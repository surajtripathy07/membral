// Prompt v21: the main extraction pass says a decision carries its consequence
// and scope (naming the file it rules on), and a reported number keeps its unit
// and window, with durations computed from the session's own timestamps. Read
// from the request the LLM actually receives; the rules stay private to extract.ts.
import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { extractWindow, PROMPT_VERSION } from "../extract";
import { MEMORY_TEXT_SOFT } from "../memory-limits";
import { renderTurnLines, type TurnRow } from "../render";
import { MEMORY_TEXT_MAX, parseMemoryRecord } from "../schema";
import { buildWindows } from "../windows";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

async function mainPrompt(): Promise<string> {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ records: [], issues: [] }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
  const turns: TurnRow[] = [
    {
      idx: 0,
      role: "user",
      kind: "prose",
      text: "leave that file alone",
      tool_name: null,
      file_path: null,
      ts: null,
      props: null,
    },
  ];
  await extractWindow(new LlmClient(CONFIG, { client }), "header", [], buildWindows(renderTurnLines(turns))[0], "s1");
  return create.mock.calls[0][0].messages[0].content as string;
}

describe("prompt v21: decision consequence and measurement rules", () => {
  it("is v24 (v21 rules kept)", () => {
    expect(PROMPT_VERSION).toBe("memory-extract-v26");
  });

  it("asks a decision to state its consequence, an explicit do-not, and the file in paths", async () => {
    const sent = await mainPrompt();
    expect(sent).toContain("A decision states the ruling AND what follows from it");
    expect(sent).toContain("that instruction in so many words");
    expect(sent).toContain("names that file in the text and lists its repo-relative path in paths");
    expect(sent).toContain('Bad: "The legacy-build flag is on."');
    expect(sent).toContain("- paths: optional");
  });

  it("asks a reported number to keep its unit and window, durations computed from both end times", async () => {
    const sent = await mainPrompt();
    expect(sent).toContain(
      "For an outcome or learning that reports a number, keep the number with its unit and its window",
    );
    expect(sent).toContain("compute it only when the cited turns show both endpoints");
    expect(sent).toContain("Never invent, round up, or estimate a figure");
  });

  it("keeps the one-sentence cap and the existing rules", async () => {
    const sent = await mainPrompt();
    expect(sent).toContain(`text: one sentence, aim for at most ${MEMORY_TEXT_SOFT} characters`);
    expect(sent).toContain("For a decision or outcome about a forge action or item");
    expect(sent).toContain("When a record is about one specific MR/PR or issue");
  });
});

describe("schema: a v21 decision with paths and a full-length text still validates", () => {
  it("round-trips paths and a text of exactly MEMORY_TEXT_MAX characters", () => {
    const head = "Keep the legacy-build flag on in build/flags.json: the release script reads it, so do not remove it";
    const text = `${head}${" and leave it".repeat(60)}`.slice(0, MEMORY_TEXT_MAX - 1).concat(".");
    expect(text).toHaveLength(MEMORY_TEXT_MAX);
    const result = parseMemoryRecord({
      kind: "decision",
      text,
      quote: "keep legacy-build on, the release script reads it",
      turn_idx: 3,
      turn_role: "user",
      durable: true,
      thread: "release build flags",
      paths: ["build/flags.json"],
      scope: "project",
      confidence: 0.8,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.text).toBe(text);
      expect(result.data.paths).toEqual(["build/flags.json"]);
    }
  });

  it("still rejects a text one character over the cap", () => {
    const result = parseMemoryRecord({
      kind: "decision",
      text: "x".repeat(MEMORY_TEXT_MAX + 1),
      quote: "q",
      turn_idx: 0,
      turn_role: "user",
      paths: ["build/flags.json"],
    });
    expect(result.success).toBe(false);
  });
});

describe("prompt v23: an incident window is a learning with the time in its quote", () => {
  it("lets a learning state what was down, when, and what restored it", async () => {
    const sent = await mainPrompt();
    expect(sent).toContain(
      "A learning may also state what was down, broken or slow (an incident, outage or regression; not a benchmark result), from when to when or for how long, and what restored or fixed it.",
    );
    expect(sent).toContain("Its quote is taken from the line that states the time or duration.");
  });

  it("asks the quote to carry one end of a stated window, and the checklist to look for incidents", async () => {
    const sent = await mainPrompt();
    expect(sent).toContain(
      "For a learning or outcome about an incident, outage or regression that states a time window or duration, the quote contains at least one end of that window (or the duration) verbatim",
    );
    expect(sent).toContain("an incident or regression and when it happened (with the time in the quote)");
  });
});
