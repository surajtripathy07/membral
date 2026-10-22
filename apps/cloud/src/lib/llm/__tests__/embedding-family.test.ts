// D-072 (W7 local embeddings): family canonicalization, zero-padding, the
// store's one-family invariant, kg skip, cosine-path skip and $0 local pricing.
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scoreConversationCandidates } from "@/lib/code-sessions/content-match";
import { DEFAULT_FAMILY_THRESHOLDS } from "@/lib/domain/similarity";
import { embedTexts } from "@/lib/memory/embed";
import { dedupeByCosine } from "@/lib/memory/merge";
import { mergeSemanticDuplicates, semanticDedupMinSim } from "@/lib/memory/write/io";
import { planSupersede } from "@/lib/memory/write/supersede";
import { embedCostUsd, LlmClient, type OpenAILike, UnpricedModelError } from "../client";
import { type ModelConfig, resolveModelConfig } from "../config";
import {
  callEmbeddingsCreate,
  canonicalEmbeddingFamily,
  currentEmbeddingFamily,
  DEFAULT_EMBEDDING_FAMILY,
  EmbeddingDimensionError,
  embeddingModelField,
  embeddingRequestBody,
  isFreeEmbeddingBaseURL,
  padEmbedding,
  resolveEmbeddingConfig,
} from "../embedding-client";
import {
  assertEmbeddingFamilyWritable,
  EmbeddingFamilyMismatchError,
  FAMILY_CHECK_TTL_MS,
  kgEmbeddingsAllowed,
  rawUnitCuts,
  resetEmbeddingFamilyCacheForTests,
  vectorThreshold,
} from "../embedding-family";

const LOCAL = "nomic-embed-text";
/** A model with no calibration table: every cosine step stays skipped. */
const UNCALIBRATED = "mxbai-embed-large";

/** Fake supabase: `from(t).select().not().or().limit()` resolves `rows[t]` (default []), recording every query. */
function fakeStore(rows: Record<string, unknown[]> = {}) {
  const queries: Array<{ table: string; or?: string; not: string[] }> = [];
  const from = vi.fn((table: string) => {
    const q: { table: string; or?: string; not: string[] } = { table, not: [] };
    queries.push(q);
    const chain = {
      select: () => chain,
      not: (col: string, op: string, v: unknown) => {
        q.not.push(`${col}.${op}.${String(v)}`);
        return chain;
      },
      or: (f: string) => {
        q.or = f;
        return chain;
      },
      limit: () => Promise.resolve({ data: rows[table] ?? [], error: null }),
    };
    return chain;
  });
  // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
  return { db: { from } as any, from, queries };
}

beforeEach(() => resetEmbeddingFamilyCacheForTests());
afterEach(() => vi.unstubAllEnvs());

describe("canonicalEmbeddingFamily", () => {
  it("strips only the known openai/ prefix", () => {
    expect(canonicalEmbeddingFamily("openai/text-embedding-3-small")).toBe("text-embedding-3-small");
    expect(canonicalEmbeddingFamily(`ollama/${LOCAL}`)).toBe(`ollama/${LOCAL}`);
    expect(canonicalEmbeddingFamily("hf.co/org/model")).toBe("hf.co/org/model");
    expect(canonicalEmbeddingFamily(" text-embedding-3-small ")).toBe("text-embedding-3-small");
    expect(canonicalEmbeddingFamily(LOCAL)).toBe(LOCAL);
  });

  it("the OpenRouter default resolves to the default family", () => {
    const env = { OPENROUTER_API_KEY: "k" };
    expect(resolveEmbeddingConfig(env).model).toBe("openai/text-embedding-3-small");
    expect(currentEmbeddingFamily(env)).toBe(DEFAULT_EMBEDDING_FAMILY);
    expect(currentEmbeddingFamily({ MEMBRAL_EMBEDDING_MODEL: LOCAL })).toBe(LOCAL);
  });
});

