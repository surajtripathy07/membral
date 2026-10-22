import type { Db } from "@/lib/db/types";
import { createEmbeddingGuardContext, EmbeddingTokenOverflowError, generateEmbedding } from "./embeddings";
import { hasFeature } from "./feature-flags";
import { currentEmbeddingFamily, embeddingModelField } from "./llm/embedding-client";
import { embeddingWriteBlockedReason } from "./llm/embedding-family";
import { checkMonthlyCeiling } from "./llm/spend-ledger";

// ============================================================
// conversation-chunks.ts — goal 2026-07-26 step 11 (#39 folded in): the
// chunk-level chat index. Zero-LLM, deterministic segmentation of a
// conversation's messages into message-boundary-aligned chunks (migration
// 045's `conversation_chunks` table), plus the batch entry points that fill
// and embed it — mirroring lib/conversation-embeddings.ts's shape (issue #92)
// throughout, per the goal's instruction.
//
// REVISION (fresh adversarial review, 2026-07-26, NOT SOLID: 3 BLOCKER/7
// MAJOR/5 MINOR) — this file's share of the fix:
//   B1  coverage probe now selects ONE row PER COVERED CONVERSATION
//       (`.eq("chunk_idx", 0)`), not one row per chunk — the prior version
//       fetched every chunk row for the scanned page and let PostgREST's
//       max_rows=1000 cap silently truncate the coverage set (live: 1000
//       chunk rows = 43 distinct covered conversations while 93 were really
//       covered, so 1,093/1,186 conversations were permanently unreachable
//       and /api/sync re-chunked already-covered rows on every call).
//   M3  a conversation that chunks to zero pieces (no messages) is now
//       covered via a SENTINEL row (chunk_idx 0, text '') instead of never
//       gaining coverage and being re-selected forever.
//   M4  a covered conversation whose `updated_at` is newer than its coverage
//       row's `created_at` is treated as STALE and re-chunked (the
//       embedding-preserving replace below makes this cheap).
//   M5  the backfill scan selects only `id, updated_at` per page (was the
//       full `messages` payload — ~14MB per 2000-row scan, every sync);
//       `messages` is fetched in ONE batched query, only for the ids that
//       actually need chunking.
//   M7  the hard-splitter now iterates by Unicode CODE POINT, never a raw
//       UTF-16 slice — the old `line.slice(pos, pos + N)` could sever a
//       surrogate pair, producing a lone surrogate that Postgres rejects in
//       jsonb/text, permanently failing that conversation's insert.
//   Embedding preservation (recurring-cost/data-loss finding): a re-chunk
//   (stale-covered or otherwise) now diffs against the existing rows by
//   (chunk_idx, text) and only deletes/re-inserts what actually changed —
//   an unchanged chunk keeps its embedding, making M4's re-chunk safe and
//   cheap instead of re-spending on every unchanged chunk every time.
// ============================================================

export interface ChunkableMessage {
  role: string;
  content: string;
}

export interface ConversationChunk {
  chunkIdx: number;
  messageStartIdx: number;
  messageEndIdx: number;
  text: string;
}

/**
 * Target chunk size in characters — not tokens: this module has no tokenizer
 * dependency (unlike lib/embeddings.ts's script-aware token estimate, which
 * exists only to stay under the embedding model's hard token ceiling). 1500
 * chars is a plain heuristic for "a few paragraphs, small enough that a
 * single sub-topic buried in a long thread doesn't get diluted by the rest of
 * the document" (the exact recall-eval gap this table exists to close — see
 * migration 045's header).
 */
const TARGET_CHUNK_CHARS = 1500;

/**
 * A SINGLE message whose rendered line exceeds this is hard-split — the only
 * case a chunk boundary falls INSIDE a message rather than between two
 * messages. Set well above TARGET_CHUNK_CHARS so a merely-long message (say,
 * 2500 chars) still gets to be one whole, un-split chunk on its own (the
 * "prospective length would overflow" check below already isolates it into
 * its own chunk without needing to split it) — only a genuinely oversized
 * single message (a pasted file, a huge tool result echoed into a message)
 * gets torn apart.
 */
const HARD_SPLIT_THRESHOLD_CHARS = 4000;

