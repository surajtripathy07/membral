import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockStartDeviceAuth = vi.fn();
vi.mock("@/lib/device-auth", () => ({
  startDeviceAuth: (...args: unknown[]) => mockStartDeviceAuth(...args),
  isUuid: (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v),
}));

const mockEnforceRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args) };
});

import { POST } from "../route";

function makeRequest(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost:3000/api/auth/device/start", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/auth/device/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0, remaining: 10 });
    mockStartDeviceAuth.mockResolvedValue({
      deviceCode: "dvc_raw",
      userCode: "WM7K-4F2Q",
      expiresIn: 600,
      interval: 3,
    });
  });

  it("no auth required — succeeds with an empty body", async () => {
    const res = await POST(makeRequest(undefined));
    expect(res.status).toBe(200);
  });

  it("returns the full device-flow contract shape", async () => {
    const res = await POST(makeRequest({ deviceName: "Laptop", devicePlatform: "darwin" }));
    const body = await res.json();
    expect(body).toEqual({
      deviceCode: "dvc_raw",
      userCode: "WM7K-4F2Q",
      verificationUri: "http://localhost:3000/device",
      verificationUriComplete: "http://localhost:3000/device?code=WM7K-4F2Q",
      expiresIn: 600,
      interval: 3,
    });
  });

  it("passes through deviceName/devicePlatform/deviceId to startDeviceAuth", async () => {
    await POST(
      makeRequest({
        deviceName: "Laptop",
        devicePlatform: "darwin",
        deviceId: "123e4567-e89b-12d3-a456-426614174000",
      }),
    );
    expect(mockStartDeviceAuth).toHaveBeenCalledWith({
      deviceName: "Laptop",
      devicePlatform: "darwin",
      deviceId: "123e4567-e89b-12d3-a456-426614174000",
    });
  });

  it("a non-uuid deviceId is dropped (null), not passed through raw", async () => {
    await POST(makeRequest({ deviceId: "not-a-uuid" }));
    expect(mockStartDeviceAuth).toHaveBeenCalledWith(expect.objectContaining({ deviceId: null }));
  });

  it("is rate-limited by IP under its own deviceAuthStart rule, in its own bucket namespace", async () => {
    mockEnforceRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 42, remaining: 0 });
    const res = await POST(makeRequest({}, { "x-forwarded-for": "5.5.5.5" }));
    expect(res.status).toBe(429);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith("deviceAuthStart", "deviceAuthStart:ip:5.5.5.5");
    expect(mockStartDeviceAuth).not.toHaveBeenCalled();
  });

  it("M1: falls back to a random-ish per-request bucket (not one shared 'unknown' bucket) when the IP can't be resolved", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(200);
    expect(mockEnforceRateLimit).toHaveBeenCalledWith(
      "deviceAuthStart",
      expect.stringMatching(/^deviceAuthStart:ip:unknown:/),
    );
  });

  it("500s cleanly if startDeviceAuth throws", async () => {
    mockStartDeviceAuth.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(500);
  });
});
