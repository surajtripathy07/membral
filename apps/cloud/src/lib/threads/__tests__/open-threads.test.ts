// Open threads — behaviour tests named after B5, B6, B8, B11 and the dismiss
// rule (docs/goals/2026-09-26_open-threads-from-observed-actions_goal.md).
// Rows are shaped exactly as the tables hold them (code_session_issues,
// code_sessions, code_session_turns.props.action, memory_branch_state,
// session_memories); the fictional forge is codehub.example/acme/billing.
// Merge-request refs are stored exactly as extract.ts's qualifyIssueRef writes
// them — `host/owner/repo#N` with `kind: "merge_request"` — never with `!`.
import { describe, expect, it } from "vitest";
import {
  computeThreads,
  refMatches,
  type ThreadIssueRow,
  type ThreadSessionRow,
  type ThreadTurnRow,
} from "../open-threads";

const ISSUE = "codehub.example/acme/billing#15178";
const MR = "codehub.example/acme/billing#17049";
const MR_A = "codehub.example/acme/billing#1";
const MR_B = "codehub.example/acme/billing#2";
const EPIC = "codehub.example/acme/billing#254702";
const PROJECT = "proj-1";
/** Refs the fixtures treat as merge requests (the stored ref alone cannot tell). */
const MR_REFS = new Set([MR, MR_A, MR_B]);

function session(
  id: string,
  day: number,
  cost: number | null = 10,
  extra: Partial<ThreadSessionRow> = {},
): ThreadSessionRow {
  return {
    id,
    code_project_id: PROJECT,
    started_at: `2026-09-${String(day).padStart(2, "0")}T09:00:00Z`,
    git_branch: "15178-5-idempotent-debits",
    turn_count: 40,
    parent_source_session_id: null,
    cost_usd: cost,
    ...extra,
  };
}

function issue(session_id: string, ref: string, overrides: Partial<ThreadIssueRow> = {}): ThreadIssueRow {
  const kind = overrides.kind ?? (MR_REFS.has(ref) ? "merge_request" : "issue");
  return {
    session_id,
    ref,
    number: Number(ref.match(/(\d+)$/)?.[1] ?? 0),
    kind,
    role: "worked_on",
    evidence_quote: `working on ${ref}`,
    turn_idx: 3,
    review_verb: null,
    build_verb: "committed",
    tier: "observed",
    turn_share: 1,
    related_to: [],
    ...overrides,
  };
}

function turn(session_id: string, idx: number, action: Record<string, unknown>): ThreadTurnRow {
  return { session_id, idx, props: { action } };
}

const commit = (sha: string, branch = "15178-5-idempotent-debits") => ({
  verb: "committed",
  refKind: "commit",
  sha,
  branch,
  source: "cli",
});
const push = (branch = "15178-5-idempotent-debits") => ({
  verb: "pushed",
  refKind: "branch",
  ref: branch,
  branch,
  source: "cli",
});

describe("open threads (B5) — discussion is shown, never open", () => {
  it("a discussion-only ref is listed but never open", () => {
    const sessions = [session("s1", 20, 4.2), session("s2", 21, 1.1), session("s3", 22, 0.7)];
    const issues = sessions.map((s) =>
      issue(s.id, EPIC, { role: "discussed", build_verb: null, tier: "discussed", turn_share: 1 }),
    );
    const { open, recent } = computeThreads({ issues, sessions });
    expect(open).toEqual([]);
    expect(recent).toHaveLength(1);
    const row = recent[0];
    expect(row.ref).toBe(EPIC);
    expect(row.open).toBe(false);
    expect(row.ladder).toEqual({ review_verb: null, build_verb: null, triaged: false, discussed: true });
    // v4 item 1: a discussion carries no cost share (it is still listed).
    expect(row.cost_est_total ?? 0).toBe(0);
    expect(row.url).toBe("https://codehub.example/acme/billing/-/issues/254702");
    expect(row.estimated).toBe(true);
  });

  it("edits alone never open a thread", () => {
    const sessions = [session("s1", 20)];
    const { open, recent } = computeThreads({
      issues: [issue("s1", ISSUE, { build_verb: "edited", role: "discussed" })],
      sessions,
    });
    expect(open).toEqual([]);
    expect(recent[0].ladder.build_verb).toBe("edited");
  });
});

