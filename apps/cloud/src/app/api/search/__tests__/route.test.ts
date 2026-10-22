import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockGetUser = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}));

const mockSearchConversations = vi.fn();
vi.mock("@/lib/search", () => ({
  searchConversations: (...args: unknown[]) => mockSearchConversations(...args),
}));

// Limiter: keep the real helpers (rateLimited/userBucket) but stub enforceRateLimit.
const mockEnforceRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args),
  };
});

// Set env vars before importing route
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { GET } from "../route";

function makeRequest(params: Record<string, string>, token?: string): NextRequest {
  const url = new URL("http://localhost:3000/api/search");
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }
  const headers: Record<string, string> = {};
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return new NextRequest(url, { method: "GET", headers });
}

describe("GET /api/search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: under the limit. Individual tests override for the 429 path.
    mockEnforceRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0, remaining: 59 });
  });

  it("returns 401 without auth header", async () => {
    const req = makeRequest({ q: "test" });
    const res = await GET(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 401 with invalid token", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "invalid" },
    });

    const req = makeRequest({ q: "test" }, "bad-token");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 without query param", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });

    const req = makeRequest({}, "valid-token");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("query");
  });

  it("returns 200 with results", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });

    const fakeResults = [
      {
        id: "conv-1",
        source: "chatgpt",
        title: "React hooks",
        created_at: "2026-01-15T10:00:00Z",
        summary: "Hooks discussion",
        similarity: 0.85,
      },
    ];
    mockSearchConversations.mockResolvedValueOnce(fakeResults);

    const req = makeRequest({ q: "React hooks" }, "valid-token");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results).toEqual(fakeResults);
    expect(body.query).toBe("React hooks");
    expect(body.mode).toBe("hybrid");
    expect(body.count).toBe(1);
  });

  it("respects mode and limit params", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });

    mockSearchConversations.mockResolvedValueOnce([]);

    const req = makeRequest({ q: "test", mode: "semantic", limit: "5" }, "valid-token");
    const res = await GET(req);
    expect(res.status).toBe(200);

    expect(mockSearchConversations).toHaveBeenCalledWith("user-123", {
      query: "test",
      mode: "semantic",
      limit: 5,
      lane: "all",
    });
  });

  it("defaults mode to hybrid and limit to 10", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });

    mockSearchConversations.mockResolvedValueOnce([]);

    const req = makeRequest({ q: "test" }, "valid-token");
    await GET(req);

    expect(mockSearchConversations).toHaveBeenCalledWith("user-123", {
      query: "test",
      mode: "hybrid",
      limit: 10,
      lane: "all",
    });
  });

  describe("lane (ADR 0039, W6/D7 follow-up; default 'all' per goal 2026-08-27 D6 fix / #106)", () => {
    it("defaults lane to 'all' and echoes it in the response", async () => {
      mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
      mockSearchConversations.mockResolvedValueOnce([]);

      const req = makeRequest({ q: "test" }, "valid-token");
      const res = await GET(req);
      const body = await res.json();
      expect(body.lane).toBe("all");
      expect(mockSearchConversations).toHaveBeenCalledWith("user-123", expect.objectContaining({ lane: "all" }));
    });

    it("passes lane=code/all through", async () => {
      mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
      mockSearchConversations.mockResolvedValueOnce([]);

      const req = makeRequest({ q: "test", lane: "code" }, "valid-token");
      const res = await GET(req);
      expect((await res.json()).lane).toBe("code");
      expect(mockSearchConversations).toHaveBeenCalledWith("user-123", expect.objectContaining({ lane: "code" }));
    });

    it("rejects an invalid lane value", async () => {
      mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });

      const req = makeRequest({ q: "test", lane: "bogus" }, "valid-token");
      const res = await GET(req);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("lane");
      expect(mockSearchConversations).not.toHaveBeenCalled();
    });
  });

  it("returns 429 with Retry-After when the per-user rate limit is exceeded (issue #67)", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });
    mockEnforceRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 30, remaining: 0 });

    const req = makeRequest({ q: "test" }, "valid-token");
    const res = await GET(req);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    const body = await res.json();
    expect(body.error).toContain("Rate limit");
    // The expensive search work must NOT run once limited.
    expect(mockSearchConversations).not.toHaveBeenCalled();
  });

  it("rejects invalid mode values", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });

    const req = makeRequest({ q: "test", mode: "invalid" }, "valid-token");
    const res = await GET(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("mode");
  });
});
