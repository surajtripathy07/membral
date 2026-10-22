import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRpc = vi.fn(() => Promise.resolve({ data: null, error: null })); // rate limiter fails open
const mockInsert = vi.fn((_row: Record<string, unknown>) => Promise.resolve({ data: null, error: null }));
const mockFrom = vi.fn((_table: string) => ({ insert: mockInsert }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ rpc: mockRpc, from: mockFrom })),
}));

const mockValidateApiKey = vi.fn();
vi.mock("@/lib/api-keys", () => ({ validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args) }));

const mockBuild = vi.fn();
vi.mock("@/lib/memory/prompt-recall", () => ({ buildPromptRecall: (...args: unknown[]) => mockBuild(...args) }));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { POST } from "../route";

const URL = "http://localhost:3001/api/memory/prompt-recall";
function post(body: unknown, headers: Record<string, string> = { authorization: "Bearer lls_good" }): NextRequest {
  return new NextRequest(URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const PROMPT = "src/legacy/ledger-sync.ts still calls the vendor API inline, wrap it";
const LINES = [
  "Membral: past work related to this prompt (true when recorded; check live state yourself):",
  "[decision · 2d ago · session abcd1234] Keep src/legacy/ledger-sync.ts as the inline-call exception (#157)",
];

describe("POST /api/memory/prompt-recall", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRpc.mockResolvedValue({ data: null, error: null });
    mockInsert.mockImplementation(() => Promise.resolve({ data: null, error: null }));
    mockValidateApiKey.mockResolvedValue({ valid: true, userId: "user-1", scopeCodeProjectId: null });
  });

  it("401s without an Authorization header", async () => {
    const res = await POST(post({ prompt: PROMPT, repo: "x" }, {}));
    expect(res.status).toBe(401);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it("400s on malformed JSON and on a body without repo", async () => {
    expect((await POST(post("{nope"))).status).toBe(400);
    expect((await POST(post({ prompt: PROMPT }))).status).toBe(400);
    expect(mockBuild).not.toHaveBeenCalled();
  });

  it("serves the lines and logs one prompt_hook event with the harness session, without the prompt", async () => {
    mockBuild.mockResolvedValueOnce({ lines: LINES, record_ids: ["rec-1"] });
    const res = await POST(post({ prompt: PROMPT, repo: "github.com/acme/app", session: "sess-abc" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      lines: LINES,
      record_ids: ["rec-1"],
      skipped: null,
      duration_ms: expect.any(Number),
    });
    expect(mockBuild).toHaveBeenCalledWith(expect.anything(), "user-1", null, {
      prompt: PROMPT,
      repo: "github.com/acme/app",
      session: "sess-abc",
    });
    expect(mockFrom).toHaveBeenCalledWith("memory_recall_events");
    expect(mockInsert).toHaveBeenCalledTimes(1);
    expect(mockInsert.mock.calls[0][0]).toMatchObject({
      tool: "memory_search",
      surface: "prompt_hook",
      harness_session_id: "sess-abc",
      record_ids: ["rec-1"],
      query: null,
    });
  });

  it("nothing served -> lines [], the skip reason and duration, and no recall event", async () => {
    mockBuild.mockResolvedValueOnce({ lines: [], record_ids: [], skipped: "timeout" });
    const res = await POST(post({ prompt: PROMPT, repo: "x" }));
    expect(await res.json()).toEqual({
      lines: [],
      record_ids: [],
      skipped: "timeout",
      duration_ms: expect.any(Number),
    });
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("the served line carries embedding_skipped and embed_deadline_ms (false when the lib reports nothing)", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const served = () =>
      logged.mock.calls
        .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
        .filter((l) => l.msg === "prompt recall served");
    mockBuild.mockResolvedValueOnce({ lines: LINES, record_ids: ["rec-1"], stages_ms: {} });
    await POST(post({ prompt: PROMPT, repo: "x" }));
    mockBuild.mockResolvedValueOnce({
      lines: LINES,
      record_ids: ["rec-1"],
      stages_ms: {},
      embedding_skipped: true,
      embed_deadline_ms: 1000,
      embedding_breaker: "open",
    });
    await POST(post({ prompt: PROMPT, repo: "x" }));
    const lines = served();
    logged.mockRestore();
    expect(lines[0]).toMatchObject({ embedding_skipped: false });
    expect(lines[0]).not.toHaveProperty("embed_deadline_ms");
    expect(lines[1]).toMatchObject({ embedding_skipped: true, embed_deadline_ms: 1000, embedding_breaker: "open" });
  });

  it("logs one structured line per request: records served with skipped null, or skipped timeout with zero", async () => {
    const logged = vi.spyOn(console, "log").mockImplementation(() => {});
    const served = () =>
      logged.mock.calls
        .map((c) => JSON.parse(String(c[0])) as Record<string, unknown>)
        .filter((l) => l.msg === "prompt recall served");
    mockBuild.mockResolvedValueOnce({
      lines: LINES,
      record_ids: ["rec-1"],
      stages_ms: { resolve_project: 12, embed_query: 300, search_rpc: 40, render: 1 },
    });
    await POST(post({ prompt: PROMPT, repo: "x" }));
    mockBuild.mockResolvedValueOnce({
      lines: [],
      record_ids: [],
      skipped: "timeout",
      stages_ms: { resolve_project: 30 },
      stage_at_timeout: "hop1_search:embed_query+anchor_leg",
    });
    await POST(post({ prompt: PROMPT, repo: "x" }));
    const lines = served();
    logged.mockRestore();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ skipped: null, records: 1, duration_ms: expect.any(Number) });
    expect(lines[1]).toMatchObject({ skipped: "timeout", records: 0, duration_ms: expect.any(Number) });
    // Per-stage timings: numeric on the served path (body_read, the lib's stages, recall_event); on the cap path the
    // stage in flight is named. Neither reaches the response body.
    const stages0 = lines[0].stages_ms as Record<string, unknown>;
    expect(Object.keys(stages0)).toEqual(
      expect.arrayContaining(["body_read", "resolve_project", "embed_query", "search_rpc", "render", "recall_event"]),
    );
    for (const v of Object.values(stages0)) expect(v).toEqual(expect.any(Number));
    expect(lines[0]).not.toHaveProperty("stage_at_timeout");
    // Which embedding provider/model served the vector; never a key or URL.
    expect(lines[0].embedding).toEqual({ provider: expect.any(String), model: expect.any(String) });
    expect(lines[1].stage_at_timeout).toBe("hop1_search:embed_query+anchor_leg");
    expect(lines[1].stages_ms).toMatchObject({ body_read: expect.any(Number), resolve_project: 30 });
  });

  it("passes a scoped key's project bound and drops a malformed session id", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: true, userId: "user-1", scopeCodeProjectId: "proj-1" });
    mockBuild.mockResolvedValueOnce({ lines: [], record_ids: [] });
    await POST(post({ prompt: PROMPT, repo: "x", session: "bad id with spaces" }));
    expect(mockBuild).toHaveBeenCalledWith(expect.anything(), "user-1", "proj-1", {
      prompt: PROMPT,
      repo: "x",
      session: null,
    });
  });

  it("passes the client's budget_ms through; absent stays absent (legacy client); out of range is a 400", async () => {
    mockBuild.mockResolvedValueOnce({ lines: [], record_ids: [] }).mockResolvedValueOnce({ lines: [], record_ids: [] });
    await POST(post({ prompt: PROMPT, repo: "x", budget_ms: 4000 }));
    expect(mockBuild.mock.calls[0][3]).toMatchObject({ clientBudgetMs: 4000 });
    await POST(post({ prompt: PROMPT, repo: "x" }));
    expect(mockBuild.mock.calls[1][3].clientBudgetMs).toBeUndefined();
    expect((await POST(post({ prompt: PROMPT, repo: "x", budget_ms: 100 }))).status).toBe(400);
    expect((await POST(post({ prompt: PROMPT, repo: "x", budget_ms: 20_000 }))).status).toBe(400);
    expect((await POST(post({ prompt: PROMPT, repo: "x", budget_ms: 1500.5 }))).status).toBe(400);
    expect(mockBuild).toHaveBeenCalledTimes(2);
  });

  it("line_max: passed through; out of range is not a 400 (clamped downstream); a non-integer falls back to absent", async () => {
    mockBuild.mockResolvedValue({ lines: [], record_ids: [] });
    const before = mockBuild.mock.calls.length;
    expect((await POST(post({ prompt: PROMPT, repo: "x", line_max: 720 }))).status).toBe(200);
    expect((await POST(post({ prompt: PROMPT, repo: "x", line_max: 5000 }))).status).toBe(200);
    expect((await POST(post({ prompt: PROMPT, repo: "x", line_max: 12.5 }))).status).toBe(200);
    expect((await POST(post({ prompt: PROMPT, repo: "x", line_max: "wide" }))).status).toBe(200);
    const calls = mockBuild.mock.calls.slice(before).map((c) => c[3].lineMax);
    expect(calls).toEqual([720, 5000, undefined, undefined]);
  });

  it("exclude_record_ids: passed through as excludeRecordIds; absent or empty stays absent; non-uuid or over 100 is a 400", async () => {
    const A = "0a1b2c3d-1111-4222-8333-444455556666";
    mockBuild.mockResolvedValue({ lines: [], record_ids: [], skipped: "no_match" });
    await POST(post({ prompt: PROMPT, repo: "acme/app", exclude_record_ids: [A] }));
    expect(mockBuild.mock.calls[0][3]).toMatchObject({ excludeRecordIds: [A] });
    await POST(post({ prompt: PROMPT, repo: "acme/app" }));
    await POST(post({ prompt: PROMPT, repo: "acme/app", exclude_record_ids: [] }));
    expect(mockBuild.mock.calls[1][3]).not.toHaveProperty("excludeRecordIds");
    expect(mockBuild.mock.calls[2][3]).not.toHaveProperty("excludeRecordIds");
    expect((await POST(post({ prompt: PROMPT, repo: "acme/app", exclude_record_ids: ["nope"] }))).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, () => A);
    expect((await POST(post({ prompt: PROMPT, repo: "acme/app", exclude_record_ids: tooMany }))).status).toBe(400);
  });

  it("an area-scoped key gets an empty answer and no search", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: "area-1",
      scopeCodeProjectId: null,
    });
    const res = await POST(post({ prompt: PROMPT, repo: "x" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lines: [], record_ids: [], skipped: "area_scoped_key", duration_ms: 0 });
    expect(mockBuild).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("a failed recall-event write never fails the response", async () => {
    mockBuild.mockResolvedValueOnce({ lines: LINES, record_ids: ["rec-1"] });
    mockInsert.mockImplementationOnce(() => Promise.reject(new Error("db down")));
    const res = await POST(post({ prompt: PROMPT, repo: "x" }));
    expect(res.status).toBe(200);
  });

  it("passes a continuation through and returns its mode; a bad harness or id is a 400", async () => {
    const id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
    mockBuild.mockResolvedValueOnce({ lines: LINES, record_ids: ["rec-1"], mode: "continuation", self_records: 1 });
    const res = await POST(
      post({ prompt: PROMPT, repo: "x", continuation: { source_session_id: id, harness: "claude-code" } }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ mode: "continuation", self_records: 1, skipped: null });
    expect(mockBuild.mock.calls[0][3]).toMatchObject({ continuation: { sourceSessionId: id, harness: "claude-code" } });
    expect(
      (await POST(post({ prompt: PROMPT, repo: "x", continuation: { source_session_id: id, harness: "codex" } })))
        .status,
    ).toBe(400);
    expect(
      (
        await POST(
          post({ prompt: PROMPT, repo: "x", continuation: { source_session_id: "a b", harness: "claude-code" } }),
        )
      ).status,
    ).toBe(400);
  });
});