describe("open threads (B6) — open needs two facts", () => {
  it("a committed ref with no closure is open, and says so without 'unresolved'", () => {
    const sessions = [session("s1", 20, 14.2)];
    const turns = [turn("s1", 12, commit("d7e5977")), turn("s1", 30, push())];
    const { open } = computeThreads({ issues: [issue("s1", ISSUE)], sessions, turns });
    expect(open).toHaveLength(1);
    expect(open[0].open).toBe(true);
    expect(open[0].closure).toBeNull();
    expect(open[0].note).toBeUndefined();
    expect(JSON.stringify(open[0])).not.toMatch(/unresolved/);
    // v4 B1: an issue row labels the work; cost comes only from PR/branch evidence.
    expect(open[0].sessions[0]).toMatchObject({ id: "s1", turn_idx: 3, share: 0, cost_est: 0 });
  });

  it("glab mr merge 17049 (bare !17049) closes the …#17049 merge-request thread", () => {
    const sessions = [session("s1", 20), session("s2", 22)];
    const turns = [
      turn("s1", 12, commit("d7e5977")),
      turn("s1", 30, push()),
      // `glab mr merge 17049` as W3 records it: a bare `!N`, no refKind needed.
      turn("s2", 7, { verb: "merged", ref: "!17049", state: "merged", source: "cli" }),
    ];
    const issues = [issue("s1", MR, { build_verb: "pushed" }), issue("s2", MR, { build_verb: "merged", turn_idx: 7 })];
    expect(issues[0].kind).toBe("merge_request");
    const { open, recent } = computeThreads({ issues, sessions, turns });
    expect(open).toEqual([]);
    expect(recent[0].open).toBe(false);
    expect(recent[0].closure).toEqual({ kind: "action", session_id: "s2", turn_idx: 7, verb: "merged" });

    // The same number as an ISSUE (`glab issue close 17049`) is another item: the MR stays open.
    const asIssue = computeThreads({
      issues: [issue("s1", MR, { build_verb: "pushed" })],
      sessions: [session("s1", 20), session("s2", 22)],
      turns: [
        turn("s1", 12, commit("d7e5977")),
        turn("s2", 7, { verb: "closed", ref: "#17049", refKind: "issue", state: "closed", source: "cli" }),
      ],
    });
    expect(asIssue.open).toHaveLength(1);

    // A GitHub PR is `#N` with refKind merge_request: the refKind decides, not the marker.
    const ghPr = computeThreads({
      issues: [issue("s1", MR, { build_verb: "pushed" })],
      sessions: [session("s1", 20), session("s2", 22)],
      turns: [
        turn("s1", 12, commit("d7e5977")),
        turn("s2", 7, { verb: "merged", ref: "#17049", refKind: "merge_request", state: "merged", source: "cli" }),
      ],
    });
    expect(ghPr.open).toEqual([]);

    // A project-qualified ref matches on the owner/repo tail; another project's !17049 does not.
    const qualified = computeThreads({
      issues: [issue("s1", MR, { build_verb: "pushed" })],
      sessions: [session("s1", 20), session("s2", 22, 10, { code_project_id: "proj-other" })],
      turns: [
        turn("s1", 12, commit("d7e5977")),
        turn("s2", 7, { verb: "merged", ref: "acme/billing!17049", source: "cli" }),
      ],
    });
    expect(qualified.open).toEqual([]);
    const otherProject = computeThreads({
      issues: [issue("s1", MR, { build_verb: "pushed" })],
      sessions: [session("s1", 20), session("s2", 22, 10, { code_project_id: "proj-other" })],
      turns: [
        turn("s1", 12, commit("d7e5977")),
        turn("s2", 7, { verb: "merged", ref: "acme/ledger!17049", source: "cli" }),
      ],
    });
    expect(otherProject.open).toHaveLength(1);
  });

  it("a bare #15 closed in another project does not close acme/billing#15", () => {
    const BILLING_15 = "codehub.example/acme/billing#15";
    const sessions = [session("s1", 20), session("s2", 22, 10, { code_project_id: "proj-ledger", git_branch: "x" })];
    const turns = [
      turn("s1", 12, commit("d7e5977")),
      turn("s2", 3, { verb: "closed", ref: "#15", refKind: "issue", state: "closed", source: "cli" }),
      turn("s2", 4, { verb: "triaged", ref: "#15", refKind: "issue", source: "cli" }),
    ];
    const { open, recent } = computeThreads({ issues: [issue("s1", BILLING_15)], sessions, turns });
    expect(open).toHaveLength(1);
    expect(recent[0].closure).toBeNull();
    expect(recent[0].ladder.triaged).toBe(false);

    // The same bare #15 from a session in the thread's own project does close it.
    const sameProject = computeThreads({
      issues: [issue("s1", BILLING_15)],
      sessions: [session("s1", 20), session("s2", 22)],
      turns,
    });
    expect(sameProject.open).toEqual([]);
    expect(sameProject.recent[0].closure).toMatchObject({ kind: "action", session_id: "s2", turn_idx: 3 });
  });

  it("a closure seen in a session that never delivered still closes the thread (glab mr view → merged)", () => {
    const sessions = [session("s1", 20), session("s2", 24)];
    const turns = [
      turn("s1", 12, commit("d7e5977")),
      turn("s2", 2, { verb: "viewed", refKind: "merge_request", ref: MR, state: "merged", source: "cli" }),
    ];
    const issues = [
      issue("s1", MR, { build_verb: "opened_mr" }),
      issue("s2", MR, { role: "discussed", build_verb: null, review_verb: "viewed", turn_idx: 2 }),
    ];
    const { open, recent } = computeThreads({ issues, sessions, turns });
    expect(open).toEqual([]);
    expect(recent[0].closure).toMatchObject({ kind: "action", session_id: "s2", turn_idx: 2, verb: "merged" });
  });

  it("a ref whose branch-state row carries merged_at is closed", () => {
    const sessions = [session("s1", 20)];
    const turns = [turn("s1", 12, commit("d7e5977")), turn("s1", 30, push())];
    const branchState = [
      {
        code_project_id: PROJECT,
        branch: "15178-5-idempotent-debits",
        last_seen_sha: "d7e5977",
        merged_into: "main",
        merged_at: "2026-09-23T02:00:00Z",
        branch_gone_at: null,
      },
    ];
    const { open, recent } = computeThreads({ issues: [issue("s1", ISSUE)], sessions, turns, branchState });
    expect(open).toEqual([]);
    expect(recent[0].closure).toEqual({
      kind: "branch_state",
      code_project_id: PROJECT,
      branch: "15178-5-idempotent-debits",
      merged_into: "main",
      merged_at: "2026-09-23T02:00:00Z",
      branch_gone_at: null,
    });
  });

  it("a branch never fetched in this checkout is not branch-gone evidence", () => {
    // The sweep found neither refs/heads nor refs/remotes/origin and the row
    // never held a sha: the branch may live in another clone. Still open.
    const sessions = [session("s1", 20)];
    const turns = [turn("s1", 12, commit("d7e5977")), turn("s1", 30, push())];
    const row = (last_seen_sha: string | null) => ({
      code_project_id: PROJECT,
      branch: "15178-5-idempotent-debits",
      last_seen_sha,
      merged_into: null,
      merged_at: null,
      branch_gone_at: "2026-09-23T02:00:00Z",
    });
    const unseen = computeThreads({ issues: [issue("s1", ISSUE)], sessions, turns, branchState: [row(null)] });
    expect(unseen.open).toHaveLength(1);
    expect(unseen.recent[0].closure).toBeNull();

    // The row proves the branch existed here (a sha was seen) and vanished: closed.
    const vanished = computeThreads({ issues: [issue("s1", ISSUE)], sessions, turns, branchState: [row("d7e5977")] });
    expect(vanished.open).toEqual([]);
    expect(vanished.recent[0].closure).toMatchObject({ kind: "branch_state", branch_gone_at: "2026-09-23T02:00:00Z" });

    // F10: a sha no session on this thread named proves nothing — the branch name may have been reused.
    const later = computeThreads({ issues: [issue("s1", ISSUE)], sessions, turns, branchState: [row("e8e8e8e")] });
    expect(later.open).toHaveLength(1);
  });

  it("merged_at closes only on the newest sha a session on this thread named (a reused branch name proves nothing)", () => {
    // s1 commits d7e5977 on X for the issue; a later session with NO row on
    // the issue commits e8e8e8e on X (a reused branch name); the sweep proves
    // e8e8e8e merged. That sha was never named on this thread: still open (F10).
    const sessions = [session("s1", 20), session("s2", 23)];
    const turns = [turn("s1", 12, commit("d7e5977")), turn("s2", 4, commit("e8e8e8e"))];
    const row = (sha: string | null) => ({
      code_project_id: PROJECT,
      branch: "15178-5-idempotent-debits",
      last_seen_sha: sha,
      merged_into: "main",
      merged_at: "2026-09-24T02:00:00Z",
      branch_gone_at: null,
    });
    const unrelated = computeThreads({ issues: [issue("s1", ISSUE)], sessions, turns, branchState: [row("e8e8e8e")] });
    expect(unrelated.open).toHaveLength(1);
    expect(unrelated.recent[0].closure).toBeNull();

    // The row still on the thread's own OLDER sha proves nothing about its newest: open.
    const both = [issue("s1", ISSUE), issue("s2", ISSUE, { turn_idx: 4 })];
    const older = computeThreads({ issues: both, sessions, turns, branchState: [row("d7e5977")] });
    expect(older.open).toHaveLength(1);
    const newest = computeThreads({ issues: both, sessions, turns, branchState: [row("e8e8e8e")] });
    expect(newest.open).toEqual([]);
    expect(newest.recent[0].closure).toMatchObject({ kind: "branch_state", merged_into: "main" });
  });

  it("a branch-state row for another project's branch of the same name is not evidence", () => {
    const sessions = [session("s1", 20)];
    const turns = [turn("s1", 12, commit("d7e5977"))];
    const branchState = [
      {
        code_project_id: "proj-other",
        branch: "15178-5-idempotent-debits",
        last_seen_sha: null,
        merged_into: "main",
        merged_at: "2026-09-23T02:00:00Z",
        branch_gone_at: null,
      },
    ];
    const { open } = computeThreads({ issues: [issue("s1", ISSUE)], sessions, turns, branchState });
    expect(open).toHaveLength(1);
  });

  it("a review at commented is never open and carries no note; a review at reviewed carries 'no comment seen'", () => {
    const sessions = [session("s1", 20, 2.1)];
    const reviewedOnly = computeThreads({
      issues: [issue("s1", MR, { review_verb: "reviewed", build_verb: null })],
      sessions,
    });
    expect(reviewedOnly.open).toEqual([]);
    expect(reviewedOnly.recent[0].note).toBe("no comment seen");
    expect(reviewedOnly.recent[0].open).toBe(false);

    const commented = computeThreads({
      issues: [issue("s1", MR, { review_verb: "commented", build_verb: null })],
      sessions,
    });
    expect(commented.open).toEqual([]);
    expect(commented.recent[0].note).toBeUndefined();
    expect(commented.recent[0].ladder.review_verb).toBe("commented");

    // Writing review-17049.md is not delivering on the MR: edited + reviewed still reads as a review.
    const editedReview = computeThreads({
      issues: [issue("s1", MR, { review_verb: "reviewed", build_verb: "edited" })],
      sessions,
    });
    expect(editedReview.open).toEqual([]);
    expect(editedReview.recent[0].note).toBe("no comment seen");
  });

  it("a superseded sha moves the check to the newer sha", () => {
    // commit a1, rebase, commit b2, push; the sweep proves b2 merged → closed.
    const sessions = [session("s1", 20)];
    const turns = [
      turn("s1", 10, commit("a1a1a1a")),
      turn("s1", 14, { verb: "rewrote", refKind: "branch", branch: "15178-5-idempotent-debits", source: "cli" }),
      turn("s1", 18, commit("b2b2b2b")),
      turn("s1", 22, push()),
    ];
    const row = (sha: string) => ({
      code_project_id: PROJECT,
      branch: "15178-5-idempotent-debits",
      last_seen_sha: sha,
      merged_into: "main",
      merged_at: "2026-09-23T02:00:00Z",
      branch_gone_at: null,
    });
    const newest = computeThreads({ issues: [issue("s1", ISSUE)], sessions, turns, branchState: [row("b2b2b2b")] });
    expect(newest.open).toEqual([]);
    expect(newest.recent[0].closure?.kind).toBe("branch_state");

    // The same proof recorded against only the superseded a1 is not evidence: still open.
    const stale = computeThreads({ issues: [issue("s1", ISSUE)], sessions, turns, branchState: [row("a1a1a1a")] });
    expect(stale.open).toHaveLength(1);
    expect(stale.recent[0].closure).toBeNull();
  });

  it("a closure action before the last build action does not close it", () => {
    const sessions = [session("s1", 18), session("s2", 22)];
    const turns = [
      turn("s1", 4, { verb: "closed", refKind: "issue", ref: ISSUE, source: "cli" }),
      turn("s2", 9, commit("c3c3c3c")),
    ];
    const issues = [issue("s1", ISSUE, { build_verb: "closed", turn_idx: 4 }), issue("s2", ISSUE, { turn_idx: 9 })];
    const { open } = computeThreads({ issues, sessions, turns });
    expect(open).toHaveLength(1);
  });

  it("open threads are sorted by est. spend and capped at the limit", () => {
    const sessions = [session("s1", 20, 1), session("s2", 20, 30), session("s3", 20, 5)];
    const refs = ["#1", "#2", "#3"].map((n) => `codehub.example/acme/billing${n}`);
    // v4 B1: only MR rows price, so the spend order is exercised on MRs.
    const issues = sessions.map((s, i) => issue(s.id, refs[i], { kind: "merge_request" }));
    const { open } = computeThreads({ issues, sessions }, { limit: 2 });
    expect(open.map((t) => t.ref)).toEqual([refs[1], refs[2]]);
  });
});

