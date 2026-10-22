import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { log } from "../../log";
import {
  CostCapExceededError,
  chatCostUsd,
  embedCostUsd,
  getCallCostUsd,
  LlmClient,
  type OpenAILike,
  summarizeCost,
  UnpricedModelError,
} from "../client";
import { type ModelConfig, resolveCostCapConfig, resolveModelConfig } from "../config";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test-key",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

function fakeClient(overrides?: Partial<OpenAILike>): {
  client: OpenAILike;
  chatCreate: ReturnType<typeof vi.fn>;
  embedCreate: ReturnType<typeof vi.fn>;
} {
  const chatCreate = vi.fn();
  const embedCreate = vi.fn();
  const client: OpenAILike = {
    chat: { completions: { create: chatCreate } },
    embeddings: { create: embedCreate },
    ...overrides,
  };
  return { client, chatCreate, embedCreate };
}

function chatResponse(content: string | null, tokensIn = 100, tokensOut = 20) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: tokensIn, completion_tokens: tokensOut },
  };
}

describe("resolveModelConfig", () => {
  it("defaults to gpt-4o-mini + text-embedding-3-small when only OPENAI_API_KEY is set", () => {
    const cfg = resolveModelConfig({ OPENAI_API_KEY: "sk-abc" });
    expect(cfg.model).toBe("gpt-4o-mini");
    expect(cfg.baseURL).toBeUndefined();
    expect(cfg.apiKey).toBe("sk-abc");
    expect(cfg.embedModel).toBe("text-embedding-3-small");
    expect(cfg.embedDimensions).toBe(1536);
  });

  it("honors MEMBRAL_MODEL override", () => {
    const cfg = resolveModelConfig({ OPENAI_API_KEY: "sk-abc", MEMBRAL_MODEL: "llama3.1:13b" });
    expect(cfg.model).toBe("llama3.1:13b");
  });

  it("uses a placeholder key when a local base URL is set without an OpenAI key", () => {
    const cfg = resolveModelConfig({ MEMBRAL_MODEL_BASE_URL: "http://localhost:11434/v1" });
    expect(cfg.baseURL).toBe("http://localhost:11434/v1");
    expect(cfg.apiKey).toBe("not-needed");
  });

  it("throws when neither an API key nor a base URL is present", () => {
    expect(() => resolveModelConfig({})).toThrow(/Missing LLM key/);
  });

  it("honors MEMBRAL_EMBED_MODEL for embedModel (back-compat)", () => {
    const cfg = resolveModelConfig({ OPENAI_API_KEY: "sk-abc", MEMBRAL_EMBED_MODEL: "text-embedding-3-large" });
    expect(cfg.embedModel).toBe("text-embedding-3-large");
  });

  it("MEMBRAL_EMBEDDING_MODEL (embedding-client.ts's newer name) overrides MEMBRAL_EMBED_MODEL for embedModel", () => {
    const cfg = resolveModelConfig({
      OPENAI_API_KEY: "sk-abc",
      MEMBRAL_EMBEDDING_MODEL: "text-embedding-3-large",
      MEMBRAL_EMBED_MODEL: "some-other-model",
    });
    expect(cfg.embedModel).toBe("text-embedding-3-large");
  });
});

