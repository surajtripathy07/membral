// G2 step 2.4d: the pure supersede planner lifted out of write.ts's
// supersedeRecords. The per-kind read and the link/retire writes stay in
// write.ts; these pin the decisions made on the already-fetched live rows.
import { describe, expect, it } from "vitest";
import { SUPERSEDE_COSINE_THRESHOLD } from "@/lib/domain/similarity";
import { groupSupersedeByKind, planSupersede, type SupersedeLiveRow } from "../supersede";

/** A unit vector at cosine `sim` to [1, 0]. */
function atSim(sim: number): number[] {
  return [sim, Math.sqrt(1 - sim * sim)];
}

describe("groupSupersedeByKind", () => {
  it("groups by kind in first-seen order and nulls empty embeddings", () => {
    const byKind = groupSupersedeByKind([
      { id: "a", kind: "blocker", text: "A", embedding: [1, 0] },
      { id: "b", kind: "decision", text: "B", embedding: [] },
      { id: "c", kind: "blocker", text: "C", embedding: null },
    ]);
    expect([...byKind.keys()]).toEqual(["blocker", "decision"]);
    expect(byKind.get("blocker")).toEqual([
      { id: "a", text: "A", embedding: [1, 0] },
      { id: "c", text: "C", embedding: null },
    ]);
    expect(byKind.get("decision")).toEqual([{ id: "b", text: "B", embedding: null }]);
  });
});

describe("planSupersede", () => {
  it("links and retires an exact normalized-text duplicate, even without an embedding", () => {
    const plan = planSupersede(
      [{ id: "new", text: "Missing the service role key blocks the migration.", embedding: null }],
      [{ id: "old", text: "missing  the service role key blocks the migration", embedding: null }],
    );
    expect(plan).toEqual({ links: [{ id: "new", supersedes: "old" }], retireIds: ["old"] });
  });

  it("links (never retires) the best paraphrase at or above the threshold", () => {
    const rows: SupersedeLiveRow[] = [
      { id: "near", text: "p1", embedding: atSim(SUPERSEDE_COSINE_THRESHOLD) },
      { id: "nearer", text: "p2", embedding: atSim(0.97) },
      { id: "far", text: "p3", embedding: atSim(0.5) },
    ];
    const plan = planSupersede([{ id: "new", text: "fresh", embedding: [1, 0] }], rows);
    expect(plan).toEqual({ links: [{ id: "new", supersedes: "nearer" }], retireIds: [] });
  });

  it("links nothing below the threshold", () => {
    const plan = planSupersede(
      [{ id: "new", text: "fresh", embedding: [1, 0] }],
      [{ id: "old", text: "other", embedding: atSim(SUPERSEDE_COSINE_THRESHOLD - 0.01) }],
    );
    expect(plan).toEqual({ links: [], retireIds: [] });
  });

  it("parses stored vector strings and skips rows without an embedding", () => {
    const plan = planSupersede(
      [{ id: "new", text: "fresh", embedding: [1, 0] }],
      [
        { id: "empty", text: "x", embedding: null },
        { id: "str", text: "y", embedding: "[1,0]" },
      ],
    );
    expect(plan.links).toEqual([{ id: "new", supersedes: "str" }]);
  });

  it("ignores live rows that are this run's own new records", () => {
    const plan = planSupersede(
      [
        { id: "n1", text: "Same fact", embedding: [1, 0] },
        { id: "n2", text: "same fact", embedding: [1, 0] },
      ],
      [
        { id: "n1", text: "Same fact", embedding: [1, 0] },
        { id: "n2", text: "same fact", embedding: [1, 0] },
      ],
    );
    expect(plan).toEqual({ links: [], retireIds: [] });
  });

  it("links every new record in order and retires a shared duplicate once", () => {
    const plan = planSupersede(
      [
        { id: "n1", text: "Build fails", embedding: null },
        { id: "n2", text: "build fails.", embedding: null },
        { id: "n3", text: "unrelated", embedding: null },
      ],
      [{ id: "old", text: "Build fails", embedding: null }],
    );
    expect(plan).toEqual({
      links: [
        { id: "n1", supersedes: "old" },
        { id: "n2", supersedes: "old" },
      ],
      retireIds: ["old"],
    });
  });

  it("plans nothing with no live candidates", () => {
    expect(planSupersede([{ id: "new", text: "t", embedding: [1, 0] }], [])).toEqual({ links: [], retireIds: [] });
  });
});
