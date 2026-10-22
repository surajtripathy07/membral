// D-053/D-055 adversarial review (2026-09-27): every harness case pinned.
// With MEMBRAL_INFER_REF OFF (the shipped default) no case links wrongly.
// W-cases with inference ON stay known-wrong: D-053 inference stays OFF by
// driver decision, so they are pinned with `it.fails` (the test body asserts
// the correct outcome and is expected to fail until inference is reworked).
import { describe, expect, it } from "vitest";
import { aggregateIssueAttribution, type SessionIssueRow, subAgentParents } from "@/lib/agent-stats/attribution";
import {
  buildProfile,
  type KnownBranchMr,
  knownBranchesFromTurns,
  type ProfileChildSession,
} from "@/lib/code-sessions/profile";
import type { SessionIssueParsed } from "@/lib/memory/schema";
import { computeThreads, type ThreadIssueRow, type ThreadSessionRow } from "../open-threads";
import { at, commit, GH, ground, parse, push, type Step } from "./pivot-transcript";

type Turns = ReturnType<typeof parse>;
type Span = { from_turn: number; to_turn: number };
const iss = (ref: string, quote: string, idxs: number[], span?: Span): SessionIssueParsed => ({
  ref,
  kind: "issue",
  evidence_quote: quote,
  mentions: idxs.map((i) => ({ turn_idx: i, quote })),
  ...(span ? { worked_span: span } : {}),
});
const last = (t: Turns) => t[t.length - 1].idx;
const before = (t: Turns, needle: string) => at(t, needle) - 1;

interface Case {
  name: string;
  steps: Step[];
  branch?: string;
  issues: (t: Turns) => SessionIssueParsed[];
  extra?: { startBranch?: string; knownBranches?: KnownBranchMr[]; childSessions?: ProfileChildSession[] };
  expectNot: { ref: string; kind?: "issue" | "merge_request"; sha?: string }[];
}

/** The harness's check: a wrong build rung (>= committed) or a wrong sha on the named ref. */
function wrongLinks(c: Case, inferRef: boolean): string[] {
  const turns = parse(c.steps, c.branch ?? "main");
  const issues = c.issues(turns);
  const rows = ground(turns, GH, issues, { ...c.extra, inferRef });
  const userRefs = issues.flatMap((i) =>
    (i.mentions ?? []).map((m) => ({
      ref: i.ref,
      refKind: i.kind,
      idx: m.turn_idx,
      ...(i.worked_span && i.worked_span.from_turn === m.turn_idx ? { spanTo: i.worked_span.to_turn } : {}),
    })),
  );
  const prof = buildProfile(turns as never, { userRefs, inferRef, ...c.extra });
  const out: string[] = [];
  for (const e of c.expectNot) {
    const kind = e.kind ?? "issue";
    if (e.sha) {
      const p = prof.refs.find((x) => x.ref.endsWith(e.ref) && x.refKind === kind);
      if (p?.shas.some((s) => s.startsWith(e.sha as string))) out.push(`${e.ref}@${e.sha}`);
    } else {
      const r = rows.find((x) => x.ref.endsWith(e.ref) && x.kind === kind);
      if (r?.build_verb && r.build_verb !== "edited") out.push(`${e.ref}:${r.build_verb}`);
    }
  }
  return out;
}

