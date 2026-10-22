// Raw units of a code session (docs/design/i33-port.md D1, section 5 PR 2): a TypeScript port of the lab's unit
// builder, `variants/I24-ensemble-fusion/recordPostProcess.mjs` (helpers :12-139, assembly :150-177), which copies
// I17's chunking, I19's windows and I22's whole-turn rows. Every constant, regex and cut is the lab's, so the texts,
// spans and order are byte-for-byte what the lab embedded. Pure and deterministic: no database, no network, no LLM.
//
//  - c700: ~700-char chunks across turns (target 700, max 800, overlap 150), each with `parts` [[turn, start, end]],
//    its character spans inside the per-turn piece text ("<role>[ tool call|tool result]: <body>", whitespace
//    collapsed), the coordinate system the ranker dedupes by;
//  - win:  ~300-char windows cut inside one turn (target 300, max 380, overlap 100), `win` = [start, end) in the piece;
//  - turn: whole-turn rows; `text` is the first 1,000 chars (embedded), `full_text` the whole turn (lexical field and
//    snippet source), `turn_text` the turn's piece text capped at 30,000 chars.
//
// Deviation from the lab, forced by migration 129: the lab keeps the capped piece text (`turn_text`) on the FIRST
// WINDOW of each turn; migration 129 documents `turn_text` as turn-row only and `memory_raw_cover` reads the neighbour
// turns from `unit = 'turn'` rows, so here it lives on the turn row. The text is the same string. The lab's `turn_len`
// (uncapped piece length) has no column of its own: the writer stores it in the turn row's `parts` jsonb as
// {"turn_len": n} (RawUnit.turn_len), which 129 leaves free on turn rows.

import { createHash } from "node:crypto";

/** Bump when anything below changes what a session's units contain; every session is then stale (source_hash). */
export const UNITS_VERSION = 1;

export type RawUnitKind = "c700" | "win" | "turn";

/** The turn fields the builder reads (a payload turn or a `code_session_turns` row). */
export interface UnitTurn {
  idx: number;
  role: string;
  kind: string;
  text?: string | null;
}

export interface RawUnit {
  unit: RawUnitKind;
  /** Index within the unit type of one session (the lab's `-<i>` id suffix; for turns, the index among turn rows). */
  ord: number;
  turn_idx: number;
  turn_from: number;
  turn_to: number;
  /** c700 only: [[turn, start, end]]. */
  parts: [number, number, number][] | null;
  /** win only: [start, end) inside the turn's piece text. */
  win: [number, number] | null;
  /** The embedded text. */
  text: string;
  /** turn only. */
  full_text: string | null;
  /** turn only: the piece text of the turn, first TURN_STORE_MAX chars. */
  turn_text: string | null;
  /**
   * turn only: the full length of the turn's piece text, before the TURN_STORE_MAX cut. The lab's ranker shows a
   * trailing "..." when a turn is longer than what is stored; PR 4's stage 2 reads this to keep that signal. Stored
   * in the turn row's `parts` jsonb ({"turn_len": n}), so migration 129 needs no new column. Null on other units.
   */
  turn_len: number | null;
}

const TAG: Record<string, string> = { prose: "", tool_use: "tool call", tool_result: "tool result" };
const clean = (s: unknown): string =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
const tagOf = (kind: string): string => TAG[kind] ?? kind ?? "";

/** Moves a cut forward to the next space (at most up to `limit`), so words are not split. */
function toSpace(text: string, pos: number, limit: number): number {
  if (pos >= text.length) return text.length;
  const sp = text.slice(pos, limit).search(/\s/);
  return sp >= 0 ? pos + sp : Math.min(limit, text.length);
}

// ---------- c700 (I17 chunkTurns, with per-turn parts) ----------

export const C_TARGET_CHARS = 700;
export const C_MAX_CHARS = 800;
export const C_OVERLAP_CHARS = 150;

