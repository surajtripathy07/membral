import { getServiceClient } from "@/lib/db/clients";
import { generateEmbedding } from "@/lib/embeddings";
import { chatVectorPlan } from "@/lib/llm/embedding-family";

/**
 * ADR 0039 (W6/D7 follow-up) — 'chat' excludes source='claude-code'
 * (code-lane) conversations from every search path below, matching the
 * conversations list's own `lane=all|chat|code` toggle; 'code' flips to ONLY
 * code sessions; 'all' mixes both lanes. Default is 'all' (goal 2026-08-27
 * D6 fix, migration 071 rev-2 / #106 — consistent with /memories defaulting
 * to All under ADR 0039's ratification; a one-line default the maintainer
 * can reverse).
 */
export type SearchLane = "all" | "chat" | "code";

export interface SearchOptions {
  query: string;
  mode?: "hybrid" | "keyword" | "semantic";
  limit?: number;
  lane?: SearchLane;
}

export interface SearchResult {
  id: string;
  source: string;
  title: string;
  created_at: string | null;
  summary: string | null;
  similarity: number | null;
}

function mapRow(row: Record<string, unknown>): SearchResult {
  return {
    id: row.id as string,
    source: row.source as string,
    title: row.title as string,
    created_at: (row.created_at as string) ?? null,
    summary: (row.summary as string) ?? null,
    similarity: (row.similarity as number) ?? null,
  };
}

/**
 * goal 2026-08-27 D6 / #106 (migration 071 rev-2, adversarial round 1
 * F1+F2): the vector RPC now takes `p_lane` directly and applies it in its
 * WHERE clause BEFORE the LIMIT, so lane filtering can never under-fill a
 * page the way post-hoc TS filtering did (measured: chat-lane "down
 * payment" came back with only 7 of 10 requested rows under the old
 * post-limit filter). Used for BOTH the hybrid/semantic path and the
 * keyword-mode / fallback path below — search_conversations has exactly one
 * caller in this codebase (confirmed by grep during the migration's
 * adversarial review), so there is no risk of drifting another call site.
 */
async function callSearchRpc(
  supabase: ReturnType<typeof getServiceClient>,
  userId: string,
  query: string,
  embeddingStr: string | null,
  limit: number,
  lane: SearchLane,
  familyArgs: { p_embedding_model?: string; p_min_similarity?: number } = {},
): Promise<SearchResult[]> {
  const { data, error } = await supabase.rpc("search_conversations", {
    query_text: query,
    query_embedding: embeddingStr,
    match_count: limit,
    search_user_id: userId,
    p_lane: lane,
    ...familyArgs,
  });

  if (error) {
    throw new Error(`Search failed: ${error.message}`);
  }

  return (data || []).map(mapRow);
}

/**
 * Keyword-only / fallback search. goal 2026-08-27 D6 (#106, adversarial
 * round 1 §4): previously ordered by `created_at desc` via a direct
 * `.textSearch()` query — recency, not relevance, so a keyword query with
 * more true matches than `limit` silently dropped the most RELEVANT ones in
 * favor of the most RECENT (measured against D6 truth: 0/10 on "down
 * payment", 1/10 on "routines"). This path is reached not just for explicit
 * `mode=keyword` but also on ANY embedding failure — including the issue
 * #92 monthly cost ceiling, which has its own regression test — so a demo
 * that trips the ceiling mid-session was silently degrading D6 to
 * near-zero recall with no visible signal.
 *
 * Fixed by calling the SAME search_conversations RPC with
 * `query_embedding: null` — this collapses the RPC's own fts_hit-dominant
 * ordering (migration 071 rev-2) to the FTS leg alone, which IS the D6
 * truth query's own `ts_rank` ordering (verified 10/10, 10/10, 9/9, 10/10
 * against the founder corpus — see scratchpad/W2_diagnosis.md). Still
 * "never throws": any RPC error here propagates to the caller's own
 * try/catch (searchConversations doesn't wrap this call), matching the
 * pre-existing contract that a hard failure here is a real 500, not a
 * silent empty result — unchanged from before this fix.
 */
async function keywordSearch(
  supabase: ReturnType<typeof getServiceClient>,
  userId: string,
  query: string,
  limit: number,
  lane: SearchLane,
): Promise<SearchResult[]> {
  return callSearchRpc(supabase, userId, query, null, limit, lane);
}

export async function searchConversations(userId: string, options: SearchOptions): Promise<SearchResult[]> {
  const { query, mode = "hybrid", limit = 10, lane = "all" } = options;
  const supabase = getServiceClient();

  if (mode === "keyword") {
    return keywordSearch(supabase, userId, query, limit, lane);
  }
  // D-072 / migration 139: the default family and a family with chat floors use the vector leg
  // (the latter with its family filter and cut); any other family runs keyword-only.
  const plan = chatVectorPlan();
  if (!plan.allowed) {
    return keywordSearch(supabase, userId, query, limit, lane);
  }

  // Hybrid / semantic: try embedding-based search; fall back to keyword when
  // the embedding provider is unavailable (no API key, quota exceeded, the
  // embeddings feature flag off, etc.). skipCeiling: a query embed costs
  // ~$0.000003, so the monthly ceiling (meant for bulk spend) never blocks it.
  let embedding: number[];
  try {
    embedding = await generateEmbedding(query, { userId, pass: "query_embedding", skipCeiling: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[search] embedding failed (${msg}); falling back to keyword search`);
    return keywordSearch(supabase, userId, query, limit, lane);
  }

  const embeddingStr = `[${embedding.join(",")}]`;

  try {
    return await callSearchRpc(
      supabase,
      userId,
      mode === "semantic" ? "" : query,
      embeddingStr,
      limit,
      lane,
      plan.rpcArgs,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[search] vector RPC failed (${msg}); falling back to keyword search`);
    return keywordSearch(supabase, userId, query, limit, lane);
  }
}
