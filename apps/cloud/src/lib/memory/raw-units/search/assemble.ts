// Assembly of the lab's I33 ranker after the SQL pools (ranker.mjs:528-570, 632-678; formatter I17 formatter.mjs
// chunkLine). Turn-level reciprocal-rank fusion of the gated lists, the walk with its cover test and span dedupe, the
// card/raw fusion, and the served lines. Pure: the pools, cover pairs and neighbour turns come in as data (PR 4b wires
// them to `memory_raw_pools` and `memory_raw_cover`). docs/design/i33-port.md D2, D4, D7.

import { RRF_K, TURN_HEAD_CHARS } from "./constants";
import { addServed, coverChunk, emptyServed, vecCovered } from "./cover";
import { packLines } from "./pack";
import { expandWindow, hasNovelPart, markServed, snippet, snippetPart, spanKey } from "./plan";
import type {
  CoverPairs,
  GatedPools,
  RawCandidate,
  RawItem,
  ServedCard,
  ServedLine,
  SessionTurns,
  TermStats,
} from "./types";

/** ranker.mjs:529-533. The turns an item covers: a chunk's parts, else its turn span (endpoints). */
export function turnsOf(r: Pick<RawCandidate, "parts" | "turn_from" | "turn_to">): number[] {
  if (Array.isArray(r.parts) && r.parts.length) return [...new Set(r.parts.map((p) => p[0]))];
  const [a, b] = [r.turn_from, r.turn_to];
  return a === b ? [a] : [a, b];
}

type Spanned = Pick<RawCandidate, "id8" | "parts" | "turn_from" | "turn_to">;

/** ranker.mjs:536-545. list -> Map spanKey -> best (0-based) rank of an item covering that turn. */
export function turnRanks(list: readonly Spanned[]): Map<string, number> {
  const m = new Map<string, number>();
  list.forEach((r, i) => {
    for (const t of turnsOf(r)) {
      const k = spanKey(r.id8, t);
      if (!m.has(k)) m.set(k, i);
    }
  });
  return m;
}

/**
 * ranker.mjs:552-570. Turn-level reciprocal-rank fusion of the gated lists [R1, R2, R3] -> [{row, li}] in fused order. An
 * item scores the sum over lists of 1/(k + 1 + the best rank in that list of an item covering one of its turns); ties
 * keep the item's own list rank, then list order.
 */
export function fuseRaw<T extends Spanned>(lists: readonly (readonly T[])[], k = RRF_K): { row: T; li: number }[] {
  const ranks = lists.map(turnRanks);
  const items: { row: T; li: number; i: number; s: number }[] = [];
  lists.forEach((list, li) =>
    list.forEach((row, i) => {
      let s = 0;
      for (const rk of ranks) {
        let best = Number.POSITIVE_INFINITY;
        for (const t of turnsOf(row)) {
          const r = rk.get(spanKey(row.id8, t));
          if (r != null && r < best) best = r;
        }
        if (best < Number.POSITIVE_INFINITY) s += 1 / (k + best + 1);
      }
      items.push({ row, li, i, s });
    }),
  );
  return items.sort((a, b) => b.s - a.s || a.i - b.i || a.li - b.li).map(({ row, li }) => ({ row, li }));
}

/** ranker.mjs:54-60. Cards and raw items fused 1:1 by reciprocal rank; cards first on a tie. Generic over the item. */
export function fuseCardsRaw<C, R>(cards: readonly C[], raw: readonly R[], k = RRF_K): (C | R)[] {
  const scored = [
    ...cards.map((row, i) => ({ row: row as C | R, s: 1 / (k + i + 1), side: 0, i })),
    ...raw.map((row, i) => ({ row: row as C | R, s: 1 / (k + i + 1), side: 1, i })),
  ];
  return scored.sort((a, b) => b.s - a.s || a.side - b.side || a.i - b.i).map((x) => x.row);
}

const fullOf = (r: RawCandidate): string => String(r.full_text ?? r.text ?? "");

/** What the walk reads besides the gated lists. */
export interface WalkInput {
  lists: GatedPools;
  /** Cards served above (their text seeds the served set). */
  cards: readonly ServedCard[];
  pairs: CoverPairs;
  sessions: SessionTurns;
  termStats: TermStats;
  /** The query's distinct `terms()`. */
  qterms: readonly string[];
  /** Items to serve (the limit). */
  total: number;
}

