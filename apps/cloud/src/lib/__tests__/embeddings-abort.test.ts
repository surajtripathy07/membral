import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// An aborted / timed-out query embedding: the abort signal and no-retry options reach the SDK call, the call is not
// retried, and no llm_spend row is written for it.
const mockEmbeddingsCreate = vi.fn();
vi.mock("../openai", () => ({
  getOpenAI: vi.fn(() => ({ embeddings: { create: mockEmbeddingsCreate } })),
}));

const ledgerInserts: unknown[] = [];
const mockRpc = vi.fn(() => Promise.resolve({ data: "0", error: null }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    rpc: mockRpc,
    from: () => ({
      insert: async (rows: unknown) => {
        ledgerInserts.push(rows);
        return { data: null, error: null };
      },
    }),
  }),
}));
vi.mock("../feature-flags", async () => {
  const actual = await vi.importActual<typeof import("../feature-flags")>("../feature-flags");
  return { ...actual, assertFeature: () => Promise.resolve(undefined) };
});

import { generateEmbedding } from "../embeddings";

const vec = new Array(1536).fill(0.1);

beforeEach(() => {
  ledgerInserts.length = 0;
  mockEmbeddingsCreate.mockReset();
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-key");
});
afterEach(() => vi.unstubAllEnvs());

describe("generateEmbedding with a signal (query-time)", () => {
  it("passes the signal, maxRetries 0 and the explicit timeout to the SDK call", async () => {
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: vec }], usage: { prompt_tokens: 3 } });
    const controller = new AbortController();
    await generateEmbedding("hello", {
      userId: "u",
      pass: "query_embedding",
      skipCeiling: true,
      signal: controller.signal,
    });
    expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1);
    const [, reqOpts] = mockEmbeddingsCreate.mock.calls[0];
    expect(reqOpts).toEqual({ signal: controller.signal, maxRetries: 0, timeout: 4000 });
  });

  it("MEMBRAL_EMBED_TIMEOUT_MS sets the timeout", async () => {
    vi.stubEnv("MEMBRAL_EMBED_TIMEOUT_MS", "2500");
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: vec }], usage: { prompt_tokens: 3 } });
    await generateEmbedding("hello", {
      userId: "u",
      pass: "query_embedding",
      skipCeiling: true,
      timeoutMs: undefined,
      signal: new AbortController().signal,
    });
    expect(mockEmbeddingsCreate.mock.calls[0][1].timeout).toBe(2500);
  });

  it("an abort rejects without a retry and records no spend", async () => {
    const controller = new AbortController();
    mockEmbeddingsCreate.mockImplementation(
      (_body: unknown, o: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          o.signal.addEventListener("abort", () => reject(new Error("Request was aborted.")));
        }),
    );
    const p = generateEmbedding("hello", {
      userId: "u",
      pass: "query_embedding",
      skipCeiling: true,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mockEmbeddingsCreate).toHaveBeenCalled());
    controller.abort();
    await expect(p).rejects.toThrow(/aborted/);
    expect(mockEmbeddingsCreate).toHaveBeenCalledTimes(1);
    expect(ledgerInserts).toHaveLength(0);
  });

  it("callers without a signal keep the one-argument SDK call", async () => {
    mockEmbeddingsCreate.mockResolvedValue({ data: [{ embedding: vec }], usage: { prompt_tokens: 3 } });
    await generateEmbedding("hello", { userId: "u", pass: "query_embedding", skipCeiling: true });
    expect(mockEmbeddingsCreate.mock.calls[0]).toHaveLength(1);
  });
});