/** turns -> one string with a segment per kept turn; thinking and empty turns dropped. */
export function streamOf(turns: UnitTurn[]): { text: string; segs: { idx: number; start: number; end: number }[] } {
  let text = "";
  const segs: { idx: number; start: number; end: number }[] = [];
  for (const t of turns) {
    if (t.kind === "thinking") continue;
    const body = clean(t.text);
    if (!body) continue;
    const tag = tagOf(t.kind);
    const head = tag ? `${t.role} ${tag}` : t.role;
    const piece = `${head}: ${body}`;
    if (text) text += "\n";
    segs.push({ idx: t.idx, start: text.length, end: text.length + piece.length });
    text += piece;
  }
  return { text, segs };
}

export function chunkTurns(
  turns: UnitTurn[],
): { text: string; turns: [number, number]; parts: [number, number, number][] }[] {
  const { text, segs } = streamOf(turns);
  const out: { text: string; turns: [number, number]; parts: [number, number, number][] }[] = [];
  if (!text) return out;
  let start = 0;
  while (start < text.length) {
    const end =
      text.length - start <= C_MAX_CHARS ? text.length : toSpace(text, start + C_TARGET_CHARS, start + C_MAX_CHARS);
    const span = segs.filter((s) => s.end > start && s.start < end);
    const body = text.slice(start, end).trim();
    if (body && span.length)
      out.push({
        text: body,
        turns: [span[0].idx, span[span.length - 1].idx],
        parts: span
          .map((s): [number, number, number] => [
            s.idx,
            Math.max(start, s.start) - s.start,
            Math.min(end, s.end) - s.start,
          ])
          .filter(([, a, b]) => b > a),
      });
    if (end >= text.length) break;
    let next = toSpace(text, end - C_OVERLAP_CHARS, end);
    if (next <= start) next = end;
    start = next + (text[next] === " " || text[next] === "\n" ? 1 : 0);
  }
  return out;
}

// ---------- win (I19 windows) ----------

export const W_TARGET_CHARS = 300;
export const W_MAX_CHARS = 380;
export const W_OVERLAP_CHARS = 100;
export const TURN_STORE_MAX = 30000;

export function piecesOf(turns: UnitTurn[]): { idx: number; head: string; piece: string }[] {
  const out: { idx: number; head: string; piece: string }[] = [];
  for (const t of turns) {
    if (t.kind === "thinking") continue;
    const body = clean(t.text);
    if (!body) continue;
    const tag = tagOf(t.kind);
    const head = tag ? `${t.role} ${tag}` : t.role;
    out.push({ idx: t.idx, head, piece: `${head}: ${body}` });
  }
  return out;
}

export function windowSpans(piece: string): [number, number][] {
  const spans: [number, number][] = [];
  const L = piece.length;
  let start = 0;
  while (start < L) {
    const end = L - start <= W_MAX_CHARS ? L : toSpace(piece, start + W_TARGET_CHARS, start + W_MAX_CHARS);
    spans.push([start, end]);
    if (end >= L) break;
    let next = toSpace(piece, end - W_OVERLAP_CHARS, end);
    if (next <= start) next = end;
    start = next + (piece[next] === " " ? 1 : 0);
  }
  return spans;
}

export function windowTurns(turns: UnitTurn[]): { text: string; turn: number; win: [number, number] }[] {
  const out: { text: string; turn: number; win: [number, number] }[] = [];
  for (const p of piecesOf(turns)) {
    windowSpans(p.piece).forEach(([s, e]) => {
      const body = p.piece.slice(s, e).trim();
      if (!body) return;
      const text = s === 0 ? body : `${p.head} (cont.): ${body}`;
      out.push({ text, turn: p.idx, win: [s, e] });
    });
  }
  return out;
}

// ---------- turn (I22 whole-turn rows) ----------

export const HEAD_CHARS = 1000;
const cleanKeepLines = (s: unknown): string =>
  String(s ?? "")
    .replace(/[ \t\f\v\r]+/g, " ")
    .replace(/\n\s*/g, "\n")
    .trim();

