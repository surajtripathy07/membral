// L1 candidate generation (gates/fable-l1-design.md section 2): per new record, the union of (a) the hybrid-search
// top-8, (b) the cosine top-8 at or above 0.55, (c) records sharing a ref token, capped at 12. Pure merge here; the
// reads that feed it live in io.ts. A pair key is the ordered id pair, so a verdict is memoised once.
import { MAX_CANDIDATES } from "./verdict";

export const HYBRID_TOP = 8;
export const COSINE_TOP = 8;
export const COSINE_FLOOR = 0.55;

export interface Cand {
  id: string;
  /** Which sources offered it: "hybrid" | "cosine" | "ref". */
  via: string[];
}

export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Top-n ids by cosine at or above the floor, best first. Pure. */
export function cosineTop(
  scores: ReadonlyArray<{ id: string; cosine: number }>,
  n = COSINE_TOP,
  floor = COSINE_FLOOR,
): string[] {
  return scores
    .filter((s) => s.cosine >= floor)
    .sort((a, b) => b.cosine - a.cosine || (a.id < b.id ? -1 : 1))
    .slice(0, n)
    .map((s) => s.id);
}

/**
 * Unions the three sources in a fixed order (hybrid, cosine, ref), deduplicates, drops the record itself and any pair
 * already judged (`seen`, by pairKey), and caps at MAX_CANDIDATES. Pure.
 */
export function mergeCandidates(
  selfId: string,
  sources: { hybrid: readonly string[]; cosine: readonly string[]; ref: readonly string[] },
  seen: ReadonlySet<string> = new Set(),
  cap = MAX_CANDIDATES,
): Cand[] {
  const byId = new Map<string, Cand>();
  const add = (ids: readonly string[], via: string) => {
    for (const id of ids) {
      if (id === selfId || seen.has(pairKey(selfId, id))) continue;
      const c = byId.get(id);
      if (c) c.via.push(via);
      else if (byId.size < cap) byId.set(id, { id, via: [via] });
    }
  };
  add(sources.hybrid.slice(0, HYBRID_TOP), "hybrid");
  add(sources.cosine, "cosine");
  add(sources.ref, "ref");
  return [...byId.values()];
}

/** The ref token of a record, lowercased, or null; records sharing one are candidates of each other. */
export function refToken(ref: string | null | undefined): string | null {
  const r = (ref ?? "").trim().toLowerCase();
  return r.length > 0 ? r : null;
}
