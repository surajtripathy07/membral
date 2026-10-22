// D-066 (clarifies D-056): one pricing rule for sub-agent children with no rows of their own,
// shared by the Issues view (aggregateIssueAttribution) and Today (computeThreads).
import { describe, expect, it } from "vitest";
import { computeThreads, type ThreadIssueRow, type ThreadSessionRow } from "@/lib/threads/open-threads";
import type { AgentStatsSessionInput } from "../aggregate";
import { aggregateIssueAttribution, type CommitEvent, type SessionIssueRow, subAgentParents } from "../attribution";
import { childCostOnItem, costParentOf, rowlessChildrenByCostParent } from "../child-pricing";

describe("child-pricing rule (table)", () => {
  // child -> parent; `rows` = sessions holding at least one row that prices under D-056.
  const cases: { name: string; parentOf: [string, string][]; rows: string[]; child: string; want: string | null }[] = [
    {
      name: "child with rows of its own is priced by them",
      parentOf: [["C", "P"]],
      rows: ["P", "C"],
      child: "C",
      want: null,
    },
    { name: "row-less child with a priced parent", parentOf: [["C", "P"]], rows: ["P"], child: "C", want: "P" },
    { name: "row-less child of a parent with no rows", parentOf: [["C", "P"]], rows: [], child: "C", want: null },
    {
      name: "nested: grandchild priced on the grandparent",
      parentOf: [
        ["G", "C"],
        ["C", "P"],
      ],
      rows: ["P"],
      child: "G",
      want: "P",
    },
    {
      name: "nested: nearest ancestor with rows wins",
      parentOf: [
        ["G", "C"],
        ["C", "P"],
      ],
      rows: ["P", "C"],
      child: "G",
      want: "C",
    },
    {
      name: "child whose only rows are discussed/mention rows is row-less for pricing (rows = priced sessions)",
      parentOf: [["C", "P"]],
      rows: ["P"],
      child: "C",
      want: "P",
    },
    { name: "a session that is not a child", parentOf: [], rows: ["P"], child: "X", want: null },
    {
      name: "a parent cycle terminates unpriced",
      parentOf: [
        ["A", "B"],
        ["B", "A"],
      ],
      rows: [],
      child: "A",
      want: null,
    },
  ];
  for (const c of cases) {
    it(c.name, () => {
      const has = (id: string) => c.rows.includes(id);
      const parentOf = new Map(c.parentOf);
      expect(costParentOf(c.child, parentOf, has)).toBe(c.want);
      const grouped = rowlessChildrenByCostParent([c.child], parentOf, has);
      expect(grouped.get(c.want ?? "")?.includes(c.child) ?? false).toBe(c.want !== null);
    });
  }

  it("prices only on a positive parent share", () => {
    expect(childCostOnItem(10, 0.6)).toBeCloseTo(6, 9);
    expect(childCostOnItem(10, 0)).toBe(0);
  });
});

