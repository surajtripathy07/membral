// Receipt re-check at render (docs/design/memory-v1.md §4 rule 3, D-021) and
// the shared "raw DB row -> served record" assembly every read tool
// (search.ts/recall.ts/summary.ts/preamble.ts) builds on.
//
// Rule 3, verbatim: "the stored `quote`, whitespace-normalized, is an exact
// substring of `code_session_turns.text` at (code_session_id, agent_id,
// turn_idx), whatever the role; for an `outcome`, its `ref` still appears in
// that turn's `inputDigest`. Re-checked at render, not trusted from the
// write. A sentence nobody actually wrote cannot be pushed (#114)."
//
// NOTE on `agent_id`: `code_session_turns` (migration 029) has no `agent_id`
// column — a sub-agent's turns are not stored as a separate keyed stream, so
// there is nowhere to additionally filter by it. §2's own wording for the
// grounding check ("some turn of the session" / "any role") does not gate on
// agent_id either — only `session_id` + `turn_idx` do. This module matches
// on (code_session_id, turn_idx) only, which is the full extent of what the
// schema can verify.
//
// A record that fails this check is served flagged `verified:false` and
// ranked last (rank.ts) — NEVER dropped (rule 3, `retire_session_memory` is
// the only delete-shaped path and this isn't it).
import { canonicalItemRef, type ItemKind } from "@/lib/code-sessions/ref-canon";
import type { Db } from "@/lib/db/types";
import { cosineSimilarityReadonly } from "@/lib/domain/similarity";
import { refToUrl } from "@/lib/forge/ref-url";
import { canonicalEmbeddingFamily, currentEmbeddingFamily, DEFAULT_EMBEDDING_FAMILY } from "@/lib/llm/embedding-client";
import { vectorThreshold } from "@/lib/llm/embedding-family";
import { log } from "@/lib/log";
import { selectAllRowsParallel } from "@/lib/util/pagination";
import { sameFactByVector } from "./dedupe";
import {
  type GroundingFailure,
  groundAgainstTurns,
  isSpecificEnoughQuote,
  isSpecificRef,
  MIN_NORMALIZED_QUOTE_CHARS,
  refInTurn,
} from "./grounding";
import { normalizeQuote, quoteMatchesTurnText } from "./normalize";
import { type RankMode, rankRecords } from "./rank";
import type { MemoryKind, MemorySource } from "./schema";
import { asOfDay, groupSameFact, pickSurvivor } from "./serve-filter";

export interface VerifiableRecord {
  id: string;
  code_session_id: string;
  turn_idx: number;
  kind: MemoryKind;
  /** The record's own text — the shared predicate's specificity gate compares the quote against it. */
  text: string;
  quote: string | null;
  ref: string | null;
  /** Review v6 R2-m4: `'user'` = written by the user-turn pass — re-checked under the same user-turns-only constraint. */
  extraction_pass?: string | null;
}

export interface VerifyOutcome {
  verified: boolean;
  /** Repaired turn_idx when the quote was found at a different turn than stored (a parser re-index). Unchanged on failure. */
  turn_idx: number;
  /**
   * step2e finding 3 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
   * #151): set only when the stored `quote` didn't match verbatim as-is but
   * DOES match once snapped to the true source span at the claimed turn
   * (normalize.ts's `snapQuoteToSource` — e.g. a stale "[redacted]" left
   * over from the undone home-path redaction rule, or dropped markdown).
   * `undefined` when the quote is unchanged (whether verified or not) — a
   * caller that persists this (backfill.ts's `--reverify`) should only
   * write `quote` back when it is present.
   */
  quote?: string;
  /** Role of the (possibly repaired) grounding turn; absent when no turn has `turn_idx`. */
  turn_role?: "user" | "assistant";
  /** Why the check failed; `null` when verified. */
  reason?: GroundingFailure | null;
}

interface TurnLike {
  idx: number;
  text: string | null;
  props: Record<string, unknown> | null;
  role: string | null;
  /** Issue #161: the file a tool turn touched, as the tool was given it (absolute). */
  file_path?: string | null;
}

