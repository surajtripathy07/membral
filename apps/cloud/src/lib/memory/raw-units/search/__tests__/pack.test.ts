// packLines equals the lab's packToBudget with chars/4 over the joined text, stopping at the first line that does not fit.
import { describe, expect, it } from "vitest";
import { charsOver4, packLines } from "../pack";
import { fx } from "./helpers";

describe("packLines equals the lab", () => {
  for (const c of fx.pack.cases) {
    it(`budget ${c.budget}`, () => {
      expect(packLines(fx.pack.lines, c.budget)).toEqual(c.expected);
    });
  }
  it("counts the join newline, so a boundary line is dropped", () => {
    const j = fx.pack.join;
    expect(packLines(j.lines, j.budget)).toEqual(j.expected);
    expect(j.expected.lines.length).toBeLessThan(j.lines.length + 1);
  });
  it("stops at the FIRST line that does not fit, not skipping to a later short one", () => {
    expect(packLines(["a".repeat(8), "b".repeat(80), "c"], 5).lines).toEqual(["a".repeat(8)]);
  });
  it("chars/4 rounds up", () => {
    expect(charsOver4("")).toBe(0);
    expect(charsOver4("abcde")).toBe(2);
  });
});
