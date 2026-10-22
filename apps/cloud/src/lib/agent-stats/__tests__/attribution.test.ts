// Goal 2026-07-26 step 9 slice two — parser + aggregation correctness.
//
// Fixture turn shapes are copied from REAL code_session_turns rows observed
// against the founder corpus (via a scratch script per the task brief), then
// SCRUBBED: repo/project names and prose replaced with fictional CodeHub /
// parade-planner content (fixtures use fictional CodeHub repo names).
// Shapes preserved exactly: `props.inputDigest` on Bash tool_use turns,
// `[tool_result elided: ok]` on the following tool_result turn, and the
// heredoc `-m "$(cat <<'EOF' ... EOF)"` commit-message convention.
import { describe, expect, it } from "vitest";
import type { AgentStatsSessionInput } from "../aggregate";
import {
  type AttributionTurnInput,
  aggregateIssueAttribution,
  type CommitEvent,
  emptySessionOutcome,
  groupCommitEventsBySession,
  parseCommitEvents,
  type SessionIssueRow,
  subAgentParents,
} from "../attribution";

function turn(overrides: Partial<AttributionTurnInput>): AttributionTurnInput {
  return {
    session_id: "s1",
    idx: 0,
    role: "assistant",
    kind: "prose",
    text: null,
    tool_name: null,
    ts: "2026-07-10T15:48:10.000Z",
    props: null,
    ...overrides,
  };
}

function bashCommit(idx: number, digest: string, overrides: Partial<AttributionTurnInput> = {}): AttributionTurnInput {
  return turn({
    idx,
    kind: "tool_use",
    tool_name: "Bash",
    ts: `2026-07-10T15:48:${String(10 + idx).padStart(2, "0")}.000Z`,
    props: { inputDigest: digest },
    ...overrides,
  });
}

function toolResult(
  idx: number,
  status: "ok" | "error" = "ok",
  overrides: Partial<AttributionTurnInput> = {},
): AttributionTurnInput {
  return turn({
    idx,
    role: "user",
    kind: "tool_result",
    tool_name: "Bash",
    text: `[tool_result elided: ${status}]`,
    props: {},
    ...overrides,
  });
}

function prose(idx: number, text: string, overrides: Partial<AttributionTurnInput> = {}): AttributionTurnInput {
  return turn({ idx, role: "assistant", kind: "prose", text, ...overrides });
}