/** Collapse runs of whitespace and trim — the "whitespace-normalized" comparison rule 3 specifies. */
export function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * One record's re-check: grounding.ts's `groundAgainstTurns`, the SAME
 * predicate merge.ts's `groundRecord` runs at write time (D3 decision A2,
 * 2026-09-24) — before it, this side skipped the quote check for a null
 * quote and had no specificity gate, so 11 of 156 live records read
 * verified here but were stored unverified. See grounding.ts's header for
 * the full accept order (cited turn, nearest other turn, snap, full-coverage
 * snap elsewhere), the preference user-turn rule, and the outcome ref rule
 * (ref anywhere in the session).
 */
function verifyOne(rec: VerifiableRecord, turns: TurnLike[]): VerifyOutcome {
  const result = groundAgainstTurns(
    {
      kind: rec.kind,
      text: rec.text,
      quote: rec.quote,
      ref: rec.ref,
      turn_idx: rec.turn_idx,
      userTurnsOnly: rec.extraction_pass === "user",
    },
    turns,
  );
  const out: VerifyOutcome = { verified: result.verified, turn_idx: result.turn_idx, reason: result.reason };
  if (result.turn_role) out.turn_role = result.turn_role;
  if (result.quoteChanged && result.quote) out.quote = result.quote;
  return out;
}