describe("open threads — dismissals", () => {
  it("a dismissed thread does not return next day", () => {
    const sessions = [session("s1", 20, 14.2), session("s2", 21, 4.2)];
    const issues = [issue("s1", ISSUE), issue("s2", ISSUE, { turn_idx: 8 })];
    const turns = [turn("s1", 12, commit("d7e5977")), turn("s2", 6, commit("e8e8e8e"))];
    const before = computeThreads({ issues, sessions, turns });
    expect(before.open.map((t) => t.ref)).toEqual([ISSUE]);

    // Next day: another session on the ref, the dismissal still there.
    const nextDay = computeThreads({
      issues: [...issues, issue("s3", ISSUE, { turn_idx: 2 })],
      sessions: [...sessions, session("s3", 22, 2)],
      turns: [...turns, turn("s3", 2, commit("f9f9f9f"))],
      dismissals: [{ ref: ISSUE, kind: "issue", reason: "not_delivery_item" }],
    });
    expect(nextDay.open).toEqual([]);
    expect(nextDay.recent[0]).toMatchObject({
      ref: ISSUE,
      open: false,
      dismissed: true,
      dismiss_reason: "not_delivery_item",
    });
    // v4 B1: an issue carries no cost (it still lists, dismissed).
    expect(nextDay.recent[0].cost_est_total ?? 0).toBe(0);
  });

  it("S4: a GitHub dismissal recorded under the other kind still holds after the discussed row folds into the observed PR", () => {
    const GH = "github.com/acme/app#5";
    const sessions = [session("s1", 20, 3), session("s2", 21, 4)];
    const issues = [
      // Dismissed while it was a discussed-only issue-kind thread…
      issue("s1", GH, { kind: "issue", role: "discussed", tier: "discussed", build_verb: null, turn_share: 0 }),
      // …then a later session viewed it as a pull request.
      issue("s2", GH, {
        kind: "merge_request",
        role: "referenced",
        tier: "observed",
        review_verb: "viewed",
        build_verb: null,
        turn_share: 0,
      }),
    ];
    const res = computeThreads({
      issues,
      sessions,
      dismissals: [{ ref: GH, kind: "issue", reason: "not_delivery_item" }],
    });
    expect(res.recent).toHaveLength(1);
    expect(res.recent[0]).toMatchObject({ ref: GH, refKind: "merge_request", dismissed: true });
  });

  it("S4: off GitHub, #N (issue) and !N (MR) stay separate — an issue dismissal never hides the MR", () => {
    const sessions = [session("s1", 20, 3)];
    const res = computeThreads({
      issues: [issue("s1", MR, { kind: "merge_request", review_verb: "viewed", build_verb: null })],
      sessions,
      dismissals: [{ ref: MR, kind: "issue", reason: "not_delivery_item" }],
    });
    expect(res.recent[0].ref).toBe(MR);
    expect(res.recent[0].dismissed).toBeUndefined();
  });

  it("a decision memory on the ref never dismisses it (dismissals live in their own table)", () => {
    const sessions = [session("s1", 20)];
    const memories = [
      {
        kind: "decision",
        ref: ISSUE,
        ref_kind: "issue",
        text: "Open thread dismissed (resolved elsewhere): whatever",
        quote: "use idempotency keys",
        turn_role: "user",
        retired_at: null,
      },
    ];
    const { open } = computeThreads({
      issues: [issue("s1", ISSUE)],
      sessions,
      turns: [turn("s1", 1, commit("a1b2c3d"))],
      memories,
    });
    expect(open).toHaveLength(1);
  });

  it("identity is (kind, ref): dismissing MR !17 leaves issue #17 of the same repo open", () => {
    // glab-style forges store both as `host/owner/repo#17`; only the kind tells them apart (F1).
    const SHARED = "codehub.example/acme/billing#17";
    const sessions = [session("s1", 20), session("s2", 21)];
    const issues = [
      issue("s1", SHARED, { kind: "issue" }),
      issue("s2", SHARED, { kind: "merge_request", build_verb: "opened_mr" }),
    ];
    const turns = [turn("s1", 2, commit("abc1234")), turn("s2", 2, commit("def5678"))];
    const res = computeThreads({
      issues,
      sessions,
      turns,
      dismissals: [{ ref: SHARED, kind: "merge_request", reason: "resolved_elsewhere" }],
    });
    const byKind = Object.fromEntries(res.recent.map((t) => [t.refKind, t]));
    expect(byKind.merge_request).toMatchObject({ dismissed: true, open: false });
    expect(byKind.issue.dismissed).toBeUndefined();
    expect(res.open.map((t) => [t.refKind, t.ref])).toEqual([["issue", SHARED]]);
    // The chip links by kind.
    expect(byKind.merge_request.url).toBe("https://codehub.example/acme/billing/-/merge_requests/17");
    expect(byKind.issue.url).toBe("https://codehub.example/acme/billing/-/issues/17");
  });

  it("a kind-less memory ref cannot pick a side when two kinds share the string; a kinded one can", () => {
    const SHARED = "codehub.example/acme/billing#17";
    const key = (kind: "issue" | "merge_request") => ({ ref: SHARED, kind, url: null, ambiguous: true });
    expect(refMatches({ ref: SHARED, refKind: "merge_request" }, key("merge_request"))).toBe(true);
    expect(refMatches({ ref: SHARED, refKind: "merge_request" }, key("issue"))).toBe(false);
    // No kind: the `#` marker reads as an issue, never as the MR.
    expect(refMatches(SHARED, key("merge_request"))).toBe(false);
    // Not ambiguous: the exact stored string still names its only thread (GitHub PRs are `#N`).
    expect(refMatches(SHARED, { ref: SHARED, kind: "merge_request", url: null })).toBe(true);
  });

  it("B8 quotes and blockers match by kind too", () => {
    const SHARED = "codehub.example/acme/billing#17";
    const sessions = [session("s1", 20), session("s2", 21)];
    const issues = [issue("s1", SHARED, { kind: "issue" }), issue("s2", SHARED, { kind: "merge_request" })];
    const memories = [
      {
        id: "q1",
        kind: "decision",
        ref: SHARED,
        ref_kind: "mr",
        text: "land it",
        quote: "this has to land before the release cut",
        turn_role: "user",
        priority: true,
        retired_at: null,
      },
      {
        id: "b1",
        kind: "blocker",
        ref: SHARED,
        ref_kind: "mr",
        text: "ci red",
        quote: null,
        turn_role: "assistant",
        recurrence_count: 3,
        retired_at: null,
      },
    ];
    const res = computeThreads({ issues, sessions, memories });
    const byKind = Object.fromEntries(res.recent.map((t) => [t.refKind, t]));
    expect(byKind.merge_request.priority).toBe("this has to land before the release cut");
    expect(byKind.merge_request.recurrence_count).toBe(3);
    expect(byKind.issue.priority).toBeUndefined();
    expect(byKind.issue.recurrence_count).toBeUndefined();
  });
});

