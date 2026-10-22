// Code sessions -> conversations mirror (ADR 0039, goal 2026-08-26 e2e demo
// W6/D7). Each `code_sessions` row is mirrored into a `conversations` row
// with `source = 'claude-code'` so pass-1, gates, receipts (quote -> message
// index/turn), the arrival loop, and the memory browser all work UNCHANGED —
// this module never touches kg_nodes/kg_edges/kg_claims itself, exactly like
// lib/code-sessions/import.ts's own isolation invariant (ADR 0021 Q2): it
// writes ONLY to `conversations`.
//
// Dedupe key (ADR 0039 §1): (user_id, source='claude-code',
// source_id=code_session.id) — the SAME `unique (user_id, source,
// source_id)` constraint migration 001 already put on `conversations`, no
// schema change needed (see migration 061's header).
//
// PROSE-ONLY, TOOL-COLLAPSED (ADR 0039 §1): only `code_session_turns.kind =
// 'prose'` (role user/assistant) becomes a real message. `tool_use` /
// `tool_result` turns collapse to one short line each and are folded into
// the nearest ASSISTANT message — never emitted as a `role: 'user'` message,
// even though a `tool_result` turn's own `role` column is "user" in the raw
// transcript (it's the tool's output being fed back to the model, not human
// speech) — misclassifying it as user prose would let pass-1's owner-voice
// gates (G2/G3, #98) treat tool output as something the OWNER said. `kind =
// 'thinking'` turns are dropped entirely (internal deliberation, not "what
// was said and decided").
//
// CAP (ADR 0039 §4, ~60k chars/conversation, W6/D7 review M5/M8 fixes):
//   - Pass 1: assistant messages are included in order until the remaining
//     budget (cap minus ALL user chars) runs out; the message that crosses
//     the budget is truncated at that point, everything after it emptied.
//   - Pass 2 (M5): if user prose ALONE still exceeds the cap (every
//     assistant message already emptied and the total is still over), user
//     messages are truncated/emptied from the END too, tail-only, same rule.
//   - M8: a dropped/truncated message NEVER loses its array SLOT — its
//     content is emptied or truncated in place, never removed — so every
//     OTHER message's array index (and therefore any `kg_claims.turn`
//     pointing at it) stays stable across a re-mirror that only ever
//     appends new turns at the end. Each message also carries its
//     originating `code_session_turns.idx` (idxs, for a folded tool
//     message) under `metadata.idx`/`metadata.idxs` — inert to
//     computeSourceHash (role/content only) but lets a receipt be
//     cross-checked against the real transcript independent of array
//     position.
// `metadata.truncated=true` + `metadata.dropped_chars` record what was cut,
// bounding one pathological session (ADR 0021 caps a single session at 20k
// turns) from eating a whole pass-1 cycle.
//
// IDEMPOTENT / content-hash short-circuit: before writing, this module
// compares `code_sessions.content_hash` (the transcript hash the CLI parser
// already computes at import time — import.ts's own idempotency key)
// against a copy of it this module stores at `metadata.code_session_content_hash`
// on its own prior write (W6/D7 review M7) — a match means the underlying
// turns are PROVABLY unchanged, so the (expensive) turn read + message
// rebuild is skipped entirely; only `deriveTitle` is recomputed against the
// existing title (M4 — P1c can title a session well after it was first
// mirrored) and, if it differs, a targeted title-only update runs. The fast
// path ALSO requires `metadata.mirror_format_version` to equal
// MIRROR_FORMAT_VERSION (W6/D7 review round 2, R2) — an unchanged hash only
// proves the SOURCE didn't change, not that THIS MODULE's own output shape
// didn't; without this check a code change (e.g. round 1's own M5/M8 fixes)
// would silently freeze every already-mirrored row on the old, buggy shape
// forever, since the hash comparison alone would keep calling them
// "unchanged". On a miss (hash OR format version, or the very first mirror
// before any row carries either yet), the full accurate path runs and
// compares `computeSourceHash(messages)` — the SAME hash pass1.ts's own
// isSkippable and the arrival loop use — as the final word; an accurate
// match still opportunistically backfills the cheap hash + format version
// so the NEXT sweep gets the fast path.

