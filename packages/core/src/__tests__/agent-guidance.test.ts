import { describe, expect, it } from "vitest";
import {
  RECALL_RESULTS_CLAUSE,
  RECALL_VS_STATE_FULL,
  RECALL_VS_STATE_HEADING,
  RECALL_VS_STATE_LINES,
  RECALL_VS_STATE_SHORT,
  RECALL_VS_STATE_SHORT_NOT_STATE,
  RECALL_VS_STATE_SHORT_USE,
  RECALL_VS_STATE_TOOLS_LINE,
} from "../index.js";

describe("recall-vs-state guidance", () => {
  it("keeps each preamble line under the CLI hook's 300-char cut", () => {
    expect(RECALL_VS_STATE_SHORT).toEqual([RECALL_VS_STATE_SHORT_USE, RECALL_VS_STATE_SHORT_NOT_STATE]);
    for (const line of RECALL_VS_STATE_SHORT) {
      expect(line.length).toBeLessThanOrEqual(300);
      expect(line).not.toContain("\n");
    }
  });

  it("leaves the not-state line's project hint room for a readable name (300 - hint prefix 17 - 20)", () => {
    expect(RECALL_VS_STATE_SHORT_NOT_STATE.length).toBeLessThanOrEqual(300 - 17 - 20);
  });

  it("states good uses on one line and the not-state rule on the other", () => {
    expect(RECALL_VS_STATE_SHORT_USE).toMatch(/did, decided and found/);
    expect(RECALL_VS_STATE_SHORT_USE).toContain("mcp__membral__memory_search");
    expect(RECALL_VS_STATE_SHORT_NOT_STATE).toMatch(/not live state/);
    expect(RECALL_VS_STATE_SHORT_NOT_STATE).toMatch(/gh\/glab\/git/);
  });

  it("says both halves of the rule on the full surface", () => {
    expect(RECALL_VS_STATE_FULL).toMatch(/did, decided and found/);
    expect(RECALL_VS_STATE_FULL).toMatch(/not live state/);
    expect(RECALL_RESULTS_CLAUSE).toMatch(/not the current state/);
  });

  it("builds the full text from the heading and the lines", () => {
    expect(RECALL_VS_STATE_FULL).toBe(
      [
        RECALL_VS_STATE_HEADING,
        ...RECALL_VS_STATE_LINES.slice(0, -1),
        RECALL_VS_STATE_TOOLS_LINE,
        ...RECALL_VS_STATE_LINES.slice(-1),
      ].join("\n"),
    );
    expect(RECALL_VS_STATE_LINES).not.toContain(RECALL_VS_STATE_TOOLS_LINE);
  });
});
