// D3 decision C2/C3 (2026-09-24): the separate user-turn pass, the
// within-session text dedupe, and the decision/learning narration guard.
import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { buildUserPassTurns, extractUserTurnPass, USER_PASS_ASSISTANT_CONTEXT_CHARS } from "../extract";
import { dedupeByNormalizedText, type GroundedRecord } from "../merge";
import type { RenderedTurn } from "../render";
import { parseMemoryRecord } from "../schema";
import type { MemoryWindow } from "../windows";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

function llmReturning(contents: string[]) {
  const create = vi.fn();
  for (const c of contents) {
    create.mockResolvedValueOnce({
      choices: [{ message: { content: c } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  }
  const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
  return { llm: new LlmClient(CONFIG, { client }), create };
}

function rt(idx: number, role: "user" | "assistant", line: string, isProse = true): RenderedTurn {
  return { idx, role, kind: isProse ? "prose" : "tool_use", line, isProse, charLen: line.length };
}

const WINDOW: MemoryWindow = {
  windowIndex: 0,
  turns: [rt(0, "user", "[#0 user] always use zsh, never bash, for scripts here")],
  containsUserProse: true,
  isToolOnly: false,
  isSubAgent: false,
} as MemoryWindow;

describe("buildUserPassTurns", () => {
  it("keeps user prose, each preceded once by the truncated prior assistant prose; drops tool turns", () => {
    const long = `[#1 assistant] ${"x".repeat(USER_PASS_ASSISTANT_CONTEXT_CHARS + 50)}`;
    const out = buildUserPassTurns([
      rt(0, "user", "[#0 user] hi"),
      rt(1, "assistant", long),
      rt(2, "assistant", "[#2 assistant tool_use] [tool: Edit a.ts]", false),
      rt(3, "user", "[#3 user] use zsh"),
      rt(4, "user", "[#4 user] and no emojis"),
    ]);
    expect(out.map((t) => t.idx)).toEqual([0, 1, 3, 4]);
    expect(out[1].line.length).toBe(USER_PASS_ASSISTANT_CONTEXT_CHARS + 1);
  });
});

describe("extractUserTurnPass", () => {
  it("falls back to zero records (failed, never throws) on malformed JSON", async () => {
    const { llm } = llmReturning(["not json {", "still not json", "{ nope"]);
    const out = await extractUserTurnPass(llm, "header", WINDOW, "s1");
    expect(out.failed).toBe(true);
    expect(out.records).toEqual([]);
  });

  it("falls back on a schema-invalid response", async () => {
    const bad = JSON.stringify({ records: "not-an-array" });
    const { llm } = llmReturning([bad, bad, bad]);
    const out = await extractUserTurnPass(llm, "header", WINDOW, "s1");
    expect(out.failed).toBe(true);
    expect(out.records).toEqual([]);
  });

  it("keeps only user-turn preference/blocker records", async () => {
    const body = JSON.stringify({
      records: [
        {
          kind: "preference",
          statement: "Use zsh for scripts",
          owner_quote: "always use zsh, never bash",
          turn_idx: 0,
          turn_role: "user",
          durable: true,
        },
        {
          kind: "decision",
          text: "Scripts use zsh",
          quote: "always use zsh, never bash",
          turn_idx: 0,
          turn_role: "user",
          durable: true,
        },
        {
          kind: "blocker",
          text: "Build fails on bash",
          quote: "always use zsh, never bash",
          turn_idx: 1,
          turn_role: "assistant",
          durable: true,
        },
      ],
    });
    const { llm } = llmReturning([body]);
    const out = await extractUserTurnPass(llm, "header", WINDOW, "s1");
    expect(out.failed).toBe(false);
    expect(out.records.map((r) => r.kind)).toEqual(["preference"]);
    expect(out.droppedOtherKind).toBe(2);
  });
});

describe("extractUserTurnPass retry-on-empty (issue #162)", () => {
  const EMPTY = JSON.stringify({ records: [] });
  const ONE_RECORD = JSON.stringify({
    records: [
      {
        kind: "preference",
        statement: "Use zsh for scripts",
        owner_quote: "always use zsh, never bash",
        turn_idx: 0,
        turn_role: "user",
        durable: true,
      },
    ],
  });

  it("empty -> non-empty: uses the second (recovered) result", async () => {
    const { llm, create } = llmReturning([EMPTY, ONE_RECORD]);
    const out = await extractUserTurnPass(llm, "header", WINDOW, "s1");
    expect(create).toHaveBeenCalledTimes(2);
    expect(out.records).toHaveLength(1);
    expect(out.retriedEmpty).toBe(1);
    expect(out.retryRecovered).toBe(1);
    expect(out.retrySkippedBudget).toBe(0);
  });

  it("empty -> empty: makes exactly 2 calls, uses the (still empty) second result", async () => {
    const { llm, create } = llmReturning([EMPTY, EMPTY]);
    const out = await extractUserTurnPass(llm, "header", WINDOW, "s1");
    expect(create).toHaveBeenCalledTimes(2);
    expect(out.records).toEqual([]);
    expect(out.retriedEmpty).toBe(1);
    expect(out.retryRecovered).toBe(0);
  });

  it("non-empty: makes exactly 1 call, never retries", async () => {
    const { llm, create } = llmReturning([ONE_RECORD, ONE_RECORD]);
    const out = await extractUserTurnPass(llm, "header", WINDOW, "s1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.retriedEmpty).toBe(0);
  });

  it("skips the retry when already over budget, counting retrySkippedBudget", async () => {
    const create = vi.fn();
    create.mockResolvedValueOnce({
      choices: [{ message: { content: EMPTY } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
    const llm = new LlmClient(CONFIG, { client, capUsd: 1e-9 });
    const out = await extractUserTurnPass(llm, "header", WINDOW, "s1");
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.records).toEqual([]);
    expect(out.retriedEmpty).toBe(0);
    expect(out.retrySkippedBudget).toBe(1);
  });

  it("RR-S1: skips the retry when canAffordRetry returns false, without needing overBudget", async () => {
    const { llm, create } = llmReturning([EMPTY, ONE_RECORD]);
    const canAffordRetry = () => false;
    const out = await extractUserTurnPass(llm, "header", WINDOW, "s1", canAffordRetry);
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.records).toEqual([]);
    expect(out.retriedEmpty).toBe(0);
    expect(out.retrySkippedBudget).toBe(1);
    expect(llm.overBudget()).toBe(false);
  });

  it("RR-S2: a retry that throws keeps the first (empty) result, failed:false, counts retryFailed", async () => {
    const create = vi.fn();
    create.mockResolvedValueOnce({
      choices: [{ message: { content: EMPTY } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    create.mockRejectedValueOnce(new Error("network error"));
    const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
    const llm = new LlmClient(CONFIG, { client });
    const out = await extractUserTurnPass(llm, "header", WINDOW, "s1");
    expect(create).toHaveBeenCalledTimes(2);
    expect(out.records).toEqual([]);
    expect(out.failed).toBe(false);
    expect(out.retriedEmpty).toBe(1);
    expect(out.retryRecovered).toBe(0);
    expect(out.retryFailed).toBe(1);
    expect(out.costUsd).toBeGreaterThan(0);
  });
});

describe("dedupeByNormalizedText (D3 C3)", () => {
  function g(over: Partial<GroundedRecord>): GroundedRecord {
    return {
      windowIndex: 0,
      kind: "preference",
      text: "Use zsh, not bash.",
      quote: null,
      turn_idx: 0,
      turn_role: "user",
      ref: null,
      ref_kind: null,
      durable: true,
      thread: null,
      scope: "project",
      confidence: 0.9,
      verified: true,
      contentHash: "a",
      paths: [],
      dangling: false,
      priority: false,
      ...over,
    };
  }

  it("collapses same-kind records differing only in case/punctuation/quotes, preferring the verified one", () => {
    const { kept, dropped } = dedupeByNormalizedText([
      g({ contentHash: "a", verified: true }),
      g({ contentHash: "b", text: "use ZSH not bash", verified: false }),
      g({ contentHash: "c", text: "Use zsh, not fish." }),
      g({ contentHash: "d", kind: "decision" }),
    ]);
    expect(dropped).toBe(1);
    expect(kept.map((r) => r.contentHash)).toEqual(["a", "c", "d"]);
  });

  it("keeps the later record when both are verified", () => {
    const { kept } = dedupeByNormalizedText([
      g({ contentHash: "a" }),
      g({ contentHash: "b", text: "use zsh not bash" }),
    ]);
    expect(kept.map((r) => r.contentHash)).toEqual(["b"]);
  });
});

describe("narration guard (D3 C3)", () => {
  it("rejects a decision or learning that narrates the session", () => {
    for (const kind of ["decision", "learning"]) {
      const res = parseMemoryRecord({
        kind,
        text: "We added a retry to the upload step",
        quote: "the upload step now retries with backoff",
        turn_idx: 1,
        turn_role: "assistant",
        durable: true,
      });
      expect(res.success).toBe(false);
    }
  });

  it("accepts the same fact stated directly", () => {
    const res = parseMemoryRecord({
      kind: "decision",
      text: "Upload step retries with backoff",
      quote: "the upload step now retries with backoff",
      turn_idx: 1,
      turn_role: "assistant",
      durable: true,
    });
    expect(res.success).toBe(true);
  });
});
