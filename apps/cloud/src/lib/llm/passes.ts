// LLM pass names and cost records, moved from lib/kg/types.ts (refactor
// programme step 1.1). lib/kg/types.ts re-exports these names.

// ------------------------------------------------------------------
// Cost accounting
// ------------------------------------------------------------------

export type PassName =
  | "pass1" // per-conversation classify + summary + central_topic
  | "pass1_chunk" // Tier-2 map-reduce: per-chunk factual summary for oversized conversations
  | "embed" // conversation-summary embedding for Stage A clustering
  | "stage_a_name" // per-tree-node naming + top-level coherence gate
  | "stage_a_consolidate" // group top blocks into LifeAreas
  | "stage_b_attach" // per-conversation entity extraction + umbrella attach
  | "code_session_summary" // per-code-session "what was done" summary, user-spine-weighted (ADR 0021 Q5)
  | "code_session_title" // migration 110: 3-8 word short title per code session (lib/code-sessions/short-title.ts backfill)
  | "code_project_rollup" // per-CodeProject batch: one call covering all of that project's session summaries (ADR 0021 Q5)
  | "conversation_embedding" // ingest-time embedding of a stored conversation (lib/embeddings.ts, issue #92)
  | "query_embedding" // query-time embedding of a search/MCP topic string (lib/embeddings.ts, issue #92)
  | "chunk_embedding" // ingest-time embedding of a conversation_chunks row (lib/conversation-chunks.ts, goal 2026-07-26 step 11 / #39)
  | "pass1b_code" // ADR 0042 §8: the code lane's second, small call — accepted proposals + blockers, over structural fragments only
  | "g3_retry" // issue #98: bounded one-shot re-ask for an owner-turn quote after a G3 assistant-voice-quote rejection
  | "claims_verify" // ADR 0030 D4 rule 5 / D5, goal step 12b: batched entailment check of an accepted extraction claim against its own receipt
  | "memory_backfill" // memory v1 §8.2 (#151): source C's per-window extraction chat call (lib/memory/extract.ts)
  | "session_assoc" // D-057: one call per candidate session linking build segments to issues/PRs (lib/memory/session-association.ts)
  | "memory_embedding"; // memory v1 §8.2 (#151): source C's record/query embedding calls (lib/memory/embed.ts)

export interface CostRecord {
  /** Conversation UUID, or a synthetic key for corpus-level calls (e.g. "stage_a_name:<treeNodeId>"). */
  conversation_id: string;
  pass: PassName;
  model: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  latency_ms: number;
}
