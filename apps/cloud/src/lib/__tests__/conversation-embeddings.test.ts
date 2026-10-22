import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockGenerateEmbedding = vi.fn();
const mockCreateEmbeddingGuardContext = vi.fn();
const mockCheckMonthlyCeiling = vi.fn();
const mockLedgerOnSpend = vi.fn();
const mockLedgerFlush = vi.fn(async () => {});

// vi.mock factories are hoisted above the whole file, including any
// top-level `class` declarations here (unlike `function`, classes are NOT
// hoisted with their binding initialized) — so the error classes must be
// declared INSIDE the factory itself, not referenced from outer scope.
vi.mock("@/lib/embeddings", () => {
  class EmbeddingTokenOverflowError extends Error {
    constructor(public readonly lastMessage: string) {
      super(`token overflow: ${lastMessage}`);
      this.name = "EmbeddingTokenOverflowError";
    }
  }
  return {
    generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
    prepareTextForEmbedding: (title: string, messages: Array<{ role: string; content: string }>) =>
      `Title: ${title}\n${messages.map((m) => `[${m.role}]: ${m.content}`).join("\n")}`,
    EmbeddingTokenOverflowError,
    createEmbeddingGuardContext: (...args: unknown[]) => mockCreateEmbeddingGuardContext(...args),
  };
});

vi.mock("@/lib/llm/spend-ledger", () => ({
  checkMonthlyCeiling: (...args: unknown[]) => mockCheckMonthlyCeiling(...args),
}));

// Issue #126 (ADR 0047): embedMissingConversations checks hasFeature ONCE
// upfront (before the batch loop) — defaults to enabled so every pre-existing
// test in this file (predating the flag) keeps exercising the batch loop;
// the dedicated describe block below overrides this to prove the disabled
// path short-circuits before generateEmbedding is ever called.
const mockHasFeature = vi.fn<(...args: unknown[]) => Promise<boolean>>(() => Promise.resolve(true));
vi.mock("@/lib/feature-flags", () => ({
  hasFeature: (...args: unknown[]) => mockHasFeature(...args),
}));

// Import the (mocked) error class back from the module — same class
// conversation-embeddings.ts's `instanceof` check is testing against, since
// vi.mock intercepts every import of this path, including this one.
import { EmbeddingTokenOverflowError } from "@/lib/embeddings";
import { embedMissingConversations } from "../conversation-embeddings";

interface FakeConversation {
  id: string;
  title: string;
  messages: Array<{ role: string; content: string }>;
}

function makeFakeEmbedding(): number[] {
  return Array.from({ length: 1536 }, (_, i) => i * 0.001);
}

/** A GUARDED context (non-null supabase marker + a spy-able ledger) — the default for most tests, matching "service-role env is configured" in production. */
function guardedContext(): {
  supabase: object;
  ledger: { onSpend: typeof mockLedgerOnSpend; flush: typeof mockLedgerFlush };
} {
  return { supabase: { marker: "guard-supabase" }, ledger: { onSpend: mockLedgerOnSpend, flush: mockLedgerFlush } };
}

function makeSupabaseMock(opts: {
  selectData: FakeConversation[] | null;
  selectError?: { message: string } | null;
  updateErrorFor?: Record<string, { message: string }>;
}) {
  const updateCalls: Array<{ id: string; userId: string; payload: Record<string, unknown> }> = [];

  const limitMock = vi.fn().mockResolvedValue({ data: opts.selectData, error: opts.selectError ?? null });
  const orderMock = vi.fn(() => ({ limit: limitMock }));
  // Two chained `.is()` calls now (issue #90): embedding is null AND
  // embedding_failed_at is null.
  const isFailedMock = vi.fn(() => ({ order: orderMock }));
  const isMock = vi.fn(() => ({ is: isFailedMock }));
  const selectEqMock = vi.fn(() => ({ is: isMock }));
  const selectMock = vi.fn(() => ({ eq: selectEqMock }));

  const updateMock = vi.fn((payload: Record<string, unknown>) => ({
    eq: vi.fn((_col1: string, id: string) => ({
      eq: vi.fn((_col2: string, userId: string) => {
        updateCalls.push({ id, userId, payload });
        const err = opts.updateErrorFor?.[id];
        return Promise.resolve({ error: err ?? null });
      }),
    })),
  }));

  const from = vi.fn(() => ({
    select: selectMock,
    update: updateMock,
  }));

  return { from, selectMock, selectEqMock, isMock, isFailedMock, orderMock, limitMock, updateMock, updateCalls };
}

function makeConversations(n: number): FakeConversation[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `conv-${i}`,
    title: `Conv ${i}`,
    messages: [{ role: "user", content: "hi" }],
  }));
}

