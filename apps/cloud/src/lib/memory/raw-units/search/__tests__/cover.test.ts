// The cover test equals the lab's coverChunk; the pair index replaces its in-memory cosines (D4).
import { describe, expect, it } from "vitest";
import { addServed, buildCoverPairs, coverChunk, emptyServed, identifiers, vecCovered } from "../cover";
import { fx } from "./helpers";

describe("coverChunk equals the lab", () => {
  for (const c of fx.cover) {
    it(c.name, () => {
      const served = emptyServed();
      for (const t of c.served_texts) addServed(served, t, null);
      const got = coverChunk({ text: c.chunk }, c.vec_covered, served);
      expect(got).toEqual(c.expected);
    });
  }
  it("fixtures cover drop, shrink and keep-whole", () => {
    expect(fx.cover.some((c) => !c.expected.keep)).toBe(true);
    expect(fx.cover.some((c) => c.expected.keep && c.expected.shrunk)).toBe(true);
    expect(fx.cover.some((c) => c.expected.keep && c.expected.shrunk === false)).toBe(true);
  });
});

describe("identifiers", () => {
  it("digits, paths, snake_case, dotted names and camelCase count; plain words do not", () => {
    expect(
      [...identifiers("see pushWithRetry in src/sync/client.ts, retry_count and #12 plus plain words")].sort(),
    ).toEqual(["#12", "pushwithretry", "retry_count", "src/sync/client.ts"].sort());
  });
});

describe("cover pairs", () => {
  const rows = [
    {
      kind: "unit_unit" as const,
      a_id: "u1",
      b_id: "u2",
      cosine: 0.9,
      turn_idx: null,
      turn_text: null,
      code_session_id: null,
      turn_len: null,
    },
    {
      kind: "unit_record" as const,
      a_id: "u3",
      b_id: "r1",
      cosine: 0.88,
      turn_idx: null,
      turn_text: null,
      code_session_id: null,
      turn_len: null,
    },
    {
      kind: "neighbour" as const,
      a_id: "u1",
      b_id: "n1",
      cosine: null,
      turn_idx: 4,
      turn_text: "x",
      code_session_id: "s1",
      turn_len: 1,
    },
  ];
  it("unit_unit is symmetric, unit_record is one way, neighbours are not pairs", () => {
    const pairs = buildCoverPairs(rows);
    expect(pairs.get("u1")).toEqual(new Set(["u2"]));
    expect(pairs.get("u2")).toEqual(new Set(["u1"]));
    expect(pairs.get("u3")).toEqual(new Set(["r1"]));
    expect(pairs.has("n1")).toBe(false);
  });
  it("a unit is vector-covered only by a SERVED counterpart", () => {
    const pairs = buildCoverPairs(rows);
    const served = emptyServed();
    expect(vecCovered(pairs, "u3", served)).toBe(false);
    served.ids.add("r1");
    expect(vecCovered(pairs, "u3", served)).toBe(true);
    expect(vecCovered(pairs, "u1", served)).toBe(false);
    served.ids.add("u2");
    expect(vecCovered(pairs, "u1", served)).toBe(true);
  });
  it("a turn row is not a pair: a window whose pair row is kind turn is not covered by cosine", () => {
    const pairs = buildCoverPairs([
      {
        kind: "turn" as const,
        a_id: "w1",
        b_id: "t1",
        cosine: 0.95,
        turn_idx: 2,
        turn_text: "x",
        code_session_id: "s1",
        turn_len: 1,
      },
    ]);
    const served = emptyServed();
    served.ids.add("t1");
    expect(pairs.has("w1")).toBe(false);
    expect(vecCovered(pairs, "w1", served)).toBe(false);
  });
});
