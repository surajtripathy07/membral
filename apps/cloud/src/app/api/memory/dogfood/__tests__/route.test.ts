import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { getUser: mockGetUser } })),
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
const mockSignals = vi.fn();
const mockCandidates = vi.fn();
vi.mock("@/lib/memory/dogfood-signals", async () => {
  const actual = await vi.importActual<typeof import("@/lib/memory/dogfood-signals")>("@/lib/memory/dogfood-signals");
  return {
    ...actual,
    getDogfoodSignals: (...args: unknown[]) => mockSignals(...args),
    getContradictedCandidates: (...args: unknown[]) => mockCandidates(...args),
  };
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { GET } from "../route";

function get(query = "", token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest(`http://localhost:3000/api/memory/dogfood${query}`, { headers });
}
const okKey = { valid: true, userId: "user-1", scopeNodeId: null, scopeCodeProjectId: null };

describe("GET /api/memory/dogfood", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue({ allowed: true });
  });

  it("401s without a bearer and reads nothing", async () => {
    const res = await GET(get());
    expect(res.status).toBe(401);
    expect(mockSignals).not.toHaveBeenCalled();
  });

  it("403s a scoped key", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ ...okKey, scopeNodeId: "n1" });
    const res = await GET(get("", "lls_scoped"));
    expect(res.status).toBe(403);
    expect(mockSignals).not.toHaveBeenCalled();
  });

  it("returns the key user's signals, default 7 days, clamped", async () => {
    mockValidateApiKey.mockResolvedValue(okKey);
    mockSignals.mockResolvedValue({ days: 7, totals: {} });
    const res = await GET(get("", "lls_ok"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ days: 7, totals: {} });
    expect(mockSignals.mock.calls[0]?.[1]).toBe("user-1");
    expect(mockSignals.mock.calls[0]?.[2]).toBe(7);
    await GET(get("?days=500", "lls_ok"));
    expect(mockSignals.mock.calls[1]?.[2]).toBe(90);
  });

  it("view=candidates returns contradicted records", async () => {
    mockValidateApiKey.mockResolvedValue(okKey);
    mockCandidates.mockResolvedValue([{ id: "m1" }]);
    const res = await GET(get("?view=candidates&days=30", "lls_ok"));
    expect(await res.json()).toEqual({ days: 30, candidates: [{ id: "m1" }] });
    expect(mockCandidates.mock.calls[0]?.slice(1)).toEqual(["user-1", 30]);
    expect(mockSignals).not.toHaveBeenCalled();
  });

  it("500s when the read throws", async () => {
    mockValidateApiKey.mockResolvedValue(okKey);
    mockSignals.mockRejectedValue(new Error("boom"));
    const res = await GET(get("", "lls_ok"));
    expect(res.status).toBe(500);
  });
});
