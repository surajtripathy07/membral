import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

// Goal 2026-09-24 B1: the memory extraction trigger runs inside next/server's after().
// The real after() throws outside a Next request scope, so (same double as
// api/sync's route.test.ts) this captures each callback WITHOUT running it;
// flushAfter() drains them, standing in for "the platform ran the deferred
// work after the response".
const capturedAfterCallbacks: Array<() => unknown> = [];
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    // after() also takes a promise (the raw-unit queue's); wrap it so flushAfter() can await it.
    after: (cb: (() => unknown) | Promise<unknown>) => {
      capturedAfterCallbacks.push(typeof cb === "function" ? cb : () => cb);
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
// sync_heartbeats: default success (goal 2026-07-26 step 2, #63/#58) — the
// route upserts a 'code' heartbeat on any successful import batch.
const mockHeartbeatUpsert = vi.fn();
// project_alias_seed (migration 060/063, W7/D8): default success — the
// route fires this RPC fire-and-forget after any successful import batch.
const mockRpc = vi.fn(
  (): Promise<{ data: unknown; error: { message: string } | null }> => Promise.resolve({ data: null, error: null }),
);
// Read-only chains for the parent requeue lookup (code_sessions, memory_extraction_queue).
const tableReads: Record<string, (() => unknown) | undefined> = {};
function readChain(data: unknown[]): unknown {
  const chain = Promise.resolve({ data, error: null });
  return Object.assign(chain, { select: () => chain, eq: () => chain, in: () => chain });
}
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => (table === "sync_heartbeats" ? { upsert: mockHeartbeatUpsert } : tableReads[table]?.()),
    rpc: mockRpc,
  })),
}));

const mockValidateApiKey = vi.fn();
vi.mock("@/lib/api-keys", () => ({
  validateApiKey: (...args: unknown[]) => mockValidateApiKey(...args),
}));

const mockImportCodeSession = vi.fn();
vi.mock("@/lib/code-sessions/import", () => ({
  importCodeSession: (...args: unknown[]) => mockImportCodeSession(...args),
}));

// ADR 0039 (W6/D7) — mocked the same way as importCodeSession/synthesize
// above, both to keep this route's own test isolated from
// mirror-conversations.ts's own (separately tested) behavior, and to avoid
// noisy "mirror had per-session errors" logs from the mirror's real
// implementation trying to query a `from()` mock this file never wires up
// for code_sessions/code_session_turns/conversations.
const mockMirror = vi.fn();
vi.mock("@/lib/code-sessions/mirror-conversations", () => ({
  mirrorCodeSessionsToConversations: (...args: unknown[]) => mockMirror(...args),
}));

const mockSynthesize = vi.fn();
vi.mock("@/lib/code-sessions/synthesize", () => ({
  synthesizeCodeDimensionForUser: (...args: unknown[]) => mockSynthesize(...args),
}));

// Goal 2026-09-24 review B1: the route only enqueues imported sessions and
// schedules ONE extract-next trigger in after(); the queue and chain are
// exercised for real in memory/__tests__/extraction-queue.test.ts.
const mockEnqueue = vi.fn();
vi.mock("@/lib/memory/extraction-queue", () => ({
  enqueueMemoryExtraction: (...args: unknown[]) => mockEnqueue(...args),
  MEMORY_QUEUE_TABLE: "memory_extraction_queue",
}));
const mockTrigger = vi.fn();
vi.mock("@/lib/memory/extraction-trigger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/memory/extraction-trigger")>();
  return { ...actual, triggerMemoryExtraction: (...args: unknown[]) => mockTrigger(...args) };
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { POST } from "../route";

function validSession(overrides: Record<string, unknown> = {}) {
  return {
    source: "claude-code",
    sourceSessionId: "session-1",
    contentHash: "hash-1",
    repo: { remoteUrl: "https://github.com/acme/webapp.git" },
    startedAt: "2026-07-01T10:00:00.000Z",
    endedAt: "2026-07-01T10:05:00.000Z",
    turns: [{ idx: 0, role: "user", kind: "prose", text: "hi", ts: "2026-07-01T10:00:00.000Z" }],
    filesTouched: [],
    toolCounts: {},
    ...overrides,
  };
}

