// GET /api/sync-state route tests — the API-shaping half of the Sync
// State panel work (sync-state-rules.test.ts / sync-state-shape.test.ts
// cover the pure decision trees; this file covers the route's own wiring:
// auth gating, per-table query shaping, and — the hard rule this endpoint
// must honor — tolerance of tables that don't exist yet.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
const mockCookieRpc = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { getUser: mockGetUser }, rpc: mockCookieRpc })),
}));

const mockServiceFrom = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ from: mockServiceFrom })),
}));

vi.mock("@/lib/log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { GET } from "../route";

// ---------------------------------------------------------------------------
// Chainable query-builder mock — every filter/order/range method returns the
// builder itself; `.then`/`.maybeSingle()` are the terminal resolution
// points, mirroring supabase-js's own thenable PostgrestFilterBuilder shape
// closely enough for this route's call patterns.
// ---------------------------------------------------------------------------

interface FakeResult {
  data?: unknown;
  error?: { message: string } | null;
  count?: number | null;
}

function makeBuilder(result: FakeResult) {
  const resolved = { data: null, error: null, count: null, ...result };
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit", "range", "in", "is"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.maybeSingle = vi.fn(() => Promise.resolve(resolved));
  // biome-ignore lint/suspicious/noThenProperty: intentional thenable, mirroring supabase-js's own directly-awaitable PostgrestFilterBuilder.
  builder.then = (onFulfilled: (v: FakeResult) => unknown, onRejected?: (e: unknown) => unknown) =>
    Promise.resolve(resolved).then(onFulfilled, onRejected);
  return builder;
}

const EMPTY_TABLES: Record<string, FakeResult> = {
  sync_heartbeats: { data: [] },
  conversations: { data: [], count: 0 },
  code_sessions: { data: [] },
};

function wireServiceFrom(tables: Record<string, FakeResult> = {}) {
  const merged = { ...EMPTY_TABLES, ...tables };
  mockServiceFrom.mockImplementation((table: string) => makeBuilder(merged[table] ?? { data: [] }));
}

describe("GET /api/sync-state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mockCookieRpc.mockResolvedValue({ data: { grounded: 3 }, error: null });
    wireServiceFrom();
  });

  it("401s without a session", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await GET(new NextRequest("http://localhost/api/sync-state"));
    expect(res.status).toBe(401);
  });

  it("empty corpus: every chat source reports never, no code", async () => {
    const res = await GET(new NextRequest("http://localhost/api/sync-state"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chat).toHaveLength(2);
    for (const row of body.chat) expect(row.state).toBe("never");
    expect(body.code).toEqual([]);
    expect(body.memory).toBeUndefined();
  });

  it("shapes a chat source from sync_heartbeats + conversations count/last-item", async () => {
    const now = new Date().toISOString();
    wireServiceFrom({
      sync_heartbeats: { data: [{ source: "claude", last_run_at: now, last_item_at: now }] },
      conversations: { data: [{ updated_at: now }], count: 42 },
    });
    const res = await GET(new NextRequest("http://localhost/api/sync-state"));
    const body = await res.json();
    const claude = body.chat.find((r: { source: string }) => r.source === "claude");
    expect(claude.conversations).toBe(42);
    expect(claude.state).toBe("syncing"); // last_run_at is "now"
  });

  it("groups code_sessions by harness (source column) into distinct rows with distinct project counts", async () => {
    const now = new Date().toISOString();
    wireServiceFrom({
      sync_heartbeats: { data: [{ source: "code", last_run_at: now, last_item_at: null }] },
      code_sessions: {
        data: [
          { source: "claude-code", started_at: now, code_project_id: "p1" },
          { source: "claude-code", started_at: now, code_project_id: "p1" },
          { source: "claude-code", started_at: now, code_project_id: "p2" },
        ],
      },
    });
    const res = await GET(new NextRequest("http://localhost/api/sync-state"));
    const body = await res.json();
    expect(body.code).toHaveLength(1);
    expect(body.code[0]).toMatchObject({ harness: "claude-code", sessions: 3, projects: 2, state: "syncing" });
  });

  it("a hard failure in a required chat read still returns 200 with that source degraded (never/stale), not a 500", async () => {
    wireServiceFrom({ conversations: { data: null, error: { message: "connection reset" } } });
    const res = await GET(new NextRequest("http://localhost/api/sync-state"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chat).toHaveLength(2);
  });
});