describe("zero-padding", () => {
  it("pads a narrower vector to 1536 with zeros; cosine is unchanged", () => {
    const a = [0.3, -0.2, 0.9];
    const b = [0.1, 0.4, 0.5];
    const pa = padEmbedding(a);
    const pb = padEmbedding(b);
    expect(pa).toHaveLength(1536);
    expect(pa.slice(3).every((v) => v === 0)).toBe(true);
    const cos = (x: number[], y: number[]) =>
      x.reduce((s, v, i) => s + v * y[i], 0) /
      (Math.sqrt(x.reduce((s, v) => s + v * v, 0)) * Math.sqrt(y.reduce((s, v) => s + v * v, 0)));
    expect(cos(pa, pb)).toBeCloseTo(cos(a, b), 12);
  });

  it("a vector wider than 1536 is an error, never truncated", () => {
    expect(() => padEmbedding(new Array(1537).fill(0.1))).toThrow(EmbeddingDimensionError);
  });

  it("through the real openai SDK, an Ollama-style float reply keeps its values (W7 D4: base64 default decoded floats into ~0)", async () => {
    const fetchMock = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
      const sent = JSON.parse(String(init?.body));
      expect(sent.encoding_format).toBe("float");
      // Ollama ignores encoding_format and always answers with floats.
      return new Response(JSON.stringify({ data: [{ embedding: [0.5, -0.25, 0.125] }], usage: { prompt_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const openai = new OpenAI({ apiKey: "x", baseURL: "http://localhost:11434/v1", fetch: fetchMock as never });
    const cfg = { model: LOCAL, baseURL: "http://localhost:11434/v1", apiKey: "x", dimensions: 1536 as const };
    const res = await callEmbeddingsCreate((body) => openai.embeddings.create(body), cfg, "hi");
    expect(res.data[0].embedding.slice(0, 3)).toEqual([0.5, -0.25, 0.125]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("text-embedding-3 keeps its body: dimensions, no encoding_format", () => {
    expect(embeddingRequestBody("text-embedding-3-small", "hi")).toEqual({
      model: "text-embedding-3-small",
      input: "hi",
      dimensions: 1536,
    });
  });

  it("callEmbeddingsCreate: a local model omits dimensions, pads, and records its family", async () => {
    const create = vi.fn().mockResolvedValue({ data: [{ embedding: [1, 2, 3] }], usage: { prompt_tokens: 2 } });
    const cfg = { model: LOCAL, baseURL: "http://localhost:11434/v1", apiKey: "x", dimensions: 1536 as const };
    const res = await callEmbeddingsCreate(create, cfg, "hi");
    expect(create).toHaveBeenCalledWith({ model: LOCAL, input: "hi", encoding_format: "float" });
    expect(res.data[0].embedding).toHaveLength(1536);
    expect(res.family).toBe(LOCAL);
    expect(res.usedModel).toBe(LOCAL);
  });

  it("callEmbeddingsCreate: a too-wide local vector rejects", async () => {
    const create = vi.fn().mockResolvedValue({ data: [{ embedding: new Array(2048).fill(0) }] });
    const cfg = { model: LOCAL, baseURL: "http://x/v1", apiKey: "x", dimensions: 1536 as const };
    await expect(callEmbeddingsCreate(create, cfg, "hi")).rejects.toThrow(EmbeddingDimensionError);
  });

  it("callEmbeddingsCreate: the model actually used after the openai/ retry is recorded, same family", async () => {
    const err = Object.assign(new Error("model not found"), { status: 404 });
    const create = vi
      .fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ data: [{ embedding: new Array(1536).fill(0.1) }] });
    const cfg = { model: DEFAULT_EMBEDDING_FAMILY, baseURL: "http://x/v1", apiKey: "x", dimensions: 1536 as const };
    const res = await callEmbeddingsCreate(create, cfg, "hi");
    expect(res.usedModel).toBe("openai/text-embedding-3-small");
    expect(res.family).toBe(DEFAULT_EMBEDDING_FAMILY);
  });

  it("LlmClient.embedMany pads a local model's vectors and sends no dimensions", async () => {
    const create = vi.fn().mockResolvedValue({ data: [{ embedding: [1, 0] }, { embedding: [0, 1] }] });
    const client: OpenAILike = { chat: { completions: { create: vi.fn() } }, embeddings: { create } };
    const config: ModelConfig = {
      model: "m",
      baseURL: "http://localhost:11434/v1",
      apiKey: "x",
      embedModel: LOCAL,
      embedDimensions: 1536,
      embedSelfHosted: true,
    };
    const llm = new LlmClient(config, { client });
    const { vectors, record } = await llm.embedMany({ texts: ["a", "b"], pass: "embed", conversationId: "c" });
    expect(create).toHaveBeenCalledWith({ model: LOCAL, input: ["a", "b"], encoding_format: "float" });
    expect(vectors.map((v) => v.length)).toEqual([1536, 1536]);
    expect(record.cost_usd).toBe(0);
    expect(llm.embedFamily).toBe(LOCAL);
  });
});

describe("$0 pricing for a self-hosted embedding model", () => {
  it("an unlisted model is $0 only with an explicit base URL", () => {
    expect(embedCostUsd(LOCAL, 1000)).toBeNull();
    expect(embedCostUsd(LOCAL, 1000, { selfHosted: true })).toBe(0);
    expect(embedCostUsd("text-embedding-3-small", 1_000_000, { selfHosted: true })).toBeCloseTo(0.02);
  });

  it("resolveModelConfig marks self-hosted only for an explicit base URL on a private host", () => {
    expect(resolveModelConfig({ OPENAI_API_KEY: "k" }).embedSelfHosted).toBe(false);
    expect(resolveModelConfig({ OPENROUTER_API_KEY: "k" }).embedSelfHosted).toBe(false);
    expect(
      resolveModelConfig({ MEMBRAL_MODEL_BASE_URL: "https://openrouter.ai/api/v1", OPENAI_API_KEY: "k" })
        .embedSelfHosted,
    ).toBe(false);
    expect(
      resolveModelConfig({ MEMBRAL_EMBEDDINGS_BASE_URL: "http://host.docker.internal:11434/v1", OPENAI_API_KEY: "k" })
        .embedSelfHosted,
    ).toBe(true);
  });

  it("isFreeEmbeddingBaseURL: loopback and host.docker.internal only, or MEMBRAL_EMBEDDINGS_FREE=1", () => {
    for (const u of [
      "http://localhost:11434/v1",
      "http://127.0.0.1:11434/v1",
      "http://127.8.9.10/v1",
      "http://host.docker.internal:11434/v1",
      "http://[::1]:11434/v1",
    ])
      expect(isFreeEmbeddingBaseURL(u, {}), u).toBe(true);
    for (const u of [
      "https://openrouter.ai/api/v1",
      "http://10.0.0.5/v1",
      "http://192.168.1.9/v1",
      "http://box.local/v1",
      "not a url",
      undefined,
    ])
      expect(isFreeEmbeddingBaseURL(u, {}), String(u)).toBe(false);
    const free = { MEMBRAL_EMBEDDINGS_FREE: "1" };
    expect(isFreeEmbeddingBaseURL("http://192.168.1.9/v1", free)).toBe(false);
    expect(isFreeEmbeddingBaseURL("http://192.168.1.9/v1", { ...free, MEMBRAL_LOCAL: "1", VERCEL: "1" })).toBe(false);
    expect(isFreeEmbeddingBaseURL("http://192.168.1.9/v1", { ...free, MEMBRAL_LOCAL: "1" })).toBe(true);
  });

  it("embeddingModelField: only a non-default family with a vector writes the column", () => {
    expect(embeddingModelField(true, DEFAULT_EMBEDDING_FAMILY)).toEqual({});
    expect(embeddingModelField(true, "openai/text-embedding-3-small")).toEqual({});
    expect(embeddingModelField(false, LOCAL)).toEqual({});
    expect(embeddingModelField(true, LOCAL)).toEqual({ embedding_model: LOCAL });
  });

  it("the hosted unknown-model guard still refuses", async () => {
    const client: OpenAILike = { chat: { completions: { create: vi.fn() } }, embeddings: { create: vi.fn() } };
    const config: ModelConfig = {
      model: "m",
      baseURL: undefined,
      apiKey: "k",
      embedModel: LOCAL,
      embedDimensions: 1536,
    };
    const llm = new LlmClient(config, { client });
    await expect(llm.embed({ text: "x", pass: "embed", conversationId: "c" })).rejects.toThrow(UnpricedModelError);
  });
});

describe("store invariant (assertEmbeddingFamilyWritable)", () => {
  const HOSTED = {};
  const LOCAL_RUN = { MEMBRAL_LOCAL: "1" };

  it("hosted + default family never queries (also on a local box that is on Vercel)", async () => {
    const store = fakeStore({ session_memories: [{ id: "x" }] });
    await expect(
      assertEmbeddingFamilyWritable(store.db, DEFAULT_EMBEDDING_FAMILY, { env: HOSTED }),
    ).resolves.toBeUndefined();
    await expect(
      assertEmbeddingFamilyWritable(store.db, DEFAULT_EMBEDDING_FAMILY, { env: { MEMBRAL_LOCAL: "1", VERCEL: "1" } }),
    ).resolves.toBeUndefined();
    expect(store.from).not.toHaveBeenCalled();
  });

  it("local + default family refuses when any vector carries a non-null embedding_model", async () => {
    const store = fakeStore({ conversation_chunks: [{ id: "k" }] });
    await expect(
      assertEmbeddingFamilyWritable(store.db, DEFAULT_EMBEDDING_FAMILY, { env: LOCAL_RUN }),
    ).rejects.toBeInstanceOf(EmbeddingFamilyMismatchError);
    expect(store.queries[0].not).toEqual(["embedding.is.null", "embedding_model.is.null"]);
    expect(store.queries[0].or).toBeUndefined();
  });

  it("local + default family passes on a clean store", async () => {
    const store = fakeStore();
    await expect(
      assertEmbeddingFamilyWritable(store.db, DEFAULT_EMBEDDING_FAMILY, { env: LOCAL_RUN }),
    ).resolves.toBeUndefined();
    expect(store.queries).toHaveLength(3);
  });

  it("a clean store passes, checks all three tables, and caches the result for the TTL", async () => {
    const store = fakeStore();
    await assertEmbeddingFamilyWritable(store.db, LOCAL, { now: 0 });
    await assertEmbeddingFamilyWritable(store.db, LOCAL, { now: FAMILY_CHECK_TTL_MS - 1 });
    expect(store.queries.map((q) => q.table)).toEqual(["session_memories", "conversations", "conversation_chunks"]);
    expect(store.queries[0].or).toBe(`embedding_model.is.null,embedding_model.neq."${LOCAL}"`);
    await assertEmbeddingFamilyWritable(store.db, LOCAL, { now: FAMILY_CHECK_TTL_MS });
    expect(store.queries).toHaveLength(6);
  });

  it("the or-filter quotes a model id containing ':'", async () => {
    const store = fakeStore();
    await assertEmbeddingFamilyWritable(store.db, "qwen3-embedding:0.6b");
    expect(store.queries[0].or).toBe('embedding_model.is.null,embedding_model.neq."qwen3-embedding:0.6b"');
  });

  it("another family's vector refuses with EmbeddingFamilyMismatchError, cached", async () => {
    const store = fakeStore({ conversations: [{ id: "c1" }] });
    const first = assertEmbeddingFamilyWritable(store.db, LOCAL);
    await expect(first).rejects.toBeInstanceOf(EmbeddingFamilyMismatchError);
    await expect(first).rejects.toThrow(/membral local reembed/);
    const calls = store.from.mock.calls.length;
    await expect(assertEmbeddingFamilyWritable(store.db, LOCAL)).rejects.toBeInstanceOf(EmbeddingFamilyMismatchError);
    expect(store.from.mock.calls.length).toBe(calls);
  });

  it("embedTexts treats a refusal as embeddings-disabled: null vectors, no provider call", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", LOCAL);
    const store = fakeStore({ session_memories: [{ id: "old" }] });
    const create = vi.fn();
    const client: OpenAILike = { chat: { completions: { create: vi.fn() } }, embeddings: { create } };
    const llm = new LlmClient(
      { model: "m", baseURL: undefined, apiKey: "k", embedModel: LOCAL, embedDimensions: 1536 },
      { client },
    );
    const res = await embedTexts(llm, ["a", "b"], "s1", store.db);
    expect(res.vectors).toEqual([null, null]);
    expect(res.familyBlocked).toMatch(/membral local reembed/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("non-default family: cosine steps are skipped", () => {
  it("kgEmbeddingsAllowed is true for the default family", () => {
    expect(kgEmbeddingsAllowed("x", DEFAULT_EMBEDDING_FAMILY)).toBe(true);
  });

  it("write-time semantic dedup (memory_semantic_duplicates) is skipped on an uncalibrated model: 0, no RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const db = { rpc, from: vi.fn() } as any;
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", UNCALIBRATED);
    expect(await mergeSemanticDuplicates(db, "u1", ["r1"])).toBe(0);
    expect(rpc).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
    await mergeSemanticDuplicates(db, "u1", ["r1"]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1].p_min_sim).toBe(0.8);
  });

  it("write-time semantic dedup on nomic runs at the calibrated 0.86, not the hosted 0.80", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    // biome-ignore lint/suspicious/noExplicitAny: test double
    const db = { rpc, from: vi.fn() } as any;
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", LOCAL);
    await mergeSemanticDuplicates(db, "u1", ["r1"]);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc.mock.calls[0][1].p_min_sim).toBe(0.86);
  });

  it("vectorThreshold: the default family keeps the historical value of every step", () => {
    const expected = {
      in_batch_dedupe: 0.93,
      cross_session_dedup: 0.94,
      semantic_dedup: 0.8,
      supersede: 0.9,
      recurrence: 0.8,
      blocker_dismiss: 0.8,
      content_match: 0.42,
      sem_floor: 0.5,
      mixed_sem_floor: 0.4,
      sql_cut: 0.3,
    } as const;
    for (const [step, value] of Object.entries(expected)) {
      expect(vectorThreshold(step as keyof typeof expected, DEFAULT_EMBEDDING_FAMILY)).toBe(value);
      // the hosted OpenRouter spelling is the same family
      expect(vectorThreshold(step as keyof typeof expected, `openai/${DEFAULT_EMBEDDING_FAMILY}`)).toBe(value);
    }
    expect(DEFAULT_FAMILY_THRESHOLDS).toEqual(expected);
  });

  it("semanticDedupMinSim: env override applies only on a calibrated family", () => {
    expect(semanticDedupMinSim({ MEMBRAL_EMBEDDING_MODEL: LOCAL })).toBe(0.86);
    expect(semanticDedupMinSim({ MEMBRAL_EMBEDDING_MODEL: LOCAL, MEMBRAL_MEMORY_DEDUP_MIN_SIM: "0.9" })).toBe(0.9);
    expect(semanticDedupMinSim({ MEMBRAL_EMBEDDING_MODEL: UNCALIBRATED })).toBeNull();
    expect(
      semanticDedupMinSim({ MEMBRAL_EMBEDDING_MODEL: UNCALIBRATED, MEMBRAL_MEMORY_DEDUP_MIN_SIM: "0.9" }),
    ).toBeNull();
  });

  it("vectorThreshold: nomic has its own values, an unknown model has none", () => {
    expect(vectorThreshold("semantic_dedup", LOCAL)).toBe(0.86);
    expect(vectorThreshold("sem_floor", LOCAL)).toBe(0.66);
    expect(vectorThreshold("content_match", LOCAL)).toBeNull();
    for (const step of Object.keys(DEFAULT_FAMILY_THRESHOLDS))
      expect(vectorThreshold(step as keyof typeof DEFAULT_FAMILY_THRESHOLDS, UNCALIBRATED)).toBeNull();
  });

  const v = [1, 0, 0];
  const records = [
    { text: "first", embedding: v, windowIndex: 0 },
    { text: "second", embedding: v, windowIndex: 1 },
  ];

  it("in-batch dedupe, supersede and content match use cosine on calibrated families only", () => {
    // biome-ignore lint/suspicious/noExplicitAny: minimal record shape for the cosine step
    expect(dedupeByCosine(records as any)).toHaveLength(1);
    expect(
      planSupersede([{ id: "n", text: "new", embedding: v }], [{ id: "o", text: "old", embedding: v }]).links,
    ).toEqual([{ id: "n", supersedes: "o" }]);
    const cands = [{ conversationId: "c", title: null, embedding: v }];
    expect(scoreConversationCandidates(v, cands, { threshold: 0.5, topK: 5 })).toHaveLength(1);

    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", UNCALIBRATED);
    // biome-ignore lint/suspicious/noExplicitAny: minimal record shape for the cosine step
    expect(dedupeByCosine(records as any)).toHaveLength(2);
    expect(
      planSupersede([{ id: "n", text: "new", embedding: v }], [{ id: "o", text: "old", embedding: v }]).links,
    ).toEqual([]);
    expect(scoreConversationCandidates(v, cands, { threshold: 0.5, topK: 5 })).toEqual([]);
    // Text-equal supersede still links: only the cosine step is skipped.
    expect(
      planSupersede([{ id: "n", text: "same", embedding: v }], [{ id: "o", text: "same", embedding: v }]).links,
    ).toEqual([{ id: "n", supersedes: "o" }]);
  });

  it("nomic: in-batch and supersede cuts sit where the calibration put them (0.93, 0.91)", () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", LOCAL);
    const at = (cos: number) => [Math.cos(Math.acos(cos)), Math.sin(Math.acos(cos)), 0];
    const pair = (cos: number) => [
      { text: "first", embedding: [1, 0, 0], windowIndex: 0 },
      { text: "second", embedding: at(cos), windowIndex: 1 },
    ];
    // biome-ignore lint/suspicious/noExplicitAny: minimal record shape for the cosine step
    expect(dedupeByCosine(pair(0.92) as any)).toHaveLength(2);
    // biome-ignore lint/suspicious/noExplicitAny: minimal record shape for the cosine step
    expect(dedupeByCosine(pair(0.94) as any)).toHaveLength(1);
    const links = (cos: number) =>
      planSupersede([{ id: "n", text: "new", embedding: at(cos) }], [{ id: "o", text: "old", embedding: [1, 0, 0] }])
        .links;
    expect(links(0.9)).toEqual([]);
    expect(links(0.92)).toEqual([{ id: "n", supersedes: "o" }]);
    // content match has no calibration on nomic: still no link by content
    const cands = [{ conversationId: "c", title: null, embedding: [1, 0, 0] }];
    expect(scoreConversationCandidates([1, 0, 0], cands, { threshold: 0.5, topK: 5 })).toEqual([]);
  });
});

describe("rawUnitCuts (I33 raw path)", () => {
  beforeEach(() => resetEmbeddingFamilyCacheForTests());

  it("nomic carries the chunk floor and abstain gate beside the record cuts", () => {
    const cuts = rawUnitCuts(LOCAL);
    expect(cuts).toMatchObject({ chunk_floor: 0.626, chunk_abstain: 0.689 });
    expect(cuts?.sql_cut).toBe(vectorThreshold("sql_cut", LOCAL));
  });

  it("another family has none and warns once", async () => {
    const { log } = await import("@/lib/log");
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    expect(rawUnitCuts(UNCALIBRATED)).toBeNull();
    expect(rawUnitCuts(UNCALIBRATED)).toBeNull();
    expect(rawUnitCuts(DEFAULT_EMBEDDING_FAMILY)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });
});