function messageLine(msg: ChunkableMessage): string {
  return `[${msg.role}]: ${msg.content ?? ""}`;
}

/**
 * Splits `line` into pieces of at most `size` UNICODE CODE POINTS each (M7
 * fix) — never a raw `String.slice`, which indexes UTF-16 code UNITS and can
 * land a boundary between a surrogate pair's high and low halves, producing
 * a lone surrogate. `Array.from(line)` iterates by code point (a
 * spec-guaranteed string iteration behavior — surrogate pairs come out as a
 * single array element), so slicing that array can never split one. Live
 * data motivating this: 789/3101 existing chunks contained astral characters
 * (emoji, some CJK extension-B ideographs) and 409/1186 conversations have a
 * message over HARD_SPLIT_THRESHOLD_CHARS; Postgres rejects a lone surrogate
 * in jsonb/text outright, so a UTF-16-unsafe split could permanently fail a
 * conversation's chunk insert.
 */
function splitByCodePoint(line: string, size: number): string[] {
  const codePoints = Array.from(line);
  const pieces: string[] = [];
  for (let i = 0; i < codePoints.length; i += size) {
    pieces.push(codePoints.slice(i, i + size).join(""));
  }
  return pieces;
}

/**
 * Deterministic, zero-LLM segmentation of a conversation's messages into
 * chunks, aligned to message boundaries EXCEPT when a single message's own
 * rendered line exceeds HARD_SPLIT_THRESHOLD_CHARS (goal step 11 spec,
 * verbatim: "never split a message unless a single message exceeds ~4000
 * chars, then hard-split"). Records the covered message index RANGE
 * (messageStartIdx/messageEndIdx, both inclusive, 0-based into `messages`) on
 * every chunk — this is what lets a search hit resolve back to "which
 * messages does this excerpt come from" (the DoD this whole table exists
 * for).
 *
 * Deterministic + pure: same `messages` array always produces the same
 * chunks in the same order — the idempotency property `chunkMissingConversations`
 * / re-chunk-on-change relies on (a re-chunk diffs against the existing rows
 * by (chunk_idx, text), which only converges if re-running this function on
 * unchanged input always yields byte-identical output).
 */
export function chunkConversation(messages: ChunkableMessage[]): ConversationChunk[] {
  const chunks: ConversationChunk[] = [];
  let chunkIdx = 0;

  let bufStart = -1;
  let bufEnd = -1;
  let bufLines: string[] = [];
  let bufLen = 0;

  const flush = (): void => {
    if (bufStart === -1) return;
    chunks.push({
      chunkIdx: chunkIdx++,
      messageStartIdx: bufStart,
      messageEndIdx: bufEnd,
      text: bufLines.join("\n"),
    });
    bufStart = -1;
    bufEnd = -1;
    bufLines = [];
    bufLen = 0;
  };

  for (let i = 0; i < messages.length; i++) {
    const line = messageLine(messages[i]);

    if (line.length > HARD_SPLIT_THRESHOLD_CHARS) {
      // Oversized single message: whatever was accumulating so far never
      // merges with a hard-split message — flush it as its own chunk first.
      flush();
      // Then hard-split THIS message's line into TARGET_CHUNK_CHARS-sized
      // pieces, code-point-safe (M7). Every piece shares
      // messageStartIdx === messageEndIdx === i: the split happens WITHIN
      // one message, so the "message range" for each piece is degenerately
      // that one message, not a span.
      for (const piece of splitByCodePoint(line, TARGET_CHUNK_CHARS)) {
        chunks.push({
          chunkIdx: chunkIdx++,
          messageStartIdx: i,
          messageEndIdx: i,
          text: piece,
        });
      }
      continue;
    }

    // Adding this message would overflow the target AND the buffer already
    // holds at least one message — flush what's there first, so this message
    // starts the next chunk instead of pushing the current one over budget.
    // (A buffer holding zero messages always accepts the next one
    // unconditionally, even if that single message alone is between
    // TARGET_CHUNK_CHARS and HARD_SPLIT_THRESHOLD_CHARS — it becomes its own
    // chunk via the very next iteration's overflow check, without needing to
    // split it.)
    const joiner = bufLines.length > 0 ? 1 : 0; // the '\n' this line would add when joined
    const prospectiveLen = bufLen + joiner + line.length;
    if (bufLines.length > 0 && prospectiveLen > TARGET_CHUNK_CHARS) {
      flush();
    }

    if (bufStart === -1) bufStart = i;
    bufEnd = i;
    bufLen = bufLen + (bufLines.length > 0 ? 1 : 0) + line.length;
    bufLines.push(line);
  }

  flush();
  return chunks;
}