const s1: Step[] = [
  { user: "For #41 fix the heading level in README" },
  { edit: "README.md" },
  commit("main", "aaaaaa1", "Fix README heading level"),
  { user: "Thanks. Unrelated: bump the lodash pin to 4.17.21 in package.json" },
  { edit: "package.json" },
  commit("main", "bbbbbb2", "Bump lodash to 4.17.21"),
];
const s2: Step[] = [
  { user: "Forget #41 for now, let's first finish this open PR — address the review nit about naming" },
  { edit: "src/ledger.ts" },
  commit("feature-y", "ccccccc", "Rename helper per review"),
  push("feature-y"),
];
const s3: Step[] = [
  { user: "What's the status of #41? Did anyone pick it up?" },
  { bash: "gh issue view 41", out: "title:\tFlaky retry test\nstate:\tOPEN\nnumber:\t41\n--\nRetries flake." },
  { user: "forget that, lets first finish this open PR on feature-y" },
  {
    bash: "git checkout feature-y",
    out: "Switched to branch 'feature-y'\nYour branch is up to date with 'origin/feature-y'.",
  },
  { edit: "src/ledger.ts" },
  commit("feature-y", "ddddddd", "Address review nit"),
  { bash: "git push", out: "To github.com:acme/billing.git\n   1111111..ddddddd  feature-y -> feature-y" },
];
const forkView = (head: string): Step => ({
  bash: "gh pr view 50 --json title,state,headRefName",
  out: `{"headRefName":"${head}","state":"OPEN","title":"Fix typo"}`,
});
const s4 = (head: string): Step[] => [
  { user: "Take a look at the contributor PR 50 and tell me if it is sane" },
  forkView(head),
  { say: "Looks sane." },
  { user: "ok. separately, fix the off-by-one in pager.ts" },
  { edit: "src/pager.ts" },
  commit("main", "eeeeeee", "Fix off-by-one in pager"),
];
const s4later: Step[] = [
  { user: "fix the off-by-one in pager.ts" },
  { edit: "src/pager.ts" },
  commit("main", "9999999", "Fix off-by-one in pager"),
];
const s5 = (checkoutOut: string): Step[] => [
  { bash: "gh pr checkout 50", out: checkoutOut },
  { say: "Checked out." },
  { user: "Actually, for #41 fix the null check — do it in the ~/dev/billing-41 clone" },
  { edit: "src/null.ts" },
  {
    bash: "cd ~/dev/billing-41 && git commit -am 'Fix null check'",
    out: "[fix-41 fffffff] Fix null check\n 1 file changed",
  },
];
const s6: Step[] = [
  { user: "For #41 fix the null check in parser.ts" },
  { edit: "src/parser.ts" },
  { user: "btw someone pinged me about https://github.com/acme/billing/pull/50 — remind me later. Carry on." },
  commit("fix-41", "1111abc", "Fix null check in parser"),
];
const s7: Step[] = [
  { user: "For #41 fix the null check in parser.ts" },
  { edit: "src/parser.ts" },
  commit("main", "2222aaa", "Fix null check"),
  { user: "Now #52: add a log line in pager.ts" },
  { edit: "src/pager.ts" },
  commit("main", "2222bbb", "Log in pager"),
  { user: "Back to #41: also handle the empty string case" },
  { edit: "src/parser.ts" },
  commit("main", "2222ccc", "Handle empty string"),
];
const s9: Step[] = [
  { user: "#41 is a dup of #52, so just fix #52: trim the header" },
  { edit: "src/h.ts" },
  commit("main", "3333aaa", "Trim header"),
];
const s10: Step[] = [
  { user: 'My manager wrote: "can someone look at #41 when free". Not now. Please fix the lint errors in pager.ts' },
  { edit: "src/pager.ts" },
  commit("main", "4444aaa", "Fix lint"),
];
const s11: Step[] = [
  { user: "For #41 fix the null check in parser.ts" },
  { say: "Spawning a helper." },
  { user: "Meanwhile, #52: add a log line in pager.ts" },
  { edit: "src/pager.ts" },
  commit("main", "5555bbb", "Log in pager"),
];
const s1d: Step[] = [
  { user: "For #41 fix the heading level in README, commit locally, don't push yet" },
  { edit: "README.md" },
  commit("main", "aaaaaa1", "Fix README heading level"),
  { user: "Thanks. Unrelated: on a new branch bump the lodash pin and push it" },
  { bash: "git checkout -b bump-lodash", out: "Switched to a new branch 'bump-lodash'" },
  { edit: "package.json" },
  commit("bump-lodash", "bbbbbb2", "Bump lodash"),
  push("bump-lodash"),
];
const earlierForkMain = [
  {
    props: {
      action: {
        verb: "viewed",
        ref: "acme/billing#50",
        refKind: "merge_request",
        branch: "main",
        source: "cli",
        state: "opened",
      },
    },
  },
];
const childTurns = [
  { idx: 0, role: "user", kind: "prose", props: {} },
  {
    idx: 1,
    role: "assistant",
    kind: "tool_use",
    tool_name: "Bash",
    props: {
      action: { verb: "committed", refKind: "commit", ref: "5555aaa", sha: "5555aaa", branch: "main", source: "cli" },
    },
  },
];
const q41 = "For #41 fix the heading level in README";

