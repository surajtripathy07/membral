import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { log } from "../../log";

const runClaudeCodeMock = vi.hoisted(() => vi.fn());
vi.mock("../claude-code-provider", async (orig) => ({
  ...(await orig<typeof import("../claude-code-provider")>()),
  runClaudeCode: runClaudeCodeMock,
}));

import { CLAUDE_CODE_PROVIDER } from "../claude-code-provider";
import { LlmClient, type OpenAILike, ProviderBodyError, UnpricedModelError } from "../client";
import type { ModelConfig } from "../config";

// Issue #188 / R5 5.11: the error and fallback branches of LlmClient that no
// other test reaches (nullish provider bodies, claude-code refusals, empty
// embedding replies, the audit logger).

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test-key",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};
const CLAUDE_CONFIG: ModelConfig = { ...CONFIG, model: "claude-code/default", provider: CLAUDE_CODE_PROVIDER };

function build(config: ModelConfig = CONFIG, opts: ConstructorParameters<typeof LlmClient>[1] = {}) {
  const chatCreate = vi.fn();
  const embedCreate = vi.fn();
  const client: OpenAILike = {
    chat: { completions: { create: chatCreate } },
    embeddings: { create: embedCreate },
  };
  return { llm: new LlmClient(config, { client, ...opts }), chatCreate, embedCreate };
}

const json = (llm: LlmClient, extra: { model?: string } = {}) =>
  llm.callJson({
    systemPrompt: "s",
    userPrompt: "u",
    pass: "memory_backfill",
    conversationId: "c1",
    schema: z.object({ a: z.number() }),
    ...extra,
  });

beforeEach(() => runClaudeCodeMock.mockReset());
afterEach(() => vi.restoreAllMocks());

describe("chat reply shapes with missing fields", () => {
  it("a null body throws ProviderBodyError with no status and is not resent", async () => {
    const { llm, chatCreate } = build();
    chatCreate.mockResolvedValue(null);
    const err = await json(llm).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderBodyError);
    expect((err as ProviderBodyError).status).toBeUndefined();
    expect(chatCreate).toHaveBeenCalledTimes(1);
  });

  it("an error body with a numeric code carries it as the status; a non-numeric or absent code leaves it undefined", async () => {
    const { llm, chatCreate } = build();
    chatCreate.mockResolvedValueOnce({ error: { code: 429 } });
    const withCode = await json(llm).catch((e: unknown) => e);
    expect((withCode as ProviderBodyError).status).toBe(429);
    chatCreate.mockResolvedValueOnce({ error: { code: "rate_limited" } });
    const stringCode = await json(llm).catch((e: unknown) => e);
    expect(stringCode).toBeInstanceOf(ProviderBodyError);
    expect((stringCode as ProviderBodyError).status).toBeUndefined();
    chatCreate.mockResolvedValueOnce({});
    const noError = await json(llm).catch((e: unknown) => e);
    expect((noError as ProviderBodyError).status).toBeUndefined();
  });

  it("a choice with no message, finish_reason or usage reads as an empty reply: 3 attempts, zero tokens, zero cost", async () => {
    const { llm, chatCreate } = build();
    chatCreate.mockResolvedValue({ choices: [{}] });
    await expect(json(llm)).rejects.toThrow(/Empty response from gpt-4o-mini/);
    expect(chatCreate).toHaveBeenCalledTimes(3);
    expect(llm.emptyResponseCount).toBe(3);
  });

  it("a good reply without a usage block records 0 tokens in and out", async () => {
    const { llm, chatCreate } = build();
    chatCreate.mockResolvedValue({ choices: [{ message: { content: '{"a":1}' } }] });
    const { data, record } = await json(llm);
    expect(data).toEqual({ a: 1 });
    expect(record.tokens_in).toBe(0);
    expect(record.tokens_out).toBe(0);
    expect(record.cost_usd).toBe(0);
  });
});