describe("open threads (B8) — priority is quoted or absent", () => {
  it("priority appears only when quoted", () => {
    const sessions = [session("s1", 20)];
    const issues = [issue("s1", ISSUE)];
    const turns = [turn("s1", 1, commit("a1b2c3d"))];

    const without = computeThreads({ issues, sessions, turns });
    expect(without.open[0].priority).toBeUndefined();
    expect(Object.keys(without.open[0])).not.toContain("priority");

    const quote = "the debits fix has to land before the release branch cuts";
    const withQuote = computeThreads({
      issues,
      sessions,
      turns,
      memories: [
        {
          kind: "preference",
          ref: ISSUE,
          text: "debits fix lands first",
          quote,
          turn_role: "user",
          priority: true,
          retired_at: null,
          created_at: "2026-09-24T10:00:00Z",
        },
      ],
    });
    expect(withQuote.open[0].priority).toBe(quote);

    // An assistant-turn "priority", or a quote extraction did not flag, is not the owner's priority —
    // whatever words it holds (C-6: the flag, not a word list, decides).
    const assistant = computeThreads({
      issues,
      sessions,
      turns,
      memories: [
        {
          kind: "decision",
          ref: ISSUE,
          text: "x",
          quote: "this must land before Friday",
          turn_role: "assistant",
          priority: true,
          retired_at: null,
        },
      ],
    });
    expect(assistant.open[0].priority).toBeUndefined();
    const plain = computeThreads({
      issues,
      sessions,
      turns,
      memories: [
        {
          kind: "preference",
          ref: ISSUE,
          text: "x",
          quote: "use tabs in this file",
          turn_role: "user",
          retired_at: null,
        },
      ],
    });
    expect(plain.open[0].priority).toBeUndefined();

    // Ordinary prose with "first" or "blocks" is not an urgency statement.
    const prose = computeThreads({
      issues,
      sessions,
      turns,
      memories: [
        {
          kind: "preference",
          ref: ISSUE,
          text: "x",
          quote: "start with the first test file; nothing blocks on it",
          turn_role: "user",
          retired_at: null,
        },
      ],
    });
    expect(prose.open[0].priority).toBeUndefined();
  });
});