describe("parseCommitEvents", () => {
  it("recovers the subject when the heredoc message closes within the digest cap", () => {
    const digest =
      "git add docs/goals/x.md && git commit -m \"$(cat <<'EOF'\ndocs: check goal criterion (issue closed)\n\nWhat: box checked.\nWhy: verification passed.\n\nparent #93\nEOF\n)\"";
    const turns = [bashCommit(0, digest), toolResult(1)];
    const events = parseCommitEvents(turns);
    expect(events).toHaveLength(1);
    expect(events[0].subject).toBe("docs: check goal criterion (issue closed)");
    expect(events[0].truncated).toBe(false);
    expect(events[0].sessionId).toBe("s1");
  });

  it("real-shape finding: a long heredoc body truncated by the 400-char digest cap is flagged truncated", () => {
    // Real digest length observed on the founder corpus tops out at exactly
    // 400 chars (claude-code.ts's MAX_DIGEST_CHARS) with no closing EOF in
    // sight — this fixture reproduces that shape at a shorter but still
    // closing-marker-absent length.
    const body =
      "Phase 1a: parade-planner cockpit skeleton (backend + PWA)\n\n" +
      "What:\n- FastAPI backend: SQLAlchemy 2.0 models for the full schema\n" +
      "  (routes, floats, vendor bookings, permits), initial migration,\n" +
      "  CRUD routers, as-of budget engine";
    const digest = `git commit -m "$(cat <<'EOF'\n${body}`; // no closing EOF — simulates truncation
    const events = parseCommitEvents([bashCommit(0, digest), toolResult(1)]);
    expect(events).toHaveLength(1);
    expect(events[0].truncated).toBe(true);
    expect(events[0].subject).toBe("Phase 1a: parade-planner cockpit skeleton (backend + PWA)");
  });

  it("parses a simple quoted -m form with no heredoc", () => {
    const events = parseCommitEvents([
      bashCommit(0, 'git commit --allow-empty -m "initial" && git log --oneline'),
      toolResult(1),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].subject).toBe("initial");
    expect(events[0].truncated).toBe(false);
  });

  it("recovers a best-effort sha from nearby assistant narration, anchored on a keyword (not a bare hex scan)", () => {
    const events = parseCommitEvents([
      bashCommit(0, 'git commit -m "fix: routing bug"'),
      toolResult(1),
      prose(2, "Committed as 645208b. All green."),
    ]);
    expect(events[0].sha).toBe("645208b");
  });

  it("does not treat an incidental hex-looking word as a sha absent a nearby keyword", () => {
    const events = parseCommitEvents([
      bashCommit(0, 'git commit -m "fix: routing bug"'),
      toolResult(1),
      prose(2, "The cafebabe constant is unrelated to this change."),
    ]);
    expect(events[0].sha).toBeNull();
  });

  it("stops the sha scan window at the NEXT git-commit Bash call, never bleeding narration across commits", () => {
    const events = parseCommitEvents([
      bashCommit(0, 'git commit -m "first change"'),
      toolResult(1),
      bashCommit(2, 'git commit -m "second change"'),
      toolResult(3),
      prose(4, "Committed as aaaaaaa for the second change."),
    ]);
    expect(events).toHaveLength(2);
    expect(events[0].sha).toBeNull(); // first commit's window is cut off by the second Bash call
    expect(events[1].sha).toBe("aaaaaaa");
  });

  it("ignores Bash calls that are not git commit", () => {
    const events = parseCommitEvents([bashCommit(0, "git status"), toolResult(1)]);
    expect(events).toEqual([]);
  });

  it("groups turns by session_id and sorts by idx before scanning, independent of input order", () => {
    const outOfOrder: AttributionTurnInput[] = [
      toolResult(1, "ok", { session_id: "b" }),
      bashCommit(0, "git commit -m \"$(cat <<'EOF'\nfeat: b work\n\nparent #7\nEOF\n)\"", { session_id: "b" }),
      toolResult(1, "ok", { session_id: "a" }),
      bashCommit(0, "git commit -m \"$(cat <<'EOF'\nfeat: a work\n\nparent #5\nEOF\n)\"", { session_id: "a" }),
    ];
    const events = parseCommitEvents(outOfOrder);
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.sessionId === "a")?.subject).toBe("feat: a work");
    expect(events.find((e) => e.sessionId === "b")?.subject).toBe("feat: b work");
  });
});

// ---- aggregateIssueAttribution ---------------------------------------------

const USAGE = {
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cacheReadInputTokens: 200_000,
  cacheCreationInputTokens: 50_000,
};

function session(overrides: Partial<AgentStatsSessionInput> = {}): AgentStatsSessionInput {
  return {
    id: "s1",
    started_at: "2026-07-10T12:00:00.000Z",
    turn_count: 10,
    user_turn_count: 4,
    props: { usage: USAGE, models: ["claude-sonnet-5"] },
    ...overrides,
  };
}

function commit(overrides: Partial<CommitEvent>): CommitEvent {
  return {
    sha: null,
    observed: false,
    turnIdx: 0,
    message: "m",
    subject: "m",
    sessionId: "s1",
    at: "2026-07-10T12:00:01.000Z",
    truncated: false,
    ...overrides,
  };
}

const REPO = "codehub.example/codehub/parade-planner";

function issueRow(overrides: Partial<SessionIssueRow> = {}): SessionIssueRow {
  // v4: a worked_on row carries the verb that makes it one (role comes from verbs only), and cost
  // comes only from PR/branch evidence — so the priced fixture row is an MR with a commit on it.
  const role = overrides.role ?? "worked_on";
  const verbs = role === "worked_on" ? { build_verb: "committed", tier: "observed" as const } : {};
  return { session_id: "s1", ref: `${REPO}#42`, number: 42, kind: "merge_request", role, ...verbs, ...overrides };
}

function fullCost(): number {
  const { unattributed } = aggregateIssueAttribution([session()], [], []);
  return unattributed.costUsd ?? 0;
}

