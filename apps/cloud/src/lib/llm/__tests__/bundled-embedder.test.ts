import { afterEach, describe, expect, it, vi } from "vitest";
import { embedInput, queryEmbedInput } from "@/lib/memory/raw-units/embed";
import { FLOOR_OFF, familyFloor } from "@/lib/memory/search";
import {
  BUNDLED_EMBEDDING_MODEL,
  BUNDLED_LOAD_RETRY_MS,
  BUNDLED_LOAD_TIMEOUT_MS,
  BUNDLED_MAX_CHARS,
  bundledEmbeddingsCreate,
  setBundledPipelineLoaderForTests,
  warmBundledEmbedder,
} from "../bundled-embedder";
import {
  callEmbeddingsCreate,
  currentEmbeddingFamily,
  embeddingModelField,
  embeddingsConfigured,
  isBundledEmbeddingConfig,
  resolveEmbeddingConfig,
} from "../embedding-client";
import { lexicalMinHits, RAW_UNIT_THRESHOLDS, rawUnitCuts, vectorThreshold } from "../embedding-family";

const vec768 = (seed: number) => Array.from({ length: 768 }, (_, i) => (i === 0 ? seed : 0));

function fakeLoader() {
  const extractor = vi.fn(async (texts: string[]) => ({ tolist: () => texts.map((_, i) => vec768(i + 1)) }));
  const loader = vi.fn(async () => extractor);
  setBundledPipelineLoaderForTests(loader);
  return { extractor, loader };
}

afterEach(() => setBundledPipelineLoaderForTests(null));

