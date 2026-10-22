import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPollDeviceAuth = vi.fn();
vi.mock("@/lib/device-auth", () => ({
  pollDeviceAuth: (...args: unknown[]) => mockPollDeviceAuth(...args),
}));

const mockEnforceRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args) };
});

import { POST } from "../route";

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/device/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/auth/device/poll", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0, remaining: 10 });
  });

  it("no auth required — pending", async () => {
    mockPollDeviceAuth.mockResolvedValue({ status: "pending" });
    const res = await POST(makeRequest({ deviceCode: "dvc_x" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "pending" });
  });

  it("approved delivers the raw apiKey exactly as pollDeviceAuth returns it", async () => {
    mockPollDeviceAuth.mockResolvedValue({ status: "approved", apiKey: "lls_raw", email: "a@b.com", userId: "u-1" });
    const res = await POST(makeRequest({ deviceCode: "dvc_x" }));
    expect(await res.json()).toEqual({ status: "approved", apiKey: "lls_raw", email: "a@b.com", userId: "u-1" });
  });

  it("consumed / denied / expired pass through unchanged", async () => {
    for (const status of ["consumed", "denied", "expired"] as const) {
      mockPollDeviceAuth.mockResolvedValueOnce({ status });
      const res = await POST(makeRequest({ deviceCode: "dvc_x" }));
      expect(await res.json()).toEqual({ status });
    }
  });

  it("400s on a missing deviceCode", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(400);
    expect(mockPollDeviceAuth).not.toHaveBeenCalled();
  });

  it("400s on invalid JSON", async () => {
    const req = new NextRequest("http://localhost:3000/api/auth/device/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("rate-limited by IP", async () => {
    mockEnforceRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 10, remaining: 0 });
    const res = await POST(makeRequest({ deviceCode: "dvc_x" }));
    expect(res.status).toBe(429);
    expect(mockPollDeviceAuth).not.toHaveBeenCalled();
  });

  it("M1: also checks the per-code bucket (deviceCode hash) when a deviceCode is present", async () => {
    mockPollDeviceAuth.mockResolvedValue({ status: "pending" });
    await POST(makeRequest({ deviceCode: "dvc_x" }));
    expect(mockEnforceRateLimit).toHaveBeenCalledWith("deviceAuthPoll", expect.stringMatching(/^deviceAuthPoll:code:/));
  });

  it("NEW-7: ALWAYS checks a per-IP bucket too, even when a deviceCode is present (still 400s after)", async () => {
    const res = await POST(makeRequest({}));
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      "deviceAuthPollIp",
      expect.stringMatching(/^deviceAuthPollIp:ip:/),
    );
    expect(res.status).toBe(400);
  });

  it(
    "NEW-7: the per-IP bucket is checked in ADDITION to the per-code bucket — a fresh " +
      "deviceCode each request can't dodge it (both buckets are hit every call)",
    async () => {
      mockPollDeviceAuth.mockResolvedValue({ status: "pending" });
      await POST(makeRequest({ deviceCode: "dvc_fresh_1" }));
      await POST(makeRequest({ deviceCode: "dvc_fresh_2" }));
      const ipCalls = mockEnforceRateLimit.mock.calls.filter((c) => c[0] === "deviceAuthPollIp");
      expect(ipCalls).toHaveLength(2); // once per request, regardless of the (different) deviceCode each time
    },
  );

  it("NEW-7: an unresolvable IP degrades to the STABLE shared 'unknown' bucket, not a random one", async () => {
    const req1 = new NextRequest("http://localhost:3000/api/auth/device/poll", {
      method: "POST",
      headers: { "content-type": "application/json" }, // no x-forwarded-for / x-real-ip
      body: JSON.stringify({}),
    });
    const req2 = new NextRequest("http://localhost:3000/api/auth/device/poll", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await POST(req1);
    await POST(req2);
    const [firstCall, secondCall] = mockEnforceRateLimit.mock.calls;
    expect(firstCall[1]).toBe("deviceAuthPollIp:ip:unknown");
    expect(secondCall[1]).toBe("deviceAuthPollIp:ip:unknown"); // SAME bucket both times, not per-request-random
  });

  it("NEW-7: rejects (429) on the IP bucket even when a deviceCode is present, before the code bucket is checked", async () => {
    mockEnforceRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 5, remaining: 0 }); // the IP check
    const res = await POST(makeRequest({ deviceCode: "dvc_x" }));
    expect(res.status).toBe(429);
    // Only the IP bucket was checked — the code bucket check never ran.
    expect(mockEnforceRateLimit).toHaveBeenCalledTimes(1);
    expect(mockPollDeviceAuth).not.toHaveBeenCalled();
  });

  it("L4: wraps pollDeviceAuth in try/catch — a thrown error returns JSON 500, not an unhandled crash", async () => {
    mockPollDeviceAuth.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(makeRequest({ deviceCode: "dvc_x" }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });
});