describe("aggregateIssueAttribution", () => {
  it("a session that worked on one issue puts its full cost, tokens, and commits there", () => {
    const { issues, unattributed } = aggregateIssueAttribution(
      [session()],
      // v4 B4: off GitHub a subject `#42` is the issue, never MR !42 — the MR's commit ties by its branch.
      [commit({ subject: "fix: codehub/parade-planner#42 thing", sha: "abc1234", branch: "fix-42" })],
      [issueRow()],
      { mrBranches: new Map([["s1", [{ ref: `${REPO}!42`, branch: "fix-42" }]]]) },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].issue).toBe(`${REPO}#42`);
    expect(issues[0].kind).toBe("merge_request");
    expect(issues[0].sessions).toBe(1);
    expect(issues[0].costUsd).toBeCloseTo(fullCost(), 6);
    expect(issues[0].tokens.input).toBe(1_000_000);
    expect(issues[0].commits).toEqual([
      { sha: "abc1234", subject: "fix: codehub/parade-planner#42 thing", at: "2026-07-10T12:00:01.000Z" },
    ]);
    expect(unattributed.sessions).toBe(0);
    expect(unattributed.costUsd).toBeNull();
  });

  it("splits cost and tokens equally across worked_on issues only — a referenced issue gets no share", () => {
    const rows = [
      issueRow({ ref: `${REPO}#1`, number: 1 }),
      issueRow({ ref: `${REPO}#2`, number: 2, kind: "merge_request" }),
      issueRow({ ref: `${REPO}#3`, number: 3, role: "referenced" }),
    ];
    const { issues } = aggregateIssueAttribution([session()], [], rows);
    const one = issues.find((i) => i.issue === `${REPO}#1`)!;
    const two = issues.find((i) => i.issue === `${REPO}#2`)!;
    const three = issues.find((i) => i.issue === `${REPO}#3`)!;
    expect(one.costUsd).toBeCloseTo(fullCost() / 2, 6);
    expect(two.costUsd).toBeCloseTo(fullCost() / 2, 6);
    expect(one.tokens.input).toBe(500_000);
    expect(two.kind).toBe("merge_request");
    expect(three.costUsd).toBeNull();
    expect(three.mentions).toBe(1);
    // Every session that touched a ref counts on that ref (maintainer rule): one session, two refs.
    expect([one.sessions, two.sessions]).toEqual([1, 1]);
  });

  it("a referenced issue carries no cost, tokens, turns, or commits — only a mention", () => {
    const { issues, unattributed } = aggregateIssueAttribution(
      [session()],
      [commit({ sha: "abc1234" })],
      [issueRow({ role: "referenced" })],
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].mentions).toBe(1);
    expect(issues[0].sessions).toBe(0);
    expect(issues[0].costUsd).toBeNull();
    expect(issues[0].turns).toBe(0);
    expect(issues[0].tokens).toEqual({ input: 0, output: 0, cache_read: 0, cache_creation: 0 });
    expect(issues[0].commits).toEqual([]);
    // With nothing worked on, the session's cost stays unattributed.
    expect(unattributed.sessions).toBe(1);
    expect(unattributed.costUsd).toBeCloseTo(fullCost(), 6);
    expect(unattributed.commits).toHaveLength(1);
  });

  it("an issue both worked on and referenced by one session counts as worked on, not as a mention", () => {
    const { issues } = aggregateIssueAttribution([session()], [], [issueRow(), issueRow({ role: "referenced" })]);
    expect(issues).toHaveLength(1);
    expect(issues[0].mentions).toBe(0);
    expect(issues[0].costUsd).toBeCloseTo(fullCost(), 6);
  });

  it("a session with no issue rows (never extracted) is unattributed — no commit-message fallback", () => {
    const { issues, unattributed } = aggregateIssueAttribution(
      [session()],
      [commit({ message: "fix: thing\n\nparent #93", subject: "fix: thing" })],
      [],
    );
    expect(issues).toEqual([]);
    expect(unattributed.sessions).toBe(1);
    expect(unattributed.costUsd).toBeCloseTo(fullCost(), 6);
  });

  it("the same number in two repos stays two issues", () => {
    const rows = [
      issueRow({ session_id: "s1", ref: `${REPO}#7`, number: 7 }),
      issueRow({ session_id: "s2", ref: "codehub.example/codehub/float-builder#7", number: 7 }),
    ];
    const { issues } = aggregateIssueAttribution([session({ id: "s1" }), session({ id: "s2" })], [], rows);
    expect(issues.map((i) => i.issue).sort()).toEqual(["codehub.example/codehub/float-builder#7", `${REPO}#7`]);
  });

  it("an issue worked on by an unpriced session reports null cost and an unpriced session", () => {
    const { issues } = aggregateIssueAttribution([session({ props: null })], [], [issueRow()]);
    expect(issues[0].costUsd).toBeNull();
    expect(issues[0].unpricedSessions).toBe(1);
  });

  it("reconciles: issue costs plus unattributed equal the total priced cost", () => {
    const sessions = [session({ id: "s1" }), session({ id: "s2" }), session({ id: "s3" })];
    const rows = [
      issueRow({ session_id: "s1", ref: `${REPO}#1`, number: 1 }),
      issueRow({ session_id: "s1", ref: `${REPO}#2`, number: 2 }),
      issueRow({ session_id: "s2", ref: `${REPO}#2`, number: 2, role: "referenced" }),
    ];
    const { issues, unattributed } = aggregateIssueAttribution(sessions, [], rows);
    const sum = issues.reduce((acc, i) => acc + (i.costUsd ?? 0), 0) + (unattributed.costUsd ?? 0);
    expect(sum).toBeCloseTo(fullCost() * 3, 6);
    expect(unattributed.sessions).toBe(2);
    expect(issues.find((i) => i.issue === `${REPO}#2`)!.mentions).toBe(1);
  });

  it("sorts by cost descending, ref ascending as the tie-break", () => {
    const rows = [
      issueRow({ session_id: "s1", ref: `${REPO}#3`, number: 3 }),
      issueRow({ session_id: "s2", ref: `${REPO}#1`, number: 1 }),
      issueRow({ session_id: "s2", ref: `${REPO}#2`, number: 2, role: "referenced" }),
    ];
    const { issues } = aggregateIssueAttribution([session({ id: "s1" }), session({ id: "s2" })], [], rows);
    expect(issues.map((i) => i.issue)).toEqual([`${REPO}#1`, `${REPO}#3`, `${REPO}#2`]);
  });
});