/** Harness cases; `onWrong` names the review finding still wrong with inference ON. */
const CASES: Array<Case & { onWrong?: string }> = [
  {
    name: "S1 main, unnamed pivot, no span",
    onWrong: "W3",
    steps: s1,
    issues: (t) => [iss("#41", q41, [at(t, "For #41")])],
    expectNot: [{ ref: "#41", sha: "bbbbbb2" }],
  },
  {
    name: "S1b span cut correctly",
    onWrong: "W1",
    steps: s1,
    issues: (t) => [
      iss("#41", q41, [at(t, "For #41")], { from_turn: at(t, "For #41"), to_turn: before(t, "Unrelated") }),
    ],
    expectNot: [{ ref: "#41", sha: "bbbbbb2" }],
  },
  {
    name: "S8 span too wide",
    onWrong: "W6",
    steps: s1,
    issues: (t) => [iss("#41", q41, [at(t, "For #41")], { from_turn: at(t, "For #41"), to_turn: last(t) })],
    expectNot: [{ ref: "#41", sha: "bbbbbb2" }],
  },
  {
    name: "S2 'Forget #41 … finish this open PR' as a mention",
    onWrong: "W6",
    steps: s2,
    branch: "feature-y",
    issues: (t) => [iss("#41", "Forget #41 for now", [at(t, "Forget #41")])],
    extra: { startBranch: "feature-y" },
    expectNot: [{ ref: "#41" }],
  },
  {
    name: "S3 status of #41, 'forget that', git checkout feature-y",
    onWrong: "W3",
    steps: s3,
    issues: (t) => [iss("#41", "What's the status of #41?", [at(t, "status of #41")])],
    extra: { startBranch: "main" },
    expectNot: [{ ref: "#41" }],
  },
  {
    name: "S3b same, startBranch feature-y",
    onWrong: "W3",
    steps: s3,
    branch: "feature-y",
    issues: (t) => [iss("#41", "What's the status of #41?", [at(t, "status of #41")])],
    extra: { startBranch: "feature-y" },
    expectNot: [{ ref: "#41" }],
  },
  {
    name: "S4 fork PR head=main, own fix on main (L1)",
    steps: s4("main"),
    issues: () => [],
    expectNot: [{ ref: "#50", kind: "merge_request" }],
  },
  {
    name: "S4v control: fork PR head=contrib-typo",
    steps: s4("contrib-typo"),
    issues: () => [],
    expectNot: [{ ref: "#50", kind: "merge_request" }],
  },
  {
    name: "S4c cross-session: earlier view of fork PR 50 head main (L1)",
    steps: s4later,
    issues: () => [],
    extra: { knownBranches: knownBranchesFromTurns(earlierForkMain), startBranch: "main" },
    expectNot: [{ ref: "#50", kind: "merge_request" }],
  },
  {
    name: "S5 gh pr checkout 50, #41 commit in another clone (W5)",
    steps: s5("Switched to a new branch 'contrib-typo'"),
    issues: (t) => [iss("#41", "for #41 fix the null check", [at(t, "for #41")])],
    expectNot: [{ ref: "#50", kind: "merge_request" }],
  },
  {
    name: "S5u same, checkout output not captured (branch unknown) (W5)",
    steps: s5(""),
    issues: (t) => [iss("#41", "for #41 fix the null check", [at(t, "for #41")])],
    expectNot: [{ ref: "#50", kind: "merge_request" }],
  },
  {
    name: "S6 pasted PR URL after naming #41 (L2)",
    steps: s6,
    issues: (t) => [iss("#41", "For #41 fix the null check in parser.ts", [at(t, "For #41")])],
    expectNot: [{ ref: "#50", kind: "merge_request" }],
  },
  {
    name: "S7 return to #41 (span only first stretch)",
    onWrong: "W2",
    steps: s7,
    issues: (t) => [
      iss("#41", "For #41 fix the null check in parser.ts", [at(t, "For #41")], {
        from_turn: at(t, "For #41"),
        to_turn: before(t, "Now #52"),
      }),
      iss("#41", "Back to #41: also handle the empty string case", [at(t, "Back to #41")]),
      iss("#52", "Now #52: add a log line in pager.ts", [at(t, "Now #52")]),
    ],
    expectNot: [
      { ref: "#41", sha: "2222bbb" },
      { ref: "#52", sha: "2222ccc" },
      { ref: "#52", sha: "2222aaa" },
    ],
  },
  {
    name: "S9 two refs in one prompt, #52 mention only",
    steps: s9,
    issues: (t) => [iss("#52", "so just fix #52: trim the header", [at(t, "fix #52")])],
    expectNot: [{ ref: "#41" }],
  },
  {
    name: "S10 pasted manager text naming #41",
    onWrong: "W6",
    steps: s10,
    issues: (t) => [iss("#41", "can someone look at #41 when free", [at(t, "manager")])],
    expectNot: [{ ref: "#41" }],
  },
  {
    name: "S11 unanchored child commit lands after #52 naming",
    onWrong: "W7",
    steps: s11,
    issues: (t) => [
      iss("#41", "For #41 fix the null check in parser.ts", [at(t, "For #41")]),
      iss("#52", "#52: add a log line in pager.ts", [at(t, "#52")]),
    ],
    extra: { childSessions: [{ id: "child", spawnToolUseId: null, turns: childTurns }] },
    expectNot: [{ ref: "#52", sha: "5555aaa" }],
  },
  {
    name: "S1d span cut; unrelated branch commit+push",
    onWrong: "W1",
    steps: s1d,
    issues: (t) => [iss("#41", q41, [at(t, "For #41")], { from_turn: at(t, "For #41"), to_turn: at(t, "Thanks") - 1 })],
    expectNot: [{ ref: "#41", sha: "bbbbbb2" }],
  },
];

