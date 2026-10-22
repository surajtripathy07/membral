import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockGetUser = vi.fn();
const mockGenerateApiKey = vi.fn();

// code_projects validation chain: from("code_projects").select().eq().eq().single()
const mockProjSingle = vi.fn();
const mockProjEq2 = vi.fn(() => ({ single: mockProjSingle }));
const mockProjEq1 = vi.fn(() => ({ eq: mockProjEq2 }));
const mockProjSelect = vi.fn(() => ({ eq: mockProjEq1 }));

const mockFrom = vi.fn((table: string) => {
  if (table === "code_projects") return { select: mockProjSelect };
  return {};
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: mockFrom,
  })),
}));

vi.mock("@/lib/api-keys", () => ({
  generateApiKey: (...args: unknown[]) => mockGenerateApiKey(...args),
}));

// Limiter stubbed to always allow (429 path covered in the search route test).
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

function makeRequest(body: unknown | undefined, token?: string): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["authorization"] = `Bearer ${token}`;
  return new NextRequest("http://localhost:3000/api/keys", {
    method: "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("POST /api/keys — area-scoped keys (issue #83)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    mockGenerateApiKey.mockResolvedValue("lls_generated");
  });

  it("401 without an auth header", async () => {
    const res = await POST(makeRequest({}));
    expect(res.status).toBe(401);
    expect(mockGenerateApiKey).not.toHaveBeenCalled();
  });

  it("unscoped by default: no body -> generateApiKey(userId, null)", async () => {
    const res = await POST(makeRequest(undefined, "jwt"));
    expect(res.status).toBe(200);
    expect(mockGenerateApiKey).toHaveBeenCalledWith("user-1", null, null);
    const body = await res.json();
    expect(body).toEqual({ api_key: "lls_generated", scope_node_id: null, scope_code_project_id: null });
  });

  it("explicit null scope stays unscoped", async () => {
    await POST(makeRequest({ scope_node_id: null }, "jwt"));
    expect(mockGenerateApiKey).toHaveBeenCalledWith("user-1", null, null);
  });

  it("life-area scoped keys are no longer supported -> 400, no key minted", async () => {
    const res = await POST(makeRequest({ scope_node_id: "area-1" }, "jwt"));
    expect(res.status).toBe(400);
    expect(mockGenerateApiKey).not.toHaveBeenCalled();
  });

  it("rejects a non-string scope_node_id", async () => {
    const res = await POST(makeRequest({ scope_node_id: 42 }, "jwt"));
    expect(res.status).toBe(400);
    expect(mockGenerateApiKey).not.toHaveBeenCalled();
  });
});

describe("POST /api/keys — code-project-scoped keys (ADR 0021 Q7)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    mockGenerateApiKey.mockResolvedValue("lls_generated");
  });

  it("a valid own code project is accepted and persisted as the scope", async () => {
    mockProjSingle.mockResolvedValueOnce({ data: { id: "proj-1" }, error: null });
    const res = await POST(makeRequest({ scope_code_project_id: "proj-1" }, "jwt"));
    expect(res.status).toBe(200);
    // Validation constrains by the CALLER's user_id — never trusts the body's ownership.
    expect(mockProjEq1).toHaveBeenCalledWith("id", "proj-1");
    expect(mockProjEq2).toHaveBeenCalledWith("user_id", "user-1");
    expect(mockGenerateApiKey).toHaveBeenCalledWith("user-1", null, "proj-1");
    const body = await res.json();
    expect(body).toEqual({ api_key: "lls_generated", scope_node_id: null, scope_code_project_id: "proj-1" });
  });

  it("ATTACK: scoping to a code project that is not the caller's -> 400, no key minted", async () => {
    mockProjSingle.mockResolvedValueOnce({ data: null, error: { message: "No rows" } });
    const res = await POST(makeRequest({ scope_code_project_id: "someone-elses-proj" }, "jwt"));
    expect(res.status).toBe(400);
    expect(mockGenerateApiKey).not.toHaveBeenCalled();
  });

  it("rejects a non-string scope_code_project_id", async () => {
    const res = await POST(makeRequest({ scope_code_project_id: 42 }, "jwt"));
    expect(res.status).toBe(400);
    expect(mockGenerateApiKey).not.toHaveBeenCalled();
  });

  it("ATTACK: single-scope XOR — BOTH scopes set is rejected 400 BEFORE any DB lookup or key mint", async () => {
    const res = await POST(makeRequest({ scope_node_id: "area-1", scope_code_project_id: "proj-1" }, "jwt"));
    expect(res.status).toBe(400);
    // Rejected up front — no project lookup, and no key is minted.
    expect(mockProjSelect).not.toHaveBeenCalled();
    expect(mockGenerateApiKey).not.toHaveBeenCalled();
  });

  it("code-project scope leaves the area scope null (never both persisted)", async () => {
    mockProjSingle.mockResolvedValueOnce({ data: { id: "proj-1" }, error: null });
    await POST(makeRequest({ scope_code_project_id: "proj-1" }, "jwt"));
    expect(mockGenerateApiKey).toHaveBeenCalledWith("user-1", null, "proj-1");
  });
});
