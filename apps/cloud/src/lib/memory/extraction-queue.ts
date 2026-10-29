// Goal 2026-09-24 review B1/M1/M2/M3/m6: memory extraction runs off the
// memory_extraction_queue table (migrations 087 + 088), one session per
// step, several steps per serverless invocation.
//
//   upload route  -> enqueueMemoryExtraction (rows 'pending') + one trigger
//   extract-next  -> processNextMemoryExtraction: claim one row (lease),
//                    gate on budget, extract, flush spend, mark it finished
//                    -> issue #339: extraction-trigger.ts loops the next step
//                       in the same invocation while time remains (the old
//                       self-POST chain was refused by the host as a loop)
//   cron          -> re-kicks users with pending rows or expired leases
//
// SPEND GATES, per session, in order (each a logged skip, never a throw):
//   1. `memory` feature (feature-flags.ts; default on, does NOT need `llm`)
//   2. monthly per-user budget (hosted mode): memory spend since the UTC
//      month start < MEMBRAL_MEMORY_MONTHLY_BUDGET_USD (default $2)
//   3. global daily ceiling (global-ceiling.ts; fails closed)
// The LlmClient's hard cap is min(per-run cap, session budget, what is left
// of every allowance above) — review M2: a run can never spend past the
// user's remaining budget or the global remaining.
//
// KNOWN BOUND (P10 re-review N-m1, documented, not reserved in the DB): each
// user's chain reads only spend already flushed, so concurrent chains for
// different users can each start a session against the same global
// remaining. Worst-case overshoot of the global daily ceiling is
//   (users running at once) x (per-session cap, $0.25 default)
// plus at most one in-flight LLM call per killed invocation (spend is
// flushed after every call — N2). At Gemma prices a session costs ~$0.004,
// so this is small today; revisit with a DB reservation if the cap grows.
//
// Migration 088 (P10 re-review N1): enqueue and finish are RPCs, so a
// re-upload during a run marks the row dirty instead of resetting it.

import { randomUUID } from "node:crypto";
import { getServiceClient, SUPABASE_ENV_MISSING_MESSAGE } from "@/lib/db/clients";
import type { Db } from "@/lib/db/types";
import { checkFeature, getAppMode, parseUsdEnv, resolveMemoryMonthlyBudgetUsd } from "@/lib/feature-flags";
import { resolveCostCapConfig } from "@/lib/llm/config";
import { isLocalModelBaseURL } from "@/lib/llm/embedding-client";
import { createCostGuardedLlm } from "@/lib/llm/spend-ledger";
import { isLocalMode } from "@/lib/local/mode";
import { log } from "@/lib/log";
import { MEMORY_EXTRACTION_LOCK_STALE_MS } from "@/lib/memory/write";
import { selectAllRows } from "@/lib/util/pagination";
import { resolveSessionBudgetUsd } from "./budget";
import { MEMORY_LATE_START_NO_PROGRESS_REASON } from "./extraction-backoff";
import { logMemoryExtraction, type MemoryExtractionLogFields } from "./extraction-log";
import { checkGlobalCeilings } from "./global-ceiling";
import { memorySpendSinceUsd, startOfUtcMonthIso } from "./monthly-spend";
import { runTailCaptureForSession } from "./tail-capture";

export { MEMORY_LATE_START_NO_PROGRESS_REASON };

export const MEMORY_QUEUE_TABLE = "memory_extraction_queue";

/**
 * #277: the reconcile's `.in("session_id", ids)` lookup below is chunked to
 * at most this many ids per request — same cliff and same cap as
 * lib/kg/arrival-loop.ts's HASH_BACKFILL_CONV_CHUNK_SIZE (measured against
 * this repo's local PostgREST: 300+ ids returns HTTP 414 "URI too long",
 * 100 is comfortably under it). A user's parent-window-plus-children `recent`
 * list is uncapped (every child of an in-window parent is included, however
 * many there are), so this must chunk independently of `limit`.
 */
const RECONCILE_QUEUE_CHUNK_SIZE = 100;

/** The keyless "extraction is off" line is logged once per process (see processNextMemoryExtraction). */
let noModelLogged = false;

/** Test-only: lets the once-per-process no-model log fire again. */
export function resetNoModelLogForTests(): void {
  noModelLogged = false;
}

/** Splits `items` into chunks of at most `size` — same helper shape as arrival-loop.ts's chunkArray (#277). */
function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/**
 * Queue lease per claim. Longer than extract-next's maxDuration (300s), so a
 * live run never loses it, AND longer than tail-capture's own per-session
 * props lock (write.ts, 15 min), so a reclaimed killed run never finds that
 * lock still held and no-ops.
 */
export const MEMORY_LEASE_SECONDS = MEMORY_EXTRACTION_LOCK_STALE_MS / 1000 + 60;
/** Claims per session before it is marked 'failed' (each killed run burns one). */
export const MEMORY_MAX_ATTEMPTS = 3;
/** Most recent sessions per user that are extracted (maintainer decision 2026-09-25). */
export const DEFAULT_MEMORY_BACKFILL_SESSIONS = 100;
/** Every pass a memory extraction run spends on: the chat pass group plus its embeddings. */
export { MEMORY_SPEND_PASSES, startOfUtcMonthIso } from "./monthly-spend";

