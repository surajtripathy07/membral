import { describe, expect, it } from "vitest";
import {
  GRAPH_ACTOR_TYPES,
  GRAPH_EDGE_TYPES,
  GRAPH_NODE_TYPES,
  isGraphEdgeType,
  isGraphNodeType,
  MEMORY_KINDS,
} from "../graph.js";

describe("GRAPH_NODE_TYPES", () => {
  it("has exactly 10 members", () => {
    expect(GRAPH_NODE_TYPES).toHaveLength(10);
  });

  it("contains all expected node types", () => {
    expect(GRAPH_NODE_TYPES).toContain("User");
    expect(GRAPH_NODE_TYPES).toContain("LifeArea");
    expect(GRAPH_NODE_TYPES).toContain("Item");
    expect(GRAPH_NODE_TYPES).toContain("Conversation");
    expect(GRAPH_NODE_TYPES).toContain("Person");
    expect(GRAPH_NODE_TYPES).toContain("Organization");
    expect(GRAPH_NODE_TYPES).toContain("Tool");
    expect(GRAPH_NODE_TYPES).toContain("Artifact");
    expect(GRAPH_NODE_TYPES).toContain("PendingExtraction");
    expect(GRAPH_NODE_TYPES).toContain("Memory");
  });
});

describe("MEMORY_KINDS", () => {
  it("has exactly 4 members", () => {
    expect(MEMORY_KINDS).toHaveLength(4);
  });

  it("contains the exact expected kind strings", () => {
    expect(MEMORY_KINDS).toContain("decision");
    expect(MEMORY_KINDS).toContain("preference");
    expect(MEMORY_KINDS).toContain("pattern");
    expect(MEMORY_KINDS).toContain("insight");
  });
});

describe("GRAPH_EDGE_TYPES", () => {
  it("has exactly 13 members", () => {
    expect(GRAPH_EDGE_TYPES).toHaveLength(13);
  });

  it("contains all expected edge types", () => {
    expect(GRAPH_EDGE_TYPES).toContain("contains");
    expect(GRAPH_EDGE_TYPES).toContain("contributes_to");
    expect(GRAPH_EDGE_TYPES).toContain("discusses");
    expect(GRAPH_EDGE_TYPES).toContain("mentions_person");
    expect(GRAPH_EDGE_TYPES).toContain("collaborates_with");
    expect(GRAPH_EDGE_TYPES).toContain("uses_tool");
    expect(GRAPH_EDGE_TYPES).toContain("is_about");
    expect(GRAPH_EDGE_TYPES).toContain("modifies");
    expect(GRAPH_EDGE_TYPES).toContain("depends_on");
    expect(GRAPH_EDGE_TYPES).toContain("reviews");
    expect(GRAPH_EDGE_TYPES).toContain("decides");
    expect(GRAPH_EDGE_TYPES).toContain("holds_stance");
    expect(GRAPH_EDGE_TYPES).toContain("relates_to");
  });
});

describe("GRAPH_ACTOR_TYPES", () => {
  it("has exactly 3 members", () => {
    expect(GRAPH_ACTOR_TYPES).toHaveLength(3);
  });

  it("contains all expected actor types", () => {
    expect(GRAPH_ACTOR_TYPES).toContain("llm");
    expect(GRAPH_ACTOR_TYPES).toContain("user");
    expect(GRAPH_ACTOR_TYPES).toContain("system");
  });
});

describe("isGraphNodeType", () => {
  it("accepts all valid node types", () => {
    for (const t of GRAPH_NODE_TYPES) {
      expect(isGraphNodeType(t)).toBe(true);
    }
  });

  it("rejects invalid values", () => {
    expect(isGraphNodeType("Unknown")).toBe(false);
    expect(isGraphNodeType("user")).toBe(false); // lowercase — not a valid type
    expect(isGraphNodeType("")).toBe(false);
    expect(isGraphNodeType(null)).toBe(false);
    expect(isGraphNodeType(undefined)).toBe(false);
    expect(isGraphNodeType(42)).toBe(false);
  });
});

describe("isGraphEdgeType", () => {
  it("accepts all valid edge types", () => {
    for (const t of GRAPH_EDGE_TYPES) {
      expect(isGraphEdgeType(t)).toBe(true);
    }
  });

  it("rejects invalid values", () => {
    expect(isGraphEdgeType("linked_to")).toBe(false);
    expect(isGraphEdgeType("Contains")).toBe(false); // capitalised — not valid
    expect(isGraphEdgeType("")).toBe(false);
    expect(isGraphEdgeType(null)).toBe(false);
    expect(isGraphEdgeType(undefined)).toBe(false);
    expect(isGraphEdgeType(0)).toBe(false);
  });
});
