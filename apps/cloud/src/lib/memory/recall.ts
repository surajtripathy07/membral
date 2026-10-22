// `memory_recall` (docs/design/memory-v1.md §4): recall BY REPO OR PATH, not
// by topic (`memory_search` is the topic tool) -- no embedding call, so this
// is plain supabase-js filtering + `rank.ts`'s business ordering, no RPC.
//
// "Exclude superseded/retired unless `include_retired`": Postgres NOT EXISTS
// has no supabase-js equivalent either, but unlike memory_search's cosine
// leg this doesn't need SQL -- a single extra `select supersedes` query
// (batched, not per-row) gives the same set in TS, matching the brief's
// "prefer TS" default since nothing here actually requires the database to
// do it.
import type { Db } from "@/lib/db/types";
import { selectAllRows } from "@/lib/util/pagination";
import { MEMORY_KINDS, type MemoryKind } from "./schema";
import { partitionStaleBlockers, recordRecallEvent, resolveProjectId } from "./search";
import { type MemoryRow, rankAndServe, type ServedRecord } from "./verify";

export interface MemoryRecallArgs {
  repo?: string;
  scope?: "project" | "global";
  kind?: string | string[];
  path?: string;
  recall_token?: string;
  durable_only?: boolean;
  include_retired?: boolean;
  limit?: number;
}

function clampLimit(limit: number | undefined, fallback = 10, max = 20): number {
  return Math.min(Math.max(Math.trunc(limit ?? fallback), 1), max);
}

function normalizeKinds(kind: string | string[] | undefined): MemoryKind[] | null {
  if (!kind) return null;
  const list = Array.isArray(kind) ? kind : [kind];
  const valid = list.filter((k): k is MemoryKind => (MEMORY_KINDS as readonly string[]).includes(k));
  return valid.length ? valid : null;
}

/** The ids of every LIVE record another live record supersedes -- these are excluded from serving unless `include_retired` (rule 4). Paginated past PostgREST's 1000-row cap (#165) so a superseded id beyond row 1000 doesn't leak back into recall. */
async function fetchSupersededIds(supabase: Db, userId: string): Promise<string[]> {
  const rows = await selectAllRows((from, to) =>
    supabase
      .from("session_memories")
      .select("supersedes")
      .eq("user_id", userId)
      .is("retired_at", null)
      .not("supersedes", "is", null)
      .order("id", { ascending: true })
      .range(from, to),
  );
  return (rows as { supersedes: string }[]).map((r) => r.supersedes);
}

export interface MemoryRecallResult {
  records: ServedRecord[];
  /** #436: blocker records older than BLOCKER_FRESH_DAYS that matched but were not served. */
  staleBlockersHidden: number;
}

export async function memoryRecall(
  supabase: Db,
  userId: string,
  codeScopeId: string | null,
  args: MemoryRecallArgs,
): Promise<ServedRecord[]> {
  return (await memoryRecallWithStats(supabase, userId, codeScopeId, args)).records;
}

/** memoryRecall plus the count of stale blockers it hid (the MCP tool reports it). */
export async function memoryRecallWithStats(
  supabase: Db,
  userId: string,
  codeScopeId: string | null,
  args: MemoryRecallArgs,
  now: number = Date.now(),
): Promise<MemoryRecallResult> {
  const limit = clampLimit(args.limit);
  const durableOnly = args.durable_only ?? true;
  const kinds = normalizeKinds(args.kind);

  const projectId = await resolveProjectId(supabase, userId, args.repo, codeScopeId);
  if (args.repo && !projectId) return { records: [], staleBlockersHidden: 0 }; // an unresolvable repo matches nothing -- never falls back to "recent" (rule 1)

  let query = supabase.from("session_memories").select("*").eq("user_id", userId);
  if (projectId) query = query.eq("code_project_id", projectId);
  if (args.scope) query = query.eq("scope", args.scope);
  if (kinds) query = query.in("kind", kinds);
  if (args.path) query = query.contains("paths", [args.path]);
  if (durableOnly) query = query.eq("durable", true);
  if (!args.include_retired) query = query.is("retired_at", null);

  const { data, error } = await query.order("created_at", { ascending: false }).limit(Math.min(limit * 3, 100));
  if (error) throw new Error(`memory_recall query failed: ${error.message}`);

  let rows = (data ?? []) as MemoryRow[];
  if (!args.include_retired) {
    const superseded = new Set(await fetchSupersededIds(supabase, userId));
    rows = rows.filter((r) => !superseded.has(r.id));
  }

  // #436: an old blocker is old on every surface — hidden (never retired), and counted.
  const { fresh, staleHidden } = partitionStaleBlockers(rows, now);

  const ranked = await rankAndServe(supabase, userId, fresh, "tool", limit, {
    collapse: !args.include_retired,
    collapseByMeaning: true,
  });

  await recordRecallEvent(supabase, userId, "memory_recall", {
    recordIds: ranked.map((r) => r.id),
    recallToken: args.recall_token,
  });

  return { records: ranked, staleBlockersHidden: staleHidden };
}