describe("groupCommitEventsBySession (#93 — outcome link per session row)", () => {
  it("groups a session's commits and collects its worked_on refs, sorted and deduped", () => {
    const commits = [commit({ sha: "abc1234" }), commit({ sha: "def5678" })];
    const rows = [
      issueRow({ ref: `${REPO}#93`, number: 93, kind: "issue" }),
      issueRow({ ref: `${REPO}#87`, number: 87, kind: "issue" }),
      issueRow({ ref: `${REPO}#93`, number: 93, kind: "merge_request" }),
      issueRow({ ref: `${REPO}#5`, number: 5, role: "referenced" }),
    ];
    const outcome = groupCommitEventsBySession(commits, rows).get("s1")!;
    expect(outcome.issues).toEqual([
      { ref: `${REPO}#87`, kind: "issue" },
      { ref: `${REPO}#93`, kind: "issue" },
      { ref: `${REPO}#93`, kind: "merge_request" },
    ]);
    expect(outcome.commits).toHaveLength(2);
    // F1: identity is (kind, ref) — issue #93 and MR !93 are two entries, each linking by its own kind
    expect(outcome.issues.filter((i) => i.kind === "merge_request")).toHaveLength(1);
  });

  it("a session with commits but no issue rows has empty issues", () => {
    const outcome = groupCommitEventsBySession([commit({ sessionId: "s2" })]).get("s2")!;
    expect(outcome.issues).toEqual([]);
    expect(outcome.commits).toHaveLength(1);
  });

  it("a session with neither is absent — callers fall back to emptySessionOutcome()", () => {
    const bySession = groupCommitEventsBySession([commit({ sessionId: "s1" })]);
    expect(bySession.has("none")).toBe(false);
    expect(bySession.get("none") ?? emptySessionOutcome()).toEqual({ issues: [], commits: [] });
  });
});

// ---- goal 2026-09-26 W4 (P2, D-051): observed shas, turn-share cost split, derived roles ----