function makeRequest(body: unknown, opts: { token?: string; headers?: Record<string, string> } = {}): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.token) headers["authorization"] = `Bearer ${opts.token}`;
  return new NextRequest("http://localhost:3000/api/code-sessions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /api/code-sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedAfterCallbacks.length = 0;
    mockHeartbeatUpsert.mockResolvedValue({ error: null });
    mockEnqueue.mockResolvedValue(undefined);
    mockTrigger.mockResolvedValue(true);
    mockMirror.mockResolvedValue({
      processed: 0,
      inserted: 0,
      updated: 0,
      skippedUnchanged: 0,
      skippedEmpty: 0,
      errors: [],
      totalChars: 0,
      truncatedCount: 0,
      sessions: [],
    });
  });

  it("returns 401 when no auth header", async () => {
    const req = makeRequest({ sessions: [validSession()] });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid Supabase JWT", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: null }, error: { message: "bad" } });
    const req = makeRequest({ sessions: [validSession()] }, { token: "bad-jwt" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 401 for an invalid lls_ API key", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: false });
    const req = makeRequest({ sessions: [validSession()] }, { token: "lls_bad" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 429 when the API key is rate-limited", async () => {
    mockValidateApiKey.mockResolvedValueOnce({ valid: false, rateLimited: true, retryAfter: 42 });
    const req = makeRequest({ sessions: [validSession()] }, { token: "lls_bad" });
    const res = await POST(req);
    expect(res.status).toBe(429);
  });

  it("returns 429 with Retry-After when the per-user codeSessions rate limit is hit (issue #127)", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-jwt" } }, error: null });
    mockRpc.mockResolvedValueOnce({ data: { allowed: false, retry_after: 17, remaining: 0 }, error: null });

    const req = makeRequest({ sessions: [validSession()] }, { token: "good-jwt" });
    const res = await POST(req);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("17");
    expect(mockImportCodeSession).not.toHaveBeenCalled();
  });

  it("returns 403 for an area-scoped key (issue #83)", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: "area-123",
      scopeCodeProjectId: null,
    });
    const req = makeRequest({ sessions: [validSession()] }, { token: "lls_scoped" });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(mockImportCodeSession).not.toHaveBeenCalled();
  });

  it("returns 403 for a code-project-scoped key (ADR 0021 Q7)", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: "proj-123",
    });
    const req = makeRequest({ sessions: [validSession()] }, { token: "lls_scoped" });
    const res = await POST(req);
    expect(res.status).toBe(403);
    expect(mockImportCodeSession).not.toHaveBeenCalled();
  });

  it("accepts an unscoped lls_ key and imports sessions", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    mockImportCodeSession.mockResolvedValueOnce({ status: "imported", sessionId: "s-1" });
    mockEnqueue.mockResolvedValueOnce(1);

    const req = makeRequest({ sessions: [validSession()] }, { token: "lls_ok" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ imported: 1, skipped: 0, total: 1, errors: [], open_supported: true });
    expect(mockImportCodeSession).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.objectContaining(validSession()),
      undefined,
      // B2: unit embedding is scheduled with after(), never awaited in the response.
      expect.objectContaining({ deferRawUnits: expect.any(Function) }),
    );
    // ADR 0039 (W6/D7): an imported session feeds the conversations mirror.
    expect(mockMirror).toHaveBeenCalledWith(expect.anything(), "user-1", { sessionIds: ["s-1"] });
    // Review B1: an imported session is queued for memory extraction.
    expect(mockEnqueue).toHaveBeenCalledWith(expect.anything(), "user-1", { requeue: ["s-1"] });
    await flushAfter();
    expect(mockTrigger).toHaveBeenCalledWith("user-1", "http://localhost:3000");
  });

  it("also mirrors a skipped-unchanged session (its conversations row may still need catching up)", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    mockImportCodeSession.mockResolvedValueOnce({ status: "skipped", sessionId: "s-1" });

    const req = makeRequest({ sessions: [validSession()] }, { token: "lls_ok" });
    await POST(req);
    expect(mockMirror).toHaveBeenCalledWith(expect.anything(), "user-1", { sessionIds: ["s-1"] });
    // A "skipped" (unchanged) session has nothing new to extract: no
    // enqueue (the daily cron reconciles any row a failed enqueue missed,
    // R3-M1), so nothing is triggered.
    await flushAfter();
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("does not call the mirror when every session errored", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    mockImportCodeSession.mockResolvedValueOnce({ status: "error", error: "db exploded" });

    const req = makeRequest({ sessions: [validSession()] }, { token: "lls_ok" });
    await POST(req);
    expect(mockMirror).not.toHaveBeenCalled();
  });

  it("never fails the import response when the mirror throws", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    mockImportCodeSession.mockResolvedValueOnce({ status: "imported", sessionId: "s-1" });
    mockMirror.mockRejectedValueOnce(new Error("mirror boom"));

    const req = makeRequest({ sessions: [validSession()] }, { token: "lls_ok" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ imported: 1, skipped: 0, total: 1, errors: [], open_supported: true });
  });

  describe("memory extraction queue (goal 2026-09-24 review B1)", () => {
    function authOk() {
      mockValidateApiKey.mockResolvedValueOnce({
        valid: true,
        userId: "user-1",
        scopeNodeId: null,
        scopeCodeProjectId: null,
      });
    }

    it("queues every imported session id in ONE enqueue and schedules ONE trigger for the user", async () => {
      authOk();
      mockEnqueue.mockResolvedValueOnce(2);
      mockImportCodeSession
        .mockResolvedValueOnce({ status: "imported", sessionId: "s-1" })
        .mockResolvedValueOnce({ status: "skipped", sessionId: "s-2" })
        .mockResolvedValueOnce({ status: "imported", sessionId: "s-3" });

      const req = makeRequest(
        {
          sessions: [
            validSession({ sourceSessionId: "s-1" }),
            validSession({ sourceSessionId: "s-2" }),
            validSession({ sourceSessionId: "s-3" }),
          ],
        },
        { token: "lls_ok" },
      );
      await POST(req);
      await flushAfter();

      expect(mockEnqueue).toHaveBeenCalledTimes(1);
      // s-2 (unchanged) is not queued.
      expect(mockEnqueue).toHaveBeenCalledWith(expect.anything(), "user-1", { requeue: ["s-1", "s-3"] });
      expect(mockTrigger).toHaveBeenCalledTimes(1);
    });

    it("an imported sub-agent re-queues its parent (the fold changed); a parent stuck at failed stays failed (N4)", async () => {
      authOk();
      mockEnqueue.mockResolvedValue(2);
      tableReads.code_sessions = () => readChain([{ id: "parent-a" }, { id: "parent-b" }]);
      tableReads.memory_extraction_queue = () => readChain([{ session_id: "parent-b" }]);
      mockImportCodeSession.mockResolvedValueOnce({ status: "imported", sessionId: "child-1" });
      try {
        const req = makeRequest(
          { sessions: [validSession({ sourceSessionId: "src-a:agent-1", parentSessionId: "src-a" })] },
          { token: "lls_ok" },
        );
        await POST(req);
        await flushAfter();
        expect(mockEnqueue).toHaveBeenCalledWith(expect.anything(), "user-1", { requeue: ["child-1", "parent-a"] });
      } finally {
        delete tableReads.code_sessions;
        delete tableReads.memory_extraction_queue;
      }
    });

    it("an unchanged batch neither queues nor triggers", async () => {
      authOk();
      mockImportCodeSession.mockResolvedValueOnce({ status: "skipped", sessionId: "s-1" });

      await POST(makeRequest({ sessions: [validSession()] }, { token: "lls_ok" }));
      await flushAfter();
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockTrigger).not.toHaveBeenCalled();
    });

    it("an empty heartbeat batch neither queues nor triggers", async () => {
      authOk();
      await POST(makeRequest({ sessions: [] }, { token: "lls_ok" }));
      await flushAfter();
      expect(mockEnqueue).not.toHaveBeenCalled();
      expect(mockTrigger).not.toHaveBeenCalled();
    });

    it("the trigger runs in after(), never before the response", async () => {
      authOk();
      mockImportCodeSession.mockResolvedValueOnce({ status: "imported", sessionId: "s-1" });
      mockEnqueue.mockResolvedValueOnce(1);

      const res = await POST(makeRequest({ sessions: [validSession()] }, { token: "lls_ok" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ imported: 1, skipped: 0, total: 1, errors: [], open_supported: true });
      expect(capturedAfterCallbacks).toHaveLength(1);
      expect(mockTrigger).not.toHaveBeenCalled();

      await flushAfter();
      expect(mockTrigger).toHaveBeenCalledWith("user-1", "http://localhost:3000");
    });

    it("R3-M1: an enqueue failure logs and the upload still succeeds with side effects run", async () => {
      authOk();
      const prevKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = "sk-test";
      mockSynthesize.mockResolvedValue(undefined);
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        mockImportCodeSession.mockResolvedValueOnce({ status: "imported", sessionId: "s-1" });
        mockEnqueue.mockRejectedValueOnce(new Error("relation memory_extraction_queue does not exist"));

        const res = await POST(makeRequest({ sessions: [validSession()] }, { token: "lls_ok" }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ imported: 1, skipped: 0, total: 1, errors: [], open_supported: true });
        // No trigger (nothing was queued) ...
        expect(capturedAfterCallbacks).toHaveLength(0);
        expect(mockTrigger).not.toHaveBeenCalled();
        // ... but every other side effect of the upload still ran.
        expect(mockMirror).toHaveBeenCalledWith(expect.anything(), "user-1", { sessionIds: ["s-1"] });
        expect(mockHeartbeatUpsert).toHaveBeenCalled();
        expect(mockSynthesize).toHaveBeenCalledWith("user-1");
        expect(mockRpc).toHaveBeenCalledWith("project_alias_seed", { p_user: "user-1" });
        // One [memory-extraction] fail line, ids and counts only.
        const lines = [...errSpy.mock.calls, ...logSpy.mock.calls]
          .map((c) => String(c[0]))
          .filter((l) => l.includes("[memory-extraction]"));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain('"reason":"enqueue_failed"');
        expect(lines[0]).toContain('"session_count":1');
      } finally {
        errSpy.mockRestore();
        logSpy.mockRestore();
        if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
        else process.env.OPENAI_API_KEY = prevKey;
      }
    });
  });

  it("raw-unit work goes through the queue and after(); flushing after() awaits it", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    const ran = vi.fn(async () => {});
    mockImportCodeSession.mockImplementationOnce(async (...args: unknown[]) => {
      const opts = args[4] as { deferRawUnits: (t: () => Promise<void>, id: string) => void };
      opts.deferRawUnits(ran, "s-queued");
      return { status: "imported", sessionId: "s-queued" };
    });
    mockEnqueue.mockResolvedValueOnce(1);
    const res = await POST(makeRequest({ sessions: [validSession()] }, { token: "lls_ok" }));
    expect(res.status).toBe(200);
    await flushAfter(); // the queue's promise was handed to after(); flushing awaits the task
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("accepts a Supabase JWT (dashboard session, parity with /api/sync)", async () => {
    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-jwt" } }, error: null });
    mockImportCodeSession.mockResolvedValueOnce({ status: "imported", sessionId: "s-1" });

    const req = makeRequest({ sessions: [validSession()] }, { token: "good-jwt" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockImportCodeSession).toHaveBeenCalledWith(
      expect.anything(),
      "user-jwt",
      expect.anything(),
      undefined,
      expect.anything(),
    );
  });

  it("forwards force:true from the request body to importCodeSession (issue #91 backfill)", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    mockImportCodeSession.mockResolvedValueOnce({ status: "imported", sessionId: "s-1" });

    const req = makeRequest({ sessions: [validSession()], force: true }, { token: "lls_ok" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(mockImportCodeSession).toHaveBeenCalledWith(
      expect.anything(),
      "user-1",
      expect.anything(),
      true,
      expect.anything(),
    );
  });

  it("tallies imported / skipped / error counts per session in a batch", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    mockImportCodeSession
      .mockResolvedValueOnce({ status: "imported", sessionId: "s-1" })
      .mockResolvedValueOnce({ status: "skipped", sessionId: "s-2" })
      .mockResolvedValueOnce({ status: "error", error: "db exploded" });

    const req = makeRequest(
      {
        sessions: [
          validSession({ sourceSessionId: "s-1" }),
          validSession({ sourceSessionId: "s-2" }),
          validSession({ sourceSessionId: "s-3" }),
        ],
      },
      { token: "lls_ok" },
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.total).toBe(3);
    expect(body.errors).toEqual([{ sourceSessionId: "s-3", error: "db exploded" }]);
  });

  it("returns 400 for a malformed body", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    const req = makeRequest({ notSessions: true }, { token: "lls_ok" });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    const req = new NextRequest("http://localhost:3000/api/code-sessions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer lls_ok" },
      body: "{not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  describe("#209: the schema is narrowed to core's unions", () => {
    function toolTurn(extra: Record<string, unknown>) {
      return {
        idx: 0,
        role: "user",
        kind: "prose",
        text: "hi",
        ts: "2026-07-01T10:00:00.000Z",
        ...extra,
      };
    }
    const okAction = { verb: "viewed", ref: "acme/webapp!7", refKind: "merge_request", source: "cli" };

    it.each([
      ["an out-of-union action verb", { action: { ...okAction, verb: "deployed" } }],
      ["an out-of-union action refKind", { action: { ...okAction, refKind: "pipeline" } }],
      ["an out-of-union action source", { actions: [okAction, { ...okAction, source: "web" }] }],
      ["repoUnknown: false (core's field is the literal true)", { action: { ...okAction, repoUnknown: false } }],
      ["an out-of-union nonOwner", { nonOwner: "system_note" }],
    ])("returns 400 and imports nothing for %s", async (_label, extra) => {
      mockValidateApiKey.mockResolvedValueOnce({
        valid: true,
        userId: "user-1",
        scopeNodeId: null,
        scopeCodeProjectId: null,
      });
      const req = makeRequest({ sessions: [validSession({ turns: [toolTurn(extra)] })] }, { token: "lls_ok" });
      const res = await POST(req);
      expect(res.status).toBe(400);
      expect(mockImportCodeSession).not.toHaveBeenCalled();
    });

    it("keeps title and strips the local-only dir/shownRepo before the importer sees the action", async () => {
      mockValidateApiKey.mockResolvedValueOnce({
        valid: true,
        userId: "user-1",
        scopeNodeId: null,
        scopeCodeProjectId: null,
      });
      mockImportCodeSession.mockResolvedValueOnce({ status: "imported", sessionId: "s-1" });
      const sent = {
        ...okAction,
        title: "Make debit posting idempotent",
        branchConfirmed: true,
        dir: "/Users/someone/dev/webapp",
        shownRepo: "acme/webapp",
      };
      const req = makeRequest(
        {
          sessions: [
            validSession({ turns: [toolTurn({ action: sent, actions: [sent, okAction], nonOwner: "caveat" })] }),
          ],
        },
        { token: "lls_ok" },
      );
      const res = await POST(req);
      expect(res.status).toBe(200);
      const imported = mockImportCodeSession.mock.calls[0][2] as {
        turns: Array<{ action: Record<string, unknown>; actions: Array<Record<string, unknown>>; nonOwner: string }>;
      };
      const turn = imported.turns[0];
      const expected = {
        verb: "viewed",
        ref: "acme/webapp!7",
        refKind: "merge_request",
        source: "cli",
        title: "Make debit posting idempotent",
        branchConfirmed: true,
      };
      // toStrictEqual: an own `dir`/`shownRepo` key (even undefined) fails, so nothing reaches stored props.
      expect(turn.action).toStrictEqual(expected);
      expect(turn.actions).toStrictEqual([expected, okAction]);
      expect(turn.nonOwner).toBe("caveat");
    });
  });

  it("returns 400 when the batch exceeds the max session cap", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    const sessions = Array.from({ length: 21 }, (_, i) => validSession({ sourceSessionId: `s-${i}` }));
    const req = makeRequest({ sessions }, { token: "lls_ok" });
    const res = await POST(req);
    expect(res.status).toBe(400);
    expect(mockImportCodeSession).not.toHaveBeenCalled();
  });

  it("round-2 review MED 7: does NOT reject a small body just because Content-Length lies large (no longer trusts the header alone)", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    mockImportCodeSession.mockResolvedValueOnce({ status: "imported", sessionId: "sess-1" });
    const req = makeRequest(
      { sessions: [validSession()] },
      { token: "lls_ok", headers: { "content-length": String(5 * 1024 * 1024) } },
    );
    const res = await POST(req);
    // The real (small) body is what's measured now — a lying Content-Length
    // header alone must not trigger a 413.
    expect(res.status).not.toBe(413);
  });

  it("round-2 review MED 7: rejects an actually oversized body even when Content-Length lies small (the streaming byte counter, not the header, decides)", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    const hugeText = "x".repeat(5 * 1024 * 1024);
    const req = makeRequest(
      {
        sessions: [
          validSession({
            turns: [{ idx: 0, role: "user", kind: "prose", text: hugeText, ts: "2026-07-01T10:00:00.000Z" }],
          }),
        ],
      },
      { token: "lls_ok", headers: { "content-length": "1" } },
    );
    const res = await POST(req);
    expect(res.status).toBe(413);
    expect(mockImportCodeSession).not.toHaveBeenCalled();
  });

  it("returns 413 for an actually oversized body even without a content-length header", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    const hugeText = "x".repeat(5 * 1024 * 1024);
    const req = makeRequest(
      {
        sessions: [
          validSession({
            turns: [{ idx: 0, role: "user", kind: "prose", text: hugeText, ts: "2026-07-01T10:00:00.000Z" }],
          }),
        ],
      },
      { token: "lls_ok" },
    );
    req.headers.delete("content-length");
    const res = await POST(req);
    expect(res.status).toBe(413);
  });

  it("returns 200 with all-zero counts for an empty sessions array", async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      valid: true,
      userId: "user-1",
      scopeNodeId: null,
      scopeCodeProjectId: null,
    });
    const req = makeRequest({ sessions: [] }, { token: "lls_ok" });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ imported: 0, skipped: 0, total: 0, errors: [], open_supported: true });
    expect(mockImportCodeSession).not.toHaveBeenCalled();
  });

  describe("P1c synthesis trigger (ADR 0021 Q5)", () => {
    const originalKey = process.env.OPENAI_API_KEY;

    afterEach(() => {
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalKey;
    });

    it("fires synthesis fire-and-forget when a session was imported and OPENAI_API_KEY is set", async () => {
      process.env.OPENAI_API_KEY = "sk-test";
      mockValidateApiKey.mockResolvedValueOnce({
        valid: true,
        userId: "user-1",
        scopeNodeId: null,
        scopeCodeProjectId: null,
      });
      mockImportCodeSession.mockResolvedValueOnce({ status: "imported", sessionId: "s-1" });
      let resolveSynth: () => void = () => {};
      mockSynthesize.mockReturnValueOnce(new Promise<void>((resolve) => (resolveSynth = resolve)));

      const req = makeRequest({ sessions: [validSession()] }, { token: "lls_ok" });
      const res = await POST(req);

      // The response does not wait on synthesis — it resolves even though the
      // synthesis promise is still pending.
      expect(res.status).toBe(200);
      expect(mockSynthesize).toHaveBeenCalledWith("user-1");
      resolveSynth();
    });

    it("does NOT fire synthesis when nothing was imported (all skipped)", async () => {
      process.env.OPENAI_API_KEY = "sk-test";
      mockValidateApiKey.mockResolvedValueOnce({
        valid: true,
        userId: "user-1",
        scopeNodeId: null,
        scopeCodeProjectId: null,
      });
      mockImportCodeSession.mockResolvedValueOnce({ status: "skipped", sessionId: "s-1" });

      const req = makeRequest({ sessions: [validSession()] }, { token: "lls_ok" });
      await POST(req);

      expect(mockSynthesize).not.toHaveBeenCalled();
    });

    it("does NOT fire synthesis when OPENAI_API_KEY is unset", async () => {
      delete process.env.OPENAI_API_KEY;
      mockValidateApiKey.mockResolvedValueOnce({
        valid: true,
        userId: "user-1",
        scopeNodeId: null,
        scopeCodeProjectId: null,
      });
      mockImportCodeSession.mockResolvedValueOnce({ status: "imported", sessionId: "s-1" });

      const req = makeRequest({ sessions: [validSession()] }, { token: "lls_ok" });
      await POST(req);

      expect(mockSynthesize).not.toHaveBeenCalled();
    });
  });

  // ---- Freshness heartbeat (goal 2026-07-26 step 2, #63/#58) ----

  describe("sync_heartbeats upsert (source='code')", () => {
    it("upserts a 'code' heartbeat when a session was imported", async () => {
      mockValidateApiKey.mockResolvedValueOnce({
        valid: true,
        userId: "user-1",
        scopeNodeId: null,
        scopeCodeProjectId: null,
      });
      mockImportCodeSession.mockResolvedValueOnce({ status: "imported", sessionId: "s-1" });

      const req = makeRequest({ sessions: [validSession()] }, { token: "lls_ok" });
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(mockHeartbeatUpsert).toHaveBeenCalledTimes(1);
      const [rows, opts] = mockHeartbeatUpsert.mock.calls[0];
      expect(opts).toEqual({ onConflict: "user_id,source" });
      expect(rows).toEqual([expect.objectContaining({ user_id: "user-1", source: "code" })]);
    });

    it("still upserts a heartbeat when nothing was imported (all skipped) — B1: a run happened even with no new content", async () => {
      mockValidateApiKey.mockResolvedValueOnce({
        valid: true,
        userId: "user-1",
        scopeNodeId: null,
        scopeCodeProjectId: null,
      });
      mockImportCodeSession.mockResolvedValueOnce({ status: "skipped", sessionId: "s-1" });

      const req = makeRequest({ sessions: [validSession()] }, { token: "lls_ok" });
      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(mockHeartbeatUpsert).toHaveBeenCalledTimes(1);
    });

    it("upserts a heartbeat for an empty sessions:[] batch (B1: the CLI's delta-with-nothing-new heartbeat ping)", async () => {
      mockValidateApiKey.mockResolvedValueOnce({
        valid: true,
        userId: "user-1",
        scopeNodeId: null,
        scopeCodeProjectId: null,
      });

      const req = makeRequest({ sessions: [] }, { token: "lls_ok" });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ imported: 0, skipped: 0, total: 0, errors: [], open_supported: true });
      expect(mockImportCodeSession).not.toHaveBeenCalled();

      expect(mockHeartbeatUpsert).toHaveBeenCalledTimes(1);
      const [rows, opts] = mockHeartbeatUpsert.mock.calls[0];
      expect(opts).toEqual({ onConflict: "user_id,source" });
      expect(rows).toEqual([expect.objectContaining({ user_id: "user-1", source: "code" })]);
    });

    it("still upserts a heartbeat when every session in the batch errored", async () => {
      mockValidateApiKey.mockResolvedValueOnce({
        valid: true,
        userId: "user-1",
        scopeNodeId: null,
        scopeCodeProjectId: null,
      });
      mockImportCodeSession.mockResolvedValueOnce({ status: "error", error: "db exploded" });

      const req = makeRequest({ sessions: [validSession()] }, { token: "lls_ok" });
      const res = await POST(req);
      expect(res.status).toBe(200);
      expect(mockHeartbeatUpsert).toHaveBeenCalledTimes(1);
    });

    it("import still succeeds when the heartbeat upsert fails", async () => {
      mockValidateApiKey.mockResolvedValueOnce({
        valid: true,
        userId: "user-1",
        scopeNodeId: null,
        scopeCodeProjectId: null,
      });
      mockImportCodeSession.mockResolvedValueOnce({ status: "imported", sessionId: "s-1" });
      mockHeartbeatUpsert.mockResolvedValueOnce({ error: { message: "db exploded" } });

      const req = makeRequest({ sessions: [validSession()] }, { token: "lls_ok" });
      const res = await POST(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.imported).toBe(1);
    });
  });
});
