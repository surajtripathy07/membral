// Floors, trigger and abstain gate of the lab's I33 ranker (ranker.mjs:30-52, 224-235, 612-630). Pure.

import type { RawUnitCuts } from "@/lib/llm/embedding-family";
import type { QueryAnchor } from "@/lib/memory/query-anchors";
import { LEX_COVERAGE, MIXED_COVERAGE, WEAK_MIN_RECORDS } from "./constants";
import type { GatedPools, RawCandidate } from "./types";

/** The per-family cuts the raw path reads (`rawUnitCuts` in lib/llm/embedding-family.ts). */
export type RawCuts = RawUnitCuts;

interface FloorRow {
  similarity: number | null;
  lex_hits: number;
  query_lexemes: number;
}

/** ranker.mjs:30-40. The records floor: cosine, or lexical coverage, or both mixed. */
export function passesFloor(
  row: FloorRow,
  cuts: Pick<RawCuts, "sem_floor" | "mixed_sem_floor" | "lex_min_hits">,
): boolean {
  const sim = typeof row.similarity === "number" ? row.similarity : null;
  const hits = row.lex_hits ?? 0;
  const lexemes = row.query_lexemes ?? 0;
  const coverage = lexemes > 0 ? hits / lexemes : 0;
  if (sim !== null && sim >= cuts.sem_floor) return true;
  if (hits < Math.min(cuts.lex_min_hits ?? 0, lexemes)) return false;
  if (hits >= Math.min(2, lexemes) && hits > 0 && coverage >= LEX_COVERAGE) return true;
  if (sim !== null && sim >= cuts.mixed_sem_floor && coverage >= MIXED_COVERAGE) return true;
  return false;
}

/** ranker.mjs:42-45. The text names a query path or ref anchor. */
export function strongHit(text: string, anchors: readonly QueryAnchor[]): boolean {
  const t = String(text ?? "").toLowerCase();
  return anchors.some(
    (a) => (a.kind === "path" || a.kind === "ref") && a.value && t.includes(String(a.value).toLowerCase()),
  );
}

/** ranker.mjs:47-52. R2 and R3 run when the query has anchors, few records came back, or the top record is weak. */
export function triggered(
  records: readonly { similarity: number | null }[],
  anchorCount: number,
  cuts: Pick<RawCuts, "sem_floor">,
): boolean {
  if (anchorCount > 0) return true;
  if (records.length < WEAK_MIN_RECORDS) return true;
  const top = records[0];
  return !(typeof top.similarity === "number" && top.similarity >= cuts.sem_floor);
}

/** ranker.mjs:226-229. */
export function passesChunkFloor(
  row: RawCandidate,
  anchors: readonly QueryAnchor[],
  cuts: Pick<RawCuts, "chunk_floor">,
): boolean {
  const sim = typeof row.similarity === "number" ? row.similarity : null;
  return (sim !== null && sim >= cuts.chunk_floor) || strongHit(row.text, anchors);
}

/** ranker.mjs:232-235. No card served: serve chunks only when the best one is above unrelated-pair p99 or names an anchor. */
export function chunksAbstain(
  cardCount: number,
  pool: readonly RawCandidate[],
  anchors: readonly QueryAnchor[],
  cuts: Pick<RawCuts, "chunk_abstain">,
): boolean {
  if (cardCount > 0) return false;
  return !pool.some(
    (c) => (typeof c.similarity === "number" ? c.similarity : 0) >= cuts.chunk_abstain || strongHit(c.text, anchors),
  );
}

const fullOf = (r: RawCandidate): string => String(r.full_text ?? r.text ?? "");

/**
 * ranker.mjs:612-630. The three raw pools (as `memory_raw_pools` returns them, R2/R3 empty when not wanted) -> the
 * gated lists [R1, R2, R3]. `records` are the ranked records (best first, cut at the limit), `cardCount` the cards.
 */
export function gatePools(input: {
  pools: GatedPools;
  records: readonly { similarity: number | null }[];
  cardCount: number;
  anchors: readonly QueryAnchor[];
  cuts: RawCuts;
}): GatedPools {
  const { pools, records, cardCount, anchors, cuts } = input;
  const r1 = chunksAbstain(cardCount, pools.r1, anchors, cuts)
    ? []
    : pools.r1.filter((c) => passesChunkFloor(c, anchors, cuts));
  const trig = triggered(records, anchors.length, cuts);
  const r2 = trig ? pools.r2.filter((c) => passesFloor(c, cuts) || strongHit(c.text, anchors)) : [];
  const r3 = trig ? pools.r3.filter((c) => passesFloor(c, cuts) || strongHit(fullOf(c), anchors)) : [];
  return { r1, r2, r3 };
}
