// Memory v1, source C — persistence (docs/design/memory-v1.md §2). Writes
// `session_memories` rows, stamps `code_sessions.props.memory_extraction`
// (+ the checkpoint the next tail-capture run reads), and runs the
// supersede rule against already-live records.

import { patchCodeSessionProps } from "@/lib/code-sessions/props-patch";
import type { Db } from "@/lib/db/types";
import { RECURRENCE_OFFER_SCAN_LIMIT } from "@/lib/domain/recurrence";
import {
  DUPLICATE_RETIRE_REASON,
  RERUN_RETIRE_REASON,
  RESOLVED_LATER_RETIRE_REASON,
  SEMANTIC_DUPLICATE_RETIRE_REASON,
} from "@/lib/domain/retire-reasons";
import { currentEmbeddingFamily } from "@/lib/llm/embedding-client";
import { vectorThreshold } from "@/lib/llm/embedding-family";
import { log } from "@/lib/log";
import { selectAllRows } from "@/lib/util/pagination";
import type { GroundedSessionIssue } from "../extract";
import {
  candidateSessionIds,
  type FetchedLaterResolutionRow,
  type FetchedSessionStartRow,
  LATER_RESOLUTION_SCAN_LIMIT,
  type LaterResolutionCandidate,
  type LaterResolutionReceipt,
  laterResolutionCutoff,
  planLaterResolutionCandidates,
  sessionsStartedBefore,
  unsupersededOtherSessionRows,
} from "./blockers";
import {
  type ExistingRow,
  type InsertableRecord,
  type InsertedRow,
  type InsertRow,
  isRetiredUnverified,
  planInsert,
  unverifiedRetireReason,
} from "./insert";
import { sessionIssueRows } from "./issues";
import { buildLock, withLock } from "./lock";
import {
  type FetchedLiveRow,
  type FetchedOpenBlockerRow,
  type LiveRow,
  planCarriedRootCounts,
  planCrossSessionDedup,
  planFallbackCounts,
  planOpenBlockerOffers,
  toLiveRows,
} from "./recurrence";
import { resolvedBlockerUpdate, retireUpdate, returnedIds } from "./retire";
import { groupSupersedeByKind, planSupersede, type SupersedeInsertedRecord, type SupersedeLiveRow } from "./supersede";

export {
  CROSS_SESSION_DUP_COSINE_THRESHOLD,
  RECURRENCE_COSINE_THRESHOLD,
  RECURRENCE_KINDS,
} from "@/lib/domain/recurrence";
export {
  RESOLVED_IN_SESSION_RETIRE_REASON,
  RESOLVED_LATER_RETIRE_REASON,
  SEMANTIC_DUPLICATE_RETIRE_REASON,
  SUBAGENT_BRIEF_RETIRE_REASON,
  UNVERIFIED_RETIRE_PREFIX,
} from "@/lib/domain/retire-reasons";
export { DEFAULT_SEMANTIC_DEDUP_MIN_SIM } from "@/lib/domain/similarity";
export type { LaterResolutionCandidate, LaterResolutionReceipt } from "./blockers";
export { type InsertableRecord, isRetiredUnverified, unverifiedRetireReason } from "./insert";
export { isMemoryExtractionLockHeld, MEMORY_EXTRACTION_LOCK_STALE_MS } from "./lock";

/**
 * e2e A-B4 / prompt v12: the same wall said three ways in three sessions
 * ("npm test hangs on the FX-rates fixture download" / "the test suite is
 * stuck on downloading the FX-rates fixture" / "FX fixture download timeout
 * in tests is still blocking") embeds at cosine 0.64–0.81 — mostly below the
 * 0.80 band, and below it the embedding alone cannot tell a paraphrase from a
 * neighbour (distinct blockers sit at 0.60–0.67 too, e.g. two different
 * unapplied migrations). So the extraction call itself judges it, in
 * context and in any language: it is offered this project's open blockers
 * (`fetchOpenBlockersForRecurrence`) and may answer `recurs_of` with one of
 * them (extract.ts, validated against the offered list). That answer
 * (`recursOfHint`) links the chain; a blocker without one falls back to the
 * cosine band alone. No word lists.
 */

