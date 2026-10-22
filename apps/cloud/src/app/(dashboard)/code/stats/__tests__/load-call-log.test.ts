// G3 step 3D-4 LOCK: the data-loading sequence in page.tsx / load.ts must run
// its awaits in the same order, with the same `.catch` handlers, before and
// after the sequence is moved into a named loader. This records every
// data-access call (module export + args) in call order and snapshots it.
// Two scenarios: a happy path, and one where a call with an explicit `.catch`
// rejects (getSessionTitles).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatsAggregate, AgentStatsSessionInput } from "@/lib/agent-stats/aggregate";
import type { AttributionTurnInput, SessionIssueRow } from "@/lib/agent-stats/attribution";
import type { RecentSessionForStatsRow } from "@/lib/code-sessions/queries";

// A fixed clock: page.tsx derives `since`/`priorSince` from Date.now(), which
// would otherwise make the call-log snapshot (it carries their ISO strings)
// flake on wall-clock time.
const FIXED_NOW = new Date("2026-09-28T05:55:05.736Z");

/** The stub only ever sets `by_model`/`totals` (a subset of each's fields) --
 * `Partial<AgentStatsAggregate>` alone doesn't loosen nested `totals`. */
type StubAggregate = Partial<Omit<AgentStatsAggregate, "totals">> & {
  totals: Partial<AgentStatsAggregate["totals"]>;
};

/** `<name>`: the ordered `[moduleExport, args]` call log, byte-identical across a pure move. */
async function expectCallLog(calls: readonly [string, unknown[]][], name: string): Promise<void> {
  await expect(`${JSON.stringify(calls, null, 2)}\n`).toMatchFileSnapshot(name);
}

const { calls, state, record } = vi.hoisted(() => {
  const calls: [string, unknown[]][] = [];
  const state = {
    userId: "user-1",
    windowRows: [] as AgentStatsSessionInput[],
    prevRows: [] as AgentStatsSessionInput[],
    windowCallCount: 0,
    issueRows: [] as Array<SessionIssueRow & { id: string }>,
    recentSessions: [] as Partial<RecentSessionForStatsRow>[],
    turnsForOutcomes: [] as AttributionTurnInput[],
    titles: new Map<string, unknown>(),
    titlesReject: false,
    aggregate: {
      by_model: [],
      totals: { sessions: 1, cost_usd: 5, subagent_cost_usd: 0 },
    } as StubAggregate,
  };
  function record(name: string, args: unknown[], value: unknown, reject = false) {
    calls.push([name, args]);
    return reject ? Promise.reject(new Error(`${name} failed`)) : Promise.resolve(value);
  }
  return { calls, state, record };
});

// The served/used block (recall-precision L7) loads on its own client; it is not part of the locked loading sequence.
vi.mock("../served-used-load", () => ({ loadServedUsed: async () => null }));
// Same for the "Membral on Membral" panel (recall-precision W3b).
vi.mock("../dogfood-load", () => ({ loadDogfood: async () => null }));

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => {
    calls.push(["createClient", []]);
    return {
      auth: {
        getUser: async () => {
          calls.push(["supabase.auth.getUser", []]);
          return { data: { user: { id: state.userId } } };
        },
      },
    };
  },
}));

vi.mock("@/lib/util/pagination", () => ({
  selectAllSessionsByKeyset: (_makePage: unknown) => {
    state.windowCallCount += 1;
    const rows = state.windowCallCount === 1 ? state.windowRows : state.prevRows;
    return record("selectAllSessionsByKeyset", [state.windowCallCount === 1 ? "window" : "prior"], rows);
  },
  selectAllByIdKeyset: (_makePage: unknown) => record("selectAllByIdKeyset", ["code_session_issues"], state.issueRows),
}));

vi.mock("@/lib/agent-stats/aggregate", () => ({
  aggregateAgentStats: (rows: unknown[], opts: unknown) => {
    calls.push(["aggregateAgentStats", [rows, opts]]);
    return state.aggregate;
  },
}));

vi.mock("@/lib/agent-stats/attribution", () => ({
  emptySessionOutcome: (...args: unknown[]) => {
    calls.push(["emptySessionOutcome", args]);
    return { kind: "empty" };
  },
  groupCommitEventsBySession: (...args: unknown[]) => {
    calls.push(["groupCommitEventsBySession", args]);
    return new Map();
  },
  parseCommitEvents: (...args: unknown[]) => {
    calls.push(["parseCommitEvents", args]);
    return [];
  },
}));

vi.mock("@/lib/code-sessions/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/code-sessions/queries")>()),
  getRecentSessionsForStats: (_supabase: unknown, ...rest: unknown[]) =>
    record("getRecentSessionsForStats", rest, state.recentSessions),
  getSessionTurnsForOutcomes: (_supabase: unknown, ...rest: unknown[]) =>
    record("getSessionTurnsForOutcomes", rest, state.turnsForOutcomes),
}));

vi.mock("@/lib/code-sessions/session-titles", () => ({
  getSessionTitles: (_supabase: unknown, ...rest: unknown[]) =>
    record("getSessionTitles", rest, state.titles, state.titlesReject),
}));

import CodeStatsOverviewPage from "../page";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: FIXED_NOW });
  calls.length = 0;
  state.userId = "user-1";
  state.windowCallCount = 0;
  state.windowRows = [
    { id: "sess-1", started_at: "2026-09-01T00:00:00.000Z", turn_count: 5, user_turn_count: 3, props: {} },
  ];
  state.prevRows = [];
  state.issueRows = [];
  state.recentSessions = [{ id: "sess-1" }, { id: "sess-2" }];
  state.turnsForOutcomes = [];
  state.titles = new Map([["sess-1", { title: "T1" }]]);
  state.titlesReject = false;
  state.aggregate = { by_model: [], totals: { sessions: 1, cost_usd: 5, subagent_cost_usd: 0 } };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("code stats overview page — data-loading call log (G3 3D-4)", () => {
  it("logs every data-access call in order (happy path)", async () => {
    await CodeStatsOverviewPage({ searchParams: Promise.resolve({}) });
    await expectCallLog(calls, "./stats-page-call-log.happy.json");
  });

  it("logs the call order when a .catch path is exercised (getSessionTitles rejects)", async () => {
    state.titlesReject = true;
    await CodeStatsOverviewPage({ searchParams: Promise.resolve({}) });
    await expectCallLog(calls, "./stats-page-call-log.titles-reject.json");
  });
});