describe("D-053 review harness — inference OFF (shipped default): no wrong link", () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(wrongLinks(c, false)).toEqual([]);
    });
  }
});

describe("D-053 review harness — inference ON", () => {
  for (const c of CASES) {
    if (c.onWrong) {
      it.fails(`${c.name} — KNOWN WRONG (${c.onWrong}); D-053 stays off, not fixed`, () => {
        expect(wrongLinks(c, true)).toEqual([]);
      });
    } else {
      it(c.name, () => {
        expect(wrongLinks(c, true)).toEqual([]);
      });
    }
  }
});

describe("L1/L3: cross-session branch → MR mappings", () => {
  const view = (ref: string, branch: string) => ({
    props: { action: { verb: "viewed", ref, refKind: "merge_request", branch, source: "cli", state: "opened" } },
  });
  it("the default branch never maps (main, master, the project's default)", () => {
    expect(
      knownBranchesFromTurns([view("#1", "main"), view("#2", "master"), view("#3", "develop")], {
        defaultBranch: "develop",
      }),
    ).toEqual([]);
  });
  it("a mapping needs a fresh turn; stale turns can still conflict or close it", () => {
    expect(knownBranchesFromTurns([{ ...view("#5", "feat"), fresh: false }])).toEqual([]);
    expect(knownBranchesFromTurns([{ ...view("#4", "feat"), fresh: false }, view("#5", "feat")])).toEqual([]);
    const merged = {
      fresh: false,
      props: { action: { verb: "merged", ref: "#5", refKind: "merge_request", source: "cli" } },
    };
    expect(knownBranchesFromTurns([merged, view("#5", "feat")])).toEqual([]);
    expect(knownBranchesFromTurns([view("#5", "feat")])).toEqual([
      { branch: "feat", ref: "#5", refKind: "merge_request" },
    ]);
  });
  it("a branch memory_branch_state saw merged or gone never maps", () => {
    expect(knownBranchesFromTurns([view("#5", "feat")], { deadBranches: ["feat"] })).toEqual([]);
  });
});