describe("claude-code provider failures", () => {
  it("a CLI failure throws ProviderBodyError and is not retried", async () => {
    runClaudeCodeMock.mockResolvedValue({ kind: "error", exitCode: 1 });
    const { llm, chatCreate } = build(CLAUDE_CONFIG);
    const err = await json(llm).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderBodyError);
    expect((err as ProviderBodyError).status).toBeUndefined();
    expect(runClaudeCodeMock).toHaveBeenCalledTimes(1);
    expect(chatCreate).not.toHaveBeenCalled();
  });

  it("a per-call model that is not a claude-code/ label is refused before the CLI runs", async () => {
    const { llm } = build(CLAUDE_CONFIG);
    await expect(json(llm, { model: "gpt-4o-mini" })).rejects.toBeInstanceOf(UnpricedModelError);
    expect(runClaudeCodeMock).not.toHaveBeenCalled();
  });
});

describe("embed() and embedMany() with sparse replies", () => {
  it("embed: a reply with no data and no usage returns a zero vector at the configured width and bills nothing", async () => {
    const { llm, embedCreate } = build();
    embedCreate.mockResolvedValue({ data: [] });
    const { vector, record } = await llm.embed({ text: "hello", pass: "embed", conversationId: "c" });
    expect(vector).toHaveLength(1536);
    expect(vector.every((x) => x === 0)).toBe(true);
    expect(record.tokens_in).toBe(0);
    expect(record.cost_usd).toBe(0);
  });

  it("embedMany: an empty list makes no call and returns no vectors", async () => {
    const { llm, embedCreate } = build();
    const { vectors, record } = await llm.embedMany({ texts: [], pass: "embed", conversationId: "c" });
    expect(vectors).toEqual([]);
    expect(embedCreate).not.toHaveBeenCalled();
    expect(record.tokens_in).toBe(0);
  });

  it("embedMany: usage prompt_tokens is billed at the embedding price", async () => {
    const { llm, embedCreate } = build();
    embedCreate.mockResolvedValue({
      data: [{ embedding: new Array(1536).fill(0.1) }],
      usage: { prompt_tokens: 1_000_000 },
    });
    const { record } = await llm.embedMany({ texts: ["a"], pass: "embed", conversationId: "c" });
    expect(record.tokens_in).toBe(1_000_000);
    expect(record.cost_usd).toBeGreaterThan(0);
  });

  it("embedMany: a missing entry becomes a zero vector in its position; present ones are kept; no usage means 0 tokens", async () => {
    const { llm, embedCreate } = build();
    embedCreate.mockResolvedValue({ data: [{ embedding: new Array(1536).fill(0.5) }] });
    const { vectors, record } = await llm.embedMany({ texts: ["a", "b"], pass: "embed", conversationId: "c" });
    expect(vectors).toHaveLength(2);
    expect(vectors[0][0]).toBe(0.5);
    expect(vectors[1]).toHaveLength(1536);
    expect(vectors[1].every((x) => x === 0)).toBe(true);
    expect(record.tokens_in).toBe(0);
  });
});

describe("the audit logger", () => {
  it("receives one entry per call, carrying the raw reply and the parse outcome", async () => {
    const logCall = vi.fn();
    const { llm, chatCreate } = build(CONFIG, { logger: { logCall } });
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: '{"a":2}' } }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    });
    await json(llm);
    expect(logCall).toHaveBeenCalledTimes(1);
    expect(logCall.mock.calls[0][0]).toMatchObject({
      pass: "memory_backfill",
      conversationId: "c1",
      rawResponse: '{"a":2}',
      parsedOutput: { a: 2 },
      parseError: null,
      tokensIn: 3,
      tokensOut: 4,
    });
  });

  it("a logger that throws never breaks the call; the failure is warned", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => {});
    const logCall = vi.fn().mockRejectedValue(new Error("db down"));
    const { llm, chatCreate } = build(CONFIG, { logger: { logCall } });
    chatCreate.mockResolvedValue({ choices: [{ message: { content: '{"a":2}' } }] });
    const { data } = await json(llm);
    expect(data).toEqual({ a: 2 });
    expect(warn).toHaveBeenCalledWith("extraction log failed", expect.objectContaining({ err: "db down" }));
  });
});
