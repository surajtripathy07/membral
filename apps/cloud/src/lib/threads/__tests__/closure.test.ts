// G2 step 2.5: the closure detectors moved out of computeThreads. Each table
// drives one detector directly with the context computeThreads builds; the
// order test pins "strongest evidence first".
import { describe, expect, it } from "vitest";
import type { ReflessResolver } from "@/lib/code-sessions/profile";
import { DEFAULT_REFLESS_RESOLVER } from "@/lib/code-sessions/profile";
import {
  CLOSURE_DETECTORS,
  type ClosureContext,
  closureFromActions,
  closureFromBranchState,
  closureFromRowRung,
  cmpPos,
} from "@/lib/threads/closure";
import type { FoldedRow, ObservedAction, Pos, ThreadSessionRow } from "@/lib/threads/open-threads";

const REF = "github.com/acme/app#7";
const PROJECT = "p1";
const T0 = Date.parse("2026-09-01T10:00:00Z");
const pos = (min: number, sid = "s1", idx = 0): Pos => ({ t: T0 + min * 60_000, sid, idx });
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString();

const session = (id: string, startMin = 0): ThreadSessionRow => ({
  id,
  code_project_id: PROJECT,
  started_at: iso(startMin),
  git_branch: "feat-7",
  turn_count: 10,
  cost_usd: null,
});

const act = (a: ObservedAction, min: number, sid = "s1", idx = 0, owner = sid) => ({
  session_id: sid,
  owner,
  idx,
  pos: pos(min, sid, idx),
  a,
});

const foldedRow = (owner: string, build_verb: FoldedRow["build_verb"], turn_idx = 3): FoldedRow =>
  ({
    owner,
    proof: { session_id: owner, turn_idx },
    all: [],
    role: "owner",
    review_verb: null,
    build_verb,
    observed: true,
    inferredRef: false,
  }) as unknown as FoldedRow;

function ctx(over: Partial<ClosureContext> = {}): ClosureContext {
  const lastReopen = over.lastReopen ?? null;
  const keyFor = (s: ThreadSessionRow, branch: string) => `${s.code_project_id ?? ""}\n${branch}`;
  return {
    actions: [],
    lastBuild: null,
    lastReopen,
    beforeReopen: (p: Pos) => !!lastReopen && cmpPos(p, lastReopen) < 0,
    sessions: new Map([["s1", session("s1")]]),
    namesThread: (x) => x.a.ref === REF,
    buildSessions: new Set(["s1"]),
    branchKeys: new Set([`${PROJECT}\nfeat-7`]),
    keyFor,
    rows: [],
    branchState: [],
    newestSha: new Map(),
    namedShas: new Map(),
    supersededShas: new Map(),
    ...over,
  };
}

describe("CLOSURE_DETECTORS", () => {
  it("runs the detectors strongest first, in the original computeThreads order", () => {
    expect(CLOSURE_DETECTORS.map((d) => d.name)).toEqual([
      "closureFromActions",
      "closureFromRowRung",
      "closureFromBranchState",
    ]);
  });
});

describe("closureFromActions", () => {
  const merged = act({ verb: "merged", ref: REF, refKind: "pull_request" }, 20, "s1", 5);
  const cases: [string, Partial<ClosureContext>, ReturnType<typeof closureFromActions>][] = [
    [
      "merged on the ref after the last build closes",
      { actions: [merged], lastBuild: pos(10) },
      { kind: "action", session_id: "s1", turn_idx: 5, verb: "merged" },
    ],
    [
      "forge state word counts as the verb",
      { actions: [act({ verb: "viewed", state: "closed", ref: REF }, 20, "s1", 6)] },
      { kind: "action", session_id: "s1", turn_idx: 6, verb: "closed" },
    ],
    [
      "branch deletion on one of the thread's branches closes",
      { actions: [act({ verb: "closed", ref: "feat-7", refKind: "branch" }, 20, "s1", 7)] },
      { kind: "action", session_id: "s1", turn_idx: 7, verb: "closed" },
    ],
    ["a close before the last build does not count", { actions: [merged], lastBuild: pos(30) }, null],
    ["a close on another ref does not count", { actions: [act({ verb: "merged", ref: "other#1" }, 20)] }, null],
    ["a reopen after the close voids it", { actions: [merged], lastReopen: pos(40) }, null],
    [
      "a child that did not build proves nothing about branches",
      {
        actions: [act({ verb: "closed", ref: "feat-7", refKind: "branch" }, 20, "c1", 1, "s1")],
        sessions: new Map([
          ["s1", session("s1")],
          ["c1", session("c1")],
        ]),
      },
      null,
    ],
  ];
  it.each(cases)("%s", (_name, over, want) => {
    expect(closureFromActions(ctx(over))).toEqual(want);
  });
});

