import { describe, expect, it } from "vitest";
import { cosineSimilarity as contentMatchCosine } from "@/lib/code-sessions/content-match";
import { cosineSimilarity as embedCosine } from "@/lib/memory/embed";
import * as writeModule from "@/lib/memory/write";
import {
  cosineSimilarityMutable,
  cosineSimilarityReadonly,
  DEFAULT_SEMANTIC_DEDUP_MIN_SIM,
  IN_BATCH_DEDUP_COSINE_THRESHOLD,
  SUPERSEDE_COSINE_THRESHOLD,
} from "../similarity";

// Expected values computed by hand from the two bodies, not by running them.
const CASES: Array<{ name: string; a: number[]; b: number[]; want: number }> = [
  { name: "identical unit", a: [1, 0], b: [1, 0], want: 1 },
  { name: "orthogonal", a: [1, 0], b: [0, 1], want: 0 },
  { name: "parallel, scaled", a: [1, 2], b: [2, 4], want: 1 },
  { name: "3-4-5", a: [3, 4], b: [4, 3], want: 24 / 25 },
  { name: "opposite", a: [1, 0], b: [-1, 0], want: -1 },
  { name: "zero norm a", a: [0, 0], b: [1, 1], want: 0 },
  { name: "length mismatch", a: [1], b: [1, 2], want: 0 },
  { name: "both empty", a: [], b: [], want: 0 },
  { name: "empty a", a: [], b: [1], want: 0 },
  // The only input the extra `b.length === 0` guard in the readonly variant
  // could distinguish; the mutable variant reaches 0 via the length check.
  { name: "empty b", a: [1], b: [], want: 0 },
];

describe("domain/similarity (G2 2.2e)", () => {
  it("pins every threshold", () => {
    expect(SUPERSEDE_COSINE_THRESHOLD).toBe(0.9);
    expect(DEFAULT_SEMANTIC_DEDUP_MIN_SIM).toBe(0.8);
    expect(IN_BATCH_DEDUP_COSINE_THRESHOLD).toBe(0.93);
    expect(writeModule.DEFAULT_SEMANTIC_DEDUP_MIN_SIM).toBe(DEFAULT_SEMANTIC_DEDUP_MIN_SIM);
  });

  it.each(CASES)("cosineSimilarityReadonly: $name", ({ a, b, want }) => {
    expect(cosineSimilarityReadonly(a, b)).toBeCloseTo(want, 12);
  });

  it.each(CASES)("cosineSimilarityMutable: $name", ({ a, b, want }) => {
    expect(cosineSimilarityMutable(a, b)).toBeCloseTo(want, 12);
  });

  it("old owners re-export their own variant under the old name", () => {
    expect(contentMatchCosine).toBe(cosineSimilarityReadonly);
    expect(embedCosine).toBe(cosineSimilarityMutable);
  });
});