export type MemoryQueueStatus = "pending" | "running" | "done" | "skipped" | "skipped_budget" | "failed" | "not_queued";

/** Invalid or negative -> 0 (nothing queued) with a warning (review m2). */
export function resolveMemoryBackfillSessions(env: Record<string, string | undefined> = process.env): number {
  return Math.floor(
    parseUsdEnv(
      env.MEMBRAL_MEMORY_BACKFILL_SESSIONS,
      DEFAULT_MEMORY_BACKFILL_SESSIONS,
      "MEMBRAL_MEMORY_BACKFILL_SESSIONS",
    ),
  );
}

/** Sessions older than this many days are not extracted (maintainer decision 2026-09-25). */
export const DEFAULT_MEMORY_BACKFILL_MAX_AGE_DAYS = 30;
/** Largest honoured max age (~100 years); set MEMBRAL_MEMORY_BACKFILL_MAX_AGE_DAYS=36500 to disable the age bound. */
export const MAX_MEMORY_BACKFILL_MAX_AGE_DAYS = 36500;

/**
 * Unset, blank, invalid, 0 or negative -> DEFAULT_MEMORY_BACKFILL_MAX_AGE_DAYS
 * (a typo must never switch the age bound off). A positive value is floored
 * (at least 1) and clamped to MAX_MEMORY_BACKFILL_MAX_AGE_DAYS, which
 * effectively disables the bound. Migration 100 applies it in the claim.
 */
export function resolveMemoryBackfillMaxAgeDays(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MEMBRAL_MEMORY_BACKFILL_MAX_AGE_DAYS;
  const n = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MEMORY_BACKFILL_MAX_AGE_DAYS;
  return Math.min(Math.max(Math.floor(n), 1), MAX_MEMORY_BACKFILL_MAX_AGE_DAYS);
}

/**
 * Queues sessions via migration 088's memory_extraction_enqueue, under the
 * same per-user advisory lock as the claim:
 *   - `requeue` (content changed this upload): a new or finished row becomes
 *     'pending' with attempts reset; a 'running' row is only marked dirty and
 *     goes back to 'pending' when that run finishes (P10 re-review N1) — the
 *     live lease is never cleared, so no second run starts for the user.
 *   - `ensure`: queued only when they have no row yet — the daily cron's
 *     reconciliation (reconcileMemoryExtractionQueue) passes sessions whose
 *     upload-time enqueue failed (P10 round 3 R3-M1/N-m4).
 * Returns how many rows now wait (or were marked dirty). Throws on a DB error.
 */
export async function enqueueMemoryExtraction(
  supabase: Db,
  userId: string,
  sessions: { requeue?: readonly string[]; ensure?: readonly string[] },
): Promise<number> {
  const requeue = [...(sessions.requeue ?? [])];
  const ensure = [...(sessions.ensure ?? [])];
  if (requeue.length === 0 && ensure.length === 0) return 0;
  const { data, error } = await supabase.rpc("memory_extraction_enqueue", {
    p_user: userId,
    p_requeue: requeue,
    p_ensure: ensure,
  });
  if (error) throw new Error(`memory_extraction_enqueue failed: ${error.message}`);
  const queued = Number(data) || 0;
  if (queued > 0) logMemoryExtraction({ event: "queued", userId, sessionCount: queued });
  return queued;
}

/** Reconciliation looks back this many days (P10 round 3 R3-M1). */
export const MEMORY_RECONCILE_DAYS = 14;

/**
 * True when a session has turns its last extraction never saw. Turn idx is
 * contiguous (0..turn_count-1, packages/core/src/sessions), and a run stores
 * its checkpoint plus how many tail turns it left uncovered, so the turns
 * that run knew about end at checkpoint + tail_turns_uncovered. More turns
 * than that means content arrived after the run. Clock-free, so client
 * transcript timestamps and server time never have to agree.
 */
export function sessionGrewSinceExtraction(turnCount: number, checkpoint: unknown, uncovered: unknown): boolean {
  const cp = typeof checkpoint === "number" ? checkpoint : -1;
  const known = typeof uncovered === "number" ? uncovered : 0;
  return turnCount - 1 - cp > known;
}

interface ReconcileSessionRow {
  id: string;
  user_id: string;
  turn_count: number | null;
  ended_at: string | null;
  started_at: string | null;
  created_at: string;
  checkpoint: unknown;
  uncovered: unknown;
  source: string;
  source_session_id: string;
  parent_source_session_id: string | null;
  /** props.open_upload: stamped by a Stop-hook (open) upload, cleared by the closing upload. */
  open_upload?: unknown;
}

/** A session stamped open whose last activity is younger than this is presumed still running: reconcile leaves it. */
export const OPEN_UPLOAD_FRESH_MS = 6 * 60 * 60 * 1000;

export interface ReconcileSummary {
  users: number;
  ensured: number;
  requeued: number;
  failedUsers: number;
}