export interface MemoryExtractionProps {
  windows_total: number;
  windows_extracted: number;
  tail_turns_extracted: number;
  budget_hit: boolean;
  records: number;
  prompt_version: string;
  run_id: string;
  at: string;
  /** Additive beyond the design's literal field list (§8 bullet 5) — lets D2's evidence query ("windows dropped by degrade that contained user prose, must be 0") be read straight off `props` without recomputing it from the raw window list. */
  windows_dropped_user_prose: number;
  /** step2b finding F — outcomes dropped because PII redaction left their `ref` no longer a valid, openable shape (merge.ts's `applyDeterministicFixes`). Never stored with a scrubbed ref; counted here instead so the run's PII hit rate is visible on the session row. */
  dropped_pii: number;
  /** step2b `--force`: the prior run this one retired (never overwritten by a subsequent non-force run — `updateSessionMemoryProps` only ever sets what this run computed). `undefined` on a normal (non-force, or force-with-no-prior-run) pass. */
  previous?: { prompt_version: string; records: number; retired_at: string };
  /** step2d finding 6: tail turns NOT covered by a successfully-extracted window this run (a degrade-dropped or failed window, and everything after the first such gap) — the checkpoint stops just short of these, so they're re-offered as the tail on the next upload. 0 when every selected window succeeded. */
  tail_turns_uncovered?: number;
  /** step2d finding 8: records whose embed batch failed (embed.ts) — stored with `embedding: null`, never discarded, just excluded from cosine dedupe/supersede. */
  embed_failed?: number;
  /** step2d finding 4: preference records dropped because their resolved receipt turn was an assistant turn, not the owner's (merge.ts's `groundRecord`). */
  dropped_owner_voice?: number;
  /** step2d finding 15: records whose receipt `turn_idx` matched no turn in the session — clamped to the session's last turn, kept `verified:false`. */
  dangling_receipts?: number;
  /** step2d finding 17: set to `"no_prose"` when the uncovered tail had zero prose turns — extraction is skipped entirely (no LLM call) rather than paying for a window that can only ever yield nothing. */
  skipped?: "no_prose";
  /** step2e finding 6 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue #151): preference records rejected by the schema because their `statement` opened with third-person narration ("The owner...", "The user...") instead of an imperative/standing-rule form — dropped, never rewritten (extract.ts). */
  dropped_narration?: number;
  /** step2e finding 1 (issue #151): outcome records dropped because their `ref` could not be corroborated by the receipt turn at all, nor repaired from its digest/text (merge.ts's `repairOutcomeRef`) — a hallucinated ref, never stored with one. */
  dropped_hallucinated_ref?: number;
  /** step2e finding 5 (issue #151): blockers whose `resolved_in_session` (and therefore `durable`) was updated by the end-of-session tail re-ask (extract.ts's `reaskBlockerResolutions`), catching a resolution that happened in a later window than the one that first raised the blocker. */
  blockers_reasked?: number;
  /** P8 (goal 2026-09-24 memory-on-prod): blockers the end-of-session re-ask judged resolved in this session, inserted retired (`retire_reason = "resolved_in_session"`, never deleted) so a fixed problem is never served as an open blocker. */
  retired_resolved_blocker?: number;
  /** D3 decision B: records inserted live (grounded). */
  verified?: number;
  /** D3 decision B: records inserted already retired (`retire_reason = "unverified:<reason>"`) because they failed grounding. */
  retired_unverified?: number;
  /** D3 decision C2: records the separate user-turn pass returned after Zod validation (before dedupe against the main pass). */
  user_pass_records?: number;
  /** D3 decision C2: user-pass windows skipped because their estimate exceeded what was left of the session budget. */
  user_pass_windows_skipped?: number;
  /** Review v6 M5: user-pass windows whose call failed (malformed/empty after retries) — they hold the checkpoint back. */
  user_pass_windows_failed?: number;
  /** Review v6 R2-M1: user-pass windows ("<first>-<last>" turn idx) released after USER_PASS_MAX_ATTEMPTS failed attempts — the checkpoint passed them without their user pass. */
  user_pass_windows_abandoned?: string[];
  /** Review v6 R2-M1: user-pass windows skipped because the main pass itself used the session budget — deliberate, never a checkpoint hold. */
  user_pass_windows_budget_released?: number;
  /** D3 decision C3(c): records dropped as near-identical (normalised text) to another record of the same session. */
  deduped_text?: number;
  /** Records not inserted because a live record of the same kind in the same project, from another session, already says it (normalized text equal or cosine >= CROSS_SESSION_DUP_COSINE_THRESHOLD) — e.g. a session echoing the injected preamble. */
  deduped?: number;
  /** step2f fix 1 (issue #151): records whose wire-level JSON omitted `durable` entirely — `schema.ts`'s `parseMemoryRecord` filled it in with a deterministic default (blocker: `!resolved_in_session` when answered, else `false`; every other kind: `false`) instead of dropping the record. Visible here so the underlying prompt-compliance rate (gpt-4o-mini omits `durable` on ~100 records across the step2e one-repo gate) stays measurable even though it no longer costs any records. */
  durable_defaulted?: number;
  /** Issue #162 (renamed N2, review round 2): outcomes whose `ref` was changed and kept by merge.ts's `repairOutcomeRef`/`resolveCommitHintedOutcome` — a hallucination recovery from the receipt turn's digest/text or a commit hint, a range ref split into its members, or a benign mis-copy fix, not hallucinations alone — the repair counterpart to `dropped_hallucinated_ref`. */
  repaired_ref?: number;
  /** Issue #162: records whose text/quote/ref/thread had a phone/email span actually redacted (the `[redacted]` marker introduced, not just a path relativized) but were still valid and kept (merge.ts's `redactRecordPii`) — the repair counterpart to `dropped_pii`. */
  repaired_pii?: number;
  /** Issue #162 (retry-on-empty, handoff/d3-qwen-v7/run-report.md): windows (main pass or user pass) whose valid-but-empty `{records: []}` result got one identical-prompt retry (extract.ts). */
  retried_empty?: number;
  /** Of `retried_empty`, retries that returned >=1 record. */
  retry_recovered?: number;
  /** Retries skipped, without a call, because the run was already over budget or didn't fit what was left of the session budget (RR-S1, review round 2). */
  retry_skipped_budget?: number;
  /** RR-S2 (review round 2): retries that themselves threw — the first (empty) result and its cost were kept, the window is not marked failed. */
  retry_failed?: number;
  /** Sub-agent sessions only: preference/blocker records dropped because their receipt turn is a role-"user" turn — in a sub-agent session that is the parent agent's brief, not the owner. */
  dropped_subagent_brief?: number;
  /** Open blockers from EARLIER sessions this session closed (`retire_reason = "resolved_later"`, with a verified evidence quote as the receipt). */
  blockers_resolved_later?: number;
  /** Later-session resolutions the model claimed whose evidence quote did not verify against this session's turns — ignored. */
  blockers_resolution_unverified?: number;
  /** W5/P3: open blockers from EARLIER sessions retired `resolved_observed` because this session's turns carry a forge action on their ref, or an edit + commit on one of their paths — decided before (and instead of) the LLM check. */
  blockers_resolved_observed?: number;
  /** W5/B7: records of this run kept as a recurrence of a live record from another session (`recurs_of` set, the earlier row's `recurrence_count` incremented) — counted, never merged. */
  recurrences?: number;
  /** code_session_issues rows this run wrote (grounded), and how many the model offered before grounding (migration 099). */
  issues?: number;
  issues_offered?: number;
  /** v24 (migration 125): session_feedback rows this run offered — what was said about Membral itself, never a record. */
  feedback?: number;
  /** v24: served_record_verdicts rows this run upserted (one per record served into the session). */
  served_verdicts?: number;
  /** v24: confirmed/contradicted answers dropped to unused for want of a verbatim quote in this session (D-021). */
  served_verdicts_no_receipt?: number;
}

/** `--reverify`'s PostgREST scope (review v6 m5): live rows plus rows retired exactly as `unverified` / `unverified:<reason>`. */
export const REVERIFY_SCOPE_OR_FILTER =
  "retired_at.is.null,retire_reason.eq.unverified,retire_reason.like.unverified:*";

/** The stored state `planReverifyUpdate` compares a fresh grounding result against. */
export interface ReverifyRowState {
  verified: boolean;
  turn_idx: number;
  quote: string | null;
  turn_role: string | null;
  retired_at: string | null;
  retire_reason: string | null;
}

/** The fresh grounding result for one row (verify.ts's `VerifyOutcome` subset). */
export interface ReverifyOutcomeLike {
  verified: boolean;
  turn_idx: number;
  quote?: string;
  turn_role?: "user" | "assistant";
  reason?: string | null;
}

export interface ReverifyPlan {
  /** `null` when nothing changes. */
  update: Record<string, unknown> | null;
  unretire: boolean;
  retire: boolean;
  verifiedChanged: boolean;
  turnIdxChanged: boolean;
  quoteChanged: boolean;
  turnRoleChanged: boolean;
}

/**
 * D3 decision B: backfill's `--reverify` plan for one row. A row retired as
 * unverified that now grounds is un-retired (both columns cleared); a live
 * row that now fails is retired as unverified. A row retired for any OTHER
 * reason (rerun, duplicate, preference_assistant_turn, or a pre-086 NULL
 * reason) is never un-retired, even if the query let it through.
 */
export function planReverifyUpdate(row: ReverifyRowState, outcome: ReverifyOutcomeLike, now: string): ReverifyPlan {
  const verifiedChanged = outcome.verified !== row.verified;
  const turnIdxChanged = outcome.turn_idx !== row.turn_idx;
  const quoteChanged = outcome.quote !== undefined && outcome.quote !== row.quote;
  const turnRoleChanged = outcome.turn_role !== undefined && outcome.turn_role !== row.turn_role;
  const isRetired = row.retired_at !== null;
  if (isRetired && !isRetiredUnverified(row.retire_reason)) {
    return {
      update: null,
      unretire: false,
      retire: false,
      verifiedChanged: false,
      turnIdxChanged: false,
      quoteChanged: false,
      turnRoleChanged: false,
    };
  }
  const unretire = isRetired && outcome.verified;
  const retire = !isRetired && !outcome.verified;
  const plan = { unretire, retire, verifiedChanged, turnIdxChanged, quoteChanged, turnRoleChanged };
  if (!verifiedChanged && !turnIdxChanged && !quoteChanged && !turnRoleChanged && !unretire && !retire) {
    return { update: null, ...plan };
  }
  const update: Record<string, unknown> = { verified: outcome.verified, turn_idx: outcome.turn_idx };
  if (quoteChanged) update.quote = outcome.quote;
  if (turnRoleChanged) update.turn_role = outcome.turn_role;
  if (unretire) {
    update.retired_at = null;
    update.retire_reason = null;
  }
  if (retire) {
    update.retired_at = now;
    update.retire_reason = unverifiedRetireReason(outcome.reason);
  }
  return { update, ...plan };
}

