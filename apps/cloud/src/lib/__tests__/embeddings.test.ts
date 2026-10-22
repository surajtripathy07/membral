import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the openai module
const mockEmbeddingsCreate = vi.fn();
vi.mock("../openai", () => ({
  getOpenAI: vi.fn(() => ({
    embeddings: {
      create: mockEmbeddingsCreate,
    },
  })),
}));

/**
 * Fake service-role Supabase client factory — issue #92 adversarial review
 * B1: generateEmbedding now mints its OWN service-role client internally
 * (getGuardSupabase) rather than accepting one from the caller, so the
 * cost-guard/ledger plumbing is tested by mocking `@supabase/supabase-js`'s
 * `createClient` directly, not by passing a fake client in as an argument
 * (there is no longer any such argument). Covers exactly what the guard
 * needs: the `llm_spend_sum` RPC (checkMonthlyCeiling) and an
 * insert-capturing `llm_spend` table (createSpendLedger) — not a `.select()`
 * row-fetch mock (mirrors kg/__tests__/spend-ledger.test.ts's own fake, for
 * the same reason as that file's adversarial review N11).
 */
let ledgerInserts: unknown[][] = [];
let ceilingRpcResult: { data: unknown; error: unknown } = { data: "0", error: null };
const mockRpc = vi.fn(() => Promise.resolve(ceilingRpcResult));
const mockCreateServiceClient = vi.fn((_url?: string, _key?: string) => ({
  rpc: mockRpc,
  from: vi.fn(() => ({
    insert: async (rows: unknown) => {
      ledgerInserts.push(Array.isArray(rows) ? rows : [rows]);
      return { data: null, error: null };
    },
  })),
}));
vi.mock("@supabase/supabase-js", () => ({
  createClient: (url?: string, key?: string) => mockCreateServiceClient(url, key),
}));

// Issue #126 (ADR 0047): generateEmbedding gates on assertFeature BEFORE any
// of the ceiling/ledger/OpenAI plumbing above — every pre-existing test in
// this file predates the feature flag and expects that plumbing to run, so
// the default mock resolves (enabled). The dedicated describe block below
// overrides this to reject with FeatureDisabledError for the disabled case.
const mockAssertFeature = vi.fn<(...args: unknown[]) => Promise<void>>(() => Promise.resolve(undefined));
vi.mock("../feature-flags", async () => {
  const actual = await vi.importActual<typeof import("../feature-flags")>("../feature-flags");
  return {
    ...actual,
    assertFeature: (...args: unknown[]) => mockAssertFeature(...args),
  };
});

import {
  EmbeddingCeilingExceededError,
  EmbeddingTokenOverflowError,
  generateEmbedding,
  prepareTextForEmbedding,
} from "../embeddings";
import { FeatureDisabledError } from "../feature-flags";

/** Sets the two env vars getGuardSupabase requires — "the guard is enabled" baseline for most tests. */
function enableGuardEnv(): void {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
}

