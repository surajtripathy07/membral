// #93 (usage visibility that reconciles) — GET /api/code-sessions/stats.
// Mocks the withRoute "dual" adapter (requireBearerOrKeyUser, lib/api/auth.ts)
// rather than the supabase-js client underneath it, since that adapter has its
// own auth-shape tests (lib/api/__tests__/auth.test.ts) and the golden contract
// locks this route's auth edges (code-sessions-stats.*.json) — this file
// focuses on the stats route's own query + aggregation wiring.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockAuthenticateRead = vi.fn();

// Chainable query-builder mock: .select().eq().is().gte().order() resolves to
// {data, error} — only the methods this route actually calls.
const isCalls: unknown[][] = [];
function chain(result: { data: unknown; error: { message: string } | null }) {
  const builder: Record<string, unknown> = {};
  builder.select = vi.fn(() => builder);
  builder.eq = vi.fn(() => builder);
  builder.is = vi.fn((...args: unknown[]) => {
    isCalls.push(args);
    return builder;
  });
  builder.gte = vi.fn(() => builder);
  builder.order = vi.fn(() => Promise.resolve(result));
  return builder;
}

let queryResult: { data: unknown; error: { message: string } | null } = { data: [], error: null };
const mockFrom = vi.fn(() => chain(queryResult));

vi.mock("@/lib/api/auth", async () => ({
  ...(await vi.importActual<typeof import("@/lib/api/auth")>("@/lib/api/auth")),
  requireBearerOrKeyUser: (...args: unknown[]) => mockAuthenticateRead(...args),
}));
vi.mock("@/lib/code-sessions/auth", async () => ({
  ...(await vi.importActual<typeof import("@/lib/code-sessions/auth")>("@/lib/code-sessions/auth")),
  getCodeSessionsServiceClient: () => ({ from: mockFrom }),
}));

import { NextResponse } from "next/server";
import { GET } from "../route";

const VALID_USAGE = {
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cacheReadInputTokens: 200_000,
  cacheCreationInputTokens: 50_000,
};

function req(url = "http://localhost:3001/api/code-sessions/stats") {
  return new NextRequest(url);
}

describe("GET /api/code-sessions/stats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryResult = { data: [], error: null };
  });

  it("returns whatever the dual auth adapter returns when auth fails", async () => {
    mockAuthenticateRead.mockResolvedValueOnce(NextResponse.json({ error: "Missing authorization" }, { status: 401 }));
    const res = await GET(req());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Missing authorization" });
    expect(mockFrom).not.toHaveBeenCalled();
  });

  it("defaults to a 30-day window and scopes the query to the authenticated user", async () => {
    mockAuthenticateRead.mockResolvedValueOnce({ userId: "user-1" });
    queryResult = {
      data: [
        {
          id: "s1",
          started_at: "2026-08-15T00:00:00.000Z",
          turn_count: 10,
          user_turn_count: 4,
          props: { usage: VALID_USAGE, models: ["claude-sonnet-5"] },
        },
      ],
      error: null,
    };
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days).toBe(30);
    expect(body.totals.sessions).toBe(1);
    expect(body.totals.cost_usd).toBeGreaterThan(0);
    expect(body.by_model.map((m: { model_tier: string }) => m.model_tier)).toEqual(["Sonnet"]);
    expect(body.coverage).toEqual({ sessions_total: 1, sessions_with_usage: 1 });
    // Sub-agent sessions (migration 089) are excluded — their usage is
    // already in the parent's props.subAgents.
    expect(isCalls).toContainEqual(["parent_source_session_id", null]);
  });

  it("respects a ?days= override", async () => {
    mockAuthenticateRead.mockResolvedValueOnce({ userId: "user-1" });
    const res = await GET(req("http://localhost:3001/api/code-sessions/stats?days=7"));
    const body = await res.json();
    expect(body.days).toBe(7);
  });

  it("caps an absurd ?days= at the max window rather than an unbounded query", async () => {
    mockAuthenticateRead.mockResolvedValueOnce({ userId: "user-1" });
    const res = await GET(req("http://localhost:3001/api/code-sessions/stats?days=999999"));
    const body = await res.json();
    expect(body.days).toBe(365);
  });

  it("ignores a non-numeric ?days= and falls back to the default", async () => {
    mockAuthenticateRead.mockResolvedValueOnce({ userId: "user-1" });
    const res = await GET(req("http://localhost:3001/api/code-sessions/stats?days=nope"));
    const body = await res.json();
    expect(body.days).toBe(30);
  });

  it("surfaces a query error as a 500", async () => {
    mockAuthenticateRead.mockResolvedValueOnce({ userId: "user-1" });
    queryResult = { data: null, error: { message: "boom" } };
    const res = await GET(req());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("boom");
  });

  it("folds sub-agent usage into the returned totals (same aggregateAgentStats path as /code/stats)", async () => {
    mockAuthenticateRead.mockResolvedValueOnce({ userId: "user-1" });
    queryResult = {
      data: [
        {
          id: "s1",
          started_at: "2026-08-15T00:00:00.000Z",
          turn_count: 10,
          user_turn_count: 4,
          props: {
            usage: VALID_USAGE,
            models: ["claude-fable-5"],
            subAgents: [{ model: "claude-sonnet-5", usage: VALID_USAGE, isFork: false }],
          },
        },
      ],
      error: null,
    };
    const res = await GET(req());
    const body = await res.json();
    expect(body.totals.subagent_runs).toBe(1);
    expect(body.totals.subagent_cost_usd).toBeGreaterThan(0);
    expect(body.by_model.map((m: { model_tier: string }) => m.model_tier).sort()).toEqual(["Fable", "Sonnet"]);
  });
});