describe("open threads (B11) — cost follows the ref, labelled as an estimate", () => {
  it("cost is the sum of per-session est. shares", () => {
    // One session reviews two MRs 30/70; a second session commits on the issue at share 0.5.
    const sessions = [session("s1", 20, 10), session("s2", 21, 4), session("s3", 22, null)];
    const issues = [
      issue("s1", MR_A, { review_verb: "commented", build_verb: null, turn_share: 0.3 }),
      issue("s1", MR_B, { review_verb: "reviewed", build_verb: null, turn_share: "0.7" }),
      issue("s2", MR_A, { review_verb: "approved", build_verb: null, turn_share: 0.5 }),
      issue("s3", MR_A, { review_verb: "viewed", build_verb: null, role: "discussed", turn_share: 1 }),
    ];
    expect(issues.every((i) => i.kind === "merge_request")).toBe(true);
    const { recent } = computeThreads({ issues, sessions });
    const a = recent.find((t) => t.ref === MR_A);
    const b = recent.find((t) => t.ref === MR_B);
    expect(a?.sessions.map((s) => s.cost_est)).toEqual([3, 2, null]);
    expect(a?.cost_est_total).toBeCloseTo(5, 6);
    // v4 B2: a derived `reviewed` (view + reads) is no review command — no cost.
    expect(b?.cost_est_total ?? 0).toBe(0);
    expect(a?.estimated).toBe(true);
    expect(b?.sessions[0].share).toBe(0);
  });

  it("a pre-W4 row with no turn_share splits the session equally across its worked_on rows", () => {
    const sessions = [session("s1", 20, 8)];
    const issues = [
      issue("s1", ISSUE, { turn_share: null }),
      issue("s1", MR, { turn_share: null, build_verb: null, review_verb: "commented" }),
    ];
    const { recent } = computeThreads({ issues, sessions });
    // v4 B1: the issue row carries no cost; the MR's review row keeps its half.
    expect(recent.map((t) => t.cost_est_total)).toEqual([0, 4]);
  });
});

