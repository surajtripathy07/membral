// The Conversation repository (G3 step 3B-6b): the direct `conversations`
// chains that lived in app/** moved here verbatim — same table, select
// string, filters in the same order, order/limit/range and single /
// maybeSingle, same upsert payload and options. Every function returns the
// PostgREST `{ data, error }` (or `{ error }`) result the call site used to
// destructure, so each site keeps its own error handling (500, empty
// fallback, throw) exactly as before. Pagers stay at the call site: each
// site's loop, page size and error mapping are part of its behaviour.

import type { TablesInsert } from "@/lib/database.generated";
import type { ConversationInsert } from "@/lib/database.types";
import type { TypedDb } from "@/lib/db/types";

type DbError = { message: string };

/** /api/health: HEAD count against `conversations` — reachability only. */
export async function pingConversations(supabase: TypedDb): Promise<{ error: DbError | null }> {
  const { error } = await supabase.from("conversations").select("id", { head: true, count: "exact" });
  return { error };
}

/** /api/sync-state: the newest `updated_at` for one chat source plus the
 * source's exact row count. Returns the raw result; the caller throws. */
export async function getLatestConversationForSource(
  supabase: TypedDb,
  userId: string,
  source: string,
): Promise<{ data: Array<{ updated_at: string | null }> | null; count: number | null; error: DbError | null }> {
  const { data, count, error } = await supabase
    .from("conversations")
    .select("updated_at", { count: "exact" })
    .eq("user_id", userId)
    .eq("source", source)
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(1);
  return { data, count, error };
}

export type ConversationManifestRow = { source: string; source_id: string; updated_at: string };

/** /api/conversations/manifest: one page (rows `from`..`to`) of the dedup
 * columns, optionally one source. The route owns the page loop and the 500. */
export async function listConversationManifestPage(
  supabase: TypedDb,
  userId: string,
  sourceFilter: string | null,
  from: number,
  to: number,
): Promise<{ data: ConversationManifestRow[] | null; error: DbError | null }> {
  let query = supabase.from("conversations").select("source, source_id, updated_at").eq("user_id", userId);

  if (sourceFilter) {
    query = query.eq("source", sourceFilter);
  }

  const { data, error } = await query.order("id", { ascending: true }).range(from, to);
  // updated_at is nullable in the schema; the route has always typed it as string.
  return { data: data as ConversationManifestRow[] | null, error };
}

export type ConversationUpsertOptions = { onConflict: string; ignoreDuplicates: boolean };

/** /api/sync: upsert a batch of conversation rows with the caller's options
 * (the route passes onConflict "user_id,source,source_id", ignoreDuplicates
 * false for both the bulk upsert and its row-by-row retry). */
export async function upsertConversations(
  supabase: TypedDb,
  rows: ConversationInsert[],
  options: ConversationUpsertOptions,
): Promise<{ error: (DbError & { details?: string | null }) | null }> {
  // ConversationInsert (database.types.ts) types messages/metadata narrower
  // than the generated Json; the payload is passed through untouched.
  const { error } = await supabase
    .from("conversations")
    .upsert(rows as unknown as Array<TablesInsert<"conversations">>, options);
  return { error };
}

export interface ConversationExportRow {
  id: string;
  source: string;
  source_id: string | null;
  title: string | null;
  model: string | null;
  messages: unknown;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

/** /api/account/export: one page (rows `from`..`to`) of the user's
 * conversations, oldest first (created_at, then id). The route's
 * streamAllRows owns the loop and the in-stream error record. */
export async function pageConversationsForExport(
  supabase: TypedDb,
  userId: string,
  from: number,
  to: number,
): Promise<{ data: ConversationExportRow[] | null; error: DbError | null }> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id, source, source_id, title, model, messages, metadata, created_at, updated_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to);
  return { data: data as ConversationExportRow[] | null, error };
}

export interface ConversationPageRow {
  id: string;
  source: string;
  title: string | null;
  created_at: string | null;
  updated_at: string | null;
  model: string | null;
  messages: unknown;
  metadata: unknown;
}

/** /conversations/[id]: the user's conversation by id (RLS-scoped client);
 * `.single()`, so a miss comes back as `{ data: null, error }`. */
export async function getConversationForPage(
  supabase: TypedDb,
  userId: string,
  id: string,
): Promise<{ data: ConversationPageRow | null; error: DbError | null }> {
  const { data, error } = await supabase
    .from("conversations")
    .select("id, source, title, created_at, updated_at, model, messages, metadata")
    .eq("id", id)
    .eq("user_id", userId)
    .single();
  return { data: data as ConversationPageRow | null, error };
}

/** /conversations/[id]: existence check by id (the caller passes the
 * service-role client); `.maybeSingle()`. */
export async function getConversationIdById(
  supabase: TypedDb,
  id: string,
): Promise<{ data: { id: string } | null; error: DbError | null }> {
  const { data, error } = await supabase.from("conversations").select("id").eq("id", id).maybeSingle();
  return { data, error };
}
