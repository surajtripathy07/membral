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
const mockGet = vi.fn();
vi.mock("@/lib/memory/served-used", async () => {
  const actual = await vi.importActual<typeof import("@/lib/memory/served-used")>("@/lib/memory/served-used");
  return { ...actual, getServedAndUsed: (...args: unknown[]) => mockGet(...args) };
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { GET } from "../route";

function get(query = "", token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest(`http://localhost:3000/api/memory/served-used${query}`, { headers });
}

describe("GET /api/memory/served-used", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue({ allowed: true });
  });

  it("401s without a bearer and reads nothing", async () => {
    const res = await GET(get());
    expect(res.status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("401s on an invalid key", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: false });
    const res = await GET(get("", "lls_bad"));
    expect(res.status).toBe(401);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("403s a scoped key", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: "n1",
      scopeCodeProjectId: null,
    });
    const res = await GET(get("", "lls_scoped"));
    expect(res.status).toBe(403);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("returns the summary for the key's user, default 7 days, clamped days", async () => {
    const summary = {
      days: 7,
      since: "x",
      totals: { served: 1, used: 1, ignored: 0, pending: 0, unlinked: 0 },
      surfaces: [],
    };
    mockGet.mockResolvedValue(summary);
    mockValidateApiKey.mockResolvedValue({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    const res = await GET(get("", "lls_ok"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(summary);
    expect(mockGet.mock.calls[0]?.[1]).toBe("user-1");
    expect(mockGet.mock.calls[0]?.[2]).toBe(7);
    await GET(get("?days=9999", "lls_ok"));
    expect(mockGet.mock.calls[1]?.[2]).toBe(90);
  });

  it("500s when the read throws", async () => {
    mockGet.mockRejectedValue(new Error("boom"));
    mockValidateApiKey.mockResolvedValue({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    const res = await GET(get("", "lls_ok"));
    expect(res.status).toBe(500);
  });
});
