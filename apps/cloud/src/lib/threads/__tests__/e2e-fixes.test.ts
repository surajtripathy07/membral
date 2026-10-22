// E2E fixes (2026-09-27) for open threads, from the e2e run's evidence:
//   C-6  a German priority reaches the thread — the extraction flag decides, never a word list
//   C-9/B7 a thread title is a commit subject, a forge title, or the ref — never command text or a quote
//   U09/B9 a `reopened` after a close voids that close
import { describe, expect, it } from "vitest";
import { computeThreads, type ThreadIssueRow, type ThreadSessionRow, type ThreadTurnRow } from "../open-threads";

const REF = "codehub.example/e2e-edge/example-repo#5";
const NOW = new Date("2026-09-26T21:00:00Z");

const session = (id: string, started_at: string): ThreadSessionRow => ({
  id,
  code_project_id: "p1",
  started_at,
  git_branch: "main",
  turn_count: 20,
  parent_source_session_id: null,
  cost_usd: 1,
});
const row = (session_id: string, over: Partial<ThreadIssueRow> = {}): ThreadIssueRow => ({
  session_id,
  ref: REF,
  number: 5,
  kind: "issue",
  role: "worked_on",
  evidence_quote: "gh pr create --title ‹text› --body ‹text› --label e2e",
  turn_idx: 2,
  review_verb: null,
  build_verb: "committed",
  tier: "observed",
  turn_share: 1,
  related_to: [],
  ...over,
});
const turn = (session_id: string, idx: number, ts: string, action: Record<string, unknown>): ThreadTurnRow => ({
  session_id,
  idx,
  ts,
  props: { action },
});

describe("C-6: the thread priority follows extraction's priority flag, in any language", () => {
  // The real U16 turn (trimmed): German, no English urgency word.
  const german = "ab jetzt ist Issue #5 die wichtigste Priorität, das muss diese Woche fertig werden";
  const memory = (id: string, quote: string, priority: boolean) => ({
    id,
    kind: "preference",
    ref: REF,
    ref_kind: "issue",
    text: "Issue #5 is the highest priority this week.",
    quote,
    turn_role: "user",
    priority,
    retired_at: null,
    created_at: "2026-09-26T20:00:00Z",
    code_session_id: "s1",
    turn_idx: 13,
  });

  it("a flagged German quote surfaces; an unflagged English urgency quote does not", () => {
    const res = computeThreads(
      {
        sessions: [session("s1", "2026-09-26T19:00:00Z")],
        issues: [row("s1")],
        memories: [memory("de", german, true), memory("en", "urgent: this has to land before friday", false)],
      },
      { now: NOW },
    );
    expect(res.recent[0].priority).toBe(german);
  });
});

describe("C-9/B7: thread titles are observed text, never command fragments", () => {
  const sessions = [session("s1", "2026-09-26T19:00:00Z")];

  it("no subject and no forge title: the title is the ref, not the evidence quote (N09 'issues/10')", () => {
    const res = computeThreads({ sessions, issues: [row("s1", { evidence_quote: "issues/10" })] }, { now: NOW });
    expect(res.recent[0].title).toBe(REF);
  });

  it("the newest commit subject on the thread's commits wins", () => {
    const turns = [
      turn("s1", 3, "2026-09-26T19:01:00Z", {
        verb: "committed",
        sha: "a1b2c3d",
        branch: "main",
        subject: "narrate: add logging",
        source: "cli",
      }),
      turn("s1", 5, "2026-09-26T19:02:00Z", {
        verb: "committed",
        sha: "b2c3d4e",
        branch: "main",
        subject: "Add License section to README",
        source: "cli",
      }),
    ];
    const res = computeThreads({ sessions, issues: [row("s1")], turns }, { now: NOW });
    expect(res.recent[0].title).toBe("Add License section to README");
    // Review r2 S1: neither commit is TIED to #5 (no subject names it, no MR branch), so the row
    // states no commit facts for it.
    expect(res.recent[0].first_commit_subject).toBeUndefined();
    expect(res.recent[0].commit_count).toBeUndefined();
    expect(res.recent[0].forge_title).toBeUndefined();
  });

  it("review r2 S1: one session committing for two items — each row counts only its own tied commits", () => {
    const REF_B = "codehub.example/e2e-edge/example-repo#7";
    const commit = (idx: number, sha: string, branch: string, subject: string) =>
      turn("s1", idx, `2026-09-26T19:0${idx}:00Z`, { verb: "committed", sha, branch, subject, source: "cli" });
    const turns = [
      commit(1, "aaa1111", "fix-5", "Fix umlauts in export, refs #5"),
      commit(2, "bbb2222", "feat-7", "Add PDF export, closes #7"),
      commit(3, "ccc3333", "fix-5", "Follow-up for #5: tests"),
      commit(4, "ddd4444", "feat-7", "tidy"),
    ];
    const res = computeThreads(
      {
        sessions,
        issues: [row("s1"), row("s1", { ref: REF_B, number: 7 })],
        turns,
        projectIdentity: { p1: "codehub.example/e2e-edge/example-repo" },
      },
      { now: NOW },
    );
    const five = res.recent.find((t) => t.ref === REF);
    const seven = res.recent.find((t) => t.ref === REF_B);
    expect(five?.commit_count).toBe(2);
    expect(five?.first_commit_subject).toBe("Fix umlauts in export, refs #5");
    expect(seven?.commit_count).toBe(1); // "tidy" names nothing: not tied
    expect(seven?.first_commit_subject).toBe("Add PDF export, closes #7");
    // A squash suffix "(#5)" is the PR number, not the item — never a tie.
    const squash = computeThreads(
      {
        sessions,
        issues: [row("s1")],
        turns: [commit(1, "eee5555", "main", "Merge work (#5)")],
        projectIdentity: { p1: "codehub.example/e2e-edge/example-repo" },
      },
      { now: NOW },
    );
    expect(squash.recent[0].commit_count).toBeUndefined();
  });

  it("a subject that is really the command digest (amend) is skipped", () => {
    const turns = [
      turn("s1", 3, "2026-09-26T19:01:00Z", {
        verb: "committed",
        sha: "a1b2c3d",
        branch: "main",
        subject: "fix the parser",
        source: "cli",
      }),
      turn("s1", 5, "2026-09-26T19:02:00Z", {
        verb: "rewrote",
        branch: "main",
        subject: "git commit --amend -m ‹text›",
        source: "cli",
      }),
    ];
    const res = computeThreads({ sessions, issues: [row("s1")], turns }, { now: NOW });
    expect(res.recent[0].title).toBe("fix the parser");
  });

  it("with no commit, a forge title from a view result naming the ref is used", () => {
    const turns = [
      turn("s1", 3, "2026-09-26T19:01:00Z", {
        verb: "viewed",
        ref: "#5",
        refKind: "issue",
        state: "open",
        title: "Umlaute in the\nnarration are garbled",
        source: "cli",
      }),
    ];
    const res = computeThreads(
      { sessions, issues: [row("s1", { build_verb: null, review_verb: "viewed" })], turns },
      { now: NOW },
    );
    expect(res.recent[0].title).toBe("Umlaute in the narration are garbled");
  });
});