/** One batch upsert, falling back to per-row upserts so one bad row never loses the rest. */
async function upsertRows(supabase: Db, userId: string, sessionId: string, rows: InsertRow[]): Promise<InsertedRow[]> {
  if (rows.length === 0) return [];
  const batchRes = await supabase
    .from("session_memories")
    .upsert(rows, { onConflict: "user_id,code_session_id,content_hash" })
    .select("id, content_hash, retired_at, verified");
  if (!batchRes.error) return batchRes.data as InsertedRow[];
  // A single row violating a DB check constraint (e.g. a mis-grounded
  // preference — see merge.ts's groundRecord doc comment) fails the WHOLE
  // batch upsert, which would otherwise lose every OTHER good record in
  // this session. Fall back to one row at a time, skipping (and logging)
  // only the row(s) that individually fail — never losing the rest.
  log.warn("memory: batch insert failed — falling back to per-row insert so one bad record doesn't lose the rest", {
    user_id: userId,
    code_session_id: sessionId,
    err: batchRes.error.message,
  });
  const inserted: InsertedRow[] = [];
  for (const row of rows) {
    const rowRes = await supabase
      .from("session_memories")
      .upsert([row], { onConflict: "user_id,code_session_id,content_hash" })
      .select("id, content_hash, retired_at, verified");
    if (rowRes.error) {
      log.warn("memory: per-row insert failed — dropping this one record", {
        user_id: userId,
        code_session_id: sessionId,
        content_hash: row.content_hash,
        kind: row.kind,
        err: rowRes.error.message,
      });
      continue;
    }
    inserted.push(...(rowRes.data as InsertedRow[]));
  }
  return inserted;
}

/**
 * Upserts one session's grounded, embedded, deduped records. Idempotent by
 * design's own unique constraint `(user_id, code_session_id, content_hash)`
 * — a re-run of an already-extracted session (the backfill script normally
 * skips those via `memory_extraction` in props, but this stays safe even if
 * forced) never duplicates a row.
 *
 * D3 decision B (2026-09-24), retire-on-write: a record that failed
 * grounding (`verified: false`) is still INSERTED — never deleted, never
 * silently dropped — but already retired (`retired_at = now()`,
 * `retire_reason = "unverified:<reason>"`, migration 086), so no serving
 * path returns it and `--reverify` can bring it back if it later grounds.
 * Verified and unverified rows go in two separate upserts so the verified
 * payload never carries `retired_at`: an upsert conflicting with an existing
 * row must not resurrect a row some other path retired.
 */
export async function insertMemoryRecords(
  supabase: Db,
  userId: string,
  codeProjectId: string,
  sessionId: string,
  branch: string | null,
  records: InsertableRecord[],
  sessionTitle: string | null = null,
): Promise<
  Array<{
    id: string;
    contentHash: string;
    kind: string;
    text: string;
    embedding: number[] | null;
    verified: boolean;
    /** The row's state AFTER this write: not retired. Only live rows may take part in supersede (review v6 M4). */
    live: boolean;
  }>
> {
  if (records.length === 0) return [];
  const retiredAt = new Date().toISOString();

  const hashes = [...new Set(records.map((r) => r.contentHash))];
  const existingRes = await supabase
    .from("session_memories")
    .select("id, content_hash, retired_at, retire_reason, verified")
    .eq("user_id", userId)
    .eq("code_session_id", sessionId)
    .in("content_hash", hashes);
  if (existingRes.error) throw new Error(`insertMemoryRecords: existing-row read failed: ${existingRes.error.message}`);
  const existing = new Map(((existingRes.data ?? []) as ExistingRow[]).map((r) => [r.content_hash, r]));

  const { keepLive, lift, insertRetired, matchedOnly, reasonBack, recurrenceIncrements } = planInsert(
    records,
    existing,
    { userId, codeProjectId, sessionId, branch, retiredAt, sessionTitle },
  );

  const inserted: InsertedRow[] = [
    ...(await upsertRows(supabase, userId, sessionId, keepLive)),
    ...(await upsertRows(supabase, userId, sessionId, lift)),
    ...(await upsertRows(supabase, userId, sessionId, insertRetired)),
    ...matchedOnly,
  ];
  for (const [reason, ids] of reasonBack) {
    const { error } = await supabase
      .from("session_memories")
      .update({ retire_reason: reason })
      .eq("user_id", userId)
      .in("id", ids)
      .eq("retire_reason", RERUN_RETIRE_REASON);
    if (error) throw new Error(`insertMemoryRecords: rerun re-tag failed: ${error.message}`);
  }

  // B7 (counts planned in planInsert): best effort — the rows are already
  // written, so a failed increment is logged, never thrown.
  if (recurrenceIncrements.size > 0) {
    await incrementRecurrenceCounts(supabase, userId, recurrenceIncrements);
  }

  const byHash = new Map(inserted.map((row) => [row.content_hash, row]));
  const withIds = records.map((r) => {
    const row = byHash.get(r.contentHash);
    return row
      ? {
          id: row.id,
          contentHash: r.contentHash,
          kind: r.kind as string,
          text: r.text,
          embedding: r.embedding,
          verified: row.verified ?? r.verified,
          live: (row.retired_at ?? null) === null,
        }
      : null;
  });
  return withIds.filter((r): r is NonNullable<(typeof withIds)[number]> => r !== null);
}

/**
 * Review N2: a chain re-roots on a live row when its old root is retired
 * (dropCrossSessionDuplicates). The old root's `recurrence_count` already
 * counted the new root's occurrence and every other one before it, so the
 * new root takes max(own, old root's) before this run's increment — else
 * A -> B -> C with A retired reads "seen 2x", not 3x. max() makes it
 * idempotent: a later re-root onto the same row carries nothing new.
 */
async function carryRetiredRootCounts(supabase: Db, userId: string, rootIds: string[]): Promise<void> {
  const { data: roots, error } = await supabase
    .from("session_memories")
    .select("id, recurs_of, recurrence_count")
    .eq("user_id", userId)
    .in("id", rootIds)
    .is("retired_at", null);
  if (error) throw new Error(error.message);
  const rows = (
    (roots ?? []) as Array<{ id: string; recurs_of: string | null; recurrence_count: number | null }>
  ).filter((r) => !!r.recurs_of);
  if (rows.length === 0) return;
  const { data: olds, error: oldErr } = await supabase
    .from("session_memories")
    .select("id, recurrence_count")
    .eq("user_id", userId)
    .in("id", [...new Set(rows.map((r) => r.recurs_of as string))])
    .not("retired_at", "is", null);
  if (oldErr) throw new Error(oldErr.message);
  for (const { id, count } of planCarriedRootCounts(
    rows,
    (olds ?? []) as Array<{ id: string; recurrence_count: number | null }>,
  )) {
    const { error: updErr } = await supabase
      .from("session_memories")
      .update({ recurrence_count: count })
      .eq("user_id", userId)
      .eq("id", id);
    if (updErr) throw new Error(updErr.message);
  }
}

