import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => Promise.resolve({ auth: { getUser: mockGetUser } })),
}));

const mockDenyDeviceAuth = vi.fn();
vi.mock("@/lib/device-auth", () => ({
  denyDeviceAuth: (...args: unknown[]) => mockDenyDeviceAuth(...args),
}));

const mockEnforceRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args) };
});

import { POST } from "../route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/device/deny", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/auth/device/deny", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0, remaining: 10 });
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mockDenyDeviceAuth.mockResolvedValue(true);
  });

  it("401s without a cookie session", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await POST(makeRequest({ userCode: "WM7K-4F2Q" }));
    expect(res.status).toBe(401);
  });

  it("denies with a valid session + userCode", async () => {
    const res = await POST(makeRequest({ userCode: "WM7K-4F2Q" }));
    expect(res.status).toBe(200);
    expect(mockDenyDeviceAuth).toHaveBeenCalledWith({ userCode: "WM7K-4F2Q" });
    expect(await res.json()).toEqual({ ok: true });
  });

  it("400s when denyDeviceAuth reports nothing to deny", async () => {
    mockDenyDeviceAuth.mockResolvedValueOnce(false);
    const res = await POST(makeRequest({ userCode: "ZZZZ-ZZZZ" }));
    expect(res.status).toBe(400);
  });

  it("L4: wraps denyDeviceAuth in try/catch — a thrown error returns JSON 500, not an unhandled crash", async () => {
    mockDenyDeviceAuth.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(makeRequest({ userCode: "WM7K-4F2Q" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });
});
