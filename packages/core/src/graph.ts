// Knowledge-graph types — mirrors migration 011, plus the 'Memory' node type
// added in migration 033 (ADR 0027 M1, issue #14).
// Zero runtime dependencies: plain TS types + const arrays + guards.

export const GRAPH_NODE_TYPES = [
  "User",
  "LifeArea",
  "Item",
  "Conversation",
  "Person",
  "Organization",
  "Tool",
  "Artifact",
  "PendingExtraction",
  "Memory",
] as const;

// ADR 0027 Q1: a Memory node's `kind` carries the four product categories.
// The kind is plain text with NO CHECK constraint (rider: the four kinds
// must be able to change freely) — so MEMORY_KINDS here, not a DB enum,
// is this taxonomy's source of truth.
// `insight` is the weakest of the four and is trivially removable: it is
// gated on the 50-memory eval (ADR 0027 §Q3 "Insight, honestly",
// open question 1) and should be dropped outright if it degenerates into
// conversation summaries rather than real self-articulated realisations.
export const MEMORY_KINDS = ["decision", "preference", "pattern", "insight"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export const GRAPH_EDGE_TYPES = [
  "contains",
  "contributes_to",
  "discusses",
  "mentions_person",
  "collaborates_with",
  "uses_tool",
  "is_about",
  "modifies",
  "depends_on",
  "reviews",
  "decides",
  "holds_stance",
  "relates_to",
] as const;

export const GRAPH_ACTOR_TYPES = ["llm", "user", "system"] as const;

export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];
export type GraphEdgeType = (typeof GRAPH_EDGE_TYPES)[number];
export type GraphActorType = (typeof GRAPH_ACTOR_TYPES)[number];

export interface GraphNode {
  id: string;
  user_id: string;
  type: GraphNodeType;
  kind: string | null;
  label: string;
  aliases: string[];
  props: Record<string, unknown>;
  status: string | null;
  confidence: number | null;
  embedding: number[] | null;
  created_by_actor: GraphActorType;
  created_by_model: string | null;
  last_modified_by: GraphActorType;
  locked_fields: string[];
  source_conversation_id: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface GraphEdge {
  id: string;
  user_id: string;
  src_id: string;
  dst_id: string;
  rel_type: GraphEdgeType;
  predicate: string | null;
  props: Record<string, unknown>;
  valid_at: string | null;
  invalid_at: string | null;
  expired_at: string | null;
  source_conversation_id: string | null;
  source_turn_idx: number | null;
  confidence: number | null;
  created_by_actor: GraphActorType;
  created_by_model: string | null;
  last_modified_by: GraphActorType;
  deleted_at: string | null;
  created_at: string;
}

export interface UserPortrait {
  user_id: string;
  version: number;
  generated_at: string;
  markdown_full: string | null;
  markdown_compact: string | null;
  json_full: unknown | null;
  portrait_dirty: boolean;
}

export function isGraphNodeType(x: unknown): x is GraphNodeType {
  return GRAPH_NODE_TYPES.includes(x as GraphNodeType);
}

export function isGraphEdgeType(x: unknown): x is GraphEdgeType {
  return GRAPH_EDGE_TYPES.includes(x as GraphEdgeType);
}