describe("parseCommitEvents — a commit sha comes from the action, not the prose", () => {
  const committed = {
    verb: "committed",
    refKind: "commit",
    sha: "d7e5977",
    branch: "15178-5-idempotent-debits",
    subject: "make debit posting idempotent",
    source: "cli",
  };

  it("reads the sha and subject from `props.action` and ignores a different sha narrated later", () => {
    const turns = [
      bashCommit(0, "git commit -am 'make debit posting idempotent'", {
        props: { inputDigest: "git commit -am 'make debit posting idempotent'", action: committed },
      }),
      toolResult(1),
      prose(2, "Committed as 999aaaa."),
    ];
    const [ev] = parseCommitEvents(turns);
    expect(ev.sha).toBe("d7e5977");
    expect(ev.subject).toBe("make debit posting idempotent");
    expect(ev.observed).toBe(true);
    expect(ev.turnIdx).toBe(0);
    expect(ev.truncated).toBe(false);
  });

  it("a chained `git commit && git push` carries `actions`; the committed one yields the event, the push none", () => {
    const pushed = { verb: "pushed", ref: "15178-5-idempotent-debits", refKind: "branch", source: "cli" };
    const turns = [
      bashCommit(0, "git commit -am x && git push", {
        props: { inputDigest: "git commit -am x && git push", action: pushed, actions: [committed, pushed] },
      }),
      toolResult(1),
    ];
    const events = parseCommitEvents(turns);
    expect(events).toHaveLength(1);
    expect(events[0].sha).toBe("d7e5977");
  });

  it("a `git merge` action with no sha yields an unverified event (sha null) without scanning prose", () => {
    const turns = [
      bashCommit(0, "git merge feature", {
        props: { inputDigest: "git merge feature", action: { verb: "committed", refKind: "commit", source: "cli" } },
      }),
      toolResult(1),
      prose(2, "Merged; the commit is 123abcd."),
    ];
    const [ev] = parseCommitEvents(turns);
    expect(ev.sha).toBeNull();
    expect(ev.observed).toBe(true);
  });

  it("falls back to prose scraping only when the turn carries no action (rows imported before W3)", () => {
    const turns = [bashCommit(0, 'git commit -m "old row"'), toolResult(1), prose(2, "Committed as 645208b.")];
    const [ev] = parseCommitEvents(turns);
    expect(ev.sha).toBe("645208b");
    expect(ev.observed).toBe(false);
  });
});