describe("prepareTextForEmbedding", () => {
  it("combines title and messages into a single string", () => {
    const result = prepareTextForEmbedding("My Chat", [
      { role: "user", content: "Hello there" },
      { role: "assistant", content: "Hi! How can I help?" },
    ]);

    expect(result).toContain("Title: My Chat");
    expect(result).toContain("[user]: Hello there");
    expect(result).toContain("[assistant]: Hi! How can I help?");
  });

  it("truncates long ASCII content to stay within the flat 24000-char budget", () => {
    const longMessages = Array.from({ length: 500 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "A".repeat(500),
    }));

    const result = prepareTextForEmbedding("Long Chat", longMessages);
    // 24000 char budget — result should be well under the full 250k chars,
    // and NOT additionally shrunk (ASCII estimates well under 8000 tokens).
    expect(result.length).toBeLessThanOrEqual(25000);
    expect(result.length).toBeGreaterThan(20000);
    expect(result).toContain("Title: Long Chat");
  });

  it("handles empty messages array", () => {
    const result = prepareTextForEmbedding("Empty Chat", []);
    expect(result).toBe("Title: Empty Chat");
  });

  it("handles messages with empty content", () => {
    const result = prepareTextForEmbedding("Chat", [
      { role: "user", content: "" },
      { role: "assistant", content: "Response" },
    ]);
    expect(result).toContain("[user]: ");
    expect(result).toContain("[assistant]: Response");
  });

  it("issue #90: a Devanagari-dense conversation gets shrunk well below the flat ASCII budget", () => {
    // बच्चों की अटैचमेंट थ्योरी ("children's attachment theory") repeated —
    // every character is in the Devanagari block (U+0900-U+097F), the
    // densest tier (1.0 chars/token). At the flat 24000-char budget this
    // would still land well over the 8192-token model limit.
    const devanagariMessage = "बच्चों की अटैचमेंट थ्योरी ".repeat(1500); // ~39000 chars
    const asciiEquivalentLength = prepareTextForEmbedding("शीर्षक", [
      { role: "user", content: "A".repeat(39000) },
    ]).length;

    const result = prepareTextForEmbedding("शीर्षक", [{ role: "user", content: devanagariMessage }]);

    // The dense-script result must be shrunk noticeably relative to what the
    // same-length ASCII text would produce — proof the heuristic actually
    // fired, not just that truncation happened at all.
    expect(result.length).toBeLessThan(asciiEquivalentLength * 0.75);
    expect(result.length).toBeGreaterThan(0);
  });

  it("issue #90 adversarial review m1: Devanagari (tier 1.0 chars/token) shrinks harder than Cyrillic (tier 2.2) at equal length", () => {
    // Cyrillic (Привет — "hello") sits in the middle tier (2.2 chars/token);
    // Devanagari sits in the densest tier (1.0). A single flat threshold
    // would treat both identically — the tiered table must not.
    const cyrillicMessage = "Привет как дела сегодня хорошо ".repeat(1500);
    const devanagariMessage = "बच्चों की अटैचमेंट थ्योरी ".repeat(1500);

    const cyrillicResult = prepareTextForEmbedding("Заголовок", [{ role: "user", content: cyrillicMessage }]);
    const devanagariResult = prepareTextForEmbedding("शीर्षक", [{ role: "user", content: devanagariMessage }]);

    expect(devanagariResult.length).toBeLessThan(cyrillicResult.length);
  });
});

