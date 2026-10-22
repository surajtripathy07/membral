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
const mockUpsert = vi.fn();
vi.mock("@/lib/memory/write", () => ({
  upsertQuestionnaire: (...args: unknown[]) => mockUpsert(...args),
}));

const mockGround = vi.fn();
vi.mock("@/lib/memory/questionnaire-ground", () => ({
  groundSelfReport: (...args: unknown[]) => mockGround(...args),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { POST } from "../route";

function post(body: unknown, token = "lls_ok"): NextRequest {
  return new NextRequest("http://localhost:3000/api/memory/questionnaire", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const okKey = { valid: true, userId: "user-1", scopeNodeId: null, scopeCodeProjectId: null };
const LINE = "- [decision] Queue retries use backoff";

describe("POST /api/memory/questionnaire", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnforceRateLimit.mockResolvedValue({ allowed: true });
    mockValidateApiKey.mockResolvedValue(okKey);
    mockUpsert.mockResolvedValue(true);
    mockGround.mockImplementation(async (_s: unknown, _u: string, _id: string, answers: unknown) => ({
      answers,
      kept: 1,
      dropped: 1,
    }));
  });

  it("stores the self-report with its order, dropping items without a turn pointer", async () => {
    const res = await POST(
      post({
        session: "sess-1",
        order: ["q3", "q1", "q4", "q2"],
        answers: { q1: [{ line: LINE, turn: "switched retries to backoff" }, { line: LINE }], q2: [] },
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stored: true, items: 1 });
    const [, userId, w] = mockUpsert.mock.calls[0] as [unknown, string, Record<string, unknown>];
    expect(userId).toBe("user-1");
    expect(w).toMatchObject({ sourceSessionId: "sess-1", source: "self", order: ["q3", "q1", "q4", "q2"] });
  });

  it("stores what the grounding step returns (redacted, grounded), not the raw answers", async () => {
    mockGround.mockResolvedValueOnce({
      answers: { q1: [{ line: "[redacted]", turn: "kept turn text" }], q2: [], q3: [], q4: [] },
      kept: 1,
      dropped: 2,
    });
    const res = await POST(
      post({
        session: "sess-1",
        order: ["q1", "q2", "q3", "q4"],
        answers: { q1: [{ line: "token sk-live-abcdefghijklmnop", turn: "not in the session at all" }] },
      }),
    );
    expect(await res.json()).toEqual({ stored: true, items: 1 });
    expect(mockGround).toHaveBeenCalledWith(expect.anything(), "user-1", "sess-1", expect.anything());
    const w = mockUpsert.mock.calls[0]?.[2] as { answers: { q1: Array<{ line: string }> } };
    expect(w.answers.q1[0]?.line).toBe("[redacted]");
  });

  it("rejects a bad body and malformed answers without storing", async () => {
    expect((await POST(post("not json"))).status).toBe(400);
    expect((await POST(post({ session: "s", order: ["q1"], answers: {} }))).status).toBe(400);
    expect((await POST(post({ session: "s", order: ["q1", "q2", "q3", "q4"], answers: { q1: "x" } }))).status).toBe(
      422,
    );
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it("needs a valid key", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: false });
    expect((await POST(post({}))).status).toBe(401);
  });
});
