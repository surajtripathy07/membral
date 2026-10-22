// G3 step 3D-3 LOCK: the /code page's 30-day code_sessions cost read must
// produce the exact same Supabase call chain before and after it is moved
// into listRecentUsageRows({ paginate: false }) in lib/code-sessions/queries.ts.
// This records every data-access call (module export + args, or supabase
// chain method + args) in call order and snapshots it. getCodeProjectsPage
// and resolveProjectCanonical are stubbed (not the target of this step);
// lib/code-sessions/queries is a PARTIAL mock (importOriginal) so that once
// listRecentUsageRows exists it runs for real, against the same recording
// supabase client, and its chain lands in the same log entries the inline
// read produces today. Two scenarios: happy path, and the read's own
// try/catch (the code_sessions query errors).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fixed clock: page.tsx derives `since`/`now` from Date.now(), which would
// otherwise make the call-log snapshot (it carries their ISO strings) flake
// on wall-clock time.
const FIXED_NOW = new Date("2026-09-28T05:55:05.736Z");

/** `<name>`: the ordered `[moduleExport, args]` call log, byte-identical across a pure move. */
async function expectCallLog(calls: readonly [string, unknown[]][], name: string): Promise<void> {
  await expect(`${JSON.stringify(calls, null, 2)}\n`).toMatchFileSnapshot(name);
}

const { calls, state, record } = vi.hoisted(() => {
  const calls: [string, unknown[]][] = [];
  const state = {
    userId: "user-1",
    projects: [] as any[],
    total: 0,
    codeSessionsRows: [] as any[],
    codeSessionsError: null as { message: string } | null,
    aliasMap: new Map<string, string>(),
    aggregate: { by_model: [], totals: { sessions: 1, cost_usd: 3, subagent_cost_usd: 0 } } as any,
  };
  function record(name: string, args: unknown[], value: unknown) {
    calls.push([name, args]);
    return Promise.resolve(value);
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
      rpc: (fn: string, args: unknown) => {
        calls.push(["supabase.rpc", [fn, args]]);
        return Promise.resolve({ data: null, error: null });
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

vi.mock("@/lib/code-sessions/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/code-sessions/queries")>();
  return {
    ...actual,
    getCodeProjectsPage: (_supabase: unknown, ...rest: unknown[]) =>
      record("getCodeProjectsPage", rest, {
        projects: state.projects,
        total: state.total,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      }),
  };
});

vi.mock("@/lib/memory/project-aliases", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/memory/project-aliases")>();
  return {
    ...actual,
    resolveProjectCanonical: (_supabase: unknown, ...rest: unknown[]) =>
      record("resolveProjectCanonical", rest, state.aliasMap),
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

import CodePage from "../page";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: FIXED_NOW });
  calls.length = 0;
  state.userId = "user-1";
  state.projects = [
    {
      id: "proj-1",
      display_name: "Proj One",
      repo_identity: "org/repo",
      session_count: 3,
      last_active_at: "2026-09-20T00:00:00.000Z",
      summary: null,
    },
  ];
  state.total = 1;
  state.codeSessionsRows = [
    {
      id: "sess-1",
      code_project_id: "proj-1",
      started_at: "2026-09-10T00:00:00.000Z",
      turn_count: 5,
      user_turn_count: 3,
      files_touched: ["a.ts"],
      props: {},
    },
  ];
  state.codeSessionsError = null;
  state.aliasMap = new Map();
  state.aggregate = { by_model: [], totals: { sessions: 1, cost_usd: 3, subagent_cost_usd: 0 } };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("code projects page — data-loading call log (G3 3D-3)", () => {
  it("logs every data-access call in order (happy path)", async () => {
    await CodePage({ searchParams: Promise.resolve({}) });
    await expectCallLog(calls, "./page-call-log.happy.json");
  });

  it("logs the call order when the code_sessions read errors", async () => {
    state.codeSessionsError = { message: "boom" };
    await CodePage({ searchParams: Promise.resolve({}) });
    await expectCallLog(calls, "./page-call-log.error.json");
  });
});