describe("open threads — the rest of the shape", () => {
  it("a worked_on row with neither ladder rung is a triage; a child whose parent is not in hand is not its own row", () => {
    const sessions = [session("s1", 20, 0.9), session("child", 20, 0, { parent_source_session_id: "src-s1" })];
    const issues = [
      issue("s1", "codehub.example/acme/billing#16002", { review_verb: null, build_verb: null }),
      issue("child", "codehub.example/acme/billing#999", {}),
    ];
    const { open, recent } = computeThreads({ issues, sessions });
    expect(recent).toHaveLength(1);
    expect(recent[0].ladder).toEqual({ review_verb: null, build_verb: null, triaged: true, discussed: false });
    expect(open).toEqual([]);
  });

  it("recurrence is a count on the thread; blockers are listed most recurrent first, then latest", () => {
    const sessions = [session("s1", 20)];
    const blocker = (id: string, count: number, created_at: string, extra: Record<string, unknown> = {}) => ({
      id,
      kind: "blocker",
      ref: null,
      text: `blocker ${id}`,
      quote: null,
      turn_role: "assistant",
      recurrence_count: count,
      retired_at: null,
      created_at,
      ...extra,
    });
    const memories = [
      blocker("newest-1", 1, "2026-09-26T00:00:00Z"),
      blocker("b4", 4, "2026-09-20T00:00:00Z", {
        ref: ISSUE,
        quote: "smoke job times out",
        code_session_id: "s1",
        turn_idx: 5,
      }),
      blocker("b2", 2, "2026-09-22T00:00:00Z", { quote: "the flaky one again", turn_role: "user" }),
    ];
    const res = computeThreads({ issues: [issue("s1", ISSUE)], sessions, memories });
    expect(res.recent[0].recurrence_count).toBe(4);
    // Counts 1 (newest), 4, 2 → 4, 2, 1.
    expect(res.recurring_blockers.map((b) => b.recurrence_count)).toEqual([4, 2, 1]);
    expect(res.recurring_blockers[0]).toEqual({
      id: "b4",
      text: "blocker b4",
      // An assistant turn's words are never shown as the owner's quote.
      quote: null,
      ref: ISSUE,
      recurrence_count: 4,
      session_id: "s1",
      turn_idx: 5,
      last_seen_at: "2026-09-20T00:00:00Z",
    });
    expect(res.recurring_blockers[1].quote).toBe("the flaky one again");
  });

  it("a malformed action or an unknown session never throws (B12)", () => {
    const sessions = [session("s1", 20)];
    const turns: ThreadTurnRow[] = [
      { session_id: "s1", idx: 1, props: { action: "nope" } },
      { session_id: "s1", idx: 2, props: { actions: [null, { verb: 7 }] } },
      { session_id: "ghost", idx: 3, props: { action: { verb: "merged", ref: ISSUE } } },
      { session_id: "s1", idx: 4, props: null },
    ];
    expect(() =>
      computeThreads({ issues: [issue("s1", ISSUE), issue("ghost", ISSUE)], sessions, turns }),
    ).not.toThrow();
    expect(computeThreads({ issues: [], sessions: [] })).toEqual({
      open: [],
      recent: [],
      recurring_blockers: [],
      estimated: true,
    });
  });
});

