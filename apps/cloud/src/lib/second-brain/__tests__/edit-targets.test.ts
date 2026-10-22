import { describe, expect, it } from "vitest";
import {
  descendantsAndSelf,
  filterByQuery,
  mergeTargets,
  moveTargets,
  type PickerNode,
  TOP_LEVEL_TARGET_ID,
} from "@/lib/second-brain/edit-targets";

// A small tree:
//   area-A (LifeArea)
//     └─ item-1 (Item)
//          └─ item-2 (Item)
//   area-B (LifeArea)
//     └─ item-3 (Item)
const NODES: PickerNode[] = [
  { id: "area-A", label: "Work", type: "LifeArea", kind: null, parent_id: null },
  { id: "area-B", label: "Health", type: "LifeArea", kind: null, parent_id: null },
  { id: "item-1", label: "Booster", type: "Item", kind: "project", parent_id: "area-A" },
  { id: "item-2", label: "Catch arms", type: "Item", kind: "project", parent_id: "item-1" },
  { id: "item-3", label: "Marathon", type: "Item", kind: "goal", parent_id: "area-B" },
];

describe("descendantsAndSelf", () => {
  it("includes the node and its whole subtree", () => {
    expect(descendantsAndSelf(NODES, "item-1")).toEqual(new Set(["item-1", "item-2"]));
    expect(descendantsAndSelf(NODES, "area-A")).toEqual(new Set(["area-A", "item-1", "item-2"]));
  });
  it("is just the node itself for a leaf", () => {
    expect(descendantsAndSelf(NODES, "item-2")).toEqual(new Set(["item-2"]));
  });
  it("terminates on cyclic dirty data", () => {
    const cyclic: PickerNode[] = [
      { id: "x", label: "x", type: "Item", kind: null, parent_id: "y" },
      { id: "y", label: "y", type: "Item", kind: null, parent_id: "x" },
    ];
    expect(descendantsAndSelf(cyclic, "x")).toEqual(new Set(["x", "y"]));
  });
});

describe("moveTargets", () => {
  it("excludes the node and its descendants (cannot move under own child)", () => {
    const ids = moveTargets(NODES, "item-1").map((n) => n.id);
    expect(ids).not.toContain("item-1");
    expect(ids).not.toContain("item-2");
    expect(ids).toEqual(expect.arrayContaining(["area-A", "area-B", "item-3"]));
  });
  it("an area can move under anything outside its subtree", () => {
    const ids = moveTargets(NODES, "area-A").map((n) => n.id);
    expect(ids).toEqual(expect.arrayContaining(["area-B", "item-3"]));
    expect(ids).not.toContain("area-A");
    expect(ids).not.toContain("item-1");
  });

  // Handoff 0024 directive B item 1 / issue #60 — promote a sub-bucket to a
  // top-level life area via a synthetic "Top level" picker row.
  describe("Top level destination (handoff 0024 directive B / issue #60)", () => {
    it("offers Top level for a nested node (has a live parent)", () => {
      const targets = moveTargets(NODES, "item-1"); // item-1's parent is area-A
      expect(targets.map((n) => n.id)).toContain(TOP_LEVEL_TARGET_ID);
      const row = targets.find((n) => n.id === TOP_LEVEL_TARGET_ID);
      expect(row?.label).toBe("Top level");
      expect(row?.parent_id).toBeNull();
    });

    it("puts Top level first in the returned list", () => {
      const targets = moveTargets(NODES, "item-2");
      expect(targets[0]?.id).toBe(TOP_LEVEL_TARGET_ID);
    });

    it("does NOT offer Top level for a node that is already top-level", () => {
      const targets = moveTargets(NODES, "area-A"); // area-A has parent_id: null
      expect(targets.map((n) => n.id)).not.toContain(TOP_LEVEL_TARGET_ID);
    });

    it("does NOT offer Top level for a node absent from the edit-targets set", () => {
      // e.g. an entity node (Person/Tool/…) the edit-targets read never includes.
      const targets = moveTargets(NODES, "not-in-set");
      expect(targets.map((n) => n.id)).not.toContain(TOP_LEVEL_TARGET_ID);
    });
  });
});

describe("mergeTargets", () => {
  it("keeps only same-class nodes and excludes self", () => {
    const itemIds = mergeTargets(NODES, "item-1", "Item").map((n) => n.id);
    expect(itemIds).toEqual(expect.arrayContaining(["item-2", "item-3"]));
    expect(itemIds).not.toContain("item-1");
    expect(itemIds).not.toContain("area-A"); // different class

    const areaIds = mergeTargets(NODES, "area-A", "LifeArea").map((n) => n.id);
    expect(areaIds).toEqual(["area-B"]);
  });
  it("allows merging into a descendant (unlike move)", () => {
    const ids = mergeTargets(NODES, "item-1", "Item").map((n) => n.id);
    expect(ids).toContain("item-2"); // item-2 is item-1's child, still a valid merge target
  });
});

describe("filterByQuery", () => {
  it("is case-insensitive substring match on label", () => {
    expect(filterByQuery(NODES, "mara").map((n) => n.id)).toEqual(["item-3"]);
    expect(filterByQuery(NODES, "  ").map((n) => n.id)).toEqual(NODES.map((n) => n.id));
  });
});
