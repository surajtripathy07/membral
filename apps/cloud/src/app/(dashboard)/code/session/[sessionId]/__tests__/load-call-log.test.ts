// G3 step 3D-4 LOCK: the data-loading sequence in page.tsx / load.ts must run
// its awaits in the same order, with the same `.catch` handlers, before and
// after the sequence is moved into a named loader. This records every
// data-access call (module export + args, minus the opaque supabase client
// arg) in call order and snapshots it. Two scenarios: a happy path, and one
// where a call with an explicit `.catch` rejects.
import { beforeEach, describe, expect, it, vi } from "vitest";

/** `<name>`: the ordered `[moduleExport, args]` call log, byte-identical across a pure move. */
async function expectCallLog(calls: readonly [string, unknown[]][], name: string): Promise<void> {
  await expect(`${JSON.stringify(calls, null, 2)}\n`).toMatchFileSnapshot(name);
}

const { calls, state, record } = vi.hoisted(() => {
  const calls: [string, unknown[]][] = [];
  const state = {
    userId: "user-1",
    detail: null as any,
    factsReject: false,
    childrenReject: false,
    issuesData: [] as unknown[],
    issuesError: null as unknown,
    usageRow: null as unknown,
    parentSession: null as unknown,
    childRows: [] as any[],
  };
  function record(name: string, args: unknown[], value: unknown, reject = false) {
    calls.push([name, args]);
    return reject ? Promise.reject(new Error(`${name} failed`)) : Promise.resolve(value);
  }
  return { calls, state, record };
});

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
      from: (table: string) => {
        calls.push(["supabase.from", [table]]);
        const chain: any = {
          select: (cols: string) => {
            calls.push(["supabase.select", [cols]]);
            return chain;
          },
          eq: (col: string, val: unknown) => {
            calls.push(["supabase.eq", [col, val]]);
            return chain;
          },
          // biome-ignore lint/suspicious/noThenProperty: intentional thenable, mirroring supabase-js's own directly-awaitable PostgrestFilterBuilder.
          then: (resolve: (v: unknown) => void, rej?: (e: unknown) => void) =>
            Promise.resolve({ data: state.issuesData, error: state.issuesError }).then(resolve, rej),
        };
        return chain;
      },
    };
  },
}));

vi.mock("@/lib/code-sessions/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/code-sessions/queries")>()),
  parseTurnParam: (raw: string | undefined) => (raw ? Number(raw) : null),
  getCodeSessionDetail: (_supabase: unknown, ...rest: unknown[]) => record("getCodeSessionDetail", rest, state.detail),
  getCodeSessionFacts: (_supabase: unknown, ...rest: unknown[]) =>
    record("getCodeSessionFacts", rest, { fact: "f1" }, state.factsReject),
  getCodeSessionUsageRow: (_supabase: unknown, ...rest: unknown[]) =>
    record("getCodeSessionUsageRow", rest, state.usageRow),
  getParentSessionForChild: (_supabase: unknown, ...rest: unknown[]) =>
    record("getParentSessionForChild", rest, state.parentSession),
  getSessionToolUseIndex: (_supabase: unknown, ...rest: unknown[]) => record("getSessionToolUseIndex", rest, []),
  listChildSessions: (_supabase: unknown, ...rest: unknown[]) =>
    record("listChildSessions", rest, state.childRows, state.childrenReject),
}));

vi.mock("@/lib/code-sessions/view", () => ({
  groupSessionTurns: (...args: unknown[]) => {
    calls.push(["groupSessionTurns", args]);
    return [];
  },
  sessionPageTitle: (...args: unknown[]) => {
    calls.push(["sessionPageTitle", args]);
    return "Title";
  },
  parentBreadcrumbLabel: (...args: unknown[]) => {
    calls.push(["parentBreadcrumbLabel", args]);
    return "Parent";
  },
  turnCountsLabel: (...args: unknown[]) => {
    calls.push(["turnCountsLabel", args]);
    return "1 turn";
  },
  shapeSessionFacts: (...args: unknown[]) => {
    calls.push(["shapeSessionFacts", args]);
    return args[0] ?? null;
  },
  matchChildSessionsToTurns: (...args: unknown[]) => {
    calls.push(["matchChildSessionsToTurns", args]);
    return { byTurnIdx: new Map(), hidden: [], unmatched: [] };
  },
  buildSubAgentTree: (...args: unknown[]) => {
    calls.push(["buildSubAgentTree", args]);
    return [];
  },
}));