describe("resolveCostCapConfig (issue #21)", () => {
  it("defaults per-run cap to 5 and ceiling to null when nothing is set", () => {
    const cfg = resolveCostCapConfig({});
    expect(cfg.perRunCapUsd).toBe(5);
    expect(cfg.monthlyCeilingUsd).toBeNull();
  });

  it("parses explicit env values", () => {
    const cfg = resolveCostCapConfig({ MEMBRAL_KG_COST_CAP_USD: "12.5", MEMBRAL_KG_MONTHLY_CEILING_USD: "2" });
    expect(cfg.perRunCapUsd).toBe(12.5);
    expect(cfg.monthlyCeilingUsd).toBe(2);
  });

  it("falls back safely on blank/non-numeric/negative per-run cap values", () => {
    expect(resolveCostCapConfig({ MEMBRAL_KG_COST_CAP_USD: "" }).perRunCapUsd).toBe(5);
    expect(resolveCostCapConfig({ MEMBRAL_KG_COST_CAP_USD: "not-a-number" }).perRunCapUsd).toBe(5);
    expect(resolveCostCapConfig({ MEMBRAL_KG_COST_CAP_USD: "-3" }).perRunCapUsd).toBe(5);
  });

  it("falls back to null (never enforcing) on blank/garbage/negative monthly ceiling values", () => {
    expect(resolveCostCapConfig({ MEMBRAL_KG_MONTHLY_CEILING_USD: "" }).monthlyCeilingUsd).toBeNull();
    expect(resolveCostCapConfig({ MEMBRAL_KG_MONTHLY_CEILING_USD: "garbage" }).monthlyCeilingUsd).toBeNull();
    expect(resolveCostCapConfig({ MEMBRAL_KG_MONTHLY_CEILING_USD: "-1" }).monthlyCeilingUsd).toBeNull();
  });

  it("never invents a monthly ceiling default — absence of the env var always means null", () => {
    expect(resolveCostCapConfig({ OPENAI_API_KEY: "sk-x" }).monthlyCeilingUsd).toBeNull();
  });

  // Driver decision (issue #21 adversarial review m7): 0 is a VALID,
  // enforcing value for both keys — it is NOT the same as "unset."
  it("treats an explicit 0 per-run cap as valid and enforcing (halts at the first check), not a fallback trigger", () => {
    const cfg = resolveCostCapConfig({ MEMBRAL_KG_COST_CAP_USD: "0" });
    expect(cfg.perRunCapUsd).toBe(0);
  });

  it("treats an explicit 0 monthly ceiling as valid and enforcing (blocks every run), not a fallback trigger", () => {
    const cfg = resolveCostCapConfig({ MEMBRAL_KG_MONTHLY_CEILING_USD: "0" });
    expect(cfg.monthlyCeilingUsd).toBe(0);
  });

  it("logs a warning for a non-blank unparseable/negative per-run cap value, but stays silent on blank/unset", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    resolveCostCapConfig({ MEMBRAL_KG_COST_CAP_USD: "" });
    expect(warnSpy).not.toHaveBeenCalled();
    resolveCostCapConfig({ MEMBRAL_KG_COST_CAP_USD: "not-a-number" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("MEMBRAL_KG_COST_CAP_USD"), expect.anything());
    warnSpy.mockClear();
    resolveCostCapConfig({ MEMBRAL_KG_COST_CAP_USD: "-3" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("MEMBRAL_KG_COST_CAP_USD"), expect.anything());
    warnSpy.mockRestore();
  });

  it("logs a warning for a non-blank unparseable/negative monthly ceiling value, but stays silent on blank/unset", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    resolveCostCapConfig({ MEMBRAL_KG_MONTHLY_CEILING_USD: "" });
    expect(warnSpy).not.toHaveBeenCalled();
    resolveCostCapConfig({ MEMBRAL_KG_MONTHLY_CEILING_USD: "garbage" });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("MEMBRAL_KG_MONTHLY_CEILING_USD"), expect.anything());
    warnSpy.mockRestore();
  });

  it("never warns on an explicit 0 (0 is valid, not garbage)", () => {
    const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => {});
    resolveCostCapConfig({ MEMBRAL_KG_COST_CAP_USD: "0", MEMBRAL_KG_MONTHLY_CEILING_USD: "0" });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("LlmClient cost cap (issue #21)", () => {
  it("overBudget()/remainingUsd() report no cap when capUsd is not configured", () => {
    const { client } = fakeClient();
    const llm = new LlmClient(CONFIG, { client });
    expect(llm.overBudget()).toBe(false);
    expect(llm.remainingUsd()).toBe(Number.POSITIVE_INFINITY);
  });

  it("throws CostCapExceededError BEFORE the network call once totalCostUsd reaches capUsd", async () => {
    const { client, chatCreate } = fakeClient();
    // gpt-4o-mini @ 1M in/out tokens = $0.75 per call; cap at $0.5 so ONE call trips it.
    chatCreate.mockResolvedValue(chatResponse(JSON.stringify({ ok: true }), 1_000_000, 1_000_000));
    const llm = new LlmClient(CONFIG, { client, capUsd: 0.5 });

    await llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "a" });
    expect(llm.overBudget()).toBe(true);
    expect(llm.remainingUsd()).toBe(0);

    await expect(
      llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "b" }),
    ).rejects.toThrow(CostCapExceededError);
    // The second call never reached the network.
    expect(chatCreate).toHaveBeenCalledTimes(1);
  });

  it("embed() and embedMany() also refuse once over budget, without hitting the network", async () => {
    const { client, embedCreate } = fakeClient();
    embedCreate.mockResolvedValue({ data: [{ embedding: [1] }], usage: { prompt_tokens: 1_000_000 } });
    // text-embedding-3-small: $0.02/1M tokens -> $0.02 for 1M tokens; cap at $0.01 so it's over after one call.
    const llm = new LlmClient(CONFIG, { client, capUsd: 0.01 });

    await llm.embed({ text: "hello", pass: "embed", conversationId: "c" });
    expect(llm.overBudget()).toBe(true);

    await expect(llm.embed({ text: "again", pass: "embed", conversationId: "c" })).rejects.toThrow(
      CostCapExceededError,
    );
    await expect(llm.embedMany({ texts: ["a", "b"], pass: "embed", conversationId: "c" })).rejects.toThrow(
      CostCapExceededError,
    );
    expect(embedCreate).toHaveBeenCalledTimes(1);
  });

  it("seedCostUsd carries a prior client's spend forward (phase-split bootstrap)", () => {
    const { client } = fakeClient();
    const llm = new LlmClient(CONFIG, { client, capUsd: 1, seedCostUsd: 0.9 });
    expect(llm.totalCostUsd).toBeCloseTo(0.9, 8);
    expect(llm.overBudget()).toBe(false);
    expect(llm.remainingUsd()).toBeCloseTo(0.1, 8);
  });

  it("fires onSpend once per billable call with the CostRecord", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValue(chatResponse(JSON.stringify({ ok: true })));
    const seen: string[] = [];
    const llm = new LlmClient(CONFIG, { client, onSpend: (rec) => seen.push(rec.pass) });

    await llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "a" });
    await llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "stage_a_name", conversationId: "b" });

    expect(seen).toEqual(["pass1", "stage_a_name"]);
  });

  it("never crashes when onSpend itself throws", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValue(chatResponse(JSON.stringify({ ok: true })));
    const llm = new LlmClient(CONFIG, {
      client,
      onSpend: () => {
        throw new Error("ledger down");
      },
    });

    await expect(
      llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "a" }),
    ).resolves.toBeDefined();
  });
});

