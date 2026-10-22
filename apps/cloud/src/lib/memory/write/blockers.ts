// G2 step 2.4g: the pure blocker logic behind write/io.ts's
// fetchLaterResolutionCandidates and retireBlockersResolvedLater — the
// candidate/receipt shapes, the scan limit, the stale cutoff, and the
// filtering, ordering and row shaping between the two reads. The Supabase
// reads and updates, their errors and the warn loop stay in write/io.ts.
// (fetchOpenBlockersForRecurrence's pure half is write/recurrence.ts's
// planOpenBlockerOffers, lifted in 2.4b.)

/** An open blocker from an earlier session, a candidate for later-session resolution. */
export interface LaterResolutionCandidate {
  id: string;
  code_session_id: string;
  text: string;
  quote: string | null;
  created_at: string;
  /** W5: the blocker's own ref and paths, for the observed pre-check (`observed-retirement.ts`). */
  ref: string | null;
  paths: string[] | null;
}

/** A resolved blocker's receipt, as `retireBlockersResolvedLater` receives it. */
export interface LaterResolutionReceipt {
  memoryId: string;
  resolvedBySessionId: string;
  quote: string;
  turnIdx: number;
}

/** How many live blockers `fetchLaterResolutionCandidates` reads before filtering — generous, so superseded/own-session/too-new rows never starve the cap. */
export const LATER_RESOLUTION_SCAN_LIMIT = 200;

/** A row of the live-blocker read in `fetchLaterResolutionCandidates`. */
export type FetchedLaterResolutionRow = LaterResolutionCandidate & { supersedes: string | null };

/** A row of the `code_sessions` read in `fetchLaterResolutionCandidates`. */
export interface FetchedSessionStartRow {
  id: string;
  started_at: string | null;
}

/** The `created_at` lower bound: `freshDays` (BLOCKER_FRESH_DAYS, #436) before `now`, as an ISO timestamp. */
export function laterResolutionCutoff(now: number, freshDays: number): string {
  return new Date(now - freshDays * 86_400_000).toISOString();
}

/** Rows not from `sessionId` and not the target of another read row's `supersedes`, in read order. */
export function unsupersededOtherSessionRows(
  rows: FetchedLaterResolutionRow[],
  sessionId: string,
): FetchedLaterResolutionRow[] {
  const superseded = new Set(rows.map((r) => r.supersedes).filter((id): id is string => !!id));
  return rows.filter((r) => r.code_session_id !== sessionId && !superseded.has(r.id));
}

/** The distinct session ids of `rows`, first-seen order — the `code_sessions` lookup's `.in("id", …)`. */
export function candidateSessionIds(rows: FetchedLaterResolutionRow[]): string[] {
  return [...new Set(rows.map((r) => r.code_session_id))];
}

/** Ids of sessions with a `started_at` strictly before `before` (epoch ms); a null `started_at` is excluded. */
export function sessionsStartedBefore(sessions: FetchedSessionStartRow[], before: number): Set<string> {
  return new Set(sessions.filter((s) => s.started_at !== null && Date.parse(s.started_at) < before).map((s) => s.id));
}

/** Rows whose session started before, at most `cap` in read order, with `supersedes` dropped and `ref`/`paths` normalised. */
export function planLaterResolutionCandidates(
  others: FetchedLaterResolutionRow[],
  startedBefore: Set<string>,
  cap: number,
): LaterResolutionCandidate[] {
  return others
    .filter((r) => startedBefore.has(r.code_session_id))
    .slice(0, cap)
    .map(({ supersedes: _s, ...r }) => ({
      ...r,
      ref: typeof r.ref === "string" ? r.ref : null,
      paths: Array.isArray(r.paths) ? r.paths.filter((p): p is string => typeof p === "string") : null,
    }));
}