describe("bundled embedder", () => {
  it("embeds a batch with mean pooling + normalize, and loads the pipeline once", async () => {
    const { extractor, loader } = fakeLoader();
    const a = await bundledEmbeddingsCreate({ input: ["x", "y"] });
    await bundledEmbeddingsCreate({ input: "z" });
    expect(a.data).toHaveLength(2);
    expect(extractor).toHaveBeenCalledWith(["x", "y"], { pooling: "mean", normalize: true });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("a load that never settles times out, is cached as a failure, and is retried later", async () => {
    vi.useFakeTimers();
    try {
      const loader = vi
        .fn()
        .mockImplementationOnce(() => new Promise(() => {}))
        .mockResolvedValue(async () => ({ tolist: () => [vec768(1)] }));
      setBundledPipelineLoaderForTests(loader, () => Date.now());
      const first = expect(bundledEmbeddingsCreate({ input: "x" })).rejects.toThrow(/model load timed out/);
      await vi.advanceTimersByTimeAsync(BUNDLED_LOAD_TIMEOUT_MS + 1);
      await first;
      await expect(bundledEmbeddingsCreate({ input: "x" })).rejects.toThrow(/model load timed out/);
      expect(loader).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(BUNDLED_LOAD_RETRY_MS + 1);
      await expect(bundledEmbeddingsCreate({ input: "x" })).resolves.toBeTruthy();
      expect(loader).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caches a failed load for 5 minutes, then retries", async () => {
    let now = 1_000_000;
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(async () => ({ tolist: () => [vec768(1)] }));
    setBundledPipelineLoaderForTests(loader, () => now);
    await expect(bundledEmbeddingsCreate({ input: "x" })).rejects.toThrow("offline");
    now += BUNDLED_LOAD_RETRY_MS - 1;
    await expect(bundledEmbeddingsCreate({ input: "x" })).rejects.toThrow("offline");
    expect(loader).toHaveBeenCalledTimes(1);
    now += 2;
    await expect(bundledEmbeddingsCreate({ input: "x" })).resolves.toBeTruthy();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("races a slow model load against the request timeout", async () => {
    setBundledPipelineLoaderForTests(() => new Promise(() => {})); // a download that never finishes
    await expect(bundledEmbeddingsCreate({ input: "x" }, { timeout: 20 })).rejects.toThrow(/timed out after 20ms/);
  });

  it("races the load against the abort signal", async () => {
    setBundledPipelineLoaderForTests(() => new Promise(() => {}));
    const ac = new AbortController();
    const p = bundledEmbeddingsCreate({ input: "x" }, { signal: ac.signal });
    ac.abort(new Error("caller gave up"));
    await expect(p).rejects.toThrow("caller gave up");
  });

  it("warmBundledEmbedder starts the load without throwing on failure", async () => {
    const loader = vi.fn().mockRejectedValue(new Error("offline"));
    setBundledPipelineLoaderForTests(loader);
    warmBundledEmbedder();
    await new Promise((r) => setTimeout(r, 0));
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("truncates each text to BUNDLED_MAX_CHARS before embedding", async () => {
    const { extractor } = fakeLoader();
    await bundledEmbeddingsCreate({ input: ["a".repeat(BUNDLED_MAX_CHARS + 500), "short"] });
    const sent = extractor.mock.calls[0]?.[0] as string[];
    expect(sent[0]).toHaveLength(BUNDLED_MAX_CHARS);
    expect(sent[1]).toBe("short");
  });

  it("zero-pads 768 to 1536 through callEmbeddingsCreate and records the family", async () => {
    fakeLoader();
    const config = resolveEmbeddingConfig({ MEMBRAL_EMBEDDING_MODEL: BUNDLED_EMBEDDING_MODEL });
    const res = await callEmbeddingsCreate((body) => bundledEmbeddingsCreate(body), config, ["x"]);
    expect(res.data[0].embedding).toHaveLength(1536);
    expect(res.data[0].embedding[0]).toBe(1);
    expect(res.data[0].embedding.slice(768).every((n) => n === 0)).toBe(true);
    expect(res.family).toBe(BUNDLED_EMBEDDING_MODEL);
    expect(embeddingModelField(true, res.family)).toEqual({ embedding_model: BUNDLED_EMBEDDING_MODEL });
  });
});

describe("provider selection", () => {
  const local = { MEMBRAL_LOCAL: "1" };

  it("is the local default when nothing else is configured", () => {
    const c = resolveEmbeddingConfig(local);
    expect(isBundledEmbeddingConfig(c)).toBe(true);
    expect(embeddingsConfigured(local)).toBe(true);
    expect(currentEmbeddingFamily(local)).toBe(BUNDLED_EMBEDDING_MODEL);
  });

  it.each([
    ["an OpenAI key", { OPENAI_API_KEY: "k" }],
    ["an OpenRouter key", { OPENROUTER_API_KEY: "k" }],
    ["an embeddings base URL (Ollama)", { MEMBRAL_EMBEDDINGS_BASE_URL: "http://localhost:11434/v1" }],
    ["another explicit model", { MEMBRAL_EMBEDDING_MODEL: "nomic-embed-text" }],
  ])("is not chosen over %s", (_n, extra) => {
    expect(isBundledEmbeddingConfig(resolveEmbeddingConfig({ ...local, ...extra }))).toBe(false);
  });

  it("is not the default outside local mode, nor on Vercel", () => {
    expect(isBundledEmbeddingConfig(resolveEmbeddingConfig({}))).toBe(false);
    expect(isBundledEmbeddingConfig(resolveEmbeddingConfig({ ...local, VERCEL: "1" }))).toBe(false);
    expect(embeddingsConfigured({})).toBe(false);
  });

  it("can be named explicitly", () => {
    expect(isBundledEmbeddingConfig(resolveEmbeddingConfig({ MEMBRAL_EMBEDDING_MODEL: BUNDLED_EMBEDDING_MODEL }))).toBe(
      true,
    );
  });

  it("its id differs from Ollama's, so prefixes apply (nomic) but the family is separate", () => {
    expect(BUNDLED_EMBEDDING_MODEL).not.toBe("nomic-embed-text");
    expect(/nomic/i.test(BUNDLED_EMBEDDING_MODEL)).toBe(true);
  });
});

describe("floor for the bundled family", () => {
  it("has its own calibrated row (not an alias of Ollama's nomic)", () => {
    const expected = {
      in_batch_dedupe: 0.93,
      cross_session_dedup: 0.94,
      semantic_dedup: 0.86,
      supersede: 0.88,
      recurrence: 0.86,
      blocker_dismiss: 0.86,
      sem_floor: 0.68,
      mixed_sem_floor: 0.63,
      sql_cut: 0.53,
    } as const;
    for (const [step, value] of Object.entries(expected)) {
      expect(vectorThreshold(step as keyof typeof expected, BUNDLED_EMBEDDING_MODEL)).toBe(value);
    }
    expect(vectorThreshold("content_match", BUNDLED_EMBEDDING_MODEL)).toBeNull();
    expect(vectorThreshold("sem_floor", BUNDLED_EMBEDDING_MODEL)).not.toBe(
      vectorThreshold("sem_floor", "nomic-embed-text"),
    );
    expect(lexicalMinHits(BUNDLED_EMBEDDING_MODEL)).toBe(4);
  });

  it("raw units stay uncalibrated for it (cards only)", () => {
    expect(RAW_UNIT_THRESHOLDS[BUNDLED_EMBEDDING_MODEL]).toBeUndefined();
    expect(rawUnitCuts(BUNDLED_EMBEDDING_MODEL)).toBeNull();
  });
});

describe("task prefixes and floor wiring for the bundled family", () => {
  it("documents and queries get the nomic prefixes", () => {
    expect(embedInput("hello", BUNDLED_EMBEDDING_MODEL)).toBe("search_document: hello");
    expect(queryEmbedInput("hello", BUNDLED_EMBEDDING_MODEL)).toBe("search_query: hello");
  });

  it("memory search applies the calibrated relevance floor for it", () => {
    const ff = familyFloor({ MEMBRAL_LOCAL: "1" });
    expect(ff.family).toBe(BUNDLED_EMBEDDING_MODEL);
    expect(ff.pMinSimilarity).toBe(0.53);
    expect(ff.pMinSimilarity).not.toBe(FLOOR_OFF);
    expect(ff.floor).not.toBeNull();
  });
});
