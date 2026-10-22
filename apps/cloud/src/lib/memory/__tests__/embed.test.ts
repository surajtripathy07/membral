import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { EMBED_BATCH_SIZE, embedTexts } from "../embed";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

function makeLlm(create: OpenAILike["embeddings"]["create"]): LlmClient {
  const client: OpenAILike = {
    chat: { completions: { create: vi.fn() } },
    embeddings: { create },
  };
  return new LlmClient(CONFIG, { client });
}

describe("embedTexts (step2d finding 8)", () => {
  it("returns an empty result for zero texts without calling out", async () => {
    const create = vi.fn();
    const llm = makeLlm(create);
    const result = await embedTexts(llm, [], "s1");
    expect(result).toEqual({ vectors: [], costUsd: 0, failedCount: 0 });
    expect(create).not.toHaveBeenCalled();
  });

  it("embeds everything in one call when under the batch size", async () => {
    const create = vi.fn().mockResolvedValue({
      data: [{ embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }],
      usage: { prompt_tokens: 10 },
    });
    const llm = makeLlm(create);
    const result = await embedTexts(llm, ["a", "b"], "s1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(result.vectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(result.failedCount).toBe(0);
  });

  it("chunks into multiple calls above EMBED_BATCH_SIZE, aligning vectors back to the original order", async () => {
    const texts = Array.from({ length: EMBED_BATCH_SIZE + 5 }, (_, i) => `text-${i}`);
    const create = vi.fn().mockImplementation((body: { input: string | string[] }) => {
      const inputs = body.input as string[];
      return Promise.resolve({
        data: inputs.map((_, i) => ({ embedding: [i, 0, 0] })),
        usage: { prompt_tokens: inputs.length },
      });
    });
    const llm = makeLlm(create);
    const result = await embedTexts(llm, texts, "s1");
    expect(create).toHaveBeenCalledTimes(2);
    expect(result.vectors).toHaveLength(texts.length);
    expect(result.vectors.every((v) => v !== null)).toBe(true);
    expect(result.failedCount).toBe(0);
  });

  it("a failed batch stores null vectors for its texts, never throwing and never discarding the other batches", async () => {
    const texts = Array.from({ length: EMBED_BATCH_SIZE + 5 }, (_, i) => `text-${i}`);
    let call = 0;
    const create = vi.fn().mockImplementation((body: { input: string | string[] }) => {
      call++;
      if (call === 1) return Promise.reject(new Error("provider outage"));
      const inputs = body.input as string[];
      return Promise.resolve({
        data: inputs.map(() => ({ embedding: [1, 1, 1] })),
        usage: { prompt_tokens: inputs.length },
      });
    });
    const llm = makeLlm(create);
    const result = await embedTexts(llm, texts, "s1");
    expect(result.failedCount).toBe(EMBED_BATCH_SIZE);
    expect(result.vectors.slice(0, EMBED_BATCH_SIZE).every((v) => v === null)).toBe(true);
    expect(result.vectors.slice(EMBED_BATCH_SIZE).every((v) => v !== null)).toBe(true);
  });
});