/**
 * The persisted signal for "this conversation has zero messages, and we know
 * it — it's covered, not pending" (M3). Without this, a zero-message
 * conversation produces zero chunks from `chunkConversation`, gains no row in
 * `conversation_chunks`, and the coverage probe (`chunk_idx = 0` existence
 * check) never sees it as covered — `chunkMissingConversations` would
 * re-select and re-attempt it on every single call forever, never
 * converging. `text: ''` is deliberately excluded from matching by the RPC
 * (migration 045's `chunk_best` WHERE `cc.text <> ''`) and from the
 * embedding backfill scan below — it exists purely as a coverage marker.
 */
const ZERO_MESSAGE_SENTINEL_CHUNK: ConversationChunk = {
  chunkIdx: 0,
  messageStartIdx: -1,
  messageEndIdx: -1,
  text: "",
};

/**
 * Idempotent per conversation: diffs the freshly computed chunk set against
 * whatever rows already exist for this conversation_id, and only
 * deletes+inserts what actually changed — mirrors
 * lib/code-sessions/import.ts's `replaceTurns` pattern in spirit (whole-set
 * replace per conversation on re-chunk), but NOT its literal
 * delete-everything-then-insert-everything shape, because that would throw
 * away every chunk's embedding on every re-chunk (recurring embedding cost,
 * and a real data-loss risk if a re-chunk races an embed-backfill call).
 *
 * DIFF RULE: an existing row is left untouched (embedding preserved) when its
 * (chunk_idx, text) pair is byte-identical to the freshly computed chunk at
 * that index — chunk boundaries and content are deterministic
 * (chunkConversation is pure), so an unchanged conversation always diffs to
 * "nothing to do". A row is deleted+re-inserted (embedding reset to null,
 * correctly, since the text under it changed) when chunk_idx exists in both
 * sets but the text differs, when chunk_idx is new, or when chunk_idx no
 * longer appears in the fresh set (deleted alone, not re-inserted).
 *
 * Zero-message conversations chunk to `[]` — substituted with a single
 * SENTINEL row (see above, M3) so the conversation still gains coverage.
 *
 * NON-TRANSACTIONAL, SELF-HEALING: like replaceTurns, this issues separate
 * delete/insert statements (no client-side multi-statement transaction — no
 * other write path in this codebase does one either). A torn write (delete
 * succeeds, insert fails, or vice versa) self-heals on the next successful
 * re-chunk of the same conversation, which re-diffs against whatever
 * actually landed and converges again. The `unique (conversation_id,
 * chunk_idx)` constraint means a insert racing a concurrent re-chunk of the
 * same conversation can hit a unique-violation — this is a rare,
 * self-healing collision (the next scheduled re-chunk/backfill call re-diffs
 * and converges), not a condition this function retries or locks against.
 */