describe("generateEmbedding", () => {
  beforeEach(() => {
    // mockEmbeddingsCreate.mockReset() (NOT vi.clearAllMocks()): clearAllMocks
    // only clears call HISTORY, not a queued .mockResolvedValueOnce/
    // .mockRejectedValueOnce that a prior test set up but never consumed
    // (e.g. a test whose code path throws before reaching the OpenAI call) —
    // that leftover value silently becomes the NEXT test's first response,
    // which is exactly the class of bug this file hit once already. mockRpc/
    // mockCreateServiceClient keep their baked-in default implementations
    // (set once at module scope) and only need their call history cleared.
    mockEmbeddingsCreate.mockReset();
    mockRpc.mockClear();
    mockCreateServiceClient.mockClear();
    mockAssertFeature.mockReset();
    mockAssertFeature.mockResolvedValue(undefined);
    ledgerInserts = [];
    ceilingRpcResult = { data: "0", error: null };
    enableGuardEnv();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns array of 1536 numbers, and never touches the ceiling/ledger for empty text", async () => {
    const fakeEmbedding = Array.from({ length: 1536 }, () => Math.random());
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: fakeEmbedding }],
      usage: { prompt_tokens: 12 },
    });

    const result = await generateEmbedding("Some text to embed", {
      userId: "user-1",
      pass: "conversation_embedding",
    });

    expect(result).toHaveLength(1536);
    expect(result.every((n) => typeof n === "number")).toBe(true);

    const callArgs = mockEmbeddingsCreate.mock.calls[0][0];
    expect(callArgs.model).toBe("text-embedding-3-small");
    expect(callArgs.dimensions).toBe(1536);
    expect(callArgs.input).toBe("Some text to embed");

    // issue #92: a spend row was recorded, priced via the shared embedCostUsd
    // table (0.02 USD / 1M tokens), tagged with the caller's pass.
    expect(ledgerInserts).toHaveLength(1);
    expect(ledgerInserts[0][0]).toMatchObject({
      user_id: "user-1",
      pass: "conversation_embedding",
      model: "text-embedding-3-small",
      cost_usd: (12 * 0.02) / 1_000_000,
    });
  });

  it("tags query-time embeds with the query_embedding pass, distinct from ingest", async () => {
    mockEmbeddingsCreate.mockResolvedValueOnce({
      data: [{ embedding: new Array(1536).fill(0.5) }],
      usage: { prompt_tokens: 5 },
    });

    await generateEmbedding("react hooks", { userId: "user-1", pass: "query_embedding" });

    expect(ledgerInserts[0][0]).toMatchObject({ pass: "query_embedding" });
  });

  it("returns zero vector for empty text without calling OpenAI or the ceiling RPC", async () => {
    const result = await generateEmbedding("", { userId: "user-1", pass: "conversation_embedding" });

    expect(result).toHaveLength(1536);
    expect(result.every((n) => n === 0)).toBe(true);
    expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it("returns zero vector for whitespace-only text", async () => {
    const result = await generateEmbedding("   \n\t  ", { userId: "user-1", pass: "conversation_embedding" });

    expect(result).toHaveLength(1536);
    expect(result.every((n) => n === 0)).toBe(true);
    expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
  });

  it("propagates a non-overflow API error immediately, with no retry and no spend row", async () => {
    mockEmbeddingsCreate.mockRejectedValueOnce(new Error("Rate limit exceeded"));

    await expect(generateEmbedding("Some text", { userId: "user-1", pass: "conversation_embedding" })).rejects.toThrow(
      "Rate limit exceeded",
    );
    expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1);
    expect(ledgerInserts).toHaveLength(0);
  });

  describe("issue #92 adversarial review B1 — cost guard uses its OWN service-role client, never the caller's", () => {
    it("ledgers spend via an internally-minted service client even for a caller that holds no Supabase client at all (the cookie-client-caller scenario: lib/kg/search.ts, lib/kg/seeded-areas.ts)", async () => {
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.3) }],
        usage: { prompt_tokens: 7 },
      });

      // The caller passes ONLY userId/pass — structurally, there is no
      // client for it to get wrong (that IS the B1 fix). Proving the ledger
      // still gets written proves generateEmbedding's guard is
      // self-sufficient, independent of whatever data client (or none) the
      // calling module happens to hold.
      await generateEmbedding("query text", { userId: "cookie-caller-user", pass: "query_embedding" });

      expect(mockCreateServiceClient).toHaveBeenCalledWith("http://localhost:54321", "service-role-key");
      expect(ledgerInserts).toHaveLength(1);
      expect(ledgerInserts[0][0]).toMatchObject({ user_id: "cookie-caller-user" });
    });

    it("preflights the ceiling via the internal service client's RPC, not any caller-supplied client", async () => {
      ceilingRpcResult = { data: "5", error: null };
      vi.stubEnv("MEMBRAL_KG_MONTHLY_CEILING_USD", "1");
      // No mockEmbeddingsCreate setup needed — the ceiling throws BEFORE any
      // OpenAI call, so queuing a resolved value here would just leak
      // unconsumed into whichever test runs next.

      const err = await generateEmbedding("Some text", { userId: "user-1", pass: "conversation_embedding" }).catch(
        (e) => e,
      );

      expect(err).toBeInstanceOf(EmbeddingCeilingExceededError);
      expect(mockRpc).toHaveBeenCalledWith("llm_spend_sum", expect.objectContaining({ p_user_id: "user-1" }));
      expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
    });

    it("degrades to UNGUARDED (proceeds, no ceiling check, no ledger row) when service-role env vars are missing, and logs a loud warning", async () => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.4) }],
        usage: { prompt_tokens: 9 },
      });

      const result = await generateEmbedding("Some text", { userId: "user-1", pass: "conversation_embedding" });

      expect(result).toHaveLength(1536);
      expect(mockCreateServiceClient).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
      expect(ledgerInserts).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("SUPABASE_SERVICE_ROLE_KEY/NEXT_PUBLIC_SUPABASE_URL not set"),
      );
      warnSpy.mockRestore();
    });
  });

  describe("issue #92 — monthly cost ceiling", () => {
    it("throws EmbeddingCeilingExceededError before calling OpenAI when spend already meets the ceiling", async () => {
      vi.stubEnv("MEMBRAL_KG_MONTHLY_CEILING_USD", "1");
      ceilingRpcResult = { data: "1.5", error: null };

      const err = await generateEmbedding("Some text", {
        userId: "user-1",
        pass: "conversation_embedding",
      }).catch((e) => e);

      expect(err).toBeInstanceOf(EmbeddingCeilingExceededError);
      expect((err as EmbeddingCeilingExceededError).spentUsd).toBeCloseTo(1.5, 8);
      expect((err as EmbeddingCeilingExceededError).ceilingUsd).toBe(1);
      expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
    });

    it("proceeds normally when spend is under the ceiling", async () => {
      vi.stubEnv("MEMBRAL_KG_MONTHLY_CEILING_USD", "10");
      ceilingRpcResult = { data: "1", error: null };
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.1) }],
        usage: { prompt_tokens: 10 },
      });

      const result = await generateEmbedding("Some text", {
        userId: "user-1",
        pass: "conversation_embedding",
      });
      expect(result).toHaveLength(1536);
    });

    it("skipCeiling: still embeds a query when spend already meets the ceiling, and never calls the ceiling RPC", async () => {
      vi.stubEnv("MEMBRAL_KG_MONTHLY_CEILING_USD", "1");
      ceilingRpcResult = { data: "1.5", error: null };
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.1) }],
        usage: { prompt_tokens: 5 },
      });

      const result = await generateEmbedding("some query", {
        userId: "user-1",
        pass: "query_embedding",
        skipCeiling: true,
      });

      expect(result).toHaveLength(1536);
      expect(mockRpc).not.toHaveBeenCalled();
      expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1);
    });

    it("skipCeiling omitted (default): a query-purpose call still throws EmbeddingCeilingExceededError when the ceiling is met", async () => {
      vi.stubEnv("MEMBRAL_KG_MONTHLY_CEILING_USD", "1");
      ceilingRpcResult = { data: "1.5", error: null };

      const err = await generateEmbedding("some query", {
        userId: "user-1",
        pass: "query_embedding",
      }).catch((e) => e);

      expect(err).toBeInstanceOf(EmbeddingCeilingExceededError);
      expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
    });
  });

  describe("issue #90 — reactive halving on token-overflow 400s", () => {
    /** A real OpenAI SDK BadRequestError carries `.status` (and often `.code`) — issue #90 adversarial review M1 requires gating on that, not the message alone. */
    function overflowError(): Error {
      const err = new Error(
        "This model's maximum context length is 8192 tokens, however you requested 9000 tokens. Please reduce your prompt.",
      ) as Error & { status: number };
      err.status = 400;
      return err;
    }

    it("halves the text and retries on a token-overflow 400, succeeding once it fits", async () => {
      mockEmbeddingsCreate
        .mockRejectedValueOnce(overflowError())
        .mockResolvedValueOnce({ data: [{ embedding: new Array(1536).fill(0.2) }], usage: { prompt_tokens: 50 } });

      const bigText = "x".repeat(20000);
      const result = await generateEmbedding(bigText, {
        userId: "user-1",
        pass: "conversation_embedding",
      });

      expect(result).toHaveLength(1536);
      expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(2);
      const firstInput = mockEmbeddingsCreate.mock.calls[0][0].input as string;
      const secondInput = mockEmbeddingsCreate.mock.calls[1][0].input as string;
      expect(secondInput.length).toBeLessThan(firstInput.length);
      expect(secondInput.length).toBeCloseTo(firstInput.length / 2, -2);
    });

    it("PIN: exactly one llm_spend row is recorded on a halving-success, priced at the FINAL (successful) attempt's tokens, not the failed first attempt's", async () => {
      mockEmbeddingsCreate
        .mockRejectedValueOnce(overflowError()) // attempt 1: fails, no usage
        .mockResolvedValueOnce({ data: [{ embedding: new Array(1536).fill(0.2) }], usage: { prompt_tokens: 50 } }); // attempt 2: succeeds

      await generateEmbedding("x".repeat(20000), { userId: "user-1", pass: "conversation_embedding" });

      expect(ledgerInserts).toHaveLength(1); // never one row per attempt
      expect(ledgerInserts[0][0]).toMatchObject({
        cost_usd: (50 * 0.02) / 1_000_000, // final attempt's 50 tokens, not 0 from the failed first attempt
      });
    });

    it("W1: with waitUntil, the llm_spend write is handed off (not awaited) and still lands exactly once", async () => {
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.3) }],
        usage: { prompt_tokens: 7 },
      });
      const handed: Promise<unknown>[] = [];

      const vec = await generateEmbedding("query text", {
        userId: "user-1",
        pass: "query_embedding",
        skipCeiling: true,
        waitUntil: (p) => handed.push(p),
      });

      expect(vec).toHaveLength(1536);
      expect(handed).toHaveLength(1);
      await Promise.all(handed);
      expect(ledgerInserts).toHaveLength(1);
      expect(ledgerInserts[0][0]).toMatchObject({ pass: "query_embedding", cost_usd: (7 * 0.02) / 1_000_000 });
    });

    it("gives up after MAX_HALVINGS (3) retries and throws EmbeddingTokenOverflowError — never retries forever", async () => {
      mockEmbeddingsCreate.mockRejectedValue(overflowError());

      const bigText = "x".repeat(20000);
      const err = await generateEmbedding(bigText, {
        userId: "user-1",
        pass: "conversation_embedding",
      }).catch((e) => e);

      expect(err).toBeInstanceOf(EmbeddingTokenOverflowError);
      // 1 initial attempt + 3 halvings = 4 total calls, then stop.
      expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(4);
      expect(ledgerInserts).toHaveLength(0); // no successful attempt ever, so no spend to ledger
    });

    it("a non-overflow 400 (e.g. invalid input) is never treated as a halving candidate", async () => {
      const err = new Error("Invalid input: input must not be empty") as Error & { status: number };
      err.status = 400;
      mockEmbeddingsCreate.mockRejectedValueOnce(err);

      await expect(
        generateEmbedding("some text", { userId: "user-1", pass: "conversation_embedding" }),
      ).rejects.toThrow("Invalid input");
      expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1);
    });

    it("issue #90 adversarial review M1: a 429 rate-limit error whose MESSAGE mentions 'token' is never classified as overflow (status gate wins over message heuristic)", async () => {
      const err = new Error("You have exceeded token rate limit for this model, please slow down.") as Error & {
        status: number;
      };
      err.status = 429; // NOT 400 — a rate limit, not a context-length overflow
      mockEmbeddingsCreate.mockRejectedValueOnce(err);

      await expect(
        generateEmbedding("some text", { userId: "user-1", pass: "conversation_embedding" }),
      ).rejects.toThrow("exceeded token rate limit");
      // Propagates immediately — no halving attempt, no retry.
      expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe("base-URL / model override (kg/embedding-client.ts's resolveEmbeddingConfig — the OpenRouter-outage fix)", () => {
    it("MEMBRAL_EMBEDDING_MODEL overrides the model sent to embeddings.create AND the llm_spend row's model id", async () => {
      vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "text-embedding-3-large");
      mockEmbeddingsCreate.mockResolvedValueOnce({
        data: [{ embedding: new Array(1536).fill(0.1) }],
        usage: { prompt_tokens: 20 },
      });

      await generateEmbedding("Some text", { userId: "user-1", pass: "conversation_embedding" });

      expect(mockEmbeddingsCreate.mock.calls[0][0].model).toBe("text-embedding-3-large");
      expect(ledgerInserts[0][0]).toMatchObject({
        model: "text-embedding-3-large",
        cost_usd: (20 * 0.13) / 1_000_000, // text-embedding-3-large's price in kg/llm.ts's EMBED_PRICING
      });
    });

    it("when a base URL is set and the bare model id is rejected as unknown, retries with the openai/-prefixed id and STILL logs spend under the canonical bare id", async () => {
      vi.stubEnv("MEMBRAL_MODEL_BASE_URL", "https://openrouter.ai/api/v1");
      const notFound = new Error("model_not_found: text-embedding-3-small is not a valid model ID") as Error & {
        status: number;
      };
      notFound.status = 400;
      mockEmbeddingsCreate
        .mockRejectedValueOnce(notFound)
        .mockResolvedValueOnce({ data: [{ embedding: new Array(1536).fill(0.2) }], usage: { prompt_tokens: 8 } });

      const result = await generateEmbedding("Some text", { userId: "user-1", pass: "conversation_embedding" });

      expect(result).toHaveLength(1536);
      expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(2);
      expect(mockEmbeddingsCreate.mock.calls[0][0].model).toBe("text-embedding-3-small");
      expect(mockEmbeddingsCreate.mock.calls[1][0].model).toBe("openai/text-embedding-3-small");
      // Spend is still logged under the canonical bare id, not the prefixed wire variant.
      expect(ledgerInserts).toHaveLength(1);
      expect(ledgerInserts[0][0]).toMatchObject({ model: "text-embedding-3-small" });
    });

    it("without a base URL, an unknown-model error is never treated as retryable (would mask a real misconfiguration against plain OpenAI)", async () => {
      const notFound = new Error("The model `bogus` does not exist") as Error & { status: number };
      notFound.status = 404;
      mockEmbeddingsCreate.mockRejectedValueOnce(notFound);

      await expect(
        generateEmbedding("Some text", { userId: "user-1", pass: "conversation_embedding" }),
      ).rejects.toThrow("does not exist");
      expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1);
    });
  });

  describe("issue #126 (ADR 0047) — llm feature flag", () => {
    it("throws FeatureDisabledError and never calls the provider or the ceiling/ledger when the flag is disabled", async () => {
      mockAssertFeature.mockRejectedValueOnce(new FeatureDisabledError("llm"));

      await expect(
        generateEmbedding("Some text to embed", { userId: "user-1", pass: "conversation_embedding" }),
      ).rejects.toBeInstanceOf(FeatureDisabledError);

      expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
      expect(ledgerInserts).toHaveLength(0);
    });

    it("checks the feature flag even for a batched (opts.guard) call, which otherwise skips the per-call ceiling preflight", async () => {
      mockAssertFeature.mockRejectedValueOnce(new FeatureDisabledError("llm"));

      await expect(
        generateEmbedding("Some text", {
          userId: "user-1",
          pass: "conversation_embedding",
          guard: { supabase: null, ledger: null },
        }),
      ).rejects.toBeInstanceOf(FeatureDisabledError);
      expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
    });

    it("skipCeiling does NOT bypass the feature flag — a query-purpose call still throws FeatureDisabledError when embeddings are off", async () => {
      mockAssertFeature.mockRejectedValueOnce(new FeatureDisabledError("embeddings"));

      await expect(
        generateEmbedding("some query", { userId: "user-1", pass: "query_embedding", skipCeiling: true }),
      ).rejects.toBeInstanceOf(FeatureDisabledError);

      expect(mockEmbeddingsCreate).not.toHaveBeenCalled();
      expect(mockRpc).not.toHaveBeenCalled();
    });
  });
});
