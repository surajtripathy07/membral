// Floors, trigger and gating equal the lab's (fixtures: lab-fixtures.json from the lab's own ranker).
import { describe, expect, it } from "vitest";
import { chunksAbstain, gatePools, passesFloor, strongHit, triggered } from "../floors";
import type { RawCandidate } from "../types";
import { fx } from "./helpers";

describe("passesFloor equals the lab", () => {
  it(`${fx.floors.length} similarity x lexical-evidence cases`, () => {
    for (const c of fx.floors) expect(passesFloor(c.row, c.cuts), JSON.stringify(c)).toBe(c.expected);
  });
  it("covers both outcomes", () => {
    expect(new Set(fx.floors.map((c) => c.expected))).toEqual(new Set([true, false]));
  });
});

describe("triggered equals the lab", () => {
  it("anchors, few records, weak top record, null similarity", () => {
    for (const c of fx.triggers)
      expect(triggered(c.records, c.anchor_count, fx.cuts), JSON.stringify(c)).toBe(c.expected);
  });
});

describe("strongHit", () => {
  const anchors = [
    { kind: "path" as const, value: "src/sync/client.ts" },
    { kind: "code" as const, value: "retry" },
  ];
  it("matches a path or ref anchor case-insensitively, never a code anchor", () => {
    expect(strongHit("see SRC/sync/Client.ts line 4", anchors)).toBe(true);
    expect(strongHit("retry only", anchors)).toBe(false);
  });
});

const cand = (similarity: number | null, text = "t"): RawCandidate => ({
  id: "x",
  id8: "aaaaaaaa",
  unit: "c700",
  turn_idx: 0,
  turn_from: 0,
  turn_to: 0,
  parts: null,
  win: null,
  text,
  full_text: null,
  similarity,
  lex_hits: 0,
  query_lexemes: 0,
  session_time_iso: null,
});

describe("chunksAbstain (floor-abstain)", () => {
  const cuts = { chunk_abstain: 0.689 };
  it("a served card lifts the gate", () => {
    expect(chunksAbstain(1, [cand(0.1)], [], cuts)).toBe(false);
  });
  it("no card: abstains below p99, serves at it, or when the text names an anchor", () => {
    expect(chunksAbstain(0, [cand(0.688)], [], cuts)).toBe(true);
    expect(chunksAbstain(0, [cand(0.689)], [], cuts)).toBe(false);
    expect(chunksAbstain(0, [cand(null)], [], cuts)).toBe(true);
    expect(chunksAbstain(0, [cand(0.1, "in src/a/b.ts")], [{ kind: "path", value: "src/a/b.ts" }], cuts)).toBe(false);
    expect(chunksAbstain(0, [], [], cuts)).toBe(true);
  });
});

describe("gatePools equals the lab's gated lists", () => {
  for (const w of fx.walks) {
    it(w.name, () => {
      const g = gatePools({
        pools: w.pools,
        records: w.records,
        cardCount: w.card_count,
        anchors: w.anchors,
        cuts: w.cuts,
      });
      expect({ r1: g.r1.map((c) => c.id), r2: g.r2.map((c) => c.id), r3: g.r3.map((c) => c.id) }).toEqual(
        w.expected.gated,
      );
    });
  }
  it("the walks include an R1 abstain with R2/R3 serving, and a nothing-passes case", () => {
    const abstain = fx.walks.find((w) => w.name === "r1-abstains-r23-serve");
    expect(abstain?.expected.gated.r1).toEqual([]);
    expect(abstain?.expected.gated.r2.length).toBeGreaterThan(0);
    const none = fx.walks.find((w) => w.name === "nothing-passes");
    expect(none?.expected.gated).toEqual({ r1: [], r2: [], r3: [] });
  });
});
