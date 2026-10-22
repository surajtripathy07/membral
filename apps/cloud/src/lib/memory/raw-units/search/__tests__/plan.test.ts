// Window expansion, snippets and span bookkeeping equal the lab's (fixtures from the lab's own functions).
import { describe, expect, it } from "vitest";
import {
  buildSessionTurns,
  expandWindow,
  hasNovelPart,
  idf,
  markServed,
  parseWin,
  pieces,
  snippet,
  snippetPart,
  subtract,
  terms,
} from "../plan";
import { fx, termStatsOf } from "./helpers";

describe("subtract / terms / pieces equal the lab", () => {
  it("subtract", () => {
    for (const c of fx.subtract) expect(subtract(c.interval, c.served), JSON.stringify(c)).toEqual(c.expected);
  });
  it("terms", () => {
    for (const c of fx.terms) expect(terms(c.text), c.text).toEqual(c.expected);
  });
  // The document frequencies of memory_raw_term_stats come from the SQL tokenizer session_raw_unit_terms (migration 132),
  // which must return this same set. The vector was run through both (psql and this function) when the migration was written.
  it("terms yields the set session_raw_unit_terms returns in SQL", () => {
    const text = "Running the tests: x² ½ Ⅷ foo_bar passes, glasses; ab c classes tested Á中 a1";
    expect([...new Set(terms(text))].sort()).toEqual([
      "a1",
      "ab",
      "class",
      "foo_bar",
      "glass",
      "pass",
      "runn",
      "test",
      "the",
      "x²",
      "á中",
    ]);
  });
  it("pieces", () => {
    for (const c of fx.pieces) expect(pieces(c.text), c.text.slice(0, 30)).toEqual(c.expected);
  });
});

describe("snippet equals the lab", () => {
  const stats = termStatsOf(fx.snippets.stats);
  it("idf equals the lab's", () => {
    for (const [t, v] of Object.entries(fx.snippets.stats.idf)) expect(idf(stats, t)).toBeCloseTo(v, 12);
  });
  fx.snippets.cases.forEach((c, i) => {
    it(`case ${i} (${c.full.length} chars)`, () => {
      expect(snippet(c.full, stats, fx.snippets.qterms)).toEqual(c.expected);
    });
  });
  it("includes a whole short turn and a cut long one", () => {
    expect(fx.snippets.cases.some((c) => c.expected.start === 0 && c.expected.end === c.full.length)).toBe(true);
    expect(fx.snippets.cases.some((c) => c.expected.text.includes(" ..."))).toBe(true);
  });
});

describe("expandWindow equals the lab", () => {
  const sessions = buildSessionTurns(fx.expand.stored);
  it("a sequence of windows of one session shares the served spans", () => {
    const spans = new Map<string, [number, number][]>();
    for (const c of fx.expand.cases) {
      expect(Array.from(spans), "spans before").toEqual(c.spans_before);
      const got = expandWindow(c.win, sessions.get(c.win.id8), spans);
      expect(got).toEqual(c.expected);
      expect(Array.from(spans), "spans after").toEqual(c.spans_after);
    }
  });
  it("includes an expansion with neighbours, an already-served window (null) and a core cut", () => {
    expect(fx.expand.cases.some((c) => c.expected === null)).toBe(true);
    expect(fx.expand.cases.some((c) => c.expected && c.expected.turns[0] !== c.expected.turns[1])).toBe(true);
  });
  it("a window with no stored turn text is served as itself", () => {
    const spans = new Map<string, [number, number][]>();
    const got = expandWindow(fx.expand.lone.win, undefined, spans);
    expect(got).toEqual(fx.expand.lone.expected);
    expect(Array.from(spans)).toEqual(fx.expand.lone.spans_after);
  });
  it('elision comes from turn_len: a turn longer than what is stored ends in "..."', () => {
    const c = fx.expand.capped;
    const spans = new Map<string, [number, number][]>();
    const got = expandWindow(c.win, buildSessionTurns([c.sess]).get(c.win.id8), spans);
    expect(got).toEqual(c.expected);
    expect(got?.text.endsWith("...")).toBe(true);
    // the same stored text with turn_len equal to its length shows no trailing "..."
    const whole = buildSessionTurns([{ ...c.sess, turn_len: c.sess.turn_text.length }]);
    expect(expandWindow(c.win, whole.get(c.win.id8), new Map())?.text.endsWith("...")).toBe(false);
  });
  it("turn_len absent falls back to the stored length", () => {
    const m = buildSessionTurns([{ id8: "s", turn_idx: 2, turn_text: "abc", turn_len: null }]);
    expect(m.get("s")?.len.get(2)).toBe(3);
  });
});

describe("span bookkeeping", () => {
  it("a part is novel only while >= 30 unserved characters remain", () => {
    const spans = new Map<string, [number, number][]>();
    expect(hasNovelPart("s", [[1, 0, 100]], spans)).toBe(true);
    markServed("s", [[1, 0, 80]], spans);
    expect(hasNovelPart("s", [[1, 0, 100]], spans)).toBe(false);
    expect(hasNovelPart("s", [[1, 0, 120]], spans)).toBe(true);
    expect(hasNovelPart("s", [[2, 0, 100]], spans)).toBe(true);
  });
  it("snippetPart places a snippet in the stored piece text, or null", () => {
    const sess = { text: new Map([[3, "assistant: alpha beta gamma delta"]]) };
    expect(snippetPart({ turn_idx: 3 }, { start: 0, end: 99 }, "x".repeat(10), sess)).toEqual([3, 0, 33]);
    expect(snippetPart({ turn_idx: 3 }, { start: 11, end: 21 }, "assistant: alpha beta gamma delta", sess)).toEqual([
      3, 11, 21,
    ]);
    expect(snippetPart({ turn_idx: 9 }, { start: 0, end: 5 }, "abcde", sess)).toBeNull();
    expect(snippetPart({ turn_idx: 3 }, { start: 0, end: 5 }, "zzzzzzzzzz", sess)).toBeNull();
  });
});

describe("parseWin", () => {
  it("reads PostgREST int4range text", () => {
    expect(parseWin("[0,300)")).toEqual([0, 300]);
    expect(parseWin("[12,400)")).toEqual([12, 400]);
    expect(parseWin(null)).toBeNull();
    expect(parseWin("empty")).toBeNull();
  });
});