describe("Today and Issues price a row-less child identically", () => {
  const REPO = "codehub.example/acme/billing";
  const USAGE = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  type LinkedSession = AgentStatsSessionInput & {
    source?: string | null;
    source_session_id?: string | null;
    parent_source_session_id?: string | null;
  };
  const statsSession = (id: string, extra: Partial<LinkedSession> = {}): LinkedSession => ({
    id,
    started_at: "2026-09-20T09:00:00.000Z",
    turn_count: 10,
    user_turn_count: 4,
    props: { usage: USAGE, models: ["claude-sonnet-5"] },
    ...extra,
  });
  const link = (id: string, parentSrc: string | null) => ({
    source: "claude-code",
    source_session_id: `src-${id}`,
    parent_source_session_id: parentSrc,
  });

  it("per-item totals match for one fixture (row-less, discussed-only, nested and middle-child cases)", () => {
    // Issues cost comes from usage; read the per-session figure off the same function.
    const unit = aggregateIssueAttribution([statsSession("x")], [], []).unattributed.costUsd ?? 0;
    expect(unit).toBeGreaterThan(0);
    const mrRow = (session_id: string, n: number, share: number): SessionIssueRow => ({
      session_id,
      ref: `${REPO}#${n}`,
      number: n,
      kind: "merge_request",
      role: "worked_on",
      build_verb: "committed",
      tier: "observed",
      turn_share: share,
    });
    const mention: SessionIssueRow = {
      session_id: "D",
      ref: `${REPO}#1`,
      number: 1,
      kind: "merge_request",
      role: "discussed",
      tier: "discussed",
      turn_share: 0,
    };
    const rows = [mrRow("P", 1, 0.6), mrRow("P", 2, 0.4), mrRow("M", 3, 1), mention];
    const sessions = [
      statsSession("D", link("D", "src-P")), // only a discussed row: row-less for pricing
      statsSession("M", link("M", "src-P")), // middle child with a priced row of its own
      statsSession("GC", link("GC", "src-M")), // row-less grandchild of M
      statsSession("P", link("P", null)),
      statsSession("C", link("C", "src-P")),
      statsSession("G", link("G", "src-C")), // nested
      statsSession("Q", link("Q", null)), // evidence-less parent
      statsSession("QC", link("QC", "src-Q")),
    ];
    const issuesView = aggregateIssueAttribution(sessions, [], rows, { parentOf: subAgentParents(sessions) });

    const tSessions: ThreadSessionRow[] = sessions.map((s) => ({
      id: s.id,
      code_project_id: "proj-1",
      started_at: s.started_at,
      git_branch: null,
      turn_count: 10,
      cost_usd: unit,
      source: s.source,
      source_session_id: s.source_session_id,
      parent_source_session_id: s.parent_source_session_id,
    }));
    const tIssues: ThreadIssueRow[] = rows.map((r) => ({
      ...r,
      evidence_quote: "q",
      turn_idx: 1,
      review_verb: null,
      related_to: [],
    })) as ThreadIssueRow[];
    const today = computeThreads({ issues: tIssues, sessions: tSessions, turns: [] });

    // P, C, G, D price on P's 60/40 (4 units); M and GC price on M's own item #3 (2 units).
    for (const [n, units, share] of [
      [1, 4, 0.6],
      [2, 4, 0.4],
      [3, 2, 1],
    ] as const) {
      const iss = issuesView.issues.find((i) => i.issue === `${REPO}#${n}`);
      const thr = today.recent.find((t) => t.ref === `${REPO}#${n}`);
      // Q and QC have no evidence, so they price nothing.
      expect(iss?.costUsd).toBeCloseTo(units * unit * share, 6);
      expect(thr?.cost_est_total).toBeCloseTo(units * unit * share, 6);
    }
    // Issues reconcile: Q and QC stay unattributed, whole.
    expect(issuesView.unattributed.costUsd).toBeCloseTo(2 * unit, 6);
  });
});

