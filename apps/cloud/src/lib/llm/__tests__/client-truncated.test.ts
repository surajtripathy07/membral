import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { log } from "../../log";
import { getCallCostUsd, LlmClient, type OpenAILike, OutputTruncatedError } from "../client";
import type { ModelConfig } from "../config";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test-key",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

function clientReturning(content: string | null, finishReason?: string) {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content }, ...(finishReason !== undefined ? { finish_reason: finishReason } : {}) }],
    usage: { prompt_tokens: 9896, completion_tokens: 2000 },
  });
  const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
  return { llm: new LlmClient(CONFIG, { client }), create };
}

const call = (llm: LlmClient) =>
  llm.callJson({
    systemPrompt: "s",
    userPrompt: "u",
    pass: "memory_backfill",
    conversationId: "c1",
    schema: z.object({ records: z.array(z.unknown()) }),
  });

afterEach(() => vi.restoreAllMocks());

describe("callJson: a reply cut off at the output limit (issue #339)", () => {
  it('finish_reason "length" is never resent and exposes the cut-off text off the log path', async () => {
    const cut = '{"records": [{"text": "MARKER-cut-3f0 half';
    const { llm, create } = clientReturning(cut, "length");
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    const err = await call(llm).catch((e: unknown) => e);
    expect(create).toHaveBeenCalledTimes(1);
    expect(err).toBeInstanceOf(OutputTruncatedError);
    const t = err as OutputTruncatedError;
    expect(t.rawText).toBe(cut);
    expect(t.tokensOut).toBe(2000);
    expect(t.message).toBe("output_truncated");
    // The raw text is not enumerable, so serializing the error cannot carry it.
    expect(JSON.stringify(t)).not.toContain("MARKER-cut-3f0");
    expect(Object.keys(t)).not.toContain("rawText");
    expect(getCallCostUsd(err)).toBeGreaterThan(0);
    expect(llm.retryCount).toBe(0);
    for (const c of infoSpy.mock.calls) expect(JSON.stringify(c)).not.toContain("MARKER-cut-3f0");
  });

  it('finish_reason "length" with an empty reply is not resent either', async () => {
    const { llm, create } = clientReturning("", "length");
    await expect(call(llm)).rejects.toBeInstanceOf(OutputTruncatedError);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('finish_reason "length" with a reply that still parses is accepted', async () => {
    const { llm, create } = clientReturning('{"records": []}', "length");
    const { data } = await call(llm);
    expect(data).toEqual({ records: [] });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('finish_reason "stop" with malformed JSON keeps the retry: 3 calls, then the parse error', async () => {
    const { llm, create } = clientReturning("not { json", "stop");
    const err = await call(llm).catch((e: unknown) => e);
    expect(create).toHaveBeenCalledTimes(3);
    expect(err).not.toBeInstanceOf(OutputTruncatedError);
    expect((err as Error).message).toMatch(/^JSON parse\/validation failed/);
  });

  it("no finish_reason at all (older providers) keeps the retry too", async () => {
    const { llm, create } = clientReturning("not { json");
    await expect(call(llm)).rejects.toThrow(/JSON parse\/validation failed/);
    expect(create).toHaveBeenCalledTimes(3);
  });

  it("the llm_call log line carries finish_reason, capped at 32 chars", async () => {
    const infoSpy = vi.spyOn(log, "info").mockImplementation(() => {});
    const { llm } = clientReturning('{"records": []}', "stop");
    await call(llm);
    const line = infoSpy.mock.calls.find((c) => c[0] === "llm_call");
    expect(line?.[1]).toMatchObject({ event: "llm_call", finish_reason: "stop", tokens_out: 2000 });

    infoSpy.mockClear();
    const { llm: llm2 } = clientReturning('{"records": []}', "x".repeat(100));
    await call(llm2);
    const long = infoSpy.mock.calls.find((c) => c[0] === "llm_call");
    expect((long?.[1] as { finish_reason: string }).finish_reason).toHaveLength(32);

    infoSpy.mockClear();
    const { llm: llm3 } = clientReturning('{"records": []}');
    await call(llm3);
    expect(infoSpy.mock.calls.find((c) => c[0] === "llm_call")?.[1]).toMatchObject({ finish_reason: null });
  });
});
