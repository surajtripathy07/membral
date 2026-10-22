import { describe, expect, it } from "vitest";
import {
  countTailTurnsExtracted,
  countTailTurnsUncovered,
  countWindowsFailed,
  didCheckpointAdvance,
  runCostUsd,
} from "../checkpoint";

const turns = (...idxs: number[]) => idxs.map((idx) => ({ idx }));

describe("countTailTurnsExtracted", () => {
  it("is 0 with zero windows selected", () => {
    expect(countTailTurnsExtracted([])).toBe(0);
  });

  it("counts a turn shared by overlapping windows once", () => {
    expect(countTailTurnsExtracted([{ turns: turns(1, 2, 3) }, { turns: turns(3, 4) }])).toBe(4);
  });

  it("is 0 when the selected windows carry no turns", () => {
    expect(countTailTurnsExtracted([{ turns: [] }, { turns: [] }])).toBe(0);
  });
});

describe("countTailTurnsUncovered", () => {
  it("counts every tail turn when the checkpoint did not move (null)", () => {
    expect(countTailTurnsUncovered(turns(5, 6, 7), null)).toBe(3);
  });

  it("counts only turns strictly past the checkpoint", () => {
    expect(countTailTurnsUncovered(turns(5, 6, 7), 6)).toBe(1);
  });

  it("is 0 when the checkpoint covers the whole tail", () => {
    expect(countTailTurnsUncovered(turns(5, 6, 7), 7)).toBe(0);
  });

  it("is 0 for an empty tail", () => {
    expect(countTailTurnsUncovered([], null)).toBe(0);
  });
});

describe("didCheckpointAdvance", () => {
  it("is false when no new checkpoint was set", () => {
    expect(didCheckpointAdvance(null, null)).toBe(false);
    expect(didCheckpointAdvance(null, 4)).toBe(false);
  });

  it("is true for a first checkpoint", () => {
    expect(didCheckpointAdvance(0, null)).toBe(true);
  });

  it("is true only when strictly past the starting checkpoint", () => {
    expect(didCheckpointAdvance(5, 4)).toBe(true);
    expect(didCheckpointAdvance(4, 4)).toBe(false);
    expect(didCheckpointAdvance(3, 4)).toBe(false);
  });
});

describe("countWindowsFailed", () => {
  it("is 0 when nothing failed", () => {
    expect(countWindowsFailed(new Set(), 0)).toBe(0);
  });

  it("adds main-pass failures to user-pass failures (all failed)", () => {
    expect(countWindowsFailed(new Set([0, 1, 2]), 2)).toBe(5);
  });
});

describe("runCostUsd", () => {
  it("adds extraction and embedding spend", () => {
    expect(runCostUsd(0.25, 0.5)).toBe(0.75);
    expect(runCostUsd(0, 0)).toBe(0);
  });
});
