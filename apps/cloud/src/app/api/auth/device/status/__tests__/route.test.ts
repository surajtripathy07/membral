// GET /api/auth/device/status — NEW-10 (round-2 review) added a try/catch
// around the DB lookup and a per-user rate limit; this route previously had
// neither, unlike every other device-auth route.
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
  })),
}));

const mockLookupDeviceAuthStatus = vi.fn();
vi.mock("@/lib/device-auth", () => ({
  lookupDeviceAuthStatus: (...args: unknown[]) => mockLookupDeviceAuthStatus(...args),
}));

const mockEnforceRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args) };
});

import { GET } from "../route";

function makeRequest(code?: string): NextRequest {
  const url = code
    ? `http://localhost:3000/api/auth/device/status?code=${code}`
    : "http://localhost:3000/api/auth/device/status";
  return new NextRequest(url, { method: "GET" });
}

describe("GET /api/auth/device/status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0, remaining: 39 });
  });

  it("401s without a cookie session", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await GET(makeRequest("WM7K-4F2Q"));
    expect(res.status).toBe(401);
    expect(mockLookupDeviceAuthStatus).not.toHaveBeenCalled();
  });

  it("400s on a missing code", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } } });
    const res = await GET(makeRequest());
    expect(res.status).toBe(400);
    expect(mockLookupDeviceAuthStatus).not.toHaveBeenCalled();
  });

  it("404s when the code isn't found", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } } });
    mockLookupDeviceAuthStatus.mockResolvedValueOnce(null);
    const res = await GET(makeRequest("WM7K-4F2Q"));
    expect(res.status).toBe(404);
  });

  it("200s with the display fields on a found code", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } } });
    mockLookupDeviceAuthStatus.mockResolvedValueOnce({ deviceName: "Kabir's MacBook", devicePlatform: "darwin" });
    const res = await GET(makeRequest("WM7K-4F2Q"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deviceName: "Kabir's MacBook", devicePlatform: "darwin" });
  });

  it("NEW-10: wraps lookupDeviceAuthStatus in try/catch — a thrown DB error returns JSON 500, not an unhandled crash", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } } });
    mockLookupDeviceAuthStatus.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(makeRequest("WM7K-4F2Q"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("NEW-10: is rate-limited, bucketed per user", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } } });
    await GET(makeRequest("WM7K-4F2Q"));
    expect(mockEnforceRateLimit).toHaveBeenCalledWith("deviceAuthPoll", "deviceAuthPoll:user:user-1");
  });

  it("NEW-10: a 429 from the rate limiter is returned before any lookup runs", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-1" } } });
    mockEnforceRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 12, remaining: 0 });
    const res = await GET(makeRequest("WM7K-4F2Q"));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("12");
    expect(mockLookupDeviceAuthStatus).not.toHaveBeenCalled();
  });
});