/** Cuts at the last whitespace before `n` (when it is past the middle), so the head ends on a word. */
export function headOf(text: string, n: number = HEAD_CHARS): string {
  if (text.length <= n) return text;
  const cut = text.slice(0, n);
  const sp = cut.search(/\s\S*$/);
  return (sp > n / 2 ? cut.slice(0, sp) : cut).trimEnd();
}

export function turnRows(turns: UnitTurn[]): { idx: number; label: string; body: string }[] {
  const out: { idx: number; label: string; body: string }[] = [];
  for (const t of turns) {
    if (t.kind === "thinking") continue;
    const body = cleanKeepLines(t.text);
    if (!body) continue;
    const tag = tagOf(t.kind);
    out.push({ idx: t.idx, label: tag ? `${t.role} ${tag}` : String(t.role), body });
  }
  return out;
}

// ---------- all three units ----------

/** A session's turns -> its units: all c700 chunks, then all windows, then all turn rows (the lab's order). */
export function buildRawUnits(turns: UnitTurn[]): RawUnit[] {
  const pieceByIdx = new Map<number, string>();
  for (const p of piecesOf(turns)) pieceByIdx.set(p.idx, p.piece);
  const c700 = chunkTurns(turns).map(
    (c, i): RawUnit => ({
      unit: "c700",
      ord: i,
      turn_idx: c.turns[0],
      turn_from: c.turns[0],
      turn_to: c.turns[1],
      parts: c.parts,
      win: null,
      text: c.text,
      full_text: null,
      turn_text: null,
      turn_len: null,
    }),
  );
  const wins = windowTurns(turns).map(
    (w, i): RawUnit => ({
      unit: "win",
      ord: i,
      turn_idx: w.turn,
      turn_from: w.turn,
      turn_to: w.turn,
      parts: null,
      win: w.win,
      text: w.text,
      full_text: null,
      turn_text: null,
      turn_len: null,
    }),
  );
  const whole = turnRows(turns).map((t, i): RawUnit => {
    const full = `${t.label}: ${t.body}`;
    return {
      unit: "turn",
      ord: i,
      turn_idx: t.idx,
      turn_from: t.idx,
      turn_to: t.idx,
      parts: null,
      win: null,
      text: headOf(full),
      full_text: full,
      turn_text: (pieceByIdx.get(t.idx) ?? "").slice(0, TURN_STORE_MAX) || null,
      turn_len: (pieceByIdx.get(t.idx) ?? "").length,
    };
  });
  return [...c700, ...wins, ...whole].map(scrubUnit);
}

/**
 * Replaces each lone UTF-16 surrogate with U+FFFD. The cuts above work on UTF-16 code units and can split a surrogate
 * pair (an emoji); Postgres jsonb rejects a lone surrogate, which would fail the whole RPC. One code unit for one code
 * unit, so every length, span and part offset is unchanged.
 */
export function scrubSurrogates(s: string): string {
  return s.isWellFormed() ? s : s.toWellFormed();
}

function scrubUnit(u: RawUnit): RawUnit {
  return {
    ...u,
    text: scrubSurrogates(u.text),
    full_text: u.full_text === null ? null : scrubSurrogates(u.full_text),
    turn_text: u.turn_text === null ? null : scrubSurrogates(u.turn_text),
  };
}

// ---------- hashes ----------

export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

/**
 * Hash of a session's turns plus UNITS_VERSION: the stale test (units.source_hash != this). Over every turn's
 * (idx, role, kind, text), so any change a unit could reflect changes it; the payload's turns and the stored
 * `code_session_turns` rows give the same value.
 */
export function computeSourceHash(turns: UnitTurn[], unitsVersion: number = UNITS_VERSION): string {
  return sha256Hex(
    `units-v${unitsVersion}\n${JSON.stringify(turns.map((t) => [t.idx, t.role, t.kind, t.text ?? null]))}`,
  );
}
