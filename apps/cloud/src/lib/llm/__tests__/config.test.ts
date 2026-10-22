import { describe, expect, it } from "vitest";
import { chatCostUsd, embedCostUsd } from "../client";
import { chatConfigured, resolveModelConfig } from "../config";
import { embeddingsConfigured, resolveEmbeddingConfig } from "../embedding-client";

const OR = "https://openrouter.ai/api/v1";
const ANTH = "https://api.anthropic.com/v1/";
const GEM = "https://generativelanguage.googleapis.com/v1beta/openai/";

describe("LLM key resolution", () => {
  it("base URL only: dummy key, both gates true", () => {
    const env = { MEMBRAL_MODEL_BASE_URL: "http://localhost:11434/v1" };
    const chat = resolveModelConfig(env);
    expect(chat.apiKey).toBe("not-needed");
    expect(chat.keySource).toBe("base-url");
    expect(chat.baseURL).toBe("http://localhost:11434/v1");
    expect(chat.model).toBe("gpt-4o-mini");
    expect(chatConfigured(env)).toBe(true);
    expect(embeddingsConfigured(env)).toBe(true);
  });

  it("OPENAI_API_KEY alone: no base URL, existing defaults", () => {
    const c = resolveModelConfig({ OPENAI_API_KEY: "k" });
    expect(c).toMatchObject({ keySource: "OPENAI_API_KEY", baseURL: undefined, model: "gpt-4o-mini" });
    expect(resolveEmbeddingConfig({ OPENAI_API_KEY: "k" })).toMatchObject({
      baseURL: undefined,
      model: "text-embedding-3-small",
    });
  });

  it("OPENROUTER_API_KEY alone", () => {
    const env = { OPENROUTER_API_KEY: "k" };
    expect(resolveModelConfig(env)).toMatchObject({
      keySource: "OPENROUTER_API_KEY",
      baseURL: OR,
      model: "openai/gpt-4o-mini",
    });
    expect(resolveEmbeddingConfig(env)).toMatchObject({
      apiKey: "k",
      baseURL: OR,
      model: "openai/text-embedding-3-small",
    });
    expect(embeddingsConfigured(env)).toBe(true);
  });

  it("ANTHROPIC_API_KEY alone: chat yes, embeddings no", () => {
    const env = { ANTHROPIC_API_KEY: "k" };
    expect(resolveModelConfig(env)).toMatchObject({
      keySource: "ANTHROPIC_API_KEY",
      baseURL: ANTH,
      model: "claude-sonnet-5",
    });
    expect(chatConfigured(env)).toBe(true);
    expect(embeddingsConfigured(env)).toBe(false);
  });

  it("GEMINI_API_KEY alone: chat yes, embeddings no", () => {
    const env = { GEMINI_API_KEY: "k" };
    expect(resolveModelConfig(env)).toMatchObject({
      keySource: "GEMINI_API_KEY",
      baseURL: GEM,
      model: "gemini-2.5-flash",
    });
    expect(chatConfigured(env)).toBe(true);
    expect(embeddingsConfigured(env)).toBe(false);
  });

  it("OPENAI wins over the others; priority follows the documented order", () => {
    const all = { OPENAI_API_KEY: "a", OPENROUTER_API_KEY: "b", ANTHROPIC_API_KEY: "c", GEMINI_API_KEY: "d" };
    expect(resolveModelConfig(all)).toMatchObject({ keySource: "OPENAI_API_KEY", apiKey: "a", baseURL: undefined });
    expect(resolveEmbeddingConfig(all)).toMatchObject({ apiKey: "a", baseURL: undefined });
    const { OPENAI_API_KEY: _o, ...rest } = all;
    expect(resolveModelConfig(rest).keySource).toBe("OPENROUTER_API_KEY");
    const { OPENROUTER_API_KEY: _r, ...rest2 } = rest;
    expect(resolveModelConfig(rest2).keySource).toBe("ANTHROPIC_API_KEY");
  });

  it("explicit base URL wins over the provider default", () => {
    const env = { OPENROUTER_API_KEY: "k", MEMBRAL_MODEL_BASE_URL: "http://proxy/v1" };
    expect(resolveModelConfig(env)).toMatchObject({
      keySource: "OPENROUTER_API_KEY",
      baseURL: "http://proxy/v1",
      model: "gpt-4o-mini",
    });
    expect(resolveEmbeddingConfig(env).baseURL).toBe("http://proxy/v1");
  });

  it("MEMBRAL_MODEL overrides the provider default model", () => {
    expect(resolveModelConfig({ ANTHROPIC_API_KEY: "k", MEMBRAL_MODEL: "claude-opus-5" }).model).toBe("claude-opus-5");
  });

  it("nothing set: gates false and chat resolution throws without echoing a key", () => {
    expect(chatConfigured({})).toBe(false);
    expect(embeddingsConfigured({})).toBe(false);
    expect(() => resolveModelConfig({})).toThrow(/Missing LLM key/);
  });
});

describe("provider default models are priced (the client fails closed on unpriced ids)", () => {
  it.each([
    ["OPENAI_API_KEY"],
    ["OPENROUTER_API_KEY"],
    ["ANTHROPIC_API_KEY"],
    ["GEMINI_API_KEY"],
  ])("%s default chat model has a price", (k) => {
    expect(chatCostUsd(resolveModelConfig({ [k]: "k" }).model, 1000, 1000)).not.toBeNull();
  });

  it.each([["OPENAI_API_KEY"], ["OPENROUTER_API_KEY"]])("%s default embedding model has a price", (k) => {
    expect(embedCostUsd(resolveEmbeddingConfig({ [k]: "k" }).model, 1000)).not.toBeNull();
  });
});
