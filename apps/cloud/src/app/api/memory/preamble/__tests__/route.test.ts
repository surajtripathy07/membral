import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRpc = vi.fn(() => Promise.resolve({ data: null, error: null })); // rate limiter fails open (see rate-limit.ts)
// #361: the route logs one memory_recall_events row per served preamble.
const mockInsert = vi.fn((_row: Record<string, unknown>) => Promise.resolve({ data: null, error: null }));
const mockFrom = vi.fn((_table: string) => ({ insert: mockInsert }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ rpc: mockRpc, from: mockFrom })),
}));

const mockValidateApiKey = vi.fn();
vi.mock("@/lib/api-keys", () => ({ validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args) }));

const mockBuildPreamble = vi.fn();
vi.mock("@/lib/memory/preamble", () => ({ buildPreamble: (...args: unknown[]) => mockBuildPreamble(...args) }));
const mockSelf = vi.fn();
vi.mock("@/lib/memory/prompt-recall", () => ({
  buildSessionStartSelfRecall: (...args: unknown[]) => mockSelf(...args),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { GET } from "../route";

function makeRequest(url: string, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(url, { headers });
}

describe("GET /api/memory/preamble", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockResolvedValue({ data: null, error: null });
    mockInsert.mockImplementation(() => Promise.resolve({ data: null, error: null }));
  });

  it("401s without an Authorization header", async () => {
    const res = await GET(makeRequest("http://localhost:3001/api/memory/preamble?repo=x"));
    expect(res.status).toBe(401);
    expect(mockBuildPreamble).not.toHaveBeenCalled();
  });

  it("401s for a non-lls_ token", async () => {
    const res = await GET(
      makeRequest("http://localhost:3001/api/memory/preamble?repo=x", { authorization: "Bearer sometoken" }),
    );
    expect(res.status).toBe(401);
    expect(mockValidateApiKey).not.toHaveBeenCalled();
  });

  it("401s for an invalid lls_ key", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: false });
    const res = await GET(
      makeRequest("http://localhost:3001/api/memory/preamble?repo=x", { authorization: "Bearer lls_bad" }),
    );
    expect(res.status).toBe(401);
  });

  it("400s when repo is missing", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: true, userId: "user-1", scopeCodeProjectId: null });
    const res = await GET(
      makeRequest("http://localhost:3001/api/memory/preamble", { authorization: "Bearer lls_good" }),
    );
    expect(res.status).toBe(400);
    expect(mockBuildPreamble).not.toHaveBeenCalled();
  });

  it("returns plain text lines by default and JSON when Accept: application/json", async () => {
    mockValidateApiKey.mockResolvedValue({ valid: true, userId: "user-1", scopeCodeProjectId: null });
    mockBuildPreamble.mockResolvedValue({
      lines: [
        "Membral memory for acme/repo (harness-injected context, not a user message).",
        "Tools: a, b, c, d.",
        "recall_token: v1.x.y",
      ],
      recall_token: "v1.x.y",
      open_blockers: [],
    });

    const textRes = await GET(
      makeRequest("http://localhost:3001/api/memory/preamble?repo=github.com/acme/repo", {
        authorization: "Bearer lls_good",
      }),
    );
    expect(textRes.headers.get("content-type")).toContain("text/plain");
    const text = await textRes.text();
    expect(text.split("\n")).toHaveLength(3);

    const jsonRes = await GET(
      makeRequest("http://localhost:3001/api/memory/preamble?repo=github.com/acme/repo", {
        authorization: "Bearer lls_good",
        accept: "application/json",
      }),
    );
    const json = await jsonRes.json();
    expect(json).toEqual({
      lines: expect.any(Array),
      recall_token: "v1.x.y",
      open_blockers: [],
    });
  });

  it("passes the code-scoped key's bound project through to buildPreamble", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: true, userId: "user-1", scopeCodeProjectId: "proj-1" });
    mockBuildPreamble.mockResolvedValueOnce({ lines: [], recall_token: "t", open_blockers: [] });

    await GET(
      makeRequest("http://localhost:3001/api/memory/preamble?repo=x&branch=main&head_sha=abc", {
        authorization: "Bearer lls_good",
      }),
    );

    expect(mockBuildPreamble).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      { repo: "x", branch: "main", head_sha: "abc", session: null },
      "proj-1",
    );
  });

  const served = {
    lines: ["Membral memory for acme/repo.", "- [decision] key the cache", "Tools: a.", "recall_token: v1.x.y"],
    recall_token: "v1.x.y",
    open_blockers: [],
    record_ids: ["rec-a", "rec-b"],
  };

  it("records one surface='preamble' event with the rendered record ids and the session param (#361)", async () => {
    mockValidateApiKey.mockResolvedValue({ valid: true, userId: "user-1", scopeCodeProjectId: null });
    mockBuildPreamble.mockResolvedValue(served);

    const res = await GET(
      makeRequest("http://localhost:3001/api/memory/preamble?repo=x&session=0f6c1d2e-aaaa", {
        authorization: "Bearer lls_good",
        accept: "application/json",
      }),
    );

    expect(res.status).toBe(200);
    expect(mockFrom).toHaveBeenCalledWith("memory_recall_events");
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][0]).toEqual({
      user_id: "user-1",
      tool: "preamble",
      surface: "preamble",
      query: null,
      record_ids: ["rec-a", "rec-b"],
      recall_token: "v1.x.y",
      code_session_id: null,
      harness_session_id: "0f6c1d2e-aaaa",
    });
    // The response body does not grow a record_ids field.
    expect(await res.json()).toEqual({ lines: served.lines, recall_token: "v1.x.y", open_blockers: [] });
  });

  it("ignores a malformed or oversized session param", async () => {
    mockValidateApiKey.mockResolvedValue({ valid: true, userId: "user-1", scopeCodeProjectId: null });
    mockBuildPreamble.mockResolvedValue(served);
    for (const bad of ["a b", "x".repeat(201), "<script>"]) {
      await GET(
        makeRequest(`http://localhost:3001/api/memory/preamble?repo=x&session=${encodeURIComponent(bad)}`, {
          authorization: "Bearer lls_good",
        }),
      );
    }
    expect(mockInsert).toHaveBeenCalledTimes(3);
    for (const call of mockInsert.mock.calls) expect(call[0].harness_session_id).toBeNull();
  });

  it("a logging failure (error result or throw) never changes the response", async () => {
    mockValidateApiKey.mockResolvedValue({ valid: true, userId: "user-1", scopeCodeProjectId: null });
    mockBuildPreamble.mockResolvedValue(served);
    const req = () =>
      GET(
        makeRequest("http://localhost:3001/api/memory/preamble?repo=x&session=s1", {
          authorization: "Bearer lls_good",
        }),
      );

    const baseline = await req();
    const baselineText = await baseline.text();

    mockInsert.mockImplementationOnce(() => Promise.resolve({ data: null, error: { message: "boom" } } as never));
    const withError = await req();
    expect(withError.status).toBe(200);
    expect(await withError.text()).toBe(baselineText);

    mockInsert.mockImplementationOnce(() => {
      throw new Error("connection reset");
    });
    const withThrow = await req();
    expect(withThrow.status).toBe(200);
    expect(await withThrow.text()).toBe(baselineText);
  });

  it("self=compact with a session: self_lines beside the preamble, ids logged; absent self: no lookup, no field", async () => {
    mockValidateApiKey.mockResolvedValue({ valid: true, userId: "user-1", scopeCodeProjectId: null });
    mockBuildPreamble.mockResolvedValue(served);
    mockSelf.mockResolvedValueOnce({ lines: ["This session so far", "- self"], record_ids: ["self-1"] });
    const json = { authorization: "Bearer lls_good", accept: "application/json" };
    const res = await GET(
      makeRequest("http://localhost:3001/api/memory/preamble?repo=x&session=s1&self=compact", json),
    );
    expect(await res.json()).toMatchObject({ lines: served.lines, self_lines: ["This session so far", "- self"] });
    expect(mockSelf).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      null,
      { sourceSessionId: "s1", harness: "claude-code" },
      { lineMax: undefined },
    );
    expect(mockInsert.mock.calls[0][0].record_ids).toEqual(["rec-a", "rec-b", "self-1"]);

    mockSelf.mockClear();
    const plain = await GET(makeRequest("http://localhost:3001/api/memory/preamble?repo=x&session=s1", json));
    expect(await plain.json()).not.toHaveProperty("self_lines");
    const noSession = await GET(makeRequest("http://localhost:3001/api/memory/preamble?repo=x&self=resume", json));
    expect(await noSession.json()).not.toHaveProperty("self_lines");
    const otherSource = await GET(
      makeRequest("http://localhost:3001/api/memory/preamble?repo=x&session=s1&self=startup", json),
    );
    expect(await otherSource.json()).not.toHaveProperty("self_lines");
    expect(mockSelf).not.toHaveBeenCalled();
  });

  it("self=resume with a session serves its records; an area-scoped key serves nothing and does no lookup", async () => {
    mockBuildPreamble.mockResolvedValue(served);
    const json = { authorization: "Bearer lls_good", accept: "application/json" };
    mockValidateApiKey.mockResolvedValue({ valid: true, userId: "user-1", scopeCodeProjectId: null });
    mockSelf.mockResolvedValueOnce({ lines: ["This session so far", "- resumed"], record_ids: ["self-2"] });
    const res = await GET(makeRequest("http://localhost:3001/api/memory/preamble?repo=x&session=s2&self=resume", json));
    expect(await res.json()).toMatchObject({ self_lines: ["This session so far", "- resumed"] });
    expect(mockSelf).toHaveBeenCalledTimes(1);

    mockSelf.mockClear();
    mockValidateApiKey.mockResolvedValue({
      valid: true,
      userId: "user-1",
      scopeCodeProjectId: null,
      scopeNodeId: "node-1",
    });
    const scoped = await GET(
      makeRequest("http://localhost:3001/api/memory/preamble?repo=x&session=s2&self=compact", json),
    );
    expect(await scoped.json()).toMatchObject({ self_lines: [], self_skipped: null });
    expect(mockSelf).not.toHaveBeenCalled();
  });
});
