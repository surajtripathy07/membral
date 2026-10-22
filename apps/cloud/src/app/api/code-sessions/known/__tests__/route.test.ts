import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// An in-memory code_sessions table. The mocked query honors the route's
// .eq("user_id") and .in("source_session_id") filters, so other-user rows
// are excluded the same way Postgres would exclude them.
interface Row {
  user_id: string;
  source: string;
  source_session_id: string;
  turn_count: number;
  ended_at: string | null;
  content_hash: string;
}
let table: Row[] = [];
const inCalls: string[][] = [];
let failQuery = false;

const mockGetUser = vi.fn();
const mockRpc = vi.fn(
  (): Promise<{ data: unknown; error: { message: string } | null }> => Promise.resolve({ data: null, error: null }),
);
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    rpc: mockRpc,
    from: (tableName: string) => {
      if (tableName !== "code_sessions") throw new Error(`unexpected table ${tableName}`);
      const filters: { userId?: string; ids?: string[] } = {};
      const chain = {
        select: () => chain,
        eq: (col: string, value: string) => {
          if (col === "user_id") filters.userId = value;
          return chain;
        },
        in: (col: string, values: string[]) => {
          if (col === "source_session_id") filters.ids = values;
          inCalls.push(values);
          if (failQuery) return Promise.resolve({ data: null, error: { message: "boom" } });
          const data = table
            .filter((r) => r.user_id === filters.userId && (filters.ids ?? []).includes(r.source_session_id))
            .map(({ user_id: _u, ...rest }) => rest);
          return Promise.resolve({ data, error: null });
        },
      };
      return chain;
    },
  })),
}));

const mockValidateApiKey = vi.fn();
vi.mock("@/lib/api-keys", () => ({
  validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { POST } from "../route";

function makeRequest(body: unknown, token: string | null = "lls_good"): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest("http://localhost:3000/api/code-sessions/known", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function probe(id: string, turn_count: number, ended_at: string | null, source = "claude-code") {
  return { source, source_session_id: id, turn_count, ended_at };
}

function row(id: string, turn_count: number, ended_at: string | null, overrides: Partial<Row> = {}): Row {
  return {
    user_id: "user-1",
    source: "claude-code",
    source_session_id: id,
    turn_count,
    ended_at,
    content_hash: "hash",
    ...overrides,
  };
}

describe("POST /api/code-sessions/known", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    table = [];
    inCalls.length = 0;
    failQuery = false;
    mockValidateApiKey.mockResolvedValue({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
  });

  it("returns 401 without auth", async () => {
    const res = await POST(makeRequest({ sessions: [] }, null));
    expect(res.status).toBe(401);
  });

  it("returns 403 for a scoped key, same as the ingest", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: "proj-1",
    });
    const res = await POST(makeRequest({ sessions: [probe("a", 1, null)] }));
    expect(res.status).toBe(403);
  });

  it("returns 429 when its own codeSessionsKnown bucket is exhausted", async () => {
    mockRpc.mockResolvedValueOnce({ data: { allowed: false, retry_after: 9, remaining: 0 }, error: null });
    const res = await POST(makeRequest({ sessions: [probe("a", 1, null)] }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("9");
    expect(mockRpc).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ p_key: "codeSessionsKnown:user:user-1", p_limit: 60 }),
    );
  });

  it("lists a session whose turn_count and ended_at (to the second) match the stored row", async () => {
    table = [row("same", 4, "2026-02-01T00:05:00.123+00:00")];
    const res = await POST(makeRequest({ sessions: [probe("same", 4, "2026-02-01T00:05:00.987Z")] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ known: [0] });
  });

  it("treats null ended_at on both sides as equal", async () => {
    table = [row("nulls", 0, null)];
    const res = await POST(makeRequest({ sessions: [probe("nulls", 0, null)] }));
    expect(await res.json()).toEqual({ known: [0] });
  });

  it("omits sessions that are missing, grew, ended later, differ in source, or are mid-import", async () => {
    table = [
      row("grown", 3, "2026-02-01T00:05:00+00:00"),
      row("later", 4, "2026-02-01T00:05:00+00:00"),
      row("opencode-only", 4, "2026-02-01T00:05:00+00:00", { source: "opencode" }),
      row("pending", 4, "2026-02-01T00:05:00+00:00", { content_hash: "" }),
      row("match", 4, "2026-02-01T00:05:00+00:00"),
    ];
    const res = await POST(
      makeRequest({
        sessions: [
          probe("missing", 4, "2026-02-01T00:05:00Z"),
          probe("grown", 4, "2026-02-01T00:05:00Z"),
          probe("later", 4, "2026-02-01T00:05:01Z"),
          probe("opencode-only", 4, "2026-02-01T00:05:00Z"),
          probe("pending", 4, "2026-02-01T00:05:00Z"),
          probe("match", 4, "2026-02-01T00:05:00Z"),
        ],
      }),
    );
    expect(await res.json()).toEqual({ known: [5] });
  });

  it("never reports another user's row as known", async () => {
    table = [row("shared-id", 2, "2026-02-01T00:05:00+00:00", { user_id: "user-2" })];
    const res = await POST(makeRequest({ sessions: [probe("shared-id", 2, "2026-02-01T00:05:00Z")] }));
    expect(await res.json()).toEqual({ known: [] });
  });

  it("accepts 500 probes, splitting the id filter to stay under the URL limit", async () => {
    const sessions = Array.from({ length: 500 }, (_, i) =>
      probe(`00000000-0000-0000-0000-${String(i).padStart(12, "0")}:agent-a${i}`, 1, null),
    );
    table = [row(sessions[499].source_session_id, 1, null)];
    const res = await POST(makeRequest({ sessions }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ known: [499] });
    expect(inCalls.length).toBeGreaterThan(1);
    expect(inCalls.flat()).toHaveLength(500);
    for (const chunk of inCalls) expect(chunk.length).toBeLessThanOrEqual(100);
  });

  it("rejects 501 probes with 400", async () => {
    const sessions = Array.from({ length: 501 }, (_, i) => probe(`s-${i}`, 1, null));
    const res = await POST(makeRequest({ sessions }));
    expect(res.status).toBe(400);
    expect(inCalls).toHaveLength(0);
  });

  it("rejects a malformed probe with 400", async () => {
    const res = await POST(makeRequest({ sessions: [{ source: "claude-code", source_session_id: "a" }] }));
    expect(res.status).toBe(400);
  });

  it("returns 500 when the lookup fails, so the CLI falls back to uploading", async () => {
    failQuery = true;
    const res = await POST(makeRequest({ sessions: [probe("a", 1, null)] }));
    expect(res.status).toBe(500);
  });
});
