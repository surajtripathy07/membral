// Shapes of the I33 read path. `PoolRow` and `CoverRow` are the columns of the RPCs `memory_raw_pools` and
// `memory_raw_cover` (migration 129); `RawCandidate` is a pool row plus what the assembly also reads.

import type { RawUnitKind } from "../units";

/** One row of `memory_raw_pools` (migration 129). `win` is the int4range as PostgREST prints it, e.g. "[0,300)". */
export interface PoolRow {
  pool: "r1" | "r2" | "r3";
  id: string;
  code_session_id: string;
  code_project_id: string | null;
  unit: RawUnitKind;
  ord: number;
  turn_idx: number | null;
  turn_from: number | null;
  turn_to: number | null;
  parts: [number, number, number][] | { turn_len: number } | null;
  win: string | null;
  text: string;
  similarity: number | null;
  lex_score: number | null;
  sem_rank: number | null;
  lex_rank: number | null;
  rrf: number;
  /** Migration 131. code_sessions.ended_at (started_at when unset) of the unit's session. */
  session_time: string | null;
  /** Migration 131. Distinct query lexemes found in the row's fts / in the query. */
  lex_hits: number;
  query_lexemes: number;
  /** Migration 131. The whole turn; R3 rows only. */
  full_text: string | null;
}

/** One row of `memory_raw_cover` (migration 129). 'unit_record' and 'unit_unit' rows carry a cosine >= 0.86. */
export interface CoverRow {
  /** Migration 131: 'turn' = the turn row of a win / turn unit, 'neighbour' = its stored previous and next turn rows. */
  kind: "unit_record" | "unit_unit" | "turn" | "neighbour";
  a_id: string;
  b_id: string;
  cosine: number | null;
  turn_idx: number | null;
  turn_text: string | null;
  /** Migration 131. The unit's session ('turn' and 'neighbour' rows). */
  code_session_id: string | null;
  /** Migration 131. The turn's uncapped piece length ('turn' and 'neighbour' rows). */
  turn_len: number | null;
}

/** One row of `memory_raw_term_stats` (migration 131, tokens of the lab's `terms()` since 132): a term's df, or (term null) the user's turn-row count in `total`. */
export interface TermStatRow {
  term: string | null;
  df: number | null;
  total: number;
}

/**
 * A pool row as the assembly reads it. The lab keeps `id8`, `session_time_iso`, `lex_hits` and `query_lexemes` on the
 * row; `memory_raw_pools` returns none of them (nor `full_text` of a turn row), so the caller adds them (PR 4b).
 */
export interface RawCandidate {
  id: string;
  /** First 8 characters of the session id: the id the served text prints. */
  id8: string;
  unit: RawUnitKind;
  turn_idx: number;
  turn_from: number;
  turn_to: number;
  /** c700 only: [[turn, start, end]]. */
  parts: [number, number, number][] | null;
  /** win only: [start, end) inside the turn's piece text. */
  win: [number, number] | null;
  text: string;
  /** turn only: the whole turn, the lexical field and the snippet source. */
  full_text: string | null;
  similarity: number | null;
  /** Matched / total query lexemes (the floor's lexical evidence). */
  lex_hits: number;
  query_lexemes: number;
  session_time_iso: string | null;
}

/** Candidate pools after the floors: R1 = c700, R2 = windows, R3 = whole turns. */
export interface GatedPools {
  r1: RawCandidate[];
  r2: RawCandidate[];
  r3: RawCandidate[];
}

/** A turn of one session as stored on its turn row: `turn_text` (capped piece text) and `turn_len` (uncapped length). */
export interface StoredTurn {
  id8: string;
  turn_idx: number;
  turn_text: string;
  turn_len: number | null;
}

/** id8 -> the session's stored turns (the lab's `sessionTurns`). */
export interface SessionTurnText {
  order: number[];
  text: Map<number, string>;
  len: Map<number, number>;
}
export type SessionTurns = Map<string, SessionTurnText>;

/** Document-frequency statistics of the whole-turn unit, the only thing the snippet reads of the lab's BM25 index. */
export interface TermStats {
  /** Number of whole-turn rows. */
  n: number;
  /** Rows containing the term. */
  df: (term: string) => number;
}

/** What the walk keeps of the cards already served: their text (cardText) and the ids whose vectors count. */
export interface ServedCard {
  /** The card's `cardText` output. */
  text: string;
  ref: string | null;
  paths: string[];
  /** Member ids with a vector in the ranked set: a raw unit with a cosine >= 0.86 to one of these is covered. */
  vec_ids: string[];
}

/** unit id -> ids (records or units) at cosine >= 0.86, from `memory_raw_cover`; symmetric. */
export type CoverPairs = Map<string, Set<string>>;

/** A raw item as served: the lab's row after `strip` (no turn_text, turn_len, full_text or parts). */
export interface RawItem {
  id: string;
  id8: string;
  unit: RawUnitKind;
  text: string;
  /** Sentences already served above were left out. */
  shrunk: boolean;
  chunk_turns: [number, number];
  session_time_iso: string | null;
}

/** One served line with the structure parity compares (lab `parity.mjs` LINE_FIELDS). */
export interface ServedLine {
  type: "raw" | "card" | "record";
  id8: string;
  span: [number, number];
  members: string[];
  text: string;
}