/**
 * P10 round 3 R3-M1 / N-m4: the upload never fails when its enqueue fails,
 * so the daily cron repairs what it missed. For each user's most recent
 * sessions (the backfill window, same recency order as the claim) inside the
 * last MEMORY_RECONCILE_DAYS:
 *   - no queue row             -> `ensure` (queued only if still missing);
 *   - 'done' or 'not_queued'   -> `requeue` when the session grew since its
 *     last extraction (sessionGrewSinceExtraction).
 * Pending and running rows already wait; skipped, skipped_budget and failed
 * rows are left alone (a new upload re-pends them). Goes through the same
 * enqueue RPC as the upload, so a running row is only marked dirty.
 * A per-user failure is logged and counted; a listing failure throws.
 */
export async function reconcileMemoryExtractionQueue(
  supabase: Db,
  opts: { env?: Record<string, string | undefined>; now?: Date } = {},
): Promise<ReconcileSummary> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const limit = resolveMemoryBackfillSessions(env);
  const summary: ReconcileSummary = { users: 0, ensured: 0, requeued: 0, failedUsers: 0 };
  if (limit <= 0) return summary;
  // 100: never look back past the max age either, so an aged-out session is
  // not re-ensured only for the claim to mark it not_queued again.
  const lookbackDays = Math.min(MEMORY_RECONCILE_DAYS, resolveMemoryBackfillMaxAgeDays(env));
  const cutoff = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000).toISOString();

  // Same recency key as memory_extraction_claim: coalesce(ended_at, started_at, created_at).
  const rows = await selectAllRows<ReconcileSessionRow>((from, to) =>
    supabase
      .from("code_sessions")
      .select(
        "id, user_id, turn_count, ended_at, started_at, created_at, checkpoint:props->memory_checkpoint_turn_idx, uncovered:props->memory_extraction->tail_turns_uncovered, source, source_session_id, parent_source_session_id, open_upload:props->open_upload",
      )
      .or(
        `ended_at.gte.${cutoff},and(ended_at.is.null,started_at.gte.${cutoff}),and(ended_at.is.null,started_at.is.null,created_at.gte.${cutoff})`,
      )
      .order("id")
      .range(from, to),
  );

  const byUser = new Map<string, ReconcileSessionRow[]>();
  for (const row of rows) {
    const list = byUser.get(row.user_id) ?? [];
    list.push(row);
    byUser.set(row.user_id, list);
  }
  summary.users = byUser.size;

  const recency = (r: ReconcileSessionRow) => r.ended_at ?? r.started_at ?? r.created_at;
  for (const [userId, sessions] of byUser) {
    // The query already filters on `cutoff`; re-check here so the window is
    // computed on in-age sessions only, as the claim (100) does.
    const sorted = sessions
      .filter((s) => new Date(recency(s)).getTime() >= Date.parse(cutoff))
      .sort((a, b) => recency(b).localeCompare(recency(a)) || a.id.localeCompare(b.id));
    // Same fix as memory_extraction_claim (090): the window ranks top-level
    // sessions only (a sub-agent transcript must not take one of a user's N
    // slots from its own parent); a child is eligible whenever its parent
    // (matched by source + parent_source_session_id, same join key as
    // queries.ts/view.ts) landed inside that parent window.
    const parentWindow = sorted.filter((s) => s.parent_source_session_id == null).slice(0, limit);
    const parentWindowIds = new Set(parentWindow.map((p) => p.id));
    const parentKeys = new Set(parentWindow.map((p) => `${p.source}:${p.source_session_id}`));
    const recent = sorted.filter((s) =>
      s.parent_source_session_id == null
        ? parentWindowIds.has(s.id)
        : parentKeys.has(`${s.source}:${s.parent_source_session_id}`),
    );
    try {
      // #277: chunked so the `.in()` id list can't exceed PostgREST's URL
      // length — a failed chunk throws (below) the same as the unchunked
      // lookup used to, so it is never mistaken for "no rows" and rows that
      // are actually queued don't get wrongly re-`ensure`d.
      const queueRows: { session_id: string; status: string }[] = [];
      for (const idChunk of chunkArray(
        recent.map((r) => r.id),
        RECONCILE_QUEUE_CHUNK_SIZE,
      )) {
        const { data, error } = await supabase
          .from(MEMORY_QUEUE_TABLE)
          .select("session_id, status")
          .eq("user_id", userId)
          .in("session_id", idChunk);
        if (error) throw new Error(error.message);
        queueRows.push(...((data ?? []) as { session_id: string; status: string }[]));
      }
      const statusBySession = new Map(queueRows.map((q) => [q.session_id, q.status]));
      const ensure: string[] = [];
      const requeue: string[] = [];
      for (const session of recent) {
        // Open (Stop-hook) uploads queue no extraction by design; the closing upload does. Skip one whose latest
        // activity (ended_at tracks the last turn; code_sessions has no updated_at) is under 6 h old. A stamped
        // row older than that never got its closing upload (crash, killed terminal): fall through, queue it.
        if (
          session.open_upload === true &&
          now.getTime() - new Date(recency(session)).getTime() < OPEN_UPLOAD_FRESH_MS
        ) {
          continue;
        }
        const status = statusBySession.get(session.id);
        if (status === undefined) ensure.push(session.id);
        else if (
          (status === "done" || status === "not_queued") &&
          sessionGrewSinceExtraction(session.turn_count ?? 0, session.checkpoint, session.uncovered)
        ) {
          requeue.push(session.id);
        }
      }
      if (ensure.length === 0 && requeue.length === 0) continue;
      await enqueueMemoryExtraction(supabase, userId, { requeue, ensure });
      summary.ensured += ensure.length;
      summary.requeued += requeue.length;
    } catch (err) {
      summary.failedUsers++;
      logMemoryExtraction({
        event: "fail",
        reason: "reconcile_failed",
        userId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return summary;
}

export interface MemoryClaim {
  sessionId: string;
  leaseToken: string;
  attempts: number;
}

/** Atomically claims this user's most recent claimable session (migration 087's memory_extraction_claim), or null. */
export async function claimNextMemoryExtraction(
  supabase: Db,
  userId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<MemoryClaim | null> {
  const { data, error } = await supabase.rpc("memory_extraction_claim", {
    p_user: userId,
    p_lease_seconds: MEMORY_LEASE_SECONDS,
    p_backfill_limit: resolveMemoryBackfillSessions(env),
    p_max_attempts: MEMORY_MAX_ATTEMPTS,
    p_max_age_days: resolveMemoryBackfillMaxAgeDays(env),
  });
  if (error) throw new Error(`memory_extraction_claim failed: ${error.message}`);
  const row = (Array.isArray(data) ? data[0] : data) as
    | { session_id: string; lease_token: string; attempts: number }
    | null
    | undefined;
  if (!row?.session_id) return null;
  return { sessionId: row.session_id, leaseToken: row.lease_token, attempts: row.attempts };
}

/** Issue #339: the terminal reason for a session whose windows failed only on a reply cut off at the output limit. */
export const MEMORY_CONTENT_FAILURE_REASON = "windows_failed_content";

/**
 * Writes a final status for a claim via migration 088's
 * memory_extraction_finish — only while the lease is still ours. A row
 * re-uploaded mid-run (dirty) goes back to 'pending' whatever `status` says.
 * `attempts` overwrites the claim's count (undefined keeps it).
 */
async function finishClaim(
  supabase: Db,
  claim: MemoryClaim,
  status: MemoryQueueStatus,
  reason: string | null,
  attempts?: number,
): Promise<void> {
  const { error } = await supabase.rpc("memory_extraction_finish", {
    p_session: claim.sessionId,
    p_token: claim.leaseToken,
    p_status: status,
    p_reason: reason,
    p_attempts: attempts ?? null,
  });
  if (error) {
    log.error("memory_extraction_queue finish failed — the lease expires and the cron reclaims it", {
      session_id: claim.sessionId,
      status,
      err: error.message,
    });
  }
}

/**
 * P10 re-review N3: checkFeature answers `disabled` both for a real "off"
 * and for a feature_flags query error (it fails closed and cannot say
 * which). A real "off" is a terminal skip; an unreadable flag is transient.
 */
async function featureFlagUnreadable(supabase: Db, userId: string): Promise<boolean> {
  try {
    const { error } = await supabase
      .from("feature_flags")
      .select("enabled")
      .eq("user_id", userId)
      .eq("feature", "memory")
      .maybeSingle();
    return Boolean(error);
  } catch {
    return true;
  }
}

/**
 * Count of this user's claimable rows — pending, or running with an expired
 * lease (same claimability as the daily cron's listing query above). Backs
 * POST /api/memory/extraction/kick: a user-triggered nudge for a self-hosted
 * install with no Vercel cron to restart a dead chain. Throws on a DB error
 * (the route turns that into a 500 rather than guessing "nothing to kick").
 */
export async function countClaimableMemoryExtraction(
  supabase: Db,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const nowIso = now.toISOString();
  const { count, error } = await supabase
    .from(MEMORY_QUEUE_TABLE)
    .select("session_id", { count: "exact", head: true })
    .eq("user_id", userId)
    .or(`status.eq.pending,and(status.eq.running,lease_until.lt.${nowIso})`);
  if (error) throw new Error(`memory_extraction_queue count failed: ${error.message}`);
  return count ?? 0;
}

export type MemoryStepOutcome = "none_claimed" | "done" | "skipped" | "skipped_budget" | "released" | "failed";

/** extract-next's maxDuration (route.ts must export the same literal — Next needs a literal there). */
export const MEMORY_MAX_DURATION_MS = 300_000;
/** P10 re-review N2: per-request LLM timeout for memory extraction on hosted (the SDK default is 10 minutes). */
export const MEMORY_LLM_TIMEOUT_MS = 60_000;
/**
 * Local-stack default per chat call. A 7B model on a laptop does not finish
 * an extraction window in 60s (observed: Ollama qwen2.5:7b, 500 after 60s).
 * With 0 retries the worst run is the latest call start (reask cutoff, 170s)
 * + this = 350s, far under the session lock's stale window (15 min) and the
 * queue lease (16 min); the kicker's fetch only waits for extract-next's 202.
 */
export const MEMORY_LLM_TIMEOUT_LOCAL_MS = 180_000;
/** Upper clamp for MEMBRAL_LLM_TIMEOUT_MS: 170s (latest chat start) + 600s stays under the 15 min lock stale window. */
export const MEMORY_LLM_TIMEOUT_MAX_MS = 600_000;

/**
 * Per-request timeout for memory extraction's chat calls. MEMBRAL_LLM_TIMEOUT_MS
 * (a positive number of ms, clamped to MEMORY_LLM_TIMEOUT_MAX_MS) wins. Otherwise
 * ONE rule picks the default: the local stack gets MEMORY_LLM_TIMEOUT_LOCAL_MS
 * when it is not on Vercel and either MEMBRAL_LOCAL=1 or MEMBRAL_MODEL_BASE_URL
 * is loopback / host.docker.internal; everything else keeps the hosted 60s.
 * (MEMBRAL_LLM_PROVIDER=claude-code only runs with MEMBRAL_LOCAL=1, so it is covered.)
 */
export function resolveMemoryLlmTimeoutMs(env: Record<string, string | undefined> = process.env): number {
  const raw = env.MEMBRAL_LLM_TIMEOUT_MS?.trim();
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(Math.round(n), MEMORY_LLM_TIMEOUT_MAX_MS);
  }
  const local = !env.VERCEL && (isLocalMode(env) || isLocalModelBaseURL(env.MEMBRAL_MODEL_BASE_URL?.trim()));
  return local ? MEMORY_LLM_TIMEOUT_LOCAL_MS : MEMORY_LLM_TIMEOUT_MS;
}
/**
 * No SDK retries for memory extraction's chat calls: the queue's attempts are
 * the retry. A 429 or provider error fails that window, the run stops
 * starting windows, the row is released with the attempt counted and the
 * chain stops — the next attempt waits for the next upload trigger or the
 * daily cron, never an immediate retry (CLAUDE.md rule 4).
 */
export const MEMORY_LLM_MAX_RETRIES = 0;
/**
 * P10 round 3 R3-m2: embedding calls are small and fast, and one failed batch
 * stores its records with `embedding: null` for good (skipped by dedupe,
 * supersede and cosine recall). So the embedding client alone gets SDK
 * retries (the SDK's exponential backoff, honoring Retry-After) with a short
 * per-attempt timeout.
 */
export const MEMORY_EMBED_MAX_RETRIES = 2;
export const MEMORY_EMBED_TIMEOUT_MS = 15_000;
/** Room for the SDK's backoff sleeps between embedding attempts (0.5s, 1s, capped by Retry-After handling). */
export const MEMORY_EMBED_BACKOFF_ALLOWANCE_MS = 5_000;
/** After the last LLM call: grounding, the DB insert, supersede, props and queue finish. */
export const MEMORY_FINISH_MARGIN_MS = 20_000;
/** One chat call, worst case: 60s timeout x (0 retries + 1) attempt = 60s (no backoff wait). */
export const MEMORY_WORST_CALL_MS = MEMORY_LLM_TIMEOUT_MS * (MEMORY_LLM_MAX_RETRIES + 1);
/** One embedding call, worst case: 15s x 3 attempts + backoff = 50s. */
export const MEMORY_EMBED_WORST_CALL_MS =
  MEMORY_EMBED_TIMEOUT_MS * (MEMORY_EMBED_MAX_RETRIES + 1) + MEMORY_EMBED_BACKOFF_ALLOWANCE_MS;
/**
 * P10 re-review N2 / round 3 R3-m1: no LLM call STARTS after this many ms in
 * one invocation. It is the embedding cutoff, the last call of a run:
 *   300s - 50s (worst embedding call) - 20s (finish margin) = 230s.
 */
export const MEMORY_RUN_DEADLINE_MS = MEMORY_MAX_DURATION_MS - MEMORY_EMBED_WORST_CALL_MS - MEMORY_FINISH_MARGIN_MS;
/**
 * Per-pass cutoffs, as shares of that 230s:
 *   main  120s — leaves the user-turn pass room over the same turns (the
 *                checkpoint only passes turns BOTH passes covered);
 *   user  160s — the last user window (and its retry-on-empty, which is
 *                gated on the same cutoff) ends by 220s;
 *   reask 170s = 230s - one worst chat call, so a re-ask that started ends
 *                before the embedding cutoff; past it the re-ask is skipped
 *                and the run still writes;
 *   embed 230s — the embedding call.
 * Livelock guard: every window, retry and re-ask ends by 230s, so the embed
 * cutoff can only fire on DB/grounding overhead, and a long session writes
 * and moves its checkpoint every run instead of redoing the same windows
 * until 'failed'.
 */
export const MEMORY_PASS_DEADLINE_SHARE = { main: 120 / 230, user: 160 / 230, reask: 170 / 230, embed: 1 } as const;
/**
 * Issue #339: the extract-next loop starts another session only while at
 * least this much of MEMORY_RUN_DEADLINE_MS is left. The pass cutoffs above
 * are measured from the INVOCATION's start, and a run only moves its
 * checkpoint over turns both passes covered, so a late session should still
 * have room to run one worst-case main window (60s) and then start a user
 * window before the user cutoff, which sits 70s before the deadline:
 *   70s + 60s = 130s -> no session starts after t = 100s.
 * This used to add the finish margin (20s) for claim, gates and turn loading
 * (150s). Dropping it is safe because of the late-start release in
 * processNextMemoryExtraction: a session that is not the invocation's first
 * and still ends at the deadline with no progress is released UNCOUNTED
 * (deadline_no_progress_late_start), so a slow setup costs time, never one
 * of its MEMORY_MAX_ATTEMPTS. The first session of an invocation keeps the
 * counted deadline_no_progress, the livelock guard for a session that can
 * never progress even with a whole invocation.
 */
export const MEMORY_MIN_REMAINING_TO_START_MS =
  Math.round(MEMORY_RUN_DEADLINE_MS * (1 - MEMORY_PASS_DEADLINE_SHARE.user)) + MEMORY_WORST_CALL_MS;
/**
 * Issue #339: safety bound on steps per extract-next invocation, against a
 * bug that makes instant steps keep answering continueChain. Real sessions
 * are bounded by time (MEMORY_MIN_REMAINING_TO_START_MS); 20 no-op steps is
 * ~40 claim/finish round trips, and anything left waits one trigger.
 */
export const MEMORY_MAX_SESSIONS_PER_INVOCATION = 20;

export interface MemoryStepResult {
  outcome: MemoryStepOutcome;
  sessionId?: string;
  reason?: string;
  /** Per-session LLM cap actually applied (review M2). */
  capUsd?: number;
  /** True when the next pending session may run now (false after any budget/ceiling/flag stop). */
  continueChain: boolean;
}

export interface ProcessNextOptions {
  supabase?: Db;
  env?: Record<string, string | undefined>;
  now?: Date;
  /** Wall-clock budget for starting LLM windows (default MEMORY_RUN_DEADLINE_MS). */
  deadlineMs?: number;
  /** Clock for the deadline (tests). Default Date.now. */
  clock?: () => number;
  /**
   * Issue #339: `clock()` at the start of the invocation this step runs in —
   * the deadline is measured from here, so every step of one invocation
   * shares one budget. Default: `clock()` at this call.
   */
  invocationStartedAt?: number;
  /**
   * 0-based index of this step within its invocation (the extract-next loop
   * passes it). A step with index > 0 that started after invocationStartedAt
   * is a late start: ending at the deadline with no progress releases it
   * uncounted. An explicit index, not a clock comparison alone, because the
   * real clock can tick between the loop's start and the first step's own
   * clock() read, which would make every first step look late and disable
   * the livelock guard. Default 0 (first step).
   */
  stepIndex?: number;
}

/**
 * Claims and extracts at most ONE session for `userId`. Never throws: every
 * path ends with the row finished (done / skipped / skipped_budget /
 * failed) or released back to 'pending', plus one `[memory-extraction]` log
 * line. Spend is flushed after every LLM call and again before returning.
 *
 * Release kinds (P10 re-review N1/N2/N3):
 *   - uncounted (attempts - 1), chain stops: not the session's fault —
 *     ceiling reached, spend unreadable, props lock held by another run, or
 *     a config-level failure (no model key) that would fail every row alike.
 *   - uncounted, continueChain true: the deadline stopped the run after it
 *     moved the checkpoint; the next trigger resumes from there (issue #339:
 *     the extract-next loop ends its invocation here — no time is left).
 *   - counted (the claim's +1 stays), reason kept: transient failure —
 *     windows failed, provider error, flag unreadable, a deadline with no
 *     progress. On the last allowed attempt it is 'failed' instead. The chain
 *     always stops (the next trigger or the daily cron retries), so a 429 is
 *     never retried at once and one outage never burns every row's attempts.
 *   - terminal, continueChain true (issue #339): every failed window failed on
 *     the reply itself (cut off at the output limit) — 'failed' at once with
 *     MEMORY_CONTENT_FAILURE_REASON, since a retry gets the same reply.
 */
export async function processNextMemoryExtraction(
  userId: string,
  opts: ProcessNextOptions = {},
): Promise<MemoryStepResult> {
  const env = opts.env ?? process.env;
  const now = opts.now ?? new Date();
  const clock = opts.clock ?? Date.now;
  const startedAt = clock();
  const invocationStartedAt = opts.invocationStartedAt ?? startedAt;
  const lateStart =
    opts.invocationStartedAt !== undefined && (opts.stepIndex ?? 0) > 0 && startedAt > opts.invocationStartedAt;
  const deadlineMs = opts.deadlineMs ?? MEMORY_RUN_DEADLINE_MS;
  let supabase: Db;
  let claim: MemoryClaim | null;
  try {
    supabase = opts.supabase ?? getServiceClient({ message: SUPABASE_ENV_MISSING_MESSAGE });
    claim = await claimNextMemoryExtraction(supabase, userId, env);
  } catch (err) {
    logMemoryExtraction({
      event: "fail",
      reason: "claim_error",
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { outcome: "failed", reason: "claim_error", continueChain: false };
  }
  if (!claim) return { outcome: "none_claimed", continueChain: false };
  const sessionId = claim.sessionId;

  const skip = async (
    status: "skipped" | "skipped_budget",
    reason: string,
    spentUsd?: number,
    limitUsd?: number | null,
  ): Promise<MemoryStepResult> => {
    await finishClaim(supabase, claim, status, reason);
    logMemoryExtraction({ event: "skip", reason, userId, sessionId, spentUsd, limitUsd });
    return { outcome: status, sessionId, reason, continueChain: false };
  };

  // Not the session's fault: back to 'pending' with the attempt uncounted.
  const release = async (
    reason: string,
    spentUsd?: number,
    limitUsd?: number,
    continueChain = false,
  ): Promise<MemoryStepResult> => {
    await finishClaim(supabase, claim, "pending", reason, Math.max(0, claim.attempts - 1));
    logMemoryExtraction({ event: "skip", reason, userId, sessionId, spentUsd, limitUsd });
    return { outcome: "released", sessionId, reason, continueChain };
  };

  // Transient failure: the attempt counts; 'failed' only once they are used up.
  const retryLater = async (
    reason: string,
    continueChain: boolean,
    extra: Pick<
      MemoryExtractionLogFields,
      | "error"
      | "runId"
      | "costUsd"
      | "failedWindows"
      | "windowsTotal"
      | "firstFailureStatus"
      | "firstFailureClass"
      | "firstFailureIsTimeout"
      | "attempt"
    > = {},
  ): Promise<MemoryStepResult> => {
    const exhausted = claim.attempts >= MEMORY_MAX_ATTEMPTS;
    await finishClaim(supabase, claim, exhausted ? "failed" : "pending", reason);
    logMemoryExtraction({
      event: "fail",
      reason,
      userId,
      sessionId,
      durationMs: clock() - startedAt,
      ...extra,
    });
    return { outcome: exhausted ? "failed" : "released", sessionId, reason, continueChain };
  };

  try {
    // 1. `memory` feature — independent of `llm` (review M1).
    const feature = await checkFeature(userId, "memory");
    if (!feature.allowed) {
      if (feature.reason === "disabled" && (await featureFlagUnreadable(supabase, userId))) {
        return retryLater("feature_flag_unreadable", false);
      }
      const budgetStop = feature.reason === "budget_exhausted" || feature.reason === "daily_exhausted";
      return skip(budgetStop ? "skipped_budget" : "skipped", feature.reason, feature.spentUsd, feature.budgetUsd);
    }
    const allowances: number[] = [];
    if (feature.budgetUsd !== null) allowances.push(feature.budgetUsd - feature.spentUsd);

    // 2. Monthly per-user budget (hosted mode — open/self-hosted mode has no
    //    product constraints, same as feature-flags.ts's resolution).
    if ((await getAppMode()) === "hosted") {
      const monthlyBudgetUsd = resolveMemoryMonthlyBudgetUsd(env);
      let monthSpentUsd: number;
      try {
        monthSpentUsd = await memorySpendSinceUsd(supabase, userId, startOfUtcMonthIso(now));
      } catch (err) {
        // Unreadable spend fails closed, like the global ceiling (review M3).
        log.warn("memory: monthly spend unreadable — session released for the cron", {
          user_id: userId,
          err: err instanceof Error ? err.message : String(err),
        });
        return release("monthly_budget_unchecked");
      }
      const monthlyRemaining = monthlyBudgetUsd - monthSpentUsd;
      if (monthlyRemaining <= 0) {
        return skip("skipped_budget", "monthly_budget_exhausted", monthSpentUsd, monthlyBudgetUsd);
      }
      allowances.push(monthlyRemaining);
    }

    // 3. Global (all users) daily + monthly ceilings — fail closed (review
    //    M3, issue #335). Allowance below is the tighter window's headroom.
    const global = await checkGlobalCeilings(supabase, env, now);
    if (!global.allowed) {
      return release(global.reason ?? "global_daily_ceiling", global.spentUsd, global.ceilingUsd);
    }
    allowances.push(global.ceilingUsd - global.spentUsd);

    // Review M2: the per-session hard cap never exceeds what is left.
    const allowance = Math.min(...allowances);
    const baseCap = Math.min(resolveCostCapConfig(env).perRunCapUsd, resolveSessionBudgetUsd(env));
    const capUsd = Math.min(baseCap, allowance);
    if (capUsd <= 0) return skip("skipped_budget", "no_allowance_left");
    const capBoundByAllowance = allowance < baseCap;

    const runId = randomUUID();
    let guarded: Awaited<ReturnType<typeof createCostGuardedLlm>>;
    try {
      guarded = await createCostGuardedLlm(supabase, userId, {
        runId,
        bypassFeatureGate: true,
        capUsdOverride: capUsd,
        // P10 re-review N2: every LLM call's spend is written as it lands.
        flushEvery: 1,
        timeoutMs: resolveMemoryLlmTimeoutMs(env),
        maxRetries: MEMORY_LLM_MAX_RETRIES,
        embedTimeoutMs: MEMORY_EMBED_TIMEOUT_MS,
        embedMaxRetries: MEMORY_EMBED_MAX_RETRIES,
      });
    } catch (err) {
      // Config-level (e.g. no OPENAI_API_KEY): every row would fail the same
      // way, so this one row is released uncounted and the chain stops.
      const message = err instanceof Error ? err.message : String(err);
      const noModel = /OPENAI_API_KEY/.test(message);
      // Info-once only on the local stack; hosted keeps the error (a missing key there is a real fault).
      const quietNoModel = noModel && isLocalMode();
      if (!quietNoModel) {
        log.error("memory: LLM client could not be built — chain stops for this user", {
          user_id: userId,
          err: message,
        });
      } else if (!noModelLogged) {
        // No key and no provider is a normal state (a keyless local stack, W7
        // D3), and the local kicker retries every 2 minutes: say it once per
        // process at info, not as an error on every kick.
        noModelLogged = true;
        log.info("memory: extraction is off — no LLM key or provider is configured", { user_id: userId });
      }
      return release(noModel ? "no_model_key" : "model_config_error");
    }
    if (!guarded.ok) {
      // Issue #335 review: the factory re-checks the global ceilings; a
      // refusal there (another invocation spent in between) is not this
      // session's fault — release it like step 3, never a terminal skip.
      if (guarded.reason === "global_ceiling_exceeded") {
        return release(guarded.detail, guarded.spentUsd, guarded.ceilingUsd);
      }
      return skip("skipped_budget", guarded.reason);
    }

    logMemoryExtraction({ event: "run", userId, sessionId, sessionCount: 1, runId, limitUsd: capUsd });
    let summary: Awaited<ReturnType<typeof runTailCaptureForSession>>;
    try {
      summary = await runTailCaptureForSession({ supabase, llm: guarded.llm }, userId, sessionId, {
        runId,
        sessionBudgetUsd: capUsd,
        shouldStop: (pass) => clock() - invocationStartedAt >= deadlineMs * MEMORY_PASS_DEADLINE_SHARE[pass],
        attempt: claim.attempts,
      });
    } catch (err) {
      await guarded.flushSpend();
      return retryLater("session_error", false, {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    await guarded.flushSpend();

    // N1: another run holds the session's props lock — not this attempt's
    // fault; the chain stops (the claim would pick this same row again).
    if (summary.lockHeld) return release("session_locked");

    // The allowance (not the normal per-session budget) cut this run short:
    // the session is left skipped_budget and the chain stops.
    if (capBoundByAllowance && guarded.llm.overBudget()) {
      await finishClaim(supabase, claim, "skipped_budget", "allowance_reached");
      logMemoryExtraction({
        event: "skip",
        reason: "allowance_reached",
        userId,
        sessionId,
        runId,
        costUsd: summary.costUsd,
        limitUsd: capUsd,
      });
      return { outcome: "skipped_budget", sessionId, reason: "allowance_reached", capUsd, continueChain: false };
    }

    // Issue #339: every failed window failed on the reply itself (cut off at
    // the output limit, nothing salvaged). That is deterministic, not a rate
    // limit: a retry gets the same reply, and a counted 'pending' row would
    // hold the user's whole queue in backoff. Finished 'failed' at once;
    // memories from its successful windows are kept, as for any failed
    // session, and the invocation moves on to the next session.
    if (summary.windowsFailed > 0 && summary.windowFailuresAllContent === true) {
      const first = summary.firstWindowFailure;
      await finishClaim(supabase, claim, "failed", MEMORY_CONTENT_FAILURE_REASON);
      logMemoryExtraction({
        event: "fail",
        reason: MEMORY_CONTENT_FAILURE_REASON,
        userId,
        sessionId,
        durationMs: clock() - startedAt,
        runId,
        costUsd: summary.costUsd,
        attempt: claim.attempts,
        failedWindows: summary.windowsFailed,
        windowsTotal: summary.windowsTotal,
        firstFailureStatus: first?.status ?? null,
        firstFailureClass: first?.errorClass,
        firstFailureIsTimeout: first?.isTimeout,
      });
      return { outcome: "failed", sessionId, reason: MEMORY_CONTENT_FAILURE_REASON, continueChain: true };
    }
    // N3: a failed window is never 'done' — its turns stay uncovered.
    // Never continue the chain here: a 429 must not be retried at once (rule 4).
    if (summary.windowsFailed > 0) {
      // Issue #339: the counts and the first failure's class/status/timeout,
      // so a timeout, a rate limit and a provider error read differently.
      const first = summary.firstWindowFailure;
      return retryLater("windows_failed", false, {
        runId,
        costUsd: summary.costUsd,
        attempt: claim.attempts,
        failedWindows: summary.windowsFailed,
        windowsTotal: summary.windowsTotal,
        firstFailureStatus: first?.status ?? null,
        firstFailureClass: first?.errorClass,
        firstFailureIsTimeout: first?.isTimeout,
      });
    }
    // N2: stopped at the deadline. Progress -> back to 'pending' uncounted,
    // resumed by the next trigger (the loop ends on deadline_partial); none -> counted, so a session that can never progress
    // ends 'failed' instead of looping.
    // Issue #339: no progress on a LATE start (not the invocation's first
    // step) is the invocation's lateness, not the session's fault: released
    // uncounted and the invocation ends. The first step of an invocation
    // (a whole run's time) still counts, which keeps the livelock guard.
    if (summary.deadlineHit) {
      if (summary.checkpointAdvanced) return release("deadline_partial", undefined, undefined, true);
      if (lateStart) return release(MEMORY_LATE_START_NO_PROGRESS_REASON);
      return retryLater("deadline_no_progress", false, { runId, costUsd: summary.costUsd });
    }

    await finishClaim(supabase, claim, "done", null);
    logMemoryExtraction({
      event: "done",
      userId,
      sessionId,
      sessionCount: 1,
      runId,
      costUsd: summary.costUsd,
      recordsWritten: summary.recordsWritten,
      embeddingMissing: summary.embeddingMissing,
      durationMs: clock() - startedAt,
    });
    return { outcome: "done", sessionId, capUsd, continueChain: true };
  } catch (err) {
    return retryLater("session_error", false, { error: err instanceof Error ? err.message : String(err) });
  }
}
