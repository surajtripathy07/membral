import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// getOpenAI() is memoized module-level state — reset it between tests via
// vi.resetModules() + a fresh dynamic import, mirroring the pattern needed
// whenever a singleton factory's behavior depends on env vars read only on
// first construction.
async function freshGetOpenAI() {
  vi.resetModules();
  const mod = await import("../openai");
  return mod.getOpenAI;
}

describe("getOpenAI", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to api.openai.com when no base-URL override is set", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-abc");
    const getOpenAI = await freshGetOpenAI();
    const client = getOpenAI();
    expect(client.baseURL).toBe("https://api.openai.com/v1");
  });

  it("points at the OpenRouter-style base URL when MEMBRAL_MODEL_BASE_URL is set — issue: embeddings must follow the chat client's override", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-or-abc");
    vi.stubEnv("MEMBRAL_MODEL_BASE_URL", "https://openrouter.ai/api/v1");
    const getOpenAI = await freshGetOpenAI();
    const client = getOpenAI();
    expect(client.baseURL).toBe("https://openrouter.ai/api/v1");
  });

  it("MEMBRAL_EMBEDDINGS_BASE_URL wins over MEMBRAL_MODEL_BASE_URL for the embeddings client specifically", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-abc");
    vi.stubEnv("MEMBRAL_MODEL_BASE_URL", "https://openrouter.ai/api/v1");
    vi.stubEnv("MEMBRAL_EMBEDDINGS_BASE_URL", "https://embeddings-only.example.com/v1");
    const getOpenAI = await freshGetOpenAI();
    const client = getOpenAI();
    expect(client.baseURL).toBe("https://embeddings-only.example.com/v1");
  });

  it("throws when OPENAI_API_KEY is unset and no base URL is configured", async () => {
    const getOpenAI = await freshGetOpenAI();
    expect(() => getOpenAI()).toThrow(/Missing OPENAI_API_KEY/);
  });

  it("does not throw when OPENAI_API_KEY is unset but a base URL is configured (local/Ollama-style opt-in)", async () => {
    vi.stubEnv("MEMBRAL_MODEL_BASE_URL", "http://localhost:11434/v1");
    const getOpenAI = await freshGetOpenAI();
    expect(() => getOpenAI()).not.toThrow();
  });

  it("memoizes the client across calls within the same module instance", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-abc");
    const getOpenAI = await freshGetOpenAI();
    expect(getOpenAI()).toBe(getOpenAI());
  });
});