describe("embedMissingConversations", () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): earlier tests deliberately queue a
    // `mockResolvedValueOnce` that a batch-break never consumes (proving a
    // row after the ceiling was never attempted) — clearAllMocks only resets
    // call history, leaving that queued value to leak into the next test's
    // queue and silently swap which row "succeeds".
    vi.resetAllMocks();
    mockCreateEmbeddingGuardContext.mockReturnValue(guardedContext());
    mockCheckMonthlyCeiling.mockResolvedValue({ allowed: true, spentUsd: 0, ceilingUsd: null });
    mockLedgerFlush.mockResolvedValue(undefined);
    mockHasFeature.mockResolvedValue(true);
  });

  it("embeds conversations with a null embedding, writing a 1536-dim '[...]' vector", async () => {
    const fakeEmbedding = makeFakeEmbedding();
    mockGenerateEmbedding.mockResolvedValueOnce(fakeEmbedding);

    const conversations: FakeConversation[] = [
      { id: "conv-1", title: "Test", messages: [{ role: "user", content: "Hello" }] },
    ];
    const supabase = makeSupabaseMock({ selectData: conversations });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

    expect(result.processed).toBe(1);
    expect(result.errors).toEqual([]);
    expect(supabase.updateCalls).toHaveLength(1);

    // Migration 118 (D-072): the default family omits embedding_model (NULL = default; pre-118 DBs keep working).
    expect(supabase.updateCalls[0].payload).not.toHaveProperty("embedding_model");
    const written = supabase.updateCalls[0].payload.embedding as string;
    expect(written.startsWith("[")).toBe(true);
    expect(written.endsWith("]")).toBe(true);
    const parsed = written.slice(1, -1).split(",").map(Number);
    expect(parsed).toHaveLength(1536);
    expect(parsed).toEqual(fakeEmbedding);
  });

  it("calls generateEmbedding with the conversation_embedding pass, userId, and the batch's shared guard — WITHOUT passing this module's own supabase client through (issue #92 adversarial review B1)", async () => {
    mockGenerateEmbedding.mockResolvedValueOnce(makeFakeEmbedding());
    const conversations: FakeConversation[] = [
      { id: "conv-1", title: "Test", messages: [{ role: "user", content: "Hello" }] },
    ];
    const supabase = makeSupabaseMock({ selectData: conversations });
    const guard = guardedContext();
    mockCreateEmbeddingGuardContext.mockReturnValue(guard);

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

    // B1 still holds: this module's OWN data client is never threaded into
    // generateEmbedding's opts. m-batching: the batch's shared guard context
    // (from createEmbeddingGuardContext, never a raw client) is, so
    // generateEmbedding can skip its own per-call preflight/ledger-mint.
    expect(mockGenerateEmbedding).toHaveBeenCalledWith(expect.any(String), {
      userId: "user-1",
      pass: "conversation_embedding",
      guard,
    });
  });

  it("scopes both the select and the update to the requesting user (id alone is not enough on a service-role client)", async () => {
    mockGenerateEmbedding.mockResolvedValueOnce(makeFakeEmbedding());

    const conversations: FakeConversation[] = [
      { id: "conv-1", title: "Test", messages: [{ role: "user", content: "Hello" }] },
    ];
    const supabase = makeSupabaseMock({ selectData: conversations });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

    expect(supabase.updateCalls[0].id).toBe("conv-1");
    expect(supabase.updateCalls[0].userId).toBe("user-1");
  });

  it("orders by synced_at (ingest recency, not provider created_at) before limiting, so deterministically-failing rows can't starve freshly-ingested ones", async () => {
    const supabase = makeSupabaseMock({ selectData: [] });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

    expect(supabase.selectEqMock).toHaveBeenCalledWith("user_id", "user-1");
    expect(supabase.isMock).toHaveBeenCalledWith("embedding", null);
    expect(supabase.orderMock).toHaveBeenCalledWith("synced_at", { ascending: false });
    expect(supabase.limitMock).toHaveBeenCalledWith(50);
  });

  it("issue #90: also filters embedding_failed_at is null — retired rows are never re-selected", async () => {
    const supabase = makeSupabaseMock({ selectData: [] });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

    expect(supabase.isMock).toHaveBeenCalledWith("embedding", null);
    expect(supabase.isFailedMock).toHaveBeenCalledWith("embedding_failed_at", null);
  });

  it("is idempotent: an already-embedded corpus (no null rows) makes zero OpenAI calls, and never even builds a guard context", async () => {
    const supabase = makeSupabaseMock({ selectData: [] });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

    expect(result.processed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(supabase.updateMock).not.toHaveBeenCalled();
    expect(mockCreateEmbeddingGuardContext).not.toHaveBeenCalled(); // early-return before any guard/ledger work

    // Blind to a mutated filter column (e.g. .is("model", null) instead of
    // .is("embedding", null)) — assert the actual query-builder args, not just
    // the empty-result behavior.
    expect(supabase.selectMock).toHaveBeenCalledWith("id, title, messages");
    expect(supabase.selectEqMock).toHaveBeenCalledWith("user_id", "user-1");
    expect(supabase.isMock).toHaveBeenCalledWith("embedding", null);
    expect(supabase.orderMock).toHaveBeenCalledWith("synced_at", { ascending: false });
  });

  it("one row throwing does not abort the batch — the rest are processed and the failure lands in errors", async () => {
    const fakeEmbedding = makeFakeEmbedding();
    mockGenerateEmbedding
      .mockRejectedValueOnce(new Error("OpenAI quota exceeded"))
      .mockResolvedValueOnce(fakeEmbedding)
      .mockResolvedValueOnce(fakeEmbedding);

    const conversations: FakeConversation[] = [
      { id: "conv-fail", title: "Fails", messages: [{ role: "user", content: "a" }] },
      { id: "conv-2", title: "OK 1", messages: [{ role: "user", content: "b" }] },
      { id: "conv-3", title: "OK 2", messages: [{ role: "user", content: "c" }] },
    ];
    const supabase = makeSupabaseMock({ selectData: conversations });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

    expect(result.processed).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("conv-fail");
    expect(supabase.updateCalls.map((c) => c.id)).toEqual(["conv-2", "conv-3"]);
  });

  it("CONTRACT: serialized form is exactly '[' + join(',') + ']' with 1536 elements — matches search.ts query_embedding shape", async () => {
    const fakeEmbedding = makeFakeEmbedding();
    mockGenerateEmbedding.mockResolvedValueOnce(fakeEmbedding);

    const conversations: FakeConversation[] = [
      { id: "conv-1", title: "Test", messages: [{ role: "user", content: "Hello" }] },
    ];
    const supabase = makeSupabaseMock({ selectData: conversations });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

    const written = supabase.updateCalls[0].payload.embedding as string;
    // This is byte-for-byte the same construction search.ts uses for query_embedding:
    // `[${embedding.join(",")}]`
    const expected = `[${fakeEmbedding.join(",")}]`;
    expect(written).toBe(expected);
    expect(written.slice(1, -1).split(",")).toHaveLength(1536);
  });

  it("propagates a query error without throwing, and surfaces it via queryError for callers that need an error-status contract", async () => {
    const supabase = makeSupabaseMock({ selectData: null, selectError: { message: "connection refused" } });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

    expect(result.processed).toBe(0);
    expect(result.errors[0]).toContain("connection refused");
    expect(result.queryError).toBe("connection refused");
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  describe("issue #90 — permanent failure retirement", () => {
    it("marks embedding_failed_at on EmbeddingTokenOverflowError and continues to the next row", async () => {
      const fakeEmbedding = makeFakeEmbedding();
      mockGenerateEmbedding
        .mockRejectedValueOnce(new EmbeddingTokenOverflowError("still too long after halving"))
        .mockResolvedValueOnce(fakeEmbedding);

      const conversations: FakeConversation[] = [
        { id: "conv-doomed", title: "Doomed", messages: [] },
        { id: "conv-ok", title: "OK", messages: [] },
      ];
      const supabase = makeSupabaseMock({ selectData: conversations });

      // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
      const result = await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

      expect(result.processed).toBe(1);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toContain("conv-doomed");

      const failCall = supabase.updateCalls.find((c) => c.id === "conv-doomed");
      expect(failCall).toBeDefined();
      expect(failCall?.payload.embedding_failed_at).toEqual(expect.any(String));

      const okCall = supabase.updateCalls.find((c) => c.id === "conv-ok");
      expect(okCall?.payload.embedding).toEqual(expect.any(String));
    });
  });

  describe("issue #92 adversarial review m-batching — hoisted ceiling preflight + batched ledger", () => {
    it("a batch of 3 rows (under the 10-row recheck interval) gets exactly ONE ceiling preflight", async () => {
      mockGenerateEmbedding.mockResolvedValue(makeFakeEmbedding());
      const supabase = makeSupabaseMock({ selectData: makeConversations(3) });

      // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
      const result = await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

      expect(result.processed).toBe(3);
      expect(mockCreateEmbeddingGuardContext).toHaveBeenCalledTimes(1); // one guard for the whole batch
      expect(mockCreateEmbeddingGuardContext).toHaveBeenCalledWith("user-1");
      expect(mockCheckMonthlyCeiling).toHaveBeenCalledTimes(1); // not once per row
    });

    it("re-checks the ceiling every 10 rows (mid-batch protection cadence)", async () => {
      mockGenerateEmbedding.mockResolvedValue(makeFakeEmbedding());
      const supabase = makeSupabaseMock({ selectData: makeConversations(12) });

      const result = await embedMissingConversations(
        // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
        { from: supabase.from } as any,
        "user-1",
        50,
      );

      expect(result.processed).toBe(12);
      // Rows 0 and 10 trigger a recheck (i % 10 === 0); rows 1-9 and 11 don't.
      expect(mockCheckMonthlyCeiling).toHaveBeenCalledTimes(2);
    });

    it("flushes the shared ledger before each periodic recheck, so the check sees this batch's own spend so far", async () => {
      mockGenerateEmbedding.mockResolvedValue(makeFakeEmbedding());
      const supabase = makeSupabaseMock({ selectData: makeConversations(1) });

      // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
      await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

      // At least the one pre-check flush (row 0) + the final finally-block flush.
      expect(mockLedgerFlush.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("spend rows: exactly one onSpend per successful embed, via the SHARED ledger (not a per-call ledger)", async () => {
      // generateEmbedding is fully mocked at this layer, so it doesn't call
      // guard.ledger.onSpend itself here — this test proves conversation-
      // embeddings.ts hands the SAME guard object to every call in the
      // batch (asserted via the exact-object identity check below), which is
      // what makes "one shared ledger" true; embeddings.test.ts's own PIN
      // test proves generateEmbedding itself records exactly one spend row
      // per successful call into whatever ledger it's given.
      mockGenerateEmbedding.mockResolvedValue(makeFakeEmbedding());
      const supabase = makeSupabaseMock({ selectData: makeConversations(3) });
      const guard = guardedContext();
      mockCreateEmbeddingGuardContext.mockReturnValue(guard);

      // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
      await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

      for (const call of mockGenerateEmbedding.mock.calls) {
        expect(call[1].guard).toBe(guard); // same object every time — one shared context, not one per row
      }
    });

    it("ceiling exceeded mid-batch (at the row-10 recheck) stops cleanly, leaves remaining rows untouched, and still flushes the ledger", async () => {
      mockGenerateEmbedding.mockResolvedValue(makeFakeEmbedding());
      mockCheckMonthlyCeiling
        .mockResolvedValueOnce({ allowed: true, spentUsd: 1, ceilingUsd: 5 }) // row 0 preflight: ok
        .mockResolvedValueOnce({ allowed: false, spentUsd: 5, ceilingUsd: 5 }); // row 10 recheck: exceeded
      const supabase = makeSupabaseMock({ selectData: makeConversations(15) });

      // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
      const result = await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

      expect(result.processed).toBe(10); // rows 0-9 succeeded before the row-10 recheck stopped the batch
      expect(result.errors).toEqual([]); // orderly backpressure, not a per-row failure
      expect(mockGenerateEmbedding).toHaveBeenCalledTimes(10); // rows 10-14 never even attempted
      // Ledger still flushed (the `finally` guarantees this even on an early stop).
      expect(mockLedgerFlush).toHaveBeenCalled();
    });

    it("guard disabled (service-role env absent, createEmbeddingGuardContext returns a null guard): proceeds fully unguarded — no ceiling checks, batch still completes", async () => {
      mockCreateEmbeddingGuardContext.mockReturnValue({ supabase: null, ledger: null });
      mockGenerateEmbedding.mockResolvedValue(makeFakeEmbedding());
      const supabase = makeSupabaseMock({ selectData: makeConversations(12) });

      // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
      const result = await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

      expect(result.processed).toBe(12);
      expect(mockCheckMonthlyCeiling).not.toHaveBeenCalled(); // no supabase to check with — skipped entirely
      expect(mockLedgerFlush).not.toHaveBeenCalled(); // guard.ledger is null — nothing to flush
    });
  });

  describe("issue #126 (ADR 0047) — llm feature flag", () => {
    it("skips the whole batch with a single clean log line — never calls generateEmbedding — when the flag is disabled", async () => {
      mockHasFeature.mockResolvedValue(false);
      const supabase = makeSupabaseMock({ selectData: makeConversations(5) });

      // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
      const result = await embedMissingConversations({ from: supabase.from } as any, "user-1", 50);

      expect(result).toEqual({ processed: 0, errors: [] });
      expect(mockGenerateEmbedding).not.toHaveBeenCalled();
      expect(mockCheckMonthlyCeiling).not.toHaveBeenCalled();
    });
  });
});
