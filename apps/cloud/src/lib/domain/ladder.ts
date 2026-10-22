/**
 * The review and build ladders, their rank tables, and the ref role union: one definition each (G2 step 2.2a).
 *
 * Moved verbatim from identical copies in `lib/code-sessions/profile.ts` (`DerivedRole`, `ReviewRung`,
 * `BuildRung`, `REVIEW_RANK`, `BUILD_RANK`), `lib/threads/open-threads.ts` (`ThreadRole`, `ReviewRung`,
 * `BuildRung`, all three tables) and `lib/agent-stats/attribution.ts` (`SessionIssueRole`, all three tables).
 * The role names stay as aliases of `Role` until Phase 4. Where copies were typed `Record<string, number>`,
 * the stricter keyed type from the other copy is kept.
 */

export type Role = "worked_on" | "discussed" | "referenced";
export type ReviewRung = "viewed" | "checked_out" | "reviewed" | "commented" | "approved";
export type BuildRung = "edited" | "committed" | "pushed" | "opened_mr" | "merged" | "closed";

export const REVIEW_RANK: Record<ReviewRung, number> = {
  viewed: 1,
  checked_out: 2,
  reviewed: 3,
  commented: 4,
  approved: 5,
};

export const BUILD_RANK: Record<BuildRung, number> = {
  edited: 1,
  committed: 2,
  pushed: 3,
  opened_mr: 4,
  merged: 5,
  closed: 5,
};

export const ROLE_RANK: Record<Role, number> = { worked_on: 3, discussed: 2, referenced: 1 };