describe("aggregateIssueAttribution — B11 cost splits by turn share and is marked estimated", () => {
  it("a session reviewing two MRs 30/70 by turn count splits its cost 30/70, both marked est.", () => {
    const total = fullCost();
    const rows = [
      issueRow({
        ref: `${REPO}#1`,
        number: 1,
        kind: "merge_request",
        review_verb: "reviewed",
        tier: "observed",
        turn_share: 0.3,
      }),
      issueRow({
        ref: `${REPO}#2`,
        number: 2,
        kind: "merge_request",
        review_verb: "commented",
        tier: "observed",
        turn_share: 0.7,
      }),
    ];
    const res = aggregateIssueAttribution([session({ turn_count: 10 })], [], rows);
    const byRef = Object.fromEntries(res.issues.map((i) => [i.issue, i]));
    expect(byRef[`${REPO}#1`].costUsd).toBeCloseTo(total * 0.3, 9);
    expect(byRef[`${REPO}#2`].costUsd).toBeCloseTo(total * 0.7, 9);
    expect(byRef[`${REPO}#1`].turns).toBe(3);
    expect(byRef[`${REPO}#2`].turns).toBe(7);
    expect(byRef[`${REPO}#1`].estimated).toBe(true);
    expect(byRef[`${REPO}#2`].estimated).toBe(true);
    expect(res.estimated).toBe(true);
    expect(byRef[`${REPO}#1`].reviewVerb).toBe("reviewed");
    expect(byRef[`${REPO}#2`].reviewVerb).toBe("commented");
    // Both touched; the session counts on each ref (per-ref count, not a partition).
    expect([byRef[`${REPO}#1`].sessions, byRef[`${REPO}#2`].sessions]).toEqual([1, 1]);
    expect(res.unattributed.costUsd).toBeNull();
  });

  it("numeric turn_share arrives as a string from Postgres and still splits", () => {
    const total = fullCost();
    const res = aggregateIssueAttribution(
      [session()],
      [],
      [issueRow({ turn_share: "0.5" }), issueRow({ ref: `${REPO}#43`, number: 43, turn_share: "0.5" })],
    );
    expect(res.issues[0].costUsd).toBeCloseTo(total / 2, 9);
  });

  it("v4 items 1+7: a discussion-only ref (no verb) is referenced and carries no cost, whatever its stored share", () => {
    const total = fullCost();
    const res = aggregateIssueAttribution(
      [session()],
      [],
      [issueRow({ ref: `${REPO}#254`, number: 254, role: "discussed", tier: "discussed", turn_share: 1 })],
    );
    expect(res.issues).toHaveLength(1);
    expect(res.issues[0]).toMatchObject({ issue: `${REPO}#254`, role: "referenced", sessions: 0, mentions: 1 });
    expect(res.issues[0].costUsd).toBeNull();
    expect(res.unattributed.costUsd).toBeCloseTo(total, 9);
  });

  it("B2: a model-only ref (discussed, share 0) gets no cost; the session's cost stays unattributed", () => {
    const total = fullCost();
    const res = aggregateIssueAttribution(
      [session()],
      [],
      [issueRow({ ref: `${REPO}#42`, role: "discussed", tier: "discussed", turn_share: 0 })],
    );
    expect(res.issues[0].costUsd).toBeNull();
    expect(res.issues[0].mentions).toBe(1);
    expect(res.unattributed.costUsd).toBeCloseTo(total, 9);
  });

  it("the share no ref claimed stays with the session in unattributed, so totals still reconcile", () => {
    const total = fullCost();
    const res = aggregateIssueAttribution([session()], [], [issueRow({ turn_share: 0.6, build_verb: "committed" })]);
    expect(res.issues[0].costUsd).toBeCloseTo(total * 0.6, 9);
    expect(res.unattributed.costUsd).toBeCloseTo(total * 0.4, 9);
    expect(res.unattributed.sessions).toBe(0);
    expect(res.issues[0].buildVerb).toBe("committed");
  });

  it("rows written before W4 (no turn_share) still split equally across worked_on rows", () => {
    const total = fullCost();
    const res = aggregateIssueAttribution([session()], [], [issueRow(), issueRow({ ref: `${REPO}#43`, number: 43 })]);
    expect(res.issues.map((i) => i.costUsd)).toEqual([total / 2, total / 2].map((n) => Math.round(n * 1e6) / 1e6));
    expect(res.issues[0].estimated).toBe(true);
  });

  it("a session with no refs is unattributed exactly as before", () => {
    const before = aggregateIssueAttribution([session()], [commit({ sha: "abc1234", subject: "x" })], []);
    expect(before.issues).toEqual([]);
    expect(before.unattributed).toMatchObject({
      issue: null,
      sessions: 1,
      mentions: 0,
      turns: 10,
      unpricedSessions: 0,
      role: null,
    });
    expect(before.unattributed.costUsd).toBeCloseTo(fullCost(), 9);
    expect(before.unattributed.commits).toEqual([{ sha: "abc1234", subject: "x", at: "2026-07-10T12:00:01.000Z" }]);
  });

  it("the strongest role and highest verbs across sessions label the ref", () => {
    const res = aggregateIssueAttribution(
      [session({ id: "s1" }), session({ id: "s2" })],
      [],
      [
        issueRow({ session_id: "s1", role: "discussed", tier: "discussed", turn_share: 1, review_verb: "viewed" }),
        issueRow({
          session_id: "s2",
          role: "worked_on",
          tier: "observed",
          turn_share: 1,
          review_verb: "commented",
          build_verb: "edited",
        }),
      ],
    );
    expect(res.issues[0]).toMatchObject({
      role: "worked_on",
      reviewVerb: "commented",
      buildVerb: "edited",
      sessions: 2, // the discussing session touched it too
      mentions: 1,
    });
  });
});

