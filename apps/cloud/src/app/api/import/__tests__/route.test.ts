import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #132: the post-ingest pipeline (triggerPostIngestHooks, called by
// the REAL ingestConversations this route uses) now registers via
// next/server's after() instead of bare `.then()/.catch()` chains — the
// REAL after() throws when called outside an active Next request scope, so
// every test below would fail immediately without this mock. Captures
// without invoking; flushAfter() drains and awaits them (used via the
// doPost() helper below), replacing the old `await new Promise((resolve) =>
// setTimeout(resolve, 0))` flushes some tests below still contain (now
// harmless no-ops, since doPost already flushed by the time they run).
let capturedAfterCallbacks: Array<() => unknown> = [];
async function flushAfter(): Promise<void> {
  const cbs = capturedAfterCallbacks;
  capturedAfterCallbacks = [];
  for (const cb of cbs) await cb();
}
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: (cb: () => unknown) => {
      capturedAfterCallbacks.push(cb);
    },
  };
});

// --- Mocks ---

const mockGetUser = vi.fn();
const mockConversationsUpsert = vi.fn();
// sync_heartbeats: default success so every pre-existing test (which only
// configures the "conversations" upsert) still gets a clean second
// .from("sync_heartbeats") call for the freshness heartbeat write (goal
// 2026-07-26 step 2, #63/#58) without needing its own per-test setup.
const mockHeartbeatUpsert = vi.fn();

// Issue #127 (conversation_limit enforcement): the route now also queries
// "profiles" (for tier/conversation_limit) and does a "conversations"
// SELECT (for both the quota's current-count and the existing-key lookup)
// BEFORE ever calling .upsert(). These three vars back that path with
// defaults that never trip the cap (a very high limit, zero existing rows,
// zero current count) so every pre-existing test below is unaffected unless
// it deliberately overrides them — see the "conversation_limit enforcement"
// describe block near the bottom.
let mockProfileLimit = 1_000_000;
let mockConversationsCount = 0;
let mockExistingConversationRows: { source_id: string }[] = [];

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      if (table === "sync_heartbeats") return { upsert: mockHeartbeatUpsert };
      if (table === "profiles") {
        return {
          select: () => ({
            eq: () => ({
              single: () =>
                Promise.resolve({ data: { tier: "free", conversation_limit: mockProfileLimit }, error: null }),
            }),
          }),
        };
      }
      // "conversations" — shared by the quota count select, the existing-key
      // lookup select, and the real upsert (all three .from("conversations")
      // call sites in the request path land here). Round-2 review HIGH 4:
      // getConversationQuota's count query is now `.select(...).eq("user_id",
      // ...)` alone (no more `.neq("source", "claude-code")` — see
      // lib/billing.ts) — so `afterFirstEq` must resolve directly (it's
      // thenable, same PromiseLike pattern real Supabase query builders use)
      // AND still support a second `.eq(...).in(...)` chain for
      // findExistingConversationKeys' 2-eq query.
      const afterFirstEq = {
        eq: () => ({ in: () => Promise.resolve({ data: mockExistingConversationRows, error: null }) }),
        // biome-ignore lint/suspicious/noThenProperty: intentional PromiseLike test double, matching the real Supabase query-builder pattern (thenable + chainable) — see the comment above.
        then: (resolve: (v: { count: number }) => void) => resolve({ count: mockConversationsCount }),
      };
      return {
        select: () => ({ eq: () => afterFirstEq }),
        upsert: (rows: unknown[], opts: unknown) => mockConversationsUpsert(rows, opts),
      };
    },
  })),
}));

vi.mock("@/lib/rate-limit", () => ({
  enforceRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfter: 0 }),
  rateLimited: vi.fn(() => new Response(null, { status: 429 })),
  userBucket: vi.fn((name: string, userId: string) => `${name}:${userId}`),
}));

const mockEmbedMissingConversations = vi.fn();
vi.mock("@/lib/conversation-embeddings", () => ({
  embedMissingConversations: (...args: unknown[]) => mockEmbedMissingConversations(...args),
}));