/**
 * ranker.mjs:632-676. Walks the fused order; an item is dropped when its spans are already served or the cover test
 * drops it, else it is expanded (R2), snippeted (R3) or shrunk (R1/R3) and served. `turn_len`, `turn_text`, `full_text`
 * and `parts` never leave: a RawItem carries only the served fields.
 */
export function assembleRaw(input: WalkInput): RawItem[] {
  const { lists, cards, pairs, sessions, termStats, qterms, total } = input;
  const served = emptyServed();
  for (const c of cards) {
    addServed(served, `${c.text} ${c.ref ?? ""} ${(c.paths ?? []).join(" ")}`, null);
    for (const id of c.vec_ids) served.ids.add(id);
  }
  const spans = new Map<string, [number, number][]>();
  const raw: RawItem[] = [];
  const item = (c: RawCandidate, text: string, shrunk: boolean, turns: [number, number]): RawItem => ({
    id: c.id,
    id8: c.id8,
    unit: c.unit,
    text,
    shrunk,
    chunk_turns: turns,
    session_time_iso: c.session_time_iso,
  });
  for (const { row: c, li } of fuseRaw([lists.r1, lists.r2, lists.r3])) {
    if (raw.length >= total) break;
    if (li === 0) {
      const parts = Array.isArray(c.parts) ? c.parts : [];
      if (parts.length && !hasNovelPart(c.id8, parts, spans)) continue;
      const cov = coverChunk(c, vecCovered(pairs, c.id, served), served);
      if (!cov.keep) continue;
      markServed(c.id8, parts, spans);
      raw.push(item(c, cov.text, cov.shrunk, [c.turn_from, c.turn_to]));
      addServed(served, cov.text, c.id);
    } else if (li === 1) {
      const cov = coverChunk(c, vecCovered(pairs, c.id, served), served);
      if (!cov.keep) continue;
      const x = expandWindow(c, sessions.get(c.id8), spans);
      if (!x) continue;
      raw.push(item(c, x.text, false, x.turns));
      addServed(served, x.text, c.id);
    } else {
      const full = fullOf(c);
      const sn = snippet(full, termStats, qterms);
      const part = snippetPart(c, sn, full, sessions.get(c.id8));
      if (part && !hasNovelPart(c.id8, [part], spans)) continue;
      // The turn row's vector is of its first TURN_HEAD_CHARS: it stands for a snippet only when the snippet ends inside it.
      const vecId = sn.end <= TURN_HEAD_CHARS ? c.id : null;
      const cov = coverChunk({ text: sn.text }, vecId !== null && vecCovered(pairs, c.id, served), served);
      if (!cov.keep) continue;
      if (part) markServed(c.id8, [part], spans);
      raw.push(item(c, cov.text, cov.shrunk, [c.turn_idx, c.turn_idx]));
      addServed(served, cov.text, vecId);
    }
  }
  return raw;
}

const day = (iso: string | null | undefined): string =>
  typeof iso === "string" && iso.length >= 10 ? iso.slice(0, 10) : "unknown day";

/** I17 formatter.mjs `chunkLine`: one quoted excerpt with its session id, turn span and day, marked when parts were left out. */
export function rawLine(row: RawItem): string {
  const [a, b] = row.chunk_turns;
  const span = a === b ? `turn ${a}` : `turns ${a}-${b}`;
  const label = row.shrunk ? "raw excerpt (parts already served above left out)" : "raw excerpt";
  return `[session ${row.id8} ${span}, ${day(row.session_time_iso)}] ${label}: ${JSON.stringify(row.text)}`;
}

/** A raw item as a served line in the structure parity compares (parity.mjs `servedFromEntries`). */
export function rawServedLine(row: RawItem): ServedLine {
  return { type: "raw", id8: row.id8, span: row.chunk_turns, members: [row.id], text: rawLine(row) };
}

/** Packs served lines whole to the budget (D7): the packed lines and their token count. */
export function packServed(lines: readonly ServedLine[], maxTokens: number): { lines: ServedLine[]; tokens: number } {
  const packed = packLines(
    lines.map((l) => l.text),
    maxTokens,
  );
  return { lines: lines.slice(0, packed.lines.length), tokens: packed.tokens };
}
