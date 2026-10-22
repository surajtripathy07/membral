import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
const mockDeleteUser = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser, admin: { deleteUser: mockDeleteUser } },
  })),
}));

vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return {
    ...actual,
    enforceRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: 0, remaining: 1 }),
  };
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { POST } from "../route";

function makeRequest(body: unknown, token?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost:3000/api/account/delete", {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/account/delete — issue #22 (truthfulness audit F7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    mockDeleteUser.mockResolvedValue({ data: {}, error: null });
  });

  it("401 without an auth header", async () => {
    const res = await POST(makeRequest({ confirmation: "DELETE" }));
    expect(res.status).toBe(401);
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it("400 without the exact confirmation string", async () => {
    const res = await POST(makeRequest({ confirmation: "delete" }, "jwt"));
    expect(res.status).toBe(400);
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it("400 with no body at all", async () => {
    const res = await POST(makeRequest(undefined, "jwt"));
    expect(res.status).toBe(400);
    expect(mockDeleteUser).not.toHaveBeenCalled();
  });

  it("200 and calls auth.admin.deleteUser with the caller's own id on a correct confirmation", async () => {
    const res = await POST(makeRequest({ confirmation: "DELETE" }, "jwt"));
    expect(res.status).toBe(200);
    expect(mockDeleteUser).toHaveBeenCalledWith("user-1");
    const body = await res.json();
    expect(body.deleted).toBe(true);
  });

  it("500 when deleteUser errors", async () => {
    mockDeleteUser.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await POST(makeRequest({ confirmation: "DELETE" }, "jwt"));
    expect(res.status).toBe(500);
  });
});