describe("open threads — review fixes (F2, F4, F7, tier, priority)", () => {
  const SHARED = "codehub.example/acme/billing#17";
  const tsTurn = (session_id: string, idx: number, ts: string, action: Record<string, unknown>): ThreadTurnRow => ({
    session_id,
    idx,
    ts,
    props: { action },
  });

  it("F4: a merge later in wall-clock time closes the thread even when its session started first", () => {
    // A starts 09:00 and merges !17 at 17:00; B starts 10:00 and commits at 10:30.
    const sessions = [
      session("A", 20, 1, { started_at: "2026-09-20T09:00:00Z" }),
      session("B", 20, 1, { started_at: "2026-09-20T10:00:00Z" }),
    ];
    const issues = [
      issue("A", SHARED, { kind: "merge_request", build_verb: "merged" }),
      issue("B", SHARED, { kind: "merge_request", build_verb: "committed" }),
    ];
    const turns = [
      tsTurn("B", 3, "2026-09-20T10:30:00Z", commit("abc1234")),
      tsTurn("A", 500, "2026-09-20T17:00:00Z", { verb: "merged", ref: "!17", refKind: "merge_request" }),
    ];
    const res = computeThreads({ issues, sessions, turns });
    expect(res.open).toEqual([]);
    expect(res.recent[0].closure).toMatchObject({ kind: "action", session_id: "A", verb: "merged" });
  });

  it("F4: a commit later in wall-clock time than a merge in a longer-started session keeps the thread open", () => {
    // A starts 09:00 and merges at 09:30; B starts 08:00 (earlier) but commits at 11:00.
    const sessions = [
      session("A", 20, 1, { started_at: "2026-09-20T09:00:00Z" }),
      session("B", 20, 1, { started_at: "2026-09-20T08:00:00Z" }),
    ];
    const issues = [
      issue("A", SHARED, { kind: "merge_request", build_verb: "committed" }),
      issue("B", SHARED, { kind: "merge_request", build_verb: "committed" }),
    ];
    const turns = [
      tsTurn("A", 2, "2026-09-20T09:10:00Z", commit("aaa1111")),
      tsTurn("A", 9, "2026-09-20T09:30:00Z", { verb: "merged", ref: "!17", refKind: "merge_request" }),
      tsTurn("B", 400, "2026-09-20T11:00:00Z", commit("bbb2222")),
    ];
    const res = computeThreads({ issues, sessions, turns });
    expect(res.open).toHaveLength(1);
    expect(res.recent[0].closure).toBeNull();
  });

  it("F2/B16: a sub-agent that pushes !17 opens the thread under its parent, which only viewed it", () => {
    const sessions = [
      session("p", 20, 5, { source: "claude-code", source_session_id: "src-p" }),
      session("c", 20, 1, { source: "claude-code", source_session_id: "src-c", parent_source_session_id: "src-p" }),
    ];
    const issues = [
      issue("p", SHARED, {
        kind: "merge_request",
        review_verb: "viewed",
        build_verb: null,
        role: "discussed",
        turn_share: 0.5,
      }),
      issue("c", SHARED, { kind: "merge_request", build_verb: "pushed", turn_idx: 5 }),
    ];
    const turns = [turn("c", 4, commit("abc1234", "feat/x")), turn("c", 5, push("feat/x"))];
    const res = computeThreads({ issues, sessions, turns });
    expect(res.open).toHaveLength(1);
    const t = res.open[0];
    expect(t.ladder.build_verb).toBe("pushed");
    expect(t.sessions.map((s) => s.id)).toEqual(["p"]);
    // B16: each session's cost by its own row's share — v4: the parent's view carries none; child 1 x $1.
    expect(t.cost_est_total).toBeCloseTo(1, 6);
  });

  it("F7 (maintainer): an observed MR merge does not close the issue it served", () => {
    const sessions = [session("s1", 20)];
    const issues = [
      issue("s1", "codehub.example/acme/billing#42", {
        kind: "issue",
        build_verb: "opened_mr",
        turn_share: 0.5,
        related_to: ["codehub.example/acme/billing#50"],
      }),
      issue("s1", "codehub.example/acme/billing#50", { kind: "merge_request", build_verb: "merged", turn_share: 0.5 }),
    ];
    const turns = [
      turn("s1", 2, commit("abc1234")),
      turn("s1", 3, {
        verb: "opened_mr",
        ref: "!50",
        refKind: "merge_request",
        url: "https://codehub.example/acme/billing/-/merge_requests/50",
      }),
      turn("s1", 9, { verb: "merged", ref: "!50", refKind: "merge_request" }),
    ];
    const res = computeThreads({ issues, sessions, turns });
    const byKind = Object.fromEntries(res.recent.map((t) => [t.refKind, t]));
    expect(byKind.merge_request.closure).not.toBeNull();
    expect(byKind.issue.open).toBe(true);
    expect(byKind.issue.closure).toBeNull();
  });

  it("tier: a discussed-tier row carries no observed rung and never opens", () => {
    const res = computeThreads({
      sessions: [session("s1", 20)],
      issues: [issue("s1", ISSUE, { role: "discussed", tier: "discussed", build_verb: "committed" })],
    });
    expect(res.open).toEqual([]);
    expect(res.recent[0].ladder.discussed).toBe(true);
    expect(res.recent[0].sessions[0].tier).toBe("discussed");
  });

  it("priority: only the owner's own flagged quote from a user turn, the latest", () => {
    const q = (id: string, turn_role: string, created_at: string, quote: string, priority = true) => ({
      id,
      kind: "decision",
      ref: ISSUE,
      ref_kind: "issue",
      text: quote,
      quote,
      turn_role,
      priority,
      retired_at: null,
      created_at,
      code_session_id: "s1",
      turn_idx: 4,
    });
    const res = computeThreads(
      {
        sessions: [session("s1", 20)],
        issues: [issue("s1", ISSUE)],
        memories: [
          q("u1", "user", "2026-09-24T00:00:00Z", "this has to land before the release cut"),
          q("a1", "assistant", "2026-09-25T00:00:00Z", "this has to land before friday"),
          q("old", "user", "2026-09-01T00:00:00Z", "urgent: ship before the freeze"),
        ],
      },
      { now: new Date("2026-09-26T12:00:00Z") },
    );
    expect(res.recent[0].priority).toBe("this has to land before the release cut");
  });
});

