// Sync State panel — pure state-rule module (Today page, GitHub
// #88-adjacent "tell the truth about what is synced" work).
//
// This file has ZERO I/O — every function here is a plain (raw signals) ->
// (state) transform, so the state RULES are unit-testable without mocking
// Supabase. GET /api/sync-state (app/api/sync-state/route.ts) is the only
// caller: it fetches the raw signals (sync_heartbeats, conversations,
// code_sessions/code_projects, kg_claims + the arrival-loop's own
// lag computation) and hands them to `shapeSyncState` below.
//
// SOURCES OF TRUTH for the raw signals this module consumes (documented here
// once, so the route file doesn't have to re-explain it at every call site):
//   - chat lastRunAt/lastItemAt: sync_heartbeats (migration 036), written by
//     recordChatHeartbeats (lib/sync-heartbeat.ts) from POST /api/sync and
//     POST /api/import — combined with conversations.updated_at exactly like
//     mcp_freshness() does (greatest of the two), so a source with real rows
//     but no heartbeat yet (pre-migration data) still reports something.
//   - chat conversations count: conversations table, grouped by source.
//   - code lastRunAt: sync_heartbeats source='code' (recordCodeHeartbeat,
//     POST /api/code-sessions) — ONE heartbeat shared across every harness
//     today (only 'claude-code' writes code_sessions as of this module;
//     ADR 0021/#87 — opencode/codex are a future dimension, not yet a
//     separate heartbeat source).
//   - code projects/sessions/lastSessionAt: code_sessions grouped by its own
//     `source` column (the harness), code_projects for the project count.

// ---------------------------------------------------------------------------
// State enums
// ---------------------------------------------------------------------------

/** One chat source (claude/chatgpt/grok) or one code harness (claude-code, …). */
export type SyncSourceState = "never" | "idle" | "syncing" | "quiet" | "stale";

// ---------------------------------------------------------------------------
// Thresholds — every number below is a documented rule, not a magic constant.
// ---------------------------------------------------------------------------

/** A heartbeat run this recent reads as "syncing right now" — there is no true in-progress signal (heartbeats are written AFTER a successful ingest completes), so this is a heuristic: a run finishing within the last 90s is close enough to "active" for a panel that polls every 15s to show it as such before it settles to idle/quiet on the next poll. */
export const SYNCING_WINDOW_MS = 90 * 1000;

/** Chat sync has no fixed cadence (user/extension-driven) — 36h without a confirmed run is several missed days of normal use, not noise. Matches this task's own suggested example. */
export const CHAT_STALE_MS = 36 * 60 * 60 * 1000;

/** A chat source whose sync keeps running (fresh lastRunAt) but has produced no new content for this long is legitimately quiet (declared-but-quiet), not broken. */
export const CHAT_QUIET_NO_ITEM_MS = 30 * 24 * 60 * 60 * 1000;

/** Code sync runs on the CLI sweep's fixed 20-minute cadence (lib/freshness.ts's own CODE_STALE_MS) — 2h is several missed cycles. */
export const CODE_STALE_MS = 2 * 60 * 60 * 1000;

/** A code harness whose sweep keeps running but has produced no new session for this long is quiet (no coding activity), not broken. */
export const CODE_QUIET_NO_ITEM_MS = 3 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Time helpers
// ---------------------------------------------------------------------------

/** Milliseconds between `now` and `iso`, or null when `iso` is missing/unparseable. Never throws. */
export function ageMs(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  return now.getTime() - t;
}

/** Whole minutes since `iso` (floored at 0 — a clock-skewed future timestamp never reads as negative), or null when `iso` is missing/unparseable. */
export function minutesSince(iso: string | null | undefined, now: Date = new Date()): number | null {
  const a = ageMs(iso, now);
  if (a === null) return null;
  return Math.max(0, Math.round(a / 60000));
}

// ---------------------------------------------------------------------------
// Source state (chat + code share one decision tree; only the thresholds and
// which "has ever produced anything" signal differ).
// ---------------------------------------------------------------------------

export interface SourceStateInput {
  /** Anything has EVER been declared/synced for this source — a heartbeat row exists, or content exists (pre-heartbeat data). False only for a source the user has never touched at all. */
  hasEverSeen: boolean;
  /** sync_heartbeats.last_run_at for this source (chat: per-source row; code: the shared 'code' row). Null when no heartbeat has ever been recorded. */
  lastRunAt: string | null;
  /** Freshest content timestamp for this source (chat: greatest(heartbeat.last_item_at, max(conversations.updated_at)); code: max(code_sessions.started_at) for this harness). Null when nothing has landed yet. */
  lastItemAt: string | null;
  staleMs: number;
  quietNoItemMs: number;
}

/**
 * Shared decision tree for a chat source or a code harness, evaluated in this
 * PRIORITY order (each rule below is the first one to fire, in this order):
 *   1. never  — nothing has ever been declared/synced for this source at all.
 *   2. syncing — the last confirmed run finished within SYNCING_WINDOW_MS.
 *   3. stale  — no run has ever been confirmed, OR the last confirmed run is
 *      older than `staleMs` (the sync mechanism itself looks broken/stopped).
 *   4. quiet  — the run is fresh (not stale) but no content has landed within
 *      `quietNoItemMs` (declared-but-quiet: the mechanism works, the source
 *      just has nothing new).
 *   5. idle   — fresh run, fresh-enough content: the healthy resting state.
 */
export function deriveSourceState(input: SourceStateInput, now: Date = new Date()): SyncSourceState {
  const { hasEverSeen, lastRunAt, lastItemAt, staleMs, quietNoItemMs } = input;
  if (!hasEverSeen) return "never";

  const runAge = ageMs(lastRunAt, now);
  if (runAge !== null && runAge <= SYNCING_WINDOW_MS) return "syncing";
  if (runAge === null || runAge > staleMs) return "stale";

  const itemAge = ageMs(lastItemAt, now);
  if (itemAge === null || itemAge > quietNoItemMs) return "quiet";

  return "idle";
}

/** Chat source (claude/chatgpt/grok) wrapper around deriveSourceState with the chat thresholds baked in. */
export function deriveChatSourceState(
  input: { hasEverSeen: boolean; lastRunAt: string | null; lastItemAt: string | null },
  now: Date = new Date(),
): SyncSourceState {
  return deriveSourceState({ ...input, staleMs: CHAT_STALE_MS, quietNoItemMs: CHAT_QUIET_NO_ITEM_MS }, now);
}

/** Code harness wrapper around deriveSourceState with the code thresholds baked in. */
export function deriveCodeHarnessState(
  input: { hasEverSeen: boolean; lastRunAt: string | null; lastItemAt: string | null },
  now: Date = new Date(),
): SyncSourceState {
  return deriveSourceState({ ...input, staleMs: CODE_STALE_MS, quietNoItemMs: CODE_QUIET_NO_ITEM_MS }, now);
}