describe("cost math", () => {
  it("prices gpt-4o-mini per known rates", () => {
    // 1,000,000 in @ $0.15 + 1,000,000 out @ $0.60 = $0.75
    expect(chatCostUsd("gpt-4o-mini", 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
  });

  it("returns null (never $0) for an unpriced/unknown model — callers must fail closed (step2d finding 5)", () => {
    expect(chatCostUsd("llama3.1:13b", 5000, 5000)).toBeNull();
    expect(embedCostUsd("nomic-embed-text", 5000)).toBeNull();
  });

  it("prices an unlisted chat model at $0 only when self-hosted (W7 D4), listed models keep their price", () => {
    expect(chatCostUsd("qwen2.5:3b", 5000, 5000, { selfHosted: true })).toBe(0);
    expect(chatCostUsd("qwen2.5:3b", 5000, 5000)).toBeNull();
    expect(chatCostUsd("qwen2.5:3b", 5000, 5000, { selfHosted: false })).toBeNull();
    expect(chatCostUsd("gpt-4o-mini", 1_000_000, 1_000_000, { selfHosted: true })).toBeCloseTo(0.75, 6);
  });

  it("prices embeddings per known rates", () => {
    expect(embedCostUsd("text-embedding-3-small", 1_000_000)).toBeCloseTo(0.02, 6);
  });
});

describe("fails closed on an unpriced model (step2d finding 5)", () => {
  const UNPRICED_CONFIG: ModelConfig = { ...CONFIG, model: "gpt-5-mini" };
  const UNPRICED_EMBED_CONFIG: ModelConfig = { ...CONFIG, embedModel: "some-unpriced-embedder" };

  it("callJson throws UnpricedModelError before ever issuing the chat call", async () => {
    const { client, chatCreate } = fakeClient();
    const llm = new LlmClient(UNPRICED_CONFIG, { client });
    await expect(
      llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "c" }),
    ).rejects.toBeInstanceOf(UnpricedModelError);
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("embed throws UnpricedModelError before ever issuing the embeddings call", async () => {
    const { client, embedCreate } = fakeClient();
    const llm = new LlmClient(UNPRICED_EMBED_CONFIG, { client });
    await expect(llm.embed({ text: "hello", pass: "embed", conversationId: "c" })).rejects.toBeInstanceOf(
      UnpricedModelError,
    );
    expect(embedCreate).not.toHaveBeenCalled();
  });

  it("embedMany throws UnpricedModelError before ever issuing the embeddings call", async () => {
    const { client, embedCreate } = fakeClient();
    const llm = new LlmClient(UNPRICED_EMBED_CONFIG, { client });
    await expect(llm.embedMany({ texts: ["a", "b"], pass: "embed", conversationId: "c" })).rejects.toBeInstanceOf(
      UnpricedModelError,
    );
    expect(embedCreate).not.toHaveBeenCalled();
  });

  it("embed with empty text never reaches the pricing check at all (already short-circuits)", async () => {
    const { client, embedCreate } = fakeClient();
    const llm = new LlmClient(UNPRICED_EMBED_CONFIG, { client });
    const { vector } = await llm.embed({ text: "   ", pass: "embed", conversationId: "c" });
    expect(vector).toEqual(new Array(UNPRICED_EMBED_CONFIG.embedDimensions).fill(0));
    expect(embedCreate).not.toHaveBeenCalled();
  });
});

describe("self-hosted chat pricing (W7 D4, D-072)", () => {
  it("resolveModelConfig: any model on a loopback or host.docker.internal base URL is self-hosted", () => {
    for (const url of [
      "http://host.docker.internal:11434/v1",
      "http://localhost:11434/v1",
      "http://127.0.0.1:8080/v1",
    ]) {
      expect(resolveModelConfig({ MEMBRAL_MODEL_BASE_URL: url, MEMBRAL_MODEL: "any-local-model" }).chatSelfHosted).toBe(
        true,
      );
    }
  });

  it("resolveModelConfig: a remote base URL or a provider key alone is not, unless MEMBRAL_MODEL_FREE=1 with a base URL", () => {
    const remote = {
      MEMBRAL_MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_API_KEY: "k",
      MEMBRAL_MODEL: "x/y",
    };
    expect(resolveModelConfig(remote).chatSelfHosted).toBe(false);
    expect(resolveModelConfig({ MEMBRAL_MODEL_BASE_URL: "http://10.0.0.5:11434/v1" }).chatSelfHosted).toBe(false);
    expect(resolveModelConfig({ OPENAI_API_KEY: "k", MEMBRAL_MODEL_FREE: "1" }).chatSelfHosted).toBe(false);
    // Honoured only on the local stack: ignored without MEMBRAL_LOCAL, and on Vercel.
    expect(resolveModelConfig({ ...remote, MEMBRAL_MODEL_FREE: "1" }).chatSelfHosted).toBe(false);
    expect(
      resolveModelConfig({ ...remote, MEMBRAL_MODEL_FREE: "1", MEMBRAL_LOCAL: "1", VERCEL: "1" }).chatSelfHosted,
    ).toBe(false);
    expect(resolveModelConfig({ ...remote, MEMBRAL_MODEL_FREE: "1", MEMBRAL_LOCAL: "1" }).chatSelfHosted).toBe(true);
  });

  it("callJson records an unlisted self-hosted model at $0", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true })));
    const llm = new LlmClient({ ...CONFIG, model: "qwen2.5:3b", chatSelfHosted: true }, { client });
    const { record } = await llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "c" });
    expect(record.cost_usd).toBe(0);
    expect(record.model).toBe("qwen2.5:3b");
  });

  it("callJson still refuses the same unlisted model on a remote base URL (OpenRouter-style)", async () => {
    const { client, chatCreate } = fakeClient();
    const config = resolveModelConfig({
      MEMBRAL_MODEL_BASE_URL: "https://openrouter.ai/api/v1",
      OPENROUTER_API_KEY: "k",
      MEMBRAL_MODEL: "qwen2.5:3b",
    });
    const llm = new LlmClient(config, { client });
    await expect(
      llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "c" }),
    ).rejects.toBeInstanceOf(UnpricedModelError);
    expect(chatCreate).not.toHaveBeenCalled();
  });
});