export async function replaceConversationChunks(
  supabase: Db,
  userId: string,
  conversationId: string,
  chunks: ConversationChunk[],
): Promise<void> {
  const desired = chunks.length > 0 ? chunks : [ZERO_MESSAGE_SENTINEL_CHUNK];

  const { data: existingRows, error: fetchError } = await supabase
    .from("conversation_chunks")
    .select("chunk_idx, text")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId);
  if (fetchError) {
    throw new Error(`replaceConversationChunks(fetch existing) failed: ${fetchError.message}`);
  }

  const existingByIdx = new Map<number, string>(
    ((existingRows ?? []) as { chunk_idx: number; text: string }[]).map((r) => [r.chunk_idx, r.text]),
  );
  const desiredIdxSet = new Set(desired.map((c) => c.chunkIdx));

  // New or text-changed chunks — these need an insert (a changed chunk's OLD
  // embedding no longer describes its NEW text, so its old row must not be
  // preserved either — see changedIdxs below).
  const changedOrNew = desired.filter((c) => existingByIdx.get(c.chunkIdx) !== c.text);
  // Of those, only the ones that ALREADY HAD a row (text changed under an
  // existing idx) need their stale row deleted first — a brand-new idx has
  // no existing row to delete at all, so it must NOT be added to the delete
  // set (a redundant delete is harmless in Postgres, but wrong to model as
  // "deleting" something that was never there).
  const changedIdxs = changedOrNew.filter((c) => existingByIdx.has(c.chunkIdx)).map((c) => c.chunkIdx);
  // Idxs that existed before but are absent from the fresh set entirely
  // (the conversation got shorter/re-segmented) — delete only, no re-insert.
  const removedIdxs = [...existingByIdx.keys()].filter((idx) => !desiredIdxSet.has(idx));

  const idxsToDelete = [...new Set([...changedIdxs, ...removedIdxs])];

  if (idxsToDelete.length > 0) {
    const deleteRes = await supabase
      .from("conversation_chunks")
      .delete()
      .eq("user_id", userId)
      .eq("conversation_id", conversationId)
      .in("chunk_idx", idxsToDelete);
    if (deleteRes.error) {
      throw new Error(`replaceConversationChunks(delete) failed: ${deleteRes.error.message}`);
    }
  }

  if (changedOrNew.length === 0) return; // unchanged conversation — nothing to insert, every embedding preserved

  const rows = changedOrNew.map((c) => ({
    user_id: userId,
    conversation_id: conversationId,
    chunk_idx: c.chunkIdx,
    message_start_idx: c.messageStartIdx,
    message_end_idx: c.messageEndIdx,
    text: c.text,
  }));

  const insertRes = await supabase.from("conversation_chunks").insert(rows);
  if (insertRes.error) {
    throw new Error(`replaceConversationChunks(insert) failed: ${insertRes.error.message}`);
  }
}

/** One page of the synced_at-desc scan chunkMissingConversations runs below. */
const CHUNK_SCAN_PAGE_SIZE = 100;

/**
 * Hard cap on how many pages (and therefore rows) a single
 * chunkMissingConversations call will scan looking for coverage gaps, before
 * giving up for this call (goal step 11 backfill: a corpus can have its
 * MOST-RECENT rows already chunked while older rows further back still lack
 * coverage — see the doc comment below for why a single unpaged page would
 * plateau forever on a large corpus). 20 pages * 100 rows/page = 2000
 * conversations scanned worst-case per call — generous headroom over the
 * founder corpus's ~1175 conversations, bounded so
 * a pathological corpus can't turn one call into an unbounded scan.
 */
const CHUNK_SCAN_MAX_PAGES = 20;

/**
 * Coverage-probe page size — PostgREST caps a single response at 1000 rows
 * regardless of an explicit `.limit()` (B1). This is deliberately far above
 * CHUNK_SCAN_PAGE_SIZE (a scan page is at most 100 conversation ids, so a
 * coverage probe for one page never approaches this) — the constant exists
 * so the probe's own `.range()` loop (defensive, in case a future caller
 * widens CHUNK_SCAN_PAGE_SIZE) never silently truncates either.
 */
const COVERAGE_PROBE_PAGE_SIZE = 1000;

interface ScanRow {
  id: string;
  updated_at: string | null;
}

interface CoverageRow {
  conversation_id: string;
  created_at: string;
}

/**
 * Coverage probe for one page of candidate conversation ids (B1 fix): probes
 * `.eq("chunk_idx", 0)` so the result is exactly ONE ROW PER COVERED
 * CONVERSATION (every covered conversation has exactly one chunk_idx=0 row,
 * whether a real chunk or the zero-message sentinel), using
 * `idx_conversation_chunks_conversation_id (conversation_id, chunk_idx)` —
 * instead of the prior version's one-row-PER-CHUNK probe, which let
 * PostgREST's 1000-row response cap silently truncate the coverage set on
 * any page with popular/heavily-chunked conversations (live: 1000 chunk rows
 * = 43 distinct covered conversations while 93 were actually covered).
 * Paginated defensively (see COVERAGE_PROBE_PAGE_SIZE) even though a single
 * scan page's candidate-id count never approaches the cap, in the style of
 * api/agent-stats/issues/route.ts's `fetchAllTurns` — never trust a single
 * unpaged response against an unbounded id list.
 */