import { parseConversationLimitError } from "@/lib/billing";
import type { Db } from "@/lib/db/types";
import { computeSourceHash } from "@/lib/util/source-hash";

/** ADR 0039 §4 — ~60k chars/conversation, user turns exempt (unless they alone overshoot — M5). */
const PROSE_CHAR_CAP = 60_000;

/**
 * R2 (W6/D7 review round 2, HIGH): the content-hash fast path only proves
 * the SOURCE turns are unchanged — it says nothing about whether THIS
 * MODULE'S OWN algorithm (buildMirrorMessages/capMirrorMessages) changed
 * since the row was last written. Round 1 of this review's fixes changed
 * both (added `metadata.idx`, changed how truncation drops content) and the
 * fast path stamped 75 legacy rows "current" without ever rebuilding them —
 * silently keeping them on the OLD, buggy shape forever. Bump this whenever
 * buildMirrorMessages/capMirrorMessages/deriveTitle's output shape changes;
 * a mismatch forces the full rebuild path exactly like a changed
 * content_hash does, even when the underlying transcript didn't move.
 */
const MIRROR_FORMAT_VERSION = 2;

/** Page size for draining code_session_turns / code_sessions (PostgREST's default row cap). */
const FETCH_PAGE_SIZE = 1000;

/**
 * Max ids per `.in(...)` call (W6/D7 review M6) — lib/kg/arrival-loop.ts
 * documents a MEASURED HTTP 414 on this repo's own PostgREST somewhere
 * between 200 and 300 ids; 200 stays comfortably under that cliff.
 */
const IN_CHUNK_SIZE = 200;

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export type MirrorMessageRole = "user" | "assistant";

export interface MirrorMessageMeta {
  /** The first/anchor code_session_turns.idx that produced this message. */
  idx: number;
  /** Every contributing turn idx, present only for a folded tool_use/tool_result message with more than one turn. */
  idxs?: number[];
}

export interface MirrorMessage {
  role: MirrorMessageRole;
  content: string;
  timestamp: string | null;
  /** W6/D7 review M8 — see this file's header CAP section. */
  metadata: MirrorMessageMeta;
}

export interface MirrorSessionOutcome {
  sessionId: string;
  status:
    | "inserted"
    | "updated"
    | "title_updated"
    | "skipped_unchanged"
    | "skipped_empty"
    | "skipped_archived"
    | "skipped_quota"
    | "error";
  chars: number;
  truncated: boolean;
  droppedChars: number;
  error?: string;
}

export interface MirrorOptions {
  /** Mirror only these code_sessions ids (e.g. the batch an import route just wrote). Omit to mirror every session for the user (backfill). */
  sessionIds?: string[];
  /** Compute everything but never write to `conversations`. */
  dryRun?: boolean;
}

export interface MirrorResult {
  processed: number;
  inserted: number;
  updated: number;
  /** M4 (W6/D7 review) — content unchanged, only `title` was updated (e.g. P1c titled the session after it was first mirrored). */
  titleUpdated: number;
  skippedUnchanged: number;
  skippedEmpty: number;
  /** M10 (W6/D7 review) — the existing mirror row carries `metadata.archived_at`; never touched. */
  skippedArchived: number;
  /**
   * Round-2 review HIGH 4: migration 078's DB trigger rejected this
   * session's conversations upsert for `conversation_limit` — expected
   * behavior for an account at/over its limit (mirrored code sessions now
   * count against the same shared quota, see lib/billing.ts's
   * getConversationQuota), NOT counted in `errors` — a caller must never
   * fail the code-session upload over this (see api/code-sessions/route.ts).
   */
  skippedQuota: number;
  errors: { sessionId: string; error: string }[];
  totalChars: number;
  truncatedCount: number;
  sessions: MirrorSessionOutcome[];
}

interface CodeSessionRow {
  id: string;
  user_id: string;
  code_project_id: string;
  git_branch: string | null;
  cwd: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  title: string | null;
  summary: string | null;
  content_hash: string;
}

interface CodeProjectRow {
  id: string;
  display_name: string | null;
  repo_identity: string;
}

interface CodeSessionTurnRow {
  idx: number;
  role: "user" | "assistant";
  kind: "prose" | "tool_use" | "tool_result" | "thinking";
  text: string | null;
  tool_name: string | null;
  file_path: string | null;
  ts: string | null;
}