vi.mock("@/lib/threads/open-threads", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/threads/open-threads")>();
  return {
    ...actual,
    computeThreads: (...args: unknown[]) => {
      calls.push(["computeThreads", args]);
      return { recent: [] };
    },
  };
});

vi.mock("@/lib/format/forge-url", () => ({
  glabHostsFrom: (...args: unknown[]) => {
    calls.push(["glabHostsFrom", args]);
    return [];
  },
}));

vi.mock("@/lib/agent-stats/aggregate", () => ({
  aggregateAgentStats: (...args: unknown[]) => {
    calls.push(["aggregateAgentStats", args]);
    return { by_model: [], totals: { cost_usd: 0, subagent_cost_usd: 0 } };
  },
}));

vi.mock("@/lib/device-auth", () => ({
  isUuid: (...args: unknown[]) => {
    calls.push(["isUuid", args]);
    return true;
  },
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));

import CodeSessionPage from "../page";

const SESSION_ID = "3f1c2a4e-8b7d-4c6a-9e2f-1a2b3c4d5e6f";

function baseSession(overrides: Record<string, unknown> = {}) {
  return {
    id: SESSION_ID,
    code_project_id: "proj-1",
    project_display_name: "Proj",
    project_repo_identity: "org/repo",
    title: "Session title",
    summary: null,
    git_branch: "main",
    turn_count: 3,
    user_turn_count: 2,
    tool_count: 1,
    started_at: "2026-09-01T00:00:00.000Z",
    duration_seconds: 60,
    source: "claude-code",
    source_session_id: "src-1",
    parent_source_session_id: "parent-src-1",
    subAgent: null,
    ...overrides,
  };
}

beforeEach(() => {
  calls.length = 0;
  state.userId = "user-1";
  state.factsReject = false;
  state.childrenReject = false;
  state.issuesData = [];
  state.issuesError = null;
  state.usageRow = { started_at: "2026-09-01T00:00:00.000Z" };
  state.parentSession = null;
  state.childRows = [
    {
      id: "child-1",
      agent_id: "agent-1",
      parent_agent_id: null,
      agent_type: "sub",
      description: "d",
      tool_use_id: "tu-1",
      turn_count: 2,
    },
  ];
  state.detail = {
    session: baseSession(),
    turns: [],
    turnsTotal: 3,
    truncated: true,
    subAgentSpawnIndex: {},
    window: null,
  };
});

describe("code session page — data-loading call log (G3 3D-4)", () => {
  it("logs every data-access call in order (happy path)", async () => {
    await CodeSessionPage({
      params: Promise.resolve({ sessionId: SESSION_ID }),
      searchParams: Promise.resolve({}),
    });
    await expectCallLog(calls, "./session-page-call-log.happy.json");
  });

  it("logs the call order when a .catch path is exercised (getCodeSessionFacts rejects)", async () => {
    state.factsReject = true;
    await CodeSessionPage({
      params: Promise.resolve({ sessionId: SESSION_ID }),
      searchParams: Promise.resolve({}),
    });
    await expectCallLog(calls, "./session-page-call-log.facts-reject.json");
  });

  it("#173: a missing session is still notFound() before any of the concurrent reads start", async () => {
    state.detail = null;
    await expect(
      CodeSessionPage({
        params: Promise.resolve({ sessionId: SESSION_ID }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    const reads = calls.map(([name]) => name).filter((name) => name !== "isUuid");
    expect(reads).toEqual(["createClient", "supabase.auth.getUser", "getCodeSessionDetail"]);
  });

  it("#173: the five independent reads all start before the first one settles", async () => {
    await CodeSessionPage({
      params: Promise.resolve({ sessionId: SESSION_ID }),
      searchParams: Promise.resolve({}),
    });
    const names = calls.map(([name]) => name);
    const firstPostRead = names.indexOf("shapeSessionFacts");
    for (const read of [
      "getCodeSessionFacts",
      "getCodeSessionUsageRow",
      "supabase.from",
      "listChildSessions",
      "getParentSessionForChild",
    ]) {
      expect(names.indexOf(read)).toBeGreaterThan(-1);
      expect(names.indexOf(read)).toBeLessThan(firstPostRead);
    }
  });
});