describe("LlmClient.callJson", () => {
  it("parses JSON, returns data, and records cost", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true, n: 3 })));
    const llm = new LlmClient(CONFIG, { client });

    const { data, record } = await llm.callJson<{ ok: boolean; n: number }>({
      systemPrompt: "sys",
      userPrompt: "usr",
      pass: "pass1",
      conversationId: "c1",
    });

    expect(data).toEqual({ ok: true, n: 3 });
    expect(record.cost_usd).toBeCloseTo(chatCostUsd("gpt-4o-mini", 100, 20) ?? 0, 8);
    expect(llm.totalCalls).toBe(1);
    expect(llm.totalCostUsd).toBeGreaterThan(0);

    const body = chatCreate.mock.calls[0][0];
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  it("pins reasoning off for gemma-4, alongside temperature", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true })));
    const llm = new LlmClient(CONFIG, { client });

    await llm.callJson({
      systemPrompt: "sys",
      userPrompt: "usr",
      pass: "pass1",
      conversationId: "c1",
      model: "google/gemma-4-31b-it",
    });

    const body = chatCreate.mock.calls[0][0];
    expect(body.reasoning).toEqual({ enabled: false });
    expect(body.temperature).toBe(0.1);
  });

  it("sends no reasoning key for qwen", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true })));
    const llm = new LlmClient(CONFIG, { client });

    await llm.callJson({
      systemPrompt: "sys",
      userPrompt: "usr",
      pass: "pass1",
      conversationId: "c1",
      model: "qwen/qwen3-235b-a22b-2507",
    });

    const body = chatCreate.mock.calls[0][0];
    expect(body).not.toHaveProperty("reasoning");
    expect(body.temperature).toBe(0.1);
  });

  it("leaves gpt-oss (isReasoningModel) unchanged: effort, no temperature, no gemma pin", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true })));
    const llm = new LlmClient(CONFIG, { client });

    await llm.callJson({
      systemPrompt: "sys",
      userPrompt: "usr",
      pass: "pass1",
      conversationId: "c1",
      model: "openai/gpt-oss-120b",
    });

    const body = chatCreate.mock.calls[0][0];
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body).not.toHaveProperty("temperature");
  });

  it("validates with a Zod schema when provided", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({ label: "X", confidence: 0.9 })));
    const llm = new LlmClient(CONFIG, { client });
    const schema = z.object({ label: z.string(), confidence: z.number() });

    const { data } = await llm.callJson({
      systemPrompt: "s",
      userPrompt: "u",
      pass: "stage_a_name",
      conversationId: "node-1",
      schema,
    });
    expect(data.label).toBe("X");
  });

  it("throws when the response violates the Zod schema on every attempt", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValue(chatResponse(JSON.stringify({ label: 123 })));
    const llm = new LlmClient(CONFIG, { client });
    const schema = z.object({ label: z.string() });

    await expect(
      llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "stage_a_name", conversationId: "n", schema }),
    ).rejects.toThrow(/parse\/validation failed/);
    // Retried MAX_JSON_ATTEMPTS (3) times; every attempt still records (billable) cost.
    expect(chatCreate).toHaveBeenCalledTimes(3);
    expect(llm.totalCalls).toBe(3);
  });

  it("throws on an empty response after exhausting retries", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValue(chatResponse(null));
    const llm = new LlmClient(CONFIG, { client });
    await expect(
      llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "c" }),
    ).rejects.toThrow(/Empty response/);
    expect(chatCreate).toHaveBeenCalledTimes(3);
    // Empty attempts now record cost too (previously threw before record()).
    expect(llm.totalCalls).toBe(3);
  });

  it("throws on invalid JSON after exhausting retries", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValue(chatResponse("not json{"));
    const llm = new LlmClient(CONFIG, { client });
    await expect(
      llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "c" }),
    ).rejects.toThrow(/parse\/validation failed/);
    expect(chatCreate).toHaveBeenCalledTimes(3);
  });

  it("routes to a per-call model override and prices it", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: 1 }), 1_000_000, 1_000_000));
    const llm = new LlmClient(CONFIG, { client });
    const { record } = await llm.callJson({
      systemPrompt: "s",
      userPrompt: "u",
      pass: "pass1",
      conversationId: "c",
      model: "gpt-4o",
    });
    expect(record.model).toBe("gpt-4o");
    expect(record.cost_usd).toBeCloseTo(12.5, 4); // 1M*2.5 + 1M*10 = 12.5
  });
});

