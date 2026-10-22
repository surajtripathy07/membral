// L1 serve side: reads the projection (migration 124) for the rows a search is about to serve, outside the search RPC
// (whose return type stays untouched). A schema without the columns reads as "no projection" (a no-op); any other
// read error is reported to the caller, which fails closed in history mode and serves unfiltered otherwise.
import type { Db } from "@/lib/db/types";
import { log } from "@/lib/log";

export interface Validity {
  superseded_by: string;
  supersede_kind: string | null;
  valid_to: string;
}

export interface ValidityRead {
  map: Map<string, Validity>;
  /** A read error that is NOT "the columns do not exist". */
  failed: boolean;
}

const ID_CHUNK = 100;

/** Per process: when a read said the columns do not exist, skip the query for a while (hosted before migration 124). */
const PROBE_TTL_MS = 5 * 60_000;
let columnsAbsentAt: number | null = null;

export function resetValidityProbeForTests(): void {
  columnsAbsentAt = null;
}

/** Postgres 42703 (undefined column) / PostgREST schema-cache miss: the schema predates migration 124. */
export function isMissingColumn(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  return /column .*(superseded_by|valid_to|supersede_kind).* does not exist|could not find .*(superseded_by|valid_to)/i.test(
    err.message ?? "",
  );
}

/**
 * The live projection of each id: rows of this USER whose `superseded_by` points at a replacement that is itself live
 * (not retired, same user). A retired replacement hides nothing (D-078). Never throws.
 */
export async function fetchValidity(supabase: Db, userId: string, ids: readonly string[]): Promise<ValidityRead> {
  const map = new Map<string, Validity>();
  if (ids.length === 0) return { map, failed: false };
  if (columnsAbsentAt !== null && Date.now() - columnsAbsentAt < PROBE_TTL_MS) return { map, failed: false };
  columnsAbsentAt = null;
  try {
    const projected: Array<{
      id: string;
      superseded_by: string;
      supersede_kind: string | null;
      valid_to: string | null;
    }> = [];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data, error } = await supabase
        .from("session_memories")
        .select("id, superseded_by, supersede_kind, valid_to")
        .eq("user_id", userId)
        .in("id", ids.slice(i, i + ID_CHUNK))
        .not("superseded_by", "is", null);
      if (error) {
        if (isMissingColumn(error)) {
          columnsAbsentAt = Date.now();
          return { map, failed: false };
        }
        log.warn("memory_search: validity read failed", { error: error.message });
        return { map, failed: true };
      }
      for (const r of (data ?? []) as typeof projected) if (r.superseded_by && r.valid_to) projected.push(r);
    }
    if (projected.length === 0) return { map, failed: false };
    const byIds = [...new Set(projected.map((p) => p.superseded_by))];
    const live = new Set<string>();
    for (let i = 0; i < byIds.length; i += ID_CHUNK) {
      const { data, error } = await supabase
        .from("session_memories")
        .select("id")
        .eq("user_id", userId)
        .is("retired_at", null)
        .in("id", byIds.slice(i, i + ID_CHUNK));
      if (error) {
        log.warn("memory_search: replacement liveness read failed", { error: error.message });
        return { map, failed: true };
      }
      for (const r of (data ?? []) as Array<{ id: string }>) live.add(r.id);
    }
    for (const p of projected) {
      if (live.has(p.superseded_by) && p.valid_to)
        map.set(p.id, { superseded_by: p.superseded_by, supersede_kind: p.supersede_kind, valid_to: p.valid_to });
    }
    return { map, failed: false };
  } catch (err) {
    log.warn("memory_search: validity read threw", { error: err instanceof Error ? err.message : String(err) });
    return { map, failed: true };
  }
}

/** Merges replacement pointers, keeping the OLDEST replacement per id (as-of correctness). Pure. */
export function mergeOldest(
  ...sources: ReadonlyArray<ReadonlyMap<string, { id: string; at: string }>>
): Map<string, { id: string; at: string }> {
  const out = new Map<string, { id: string; at: string }>();
  for (const s of sources) {
    for (const [id, v] of s) {
      const cur = out.get(id);
      if (!cur || (Date.parse(v.at) || 0) < (Date.parse(cur.at) || 0)) out.set(id, v);
    }
  }
  return out;
}