/**
 * B7: `recurrence_count += n` on each chain root, atomically in SQL
 * (migration 105's `increment_memory_recurrence`: one UPDATE ... SET
 * recurrence_count = recurrence_count + n, live rows only — a retired root
 * is never bumped, and two sessions of a project extracted at once never
 * lose an increment). Until 105 is applied the RPC errors and a
 * read-then-write over the LIVE roots stands in. Never throws — the
 * recurrence rows are already stored; a failed count is logged.
 */
async function incrementRecurrenceCounts(supabase: Db, userId: string, increments: Map<string, number>): Promise<void> {
  try {
    const ids = [...increments.keys()];
    await carryRetiredRootCounts(supabase, userId, ids);
    const { error: rpcErr } = await supabase.rpc("increment_memory_recurrence", {
      p_user_id: userId,
      p_ids: ids,
      p_counts: ids.map((id) => increments.get(id) ?? 0),
    });
    if (!rpcErr) return;
    const { data, error } = await supabase
      .from("session_memories")
      .select("id, recurrence_count")
      .eq("user_id", userId)
      .in("id", ids)
      .is("retired_at", null);
    if (error) throw new Error(error.message);
    for (const { id, count } of planFallbackCounts(
      (data ?? []) as Array<{ id: string; recurrence_count: number | null }>,
      increments,
    )) {
      const { error: updErr } = await supabase
        .from("session_memories")
        .update({ recurrence_count: count })
        .eq("user_id", userId)
        .eq("id", id);
      if (updErr) throw new Error(updErr.message);
    }
  } catch (err) {
    log.warn("memory: recurrence count update failed — recurrence rows kept, count not bumped", {
      user_id: userId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** #174: a per-kind live read above this many rows logs its size (visibility only; nothing is capped). */
const LARGE_LIVE_SCOPE_ROWS = 2000;

/**
 * Drops records headed LIVE (verified, no retireReason) that restate a live
 * record already stored for this user + project + kind from ANOTHER session:
 * normalized text equal (`normalizeForDedup`: case, whitespace, trailing punctuation) or embedding cosine >=
 * `CROSS_SESSION_DUP_COSINE_THRESHOLD`. The stored record stays the one
 * served; nothing is inserted, so the echo never becomes a second "new"
 * learning. Rows headed retired pass through untouched (they are never
 * served). There is no evidence-list column to append the session to, so a
 * drop is only counted and logged. Best-effort: a lookup failure keeps every
 * record (the later supersede pass still links paraphrases).
 *
 * B7 (W5): a kept blocker (`RECURRENCE_KINDS`) the extraction call linked to
 * an offered open blocker, or whose best cross-session cosine lies in `[RECURRENCE_COSINE_THRESHOLD, CROSS_SESSION_DUP_
 * COSINE_THRESHOLD)` is returned with `recursOf` = the earliest row of that
 * chain (the match's own `recurs_of` when it is itself a recurrence AND that
 * root is still live, else the match — the count always lands on a LIVE
 * root; the earliest-created match wins when several qualify).
 * `insertMemoryRecords` writes it and bumps the root's `recurrence_count`;
 * `mergeSemanticDuplicates` must be told to leave these rows alone.
 * e2e A-B4 / prompt v12: "recurs" is the extraction call's `recurs_of` on an
 * offered open blocker (`recursOfHint`, any cosine), else the cosine band;
 * a session counts once per chain — a second record of this batch recurring
 * the same root is kept as its own row when its text differs (it may be a
 * distinct wall the model or the cosine band linked to the same root), with
 * `countsRecurrence: false` so the root's count moves once; the same text
 * again is a duplicate and dropped.
 */
export async function dropCrossSessionDuplicates<T extends InsertableRecord>(
  supabase: Db,
  userId: string,
  codeProjectId: string,
  sessionId: string,
  records: T[],
): Promise<{ kept: T[]; deduped: number; recurrences: number }> {
  const headedLive = (r: T) => r.verified && !r.retireReason;
  const kinds = [...new Set(records.filter(headedLive).map((r) => r.kind as string))];
  if (kinds.length === 0) return { kept: records, deduped: 0, recurrences: 0 };

  const liveByKind = new Map<string, LiveRow[]>();
  /** Every live row id of the scope (this session's too) — a chain root outside it is retired and never takes the count. */
  const liveIds = new Set<string>();
  try {
    for (const kind of kinds) {
      // #174: every live row of the scope, paged — a match older than any fixed window must still be found.
      // Offset paging via selectAllRows, not selectAllByIdKeyset: the first-hit match wants newest-first
      // order; a row retired mid-read can shift a page into a miss, a row inserted mid-read can repeat one
      // (both planners dedupe by id), neither makes a wrong link.
      const data = await selectAllRows<FetchedLiveRow>((from, to) =>
        supabase
          .from("session_memories")
          .select("id, code_session_id, text, embedding, created_at, recurs_of")
          .eq("user_id", userId)
          .eq("code_project_id", codeProjectId)
          .eq("kind", kind)
          .is("retired_at", null)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
      );
      if (data.length > LARGE_LIVE_SCOPE_ROWS) {
        log.info("memory: cross-session dedup read a large live scope", { user_id: userId, kind, rows: data.length });
      }
      const { rows, ids } = toLiveRows(data, sessionId);
      for (const id of ids) liveIds.add(id);
      liveByKind.set(kind, rows);
    }
  } catch (err) {
    log.warn("memory: cross-session dedup lookup failed — keeping every record", {
      user_id: userId,
      code_session_id: sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { kept: records, deduped: 0, recurrences: 0 };
  }

  const { kept, deduped, recurrences, notes } = planCrossSessionDedup(records, liveByKind, liveIds);
  for (const { msg, fields } of notes) {
    log.info(msg, { user_id: userId, code_session_id: sessionId, ...fields });
  }
  return { kept, deduped, recurrences };
}

/**
 * step2b `--force` re-run: retires (NEVER deletes — `retired_at = now()`)
 * every currently-live `source='extractor'` row on this session, so a
 * prompt-version re-run doesn't leave the old and new extraction both
 * "live" at once. `supersedes` on any row is left untouched — retiring is
 * orthogonal to the supersede chain. Returns the ids retired (for
 * `props.memory_extraction.previous.records`) and the timestamp used.
 *
 * Kept for callers that genuinely want "retire everything live on this
 * session" (e.g. the `--repair-paths` repair pass). `runTailCaptureForSession`
 * itself no longer calls this directly for `--force` — see
 * `retireRowsByIds` below (step2d finding 7: retire happens AFTER the new
 * rows are inserted, so it must target specific prior ids, never a blanket
 * "all live extractor rows", which would also retire the rows just written).
 */
export async function retireExtractorRowsForSession(
  supabase: Db,
  userId: string,
  sessionId: string,
): Promise<{ retiredIds: string[]; retiredAt: string }> {
  const retiredAt = new Date().toISOString();
  const { data, error } = await supabase
    .from("session_memories")
    .update(retireUpdate(retiredAt, RERUN_RETIRE_REASON))
    .eq("user_id", userId)
    .eq("code_session_id", sessionId)
    .eq("source", "extractor")
    .is("retired_at", null)
    .select("id");
  if (error) throw new Error(`retireExtractorRowsForSession failed: ${error.message}`);
  return { retiredIds: returnedIds(data), retiredAt };
}

/**
 * step2d finding 7: retires (never deletes) EXACTLY the given row ids —
 * used by the reordered `--force` pipeline (extract -> embed -> insert new
 * rows -> retire the specific prior-version ids), so the just-inserted rows
 * (which also carry `source='extractor'`) are never accidentally swept up
 * by a blanket "all live extractor rows for this session" retire. A no-op
 * (no query issued) for an empty id list.
 */
export async function retireRowsByIds(
  supabase: Db,
  userId: string,
  ids: string[],
  reason: string = RERUN_RETIRE_REASON,
): Promise<{ retiredIds: string[]; retiredAt: string }> {
  const retiredAt = new Date().toISOString();
  if (ids.length === 0) return { retiredIds: [], retiredAt };
  const { data, error } = await supabase
    .from("session_memories")
    .update(retireUpdate(retiredAt, reason))
    .eq("user_id", userId)
    .in("id", ids)
    .is("retired_at", null)
    .select("id");
  if (error) throw new Error(`retireRowsByIds failed: ${error.message}`);
  return { retiredIds: returnedIds(data), retiredAt };
}

/**
 * Review v6 M1: on `--force`, rows of the REPLACED extraction that were
 * already retired as unverified are re-tagged `rerun` (retired_at kept), so
 * `--reverify` — which may un-retire only `unverified*` rows — can never
 * bring a superseded extraction's row back next to the new run's. Rows
 * whose retire_reason is anything else are left alone.
 */
export async function retagUnverifiedAsRerun(supabase: Db, userId: string, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const { data, error } = await supabase
    .from("session_memories")
    .update({ retire_reason: RERUN_RETIRE_REASON })
    .eq("user_id", userId)
    .in("id", ids)
    .not("retired_at", "is", null)
    .select("id, retire_reason");
  if (error) throw new Error(`retagUnverifiedAsRerun failed: ${error.message}`);
  return returnedIds(data);
}

/**
 * Supersede rule (§2): each newly-inserted record is compared against LIVE
 * records of the same (user_id, code_project_id, kind). Two mechanisms:
 *
 *  1. step2e finding 4 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
 *     #151): an EXACT cross-session duplicate — `text` equal once
 *     case/whitespace/trailing-punctuation-normalized (`merge.ts`'s
 *     `normalizeForDedup`; UX W6 added the trailing punctuation, so "X" and
 *     "X." are one fact) — is not a "similar"
 *     record, it is the SAME fact re-extracted from a different session
 *     (the concrete evidence: "Missing <service-role key env var> blocks the
 *     migration" showing up as three independently-extracted, independently
 *     unverified, all-still-"live" rows). The older row is RETIRED outright
 *     (never just linked) so a duplicate chain ends with exactly one live
 *     row, never three live twins.
 *  2. The pre-existing cosine >= 0.90 paraphrase check: the newer row's
 *     `supersedes` points at the older, WITHOUT retiring it (a paraphrase
 *     might still read differently enough to keep both visible) — unchanged
 *     from before step2e.
 *
 * Never deletes. Best-effort — a failure here is logged and swallowed (the
 * records themselves already landed; supersede linking/retiring is an
 * enrichment, not a correctness requirement for D2).
 */
// Known limit (L8, calibration/REPORT.md "Known limits"): this live-row read does not filter on embedding_model, so a
// store holding two embedding families compares cosines across families. Follow-up: scope by model before mixing.
export async function supersedeRecords(
  supabase: Db,
  userId: string,
  codeProjectId: string,
  inserted: SupersedeInsertedRecord[],
): Promise<number> {
  let linked = 0;
  const byKind = groupSupersedeByKind(inserted);

  for (const [kind, newRecords] of byKind) {
    try {
      // #174: every live row of the scope, paged — the only match may be the oldest row. Offset paging
      // via selectAllRows (see dropCrossSessionDuplicates): a concurrent retire can cause a miss, an insert a repeat.
      const data = await selectAllRows<SupersedeLiveRow>((from, to) =>
        supabase
          .from("session_memories")
          .select("id, text, embedding")
          .eq("user_id", userId)
          .eq("code_project_id", codeProjectId)
          .eq("kind", kind)
          .is("retired_at", null)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .range(from, to),
      );
      if (data.length > LARGE_LIVE_SCOPE_ROWS) {
        log.info("memory: supersede read a large live scope", { user_id: userId, kind, rows: data.length });
      }
      const plan = planSupersede(newRecords, data);

      for (const link of plan.links) {
        // step2d finding 13: `.eq("user_id", userId)` added — belt and
        // braces, matching updateSessionMemoryProps/retireExtractorRowsForSession.
        // Not exploitable today (rec.id always comes from this run's own
        // insert `.select()`), but this is the one write in the module
        // that previously didn't carry the tenant key.
        const { error: updateError } = await supabase
          .from("session_memories")
          .update({ supersedes: link.supersedes })
          .eq("id", link.id)
          .eq("user_id", userId);
        if (updateError) throw new Error(updateError.message);
        linked++;
      }

      if (plan.retireIds.length > 0) {
        const retiredAt = new Date().toISOString();
        const { error: retireError } = await supabase
          .from("session_memories")
          .update({ retired_at: retiredAt, retire_reason: DUPLICATE_RETIRE_REASON })
          .eq("user_id", userId)
          .in("id", plan.retireIds)
          .is("retired_at", null);
        if (retireError) throw new Error(retireError.message);
      }
    } catch (err) {
      log.warn("memory: supersede pass failed for kind — records already landed, skipping enrichment", {
        user_id: userId,
        code_project_id: codeProjectId,
        kind,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return linked;
}

/**
 * Kinds semantic dedup merges. Never 'outcome': an outcome is a delivery
 * receipt, and two similar ones are two deliveries.
 */
export const SEMANTIC_DEDUP_KINDS: readonly string[] = ["learning", "blocker", "decision", "preference"];

/**
 * The semantic-dedup cut: `MEMBRAL_MEMORY_DEDUP_MIN_SIM` when it parses to (0, 1], else the embedding family's
 * calibrated value (0.80 on the default family). null = the family has no calibrated cut, so the pass is skipped
 * (an env override never enables it for an uncalibrated model).
 */
export function semanticDedupMinSim(
  env: Record<string, string | undefined> = process.env,
  family: string = currentEmbeddingFamily(env),
): number | null {
  const calibrated = vectorThreshold("semantic_dedup", family);
  if (calibrated === null) return null;
  const v = Number.parseFloat(env.MEMBRAL_MEMORY_DEDUP_MIN_SIM ?? "");
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : calibrated;
}

/**
 * `MEMBRAL_MEMORY_DEDUP_KINDS` (comma list) narrowed to `SEMANTIC_DEDUP_KINDS`
 * — 'outcome' or an unknown kind is dropped; an empty result falls back to
 * the default list.
 */
export function semanticDedupKinds(env: Record<string, string | undefined> = process.env): string[] {
  const picked = (env.MEMBRAL_MEMORY_DEDUP_KINDS ?? "")
    .split(",")
    .map((k) => k.trim())
    .filter((k) => SEMANTIC_DEDUP_KINDS.includes(k));
  return picked.length > 0 ? [...new Set(picked)] : [...SEMANTIC_DEDUP_KINDS];
}

/** One row of `memory_semantic_duplicates`: `existing_id` is always the OLDER memory. */
export interface SemanticDuplicatePair {
  new_id: string;
  existing_id: string;
  sim: number;
  kind: string;
  new_created_at: string;
  existing_created_at: string;
}

/** One planned merge: `retired_id` is retired in favour of the cluster survivor `kept_id`. */
export interface SemanticMerge {
  kept_id: string;
  retired_id: string;
  sim: number;
  kind: string;
}

/** Sort key for a Postgres timestamptz string, keeping microseconds (Date.parse drops them). */
function tsKey(ts: string): [number, number] {
  const micro = /\.(\d+)/.exec(ts)?.[1] ?? "";
  return [Date.parse(ts), Number.parseInt(micro.padEnd(6, "0").slice(3, 6), 10) || 0];
}

function isNewer(a: { at: string; id: string }, b: { at: string; id: string }): boolean {
  const [am, au] = tsKey(a.at);
  const [bm, bu] = tsKey(b.at);
  if (am !== bm) return am > bm;
  if (au !== bu) return au > bu;
  return a.id > b.id;
}

/**
 * Groups pairs into duplicate clusters (connected components) and keeps ONLY
 * the newest row of each — (created_at, id) order, the same order the SQL
 * uses. Every other row of the cluster is retired in favour of that survivor,
 * so a chain A~B~C ends with one live row (C), and a retired row is never
 * left as the match target of another. `sim` is the row's direct similarity
 * to the survivor when the SQL returned that pair, else its best similarity
 * to any cluster member (the edge that joined it). `link` is the survivor's
 * best direct older match, for its `supersedes`. Deterministic for any pair
 * order.
 */
export function planSemanticMerges(pairs: SemanticDuplicatePair[]): {
  merges: SemanticMerge[];
  links: Array<{ id: string; supersedes: string }>;
} {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r) as string;
    let c = x;
    while (c !== r) {
      const next = parent.get(c) as string;
      parent.set(c, r);
      c = next;
    }
    return r;
  };
  const created = new Map<string, string>();
  const kinds = new Map<string, string>();
  const bestEdge = new Map<string, number>();
  const direct = new Map<string, number>();
  for (const p of pairs) {
    for (const id of [p.new_id, p.existing_id]) if (!parent.has(id)) parent.set(id, id);
    created.set(p.new_id, p.new_created_at);
    created.set(p.existing_id, p.existing_created_at);
    kinds.set(p.new_id, p.kind);
    kinds.set(p.existing_id, p.kind);
    for (const id of [p.new_id, p.existing_id]) bestEdge.set(id, Math.max(bestEdge.get(id) ?? 0, p.sim));
    const key = `${p.new_id}|${p.existing_id}`;
    direct.set(key, Math.max(direct.get(key) ?? 0, p.sim));
    const a = find(p.new_id);
    const b = find(p.existing_id);
    if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
  }
  const clusters = new Map<string, string[]>();
  for (const id of [...parent.keys()].sort()) {
    const root = find(id);
    const list = clusters.get(root) ?? [];
    list.push(id);
    clusters.set(root, list);
  }
  const merges: SemanticMerge[] = [];
  const links: Array<{ id: string; supersedes: string }> = [];
  for (const members of clusters.values()) {
    let survivor = members[0] as string;
    for (const id of members) {
      if (isNewer({ at: created.get(id) ?? "", id }, { at: created.get(survivor) ?? "", id: survivor })) survivor = id;
    }
    let bestLink: { id: string; sim: number } | null = null;
    for (const id of members) {
      if (id === survivor) continue;
      const d = direct.get(`${survivor}|${id}`);
      merges.push({
        kept_id: survivor,
        retired_id: id,
        sim: d ?? bestEdge.get(id) ?? 0,
        kind: kinds.get(id) ?? "",
      });
      if (d !== undefined && (!bestLink || d > bestLink.sim || (d === bestLink.sim && id < bestLink.id))) {
        bestLink = { id, sim: d };
      }
    }
    if (bestLink) links.push({ id: survivor, supersedes: bestLink.id });
  }
  return { merges, links };
}

/**
 * Applies semantic-duplicate pairs (planned by `planSemanticMerges`): each
 * cluster's non-survivors are retired with `semantic_duplicate`, one
 * `memory_merges` row is logged per row actually retired (`source`), and the
 * survivor's `supersedes` is set to its best direct match ONLY when still
 * null — an existing link is never overwritten. Never deletes. Throws on a
 * write error (callers decide).
 */
export async function applySemanticDuplicates(
  supabase: Db,
  userId: string,
  pairs: SemanticDuplicatePair[],
  source: "write" | "cleanup" = "write",
): Promise<{ retiredIds: string[]; linkedIds: string[]; merges: SemanticMerge[] }> {
  if (pairs.length === 0) return { retiredIds: [], linkedIds: [], merges: [] };
  const plan = planSemanticMerges(pairs);
  const linkedIds: string[] = [];
  for (const l of plan.links) {
    const { data, error } = await supabase
      .from("session_memories")
      .update({ supersedes: l.supersedes })
      .eq("user_id", userId)
      .eq("id", l.id)
      .is("supersedes", null)
      .select("id");
    if (error) throw new Error(`semantic dedup link failed: ${error.message}`);
    if (((data ?? []) as unknown[]).length > 0) linkedIds.push(l.id);
  }
  const retiredIds: string[] = [];
  const toRetire = plan.merges.map((m) => m.retired_id);
  for (let i = 0; i < toRetire.length; i += 200) {
    const { retiredIds: chunk } = await retireRowsByIds(
      supabase,
      userId,
      toRetire.slice(i, i + 200),
      SEMANTIC_DUPLICATE_RETIRE_REASON,
    );
    retiredIds.push(...chunk);
  }
  const retiredSet = new Set(retiredIds);
  const merges = plan.merges.filter((m) => retiredSet.has(m.retired_id));
  for (let i = 0; i < merges.length; i += 200) {
    const { error } = await supabase
      .from("memory_merges")
      .insert(merges.slice(i, i + 200).map((m) => ({ user_id: userId, ...m, source })));
    if (error) throw new Error(`semantic dedup merge log failed: ${error.message}`);
  }
  return { retiredIds, linkedIds, merges };
}

/**
 * Write-time semantic dedup, run after a session's records AND their
 * embeddings are stored: asks Postgres (`memory_semantic_duplicates`) which
 * live memories the new records duplicate — older rows and rows of the same
 * batch alike — and keeps only the newest of each cluster. Never throws — an
 * RPC or write failure is logged and counts 0 (the records already landed;
 * dedup is an enrichment).
 *
 * B7 (W5): `excludeIds` are this run's recurrence rows (`recurs_of` set).
 * They are left out of `p_record_ids` AND any pair naming one of them is
 * dropped — a recurrence is counted, never merged away by this pass either.
 */
// Known limit (L8, calibration/REPORT.md "Known limits"): this live-row read does not filter on embedding_model, so a
// store holding two embedding families compares cosines across families. Follow-up: scope by model before mixing.
export async function mergeSemanticDuplicates(
  supabase: Db,
  userId: string,
  recordIds: string[],
  minSim: number | null = semanticDedupMinSim(),
  kinds: string[] = semanticDedupKinds(),
  excludeIds: ReadonlySet<string> = new Set(),
): Promise<number> {
  const ids = recordIds.filter((id) => !excludeIds.has(id));
  if (ids.length === 0) return 0;
  // L8: the cut is calibrated per embedding family; null = uncalibrated model, the pass is skipped.
  if (minSim === null) return 0;
  try {
    const { data, error } = await supabase.rpc("memory_semantic_duplicates", {
      p_user: userId,
      p_record_ids: ids,
      p_min_sim: minSim,
      p_kinds: kinds.filter((k) => k !== "outcome"),
    });
    if (error) throw new Error(error.message);
    const pairs = ((data ?? []) as SemanticDuplicatePair[]).filter(
      (p) => p.kind !== "outcome" && !excludeIds.has(p.new_id) && !excludeIds.has(p.existing_id),
    );
    const { retiredIds } = await applySemanticDuplicates(supabase, userId, pairs, "write");
    if (retiredIds.length > 0) {
      log.info("memory: retired semantic duplicates", { user_id: userId, retired: retiredIds.length });
    }
    return retiredIds.length;
  } catch (err) {
    log.warn("memory: semantic dedup failed — records already landed, skipping", {
      user_id: userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * Stamps `code_sessions.props.memory_extraction` and the checkpoint the next
 * tail-capture run reads (`memory_checkpoint_turn_idx`). Only these keys are
 * written, atomically in SQL (migration 109, `patchCodeSessionProps`): a
 * whole-props write from the snapshot read at the start of the run reverted
 * whatever an import wrote meanwhile (observed: props.usage went back one
 * invocation). From `currentProps` only its `memory_*` keys are carried
 * (e.g. `memory_user_pass_failures`, which the run set locally); every other
 * key is left to whoever owns it.
 *
 * Only `memory_*` keys this run CHANGED are carried (`opts.baseProps` is the
 * snapshot the run started from); an unchanged key is left alone, so a
 * concurrent writer's newer value is never reverted. Without `baseProps`
 * every `memory_*` key of `currentProps` is carried (the older behaviour).
 *
 * step2d finding 3: clears `memory_extraction_lock` — only while it still
 * carries `opts.runId` (a compare-and-delete: never another run's lease);
 * without `runId`, whatever lock is there (the older behaviour) — every completion path (empty-session stamp, no_prose skip, a full
 * extraction) calls this exactly once at the end, so "call
 * updateSessionMemoryProps" and "release the lease lock" are the same
 * event. A run that throws before reaching here is released by
 * runTailCaptureInner's catch; a killed process still leaves its lock to
 * staleness (see `isMemoryExtractionLockHeld`, the "or older than 15 min" fallback).
 */
export async function updateSessionMemoryProps(
  supabase: Db,
  userId: string,
  sessionId: string,
  currentProps: Record<string, unknown>,
  extraction: MemoryExtractionProps,
  checkpointTurnIdx: number | null,
  opts: { baseProps?: Record<string, unknown>; runId?: string } = {},
): Promise<void> {
  const memoryKeys: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(currentProps)) {
    if (!k.startsWith("memory_") || k === "memory_extraction_lock") continue;
    if (opts.baseProps && JSON.stringify(opts.baseProps[k]) === JSON.stringify(v)) continue;
    memoryKeys[k] = v;
  }
  const set = { ...memoryKeys, memory_extraction: extraction, memory_checkpoint_turn_idx: checkpointTurnIdx };
  if (opts.runId === undefined) {
    await patchCodeSessionProps(supabase, userId, sessionId, set, ["memory_extraction_lock"]);
    return;
  }
  await patchCodeSessionProps(supabase, userId, sessionId, set);
  await releaseMemoryExtractionLock(supabase, userId, sessionId, opts.runId);
}

/** Remove `memory_extraction_lock` only while it is still this run's (compare-and-delete, migration 109). */
export async function releaseMemoryExtractionLock(
  supabase: Db,
  userId: string,
  sessionId: string,
  runId: string,
): Promise<boolean> {
  return patchCodeSessionProps(supabase, userId, sessionId, {}, ["memory_extraction_lock"], {
    memory_extraction_lock: { run_id: runId },
  });
}

/**
 * step2d finding 3: per-session advisory lock around extraction, as a lease
 * row rather than a Postgres advisory lock (the reviewer's own note: those
 * aren't usable across separate PostgREST calls). Best-effort/optimistic —
 * NOT a true compare-and-swap (two concurrent runs that both read the
 * session row in the same instant could both pass `isMemoryExtractionLockHeld`
 * and both write a lock); it still closes the practical case this finding
 * was about (a sweep re-uploading the same already-in-flight session a
 * request or two later, well after the first run's lock write has landed).
 * Returns the props object WITH the lock set, for the caller to keep using
 * as its local `currentProps` — `updateSessionMemoryProps` strips the lock
 * back out again at the end of the run.
 */
export async function setMemoryExtractionLock(
  supabase: Db,
  userId: string,
  sessionId: string,
  currentProps: Record<string, unknown>,
  runId: string,
): Promise<Record<string, unknown>> {
  const lock = buildLock(new Date().toISOString(), runId);
  // Only the lock key is written (migration 109); the returned object is the caller's local view.
  await patchCodeSessionProps(supabase, userId, sessionId, { memory_extraction_lock: lock });
  return withLock(currentProps, lock);
}

/**
 * Prompt v12: the open blockers offered to this session's extraction call
 * for `recurs_of` — live blockers of this user + project from OTHER sessions,
 * one per recurrence chain (keyed the way `dropCrossSessionDuplicates`
 * resolves a root: the row's live `recurs_of`, else the row itself), the
 * chain's most-recurring and newest first, at most `cap`. The offered id is
 * the chain key; the text is the newest member's. Never throws: a failed read
 * logs and offers nothing (the cosine band still links).
 */
// Known limit (L8, calibration/REPORT.md "Known limits"): this live-row read does not filter on embedding_model, so a
// store holding two embedding families compares cosines across families. Follow-up: scope by model before mixing.
export async function fetchOpenBlockersForRecurrence(
  supabase: Db,
  userId: string,
  codeProjectId: string,
  sessionId: string,
  cap: number,
): Promise<Array<{ id: string; text: string }>> {
  try {
    const { data, error } = await supabase
      .from("session_memories")
      .select("id, code_session_id, text, created_at, recurs_of, recurrence_count")
      .eq("user_id", userId)
      .eq("code_project_id", codeProjectId)
      .eq("kind", "blocker")
      .is("retired_at", null)
      .order("created_at", { ascending: false })
      .limit(RECURRENCE_OFFER_SCAN_LIMIT);
    if (error) throw new Error(error.message);
    return planOpenBlockerOffers((Array.isArray(data) ? data : []) as FetchedOpenBlockerRow[], sessionId, cap);
  } catch (err) {
    log.warn("memory: open-blocker read for recurrence failed — none offered", {
      user_id: userId,
      code_session_id: sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/**
 * The open blockers a session may resolve after the fact: same user and
 * project, `kind = 'blocker'`, live (`retired_at is null`), not the target of
 * another live blocker's `supersedes`, not from `sessionId` itself, created
 * within `freshDays`, from main OR sub-agent sessions — and only from
 * sessions that STARTED before `beforeTs` (this session's last turn), so a
 * backlog re-extraction of an old session can never close a newer blocker.
 * A session with no `started_at` is excluded (its order is unknown). Most
 * recent first, at most `cap`. Throws on a DB error (the caller logs and
 * skips).
 */
export async function fetchLaterResolutionCandidates(
  supabase: Db,
  userId: string,
  codeProjectId: string,
  sessionId: string,
  beforeTs: string,
  freshDays: number,
  cap: number,
  now: number = Date.now(),
): Promise<LaterResolutionCandidate[]> {
  const before = Date.parse(beforeTs);
  if (!Number.isFinite(before)) return [];
  const cutoff = laterResolutionCutoff(now, freshDays);
  const { data, error } = await supabase
    .from("session_memories")
    .select("id, code_session_id, text, quote, supersedes, created_at, ref, paths")
    .eq("user_id", userId)
    .eq("code_project_id", codeProjectId)
    .eq("kind", "blocker")
    .is("retired_at", null)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(LATER_RESOLUTION_SCAN_LIMIT);
  if (error) throw new Error(`fetchLaterResolutionCandidates: blockers read failed: ${error.message}`);
  const others = unsupersededOtherSessionRows((data ?? []) as FetchedLaterResolutionRow[], sessionId);
  if (others.length === 0) return [];

  const sessionIds = candidateSessionIds(others);
  const { data: sessData, error: sessErr } = await supabase
    .from("code_sessions")
    .select("id, started_at")
    .eq("user_id", userId)
    .in("id", sessionIds);
  if (sessErr) throw new Error(`fetchLaterResolutionCandidates: sessions read failed: ${sessErr.message}`);
  const startedBefore = sessionsStartedBefore((sessData ?? []) as FetchedSessionStartRow[], before);
  return planLaterResolutionCandidates(others, startedBefore, cap);
}

/**
 * Retires each resolved blocker with `retire_reason = "resolved_later"` and
 * its receipt (migration 092's `resolved_by_session_id`, `resolution_quote`,
 * `resolution_turn_idx`). Only a still-live row is touched. Never throws: a
 * failed update is logged and skipped (never fails the extraction). Returns
 * how many rows were actually retired. `reason` defaults to `resolved_later`;
 * the observed pre-check (W5, `observed-retirement.ts`) passes
 * `RESOLVED_OBSERVED_RETIRE_REASON` with the closing action as the quote.
 */
export async function retireBlockersResolvedLater(
  supabase: Db,
  userId: string,
  receipts: LaterResolutionReceipt[],
  reason: string = RESOLVED_LATER_RETIRE_REASON,
): Promise<number> {
  let retired = 0;
  const retiredAt = new Date().toISOString();
  for (const r of receipts) {
    try {
      const { data, error } = await supabase
        .from("session_memories")
        .update(resolvedBlockerUpdate(retiredAt, reason, r))
        .eq("user_id", userId)
        .eq("id", r.memoryId)
        .is("retired_at", null)
        .select("id");
      if (error) throw new Error(error.message);
      retired += ((data ?? []) as unknown[]).length;
    } catch (err) {
      log.warn("memory: could not retire a blocker resolved in a later session — left open", {
        user_id: userId,
        memory_id: r.memoryId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return retired;
}

/** A live row `findSubagentBriefRows` considers. */
export interface SubagentBriefCandidateRow {
  id: string;
  user_id: string;
  code_session_id: string;
  kind: string;
  turn_role: string;
  retired_at: string | null;
}

/** How many session ids go into one `.in("id", …)` lookup — keeps the PostgREST URL short. */
const SUBAGENT_LOOKUP_CHUNK = 200;

/**
 * Pure selection for the sub-agent-brief cleanup: a LIVE preference or
 * blocker whose receipt turn is role "user" and whose session is a sub-agent
 * session (id in `subAgentSessionIds`). Everything else is kept.
 */
export function selectSubagentBriefRows<T extends SubagentBriefCandidateRow>(
  rows: readonly T[],
  subAgentSessionIds: ReadonlySet<string>,
): T[] {
  return rows.filter(
    (r) =>
      r.retired_at === null &&
      (r.kind === "preference" || r.kind === "blocker") &&
      r.turn_role === "user" &&
      subAgentSessionIds.has(r.code_session_id),
  );
}

/**
 * Reads every live preference/blocker with `turn_role = 'user'` (optionally
 * for one user), looks up which of their sessions are sub-agent sessions
 * (`parent_source_session_id is not null`), and returns the rows
 * `selectSubagentBriefRows` picks. Read-only.
 */
export async function findSubagentBriefRows(supabase: Db, userId?: string): Promise<SubagentBriefCandidateRow[]> {
  const rows = (await selectAllRows((from, to) => {
    let q = supabase
      .from("session_memories")
      .select("id, user_id, code_session_id, kind, turn_role, retired_at")
      .in("kind", ["preference", "blocker"])
      .eq("turn_role", "user")
      .is("retired_at", null);
    if (userId) q = q.eq("user_id", userId);
    return q.order("id", { ascending: true }).range(from, to);
  })) as SubagentBriefCandidateRow[];
  const sessionIds = [...new Set(rows.map((r) => r.code_session_id))];
  const subAgentIds = new Set<string>();
  for (let i = 0; i < sessionIds.length; i += SUBAGENT_LOOKUP_CHUNK) {
    const { data, error } = await supabase
      .from("code_sessions")
      .select("id")
      .in("id", sessionIds.slice(i, i + SUBAGENT_LOOKUP_CHUNK))
      .not("parent_source_session_id", "is", null);
    if (error) throw new Error(`findSubagentBriefRows: sessions read failed: ${error.message}`);
    for (const r of (data ?? []) as Array<{ id: string }>) subAgentIds.add(r.id);
  }
  return selectSubagentBriefRows(rows, subAgentIds);
}

/**
 * Writes a session's grounded issues to code_session_issues (migration 099).
 * `replace` (a run that covered the session from its first turn): the
 * session's existing rows are deleted first, so re-extraction replaces them.
 * Otherwise (a tail run) new rows are added and an existing (session, ref,
 * kind, role) row is left as is. Returns the number of rows offered.
 */
export async function writeSessionIssues(
  supabase: Db,
  userId: string,
  sessionId: string,
  issues: readonly GroundedSessionIssue[],
  replace: boolean,
): Promise<number> {
  if (replace) {
    const { error } = await supabase
      .from("code_session_issues")
      .delete()
      .eq("user_id", userId)
      .eq("session_id", sessionId);
    if (error) throw new Error(`writeSessionIssues: delete failed: ${error.message}`);
  }
  if (issues.length === 0) return 0;
  const rows = sessionIssueRows(sessionId, userId, issues);
  const { error } = await supabase
    .from("code_session_issues")
    .upsert(rows, { onConflict: "session_id,ref,kind,role", ignoreDuplicates: true });
  if (error) throw new Error(`writeSessionIssues: insert failed: ${error.message}`);
  return rows.length;
}