describe("LlmClient.callJson app-level retry (membral-47k)", () => {
  it("recovers on the 2nd attempt after an empty response", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate
      .mockResolvedValueOnce(chatResponse(null))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true })));
    const llm = new LlmClient(CONFIG, { client });

    const { data } = await llm.callJson<{ ok: boolean }>({
      systemPrompt: "s",
      userPrompt: "u",
      pass: "pass1",
      conversationId: "c",
    });

    expect(data).toEqual({ ok: true });
    expect(chatCreate).toHaveBeenCalledTimes(2);
    expect(llm.records).toHaveLength(2);
    expect(llm.totalCostUsd).toBeCloseTo(llm.records[0].cost_usd + llm.records[1].cost_usd, 10);
  });

  it("recovers on the 3rd attempt after unparseable JSON twice", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate
      .mockResolvedValueOnce(chatResponse("not json{"))
      .mockResolvedValueOnce(chatResponse("still not json{"))
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true })));
    const llm = new LlmClient(CONFIG, { client });

    const { data } = await llm.callJson<{ ok: boolean }>({
      systemPrompt: "s",
      userPrompt: "u",
      pass: "pass1",
      conversationId: "c",
    });

    expect(data).toEqual({ ok: true });
    expect(chatCreate).toHaveBeenCalledTimes(3);
    expect(llm.records).toHaveLength(3);
  });

  it("throws after exhausting 3 attempts, preserving the existing message shape", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValue(chatResponse("not json{"));
    const llm = new LlmClient(CONFIG, { client });

    await expect(
      llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "c" }),
    ).rejects.toThrow(/JSON parse\/validation failed on pass1/);
    expect(chatCreate).toHaveBeenCalledTimes(3);
    expect(llm.records).toHaveLength(3);
  });

  it("does not retry gratuitously on a first-attempt success", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true })));
    const llm = new LlmClient(CONFIG, { client });

    await llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "c" });

    expect(chatCreate).toHaveBeenCalledTimes(1);
    expect(llm.records).toHaveLength(1);
  });

  it("does not retry a non-JSON error (SDK/network) — rethrows immediately", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockRejectedValue(new Error("connection reset"));
    const llm = new LlmClient(CONFIG, { client });

    await expect(
      llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "c" }),
    ).rejects.toThrow(/connection reset/);
    expect(chatCreate).toHaveBeenCalledTimes(1);
  });
});

