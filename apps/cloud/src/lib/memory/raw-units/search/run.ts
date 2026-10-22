// The I33 read path against the database (docs/design/i33-port.md section 5, PR 4): embeds the query, calls the three
// RPCs (`memory_raw_pools`, `memory_raw_cover`, `memory_raw_term_stats`, migration 131), applies the family's cuts and
// hands the rows to the pure assembly. Never throws (repo rule 3): any failure returns no raw lines and a reason.

import type { Db } from "@/lib/db/types";
import { rawUnitCuts } from "@/lib/llm/embedding-family";
import { log } from "@/lib/log";
import type { QueryAnchor } from "@/lib/memory/query-anchors";
import { queryEmbedInput, unitEmbeddingModel } from "../embed";
import { assembleRaw, rawServedLine } from "./assemble";
import { WHOLE_MAX } from "./constants";
import { buildCoverPairs } from "./cover";
import { gatePools, triggered } from "./floors";
import { buildSessionTurns, parseWin, terms } from "./plan";
import type {
  CoverRow,
  GatedPools,
  PoolRow,
  RawCandidate,
  ServedCard,
  ServedLine,
  StoredTurn,
  TermStatRow,
  TermStats,
} from "./types";

/** What the raw search needs of the records search that ran beside it. */
export interface RawSearchContext {
  /** The query text as the records search reads it (date phrases already stripped). */
  query: string;
  /** Canonical embedding family of this process. */
  family: string;
  /** Items to serve (the limit). */
  limit: number;
  projectId: string | null;
  anchors: readonly QueryAnchor[];
  /** The ranked records, best first, with the cosine the records RPC returned. */
  records: readonly { id: string; similarity: number | null }[];
  /** The records as already served lines: their text seeds the cover test. */
  cards: readonly ServedCard[];
  /** Embeds the exact string given; null when no vector could be made. Shared per request, so a repeated text embeds once. */
  embed: (text: string) => Promise<number[] | null>;
}

export interface RawSearchOutcome {
  lines: ServedLine[];
  /** Why no raw line was served because of a failure or a missing calibration; absent on a normal (possibly empty) run. */
  reason?: string;
}

const NO_STATS: TermStats = { n: 0, df: () => 0 };

/** Throws on an RPC error: the caller turns it into a degraded outcome. */
async function rpcRows<T>(supabase: Db, fn: string, args: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return (data ?? []) as T[];
}

/** A pool row as the assembly reads it (the caller-side columns come from migration 131). */
function toCandidate(r: PoolRow): RawCandidate {
  const turnIdx = r.turn_idx ?? r.turn_from ?? 0;
  return {
    id: r.id,
    id8: r.code_session_id.slice(0, 8),
    unit: r.unit,
    turn_idx: turnIdx,
    turn_from: r.turn_from ?? turnIdx,
    turn_to: r.turn_to ?? turnIdx,
    parts: Array.isArray(r.parts) ? r.parts : null,
    win: parseWin(r.win),
    text: r.text,
    full_text: r.full_text,
    similarity: r.similarity,
    lex_hits: r.lex_hits ?? 0,
    query_lexemes: r.query_lexemes ?? 0,
    session_time_iso: r.session_time,
  };
}

/** Pool rows -> the three lists, each best first (the RPC's own order is kept on a tie). */
function splitPools(rows: readonly PoolRow[]): GatedPools {
  const by = (pool: PoolRow["pool"]) =>
    rows
      .map((r, i) => ({ r, i }))
      .filter((x) => x.r.pool === pool)
      .sort((a, b) => b.r.rrf - a.r.rrf || a.i - b.i)
      .map((x) => toCandidate(x.r));
  return { r1: by("r1"), r2: by("r2"), r3: by("r3") };
}

function toStoredTurns(rows: readonly CoverRow[]): StoredTurn[] {
  const out: StoredTurn[] = [];
  for (const r of rows) {
    if ((r.kind !== "turn" && r.kind !== "neighbour") || !r.code_session_id) continue;
    if (r.turn_idx === null || typeof r.turn_text !== "string") continue;
    out.push({
      id8: r.code_session_id.slice(0, 8),
      turn_idx: r.turn_idx,
      turn_text: r.turn_text,
      turn_len: r.turn_len,
    });
  }
  return out;
}

function toTermStats(rows: readonly TermStatRow[]): TermStats {
  const df = new Map<string, number>();
  let n = 0;
  for (const r of rows) {
    if (r.term === null) n = r.total;
    else df.set(r.term, r.df ?? 0);
  }
  return { n, df: (t) => df.get(t) ?? 0 };
}

/** The raw-excerpt lines for one query. Never throws. */
export async function searchRawUnits(supabase: Db, userId: string, ctx: RawSearchContext): Promise<RawSearchOutcome> {
  try {
    const cuts = rawUnitCuts(ctx.family);
    if (!cuts) return { lines: [], reason: "no calibrated raw-unit floors for this embedding model" };
    const vector = await ctx.embed(queryEmbedInput(ctx.query, ctx.family));
    if (!vector) return { lines: [], reason: "no query embedding for the raw search" };

    const poolRows = await rpcRows<PoolRow>(supabase, "memory_raw_pools", {
      p_user_id: userId,
      p_query: ctx.query,
      p_query_embedding: `[${vector.join(",")}]`,
      p_embedding_model: unitEmbeddingModel(ctx.family),
      p_min_similarity: cuts.sql_cut,
      p_code_project_id: ctx.projectId,
      p_want_r23: triggered(ctx.records, ctx.anchors.length, cuts),
    });
    const lists = gatePools({
      pools: splitPools(poolRows),
      records: ctx.records,
      cardCount: ctx.cards.length,
      anchors: ctx.anchors,
      cuts,
    });
    const unitIds = [...lists.r1, ...lists.r2, ...lists.r3].map((c) => c.id);
    if (unitIds.length === 0) return { lines: [] };

    const coverRows = await rpcRows<CoverRow>(supabase, "memory_raw_cover", {
      p_user_id: userId,
      p_unit_ids: unitIds,
      p_record_ids: ctx.records.map((r) => r.id),
    });

    const qterms = [...new Set(terms(ctx.query))];
    // Document frequencies only matter to a snippet, which only a turn longer than WHOLE_MAX gets.
    const needsStats = lists.r3.some((c) => String(c.full_text ?? c.text).length > WHOLE_MAX);
    const termStats =
      needsStats && qterms.length > 0
        ? toTermStats(
            await rpcRows<TermStatRow>(supabase, "memory_raw_term_stats", { p_user_id: userId, p_terms: qterms }),
          )
        : NO_STATS;

    const items = assembleRaw({
      lists,
      cards: ctx.cards,
      pairs: buildCoverPairs(coverRows),
      sessions: buildSessionTurns(toStoredTurns(coverRows)),
      termStats,
      qterms,
      total: ctx.limit,
    });
    return { lines: items.map(rawServedLine) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("memory_search: raw search failed, serving records only", { user_id: userId, error: message });
    return { lines: [], reason: `raw search failed: ${message}` };
  }
}