async function probeCoverage(supabase: Db, userId: string, ids: string[]): Promise<Map<string, string>> {
  const coverage = new Map<string, string>(); // conversation_id -> chunk_idx=0 row's created_at
  if (ids.length === 0) return coverage;

  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("conversation_chunks")
      .select("conversation_id, created_at")
      .eq("user_id", userId)
      .eq("chunk_idx", 0)
      .in("conversation_id", ids)
      // MINOR-4 fix (round-2 adversarial re-verification, 2026-07-26): a
      // `.range()` page without an explicit `.order()` has no guaranteed row
      // order in Postgres — successive pages could repeat or skip rows,
      // silently corrupting the coverage map on a page boundary. Ordered by
      // `conversation_id` for a fully deterministic pagination, matching
      // fetchAllTurns' ordered style (api/agent-stats/issues/route.ts).
      .order("conversation_id")
      .range(from, from + COVERAGE_PROBE_PAGE_SIZE - 1);
    if (error) throw new Error(`probeCoverage failed: ${error.message}`);
    if (!data || data.length === 0) break;
    for (const row of data as CoverageRow[]) coverage.set(row.conversation_id, row.created_at);
    if (data.length < COVERAGE_PROBE_PAGE_SIZE) break;
    from += COVERAGE_PROBE_PAGE_SIZE;
  }
  return coverage;
}

/**
 * Chunks any of a user's conversations that lack coverage, OR whose coverage
 * is STALE (M4: `conversations.updated_at` newer than the covering
 * chunk_idx=0 row's `created_at` — the conversation was resynced with new
 * content after it was last chunked), up to `limit` conversations touched
 * per call. Mirrors embedMissingConversations's shape (issue #92
 * conventions): ordered by `synced_at` DESC (ingest recency, matching that
 * module's own reasoning — a resumed old chat must still win the batch over
 * a backlog of un-chunked rows), and each row's chunking is isolated in its
 * own try/catch so one malformed conversation can't abort the batch.
 *
 * PAGINATED SCAN (the one structural difference from
 * embedMissingConversations, which selects its "missing" rows directly via a
 * `.is("embedding", null)` SQL filter): there is no `conversations.chunked_at`
 * column to filter on — adding one was out of scope for this goal's two
 * migration numbers (044/045), and coverage is a property of a SEPARATE
 * table (`conversation_chunks`), not a column on `conversations` itself. A
 * single unpaged "most recent `limit` conversations, then check which are
 * covered" query would PLATEAU on a large corpus: once the top `limit`
 * most-recent conversations are all chunked, every future call would keep
 * re-checking that same already-covered head and never progress to the
 * older, still-uncovered tail — backfill would never converge. Scanning in
 * pages (synced_at DESC) until `limit` conversations NEEDING WORK are found
 * (or the page cap / corpus is exhausted) guarantees a backfill loop that
 * calls this repeatedly eventually covers the whole corpus.
 *
 * SCAN PAYLOAD (M5): the scan itself selects only `id, updated_at` — never
 * `messages` (a single page's worth of full conversation payloads was ~14MB,
 * fetched fresh on every sync call). `messages` is fetched in ONE additional
 * batched query, scoped to only the ids this call actually decided need
 * (re-)chunking — typically a small subset of a scanned page, never the
 * whole page.
 */