describe("D-066 review fixes: own rows keep sessions and commits; chains count as their root", () => {
  const REPO = "codehub.example/codehub/parade-planner";
  const USAGE = { inputTokens: 1_000_000, outputTokens: 500_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  type L = AgentStatsSessionInput & {
    source?: string | null;
    source_session_id?: string | null;
    parent_source_session_id?: string | null;
  };
  const sess = (id: string, parentSrc: string | null): L => ({
    id,
    started_at: "2026-07-10T12:00:00.000Z",
    turn_count: 10,
    user_turn_count: 4,
    props: { usage: USAGE, models: ["claude-sonnet-5"] },
    source: "claude-code",
    source_session_id: `src-${id}`,
    parent_source_session_id: parentSrc,
  });
  const mr = (session_id: string, n: number, share = 1): SessionIssueRow => ({
    session_id,
    ref: `${REPO}#${n}`,
    number: n,
    kind: "merge_request",
    role: "worked_on",
    build_verb: "committed",
    tier: "observed",
    turn_share: share,
  });
  const unitCost = () => aggregateIssueAttribution([sess("x", null)], [], []).unattributed.costUsd ?? 0;

  it("F1: a child's own issue-kind worked_on row keeps its session count and commit when the parent is priced", () => {
    const sessions = [sess("P", null), sess("C", "src-P")];
    const rows: SessionIssueRow[] = [
      mr("P", 1),
      {
        session_id: "C",
        ref: `${REPO}#5`,
        number: 5,
        kind: "issue",
        role: "worked_on",
        build_verb: "committed",
        tier: "observed",
        turn_share: 1,
      },
    ];
    const commits: CommitEvent[] = [
      {
        sha: "c5c5c5c",
        observed: false,
        turnIdx: 0,
        message: "m",
        subject: "fix: codehub/parade-planner#5 thing",
        sessionId: "C",
        at: "2026-07-10T12:00:01.000Z",
        truncated: false,
      },
    ];
    const r = aggregateIssueAttribution(sessions, commits, rows, { parentOf: subAgentParents(sessions) });
    const five = r.issues.find((i) => i.issue === `${REPO}#5`);
    expect(five?.sessions).toBe(1);
    expect(five?.commits.map((c) => c.sha)).toEqual(["c5c5c5c"]);
    expect(r.unattributed.commits).toEqual([]);
    // The issue row never prices (D-056); the child's cost goes to the parent's MR.
    expect(five?.costUsd).toBeNull();
    expect(r.issues.find((i) => i.issue === `${REPO}#1`)?.costUsd).toBeCloseTo(2 * unitCost(), 6);
  });

  it("F2/F3: chains count as their root in both views; a grandchild-only item is a Today thread proven on the grandchild", () => {
    // P -> M(own #3) -> GC (row-less);  P -> C (row-less) -> G(own #7);  P holds #1.
    const sessions = [sess("P", null), sess("M", "src-P"), sess("GC", "src-M"), sess("C", "src-P"), sess("G", "src-C")];
    const rows = [mr("P", 1), mr("M", 3), mr("G", 7)];
    const unit = unitCost();
    const issuesView = aggregateIssueAttribution(sessions, [], rows, { parentOf: subAgentParents(sessions) });
    const tSessions: ThreadSessionRow[] = sessions.map((x) => ({
      id: x.id,
      code_project_id: "proj-1",
      started_at: x.started_at,
      git_branch: null,
      turn_count: 10,
      cost_usd: unit,
      source: x.source,
      source_session_id: x.source_session_id,
      parent_source_session_id: x.parent_source_session_id,
    }));
    const tIssues = rows.map((r) => ({
      ...r,
      evidence_quote: "q",
      turn_idx: 1,
      review_verb: null,
      related_to: [],
    })) as ThreadIssueRow[];
    const today = computeThreads({ issues: tIssues, sessions: tSessions, turns: [] });

    for (const [n, units] of [
      [1, 2], // P + row-less C
      [3, 2], // M + row-less GC
      [7, 1], // G on its own row
    ] as const) {
      const iss = issuesView.issues.find((i) => i.issue === `${REPO}#${n}`);
      const thr = today.recent.find((t) => t.ref === `${REPO}#${n}`);
      expect(thr, `Today thread #${n}`).toBeDefined();
      expect(iss?.costUsd).toBeCloseTo(units * unit, 6);
      expect(thr?.cost_est_total).toBeCloseTo(units * unit, 6);
      // One chain is one session, the chain root, in both views.
      expect(iss?.sessionIds).toEqual(["P"]);
      expect(thr?.sessions.map((s) => s.id)).toEqual(["P"]);
    }
    const seven = today.recent.find((t) => t.ref === `${REPO}#7`);
    expect(seven?.sessions[0].proof_session_id).toBe("G");
    expect(seven?.sessions[0].turn_idx).toBe(1);
  });
});
