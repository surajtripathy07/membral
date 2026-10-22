// Serving plans of the lab's I33 ranker: small windows expanded to their turn and neighbours (ranker.mjs:245-343) and
// whole turns served as query-biased snippets (:357-516), plus the per-turn span bookkeeping that dedupes them
// (:572-593). Pure. The lab keeps the stored turn text on the rows of the store; here the caller passes `SessionTurns`.

import {
  BM25_K1,
  CORE_CHARS,
  MIN_PART,
  NEIGHBOUR_CHARS,
  NEIGHBOUR_MAX,
  PIECE_MAX,
  SNIPPET_CHARS,
  WHOLE_MAX,
} from "./constants";
import type { RawCandidate, SessionTurns, SessionTurnText, StoredTurn, TermStats } from "./types";

/** Served character spans per `${id8}\u0001${turn}`, in the per-turn piece coordinates (updated in place). */
export type Spans = Map<string, [number, number][]>;
export const spanKey = (id8: string, turn: number): string => `${id8}\u0001${turn}`;

/** Stored turns -> id8 -> {order, text, len} (ranker.mjs:247-260). `len` falls back to the stored text's length. */
export function buildSessionTurns(rows: readonly StoredTurn[]): SessionTurns {
  const m: SessionTurns = new Map();
  for (const r of rows) {
    if (typeof r.turn_text !== "string") continue;
    let s = m.get(r.id8);
    if (!s) {
      s = { order: [], text: new Map(), len: new Map() };
      m.set(r.id8, s);
    }
    s.text.set(r.turn_idx, r.turn_text);
    s.len.set(r.turn_idx, r.turn_len ?? r.turn_text.length);
  }
  for (const s of m.values()) s.order = [...s.text.keys()].sort((a, b) => a - b);
  return m;
}