// Chunk-level chat index (goal 2026-07-26 step 11, #39 folded in) — mocked
// the same way as embedMissingConversations above.
const mockChunkMissingConversations = vi.fn();
const mockEmbedMissingChunks = vi.fn();
vi.mock("@/lib/conversation-chunks", () => ({
  chunkMissingConversations: (...args: unknown[]) => mockChunkMissingConversations(...args),
  embedMissingChunks: (...args: unknown[]) => mockEmbedMissingChunks(...args),
}));

// Issue #132 item 2 — defaults to NOT granted so every pre-existing test
// below gets a cheap no-op, matching the "no lock, no DB writes" doc for an
// ungranted user.
const mockHasFeature = vi.fn();
vi.mock("@/lib/feature-flags", () => ({
  hasFeature: (...args: unknown[]) => mockHasFeature(...args),
}));

// Set env vars before importing route
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { _clearConversationCountCacheForTest } from "@/lib/billing";
import { POST } from "../route";

/** POST + drain next/server's after() — see the module-level mock/comment above. */
async function doPost(req: NextRequest) {
  const res = await POST(req);
  await flushAfter();
  return res;
}

function makeRequest(body: unknown, token?: string): NextRequest {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) {
    headers["authorization"] = `Bearer ${token}`;
  }
  return new NextRequest("http://localhost:3000/api/import", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

const validConversation = {
  source: "claude",
  source_id: "conv-123",
  title: "Test conversation",
  messages: [{ role: "user", content: "Hello", timestamp: null, metadata: {} }],
  metadata: {},
  created_at: null,
  updated_at: null,
  model: null,
  synced_at: new Date().toISOString(),
};

describe("POST /api/import", () => {
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedAfterCallbacks.length = 0;
    _clearConversationCountCacheForTest();
    mockProfileLimit = 1_000_000;
    mockConversationsCount = 0;
    mockExistingConversationRows = [];
    mockEmbedMissingConversations.mockResolvedValue({ processed: 0, errors: [] });
    mockChunkMissingConversations.mockResolvedValue({ processed: 0, errors: [] });
    mockEmbedMissingChunks.mockResolvedValue({ processed: 0, errors: [] });
    mockHeartbeatUpsert.mockResolvedValue({ error: null });
    mockHasFeature.mockResolvedValue(false);
  });

  afterEach(() => {
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  });

  it("returns 401 when no auth header", async () => {
    const req = makeRequest({ conversations: [validConversation] });
    const res = await doPost(req);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBeDefined();
  });

  it("returns 401 when token is invalid", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "invalid token" },
    });

    const req = makeRequest({ conversations: [validConversation] }, "bad-token");
    const res = await doPost(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when conversations is not an array", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });

    const req = makeRequest({ conversations: "not-array" }, "valid-token");
    const res = await doPost(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when the conversations array exceeds the per-request count cap", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });

    const many = Array.from({ length: 501 }, (_, i) => ({ ...validConversation, source_id: `conv-${i}` }));
    const req = makeRequest({ conversations: many }, "valid-token");
    const res = await doPost(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("501");
  });

  it("returns 200 with correct import count on valid request", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });

    mockConversationsUpsert.mockResolvedValueOnce({
      data: [{ id: "row-1" }],
      error: null,
    });

    const req = makeRequest({ conversations: [validConversation] }, "valid-token");
    const res = await doPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(1);
    expect(body.total).toBe(1);
  });

  it("calls embedMissingConversations(userId, min(totalImported, 50)) when OPENAI_API_KEY is set", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-test";

    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });

    mockConversationsUpsert.mockResolvedValueOnce({
      data: [{ id: "row-1" }],
      error: null,
    });

    const req = makeRequest({ conversations: [validConversation] }, "valid-token");
    const res = await doPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(1);

    expect(mockEmbedMissingConversations).toHaveBeenCalledTimes(1);
    const call = mockEmbedMissingConversations.mock.calls[0];
    // (supabase, userId, min(totalImported, 50))
    expect(call[1]).toBe("user-123");
    expect(call[2]).toBe(1);

    if (originalKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });

  it("calls chunkMissingConversations(userId, min(totalImported, 50)) additively, regardless of OPENAI_API_KEY (chunking is zero-LLM)", async () => {
    delete process.env.OPENAI_API_KEY;

    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
    mockConversationsUpsert.mockResolvedValueOnce({ data: [{ id: "row-1" }], error: null });

    const req = makeRequest({ conversations: [validConversation] }, "valid-token");
    const res = await doPost(req);
    expect(res.status).toBe(200);

    expect(mockChunkMissingConversations).toHaveBeenCalledTimes(1);
    const call = mockChunkMissingConversations.mock.calls[0];
    expect(call[1]).toBe("user-123");
    expect(call[2]).toBe(1);
    expect(mockEmbedMissingConversations).not.toHaveBeenCalled();
  });

  it("chains embedMissingChunks after a successful chunk pass, only when OPENAI_API_KEY is set", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    mockChunkMissingConversations.mockResolvedValueOnce({ processed: 1, errors: [] });

    mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
    mockConversationsUpsert.mockResolvedValueOnce({ data: [{ id: "row-1" }], error: null });

    const req = makeRequest({ conversations: [validConversation] }, "valid-token");
    const res = await doPost(req);
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mockEmbedMissingChunks).toHaveBeenCalledTimes(1);
    const call = mockEmbedMissingChunks.mock.calls[0];
    expect(call[1]).toBe("user-123");
    // MAJOR-1 fix (round-2 adversarial re-verification, 2026-07-26): the
    // embed call is no longer capped by the chunk-processed count (that
    // count is always 0 on a converged corpus, which used to starve this
    // call forever) — it always runs with a fixed limit.
    expect(call[2]).toBe(50);
  });

  it("does not call embedMissingConversations when OPENAI_API_KEY is unset", async () => {
    const originalKey = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;

    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });

    mockConversationsUpsert.mockResolvedValueOnce({
      data: [{ id: "row-1" }],
      error: null,
    });

    const req = makeRequest({ conversations: [validConversation] }, "valid-token");
    const res = await doPost(req);
    expect(res.status).toBe(200);

    expect(mockEmbedMissingConversations).not.toHaveBeenCalled();

    if (originalKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalKey;
    }
  });

  it("caps the embed limit at 50 even when more conversations were imported", async () => {
    process.env.OPENAI_API_KEY = "sk-test";

    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });

    const many = Array.from({ length: 60 }, (_, i) => ({
      ...validConversation,
      source_id: `conv-${i}`,
    }));

    mockConversationsUpsert.mockResolvedValue({
      data: many.map((_, i) => ({ id: `row-${i}` })),
      error: null,
    });

    const req = makeRequest({ conversations: many }, "valid-token");
    const res = await doPost(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.imported).toBe(60);

    expect(mockEmbedMissingConversations).toHaveBeenCalledTimes(1);
    const call = mockEmbedMissingConversations.mock.calls[0];
    expect(call[2]).toBe(50);
  });

  it("logs a warning (not silence) when embedMissingConversations resolves with per-row errors", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });
    mockConversationsUpsert.mockResolvedValueOnce({ data: [{ id: "row-1" }], error: null });
    mockEmbedMissingConversations.mockResolvedValueOnce({
      processed: 0,
      errors: ["Embedding error for conv-x: 400 maximum context length is 8192 tokens."],
    });

    const req = makeRequest({ conversations: [validConversation] }, "valid-token");
    const res = await doPost(req);
    expect(res.status).toBe(200);

    // Flush the fire-and-forget promise chain's microtasks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warnSpy).toHaveBeenCalled();
    const line = warnSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("embedding errors"));
    expect(line).toBeDefined();
    const parsed = JSON.parse(line as string);
    expect(parsed.errorCount).toBe(1);

    warnSpy.mockRestore();
  });

  it("logs an error (not silence) when embedMissingConversations rejects", async () => {
    process.env.OPENAI_API_KEY = "sk-test";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    mockGetUser.mockResolvedValueOnce({
      data: { user: { id: "user-123" } },
      error: null,
    });
    mockConversationsUpsert.mockResolvedValueOnce({ data: [{ id: "row-1" }], error: null });
    mockEmbedMissingConversations.mockRejectedValueOnce(new Error("connection refused"));

    const req = makeRequest({ conversations: [validConversation] }, "valid-token");
    const res = await doPost(req);
    expect(res.status).toBe(200);

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(errorSpy).toHaveBeenCalled();
    const line = errorSpy.mock.calls.map((c) => String(c[0])).find((l) => l.includes("embedding failed"));
    expect(line).toBeDefined();
    expect(JSON.parse(line as string).err).toBe("connection refused");

    errorSpy.mockRestore();
  });

  it("does not import @/lib/extraction-queue (legacy path removed)", async () => {
    const routeSource = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../route.ts", import.meta.url), "utf-8"),
    );
    expect(routeSource).not.toContain("extraction-queue");
    expect(routeSource).not.toContain("processUnextracted");
  });

  // ---- Issue #132: post-ingest work runs via next/server's after() ----

  describe("after() registration (issue #132 item 1)", () => {
    it("registers the post-ingest pipeline via after() instead of running it inline, and the response is not delayed", async () => {
      let releasePipeline: (() => void) | undefined;
      mockEmbedMissingConversations.mockImplementation(
        () =>
          new Promise((resolve) => {
            releasePipeline = () => resolve({ processed: 0, errors: [] });
          }),
      );
      process.env.OPENAI_API_KEY = "sk-test";

      mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
      mockConversationsUpsert.mockResolvedValueOnce({ data: [{ id: "row-1" }], error: null });

      const req = makeRequest({ conversations: [validConversation] }, "valid-token");
      // Intentionally calling POST directly (not doPost) — the point is
      // that POST itself resolves without waiting on the after() callback.
      const res = await POST(req);
      expect(res.status).toBe(200);

      expect(capturedAfterCallbacks).toHaveLength(1);
      expect(mockEmbedMissingConversations).not.toHaveBeenCalled();

      // flushAfter() synchronously calls embedMissingConversations (an
      // async function's body runs synchronously up to its own first
      // await) — which synchronously sets releasePipeline — BEFORE
      // flushAfter's own first `await` suspends it. releasePipeline must
      // be called AFTER starting the flush, not before it.
      const flushed = flushAfter();
      releasePipeline?.();
      await flushed;
      expect(mockEmbedMissingConversations).toHaveBeenCalledTimes(1);
    });
  });

  // ---- Issue #132 item 2: post-import extraction (bounded claims-advance) ----

  // ---- Freshness heartbeat (goal 2026-07-26 step 2, #63/#58) ----

  describe("sync_heartbeats upsert", () => {
    it("upserts a heartbeat row for the imported provider source", async () => {
      mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
      mockConversationsUpsert.mockResolvedValueOnce({ data: [{ id: "row-1" }], error: null });

      const convo = { ...validConversation, updated_at: "2026-07-20T00:00:00.000Z" };
      const req = makeRequest({ conversations: [convo] }, "valid-token");
      const res = await doPost(req);
      expect(res.status).toBe(200);

      expect(mockHeartbeatUpsert).toHaveBeenCalledTimes(1);
      const [rows] = mockHeartbeatUpsert.mock.calls[0];
      expect(rows).toEqual([
        expect.objectContaining({
          user_id: "user-123",
          source: "claude",
          last_item_at: "2026-07-20T00:00:00.000Z",
        }),
      ]);
    });

    it("import still succeeds when the heartbeat upsert fails", async () => {
      mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
      mockConversationsUpsert.mockResolvedValueOnce({ data: [{ id: "row-1" }], error: null });
      mockHeartbeatUpsert.mockResolvedValueOnce({ error: { message: "db exploded" } });

      const req = makeRequest({ conversations: [validConversation] }, "valid-token");
      const res = await doPost(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.imported).toBe(1);
    });

    // ---- MAJOR 2 fix (adversarial review, symmetric with /api/sync) ----

    describe("optional `sources` field", () => {
      it("records a heartbeat for a declared source even with ZERO conversations in the batch", async () => {
        mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
        const req = makeRequest({ conversations: [], sources: ["claude"] }, "valid-token");
        const res = await doPost(req);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.imported).toBe(0);

        expect(mockHeartbeatUpsert).toHaveBeenCalledTimes(1);
        const [rows] = mockHeartbeatUpsert.mock.calls[0];
        expect(rows).toEqual([expect.objectContaining({ user_id: "user-123", source: "claude", last_item_at: null })]);
      });

      it("old-format request (no `sources` field, zero conversations) still works with no heartbeat", async () => {
        mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
        const req = makeRequest({ conversations: [] }, "valid-token");
        const res = await doPost(req);
        expect(res.status).toBe(200);
        expect(mockHeartbeatUpsert).not.toHaveBeenCalled();
      });

      // ---- Round-2 adversarial review, MAJOR 2: unvalidated sources[] could forge the code heartbeat ----

      it("rejects 'code' — cannot forge the code freshness row through the chat route", async () => {
        mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
        const req = makeRequest({ conversations: [], sources: ["code"] }, "valid-token");
        const res = await doPost(req);
        expect(res.status).toBe(200);
        expect(mockHeartbeatUpsert).not.toHaveBeenCalled();
      });

      it("rejects arbitrary junk strings", async () => {
        mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
        const req = makeRequest({ conversations: [], sources: ["not-a-source"] }, "valid-token");
        const res = await doPost(req);
        expect(res.status).toBe(200);
        expect(mockHeartbeatUpsert).not.toHaveBeenCalled();
      });

      it("a mix of valid, invalid, and 'code' sources: only the valid chat ones heartbeat", async () => {
        mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
        const req = makeRequest({ conversations: [], sources: ["claude", "code", "junk", "chatgpt"] }, "valid-token");
        const res = await doPost(req);
        expect(res.status).toBe(200);

        expect(mockHeartbeatUpsert).toHaveBeenCalledTimes(1);
        const [rows] = mockHeartbeatUpsert.mock.calls[0];
        const sources = rows.map((r: { source: string }) => r.source).sort();
        expect(sources).toEqual(["chatgpt", "claude"]);
      });

      it("dedupes a repeated source", async () => {
        mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
        const req = makeRequest({ conversations: [], sources: ["claude", "claude"] }, "valid-token");
        const res = await doPost(req);
        expect(res.status).toBe(200);

        expect(mockHeartbeatUpsert).toHaveBeenCalledTimes(1);
        const [rows] = mockHeartbeatUpsert.mock.calls[0];
        expect(rows).toHaveLength(1);
      });
    });
  });

  // ---- Issue #127: profiles.conversation_limit enforcement ----

  describe("conversation_limit enforcement", () => {
    it("returns 402 conversation_limit when every conversation is new and none fit under the cap", async () => {
      mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
      mockProfileLimit = 1;
      mockConversationsCount = 1; // already at the limit
      mockExistingConversationRows = []; // the incoming conversation is brand-new

      const req = makeRequest({ conversations: [validConversation] }, "valid-token");
      const res = await doPost(req);
      expect(res.status).toBe(402);
      const body = await res.json();
      expect(body.error).toBe("conversation_limit");
      expect(body.limit).toBe(1);
      expect(body.count).toBe(1);
      expect(mockConversationsUpsert).not.toHaveBeenCalled();
    });

    it("still accepts an UPDATE to an already-stored conversation even when at the limit", async () => {
      mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
      mockProfileLimit = 1;
      mockConversationsCount = 1; // at the limit
      mockExistingConversationRows = [{ source_id: validConversation.source_id }]; // already stored -> update
      mockConversationsUpsert.mockResolvedValueOnce({ data: [{ id: "row-1" }], error: null });

      const req = makeRequest({ conversations: [validConversation] }, "valid-token");
      const res = await doPost(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.imported).toBe(1);
      expect(body.skipped).toBe(0);
      expect(body.atLimit).toBe(false);
    });

    it("partial batch: accepts up to the remaining headroom and reports the rest as skipped", async () => {
      mockGetUser.mockResolvedValueOnce({ data: { user: { id: "user-123" } }, error: null });
      mockProfileLimit = 5;
      mockConversationsCount = 3; // 2 slots remain
      mockExistingConversationRows = []; // all three below are brand-new
      mockConversationsUpsert.mockResolvedValueOnce({
        data: [{ id: "row-1" }, { id: "row-2" }],
        error: null,
      });

      const three = [0, 1, 2].map((i) => ({ ...validConversation, source_id: `conv-new-${i}` }));
      const req = makeRequest({ conversations: three }, "valid-token");
      const res = await doPost(req);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.imported).toBe(2);
      expect(body.skipped).toBe(1);
      expect(body.atLimit).toBe(true);
      // Only the 2 accepted rows were ever upserted — the 3rd never reached the write path.
      const [rows] = mockConversationsUpsert.mock.calls[0];
      expect(rows).toHaveLength(2);
    });
  });
});
