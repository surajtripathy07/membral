import { describe, expect, expectTypeOf, it } from "vitest";
import { BUILD_RANK, type BuildRung, REVIEW_RANK, type ReviewRung, ROLE_RANK, type Role } from "../ladder";

// The pre-G2 copies, inlined verbatim as fixtures (step 2.2a moved them into lib/domain/ladder.ts).
/** lib/code-sessions/profile.ts (was `Record<ReviewRung, number>`). */
const PROFILE_REVIEW_RANK = { viewed: 1, checked_out: 2, reviewed: 3, commented: 4, approved: 5 };
/** lib/threads/open-threads.ts (was `Record<string, number>`). */
const OPEN_THREADS_REVIEW_RANK = { viewed: 1, checked_out: 2, reviewed: 3, commented: 4, approved: 5 };
/** lib/agent-stats/attribution.ts (was `Record<string, number>`). */
const ATTRIBUTION_REVIEW_RANK = { viewed: 1, checked_out: 2, reviewed: 3, commented: 4, approved: 5 };

/** lib/code-sessions/profile.ts (was `Record<BuildRung, number>`). */
const PROFILE_BUILD_RANK = { edited: 1, committed: 2, pushed: 3, opened_mr: 4, merged: 5, closed: 5 };
/** lib/threads/open-threads.ts (was `Record<string, number>`). */
const OPEN_THREADS_BUILD_RANK = { edited: 1, committed: 2, pushed: 3, opened_mr: 4, merged: 5, closed: 5 };
/** lib/agent-stats/attribution.ts (was `Record<string, number>`). */
const ATTRIBUTION_BUILD_RANK = { edited: 1, committed: 2, pushed: 3, opened_mr: 4, merged: 5, closed: 5 };

/** lib/threads/open-threads.ts (was `Record<string, number>`). */
const OPEN_THREADS_ROLE_RANK = { worked_on: 3, discussed: 2, referenced: 1 };
/** lib/agent-stats/attribution.ts (was `Record<SessionIssueRole, number>`). */
const ATTRIBUTION_ROLE_RANK = { worked_on: 3, discussed: 2, referenced: 1 };
/** lib/stats/user-stats.ts, function-local (`Record<string, number>`), not yet moved. */
const USER_STATS_ROLE_RANK = { worked_on: 3, discussed: 2, referenced: 1 };

function expectSameTable(actual: Record<string, number>, fixture: Record<string, number>): void {
  expect(actual).toStrictEqual(fixture);
  expect(Object.keys(actual)).toEqual(Object.keys(fixture));
}

describe("ladder", () => {
  it.each([
    ["profile", PROFILE_REVIEW_RANK],
    ["open-threads", OPEN_THREADS_REVIEW_RANK],
    ["attribution", ATTRIBUTION_REVIEW_RANK],
  ])("REVIEW_RANK equals the old %s table", (_name, fixture) => {
    expectSameTable(REVIEW_RANK, fixture);
  });

  it.each([
    ["profile", PROFILE_BUILD_RANK],
    ["open-threads", OPEN_THREADS_BUILD_RANK],
    ["attribution", ATTRIBUTION_BUILD_RANK],
  ])("BUILD_RANK equals the old %s table", (_name, fixture) => {
    expectSameTable(BUILD_RANK, fixture);
  });

  it.each([
    ["open-threads", OPEN_THREADS_ROLE_RANK],
    ["attribution", ATTRIBUTION_ROLE_RANK],
    ["user-stats", USER_STATS_ROLE_RANK],
  ])("ROLE_RANK equals the old %s table", (_name, fixture) => {
    expectSameTable(ROLE_RANK, fixture);
  });

  it("Role is the shared DerivedRole / ThreadRole / SessionIssueRole union", () => {
    expectTypeOf<Role>().toEqualTypeOf<"worked_on" | "discussed" | "referenced">();
  });

  it("ReviewRung and BuildRung keep their members", () => {
    expectTypeOf<ReviewRung>().toEqualTypeOf<"viewed" | "checked_out" | "reviewed" | "commented" | "approved">();
    expectTypeOf<BuildRung>().toEqualTypeOf<"edited" | "committed" | "pushed" | "opened_mr" | "merged" | "closed">();
  });
});
