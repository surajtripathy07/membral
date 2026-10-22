import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockGetUser = vi.fn();
const mockFrom = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

// Limiter stubbed to always allow (429 path covered in the search route test).
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: 0, remaining: 1 }),
  };
});

// Set env vars before importing route
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { GET, POST } from "../route";

function makeRequest(method: string, params?: Record<string, string>, token?: string, body?: unknown): NextRequest {
  const url = new URL("http://localhost:3000/api/memories");
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }
  const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
  if (body) {
    init.body = JSON.stringify(body);
  }
  return new NextRequest(url, init);
}

describe("GET /api/memories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without auth header", async () => {
    const req = makeRequest("GET", { q: "test" });
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 with invalid token", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "invalid" },
    });

    const req = makeRequest("GET", {}, "bad-token");
    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("returns memories for authenticated user", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });

    const fakeMemories = [
      {
        id: "mem-1",
        type: "preference",
        content: "Prefers TypeScript",
        confidence: 0.9,
        tags: ["typescript"],
        source_conversation_ids: [],
        created_at: "2025-01-01T00:00:00Z",
        updated_at: "2025-01-01T00:00:00Z",
      },
    ];

    // Chain: from().select().eq().order().limit() -> optionally .eq(), .gte(), .ilike()
    const chainMock = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      gte: vi.fn().mockReturnThis(),
      ilike: vi.fn().mockImplementation(() => Promise.resolve({ data: fakeMemories, error: null })),
    };
    // When no ilike is called, the last call in chain resolves
    chainMock.limit.mockImplementation(() => {
      // Return an object that resolves like a thenable but also has chainable methods
      const result = Promise.resolve({ data: fakeMemories, error: null });
      return Object.assign(result, {
        eq: chainMock.eq,
        gte: chainMock.gte,
        ilike: chainMock.ilike,
      });
    });
    mockFrom.mockReturnValue(chainMock);

    const req = makeRequest("GET", {}, "valid-token");
    const res = await GET(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memories).toEqual(fakeMemories);
    expect(body.count).toBe(1);
  });
});

describe("POST /api/memories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 without auth", async () => {
    const req = makeRequest("POST", undefined, undefined, {
      memories: [{ type: "preference", content: "test" }],
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("creates memories for authenticated user", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });

    const insertedData = [
      {
        id: "mem-new",
        user_id: "user-123",
        type: "preference",
        content: "Prefers dark mode",
        confidence: 0.8,
        tags: ["ui"],
        source_conversation_ids: [],
      },
    ];

    const chainMock = {
      insert: vi.fn().mockReturnThis(),
      select: vi.fn().mockResolvedValue({ data: insertedData, error: null }),
    };
    mockFrom.mockReturnValue(chainMock);

    const req = makeRequest("POST", undefined, "valid-token", {
      memories: [{ type: "preference", content: "Prefers dark mode", confidence: 0.8, tags: ["ui"] }],
    });
    const res = await POST(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.memories).toEqual(insertedData);
    expect(body.count).toBe(1);
  });

  it("returns 400 for empty memories array", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });

    const req = makeRequest("POST", undefined, "valid-token", {
      memories: [],
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });
});