describe("LlmClient.callJson — per-call cost attribution (issue #98 round-5 fix, MEDIUM 1)", () => {
  it("callCostUsd on success is the SUM across every attempt this call made, not just the winning one", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate
      .mockResolvedValueOnce(chatResponse("not json{", 100, 20)) // billed, fails
      .mockResolvedValueOnce(chatResponse(JSON.stringify({ ok: true }), 100, 20)); // billed, succeeds
    const llm = new LlmClient(CONFIG, { client });

    const { callCostUsd, record } = await llm.callJson<{ ok: boolean }>({
      systemPrompt: "s",
      userPrompt: "u",
      pass: "pass1",
      conversationId: "c",
    });

    const perCallUsd = chatCostUsd("gpt-4o-mini", 100, 20) ?? 0;
    // The winning attempt's own record only carries ITS cost...
    expect(record.cost_usd).toBeCloseTo(perCallUsd, 10);
    // ...but callCostUsd carries BOTH billed attempts.
    expect(callCostUsd).toBeCloseTo(perCallUsd * 2, 10);
  });

  it("getCallCostUsd(err) reads the accumulated total off an exhausted-attempts failure", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValue(chatResponse("not json{", 100, 20));
    const llm = new LlmClient(CONFIG, { client });

    let caught: unknown;
    try {
      await llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "c" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    // 3 exhausted attempts (MAX_JSON_ATTEMPTS), every one billed regardless of parse outcome.
    expect(getCallCostUsd(caught)).toBeCloseTo((chatCostUsd("gpt-4o-mini", 100, 20) ?? 0) * 3, 10);
  });

  it("getCallCostUsd(err) reads whatever THIS call billed before a non-retryable (network/SDK) error propagates", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate
      .mockResolvedValueOnce(chatResponse("not json{", 100, 20)) // billed, fails, retries
      .mockRejectedValueOnce(new Error("connection reset")); // not retryable — propagates immediately
    const llm = new LlmClient(CONFIG, { client });

    let caught: unknown;
    try {
      await llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "c" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("connection reset");
    // The first (JSON-parse-failed) attempt WAS billed before the network error hit —
    // that spend must not vanish just because the error that ultimately propagated
    // is a different, non-retryable one.
    expect(getCallCostUsd(caught)).toBeCloseTo(chatCostUsd("gpt-4o-mini", 100, 20) ?? 0, 10);
  });

  it("getCallCostUsd defaults to 0 for a value callJson never threw", () => {
    expect(getCallCostUsd(new Error("unrelated"))).toBe(0);
    expect(getCallCostUsd(null)).toBe(0);
    expect(getCallCostUsd("plain string")).toBe(0);
    expect(getCallCostUsd(undefined)).toBe(0);
  });

  it("CONCURRENCY: two interleaved callJson calls on ONE LlmClient never cross-attribute cost (round-5 reproduction)", async () => {
    // A dispatch mock that resolves conversation B's call BEFORE conversation A's,
    // even though A's callJson was invoked first — the exact interleaving shape that
    // broke a totalCostUsd-delta measurement (B's spend landing on the shared counter
    // in the middle of A's own before/after window).
    const chatCreate = vi.fn().mockImplementation(async (body: { messages: Array<{ content: string }> }) => {
      const isB = body.messages.some((m) => m.content.includes("conv-b"));
      if (isB) {
        // B resolves fast and first.
        return chatResponse(JSON.stringify({ who: "b" }), 200, 50);
      }
      // A resolves after a tick, so B's record() call lands inside A's await window.
      await new Promise((r) => setTimeout(r, 5));
      return chatResponse(JSON.stringify({ who: "a" }), 100, 20);
    });
    const client: OpenAILike = { chat: { completions: { create: chatCreate } }, embeddings: { create: vi.fn() } };
    const llm = new LlmClient(CONFIG, { client });

    const [a, b] = await Promise.all([
      llm.callJson<{ who: string }>({ systemPrompt: "s", userPrompt: "conv-a", pass: "pass1", conversationId: "a" }),
      llm.callJson<{ who: string }>({ systemPrompt: "s", userPrompt: "conv-b", pass: "pass1", conversationId: "b" }),
    ]);

    const aUsd = chatCostUsd("gpt-4o-mini", 100, 20) ?? 0;
    const bUsd = chatCostUsd("gpt-4o-mini", 200, 50) ?? 0;
    expect(a.data.who).toBe("a");
    expect(b.data.who).toBe("b");
    // Each call's own callCostUsd is ONLY its own spend — never inflated by the
    // other's concurrent call landing in between.
    expect(a.callCostUsd).toBeCloseTo(aUsd, 10);
    expect(b.callCostUsd).toBeCloseTo(bUsd, 10);
    // The shared counter still sees both (sanity: nothing was double-counted OR lost).
    expect(llm.totalCostUsd).toBeCloseTo(aUsd + bUsd, 10);
  });
});

