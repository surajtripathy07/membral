// Prompt v22: a Write/Edit/MultiEdit tool_use line carries the text the session
// wrote to that file, and the main pass is told that text counts as stated in
// the session. Read from the request the LLM actually receives.
import { describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { extractWindow, PROMPT_VERSION } from "../extract";
import { renderTurnLines, type TurnRow } from "../render";
import { buildWindows } from "../windows";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

const WRITTEN = "Ruling: the queue worker keeps a 30 s visibility timeout; do not raise it.";

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
      text: "write the ruling down",
      tool_name: null,
      file_path: null,
      ts: null,
      props: null,
    },
    {
      idx: 1,
      role: "assistant",
      kind: "tool_use",
      text: WRITTEN,
      tool_name: "Write",
      file_path: "docs/goals/queue.md",
      ts: null,
      props: null,
    },
  ];
  await extractWindow(new LlmClient(CONFIG, { client }), "header", [], buildWindows(renderTurnLines(turns))[0], "s1");
  const messages = create.mock.calls[0][0].messages as { content: string }[];
  return messages.map((m) => m.content).join("\n");
}

describe("prompt v22: text a session wrote to a file", () => {
  it("is v24 (v22 rules kept)", () => {
    expect(PROMPT_VERSION).toBe("memory-extract-v26");
  });

  it("tells the main pass that written text counts as stated, quoted, with the file in paths", async () => {
    const sent = await mainPrompt();
    expect(sent).toContain("is text this session itself wrote to that file");
    expect(sent).toContain("counts as stated in this session");
    expect(sent).toContain("repo-relative path in paths");
  });

  it("asks a record of an event to keep its absolute time or window, both ends", async () => {
    const sent = await mainPrompt();
    expect(sent).toContain("the record text carries that time or window verbatim, both ends of a window included");
  });

  it("puts the written text in the prompt under its tool tag", async () => {
    const sent = await mainPrompt();
    expect(sent).toContain(`[#1 assistant tool_use] [tool: Write docs/goals/queue.md]\n${WRITTEN}`);
  });
});
