// The cover test of the lab's I33 ranker (ranker.mjs:164-217): is a raw chunk already served, wholly or by sentences.
// The lab compares cosines in memory; the product gets the pairs at cosine >= 0.86 from `memory_raw_cover` (D4), so the
// vector rule is a membership test, not a number. Pure.

import { tokenSet } from "@/lib/memory/dedupe";
import { COVER_CONTAINMENT, MIN_SHRINK_GAIN, SENTENCE_NOVEL } from "./constants";
import type { CoverPairs, CoverRow } from "./types";

/** What is already served: token and identifier sets of the text, and the ids whose vectors count for the cosine rule. */
export interface ServedSet {
  tokens: Set<string>;
  idents: Set<string>;
  ids: Set<string>;
}

export const emptyServed = (): ServedSet => ({ tokens: new Set(), idents: new Set(), ids: new Set() });

export type CoverResult = { keep: false; reason: string } | { keep: true; text: string; shrunk: boolean };

/** ranker.mjs:172-180. Identifier-like tokens: digits, paths, snake_case, dotted names, camelCase, #N. */
export function identifiers(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of String(text ?? "").split(/\s+/)) {
    const t = raw.replace(/^[^\p{L}\p{N}#!~./_-]+|[^\p{L}\p{N}_/]+$/gu, "");
    if (t.length < 2) continue;
    if (
      /\d/.test(t) ||
      t.includes("/") ||
      t.includes("_") ||
      /[\p{L}\p{N}]\.[\p{L}\p{N}]/u.test(t) ||
      /\p{Ll}\p{Lu}/u.test(t)
    )
      out.add(t.toLowerCase());
  }
  return out;
}

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

/**
 * ranker.mjs:188-209. -> dropped, or kept (text shrunk to its novel sentences when most of the chunk is already served).
 * `vecCovered`: the chunk's cosine to something served is >= 0.86 (false when the chunk has no vector).
 */
export function coverChunk(chunk: { text: string }, vecCovered: boolean, served: ServedSet): CoverResult {
  const tc = tokenSet(chunk.text);
  const novelIdents = [...identifiers(chunk.text)].filter((t) => !served.idents.has(t));
  let shared = 0;
  for (const t of tc) if (served.tokens.has(t)) shared++;
  const cover = tc.size ? shared / tc.size : 1;
  if ((vecCovered || cover >= COVER_CONTAINMENT) && novelIdents.length === 0) return { keep: false, reason: "covered" };
  const sentences = String(chunk.text)
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean);
  const kept = sentences.filter((s) => {
    if ([...identifiers(s)].some((t) => !served.idents.has(t))) return true;
    const st = tokenSet(s);
    if (!st.size) return false;
    let novel = 0;
    for (const t of st) if (!served.tokens.has(t)) novel++;
    return novel / st.size >= SENTENCE_NOVEL;
  });
  if (!kept.length) return { keep: false, reason: "covered by sentence" };
  const text = kept.join(" ... ");
  if (text.length < MIN_SHRINK_GAIN * String(chunk.text).length) return { keep: true, text, shrunk: true };
  return { keep: true, text: chunk.text, shrunk: false };
}

/** ranker.mjs:211-215. `vecId`: the id whose vector joins the served ones (null = none). */
export function addServed(served: ServedSet, text: string, vecId: string | null): void {
  for (const t of tokenSet(text)) served.tokens.add(t);
  for (const t of identifiers(text)) served.idents.add(t);
  if (vecId) served.ids.add(vecId);
}

/** `memory_raw_cover` rows -> unit id -> ids at cosine >= 0.86 (both directions). Neighbour and turn rows are not pairs. */
export function buildCoverPairs(rows: readonly CoverRow[]): CoverPairs {
  const pairs: CoverPairs = new Map();
  const link = (a: string, b: string) => {
    const set = pairs.get(a) ?? new Set<string>();
    set.add(b);
    pairs.set(a, set);
  };
  for (const r of rows) {
    if (r.kind === "neighbour" || r.kind === "turn") continue;
    link(r.a_id, r.b_id);
    if (r.kind === "unit_unit") link(r.b_id, r.a_id);
  }
  return pairs;
}

/** True when unit `id` is at cosine >= 0.86 to something already served. */
export function vecCovered(pairs: CoverPairs, id: string, served: ServedSet): boolean {
  const near = pairs.get(id);
  if (!near) return false;
  for (const s of served.ids) if (near.has(s)) return true;
  return false;
}