interface ExistingMirroredRow {
  id: string;
  source_id: string;
  title: string | null;
  messages: unknown;
  metadata: Record<string, unknown> | null;
}

/** One short, non-prose line for a tool_use/tool_result turn — ADR 0039 §1's "[tool: <tool_name> <file_path>]". */
function toolLine(turn: CodeSessionTurnRow): string {
  const name = turn.tool_name || "unknown";
  if (turn.kind === "tool_result") {
    // The parser already elides tool_result payloads before upload
    // (code_session_turns' own doc comment, migration 029) — its `text` is
    // already a short placeholder (e.g. "[tool_result elided: ok]"); fall
    // back to a synthesized line only if that's ever missing.
    return turn.text?.trim() || `[tool result: ${name}]`;
  }
  return turn.file_path ? `[tool: ${name} ${turn.file_path}]` : `[tool: ${name}]`;
}

/**
 * Walks turns in idx order, building the mirror's message array: `prose`
 * turns become real messages; `tool_use`/`tool_result` collapse into one
 * line each, folded into the last assistant message (or starting a new one)
 * — see this file's header for why they never become a `role: 'user'`
 * message. `thinking` turns are dropped. Each message carries its
 * originating turn idx(es) under `metadata` (M8).
 */
export function buildMirrorMessages(turns: CodeSessionTurnRow[]): MirrorMessage[] {
  const sorted = [...turns].sort((a, b) => a.idx - b.idx);
  const out: MirrorMessage[] = [];

  for (const turn of sorted) {
    if (turn.kind === "thinking") continue;

    if (turn.kind === "prose") {
      // An empty prose turn has nothing to mirror; emitting it only drew an
      // empty row on the conversation page. Skipping it here (before the
      // cap) never moves an existing slot: no stored session has one today,
      // and the cap's own in-place emptying (M8) is untouched.
      if (!(turn.text ?? "").trim()) continue;
      out.push({
        role: turn.role,
        content: turn.text ?? "",
        timestamp: turn.ts ?? null,
        metadata: { idx: turn.idx },
      });
      continue;
    }

    // tool_use / tool_result — fold into the trailing assistant message.
    const line = toolLine(turn);
    const last = out[out.length - 1];
    if (last && last.role === "assistant") {
      last.content = last.content ? `${last.content}\n${line}` : line;
      const idxs = last.metadata.idxs ?? [last.metadata.idx];
      idxs.push(turn.idx);
      last.metadata = { idx: last.metadata.idx, idxs };
    } else {
      out.push({
        role: "assistant",
        content: line,
        timestamp: turn.ts ?? null,
        metadata: { idx: turn.idx, idxs: [turn.idx] },
      });
    }
  }

  return out;
}

/**
 * ADR 0039 §4's cap (W6/D7 review M5/M8 — see this file's header). Never
 * removes an array slot; a message that must be cut is emptied or truncated
 * in place. No-op when already under the cap.
 */