/** `.in()` id lists are chunked at this size (#277/#302: PostgREST URL length). */
const IN_CHUNK = 100;
/** Targeted turn reads in flight at once -- a whole-project `--reverify` must not open hundreds of requests. */
const TARGETED_CONCURRENCY = 10;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * W1 (memory_search latency, 2026-10-02): true when
 * `groundAgainstTurns(rec, [cited])` is GUARANTEED to equal
 * `groundAgainstTurns(rec, everyTurnOfTheSession)` -- no step of
 * grounding.ts's accept order can consult a turn other than the cited one.
 * Mirrors grounding.ts step by step:
 *   - no cited turn: steps b/d and the quote-less ref search look elsewhere.
 *   - null quote, non-outcome: fails `no_quote` whatever the turns.
 *   - null quote, outcome: a missing or non-specific ref fails whatever the
 *     turns; a specific ref in the cited turn wins (nearest-first, distance
 *     0; (session_id, idx) is unique); otherwise the session is searched.
 *   - quote under MIN_NORMALIZED_QUOTE_CHARS: fails whatever the turns.
 *   - step a (cited turn matches) wins before b/c/d; a quote not specific
 *     enough to move (M2) only ever tries a/c, both at the cited turn. Either
 *     way the hit, if any, is the cited turn, and an outcome's ref is decided
 *     there unless it is specific AND absent from it ("anywhere in the
 *     session" branch).
 * Everything else -- a specific quote that misses its cited turn -- needs
 * the whole session.
 */
export function decidedByCitedTurn(rec: VerifiableRecord, cited: TurnLike | undefined): boolean {
  if (!cited) return false;
  const refLocal = rec.kind !== "outcome" || !rec.ref || !isSpecificRef(rec.ref) || refInTurn(rec.ref, cited, true);
  if (!rec.quote) return rec.kind !== "outcome" || refLocal;
  if (normalizeQuote(rec.quote).length < MIN_NORMALIZED_QUOTE_CHARS) return true;
  const userOnly = rec.kind === "preference" || rec.extraction_pass === "user";
  const stepA = (!userOnly || cited.role === "user") && quoteMatchesTurnText(rec.quote, cited.text ?? "");
  if (!stepA && isSpecificEnoughQuote(rec.quote, rec.text)) return false;
  return refLocal;
}

type TurnRow = {
  session_id: string;
  idx: number;
  role: string | null;
  text: string | null;
  props: unknown;
  file_path?: string | null;
};

function toTurn(row: TurnRow): TurnLike {
  return {
    idx: row.idx,
    text: row.text,
    role: row.role,
    props: (row.props ?? {}) as Record<string, unknown>,
    file_path: row.file_path ?? null,
  };
}

/** Only the cited turns: one `idx in (...)` query per session (ids chunked at IN_CHUNK), TARGETED_CONCURRENCY in flight. */
async function fetchCitedTurns(
  supabase: Db,
  citedBySession: Map<string, number[]>,
): Promise<Map<string, Map<number, TurnLike>>> {
  const jobs: Array<{ sessionId: string; idxs: number[] }> = [];
  for (const [sessionId, idxs] of citedBySession) {
    for (const part of chunk(idxs, IN_CHUNK)) jobs.push({ sessionId, idxs: part });
  }
  const out = new Map<string, Map<number, TurnLike>>();
  for (const wave of chunk(jobs, TARGETED_CONCURRENCY)) {
    const pages = await Promise.all(
      wave.map((j) =>
        supabase
          .from("code_session_turns")
          .select("session_id, idx, role, text, props, file_path")
          .eq("session_id", j.sessionId)
          .in("idx", j.idxs),
      ),
    );
    for (const { data, error } of pages) {
      if (error) throw new Error(error.message);
      for (const row of (data ?? []) as TurnRow[]) {
        const bySession = out.get(row.session_id) ?? new Map<number, TurnLike>();
        bySession.set(row.idx, toTurn(row));
        out.set(row.session_id, bySession);
      }
    }
  }
  return out;
}

/**
 * Every turn of `sessionIds` -- the pre-W1 read: paginated past PostgREST's
 * ~1000-row cap (step2c, issue #151: an un-paginated `.in()` here once
 * truncated to ~1000 turns across ALL sessions and mis-verified most
 * records), session ids chunked at IN_CHUNK.
 */
async function fetchAllTurns(
  supabase: Db,
  sessionIds: readonly string[],
  expectedTurns: number,
): Promise<Map<string, TurnLike[]>> {
  const bySession = new Map<string, TurnLike[]>();
  for (const ids of chunk(sessionIds, IN_CHUNK)) {
    const data = await selectAllRowsParallel(
      (from, to) =>
        supabase
          .from("code_session_turns")
          .select("session_id, idx, role, text, props, file_path")
          .in("session_id", ids)
          .order("session_id", { ascending: true })
          .order("idx", { ascending: true })
          .range(from, to),
      expectedTurns,
    );
    for (const row of data as TurnRow[]) {
      const arr = bySession.get(row.session_id) ?? [];
      arr.push(toTurn(row));
      bySession.set(row.session_id, arr);
    }
  }
  return bySession;
}

/** What one `verifyRecords` call read -- for the per-phase timing log. */
export interface VerifyStats {
  /** Records decided from their cited turn alone. */
  targeted: number;
  /** Records whose whole session was read (a specific quote off its cited turn, a specific outcome ref elsewhere, a dangling turn). */
  full_session: number;
  /** Turn rows read in total. */
  turns_read: number;
}

/**
 * Batched receipt re-check (rule 3), returning a Map keyed by record id.
 * Each outcome is exactly `groundAgainstTurns(record, everyTurnOfItsSession)`,
 * but the turns are read in two steps (W1, 2026-10-02):
 *   1. only the turns the records CITE (`idx in (...)` per session). The old
 *      single read pulled every turn of every candidate session -- on prod
 *      4,552 turns (~2 MB, 1000-row pages one after another) for ~60 quotes.
 *   2. a record `decidedByCitedTurn` cannot settle has its WHOLE session read,
 *      exactly as before (fetchAllTurns).
 * Never N+1 per record: one query per session in step 1, one paginated query
 * per 100 sessions in step 2.
 *
 * `expectedTurns` (optional): roughly how many turn rows the sessions hold
 * (sum of `code_sessions.turn_count`). When given, step 2's pages are
 * requested in parallel (`selectAllRowsParallel`) -- the preamble's hot path.
 * `stats`, when passed, is filled with what was read.
 */
export async function verifyRecords(
  supabase: Db,
  records: VerifiableRecord[],
  expectedTurns = 0,
  stats?: VerifyStats,
): Promise<Map<string, VerifyOutcome>> {
  const results = new Map<string, VerifyOutcome>();
  if (records.length === 0) return results;

  const citedBySession = new Map<string, number[]>();
  for (const r of records) {
    const list = citedBySession.get(r.code_session_id) ?? [];
    if (!list.includes(r.turn_idx)) list.push(r.turn_idx);
    citedBySession.set(r.code_session_id, list);
  }
  const cited = await fetchCitedTurns(supabase, citedBySession);
  let turnsRead = 0;
  for (const m of cited.values()) turnsRead += m.size;

  const pending: VerifiableRecord[] = [];
  for (const rec of records) {
    const turn = cited.get(rec.code_session_id)?.get(rec.turn_idx);
    if (turn && decidedByCitedTurn(rec, turn)) results.set(rec.id, verifyOne(rec, [turn]));
    else pending.push(rec);
  }

  if (pending.length > 0) {
    const full = await fetchAllTurns(supabase, [...new Set(pending.map((r) => r.code_session_id))], expectedTurns);
    for (const turns of full.values()) turnsRead += turns.length;
    for (const rec of pending) results.set(rec.id, verifyOne(rec, full.get(rec.code_session_id) ?? []));
  }

  if (stats) {
    stats.targeted = records.length - pending.length;
    stats.full_session = pending.length;
    stats.turns_read = turnsRead;
  }
  return results;
}

// ---------------------------------------------------------------------------
// Served-record assembly shared by every read tool. One row shape in, one
// row shape out (the §4 table's field list), with the receipt re-check
// folded in.
// ---------------------------------------------------------------------------

/** The subset of `session_memories` columns every read tool selects. */
export interface MemoryRow {
  id: string;
  code_session_id: string;
  code_project_id: string;
  agent_id: string | null;
  source: MemorySource;
  kind: MemoryKind;
  text: string;
  quote: string | null;
  turn_idx: number;
  turn_role: "user" | "assistant";
  ref: string | null;
  ref_kind: string | null;
  branch: string | null;
  head_sha: string | null;
  thread: string | null;
  paths: string[];
  verified: boolean;
  durable: boolean;
  observed_durable: boolean;
  recurrence_count: number;
  scope: "project" | "global";
  confidence: number;
  supersedes: string | null;
  retired_at: string | null;
  chat_conversation_id: string | null;
  created_at: string;
}

/** Exactly the `MemoryRow` columns -- `select("*")` also ships the ~6 KB `embedding` vector per row, which no read path here uses. */
export const MEMORY_ROW_COLUMNS =
  "id, code_session_id, code_project_id, agent_id, source, kind, text, quote, turn_idx, turn_role, ref, ref_kind, branch, head_sha, thread, paths, verified, durable, observed_durable, recurrence_count, scope, confidence, supersedes, retired_at, chat_conversation_id, created_at";

/** The §4 output-table shape every tool response serves. */
export interface ServedRecord {
  id: string;
  kind: MemoryKind;
  source: MemorySource;
  text: string;
  quote: string | null;
  ref: string | null;
  session_id: string;
  agent_id: string | null;
  turn_idx: number;
  turn_role: "user" | "assistant";
  repo: string | null;
  branch: string | null;
  merged_at: string | null;
  when: string;
  durable: boolean;
  verified: boolean;
  confidence: number;
  chat_precontext: string | null;
  /** The commit the session was on when the record was written (`head_sha`, full), for `git show`. Optional on hand-built records. */
  sha?: string | null;
  /** Files the record names (the row's `paths`, at most SERVED_PATHS_MAX). */
  paths?: string[];
  /**
   * The forge page of `ref`, when the ref (or the record's project identity) names a known host -- never a guessed
   * host. A link for opening the source, never a claim about its state.
   */
  ref_url?: string | null;
  /** L2: how many distinct sessions told this same fact (paraphrases collapsed into this line). Set only when > 1. */
  seen_in?: number;
  /** L2: the other records collapsed into this one (same fact, other sessions): open them with get_code_session. */
  collapsed_ids?: string[];
  /** L2: only with include_superseded or a date phrase: the record that replaced this one, and the day it did. */
  superseded_by?: { id: string; on: string };
}

/** A served record lists at most this many of the row's `paths`. */
export const SERVED_PATHS_MAX = 5;

/**
 * The forge URL of a record's `ref`: the ref qualified by the project's `repo_identity` (`host/owner/repo`) when it
 * is bare (`#12`, `!34`), then `refToUrl`. Null when the kind is not an issue or MR, or no host is known. Pure.
 */
export function recordRefUrl(
  ref: string | null,
  refKind: string | null,
  projectIdentity: string | null | undefined,
): string | null {
  if (!ref?.trim()) return null;
  const k = refKind?.toLowerCase() ?? "";
  const kind: ItemKind | null =
    k === "issue" ? "issue" : k === "pr" || k === "mr" || k === "merge_request" ? "merge_request" : null;
  if (!kind) return null;
  const canon = canonicalItemRef(ref, projectIdentity?.trim() || null, kind);
  if (canon) return refToUrl(canon.ref, canon.kind);
  return /^https?:\/\//i.test(ref.trim()) ? refToUrl(ref, kind) : null;
}

export interface ServeContext {
  /** code_project_id -> display string (display_name || repo_identity). */
  repoNames: Map<string, string>;
  /** `${code_project_id}::${branch}` -> merged_at (memory_branch_state). */
  mergedAt: Map<string, string | null>;
  /** conversation id -> a short pre-context blurb (title/summary). */
  chatPrecontext: Map<string, string>;
  /** code_sessions.id -> when the session happened (ended_at, else started_at); absent when neither is set. */
  sessionTimes: Map<string, string>;
  /** code_project_id -> repo_identity (`host/owner/repo` for a forge repo), to qualify a bare ref into a URL. */
  repoIdentities?: Map<string, string>;
}

/**
 * Assemble one served record from a DB row, the batched verify result, and
 * the lookup maps above. Never drops a record on verify failure (rule 3).
 *
 * `when` is the source session's time (ended_at, else started_at), because
 * agents read results as "true when recorded" and a backfill re-extracts old
 * sessions today, which makes `created_at` the extraction time, not the work
 * time. It falls back to `created_at` when the session has no time or the
 * row has no session. Not the receipt turn's own `ts`: that would widen
 * verify's batched select for no gain.
 */
export function toServedRecord(row: MemoryRow, verify: VerifyOutcome, ctx: ServeContext): ServedRecord {
  const mergedAtKey = row.branch ? `${row.code_project_id}::${row.branch}` : null;
  return {
    id: row.id,
    kind: row.kind,
    source: row.source,
    text: row.text,
    quote: row.quote,
    ref: row.ref,
    session_id: row.code_session_id,
    agent_id: row.agent_id,
    turn_idx: verify.turn_idx,
    turn_role: verify.turn_role ?? row.turn_role,
    repo: ctx.repoNames.get(row.code_project_id) ?? null,
    branch: row.branch,
    merged_at: mergedAtKey ? (ctx.mergedAt.get(mergedAtKey) ?? null) : null,
    when: ctx.sessionTimes.get(row.code_session_id) ?? row.created_at,
    durable: row.durable,
    verified: verify.verified,
    confidence: row.confidence,
    chat_precontext: row.chat_conversation_id ? (ctx.chatPrecontext.get(row.chat_conversation_id) ?? null) : null,
    sha: row.head_sha?.trim() || null,
    paths: (row.paths ?? []).filter((p) => typeof p === "string" && p.trim()).slice(0, SERVED_PATHS_MAX),
    ref_url: recordRefUrl(row.ref, row.ref_kind, ctx.repoIdentities?.get(row.code_project_id)),
  };
}

/**
 * Batched lookups for `toServedRecord`'s context maps -- one query per
 * table, never per record. Shared by every read tool (search/recall/
 * summary/preamble) so the join logic exists exactly once.
 */
export async function buildServeContext(
  supabase: Db,
  userId: string,
  rows: readonly MemoryRow[],
): Promise<ServeContext> {
  const projectIds = [...new Set(rows.map((r) => r.code_project_id))];
  const convIds = [...new Set(rows.map((r) => r.chat_conversation_id).filter((id): id is string => !!id))];

  const sessionIds = [...new Set(rows.map((r) => r.code_session_id).filter((id): id is string => !!id))];

  const [projectsRes, branchRes, convRes, sessionsRes] = await Promise.all([
    projectIds.length
      ? supabase
          .from("code_projects")
          .select("id, display_name, repo_identity")
          .eq("user_id", userId)
          .in("id", projectIds)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    projectIds.length
      ? supabase
          .from("memory_branch_state")
          .select("code_project_id, branch, merged_at")
          .eq("user_id", userId)
          .in("code_project_id", projectIds)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    convIds.length
      ? supabase.from("conversations").select("id, title, metadata").in("id", convIds)
      : Promise.resolve({ data: [] as unknown[], error: null }),
    fetchSessionTimeRows(supabase, userId, sessionIds),
  ]);
  if (projectsRes.error) throw new Error(`buildServeContext: code_projects fetch failed: ${projectsRes.error.message}`);
  if (branchRes.error)
    throw new Error(`buildServeContext: memory_branch_state fetch failed: ${branchRes.error.message}`);
  if (convRes.error) throw new Error(`buildServeContext: conversations fetch failed: ${convRes.error.message}`);

  return serveContextFromRows(
    (projectsRes.data ?? []) as ServeContextProjectRow[],
    (branchRes.data ?? []) as ServeContextBranchRow[],
    (convRes.data ?? []) as ServeContextConversationRow[],
    sessionsRes,
  );
}

/** Same chunk size as current-work.ts SESSION_ID_CHUNK: an unbounded .in() once overflowed the URL (431). */
const SESSION_TIME_CHUNK = 100;

/**
 * Session times for `when`, chunked and batched (never per record). Additive: a failed read logs a warning and
 * returns what it has, so `when` falls back to created_at instead of failing the tool.
 */
export async function fetchSessionTimeRows(
  supabase: Db,
  userId: string,
  sessionIds: readonly string[],
): Promise<ServeContextSessionRow[]> {
  const chunks: string[][] = [];
  for (let i = 0; i < sessionIds.length; i += SESSION_TIME_CHUNK)
    chunks.push(sessionIds.slice(i, i + SESSION_TIME_CHUNK));
  try {
    const results = await Promise.all(
      chunks.map((chunk) =>
        supabase.from("code_sessions").select("id, started_at, ended_at").eq("user_id", userId).in("id", chunk),
      ),
    );
    const out: ServeContextSessionRow[] = [];
    for (const res of results) {
      if (res.error) {
        log.warn("[serve_context] code_sessions time read failed, serving created_at as when", {
          error: res.error.message,
        });
        continue;
      }
      out.push(...((res.data ?? []) as ServeContextSessionRow[]));
    }
    return out;
  } catch (err) {
    log.warn("[serve_context] code_sessions time read threw, serving created_at as when", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export type ServeContextProjectRow = { id: string; display_name: string | null; repo_identity: string };
export type ServeContextBranchRow = { code_project_id: string; branch: string; merged_at: string | null };
export type ServeContextConversationRow = { id: string; title: string | null; metadata: unknown };
export type ServeContextSessionRow = { id: string; started_at: string | null; ended_at: string | null };

/**
 * The context maps from rows a caller already holds -- `buildServeContext`'s
 * second half, split out so preamble.ts (which has already read the project
 * and its branch state) builds the same maps without re-reading them.
 */
export function serveContextFromRows(
  projects: readonly ServeContextProjectRow[],
  branches: readonly ServeContextBranchRow[],
  conversations: readonly ServeContextConversationRow[],
  sessions: readonly ServeContextSessionRow[] = [],
): ServeContext {
  const repoNames = new Map<string, string>();
  const repoIdentities = new Map<string, string>();
  for (const p of projects) {
    repoNames.set(p.id, p.display_name ?? p.repo_identity);
    if (p.repo_identity) repoIdentities.set(p.id, p.repo_identity);
  }

  const mergedAt = new Map<string, string | null>();
  for (const b of branches) {
    mergedAt.set(`${b.code_project_id}::${b.branch}`, b.merged_at);
  }

  const chatPrecontext = new Map<string, string>();
  for (const c of conversations) {
    const summary =
      c.metadata && typeof c.metadata === "object" && "summary" in c.metadata
        ? (c.metadata as { summary?: unknown }).summary
        : undefined;
    chatPrecontext.set(c.id, typeof summary === "string" && summary ? summary : (c.title ?? "Untitled"));
  }

  const sessionTimes = new Map<string, string>();
  for (const s of sessions) {
    const t = s.ended_at ?? s.started_at;
    if (t) sessionTimes.set(s.id, t);
  }

  return { repoNames, mergedAt, chatPrecontext, sessionTimes, repoIdentities };
}

/** Per-phase timing `rankAndServe` reports through `opts.timings`. */
export interface RankAndServeTimings extends Partial<VerifyStats> {
  verify_ms?: number;
  serve_ctx_ms?: number;
}

/** How many of the best-ranked rows the embedding rule may compare (the rest cannot reach a served slot). */
const COLLAPSE_VECTOR_ROWS = 12;

/**
 * The embeddings of the best-ranked rows, for L2's meaning-level collapse: one batched read, only rows of the current
 * embedding family (a row of another family is never compared with this process's cut). Null when the family has no
 * calibrated cut or the read fails: the collapse then runs on the text rule alone. Never throws.
 */
async function fetchVectorsForCollapse(
  supabase: Db,
  userId: string,
  rows: readonly MemoryRow[],
): Promise<Map<string, number[]> | null> {
  try {
    if (rows.length < 2 || vectorThreshold("semantic_dedup") === null) return null;
    const family = currentEmbeddingFamily();
    const { data, error } = await supabase
      .from("session_memories")
      .select("id, embedding, embedding_model")
      .eq("user_id", userId)
      .in(
        "id",
        rows.slice(0, COLLAPSE_VECTOR_ROWS).map((r) => r.id),
      );
    if (error) return null;
    const out = new Map<string, number[]>();
    for (const r of (data ?? []) as unknown as Array<{
      id: string;
      embedding: string | number[] | null;
      embedding_model: string | null;
    }>) {
      const rowFamily = r.embedding_model ? canonicalEmbeddingFamily(r.embedding_model) : DEFAULT_EMBEDDING_FAMILY;
      if (rowFamily !== canonicalEmbeddingFamily(family) || !r.embedding) continue;
      const v = typeof r.embedding === "string" ? (JSON.parse(r.embedding) as number[]) : r.embedding;
      if (Array.isArray(v)) out.set(r.id, v);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * The full pipeline every read tool runs: batched receipt re-check
 * (verify.ts) -> rank (rank.ts's business rules, using the RAW row's
 * `paths`/`created_at` -- fields §4's output table drops but ranking still
 * needs) -> slice to `limit` -> assemble the served shape (context lookups
 * run only for the final, post-slice set -- cheaper than joining every
 * candidate). `branchLive` lets a "push" caller (preamble.ts) mark which
 * rows are this session's live branch; omit it for "tool" mode, where it is
 * inert (see rank.ts's header).
 */
export async function rankAndServe(
  supabase: Db,
  userId: string,
  rows: readonly MemoryRow[],
  mode: RankMode,
  limit: number,
  opts: {
    recentFiles?: readonly string[];
    branchLive?: (row: MemoryRow) => boolean;
    /** memory_search only: the row's query relevance -- see rank.ts `RankableRecord.relevance`. */
    relevance?: (row: MemoryRow) => number | undefined;
    /** memory_search only: how many of the query's exact anchors the row carries -- see rank.ts `RankableRecord.anchorHits`. */
    anchorHits?: (row: MemoryRow) => number | undefined;
    /** Filled with per-phase ms and what verify read, for the caller's timing log. */
    timings?: RankAndServeTimings;
    /**
     * L2: also collapse paraphrases by meaning (embedding cosine at the family's semantic_dedup cut, plus the text
     * rule's guards). One extra batched read of the best-ranked rows' vectors, so only the MCP tools ask for it;
     * prompt recall and the preamble keep their latency budgets and collapse on text alone.
     */
    collapseByMeaning?: boolean;
    /** L2: collapse same-fact paraphrases to one line (newest session wins). Default true. */
    collapse?: boolean;
    /** L2: row id -> its live replacement, for rows served as history (include_superseded / date phrase). */
    supersededBy?: ReadonlyMap<string, { id: string; at: string }>;
  } = {},
): Promise<ServedRecord[]> {
  const verifyStarted = Date.now();
  const verifyStats: VerifyStats = { targeted: 0, full_session: 0, turns_read: 0 };
  const verifyMap = await verifyRecords(
    supabase,
    rows.map((r) => ({
      id: r.id,
      code_session_id: r.code_session_id,
      turn_idx: r.turn_idx,
      kind: r.kind,
      text: r.text,
      quote: r.quote,
      ref: r.ref,
    })),
    0,
    verifyStats,
  );
  const verifyMs = Date.now() - verifyStarted;

  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const rankable = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    source: r.source,
    turn_role: r.turn_role,
    agent_id: r.agent_id,
    verified: verifyMap.get(r.id)?.verified ?? false,
    paths: r.paths,
    created_at: r.created_at,
    branchLive: opts.branchLive?.(r) ?? false,
    relevance: opts.relevance?.(r),
    anchorHits: opts.anchorHits?.(r),
  }));

  const rankedAll = rankRecords(rankable, mode, opts.recentFiles ?? []);
  let rankedRows = rankedAll.map((r) => byId.get(r.id)).filter((r): r is MemoryRow => !!r);
  // L2: paraphrase sets become one line, the survivor chosen by real session time. Only groups of 2+ need session
  // times, read in one batch for those members.
  const seenIn = new Map<string, number>();
  const collapsedIds = new Map<string, string[]>();
  if (opts.collapse !== false) {
    const verifiedOf = (r: MemoryRow) => verifyMap.get(r.id)?.verified ?? false;
    const asGroupRow = (r: MemoryRow) => {
      // L1: a `duplicates` target served in a history view joins the record that replaced it.
      const link = r as MemoryRow & { superseded_by?: string | null; supersede_kind?: string | null };
      return {
        ...r,
        verified: verifiedOf(r),
        duplicate_of: link.supersede_kind === "duplicates" ? (link.superseded_by ?? null) : null,
      };
    };
    const vecs = opts.collapseByMeaning ? await fetchVectorsForCollapse(supabase, userId, rankedRows) : null;
    const cut = vectorThreshold("semantic_dedup");
    const groups = groupSameFact(
      rankedRows.map(asGroupRow),
      vecs && cut !== null
        ? (a, b) => {
            const va = vecs.get(a.id);
            const vb = vecs.get(b.id);
            return !!va && !!vb && sameFactByVector(a, b, cosineSimilarityReadonly(va, vb), cut);
          }
        : undefined,
    );
    const multi = groups.filter((g) => g.length > 1);
    const times = new Map<string, number>();
    if (multi.length) {
      const sids = [...new Set(multi.flat().map((r) => r.code_session_id))];
      for (const t of await fetchSessionTimeRows(supabase, userId, sids)) {
        const at = Date.parse(t.ended_at ?? t.started_at ?? "");
        if (Number.isFinite(at)) times.set(t.id, at);
      }
    }
    const survivors: MemoryRow[] = [];
    for (const g of groups) {
      const survivor = pickSurvivor(g, (r) => times.get(r.code_session_id));
      if (g.length > 1) {
        seenIn.set(survivor.id, new Set(g.map((m) => m.code_session_id)).size);
        collapsedIds.set(
          survivor.id,
          g.filter((m) => m.id !== survivor.id).map((m) => m.id),
        );
      }
      const row = byId.get(survivor.id);
      if (row) survivors.push(row);
    }
    rankedRows = survivors;
  }
  rankedRows = rankedRows.slice(0, limit);

  const ctxStarted = Date.now();
  const ctx = await buildServeContext(supabase, userId, rankedRows);
  if (opts.timings) {
    Object.assign(opts.timings, { verify_ms: verifyMs, serve_ctx_ms: Date.now() - ctxStarted, ...verifyStats });
  }
  return rankedRows.map((r) => {
    const rec = toServedRecord(r, verifyMap.get(r.id) ?? { verified: false, turn_idx: r.turn_idx }, ctx);
    const n = seenIn.get(r.id);
    if (n && n > 1) rec.seen_in = n;
    const merged = collapsedIds.get(r.id);
    if (merged?.length) rec.collapsed_ids = merged;
    const by = opts.supersededBy?.get(r.id);
    if (by) rec.superseded_by = { id: by.id, on: asOfDay(by.at) };
    return rec;
  });
}
