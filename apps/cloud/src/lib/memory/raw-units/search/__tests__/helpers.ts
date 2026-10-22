// Typed access to lab-fixtures.json (fixtures/generate-i33-fixtures.mjs runs the LAB's I33 ranker to produce it).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { QueryAnchor } from "@/lib/memory/query-anchors";
import type { RawCuts } from "../floors";
import type { CoverRow, RawCandidate, StoredTurn, TermStats } from "../types";

type Span = [number, number];
type SpanEntries = [string, Span[]][];

export interface LabWalk {
  name: string;
  query: string;
  total: number;
  anchors: QueryAnchor[];
  cuts: RawCuts;
  records: { similarity: number | null }[];
  card_count: number;
  cards: { text: string; ref: string | null; paths: string[]; vec_ids: string[] }[];
  pools: { r1: RawCandidate[]; r2: RawCandidate[]; r3: RawCandidate[] };
  sessions: StoredTurn[];
  term_stats: { n: number; df: Record<string, number> };
  qterms: string[];
  cover_rows: CoverRow[];
  expected: {
    trigger: boolean;
    gated: { r1: string[]; r2: string[]; r3: string[] };
    raw: { id: string; text: string; shrunk: boolean; chunk_turns: [number, number]; line: string }[];
    final_order: string[];
    final_cards: string[];
  };
}

export interface LabFixtures {
  cuts: RawCuts;
  floors: {
    row: { similarity: number | null; lex_hits: number; query_lexemes: number };
    cuts: RawCuts;
    expected: boolean;
  }[];
  triggers: { records: { similarity: number | null }[]; anchor_count: number; expected: boolean }[];
  subtract: { interval: Span; served: Span[]; expected: Span[] }[];
  terms: { text: string; expected: string[] }[];
  pieces: { text: string; expected: { start: number; end: number }[] }[];
  snippets: {
    stats: { n: number; df: Record<string, number>; idf: Record<string, number> };
    qterms: string[];
    cases: { full: string; expected: { text: string; start: number; end: number } }[];
  };
  expand: {
    stored: StoredTurn[];
    cases: {
      win: { id8: string; turn_idx: number; win: Span | null; text: string };
      spans_before: SpanEntries;
      expected: { text: string; turns: Span } | null;
      spans_after: SpanEntries;
    }[];
    lone: {
      win: { id8: string; turn_idx: number; win: Span | null; text: string };
      expected: { text: string; turns: Span } | null;
      spans_after: SpanEntries;
    };
    capped: {
      sess: StoredTurn;
      win: { id8: string; turn_idx: number; win: Span | null; text: string };
      expected: { text: string; turns: Span } | null;
      spans_after: SpanEntries;
    };
  };
  cover: {
    name: string;
    chunk: string;
    served_texts: string[];
    vec_covered: boolean;
    expected: { keep: boolean; reason?: string; text?: string; shrunk?: boolean };
  }[];
  fuse: { cards: { id: string }[]; raw: { id: string }[]; expected: string[] };
  pack: {
    lines: string[];
    cases: { budget: number; expected: { lines: string[]; tokens: number } }[];
    join: { lines: string[]; budget: number; expected: { lines: string[]; tokens: number } };
  };
  raw_lines: {
    row: { id8: string; chunk_turns: Span; text: string; shrunk: boolean; session_time_iso: string | null };
    expected: string;
  }[];
  fuse_raw: {
    lists: {
      id: string;
      id8: string;
      parts: [number, number, number][] | null;
      turn_from: number;
      turn_to: number;
    }[][];
    expected: { id: string; li: number }[];
    turnsOf: { id: string; expected: number[] }[];
  };
  walks: LabWalk[];
}

export const fx: LabFixtures = JSON.parse(readFileSync(join(__dirname, "fixtures", "lab-fixtures.json"), "utf8"));

export const termStatsOf = (s: { n: number; df: Record<string, number> }): TermStats => ({
  n: s.n,
  df: (t) => s.df[t] ?? 0,
});
