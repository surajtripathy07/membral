// Constants of the lab's I33 assembly (extract-search-lab variants/I33-i24-cue-off/ranker.mjs), each with its lab line.
// Same values, same names where the lab has one. docs/design/i33-port.md D6 and D7.

/** Reciprocal-rank-fusion constant, 1 / (k + rank + 1): ranker.mjs:23. */
export const RRF_K = 60;

// ---------- floors (ranker.mjs:22-25, 221-222) ----------
/** Fewer records than this fires the R2/R3 trigger: :22. */
export const WEAK_MIN_RECORDS = 3;
/** Lexical coverage that serves on lexical evidence alone: :24. */
export const LEX_COVERAGE = 0.5;
/** Lexical coverage that serves together with the mixed semantic floor: :25. */
export const MIXED_COVERAGE = 0.33;

// ---------- cover test (:166-169) ----------
export const COVER_COSINE = 0.86;
export const COVER_CONTAINMENT = 0.8;
export const SENTENCE_NOVEL = 0.4;
/** Shrink only when the kept sentences are under this share of the chunk: :169. */
export const MIN_SHRINK_GAIN = 0.9;

// ---------- window expansion (:241-243) ----------
export const CORE_CHARS = 1500;
export const NEIGHBOUR_CHARS = 250;
export const MIN_PART = 30;

// ---------- whole-turn snippets (:348-355) ----------
/** BM25 k1 of the snippet's piece weight: :349. (The pool's BM25 is Postgres ts_rank_cd, D3.) */
export const BM25_K1 = 1.2;
export const SNIPPET_CHARS = 600;
export const WHOLE_MAX = 800;
export const PIECE_MAX = 300;
export const NEIGHBOUR_MAX = 200;
/** The embedded head of a turn row; a snippet ending inside it keeps its vector for the cover test: :355. */
export const TURN_HEAD_CHARS = 1000;
