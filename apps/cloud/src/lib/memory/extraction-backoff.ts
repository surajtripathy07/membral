// Issue #339: per-user backoff for the cron's kicks. An external scheduler
// calls /api/internal/cron/memory-extraction every few minutes; without a
// backoff a session that failed on a provider rate limit would be retried on
// the very next trigger, burning its MEMORY_MAX_ATTEMPTS in minutes, and then
// the next session would burn its own.
//
// Rule 4 (CLAUDE.md): never retry a 429 immediately; back off proportionally.
// The wait grows with the attempts the row has already used: 15 min after
// the first counted failure, 30 min after the second (the third is final —
// the row becomes 'failed'). Within one invocation the loop already stops on
// the first failure; this spaces the retries ACROSS invocations.
//
// Per USER, not per row: the claim (memory_extraction_claim) takes the
// user's most recent claimable row and one failure stops that user's
// invocation, so a row-level filter could not steer the claim anyway.
//
// "Counted failure" = a queue row with status 'pending' and attempts > 0: what
// retryLater leaves (finish with the claim's +1 kept). Its time is
// updated_at, which memory_extraction_finish sets (migration 088). Other
// writes to updated_at on such a row:
//   - a claim sets status 'running' -> no longer a counted failure while it
//     runs; its finish rewrites updated_at when the run ends, which is the
//     new failure time if it failed again.
//   - an uncounted release of a row that still carries earlier attempts
//     (ceiling, lock, deadline_partial, late start) also rewrites updated_at.
//     Rows whose last_reason says the run made progress or started late are
//     not counted failures (MEMORY_BACKOFF_EXEMPT_REASONS), so a
//     half-extracted session resumes at once. Other uncounted releases do
//     restart the clock, but only once per claim, and a claim needs a kick
//     that this very backoff withholds (user actions excepted), so the clock
//     can never be pushed forward indefinitely and always expires.
//   - an enqueue (re-upload) resets attempts to 0 -> not a counted failure.

/**
 * The uncounted release reason for a step that was not its invocation's
 * first and ended at the deadline with no progress (extraction-queue.ts).
 * Defined here, not there, so this module has no imports.
 */
export const MEMORY_LATE_START_NO_PROGRESS_REASON = "deadline_no_progress_late_start";

/** Wait after the first counted failure; each further attempt used adds one more (rule 4: proportional). */
export const MEMORY_BACKOFF_BASE_MS = 15 * 60_000;

/** last_reason values of an UNCOUNTED release after which the session should resume at once. */
export const MEMORY_BACKOFF_EXEMPT_REASONS: ReadonlySet<string> = new Set([
  "deadline_partial",
  MEMORY_LATE_START_NO_PROGRESS_REASON,
]);

/** Wait for a row whose used attempts are `attempts`: 0 -> none, 1 -> 15 min, 2 -> 30 min. */
export function memoryBackoffMs(attempts: number): number {
  return attempts > 0 ? MEMORY_BACKOFF_BASE_MS * attempts : 0;
}

/**
 * True while a counted failure with `attempts` used, last finished at
 * `lastFailureAt`, must still wait at `now`. attempts 0 never backs off; an
 * unreadable time does not back off (the claim itself still caps attempts).
 */
export function isMemoryBackoffActive(attempts: number, lastFailureAt: Date | string | null, now: Date): boolean {
  const wait = memoryBackoffMs(attempts);
  if (wait <= 0 || lastFailureAt === null) return false;
  const at = new Date(lastFailureAt).getTime();
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at < wait;
}

export interface MemoryQueueListingRow {
  user_id: string;
  status?: string | null;
  attempts?: number | null;
  updated_at?: string | null;
  last_reason?: string | null;
}

/**
 * Splits the cron's claimable rows into users to kick and users backing off.
 * A user backs off while their MOST RECENT counted failure is inside its
 * window. Users whose only work is an expired lease ('running') are kicked.
 */
export function partitionUsersForKick(
  rows: MemoryQueueListingRow[],
  now: Date,
): { kick: string[]; skippedBackoff: string[] } {
  const users = new Set<string>();
  const latest = new Map<string, { at: number; attempts: number; updatedAt: string }>();
  for (const r of rows) {
    users.add(r.user_id);
    const attempts = r.attempts ?? 0;
    if (r.status !== "pending" || attempts <= 0 || !r.updated_at) continue;
    if (r.last_reason && MEMORY_BACKOFF_EXEMPT_REASONS.has(r.last_reason)) continue;
    const at = new Date(r.updated_at).getTime();
    if (!Number.isFinite(at)) continue;
    const prev = latest.get(r.user_id);
    if (!prev || at > prev.at || (at === prev.at && attempts > prev.attempts)) {
      latest.set(r.user_id, { at, attempts, updatedAt: r.updated_at });
    }
  }
  const kick: string[] = [];
  const skippedBackoff: string[] = [];
  for (const u of users) {
    const f = latest.get(u);
    if (f && isMemoryBackoffActive(f.attempts, f.updatedAt, now)) skippedBackoff.push(u);
    else kick.push(u);
  }
  return { kick, skippedBackoff };
}