export function capMirrorMessages(
  messages: MirrorMessage[],
  capChars: number = PROSE_CHAR_CAP,
): { messages: MirrorMessage[]; truncated: boolean; droppedChars: number } {
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  if (totalChars <= capChars) {
    return { messages, truncated: false, droppedChars: 0 };
  }

  const userChars = messages.filter((m) => m.role === "user").reduce((sum, m) => sum + m.content.length, 0);
  let assistantBudget = Math.max(capChars - userChars, 0);
  let droppedChars = 0;

  // Pass 1: assistant messages, in order, budget-limited. truncateToBudget
  // (below) guarantees the RETURNED length never exceeds `budget` —
  // including the "\n[truncated]" marker itself — so this pass's own
  // contribution to the running total is exact, never off by the marker's
  // length (the bug a naive `slice(0,budget) + marker` has).
  const out: MirrorMessage[] = messages.map((m) => {
    if (m.role === "user") return m;
    const { content, kept } = truncateToBudget(m.content, assistantBudget);
    // R1 (W6/D7 review round 2, HIGH): decrement the budget for EVERY
    // assistant message that consumes it, not just the ones that got
    // truncated — the prior code returned early (before decrementing) for
    // any message that fit whole, so a run of fitting assistant messages
    // consumed no budget at all, `assistantBudget` stayed at its ORIGINAL
    // value for the rest of pass 1, total assistant content could exceed
    // the true budget by a wide margin, and pass 2 (which only ever touches
    // USER messages) absorbed the entire overshoot — live: 12+ rows over
    // cap (max 114,308 chars) with every user turn emptied. The budget must
    // shrink here regardless of whether this specific message needed
    // truncating.
    assistantBudget = Math.max(assistantBudget - kept, 0);
    if (kept === m.content.length) return m; // untouched — avoid an unnecessary copy
    droppedChars += m.content.length - kept;
    return { ...m, content };
  });

  // Pass 2 (M5): user prose alone can still exceed the cap even with every
  // assistant message already at its floor — truncate/empty user messages
  // from the END (tail-only), same exact-budget rule as pass 1.
  let overBudget = out.reduce((sum, m) => sum + m.content.length, 0) - capChars;
  if (overBudget > 0) {
    for (let i = out.length - 1; i >= 0 && overBudget > 0; i--) {
      const m = out[i];
      if (m.role !== "user" || m.content.length === 0) continue;
      const targetLen = Math.max(m.content.length - overBudget, 0);
      const { content, kept } = truncateToBudget(m.content, targetLen);
      droppedChars += m.content.length - kept;
      overBudget -= m.content.length - kept;
      out[i] = { ...m, content };
    }
  }

  return { messages: out, truncated: true, droppedChars };
}

/** "\n[truncated]" — appended only when truncating actually keeps some content (never when the whole message is dropped, which just empties it). */
const TRUNCATION_MARKER = "\n[truncated]";

/**
 * Trims `content` so its length (INCLUDING the marker, when one is added)
 * never exceeds `budget` — the naive `content.slice(0, budget) + marker`
 * overshoots `budget` by `marker.length`, which compounds into a real
 * over-cap total when many messages truncate (W6/D7 review M5). Returns the
 * final `content` and how many chars of it survived (`kept`) so the caller
 * can compute `droppedChars` as `original.length - kept`.
 */
function truncateToBudget(content: string, budget: number): { content: string; kept: number } {
  if (content.length <= budget) return { content, kept: content.length };
  const keepLen = Math.max(budget - TRUNCATION_MARKER.length, 0);
  if (keepLen <= 0) return { content: "", kept: 0 };
  return { content: `${content.slice(0, keepLen)}${TRUNCATION_MARKER}`, kept: keepLen + TRUNCATION_MARKER.length };
}

function deriveTitle(session: CodeSessionRow, project: CodeProjectRow | undefined): string {
  if (session.title?.trim()) return session.title.trim();
  if (session.summary?.trim()) return session.summary.trim();
  const projectName = project?.display_name || project?.repo_identity || "code project";
  const branch = session.git_branch || "no-branch";
  const date = (session.started_at ?? session.ended_at ?? "").slice(0, 10) || "unknown date";
  return `${projectName} · ${branch} · ${date}`;
}

async function fetchAllTurns(supabase: Db, userId: string, sessionId: string): Promise<CodeSessionTurnRow[]> {
  const out: CodeSessionTurnRow[] = [];
  for (let offset = 0; ; offset += FETCH_PAGE_SIZE) {
    const { data, error } = await supabase
      .from("code_session_turns")
      .select("idx, role, kind, text, tool_name, file_path, ts")
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .order("idx", { ascending: true })
      .range(offset, offset + FETCH_PAGE_SIZE - 1);
    if (error) throw new Error(`fetchAllTurns failed: ${error.message}`);
    const rows = (data ?? []) as CodeSessionTurnRow[];
    out.push(...rows);
    if (rows.length < FETCH_PAGE_SIZE) break;
  }
  return out;
}

/**
 * W6/D7 review M6: paginates (a >1000-session user no longer silently caps
 * at PostgREST's max_rows) and, when `sessionIds` is given, chunks the
 * `.in()` call at IN_CHUNK_SIZE.
 */