export async function chunkMissingConversations(
  supabase: Db,
  userId: string,
  limit: number,
): Promise<{ processed: number; errors: string[]; queryError?: string }> {
  const needsWork: string[] = [];
  let offset = 0;

  for (let page = 0; page < CHUNK_SCAN_MAX_PAGES && needsWork.length < limit; page++) {
    const { data: convPage, error: convError } = await supabase
      .from("conversations")
      .select("id, updated_at")
      .eq("user_id", userId)
      .order("synced_at", { ascending: false })
      .range(offset, offset + CHUNK_SCAN_PAGE_SIZE - 1);

    if (convError) {
      return { processed: 0, errors: [`Query error: ${convError.message}`], queryError: convError.message };
    }
    if (!convPage || convPage.length === 0) break;

    offset += convPage.length;
    const rows = convPage as ScanRow[];
    const ids = rows.map((c) => c.id);

    let coverage: Map<string, string>;
    try {
      coverage = await probeCoverage(supabase, userId, ids);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { processed: 0, errors: [`Coverage query error: ${message}`], queryError: message };
    }

    for (const c of rows) {
      const coveredCreatedAt = coverage.get(c.id);
      const isUncovered = coveredCreatedAt === undefined;
      // M4: stale when the conversation was updated (resynced) AFTER it was
      // last chunked. A missing/unparseable updated_at never counts as
      // stale — a conversation must PROVE it changed since coverage, not the
      // reverse.
      const isStale =
        !isUncovered &&
        c.updated_at != null &&
        Number.isFinite(Date.parse(c.updated_at)) &&
        Date.parse(c.updated_at) > Date.parse(coveredCreatedAt as string);

      if (isUncovered || isStale) {
        needsWork.push(c.id);
        if (needsWork.length >= limit) break;
      }
    }

    if (rows.length < CHUNK_SCAN_PAGE_SIZE) break; // exhausted the corpus before filling the page
  }

  if (needsWork.length === 0) return { processed: 0, errors: [] };

  // Batched fetch of `messages`, scoped to exactly the ids that need
  // (re-)chunking — never the full scanned page (M5).
  const { data: withMessages, error: msgError } = await supabase
    .from("conversations")
    .select("id, messages")
    .eq("user_id", userId)
    .in("id", needsWork);
  if (msgError) {
    return { processed: 0, errors: [`Messages query error: ${msgError.message}`], queryError: msgError.message };
  }

  let processed = 0;
  const errors: string[] = [];

  for (const conv of (withMessages ?? []) as { id: string; messages: unknown }[]) {
    try {
      const messages = normalizeMessages(conv.messages);
      const chunks = chunkConversation(messages);
      await replaceConversationChunks(supabase, userId, conv.id, chunks);
      processed++;
    } catch (err) {
      errors.push(`Chunking error for ${conv.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { processed, errors };
}

function normalizeMessages(raw: unknown): ChunkableMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => {
    const msg = m as { role?: unknown; content?: unknown };
    return {
      role: typeof msg.role === "string" ? msg.role : "unknown",
      content: typeof msg.content === "string" ? msg.content : "",
    };
  });
}

// ------------------------------------------------------------
// Embedding backfill for chunks — reuses generateEmbedding's guarded path
// (lib/embeddings.ts, issue #92), tagged with the 'chunk_embedding' PassName
// (kg/types.ts) so ingest-time chunk spend is distinguishable in the
// llm_spend ledger from whole-conversation embeds. Mirrors
// embedMissingConversations's batching shape (ONE shared EmbeddingGuardContext
// for the whole batch, ceiling rechecked every CEILING_RECHECK_INTERVAL rows,
// ledger flushed in a `finally`) — see that module's doc comments for the
// full reasoning; not re-derived here.
// ------------------------------------------------------------

const RATE_LIMIT_MS = 200;
const CEILING_RECHECK_INTERVAL = 10;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface MinimalChunkRow {
  id: string;
  text: string;
}

/**
 * Embeds any of a user's `conversation_chunks` rows that don't yet have an
 * embedding — `embedding is null` IS the idempotency/selection mechanism,
 * exactly like embedMissingConversations. Also requires
 * `embedding_failed_at is null` (mirrors conversations.embedding_failed_at,
 * issue #90's permanent-failure retirement pattern) and `text <> ''`
 * (excludes the M3 zero-message sentinel row, which is never meant to be
 * embedded). Ordered by `created_at` ASC (round-2 adversarial re-verification,
 * MAJOR-1, 2026-07-26 — was DESC): DESC processes the NEWEST unembedded rows
 * first on every call, which starves the backlog forever on a corpus that
 * keeps growing — a pre-existing backlog is permanently "last", and a batch
 * that never fully drains it (limit smaller than the backlog) makes progress
 * only on whatever chunked most recently, never on the backlog itself. ASC
 * drains oldest-first: the existing backlog empties over successive calls,
 * and newly-chunked rows simply join the back of that same queue (there is
 * no `synced_at` on this table — `created_at` is the chunk's own ingest
 * timestamp, the direct analogue).
 */
export async function embedMissingChunks(
  supabase: Db,
  userId: string,
  limit: number,
): Promise<{ processed: number; errors: string[]; queryError?: string }> {
  const { data: chunks, error: queryError } = await supabase
    .from("conversation_chunks")
    .select("id, text")
    .eq("user_id", userId)
    .is("embedding", null)
    .is("embedding_failed_at", null)
    .neq("text", "")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (queryError) {
    return { processed: 0, errors: [`Query error: ${queryError.message}`], queryError: queryError.message };
  }
  if (!chunks || chunks.length === 0) {
    return { processed: 0, errors: [] };
  }

  // Issue #126 (ADR 0047); "embeddings" not "llm" as of issue #128 (ADR
  // 0047 v2) — see conversation-embeddings.ts's identical upfront check for
  // why this lives here as well as inside generateEmbedding itself: one
  // clean log line + zero wasted per-row throws for a flagged-off/
  // budget-exhausted user's batch.
  if (!(await hasFeature(userId, "embeddings"))) {
    console.warn(
      `[chunk-embed] feature_disabled — skipping chunk embedding batch for user ${userId} (${chunks.length} pending)`,
    );
    return { processed: 0, errors: [] };
  }

  // D-072: see conversation-embeddings.ts's identical family check.
  const family = currentEmbeddingFamily();
  const blocked = await embeddingWriteBlockedReason(supabase, family);
  if (blocked) {
    console.warn(`[chunk-embed] embeddings skipped for user ${userId} (${chunks.length} pending): ${blocked}`);
    return { processed: 0, errors: [] };
  }

  const rows = chunks as MinimalChunkRow[];
  const guard = createEmbeddingGuardContext(userId);

  let processed = 0;
  const errors: string[] = [];

  try {
    for (let i = 0; i < rows.length; i++) {
      const chunk = rows[i];

      if (guard.supabase && i % CEILING_RECHECK_INTERVAL === 0) {
        await guard.ledger?.flush();
        const ceiling = await checkMonthlyCeiling(guard.supabase, userId);
        if (!ceiling.allowed) {
          console.warn(
            `[chunk-embed] monthly cost ceiling exceeded (spent $${ceiling.spentUsd.toFixed(4)} >= $${(ceiling.ceilingUsd as number).toFixed(4)}) — stopping batch for user ${userId} at row ${i}/${rows.length}, remaining rows left pending`,
          );
          break;
        }
      }

      try {
        const embedding = await generateEmbedding(chunk.text, { userId, pass: "chunk_embedding", guard });
        const embeddingStr = `[${embedding.join(",")}]`;

        const { error: updateError } = await supabase
          .from("conversation_chunks")
          .update({ embedding: embeddingStr, ...embeddingModelField(true, family) })
          .eq("id", chunk.id)
          .eq("user_id", userId);

        if (updateError) {
          errors.push(`Update error for ${chunk.id}: ${updateError.message}`);
        } else {
          processed++;
        }
      } catch (err) {
        if (err instanceof EmbeddingTokenOverflowError) {
          // Permanent failure (issue #90 pattern): retire the row so the
          // `embedding is null` scan stops re-selecting it forever.
          // Best-effort — if the retirement write itself fails, the row
          // simply falls back to being retried next batch. NEVER retired on
          // a transient/429 failure — only this token-overflow class, which
          // survives every reactive halving in generateEmbedding and can
          // never succeed on retry.
          console.warn(`[chunk-embed] chunk ${chunk.id} permanently un-embeddable — marking embedding_failed_at`);
          const { error: failError } = await supabase
            .from("conversation_chunks")
            .update({ embedding_failed_at: new Date().toISOString() })
            .eq("id", chunk.id)
            .eq("user_id", userId);
          if (failError) {
            errors.push(`Failed to mark embedding_failed_at for ${chunk.id}: ${failError.message}`);
          } else {
            errors.push(`Embedding permanently failed for chunk ${chunk.id}: ${err.message}`);
          }
        } else {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`Embedding error for chunk ${chunk.id}: ${message}`);
        }
      }

      await delay(RATE_LIMIT_MS);
    }
  } finally {
    await guard.ledger?.flush();
  }

  return { processed, errors };
}