describe("closureFromRowRung", () => {
  const sessions = new Map([
    ["s1", session("s1", 0)],
    ["s2", session("s2", 60)],
  ]);
  const cases: [string, Partial<ClosureContext>, ReturnType<typeof closureFromRowRung>][] = [
    [
      "the latest build session's merged rung closes",
      { sessions, rows: [foldedRow("s1", "committed"), foldedRow("s2", "merged", 9)] },
      { kind: "action", session_id: "s2", turn_idx: 9, verb: "merged" },
    ],
    [
      "a commit after a close reopens the question",
      { sessions, rows: [foldedRow("s1", "closed"), foldedRow("s2", "committed")] },
      null,
    ],
    ["no build row at all", { sessions, rows: [foldedRow("s1", null)] }, null],
    [
      "a reopen at or after the session start voids the rung",
      { sessions, rows: [foldedRow("s2", "merged")], lastReopen: pos(60) },
      null,
    ],
    [
      "a reopen before the session start leaves the rung",
      { sessions, rows: [foldedRow("s2", "closed", 4)], lastReopen: pos(30) },
      { kind: "action", session_id: "s2", turn_idx: 4, verb: "closed" },
    ],
  ];
  it.each(cases)("%s", (_name, over, want) => {
    expect(closureFromRowRung(ctx(over))).toEqual(want);
  });
});

describe("closureFromBranchState", () => {
  const k = `${PROJECT}\nfeat-7`;
  const bs = (over: Partial<ClosureContext["branchState"][number]> = {}) => ({
    code_project_id: PROJECT,
    branch: "feat-7",
    last_seen_sha: "abc1234",
    merged_into: "main",
    merged_at: iso(50),
    branch_gone_at: null,
    ...over,
  });
  const shas = { newestSha: new Map([[k, "abc1234def"]]), namedShas: new Map([[k, ["abc1234def"]]]) };
  const cases: [string, Partial<ClosureContext>, ReturnType<typeof closureFromBranchState>][] = [
    [
      "merged at the newest named sha closes",
      { branchState: [bs()], ...shas },
      {
        kind: "branch_state",
        code_project_id: PROJECT,
        branch: "feat-7",
        merged_into: "main",
        merged_at: iso(50),
        branch_gone_at: null,
      },
    ],
    [
      "branch gone at any named sha closes",
      {
        branchState: [bs({ merged_at: null, merged_into: null, branch_gone_at: iso(50) })],
        newestSha: new Map([[k, "fff9999"]]),
        namedShas: new Map([[k, ["abc1234def", "fff9999"]]]),
      },
      {
        kind: "branch_state",
        code_project_id: PROJECT,
        branch: "feat-7",
        merged_into: null,
        merged_at: null,
        branch_gone_at: iso(50),
      },
    ],
    [
      "someone else's sha on a reused branch proves nothing",
      { branchState: [bs({ last_seen_sha: "999" })], ...shas },
      null,
    ],
    [
      "a superseded sha proves nothing",
      { branchState: [bs()], ...shas, supersededShas: new Map([[k, new Set(["abc1234def"])]]) },
      null,
    ],
    ["a branch not on the thread proves nothing", { branchState: [bs({ branch: "other" })], ...shas }, null],
    ["a reopen after the proof time voids it", { branchState: [bs()], ...shas, lastReopen: pos(55) }, null],
  ];
  it.each(cases)("%s", (_name, over, want) => {
    expect(closureFromBranchState(ctx(over))).toEqual(want);
  });
});

describe("DEFAULT_REFLESS_RESOLVER", () => {
  it("is typed as a ReflessResolver", () => {
    const r: ReflessResolver = DEFAULT_REFLESS_RESOLVER;
    expect(typeof r).toBe("function");
  });
});