async function fetchSessions(supabase: Db, userId: string, sessionIds?: string[]): Promise<CodeSessionRow[]> {
  const out: CodeSessionRow[] = [];
  const idChunks = sessionIds && sessionIds.length > 0 ? chunkArray(sessionIds, IN_CHUNK_SIZE) : [null];
  for (const chunk of idChunks) {
    for (let offset = 0; ; offset += FETCH_PAGE_SIZE) {
      let query = supabase
        .from("code_sessions")
        .select(
          "id, user_id, code_project_id, git_branch, cwd, model, started_at, ended_at, title, summary, content_hash",
        )
        .eq("user_id", userId)
        // Sub-agent sessions (089) are not mirrored as conversations of their own.
        .is("parent_source_session_id", null)
        .order("id", { ascending: true })
        .range(offset, offset + FETCH_PAGE_SIZE - 1);
      if (chunk) query = query.in("id", chunk);
      const { data, error } = await query;
      if (error) throw new Error(`fetchSessions failed: ${error.message}`);
      const rows = (data ?? []) as unknown as CodeSessionRow[];
      out.push(...rows);
      if (rows.length < FETCH_PAGE_SIZE) break;
    }
  }
  return out;
}

/**
 * Batch-loads code_projects by id (no PostgREST embedded-select join — kept
 * as two plain queries so this module's own test double doesn't need to
 * emulate FK embedding, and so a project row missing/renamed mid-batch never
 * silently drops a whole session's row from a joined result set). Chunked
 * at IN_CHUNK_SIZE (M6).
 */
