import { describe, expect, it } from "vitest";
import {
  DEFAULT_SESSION_BUDGET_USD,
  estimateWindowCostUsd,
  resolveSessionBudgetUsd,
  selectWindowsWithinBudget,
} from "../budget";
import type { MemoryWindow } from "../windows";

function makeWindow(overrides: Partial<MemoryWindow> & Pick<MemoryWindow, "windowIndex">): MemoryWindow {
  return {
    turns: [],
    containsUserProse: false,
    isToolOnly: false,
    isSubAgent: false,
    proseDensity: 0,
    charLen: 200_000, // large enough that every window is individually expensive
    ...overrides,
  };
}

describe("resolveSessionBudgetUsd", () => {
  it("defaults to $0.25", () => {
    expect(resolveSessionBudgetUsd({})).toBe(DEFAULT_SESSION_BUDGET_USD);
  });

  it("honors MEMBRAL_MEMORY_SESSION_BUDGET_USD", () => {
    expect(resolveSessionBudgetUsd({ MEMBRAL_MEMORY_SESSION_BUDGET_USD: "0.5" })).toBe(0.5);
  });
});

describe("estimateWindowCostUsd (step2d finding 5)", () => {
  it("throws, never returns 0, for an unpriced model", () => {
    const window = makeWindow({ windowIndex: 0, charLen: 1000 });
    expect(() => estimateWindowCostUsd(window, "gpt-5-mini", 200)).toThrow(/no pricing entry/i);
  });

  it("prices a known model normally", () => {
    const window = makeWindow({ windowIndex: 0, charLen: 1000 });
    expect(estimateWindowCostUsd(window, "gpt-4o-mini", 200)).toBeGreaterThan(0);
  });
});

describe("selectWindowsWithinBudget", () => {
  const opts = { budgetUsd: 0.001, model: "gpt-4o-mini", headerAndPrecontextChars: 1000 };

  it("keeps everything when under budget", () => {
    const windows = [makeWindow({ windowIndex: 0, charLen: 10 })];
    const result = selectWindowsWithinBudget(windows, { ...opts, budgetUsd: 10 });
    expect(result.selected).toHaveLength(1);
    expect(result.budgetHit).toBe(false);
  });

  it("never drops a window containing user prose", () => {
    const windows = [
      makeWindow({ windowIndex: 0, containsUserProse: true }),
      makeWindow({ windowIndex: 1, containsUserProse: true, isToolOnly: false }),
      makeWindow({ windowIndex: 2, containsUserProse: true }),
    ];
    const result = selectWindowsWithinBudget(windows, opts);
    expect(result.selected.map((w) => w.windowIndex)).toEqual([0, 1, 2]);
    expect(result.droppedContainingUserProse).toBe(0);
  });

  it("always keeps the first and last windows even when over budget and eligible to drop", () => {
    const windows = [
      makeWindow({ windowIndex: 0, isToolOnly: true }),
      makeWindow({ windowIndex: 1, isToolOnly: true }),
      makeWindow({ windowIndex: 2, isToolOnly: true }),
    ];
    const result = selectWindowsWithinBudget(windows, opts);
    const selectedIdx = result.selected.map((w) => w.windowIndex);
    expect(selectedIdx).toContain(0);
    expect(selectedIdx).toContain(2);
  });

  it("drops sub-agent windows before tool-only windows", () => {
    const windows = [
      makeWindow({ windowIndex: 0, containsUserProse: true }), // first — kept regardless
      makeWindow({ windowIndex: 1, isSubAgent: true }),
      makeWindow({ windowIndex: 2, isToolOnly: true }),
      makeWindow({ windowIndex: 3, containsUserProse: true }), // last — kept regardless
    ];
    // Budget only large enough for 2 of the 4 windows worth of estimated cost.
    const result = selectWindowsWithinBudget(windows, { ...opts, budgetUsd: opts.budgetUsd * 2 });
    expect(result.dropped[0]?.windowIndex).toBe(1); // sub-agent dropped first
  });

  it("drops tool-only windows before lower-density prose windows", () => {
    const windows = [
      makeWindow({ windowIndex: 0, containsUserProse: true }),
      makeWindow({ windowIndex: 1, isToolOnly: true }),
      makeWindow({ windowIndex: 2, proseDensity: 0.1 }),
      makeWindow({ windowIndex: 3, containsUserProse: true }),
    ];
    const result = selectWindowsWithinBudget(windows, { ...opts, budgetUsd: opts.budgetUsd * 2 });
    expect(result.dropped[0]?.windowIndex).toBe(1);
  });

  it("drops lowest-density windows first among non-tool-only, non-subagent candidates", () => {
    const windows = [
      makeWindow({ windowIndex: 0, containsUserProse: true }),
      makeWindow({ windowIndex: 1, proseDensity: 0.5 }),
      makeWindow({ windowIndex: 2, proseDensity: 0.1 }),
      makeWindow({ windowIndex: 3, containsUserProse: true }),
    ];
    const result = selectWindowsWithinBudget(windows, { ...opts, budgetUsd: opts.budgetUsd * 2 });
    expect(result.dropped[0]?.windowIndex).toBe(2);
  });

  it("sets budgetHit when anything was dropped, and leaves it false otherwise", () => {
    const windows = [
      makeWindow({ windowIndex: 0, containsUserProse: true }),
      makeWindow({ windowIndex: 1, isToolOnly: true }),
      makeWindow({ windowIndex: 2, containsUserProse: true }),
    ];
    const dropped = selectWindowsWithinBudget(windows, opts);
    expect(dropped.budgetHit).toBe(true);

    const kept = selectWindowsWithinBudget(windows, { ...opts, budgetUsd: 100 });
    expect(kept.budgetHit).toBe(false);
  });

  it("stops the run cap even if a single window can't be dropped (only window is first+last)", () => {
    const windows = [makeWindow({ windowIndex: 0, containsUserProse: true })];
    const result = selectWindowsWithinBudget(windows, opts);
    expect(result.selected).toHaveLength(1);
    expect(result.budgetHit).toBe(false); // nothing eligible to drop, and nothing WAS dropped
  });
});