/** The window of a pool row: PostgREST prints int4range as "[0,300)". */
export function parseWin(range: string | null): [number, number] | null {
  const m = /^[[(](-?\d+),(-?\d+)[\])]$/.exec(String(range ?? ""));
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const snapBack = (t: string, p: number): number => {
  if (p <= 0) return 0;
  const sp = t.lastIndexOf(" ", p);
  return sp > p - 40 && sp >= 0 ? sp + 1 : p;
};
const snapFwd = (t: string, p: number): number => {
  if (p >= t.length) return t.length;
  const sp = t.indexOf(" ", p);
  return sp >= 0 && sp < p + 40 ? sp : p;
};

/** ranker.mjs:274-288. Subtracts served intervals from [s, e] -> the uncovered pieces. */
export function subtract([s, e]: [number, number], served: readonly [number, number][] = []): [number, number][] {
  let parts: [number, number][] = [[s, e]];
  for (const [a, b] of served) {
    const next: [number, number][] = [];
    for (const [x, y] of parts) {
      if (b <= x || a >= y) next.push([x, y]);
      else {
        if (a > x) next.push([x, a]);
        if (b < y) next.push([b, y]);
      }
    }
    parts = next;
  }
  return parts.filter(([x, y]) => y > x);
}

type Win = Pick<RawCandidate, "id8" | "turn_idx" | "win" | "text">;

/**
 * ranker.mjs:294-343. One window -> {text, turns: [lo, hi]} expanded to its turn and neighbour edges, or null when its
 * own span is already served. A "..." marks every cut: a piece not starting at 0, or ending before the turn's full
 * length (`len`, the uncapped length, so a turn cut at the storage cap still shows it).
 */
export function expandWindow(
  win: Win,
  sess: SessionTurnText | undefined,
  spans: Spans,
): { text: string; turns: [number, number] } | null {
  const t = win.turn_idx;
  const key = (i: number) => spanKey(win.id8, i);
  const [o1, o2] = win.win ?? [0, String(win.text).length];
  const turnText = sess?.text.get(t);
  if (sess == null || turnText == null || o2 > turnText.length) {
    // Turn text not stored (or the window lies past the stored cap): serve the window itself.
    const own = spans.get(key(t)) ?? [];
    if (!subtract([o1, o2], own).length) return null;
    spans.set(key(t), [...own, [o1, o2]]);
    return { text: `[turn ${t}] ${win.text}`, turns: [t, t] };
  }
  if (!subtract([o1, o2], spans.get(key(t)) ?? []).length) return null;
  let s = 0;
  let e = turnText.length;
  if (e > CORE_CHARS) {
    const mid = Math.round((o1 + o2) / 2);
    s = Math.max(0, mid - CORE_CHARS / 2);
    e = Math.min(turnText.length, s + CORE_CHARS);
    s = Math.max(0, e - CORE_CHARS);
    s = snapBack(turnText, s);
    e = snapFwd(turnText, e);
  }
  const pos = sess.order.indexOf(t);
  const prev = pos > 0 ? sess.order[pos - 1] : null;
  const next = pos >= 0 && pos < sess.order.length - 1 ? sess.order[pos + 1] : null;
  interface Plan {
    turn: number;
    text: string;
    s: number;
    e: number;
    full: number;
    core?: boolean;
  }
  const plan: Plan[] = [];
  if (prev != null) {
    const pt = sess.text.get(prev) as string;
    plan.push({
      turn: prev,
      text: pt,
      s: snapBack(pt, Math.max(0, pt.length - NEIGHBOUR_CHARS)),
      e: pt.length,
      full: sess.len.get(prev) as number,
    });
  }
  plan.push({ turn: t, text: turnText, s, e, full: sess.len.get(t) as number, core: true });
  if (next != null) {
    const nt = sess.text.get(next) as string;
    plan.push({
      turn: next,
      text: nt,
      s: 0,
      e: snapFwd(nt, Math.min(nt.length, NEIGHBOUR_CHARS)),
      full: sess.len.get(next) as number,
    });
  }
  const out: string[] = [];
  const used: number[] = [];
  for (const p of plan) {
    const own = spans.get(key(p.turn)) ?? [];
    const pieces = subtract([p.s, p.e], own).filter(([x, y]) => p.core || y - x >= MIN_PART);
    if (!pieces.length) continue;
    const segs = pieces.map(([x, y]) => `${x > 0 ? "..." : ""}${p.text.slice(x, y).trim()}${y < p.full ? "..." : ""}`);
    out.push(`[turn ${p.turn}] ${segs.join(" ")}`);
    used.push(p.turn);
    spans.set(key(p.turn), [...own, ...pieces]);
  }
  if (!out.length) return null;
  return { text: out.join("\n"), turns: [Math.min(...used), Math.max(...used)] };
}

// ---------- whole-turn snippets ----------

/** ranker.mjs:360-372. Generic tokenizer: lowercase letter/digit/underscore runs, length >= 2, light suffix folding. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const m of String(text ?? "")
    .toLowerCase()
    .matchAll(/[\p{L}\p{N}_]+/gu)) {
    let t = m[0];
    if (t.length < 2) continue;
    if (t.length > 5 && t.endsWith("ing")) t = t.slice(0, -3);
    else if (t.length > 4 && t.endsWith("ed")) t = t.slice(0, -2);
    else if (t.length > 4 && t.endsWith("es")) t = t.slice(0, -2);
    else if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss")) t = t.slice(0, -1);
    out.push(t);
  }
  return out;
}

const tfOf = (ts: readonly string[]): Map<string, number> => {
  const m = new Map<string, number>();
  for (const t of ts) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
};

/** ranker.mjs:400-403. */
export const idf = (stats: TermStats, t: string): number => {
  const n = stats.df(t);
  return Math.log(1 + (stats.n - n + 0.5) / (n + 0.5));
};

/** ranker.mjs:445-467. text -> pieces: sentences (or lines), long ones split at whitespace to <= PIECE_MAX chars. */
export function pieces(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  const re = /[^\n]+?(?:[.!?](?=\s)|\n|$)|[^\n]+$/g;
  const push = (from: number, b: number) => {
    let a = from;
    while (b - a > PIECE_MAX) {
      const seg = text.slice(a, a + PIECE_MAX);
      const sp = seg.search(/\s\S*$/);
      const cut = sp > PIECE_MAX / 3 ? a + sp : a + PIECE_MAX;
      if (text.slice(a, cut).trim()) out.push({ start: a, end: cut });
      a = cut;
    }
    if (text.slice(a, b).trim()) out.push({ start: a, end: b });
  };
  let m: RegExpExecArray | null = re.exec(text);
  while (m !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
    } else {
      push(m.index, m.index + m[0].length);
    }
    m = re.exec(text);
  }
  return out;
}

