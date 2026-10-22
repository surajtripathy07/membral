// G2 step 2.4b: the pure recurrence planners lifted out of write.ts. The
// Supabase reads and writes stay in write.ts; these pin the decisions made on
// already-fetched rows (cross-session dedup + recurrence band, the open-blocker
// offer, and the count plans).
import { describe, expect, it } from "vitest";
import { RECURRENCE_COSINE_THRESHOLD } from "@/lib/domain/recurrence";
import type { InsertableRecord } from "../insert";
import {
  type LiveRow,
  planCarriedRootCounts,
  planCrossSessionDedup,
  planFallbackCounts,
  planOpenBlockerOffers,
  toLiveRows,
} from "../recurrence";

function rec(over: Partial<InsertableRecord>): InsertableRecord {
  return {
    windowIndex: 0,
    kind: "blocker",
    text: "Build fails on a missing lockfile",
    quote: "npm ci fails: no lockfile",
    turn_idx: 1,
    turn_role: "assistant",
    ref: null,
    ref_kind: null,
    durable: true,
    thread: null,
    scope: "project",
    confidence: 0.9,
    verified: true,
    unverifiedReason: null,
    contentHash: "h1",
    paths: [],
    dangling: false,
    priority: false,
    embedding: null,
    ...over,
  };
}

/** A unit vector whose cosine with [1, 0] is exactly `c`. */
function at(c: number): number[] {
  return [c, Math.sqrt(1 - c * c)];
}

function live(over: Partial<LiveRow>): LiveRow {
  return { id: "L1", norm: "something else", embedding: [0, 1], createdAt: "2026-09-01", recursOf: null, ...over };
}

describe("planCrossSessionDedup", () => {
  it("drops an exact-text echo of a live row from another session", () => {
    const r = rec({ text: "Build fails on a missing lockfile." });
    const rows = new Map([["blocker", [live({ norm: "build fails on a missing lockfile" })]]]);
    const plan = planCrossSessionDedup([r], rows, new Set(["L1"]));
    expect(plan.kept).toEqual([]);
    expect(plan.deduped).toBe(1);
    expect(plan.notes[0]).toMatchObject({ fields: { kind: "blocker", existing_id: "L1" } });
  });

  it("keeps a blocker in the recurrence band with recursOf = the match (below the band: plain keep)", () => {
    const inBand = rec({ embedding: [1, 0] });
    const rows = new Map([["blocker", [live({ embedding: at(RECURRENCE_COSINE_THRESHOLD + 0.05) })]]]);
    const plan = planCrossSessionDedup([inBand], rows, new Set(["L1"]));
    expect(plan.kept).toEqual([{ ...inBand, recursOf: "L1" }]);
    expect(plan.recurrences).toBe(1);

    const below = new Map([["blocker", [live({ embedding: at(RECURRENCE_COSINE_THRESHOLD - 0.05) })]]]);
    const plain = planCrossSessionDedup([inBand], below, new Set(["L1"]));
    expect(plain.kept).toEqual([inBand]);
    expect(plain.recurrences).toBe(0);
  });

  it("never links a kind outside RECURRENCE_KINDS", () => {
    const r = rec({ kind: "learning", embedding: [1, 0] });
    const rows = new Map([["learning", [live({ embedding: at(0.9) })]]]);
    const plan = planCrossSessionDedup([r], rows, new Set(["L1"]));
    expect(plan.kept).toEqual([r]);
    expect(plan.recurrences).toBe(0);
  });

  it("counts a chain once per session: live root taken, second distinct text uncounted, same text dropped", () => {
    const rows = new Map([["blocker", [live({ id: "L2", recursOf: "L1", embedding: at(0.85) })]]]);
    const a = rec({ contentHash: "a", text: "first wall", embedding: [1, 0] });
    const b = rec({ contentHash: "b", text: "second wall", embedding: [1, 0] });
    const c = rec({ contentHash: "c", text: "first wall", embedding: [1, 0] });
    const plan = planCrossSessionDedup([a, b, c], rows, new Set(["L1", "L2"]));
    expect(plan.kept).toEqual([
      { ...a, recursOf: "L1" },
      { ...b, recursOf: "L1", countsRecurrence: false },
    ]);
    expect(plan.recurrences).toBe(1);
    expect(plan.deduped).toBe(1);
    // A retired root (not in liveIds): the match itself takes the count.
    const retiredRoot = planCrossSessionDedup([a], rows, new Set(["L2"]));
    expect(retiredRoot.kept).toEqual([{ ...a, recursOf: "L2" }]);
  });

  it("follows the extraction call's recursOfHint at any cosine; retired-headed rows pass through", () => {
    const rows = new Map([["blocker", [live({ id: "L9" })]]]);
    const hinted = rec({ recursOfHint: "L9" });
    const retired = rec({ contentHash: "r", retireReason: "x", text: "something else" });
    const plan = planCrossSessionDedup([hinted, retired], rows, new Set(["L9"]));
    expect(plan.kept).toEqual([{ ...hinted, recursOf: "L9" }, retired]);
  });
});

describe("toLiveRows", () => {
  it("excludes this session's rows but reports every id as live", () => {
    const out = toLiveRows(
      [
        { id: "a", code_session_id: "s1", text: "A.", embedding: null, created_at: "t1", recurs_of: null },
        { id: "b", code_session_id: "s2", text: "B!", embedding: "[1,0]", created_at: null },
      ],
      "s1",
    );
    expect(out.ids).toEqual(["a", "b"]);
    expect(out.rows).toEqual([{ id: "b", norm: "b", embedding: [1, 0], createdAt: "", recursOf: null }]);
  });
});

describe("planOpenBlockerOffers", () => {
  it("one offer per chain, most-recurring first, own-session-only chains dropped, capped", () => {
    const offers = planOpenBlockerOffers(
      [
        { id: "x2", code_session_id: "s2", text: "x newer", created_at: "2026-09-03", recurs_of: "x1" },
        { id: "y1", code_session_id: "s3", text: "y", created_at: "2026-09-04", recurrence_count: 1 },
        { id: "x1", code_session_id: "s2", text: "x old", created_at: "2026-09-01", recurrence_count: 3 },
        { id: "own", code_session_id: "s1", text: "mine", created_at: "2026-09-05" },
      ],
      "s1",
      5,
    );
    expect(offers).toEqual([
      { id: "x1", text: "x newer" },
      { id: "y1", text: "y" },
    ]);
    expect(planOpenBlockerOffers([], "s1", 5)).toEqual([]);
  });
});

describe("count plans", () => {
  it("carries a retired old root's count only when larger; fallback adds the increment to a default of 1", () => {
    expect(
      planCarriedRootCounts(
        [
          { id: "n1", recurs_of: "o1", recurrence_count: 1 },
          { id: "n2", recurs_of: "o2", recurrence_count: 5 },
          { id: "n3", recurs_of: "gone", recurrence_count: null },
        ],
        [
          { id: "o1", recurrence_count: 3 },
          { id: "o2", recurrence_count: 4 },
        ],
      ),
    ).toEqual([{ id: "n1", count: 3 }]);
    expect(
      planFallbackCounts(
        [
          { id: "a", recurrence_count: 2 },
          { id: "b", recurrence_count: null },
        ],
        new Map([
          ["a", 1],
          ["b", 2],
        ]),
      ),
    ).toEqual([
      { id: "a", count: 3 },
      { id: "b", count: 3 },
    ]);
  });
});
