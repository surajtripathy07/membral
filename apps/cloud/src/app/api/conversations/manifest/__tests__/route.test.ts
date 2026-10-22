import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks (hoisted by vitest) ─────────────────────────────────────────────────

// Issue #132: POST /api/sync (exercised below via syncPOST) now registers
// its post-sync pipeline via next/server's after() instead of a bare
// `.then()/.catch()` — the REAL after() throws when called outside an
// active Next request scope (this file constructs a NextRequest and calls
// syncPOST directly, with no Next dev-server request lifecycle behind it).
// This file's own tests only care about the synchronous upsert-row shape,
// never the post-sync pipeline itself — a no-op capture (never flushed) is
// sufficient here, unlike app/api/sync/__tests__/route.test.ts's own mock.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: () => {} };
});

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

// Issue #127: /api/sync (exercised below via syncPOST) now rate-limits and
// enforces profiles.conversation_limit — neither of which this file's own
// GET-manifest-focused mockFrom setup (per-test mockReturnValue chains, see
// below) models. Rate limit: mocked away entirely (always-allow), matching
// every other route test file's convention. conversation_limit: the two
// POST tests below give mockFrom its own table-aware default via
// mockDefaultFromImpl so the quota/existing-key lookups never trip and the
// `mockReturnValueOnce({ upsert: ... })` call still lands on the real
// upsert, not an earlier quota-check call.
vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: 0 }),
  rateLimited: vi.fn(() => new Response(null, { status: 429 })),
  userBucket: vi.fn((name: string, userId: string) => `${name}:${userId}`),
}));

// Env vars must be set before importing routes
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { POST as syncPOST } from "../../../sync/route";
import { GET, OPTIONS } from "../route";

// ── Helpers ───────────────────────────────────────────────────────────────────

// 32 lowercase [a-p] chars — matches the chrome-extension origin pattern
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";

function makeGetRequest(params: Record<string, string> = {}, token?: string, origin?: string): NextRequest {
  const url = new URL("http://localhost:3000/api/conversations/manifest");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const headers: Record<string, string> = {};
  if (token) headers["authorization"] = `Bearer ${token}`;
  if (origin) headers["origin"] = origin;
  return new NextRequest(url, { method: "GET", headers });
}

function makeSyncRequest(body: unknown, token?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost:3000/api/sync", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function makeChainableQuery(
  rows: Array<{ source: string; source_id: string; updated_at: string }> | null,
  opts: { error?: { message: string }; onEq?: (col: string, val: unknown) => void } = {},
) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn((col: string, val: unknown) => {
      opts.onEq?.(col, val);
      return builder;
    }),
    order: vi.fn(() => builder),
    range: vi.fn((from: number, to: number) =>
      Promise.resolve({ data: rows ? rows.slice(from, to + 1) : null, error: opts.error ?? null }),
    ),
  };
  return builder;
}

// ── GET /api/conversations/manifest ──────────────────────────────────────────

describe("GET /api/conversations/manifest", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when authorization header is absent", async () => {
    const req = makeGetRequest();
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 401 when Bearer token is invalid", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "invalid token" },
    });
    const req = makeGetRequest({}, "bad-token");
    const res = await GET(req);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe("Invalid token");
  });

  it("returns 401 when authorization header is not Bearer scheme", async () => {
    const req = new NextRequest("http://localhost:3000/api/conversations/manifest", {
      method: "GET",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns only { source, source_id, updated_at } — no title/messages/embedding", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } }, error: null });

    const rows = [
      { source: "chatgpt", source_id: "c1", updated_at: "2026-01-01T00:00:00Z" },
      { source: "claude", source_id: "c2", updated_at: "2026-01-02T00:00:00Z" },
    ];
    mockFrom.mockReturnValue(makeChainableQuery(rows));

    const req = makeGetRequest({}, "valid-token");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversations).toHaveLength(2);
    expect(body.conversations[0]).toStrictEqual({
      source: "chatgpt",
      source_id: "c1",
      updated_at: "2026-01-01T00:00:00Z",
    });
    expect(body.conversations[0]).not.toHaveProperty("title");
    expect(body.conversations[0]).not.toHaveProperty("messages");
    expect(body.conversations[0]).not.toHaveProperty("embedding");
  });

  it("paginates past the 1000-row PostgREST cap — returns ALL rows across pages", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } }, error: null });
    // 2500 rows ⇒ 3 pages (1000 + 1000 + 500). A single unpaginated query is
    // capped at 1000 by PostgREST max_rows and would silently drop 1500.
    const rows = Array.from({ length: 2500 }, (_, i) => ({
      source: i % 3 === 0 ? "claude" : "chatgpt",
      source_id: `c${i}`,
      updated_at: "2026-01-01T00:00:00Z",
    }));
    const builder = makeChainableQuery(rows);
    mockFrom.mockReturnValue(builder);

    const req = makeGetRequest({}, "valid-token");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversations).toHaveLength(2500);
    expect(builder.range).toHaveBeenCalledTimes(3);
  });

  it("returns empty array when user has no conversations (data: null)", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } }, error: null });
    mockFrom.mockReturnValue(makeChainableQuery(null));

    const req = makeGetRequest({}, "valid-token");
    const res = await GET(req);
    expect(res.status).toBe(200);
    expect((await res.json()).conversations).toEqual([]);
  });

  it("respects ?source filter — applies extra .eq('source', value) to the query", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } }, error: null });

    const onEq = vi.fn();
    mockFrom.mockReturnValue(
      makeChainableQuery([{ source: "chatgpt", source_id: "c1", updated_at: "2026-01-01T00:00:00Z" }], { onEq }),
    );

    const req = makeGetRequest({ source: "chatgpt" }, "valid-token");
    const res = await GET(req);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.conversations).toHaveLength(1);
    expect(onEq).toHaveBeenCalledWith("source", "chatgpt");
  });

  it("returns 500 on database error", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } }, error: null });
    mockFrom.mockReturnValue(makeChainableQuery(null, { error: { message: "db failure" } }));

    const req = makeGetRequest({}, "valid-token");
    const res = await GET(req);
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe("Database error");
  });

  it("OPTIONS from allowed extension origin returns 204 with CORS headers", async () => {
    const req = new NextRequest("http://localhost:3000/api/conversations/manifest", {
      method: "OPTIONS",
      headers: { origin: EXT_ORIGIN },
    });
    const res = await OPTIONS(req);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(EXT_ORIGIN);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("OPTIONS from disallowed origin returns 403", async () => {
    const req = new NextRequest("http://localhost:3000/api/conversations/manifest", {
      method: "OPTIONS",
      headers: { origin: "https://evil.example.com" },
    });
    const res = await OPTIONS(req);
    expect(res.status).toBe(403);
  });
});

