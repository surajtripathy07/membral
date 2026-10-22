// The Memory repository (G3 step 3B-7a): the direct `memories` chains that
// lived in app/** moved here verbatim — same table, select string, filters
// in the same order, order/limit and optional filters. Every function
// returns the PostgREST `{ data, error }` result the call site used to
// destructure, so each site keeps its own error handling exactly as before.

import type { MemoryInsert, MemoryRow } from "@/lib/database.types";
import type { Db } from "@/lib/db/types";

type DbError = { message: string };

/** /api/memories GET: the caller's memories, most confident first, capped at
 * `limit`, with the same optional type / min-confidence / content-search
 * filters the route already validated (null means "no filter"), in the same
 * order as before (type, then min_confidence, then q). */
export async function listMemoriesByConfidence(
  supabase: Db,
  userId: string,
  limit: number,
  type: string | null = null,
  minConfidence: number | null = null,
  search: string | null = null,
): Promise<{ data: MemoryRow[] | null; error: DbError | null }> {
  let query = supabase
    .from("memories")
    .select("*")
    .eq("user_id", userId)
    .order("confidence", { ascending: false })
    .limit(limit);

  if (type) {
    query = query.eq("type", type);
  }
  if (minConfidence !== null) {
    query = query.gte("confidence", minConfidence);
  }
  if (search) {
    query = query.ilike("content", `%${search}%`);
  }

  const { data, error } = await query;
  return { data, error };
}

/** /api/memories POST: bulk-insert the validated rows, returning them back
 * (insert...select, same as before — no separate read). */
export async function insertMemories(
  supabase: Db,
  rows: MemoryInsert[],
): Promise<{ data: MemoryRow[] | null; error: DbError | null }> {
  const { data, error } = await supabase.from("memories").insert(rows).select();
  return { data, error };
}

/** /conversations/[id]: memories that reference this conversation. */
export async function listMemoriesForConversation(
  supabase: Db,
  userId: string,
  conversationId: string,
): Promise<{ data: MemoryRow[] | null; error: DbError | null }> {
  const { data, error } = await supabase
    .from("memories")
    .select("*")
    .eq("user_id", userId)
    .contains("source_conversation_ids", [conversationId]);
  return { data, error };
}