async function fetchProjectsByIds(
  supabase: Db,
  userId: string,
  projectIds: string[],
): Promise<Map<string, CodeProjectRow>> {
  const map = new Map<string, CodeProjectRow>();
  if (projectIds.length === 0) return map;
  for (const chunk of chunkArray(projectIds, IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("code_projects")
      .select("id, display_name, repo_identity")
      .eq("user_id", userId)
      .in("id", chunk);
    if (error) throw new Error(`fetchProjectsByIds failed: ${error.message}`);
    for (const row of (data ?? []) as CodeProjectRow[]) map.set(row.id, row);
  }
  return map;
}

/**
 * W6/D7 review M7: ONE batch read (chunked at IN_CHUNK_SIZE) over exactly
 * the source_ids this run cares about, keyed by source_id — replaces a
 * prior per-session `select id, messages` round trip. Carries `metadata` too
 * (M10's merge target) and `title` (M4's freshness check).
 */
async function fetchExistingMirroredConversations(
  supabase: Db,
  userId: string,
  sourceIds: string[],
): Promise<Map<string, ExistingMirroredRow>> {
  const map = new Map<string, ExistingMirroredRow>();
  if (sourceIds.length === 0) return map;
  for (const chunk of chunkArray(sourceIds, IN_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from("conversations")
      .select("id, source_id, title, messages, metadata")
      .eq("user_id", userId)
      .eq("source", "claude-code")
      .in("source_id", chunk);
    if (error) throw new Error(`fetchExistingMirroredConversations failed: ${error.message}`);
    for (const row of (data ?? []) as ExistingMirroredRow[]) map.set(row.source_id, row);
  }
  return map;
}

function isArchived(existing: ExistingMirroredRow | undefined): boolean {
  return !!existing?.metadata && (existing.metadata as Record<string, unknown>).archived_at != null;
}

/**
 * Mirrors `code_sessions` rows into `conversations` rows for `userId` —
 * ADR 0039's own implementation (see this file's header for the full
 * contract). Idempotent and re-runnable: an unchanged session is a true
 * no-op (content-hash short-circuit); a changed or new session is
 * inserted/updated via upsert on (user_id, source, source_id).
 */
export async function mirrorCodeSessionsToConversations(
  supabase: Db,
  userId: string,
  options: MirrorOptions = {},
): Promise<MirrorResult> {
  const { sessionIds, dryRun = false } = options;

  const result: MirrorResult = {
    processed: 0,
    inserted: 0,
    updated: 0,
    titleUpdated: 0,
    skippedUnchanged: 0,
    skippedEmpty: 0,
    skippedArchived: 0,
    skippedQuota: 0,
    errors: [],
    totalChars: 0,
    truncatedCount: 0,
    sessions: [],
  };

  let sessions: CodeSessionRow[];
  let projects: Map<string, CodeProjectRow>;
  let existingBySourceId: Map<string, ExistingMirroredRow>;
  try {
    sessions = await fetchSessions(supabase, userId, sessionIds);
    projects = await fetchProjectsByIds(supabase, userId, [...new Set(sessions.map((s) => s.code_project_id))]);
    existingBySourceId = await fetchExistingMirroredConversations(
      supabase,
      userId,
      sessions.map((s) => s.id),
    );
  } catch (err) {
    result.errors.push({ sessionId: "*", error: err instanceof Error ? err.message : String(err) });
    return result;
  }

  for (const session of sessions) {
    result.processed++;
    try {
      const existing = existingBySourceId.get(session.id);

      // M10: an archived mirror is never touched by this module again —
      // reversibility (ADR 0039 §5) must be durable against the module it
      // disables.
      if (isArchived(existing)) {
        result.skippedArchived++;
        result.sessions.push({
          sessionId: session.id,
          status: "skipped_archived",
          chars: 0,
          truncated: false,
          droppedChars: 0,
        });
        continue;
      }

      const existingMetaHash =
        existing?.metadata && typeof existing.metadata.code_session_content_hash === "string"
          ? (existing.metadata.code_session_content_hash as string)
          : null;
      // R2: the fast path additionally requires the stored row to already
      // be on the CURRENT mirror format — a hash match alone only proves
      // the source turns are unchanged, not that this module's own output
      // shape hasn't changed since that row was written.
      const existingFormatVersion =
        existing?.metadata && typeof existing.metadata.mirror_format_version === "number"
          ? (existing.metadata.mirror_format_version as number)
          : null;

      // M7 fast path: code_sessions.content_hash unchanged since our own
      // last write means the underlying turns are PROVABLY unchanged (it's
      // import.ts's own idempotency key — content_hash only changes when
      // replaceTurns actually ran) — skip the turn read + message rebuild
      // entirely. Still re-check the title (M4): P1c can title a session
      // well after the first mirror, and this path must not freeze it.
      if (existing && existingMetaHash === session.content_hash && existingFormatVersion === MIRROR_FORMAT_VERSION) {
        const freshTitle = deriveTitle(session, projects.get(session.code_project_id));
        if (freshTitle !== existing.title) {
          if (!dryRun) {
            const { error } = await supabase
              .from("conversations")
              .update({ title: freshTitle })
              .eq("id", existing.id)
              .eq("user_id", userId);
            if (error) throw new Error(`title-only update failed: ${error.message}`);
          }
          result.titleUpdated++;
          result.sessions.push({
            sessionId: session.id,
            status: "title_updated",
            chars: 0,
            truncated: false,
            droppedChars: 0,
          });
        } else {
          result.skippedUnchanged++;
          result.sessions.push({
            sessionId: session.id,
            status: "skipped_unchanged",
            chars: 0,
            truncated: false,
            droppedChars: 0,
          });
        }
        continue;
      }

      const turns = await fetchAllTurns(supabase, userId, session.id);
      const built = buildMirrorMessages(turns);

      if (built.length === 0) {
        result.skippedEmpty++;
        result.sessions.push({
          sessionId: session.id,
          status: "skipped_empty",
          chars: 0,
          truncated: false,
          droppedChars: 0,
        });
        continue;
      }

      const { messages, truncated, droppedChars } = capMirrorMessages(built);
      const chars = messages.reduce((sum, m) => sum + m.content.length, 0);
      if (truncated) result.truncatedCount++;

      const nextHash = computeSourceHash(messages);
      const existingContentHash = existing ? computeSourceHash(existing.messages) : null;
      const freshTitle = deriveTitle(session, projects.get(session.code_project_id));
      const contentUnchanged = !!existing && existingContentHash === nextHash;
      // R2: computeSourceHash only hashes role+content — it is BLIND to
      // `metadata.idx` (M8) and to whether the OLD capMirrorMessages logic
      // (round 1's own R1 bug) produced the same bytes this run's fixed
      // logic does. A row whose stored `messages` predate the current
      // MIRROR_FORMAT_VERSION must be rewritten even when the accurate hash
      // matches — the shortcut below (metadata/title only, no `messages`
      // rewrite) is only safe when the existing row is ALREADY on the
      // current format.
      const formatCurrent = existingFormatVersion === MIRROR_FORMAT_VERSION;

      if (existing && contentUnchanged && formatCurrent) {
        // The cheap pre-check missed (this row predates it, or was hand-
        // edited) but the accurate check confirms nothing changed AND the
        // row is already on the current mirror format — opportunistically
        // backfill the cheap hash (merged, M10) so the NEXT sweep gets the
        // fast path, and still apply M4's title check. `messages` is
        // deliberately NOT rewritten here — it's already byte-identical.
        const mergedMetadata = {
          ...(existing.metadata ?? {}),
          code_session_content_hash: session.content_hash,
          mirror_format_version: MIRROR_FORMAT_VERSION,
        };
        const titleChanged = freshTitle !== existing.title;
        if (!dryRun) {
          const { error } = await supabase
            .from("conversations")
            .update({ metadata: mergedMetadata, ...(titleChanged ? { title: freshTitle } : {}) })
            .eq("id", existing.id)
            .eq("user_id", userId);
          if (error) throw new Error(`metadata backfill update failed: ${error.message}`);
        }
        if (titleChanged) {
          result.titleUpdated++;
          result.sessions.push({ sessionId: session.id, status: "title_updated", chars, truncated, droppedChars });
        } else {
          result.skippedUnchanged++;
          result.sessions.push({ sessionId: session.id, status: "skipped_unchanged", chars, truncated, droppedChars });
        }
        continue;
      }

      result.totalChars += chars;

      const metadataFields: Record<string, unknown> = {
        code_session_id: session.id,
        code_project_id: session.code_project_id,
        branch: session.git_branch ?? null,
        cwd: session.cwd ?? null,
        started_at: session.started_at ?? null,
        lane: "code",
        code_session_content_hash: session.content_hash,
        mirror_format_version: MIRROR_FORMAT_VERSION,
      };
      if (truncated) {
        metadataFields.truncated = true;
        metadataFields.dropped_chars = droppedChars;
      } else {
        // A re-mirror that shrinks below the cap must clear a stale flag
        // from a prior truncated write (merge below would otherwise keep it).
        metadataFields.truncated = false;
        metadataFields.dropped_chars = 0;
      }
      // M10: merge onto the EXISTING row's metadata (jsonb `||` in spirit —
      // done in TS since we already hold both objects) rather than
      // replacing it outright, so any other key (or a future archived_at)
      // survives a re-mirror.
      const metadata: Record<string, unknown> = { ...(existing?.metadata ?? {}), ...metadataFields };

      if (!dryRun) {
        const row = {
          user_id: userId,
          source: "claude-code",
          source_id: session.id,
          title: freshTitle,
          created_at: session.started_at ?? session.ended_at ?? new Date().toISOString(),
          updated_at: session.ended_at ?? session.started_at ?? new Date().toISOString(),
          model: session.model ?? null,
          messages,
          metadata,
        };
        const { error } = await supabase.from("conversations").upsert(row, { onConflict: "user_id,source,source_id" });
        if (error) {
          // Round-2 review HIGH 4: migration 078's DB trigger rejected this
          // session for conversation_limit (mirrored code sessions now
          // share the same quota as chat conversations — see
          // lib/billing.ts's getConversationQuota). Skip-and-log, same as
          // skipped_archived/skipped_empty above — never surfaced via
          // `errors` (that would page an operator for expected, correct
          // behavior) and never thrown (this loop's per-session try/catch
          // already isolates one session's failure from the rest, but a
          // quota rejection isn't a failure at all).
          if (parseConversationLimitError(error)) {
            result.skippedQuota++;
            result.sessions.push({
              sessionId: session.id,
              status: "skipped_quota",
              chars,
              truncated,
              droppedChars,
            });
            continue;
          }
          throw new Error(`conversations upsert failed: ${error.message}`);
        }
      }

      if (existing) {
        result.updated++;
        result.sessions.push({ sessionId: session.id, status: "updated", chars, truncated, droppedChars });
      } else {
        result.inserted++;
        result.sessions.push({ sessionId: session.id, status: "inserted", chars, truncated, droppedChars });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ sessionId: session.id, error: message });
      result.sessions.push({
        sessionId: session.id,
        status: "error",
        chars: 0,
        truncated: false,
        droppedChars: 0,
        error: message,
      });
    }
  }

  return result;
}
