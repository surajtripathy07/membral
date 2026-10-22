// G3 step 3D-3 LOCK: the /code/[projectId] page's 30-day code_sessions cost
// read must produce the exact same Supabase call chain before and after it
// is moved into listRecentUsageRows({ paginate: false }) in
// lib/code-sessions/queries.ts. This records every data-access call (module
// export + args, or supabase chain method + args) in call order and
// snapshots it. getCodeProjectDetail and getCodeProjectFacts are stubbed
// (not the target of this step); lib/code-sessions/queries is a PARTIAL
// mock (importOriginal) so that once listRecentUsageRows exists it runs for
// real, against the same recording supabase client, and its chain lands in
// the same log entries the inline read produces today. Two scenarios: happy
// path, and the read's own try/catch (the code_sessions query errors).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentStatsAggregate, AgentStatsSessionInput } from "@/lib/agent-stats/aggregate";
import type { CodeProjectDetail } from "@/lib/code-sessions/queries";

const FIXED_NOW = new Date("2026-09-28T05:55:05.736Z");
const PROJECT_ID = "3f1c2a4e-8b7d-4c6a-9e2f-1a2b3c4d5e6f";

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
    detail: null as Partial<CodeProjectDetail> | null,
    factsReject: false,
    codeSessionsRows: [] as AgentStatsSessionInput[],
    codeSessionsError: null as { message: string } | null,
    aggregate: {
      by_model: [],
      totals: { sessions: 1, cost_usd: 4, subagent_cost_usd: 0 },
    } as StubAggregate,
  };
  function record(name: string, args: unknown[], value: unknown, reject = false) {
    calls.push([name, args]);
    return reject ? Promise.reject(new Error(`${name} failed`)) : Promise.resolve(value);
  }
  return { calls, state, record };
});

// D-061 (#166): page.tsx now reads the membral_tz cookie via next/headers. No
// cookie set here (falls back to UTC) — same as every pre-#166 snapshot.
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));

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
          is: (col: string, val: unknown) => {
            calls.push(["supabase.is", [col, val]]);
            return chain;
          },
          gte: (col: string, val: unknown) => {
            calls.push(["supabase.gte", [col, val]]);
            return chain;
          },
          order: (col: string, opts: unknown) => {
            calls.push(["supabase.order", [col, opts]]);
            return chain;
          },
          range: (from: number, to: number) => {
            calls.push(["supabase.range", [from, to]]);
            return chain;
          },
          // biome-ignore lint/suspicious/noThenProperty: intentional thenable, mirroring supabase-js's own directly-awaitable PostgrestFilterBuilder.
          then: (resolve: (v: unknown) => void, rej?: (e: unknown) => void) =>
            Promise.resolve({ data: state.codeSessionsRows, error: state.codeSessionsError }).then(resolve, rej),
        };
        return chain;
      },
    };
  },
}));

vi.mock("@/lib/device-auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/device-auth")>();
  return {
    ...actual,
    isUuid: (...args: unknown[]) => {
      calls.push(["isUuid", args]);
      return true;
    },
  };
});

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  },
}));

vi.mock("@/lib/code-sessions/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/code-sessions/queries")>();
  return {
    ...actual,
    getCodeProjectDetail: (_supabase: unknown, ...rest: unknown[]) =>
      record("getCodeProjectDetail", rest, state.detail),
    getCodeProjectFacts: (_supabase: unknown, ...rest: unknown[]) =>
      record("getCodeProjectFacts", rest, { rows: [], trueCounts: {} }, state.factsReject),
  };
});

vi.mock("@/lib/agent-stats/aggregate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-stats/aggregate")>();
  return {
    ...actual,
    aggregateAgentStats: (...args: unknown[]) => {
      calls.push(["aggregateAgentStats", args]);
      return state.aggregate;
    },
  };
});

import CodeProjectPage from "../page";

function baseProject(overrides: Record<string, unknown> = {}) {
  return {
    id: PROJECT_ID,
    display_name: "Proj One",
    repo_identity: "org/repo",
    remote_url: null,
    summary: null,
    props: {},
    session_count: 3,
    last_active_at: "2026-09-20T00:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: FIXED_NOW });
  calls.length = 0;
  state.userId = "user-1";
  state.factsReject = false;
  state.detail = {
    project: baseProject(),
    sessions: [],
    sessionsTotal: 0,
  };
  state.codeSessionsRows = [
    {
      id: "sess-1",
      started_at: "2026-09-10T00:00:00.000Z",
      turn_count: 5,
      user_turn_count: 3,
      props: {},
    },
  ];
  state.codeSessionsError = null;
  state.aggregate = { by_model: [], totals: { sessions: 1, cost_usd: 4, subagent_cost_usd: 0 } };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("code project detail page — data-loading call log (G3 3D-3)", () => {
  it("logs every data-access call in order (happy path)", async () => {
    await CodeProjectPage({ params: Promise.resolve({ projectId: PROJECT_ID }) });
    await expectCallLog(calls, "./page-call-log.happy.json");
  });

  it("logs the call order when the code_sessions read errors", async () => {
    state.codeSessionsError = { message: "boom" };
    await CodeProjectPage({ params: Promise.resolve({ projectId: PROJECT_ID }) });
    await expectCallLog(calls, "./page-call-log.error.json");
  });
});