const weightOf = (text: string, stats: TermStats, qset: ReadonlySet<string>): number => {
  const m = tfOf(terms(text));
  let s = 0;
  for (const t of qset) {
    const f = m.get(t) ?? 0;
    if (f) s += (idf(stats, t) * f * (BM25_K1 + 1)) / (f + BM25_K1);
  }
  return s;
};

/**
 * ranker.mjs:484-516. Full turn text -> {text, start, end}: the turn whole when <= WHOLE_MAX, else the contiguous run of
 * pieces of at most SNIPPET_CHARS (at least one) with the most query-term weight (earliest on a tie), plus one
 * neighbouring piece (more weight wins, the following one on a tie) cut to NEIGHBOUR_MAX. The role label stays in front.
 */
export function snippet(
  full: string,
  stats: TermStats,
  qterms: readonly string[],
): { text: string; start: number; end: number } {
  if (full.length <= WHOLE_MAX) return { text: full, start: 0, end: full.length };
  const colon = full.indexOf(": ");
  const labelEnd = colon > 0 && colon < 40 ? colon + 2 : 0;
  const label = full.slice(0, labelEnd);
  const body = full.slice(labelEnd);
  const ps = pieces(body);
  if (!ps.length) return { text: full.slice(0, WHOLE_MAX), start: 0, end: WHOLE_MAX };
  const qset = new Set(qterms);
  const w = ps.map((p) => weightOf(body.slice(p.start, p.end), stats, qset));
  let best = { a: 0, b: 0, s: -1 };
  for (let a = 0; a < ps.length; a++) {
    let s = 0;
    let b = a;
    for (; b < ps.length; b++) {
      if (b > a && ps[b].end - ps[a].start > SNIPPET_CHARS) break;
      s += w[b];
    }
    // window pieces a..b-1; a single piece always counts
    if (s > best.s) best = { a, b: Math.max(a, b - 1), s };
  }
  const { a, b } = best;
  const prev = a - 1 >= 0 ? w[a - 1] : -1;
  const next = b + 1 < ps.length ? w[b + 1] : -1;
  let start = ps[a].start;
  let end = ps[b].end;
  if (next >= 0 && next >= prev) end = Math.min(ps[b + 1].end, ps[b + 1].start + NEIGHBOUR_MAX);
  else if (prev >= 0) start = Math.max(ps[a - 1].start, ps[a - 1].end - NEIGHBOUR_MAX);
  const core = body.slice(start, end).trim();
  const lead = start > 0 ? "... " : "";
  const tail = end < body.length ? " ..." : "";
  return { text: `${label}${lead}${core}${tail}`, start: labelEnd + start, end: labelEnd + end };
}

// ---------- per-turn span bookkeeping ----------

/** ranker.mjs:573-575. Parts [[turn, s, e]] -> true when some part keeps >= MIN_PART chars not yet served. */
export function hasNovelPart(id8: string, parts: readonly [number, number, number][], spans: Spans): boolean {
  return parts.some(([t, s, e]) =>
    subtract([s, e], spans.get(spanKey(id8, t)) ?? []).some(([x, y]) => y - x >= MIN_PART),
  );
}

/** ranker.mjs:577-582. */
export function markServed(id8: string, parts: readonly [number, number, number][], spans: Spans): void {
  for (const [t, s, e] of parts) {
    const k = spanKey(id8, t);
    spans.set(k, [...(spans.get(k) ?? []), [s, e]]);
  }
}

const collapse = (s: string): string =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** ranker.mjs:585-593. A whole-turn snippet -> its part [turn, s, e] in the per-turn piece coordinates, or null. */
export function snippetPart(
  row: Pick<RawCandidate, "turn_idx">,
  sn: { start: number; end: number },
  full: string,
  sess: { text: Map<number, string> } | undefined,
): [number, number, number] | null {
  const piece = sess?.text.get(row.turn_idx);
  if (piece == null) return null;
  if (sn.start === 0 && sn.end >= full.length) return [row.turn_idx, 0, piece.length];
  const core = collapse(full.slice(sn.start, sn.end));
  if (!core) return null;
  const pos = piece.indexOf(core);
  return pos >= 0 ? [row.turn_idx, pos, pos + core.length] : null;
}
