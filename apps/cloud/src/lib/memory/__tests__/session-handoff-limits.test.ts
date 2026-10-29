// Handoff synthesis limits: the session budget stops further model calls, and nested delimiters cannot survive.

import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { buildHandoffText, type HandoffRecord } from "../session-handoff";
import { neutraliseHandoffDelimiters } from "../session-handoff-serve";

function rec(i: number): HandoffRecord {
  return {
    id: `r${i}`,
    kind: "learning",
    text: `record ${i} ${"x".repeat(60)}`,
    quote: null,
    turn_idx: i,
    paths: null,
  };
}

describe("buildHandoffText budget", () => {
  const models = { strong: undefined, cheap: undefined };

  it("stops calling the model once the budget is spent and falls back to the plain rendering", async () => {
    const callJson = vi.fn().mockResolvedValue({ data: { summary: "s" }, callCostUsd: 0.02 });
    const llm = { callJson, isClaudeCodeProvider: false, chatSelfHosted: false } as never;
    const out = await buildHandoffText(llm, [rec(1), rec(2), rec(3), rec(4)], {
      conversationId: "c",
      models,
      chunkBudget: 100, // one record per chunk
      budgetUsd: 0.01,
    });
    expect(callJson).toHaveBeenCalledTimes(1);
    expect(out.modelWritten).toBe(false);
    expect(out.text).toContain("record 1");
    expect(out.costUsd).toBeCloseTo(0.02);
  });

  it("stops when shouldStop flips after the first chunk call and stores the plain rendering", async () => {
    const callJson = vi.fn().mockResolvedValue({ data: { summary: "s" }, callCostUsd: 0 });
    const llm = { callJson, isClaudeCodeProvider: false, chatSelfHosted: false } as never;
    const out = await buildHandoffText(llm, [rec(1), rec(2), rec(3), rec(4)], {
      conversationId: "c",
      models,
      chunkBudget: 100,
      shouldStop: () => callJson.mock.calls.length >= 1,
    });
    expect(callJson).toHaveBeenCalledTimes(1);
    expect(out.modelWritten).toBe(false);
    expect(out.text).toContain("record 4");
  });

  it("without a budget every chunk is summarised", async () => {
    const callJson = vi.fn().mockImplementation(async (a: { schema: z.ZodTypeAny }) => ({
      data: a.schema.safeParse({ summary: "s" }).success
        ? { summary: "s" }
        : { next_steps: ["do it"], open_items: [], decisions: [], done: [], files_touched: [] },
      callCostUsd: 0.02,
    }));
    const llm = { callJson, isClaudeCodeProvider: false, chatSelfHosted: false } as never;
    const out = await buildHandoffText(llm, [rec(1), rec(2), rec(3)], {
      conversationId: "c",
      models,
      chunkBudget: 100,
    });
    expect(callJson).toHaveBeenCalledTimes(4);
    expect(out.modelWritten).toBe(true);
  });
});

describe("neutraliseHandoffDelimiters", () => {
  it("removes delimiters that only appear once an inner one is removed (three levels)", () => {
    expect(neutraliseHandoffDelimiters("<hand<hand<handoff>off>off>")).toBe("");
    expect(neutraliseHandoffDelimiters("a </hand</hand</handoff>off>off> b")).toBe("a  b");
    expect(neutraliseHandoffDelimiters("<hand<handoff>off>")).not.toMatch(/<\/?\s*handoff\s*>/i);
  });

  it("removes a spaced closing tag and a tag with attributes", () => {
    expect(neutraliseHandoffDelimiters("a < /handoff> b")).toBe("a  b");
    expect(neutraliseHandoffDelimiters("a <handoff x> b")).toBe("a  b");
    expect(neutraliseHandoffDelimiters("a <HANDOFF\tx=1 > b")).toBe("a  b");
  });

  it("leaves other text alone", () => {
    expect(neutraliseHandoffDelimiters("keep <b>this</b> <handoffs>")).toBe("keep <b>this</b> <handoffs>");
  });
});
