import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real after() throws outside a Next request scope (same double as
// code-sessions/__tests__/route.test.ts): capture the callback instead of
// running it, and flushAfter() drains it, standing in for "the platform ran
// the deferred work after the response".
const capturedAfterCallbacks: Array<() => unknown> = [];
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (cb: () => unknown) => {
      capturedAfterCallbacks.push(cb);
    },
  };
});
async function flushAfter(): Promise<void> {
  while (capturedAfterCallbacks.length > 0) {
    const cb = capturedAfterCallbacks.shift();
    await cb?.();
  }
}

const mockGetUser = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
  })),
}));

const mockValidateApiKey = vi.fn();
vi.mock("@/lib/api-keys", () => ({
  validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
}));

const mockEnforceRateLimit = vi.fn();
vi.mock("@/lib/rate-limit", async () => {
  const actual = await vi.importActual<typeof import("@/lib/rate-limit")>("@/lib/rate-limit");
  return { ...actual, enforceRateLimit: (...args: unknown[]) => mockEnforceRateLimit(...args) };
});

const mockCountClaimable = vi.fn();
vi.mock("@/lib/memory/extraction-queue", () => ({
  countClaimableMemoryExtraction: (...args: unknown[]) => mockCountClaimable(...args),
}));

const mockCheckFeature = vi.fn();
vi.mock("@/lib/feature-flags", () => ({
  checkFeature: (...args: unknown[]) => mockCheckFeature(...args),
}));

const mockTrigger = vi.fn();
vi.mock("@/lib/memory/extraction-trigger", () => ({
  resolveInternalBaseUrl: () => "http://localhost:3001",
  triggerMemoryExtraction: (...args: unknown[]) => mockTrigger(...args),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { POST } from "../route";

function makeRequest(opts: { token?: string } = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  return new NextRequest("http://localhost:3000/api/memory/extraction/kick", { method: "POST", headers });
}

describe("POST /api/memory/extraction/kick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedAfterCallbacks.length = 0;
    mockEnforceRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0, remaining: 5 });
  });

  it("returns 401 when no auth header", async () => {
    const res = await POST(makeRequest());
    expect(res.status).toBe(401);
    expect(mockCountClaimable).not.toHaveBeenCalled();
  });

  it("returns 429 when the rate limit is hit", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    mockEnforceRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 42, remaining: 0 });
    const res = await POST(makeRequest({ token: "lls_ok" }));
    expect(res.status).toBe(429);
    expect(mockCountClaimable).not.toHaveBeenCalled();
  });

  it("returns { kicked: false, pending: 0 } and never triggers when there is nothing claimable", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    mockCountClaimable.mockResolvedValueOnce(0);

    const res = await POST(makeRequest({ token: "lls_ok" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kicked: false, pending: 0 });
    expect(mockCheckFeature).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("triggers exactly once and returns { kicked: true, pending } when rows are claimable and the feature is allowed", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    mockCountClaimable.mockResolvedValueOnce(3);
    mockCheckFeature.mockResolvedValueOnce({
      allowed: true,
      reason: "ok",
      spentUsd: 0,
      budgetUsd: null,
      dailyUsd: null,
    });
    mockTrigger.mockResolvedValueOnce(true);

    const res = await POST(makeRequest({ token: "lls_ok" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kicked: true, pending: 3 });
    await flushAfter();
    expect(mockTrigger).toHaveBeenCalledTimes(1);
    expect(mockTrigger).toHaveBeenCalledWith("user-1", "http://localhost:3001");
  });

  it("does not trigger and says why when memory is off/over budget", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    mockCountClaimable.mockResolvedValueOnce(5);
    mockCheckFeature.mockResolvedValueOnce({
      allowed: false,
      reason: "budget_exhausted",
      spentUsd: 2,
      budgetUsd: 2,
      dailyUsd: null,
    });

    const res = await POST(makeRequest({ token: "lls_ok" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ kicked: false, pending: 5, reason: "budget_exhausted" });
    await flushAfter();
    expect(mockTrigger).not.toHaveBeenCalled();
  });
});