describe("attribution identity is (kind, ref) (F1)", () => {
  it("a glab-style issue #17 and MR !17 sharing the stored ref stay two outcome entries with their own kinds", () => {
    const ref = "codehub.example/acme/billing#17";
    const rows = [
      { session_id: "s", ref, number: 17, kind: "merge_request" as const, role: "worked_on" as const },
      { session_id: "s", ref, number: 17, kind: "issue" as const, role: "worked_on" as const },
    ];
    const outcome = groupCommitEventsBySession([], rows).get("s");
    expect(outcome?.issues).toEqual([
      { ref, kind: "issue" },
      { ref, kind: "merge_request" },
    ]);
  });
});

describe("attribution v3/D-066: a sub-agent's cost follows its own rows, or with none the parent's items", () => {
  const parent = session({
    id: "P",
    source: "claude-code",
    source_session_id: "p-src",
    parent_source_session_id: null,
  } as Partial<AgentStatsSessionInput>);
  const child = (id: string) =>
    session({
      id,
      source: "claude-code",
      source_session_id: `p-src:${id}`,
      parent_source_session_id: "p-src",
    } as Partial<AgentStatsSessionInput>);

  it("D-066: a child with no rows of its own is priced on the parent's items in the parent's proportions", () => {
    const sessions = [parent, child("C")];
    // The parent was focused 60/40 on #1/#2 in its OWN turns.
    const rows = [
      issueRow({ session_id: "P", ref: `${REPO}#1`, number: 1, turn_share: 0.6, tier: "observed" }),
      issueRow({ session_id: "P", ref: `${REPO}#2`, number: 2, turn_share: 0.4, tier: "observed" }),
    ];
    const { issues, unattributed } = aggregateIssueAttribution(
      sessions,
      [commit({ sessionId: "C", sha: "c0ffee1" })],
      rows,
      {
        parentOf: subAgentParents(sessions),
      },
    );
    const one = issues.find((i) => i.issue === `${REPO}#1`)!;
    const two = issues.find((i) => i.issue === `${REPO}#2`)!;
    // Parent AND child each cost fullCost(): 60/40 of both.
    expect(one.costUsd).toBeCloseTo(2 * fullCost() * 0.6, 6);
    expect(two.costUsd).toBeCloseTo(2 * fullCost() * 0.4, 6);
    expect(unattributed.costUsd).toBeNull();
    // The child's ref-less commit stays unattributed: only cost follows the parent's items.
    expect(unattributed.commits.map((c) => c.sha)).toEqual(["c0ffee1"]);
    // The child is still counted as the parent's session, never twice.
    expect(one.sessions).toBe(1);
    expect(unattributed.sessions).toBe(0);
  });

  it("a child whose only row is a share-0 mention is row-less for pricing: it takes the parent's items (D-066)", () => {
    const sessions = [parent, child("C")];
    const rows = [
      issueRow({ session_id: "P", ref: `${REPO}#1`, number: 1, turn_share: 1, tier: "observed" }),
      issueRow({ session_id: "C", ref: `${REPO}#9`, number: 9, role: "referenced", turn_share: 0, tier: "observed" }),
    ];
    const { issues, unattributed } = aggregateIssueAttribution(sessions, [], rows, {
      parentOf: subAgentParents(sessions),
    });
    expect(issues.find((i) => i.issue === `${REPO}#1`)!.costUsd).toBeCloseTo(2 * fullCost(), 6);
    expect(issues.find((i) => i.issue === `${REPO}#9`)!.costUsd).toBeNull();
    expect(unattributed.costUsd).toBeNull();
  });

  it("a child's own worked_on row carries the child's cost to that item", () => {
    const sessions = [parent, child("C")];
    const rows = [
      issueRow({ session_id: "P", ref: `${REPO}#1`, number: 1, turn_share: 1, tier: "observed" }),
      issueRow({
        session_id: "C",
        ref: `${REPO}#5`,
        number: 5,
        build_verb: "committed",
        turn_share: 1,
        tier: "observed",
      }),
    ];
    const { issues, unattributed } = aggregateIssueAttribution(sessions, [], rows, {
      parentOf: subAgentParents(sessions),
    });
    expect(issues.find((i) => i.issue === `${REPO}#5`)!.costUsd).toBeCloseTo(fullCost(), 6);
    expect(issues.find((i) => i.issue === `${REPO}#1`)!.costUsd).toBeCloseTo(fullCost(), 6);
    expect(unattributed.costUsd).toBeNull();
  });
});
