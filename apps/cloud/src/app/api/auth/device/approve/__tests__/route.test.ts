import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => Promise.resolve({ auth: { getUser: mockGetUser } })),
}));

const mockApproveDeviceAuth = vi.fn();
vi.mock("@/lib/device-auth", () => {
  class DeviceConflictError extends Error {
    constructor(message = "Device is already registered to another account") {
      super(message);
      this.name = "DeviceConflictError";
    }
  }
  return {
    approveDeviceAuth: (...args: unknown[]) => mockApproveDeviceAuth(...args),
    DeviceConflictError,
  };
});

const mockEnforceRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args) };
});

import { DeviceConflictError } from "@/lib/device-auth";
import { POST } from "../route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/device/approve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/auth/device/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0, remaining: 10 });
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } } });
    mockApproveDeviceAuth.mockResolvedValue({ deviceName: "Laptop", keyPrefix: "lls_abcd" });
  });

  it("401s without a cookie session", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null } });
    const res = await POST(makeRequest({ userCode: "WM7K-4F2Q" }));
    expect(res.status).toBe(401);
    expect(mockApproveDeviceAuth).not.toHaveBeenCalled();
  });

  it("approves with a valid session + userCode, binding the caller's userId", async () => {
    const res = await POST(makeRequest({ userCode: "WM7K-4F2Q", deviceName: "My Laptop" }));
    expect(res.status).toBe(200);
    expect(mockApproveDeviceAuth).toHaveBeenCalledWith({
      userCode: "WM7K-4F2Q",
      userId: "user-1",
      deviceName: "My Laptop",
    });
    expect(await res.json()).toEqual({ ok: true, deviceName: "Laptop", keyPrefix: "lls_abcd" });
  });

  it("400s on a missing userCode", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(mockApproveDeviceAuth).not.toHaveBeenCalled();
  });

  it("rejects an expired/used/unknown code with 400 — approveDeviceAuth returning null", async () => {
    mockApproveDeviceAuth.mockResolvedValueOnce(null);
    const res = await POST(makeRequest({ userCode: "ZZZZ-ZZZZ" }));
    expect(res.status).toBe(400);
  });

  it("is rate-limited per-user", async () => {
    mockEnforceRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 5, remaining: 0 });
    const res = await POST(makeRequest({ userCode: "WM7K-4F2Q" }));
    expect(res.status).toBe(429);
    expect(mockApproveDeviceAuth).not.toHaveBeenCalled();
  });

  it("500s cleanly if approveDeviceAuth throws", async () => {
    mockApproveDeviceAuth.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(makeRequest({ userCode: "WM7K-4F2Q" }));
    expect(res.status).toBe(500);
  });

  it("H1: a DeviceConflictError maps to 409, not the generic 500", async () => {
    mockApproveDeviceAuth.mockRejectedValueOnce(new DeviceConflictError());
    const res = await POST(makeRequest({ userCode: "WM7K-4F2Q" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });
});