describe("U09/B9: reopened supersedes an earlier close", () => {
  const sessions = [session("s1", "2026-09-26T18:00:00Z"), session("s2", "2026-09-26T19:00:00Z")];
  const issues = [row("s1"), row("s2", { build_verb: null, review_verb: "commented" })];
  const commitTurn = turn("s1", 2, "2026-09-26T18:01:00Z", {
    verb: "committed",
    sha: "a1b2c3d",
    branch: "main",
    source: "cli",
  });
  const closeTurn = turn("s1", 4, "2026-09-26T18:02:00Z", {
    verb: "closed",
    ref: "#5",
    refKind: "issue",
    source: "cli",
  });

  it("closed, then reopened in a later session: no closure, open again", () => {
    const closed = computeThreads({ sessions, issues, turns: [commitTurn, closeTurn] }, { now: NOW });
    expect(closed.recent[0].closure).toMatchObject({ kind: "action", verb: "closed" });

    const reopen = turn("s2", 3, "2026-09-26T19:01:00Z", {
      verb: "commented",
      ref: "#5",
      refKind: "issue",
      state: "reopened",
      source: "cli",
    });
    const res = computeThreads({ sessions, issues, turns: [commitTurn, closeTurn, reopen] }, { now: NOW });
    expect(res.recent[0].closure).toBeNull();
    expect(res.recent[0].open).toBe(true);
  });

  it("a close after the reopen closes it again", () => {
    const reopen = turn("s2", 3, "2026-09-26T19:01:00Z", {
      verb: "reopened",
      ref: "#5",
      refKind: "issue",
      source: "cli",
    });
    const closeAgain = turn("s2", 6, "2026-09-26T19:05:00Z", {
      verb: "closed",
      ref: "#5",
      refKind: "issue",
      source: "cli",
    });
    const res = computeThreads({ sessions, issues, turns: [commitTurn, closeTurn, reopen, closeAgain] }, { now: NOW });
    expect(res.recent[0].closure).toMatchObject({ kind: "action", verb: "closed", turn_idx: 6 });
  });
});

describe("recurring blockers: the dashboard counts a retired root like the preamble does", () => {
  it("a live chain whose root was retired carries the root's count, and matches the preamble's seen N×", async () => {
    const { collapseBlockerChains } = await import("../queries");
    const { collapseRecurrenceChains, retiredRootCountsFor } = await import("@/lib/memory/preamble");
    const live = [
      {
        id: "b2",
        kind: "blocker",
        ref: null,
        text: "FX fixture download hangs npm test",
        quote: null,
        turn_role: "user",
        recurrence_count: 1,
        recurs_of: "root-retired",
        created_at: "2026-09-26T20:20:00Z",
        code_session_id: "s1",
      },
    ];
    // The retired root was seen 4× before it was retired.
    const tables: Record<string, Array<Record<string, unknown>>> = {
      session_memories: [{ id: "root-retired", recurrence_count: 4 }],
      code_sessions: [{ id: "s1", started_at: "2026-09-26T19:00:00Z", ended_at: "2026-09-26T19:30:00Z" }],
    };
    const fake = {
      from: (t: string) => ({
        select: () => ({
          eq: () => ({
            in: (_c: string, ids: string[]) =>
              Promise.resolve({ data: (tables[t] ?? []).filter((r) => ids.includes(r.id as string)), error: null }),
          }),
        }),
      }),
    } as unknown as Parameters<typeof collapseBlockerChains>[0];

    const dashboard = await collapseBlockerChains(fake, "u", live as never);
    expect(dashboard.map((r) => [r.id, r.recurrence_count])).toEqual([["b2", 4]]);
    const preamble = collapseRecurrenceChains(live as never, await retiredRootCountsFor(fake, "u", live as never));
    expect(preamble.seen.get("b2")).toBe(4);
  });
});
