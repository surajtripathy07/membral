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

const mockLoad = vi.fn();
const mockUpsert = vi.fn();
vi.mock("@/lib/memory/branch-state", async () => {
  const actual = await vi.importActual<typeof import("@/lib/memory/branch-state")>("@/lib/memory/branch-state");
  return {
    ...actual,
    loadRefsToCheck: (...args: unknown[]) => mockLoad(...args),
    upsertBranchState: (...args: unknown[]) => mockUpsert(...args),
  };
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { GET, POST } from "../route";

const P1 = "11111111-1111-4111-8111-111111111111";
const A1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";

function get(query = "", token?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest(`http://localhost:3000/api/memory/branch-state${query}`, { method: "GET", headers });
}
function post(body: unknown, token?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest("http://localhost:3000/api/memory/branch-state", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const unscopedKey = () =>
  mockValidateApiKey.mockResolvedValueOnce({
    valid: true,
    userId: "user-1",
    scopeNodeId: null,
    scopeCodeProjectId: null,
  });

const validBody = {
  checked_at: "2026-09-26T17:30:00.000Z",
  results: [
    {
      code_project_id: P1,
      branch: "feat-1",
      default_branch: "main",
      last_seen_sha: A1,
      merged_into_default: false,
      sha_superseded_by: null,
      branch_gone: false,
    },
  ],
};

describe("/api/memory/branch-state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue({ allowed: true, retryAfter: 0, remaining: 5 });
  });

  it("GET/POST return 401 without auth and never touch the store", async () => {
    expect((await GET(get())).status).toBe(401);
    expect((await POST(post(validBody))).status).toBe(401);
    expect(mockLoad).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("a scoped key is refused with 403 on both verbs", async () => {
    mockValidateApiKey.mockResolvedValue({ valid: true, userId: "user-1", scopeNodeId: null, scopeCodeProjectId: P1 });
    expect((await GET(get("", "lls_scoped"))).status).toBe(403);
    expect((await POST(post(validBody, "lls_scoped"))).status).toBe(403);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  it("GET plans refs to check for the caller with the clamped window and repo filter", async () => {
    unscopedKey();
    mockLoad.mockResolvedValueOnce([
      { codeProjectId: P1, repoIdentity: "x", paths: [], shas: [], branches: [], openRefs: [] },
    ]);
    const res = await GET(get("?days=500&repo=/home/dev/src/billing", "lls_ok"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      checked_window_days: 90,
      repos: [{ codeProjectId: P1, repoIdentity: "x", paths: [], shas: [], branches: [], openRefs: [] }],
    });
    expect(mockLoad).toHaveBeenCalledWith(expect.anything(), "user-1", { days: 90, repo: "/home/dev/src/billing" });
  });

  it("GET returns 429 when rate limited and 500 when the read fails", async () => {
    unscopedKey();
    mockEnforceRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 30, remaining: 0 });
    expect((await GET(get("", "lls_ok"))).status).toBe(429);

    unscopedKey();
    mockLoad.mockRejectedValueOnce(new Error("db down"));
    const res = await GET(get("", "lls_ok"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "refs-to-check read failed" });
  });

  it("POST validates the body with Zod (400 on malformed JSON or a bad result) and upserts a valid one", async () => {
    unscopedKey();
    expect((await POST(post("{ not json", "lls_ok"))).status).toBe(400);
    unscopedKey();
    const bad = await POST(post({ ...validBody, results: [{ ...validBody.results[0], branch: "" }] }, "lls_ok"));
    expect(bad.status).toBe(400);
    expect(mockUpsert).not.toHaveBeenCalled();

    unscopedKey();
    mockUpsert.mockResolvedValueOnce({ upserted: 1, rejected: 0 });
    const ok = await POST(post(validBody, "lls_ok"));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, upserted: 1, rejected: 0 });
    expect(mockUpsert).toHaveBeenCalledWith(expect.anything(), "user-1", validBody);
  });

  it("POST returns 500 when the upsert fails", async () => {
    unscopedKey();
    mockUpsert.mockRejectedValueOnce(new Error("boom"));
    const res = await POST(post(validBody, "lls_ok"));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "branch-state write failed" });
  });

  it("a JWT caller is accepted", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "jwt-user" } }, error: null });
    mockLoad.mockResolvedValueOnce([]);
    const res = await GET(get("", "eyJ.jwt.token"));
    expect(res.status).toBe(200);
    expect(mockLoad).toHaveBeenCalledWith(expect.anything(), "jwt-user", { days: 30, repo: null });
  });
});
