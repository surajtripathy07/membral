// Prompt v20: both extraction prompts state every schema length cap, so the
// model writes within it. An over-long field drops the record (rule 3); the
// prompt is the only fix, never truncation. These tests read the caps from
// schema.ts and the prompts from the request the LLM actually receives.
import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { extractUserTurnPass, extractWindow } from "../extract";
import { MEMORY_TEXT_MAX_HARD, MEMORY_TEXT_SOFT } from "../memory-limits";
import { renderTurnLines, type TurnRow } from "../render";
import {
  ISSUE_EVIDENCE_QUOTE_MAX,
  ISSUE_MENTION_QUOTE_MAX,
  ISSUE_REF_MAX,
  MEMORY_QUOTE_MAX,
  MEMORY_REF_MAX,
  MEMORY_TEXT_MAX,
  MEMORY_THREAD_MAX,
  NonPreferenceRecord,
  PreferenceRecord,
} from "../schema";
import { buildWindows } from "../windows";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

function capturingLlm() {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ records: [], issues: [] }) } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  });
  const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
  return { llm: new LlmClient(CONFIG, { client }), create };
}

function window() {
  const turns: TurnRow[] = [
    {
      idx: 0,
      role: "user",
      kind: "prose",
      text: "always run the migrations before deploying",
      tool_name: null,
      file_path: null,
      ts: null,
      props: null,
    },
  ];
  return buildWindows(renderTurnLines(turns))[0];
}

async function mainPrompt(): Promise<string> {
  const { llm, create } = capturingLlm();
  await extractWindow(llm, "header", [], window(), "s1");
  return create.mock.calls[0][0].messages[0].content as string;
}

async function userPassPrompt(): Promise<string> {
  const { llm, create } = capturingLlm();
  await extractUserTurnPass(llm, "header", window(), "s1");
  return create.mock.calls[0][0].messages[0].content as string;
}

const RECORD_LIMITS =
  `Length limits, in characters of the exact string you write: text and statement aim for at most ${MEMORY_TEXT_SOFT} (hard limit ${MEMORY_TEXT_MAX_HARD}); ` +
  `quote and owner_quote at most ${MEMORY_QUOTE_MAX}; ref at most ${MEMORY_REF_MAX}; thread at most ${MEMORY_THREAD_MAX}.`;

describe("extraction prompts state the schema's length caps (v20)", () => {
  it("the caps are the ones the schema enforces", () => {
    const base = { kind: "decision", turn_idx: 0, turn_role: "user", quote: "a verbatim quote" };
    expect(NonPreferenceRecord.safeParse({ ...base, text: "x".repeat(MEMORY_TEXT_MAX) }).success).toBe(true);
    expect(NonPreferenceRecord.safeParse({ ...base, text: "x".repeat(MEMORY_TEXT_MAX + 1) }).success).toBe(false);
    const pref = { kind: "preference", turn_idx: 0, turn_role: "user", statement: "Run migrations first." };
    expect(PreferenceRecord.safeParse({ ...pref, owner_quote: "y".repeat(MEMORY_QUOTE_MAX + 1) }).success).toBe(false);
    expect(
      NonPreferenceRecord.safeParse({ ...base, text: "ok text", thread: "t".repeat(MEMORY_THREAD_MAX + 1) }).success,
    ).toBe(false);
  });

  it("the window prompt states every record cap and the issues caps", async () => {
    const system = await mainPrompt();
    expect(system).toContain(RECORD_LIMITS);
    expect(system).toContain(`- text: one sentence, aim for at most ${MEMORY_TEXT_SOFT} characters`);
    expect(system).toContain(`at most ${MEMORY_QUOTE_MAX} characters — this is the receipt`);
    expect(system).toContain(`imperative or declarative, aim for at most ${MEMORY_TEXT_SOFT} characters`);
    expect(system).toContain(`<= 6 words and at most ${MEMORY_THREAD_MAX} characters`);
    expect(system).toContain(`At most ${ISSUE_REF_MAX} characters.`);
    expect(system).toContain(`at most ${ISSUE_EVIDENCE_QUOTE_MAX} characters.`);
    expect(system).toContain(`at most ${ISSUE_MENTION_QUOTE_MAX} characters>`);
    expect(system).not.toContain("one or two sentences");
  });

  it("the user-turn pass prompt states every record cap", async () => {
    const system = await userPassPrompt();
    expect(system).toContain(RECORD_LIMITS);
    expect(system).toContain(`Give "text" (one sentence, aim for at most ${MEMORY_TEXT_SOFT} characters`);
    expect(system).toContain(
      `Give "statement" (the rule itself, imperative or declarative, aim for at most ${MEMORY_TEXT_SOFT} characters`,
    );
    expect(system).toContain(`thread (<= 6 words, at most ${MEMORY_THREAD_MAX} characters)`);
  });

  it("no prompt carries an uninterpolated placeholder", async () => {
    for (const system of [await mainPrompt(), await userPassPrompt()]) expect(system).not.toMatch(/\$\{/);
  });
});