describe("W5: an MR checkout's branch", () => {
  it("a commit on the checked-out branch builds the MR", () => {
    const turns = parse([
      { bash: "gh pr checkout 50", out: "Switched to a new branch 'contrib-typo'" },
      { edit: "src/a.ts" },
      commit("contrib-typo", "abcdef1", "Fix"),
    ]);
    const rows = ground(turns, GH, [], { inferRef: false });
    expect(rows.find((r) => r.kind === "merge_request")?.build_verb).toBe("committed");
  });
});

describe("W4: a delivery that reached a ref through prose is inferred even when the ref was viewed", () => {
  it("view #41, then 'For #41 …', commit on main → inferred_ref", () => {
    const turns = parse([
      { user: "What's the status of #41?" },
      { bash: "gh issue view 41", out: "title:\tFlaky\nstate:\tOPEN\nnumber:\t41\n--\nx" },
      { user: "OK, for #41 fix the null check in parser.ts" },
      { edit: "src/parser.ts" },
      commit("main", "7777aaa", "Fix null check"),
    ]);
    const mention = at(turns, "for #41");
    const rows = ground(turns, GH, [iss("#41", "for #41 fix the null check", [mention])], { inferRef: true });
    const r = rows.find((x) => x.ref === `${GH}#41`);
    expect([r?.build_verb, r?.tier]).toEqual(["committed", "inferred_ref"]);
  });
});

describe("child cost never vanishes", () => {
  const REF = "codehub.example/acme/billing#41";
  it("threads: a child with no row of its own is priced at the parent's share", () => {
    const sess = (id: string, extra: Partial<ThreadSessionRow>): ThreadSessionRow => ({
      id,
      code_project_id: "p1",
      started_at: "2026-09-26T22:00:00Z",
      git_branch: "main",
      turn_count: 10,
      parent_source_session_id: null,
      source: "claude-code",
      source_session_id: `${id}-src`,
      cost_usd: 1,
      ...extra,
    });
    const row: ThreadIssueRow = {
      session_id: "P",
      ref: REF,
      number: 41,
      // v4 B1: only PR/branch evidence prices — the priced row is an MR.
      kind: "merge_request",
      role: "worked_on",
      evidence_quote: "x",
      turn_idx: 0,
      review_verb: null,
      build_verb: "committed",
      tier: "observed",
      turn_share: 0.5,
      related_to: [],
    };
    const res = computeThreads(
      { issues: [row], sessions: [sess("P", {}), sess("C", { parent_source_session_id: "P-src", cost_usd: 2 })] },
      { now: new Date("2026-09-27T00:00:00Z") },
    );
    // parent 1 x 0.5 + child 2 x 0.5
    expect(res.recent[0].cost_est_total).toBeCloseTo(1.5, 6);
  });

  it("agent-stats: items + unattributed = total including children", () => {
    const USAGE = {
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    };
    const sessions = [
      { id: "P", source: "claude-code", source_session_id: "p-src", parent_source_session_id: null },
      { id: "C", source: "claude-code", source_session_id: "p-src:a", parent_source_session_id: "p-src" },
      { id: "Q", source: "claude-code", source_session_id: "q-src", parent_source_session_id: null },
    ].map((s) => ({
      ...s,
      started_at: "2026-09-26T22:00:00Z",
      turn_count: 10,
      user_turn_count: 1,
      props: { usage: USAGE, models: ["claude-sonnet-5"] },
    }));
    const rows: SessionIssueRow[] = [
      {
        session_id: "P",
        ref: REF,
        number: 41,
        kind: "merge_request",
        role: "worked_on",
        build_verb: "committed",
        tier: "observed",
        turn_share: 0.6,
      },
    ];
    const agg = aggregateIssueAttribution(sessions, [], rows, { parentOf: subAgentParents(sessions) });
    const all = aggregateIssueAttribution(sessions, [], [], {});
    const items = agg.issues.reduce((sum, i) => sum + (i.costUsd ?? 0), 0);
    expect(items + (agg.unattributed.costUsd ?? 0)).toBeCloseTo(all.unattributed.costUsd ?? 0, 4);
    expect(items).toBeGreaterThan(0);
  });
});
