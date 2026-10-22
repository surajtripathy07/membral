import { describe, expect, it, vi } from "vitest";
import { callEmbeddingsCreate, resolveEmbeddingConfig } from "../embedding-client";

describe("resolveEmbeddingConfig", () => {
  it("defaults to OpenAI, text-embedding-3-small, 1536 dimensions", () => {
    const cfg = resolveEmbeddingConfig({ OPENAI_API_KEY: "sk-abc" });
    expect(cfg.model).toBe("text-embedding-3-small");
    expect(cfg.baseURL).toBeUndefined();
    expect(cfg.apiKey).toBe("sk-abc");
    expect(cfg.dimensions).toBe(1536);
  });

  it("MEMBRAL_MODEL_BASE_URL sets the base URL (same override the chat client already honors)", () => {
    const cfg = resolveEmbeddingConfig({
      OPENAI_API_KEY: "sk-abc",
      MEMBRAL_MODEL_BASE_URL: "https://openrouter.ai/api/v1",
    });
    expect(cfg.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  it("MEMBRAL_EMBEDDINGS_BASE_URL wins over MEMBRAL_MODEL_BASE_URL when both are set", () => {
    const cfg = resolveEmbeddingConfig({
      OPENAI_API_KEY: "sk-abc",
      MEMBRAL_MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      MEMBRAL_EMBEDDINGS_BASE_URL: "https://embeddings.example.com/v1",
    });
    expect(cfg.baseURL).toBe("https://embeddings.example.com/v1");
  });

  it("MEMBRAL_EMBEDDING_MODEL overrides the default model id", () => {
    const cfg = resolveEmbeddingConfig({ OPENAI_API_KEY: "sk-abc", MEMBRAL_EMBEDDING_MODEL: "text-embedding-3-large" });
    expect(cfg.model).toBe("text-embedding-3-large");
  });

  it("falls back to MEMBRAL_EMBED_MODEL (kg/types.ts's older name) when MEMBRAL_EMBEDDING_MODEL is unset", () => {
    const cfg = resolveEmbeddingConfig({ OPENAI_API_KEY: "sk-abc", MEMBRAL_EMBED_MODEL: "text-embedding-3-large" });
    expect(cfg.model).toBe("text-embedding-3-large");
  });

  it("MEMBRAL_EMBEDDING_MODEL takes priority over MEMBRAL_EMBED_MODEL when both are set", () => {
    const cfg = resolveEmbeddingConfig({
      OPENAI_API_KEY: "sk-abc",
      MEMBRAL_EMBEDDING_MODEL: "text-embedding-3-large",
      MEMBRAL_EMBED_MODEL: "some-other-model",
    });
    expect(cfg.model).toBe("text-embedding-3-large");
  });

  it("apiKey falls back to a non-empty placeholder ('ollama') when unset AND a base URL is configured", () => {
    const cfg = resolveEmbeddingConfig({ MEMBRAL_MODEL_BASE_URL: "http://localhost:11434/v1" });
    expect(cfg.apiKey).toBe("not-needed");
  });

  it("apiKey is '' (never throws) when both OPENAI_API_KEY and any base URL are unset — pure config read", () => {
    expect(() => resolveEmbeddingConfig({})).not.toThrow();
    expect(resolveEmbeddingConfig({}).apiKey).toBe("");
  });

  it("dimensions always 1536 regardless of overrides — pgvector column width, not configurable", () => {
    const cfg = resolveEmbeddingConfig({
      OPENAI_API_KEY: "sk-abc",
      MEMBRAL_EMBEDDING_MODEL: "text-embedding-3-large",
      MEMBRAL_MODEL_BASE_URL: "https://openrouter.ai/api/v1",
    });
    expect(cfg.dimensions).toBe(1536);
  });
});

describe("callEmbeddingsCreate", () => {
  const baseConfig = {
    model: "text-embedding-3-small",
    baseURL: undefined,
    apiKey: "sk-abc",
    dimensions: 1536 as const,
  };

  function modelError(message: string, status: number): Error & { status: number } {
    const err = new Error(message) as Error & { status: number };
    err.status = status;
    return err;
  }

  it("calls create once with the configured model/input/dimensions on success", async () => {
    const create = vi.fn().mockResolvedValue({ data: [{ embedding: [0.1, 0.2] }], usage: { prompt_tokens: 3 } });
    const result = await callEmbeddingsCreate(create, baseConfig, "hello world");

    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({ model: "text-embedding-3-small", input: "hello world", dimensions: 1536 });
    expect(result.data[0].embedding).toEqual([0.1, 0.2]);
  });

  it("propagates an unknown-model error untouched when no base URL is configured (default OpenAI — never masks a real config error)", async () => {
    const create = vi.fn().mockRejectedValue(modelError("The model `bogus-model` does not exist", 404));
    await expect(callEmbeddingsCreate(create, baseConfig, "text")).rejects.toThrow("does not exist");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("retries ONCE with an openai/-prefixed id when a base URL is set and the bare id is rejected as unknown", async () => {
    const config = { ...baseConfig, baseURL: "https://openrouter.ai/api/v1" };
    const create = vi
      .fn()
      .mockRejectedValueOnce(modelError("model_not_found: text-embedding-3-small is not a valid model ID", 400))
      .mockResolvedValueOnce({ data: [{ embedding: [0.5] }], usage: { prompt_tokens: 4 } });

    const result = await callEmbeddingsCreate(create, config, "text");

    expect(create).toHaveBeenCalledTimes(2);
    expect(create).toHaveBeenNthCalledWith(1, { model: "text-embedding-3-small", input: "text", dimensions: 1536 });
    expect(create).toHaveBeenNthCalledWith(2, {
      model: "openai/text-embedding-3-small",
      input: "text",
      dimensions: 1536,
    });
    expect(result.data[0].embedding).toEqual([0.5]);
  });

  it("never retries a non-model error (rate limit, token overflow) even with a base URL set — caller's own retry logic owns those", async () => {
    const config = { ...baseConfig, baseURL: "https://openrouter.ai/api/v1" };
    const create = vi.fn().mockRejectedValue(modelError("Rate limit exceeded", 429));

    await expect(callEmbeddingsCreate(create, config, "text")).rejects.toThrow("Rate limit exceeded");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not double-prefix when the configured model already carries an openai/ prefix", async () => {
    const config = { ...baseConfig, baseURL: "https://openrouter.ai/api/v1", model: "openai/text-embedding-3-small" };
    const create = vi.fn().mockRejectedValue(modelError("model_not_found", 400));

    await expect(callEmbeddingsCreate(create, config, "text")).rejects.toThrow("model_not_found");
    expect(create).toHaveBeenCalledTimes(1);
  });
});