describe("LlmClient.embed", () => {
  it("returns a vector and records cost", async () => {
    const { client, embedCreate } = fakeClient();
    embedCreate.mockResolvedValueOnce({
      data: [{ embedding: [0.1, 0.2, 0.3] }],
      usage: { prompt_tokens: 50 },
    });
    const llm = new LlmClient(CONFIG, { client });
    const { vector, record } = await llm.embed({ text: "hello", pass: "embed", conversationId: "c" });
    expect(vector).toEqual([0.1, 0.2, 0.3]);
    expect(record.cost_usd).toBeCloseTo(embedCostUsd("text-embedding-3-small", 50) ?? 0, 8);
  });

  it("returns a zero vector without calling the API for empty text", async () => {
    const { client, embedCreate } = fakeClient();
    const llm = new LlmClient(CONFIG, { client });
    const { vector, record } = await llm.embed({ text: "   ", pass: "embed", conversationId: "c" });
    expect(embedCreate).not.toHaveBeenCalled();
    expect(vector).toHaveLength(1536);
    expect(vector.every((v) => v === 0)).toBe(true);
    expect(record.cost_usd).toBe(0);
  });
});

describe("summarizeCost", () => {
  beforeEach(() => vi.clearAllMocks());

  it("aggregates cost per pass", async () => {
    const { client, chatCreate } = fakeClient();
    chatCreate.mockResolvedValue(chatResponse(JSON.stringify({ ok: 1 })));
    const llm = new LlmClient(CONFIG, { client });
    await llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "a" });
    await llm.callJson({ systemPrompt: "s", userPrompt: "u", pass: "pass1", conversationId: "b" });

    const summary = summarizeCost(llm.records);
    expect(summary).toContain("Total calls: 2");
    expect(summary).toContain("pass1: calls=2");
  });
});