// ── synced_at preservation ────────────────────────────────────────────────────

describe("synced_at preservation in sync route", () => {
  beforeEach(() => vi.clearAllMocks());

  // Issue #127: gives mockFrom a table-aware default so /api/sync's
  // conversation_limit quota check ("profiles" + a "conversations" count
  // select, then a "conversations" existing-key select) never trips and
  // never consumes the ONE queued mockReturnValueOnce({ upsert }) below —
  // the real upsert call is the ONLY thing that still needs per-test
  // control. A generous limit (never at cap) + no existing rows (every
  // incoming conversation reads as "new") is exactly this suite's existing
  // assumption (a fresh single-conversation sync, always accepted in full).
  function withQuotaDefaults(upsert: ReturnType<typeof vi.fn>) {
    mockFrom.mockImplementation((table: string) => {
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              single: () => Promise.resolve({ data: { tier: "free", conversation_limit: 1_000_000 }, error: null }),
            }),
          }),
        };
      }
      if (table === "sync_heartbeats") {
        return { upsert: vi.fn().mockResolvedValue({ error: null }) };
      }
      const afterFirstEq = {
        neq: () => Promise.resolve({ count: 0 }),
        eq: () => ({ in: () => Promise.resolve({ data: [], error: null }) }),
      };
      return { select: () => ({ eq: () => afterFirstEq }), upsert };
    });
  }

  const CLIENT_SYNCED_AT = "2025-12-01T10:00:00.000Z";

  // Base conversation without synced_at so each test can control it independently
  const baseConversation = {
    source: "claude",
    source_id: "conv-abc",
    title: "Test",
    messages: [{ role: "user", content: "Hi", timestamp: null, metadata: {} }],
    metadata: {},
    created_at: null,
    updated_at: null,
    model: null,
  };

  it("preserves client-provided synced_at verbatim in the upserted row", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } }, error: null });

    const mockUpsert = vi.fn().mockResolvedValueOnce({ data: [{ id: "r1" }], error: null });
    withQuotaDefaults(mockUpsert);

    const req = makeSyncRequest(
      { conversations: [{ ...baseConversation, synced_at: CLIENT_SYNCED_AT }] },
      "valid-token",
    );
    const res = await syncPOST(req);

    expect(res.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledOnce();
    const rows = (mockUpsert.mock.calls[0] as [Array<{ synced_at: string }>, unknown])[0];
    expect(rows[0].synced_at).toBe(CLIENT_SYNCED_AT);
  });

  it("defaults synced_at to approximately now when absent from client payload", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } }, error: null });

    const mockUpsert = vi.fn().mockResolvedValueOnce({ data: [{ id: "r1" }], error: null });
    withQuotaDefaults(mockUpsert);

    const before = Date.now();
    const req = makeSyncRequest({ conversations: [baseConversation] }, "valid-token");
    const res = await syncPOST(req);
    const after = Date.now();

    expect(res.status).toBe(200);
    const rows = (mockUpsert.mock.calls[0] as [Array<{ synced_at: string }>, unknown])[0];
    const ts = new Date(rows[0].synced_at).getTime();
    // Should be within the window; 100ms tolerance covers CI jitter
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after + 100);
  });
});