describe("open threads — a dismissal holds until new delivery work (maintainer rule)", () => {
  const at = (session_id: string, idx: number, ts: string, action: Record<string, unknown>): ThreadTurnRow => ({
    session_id,
    idx,
    ts,
    props: { action },
  });
  const base = () => ({
    sessions: [session("s1", 20), session("s2", 24)],
    issues: [issue("s1", ISSUE), issue("s2", ISSUE, { review_verb: "commented", build_verb: null })],
  });

  for (const reason of ["resolved_elsewhere", "not_delivery_item"] as const) {
    it(`${reason}: a commit on the same (kind, ref) after the dismissal brings the thread back`, () => {
      const { sessions, issues } = base();
      const res = computeThreads({
        sessions,
        issues: [...issues.slice(0, 1), issue("s2", ISSUE, { build_verb: "committed" })],
        turns: [
          at("s1", 2, "2026-09-20T10:00:00Z", commit("aaa1111")),
          at("s2", 3, "2026-09-24T10:00:00Z", commit("bbb2222")),
        ],
        dismissals: [{ ref: ISSUE, kind: "issue", reason, created_at: "2026-09-22T00:00:00Z" }],
      });
      expect(res.open.map((t) => t.ref)).toEqual([ISSUE]);
      expect(res.recent[0].dismissed).toBeUndefined();
    });

    it(`${reason}: viewing, commenting or discussing after the dismissal does not bring it back`, () => {
      const { sessions, issues } = base();
      const res = computeThreads({
        sessions,
        issues: [...issues, issue("s2", ISSUE, { role: "discussed", tier: "discussed", build_verb: null })],
        turns: [
          at("s1", 2, "2026-09-20T10:00:00Z", commit("aaa1111")),
          at("s2", 3, "2026-09-24T10:00:00Z", { verb: "viewed", ref: "#15178", refKind: "issue" }),
          at("s2", 4, "2026-09-24T10:05:00Z", { verb: "commented", ref: "#15178", refKind: "issue" }),
        ],
        dismissals: [{ ref: ISSUE, kind: "issue", reason, created_at: "2026-09-22T00:00:00Z" }],
      });
      expect(res.open).toEqual([]);
      expect(res.recent[0]).toMatchObject({ dismissed: true, dismiss_reason: reason });
    });
  }

  it("a commit on the MR twin (same ref string, other kind) does not bring back the dismissed issue", () => {
    const SHARED = "codehub.example/acme/billing#17";
    const res = computeThreads({
      sessions: [session("s1", 20), session("s2", 24)],
      issues: [issue("s1", SHARED, { kind: "issue" }), issue("s2", SHARED, { kind: "merge_request" })],
      turns: [
        at("s1", 2, "2026-09-20T10:00:00Z", commit("aaa1111")),
        at("s2", 3, "2026-09-24T10:00:00Z", { ...commit("bbb2222"), branch: "other" }),
      ],
      dismissals: [{ ref: SHARED, kind: "issue", reason: "resolved_elsewhere", created_at: "2026-09-22T00:00:00Z" }],
    });
    const byKind = Object.fromEntries(res.recent.map((t) => [t.refKind, t]));
    expect(byKind.issue.dismissed).toBe(true);
    expect(byKind.merge_request.open).toBe(true);
  });
});

describe("maintainer rule: a link lands on the turn that SHOWS the action (sub-agents)", () => {
  it("a parent row on its sub-agent spawn turn links to the child's comment turn instead", () => {
    const ISS = "github.com/acme/billing#145";
    const sessions = [
      session("p", 20, 5, { source: "claude-code", source_session_id: "src-p" }),
      session("c", 20, 1, { source: "claude-code", source_session_id: "src-c", parent_source_session_id: "src-p" }),
    ];
    const issues = [
      // Real shape (local DB, #145): the parent's row sits on the Agent spawn turn 182, with the child's command as evidence.
      issue("p", ISS, { kind: "issue", review_verb: "commented", build_verb: null, turn_idx: 182 }),
      issue("c", ISS, { kind: "issue", review_verb: "commented", build_verb: null, turn_idx: 132 }),
    ];
    const turns = [turn("c", 132, { verb: "commented", ref: "#145", refKind: "issue", source: "cli" })];
    const t = computeThreads({ issues, sessions, turns }).recent.find((x) => x.ref === ISS);
    expect(t?.sessions.map((s) => [s.id, s.proof_session_id, s.turn_idx])).toEqual([["p", "c", 132]]);
  });

  it("the parent's own action turn still wins over a child's", () => {
    const ISS = "github.com/acme/billing#146";
    const sessions = [
      session("p", 20, 5, { source: "claude-code", source_session_id: "src-p" }),
      session("c", 20, 1, { source: "claude-code", source_session_id: "src-c", parent_source_session_id: "src-p" }),
    ];
    const issues = [
      issue("p", ISS, { kind: "issue", review_verb: "commented", build_verb: null, turn_idx: 40 }),
      issue("c", ISS, { kind: "issue", review_verb: "commented", build_verb: null, turn_idx: 9 }),
    ];
    const turns = [
      turn("p", 40, { verb: "commented", ref: "#146", refKind: "issue", source: "cli" }),
      turn("c", 9, { verb: "commented", ref: "#146", refKind: "issue", source: "cli" }),
    ];
    const t = computeThreads({ issues, sessions, turns }).recent.find((x) => x.ref === ISS);
    expect(t?.sessions.map((s) => [s.proof_session_id, s.turn_idx])).toEqual([["p", 40]]);
  });
});
