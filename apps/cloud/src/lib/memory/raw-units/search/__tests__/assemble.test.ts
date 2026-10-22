// The assembly equals the lab's I33 ranker: fuseRaw, the walk (the lab's `default` export on a hand-built store), the
// card/raw fusion and the served lines.
import { describe, expect, it } from "vitest";
import { assembleRaw, fuseCardsRaw, fuseRaw, packServed, rawLine, rawServedLine, turnsOf } from "../assemble";
import { buildCoverPairs } from "../cover";
import { gatePools } from "../floors";
import { buildSessionTurns } from "../plan";
import { fx, termStatsOf } from "./helpers";

describe("turn-level fusion equals the lab", () => {
  const lists = fx.fuse_raw.lists.map((l) => l.map((x) => ({ ...x, win: null })));
  it("turnsOf", () => {
    const all = fx.fuse_raw.lists.flat();
    for (const t of fx.fuse_raw.turnsOf)
      expect(turnsOf(all.find((x) => x.id === t.id) as (typeof all)[number]), t.id).toEqual(t.expected);
  });
  it("fuseRaw order and list index", () => {
    expect(fuseRaw(lists).map(({ row, li }) => ({ id: row.id, li }))).toEqual(fx.fuse_raw.expected);
  });
});

describe("card/raw fusion equals the lab's fuse", () => {
  it("interleaves 1:1, cards first on a tie", () => {
    const got = fuseCardsRaw(fx.fuse.cards, fx.fuse.raw).map((x) => x.id);
    expect(got).toEqual(fx.fuse.expected);
    expect(got.slice(0, 2)).toEqual(["c0", "r0"]);
  });
});

describe("served lines", () => {
  for (const [i, c] of fx.raw_lines.entries()) {
    it(`rawLine ${i} equals the lab's chunkLine`, () => {
      expect(rawLine({ id: "x", unit: "c700", ...c.row })).toBe(c.expected);
    });
  }
  it("a raw item is a served line with its span and member", () => {
    const row = {
      id: "u1",
      unit: "c700" as const,
      id8: "aaaa1111",
      chunk_turns: [2, 4] as [number, number],
      text: "t",
      shrunk: false,
      session_time_iso: null,
    };
    expect(rawServedLine(row)).toEqual({
      type: "raw",
      id8: "aaaa1111",
      span: [2, 4],
      members: ["u1"],
      text: rawLine(row),
    });
  });
  it("packServed keeps whole lines to the budget", () => {
    const row = {
      id: "u1",
      unit: "c700" as const,
      id8: "aaaa1111",
      chunk_turns: [2, 2] as [number, number],
      text: "x".repeat(100),
      shrunk: false,
      session_time_iso: null,
    };
    const lines = [rawServedLine(row), rawServedLine({ ...row, id: "u2" }), rawServedLine({ ...row, id: "u3" })];
    const one = Math.ceil(lines[0].text.length / 4);
    expect(packServed(lines, one).lines.map((l) => l.members[0])).toEqual(["u1"]);
    expect(packServed(lines, one * 2 + 1).lines.map((l) => l.members[0])).toEqual(["u1", "u2"]);
    expect(packServed(lines, 0).lines).toEqual([]);
  });
});

describe("assembleRaw equals the lab's default ranker", () => {
  for (const w of fx.walks) {
    it(w.name, () => {
      const lists = gatePools({
        pools: w.pools,
        records: w.records,
        cardCount: w.card_count,
        anchors: w.anchors,
        cuts: w.cuts,
      });
      const assembled = assembleRaw({
        lists,
        cards: w.cards,
        pairs: buildCoverPairs(w.cover_rows),
        sessions: buildSessionTurns(w.sessions),
        termStats: termStatsOf(w.term_stats),
        qterms: w.qterms,
        total: w.total,
      });
      // The lab's final cut (:677) takes `total` of cards and raw together, so the raw served are those that survive it.
      const cards = w.expected.final_cards.map((id) => ({ id }));
      const final = fuseCardsRaw(cards, assembled).slice(0, w.total);
      expect(final.map((x) => x.id)).toEqual(w.expected.final_order);
      const cardIds = new Set(w.expected.final_cards);
      const raw = assembled.filter((r) => final.some((f) => f.id === r.id) && !cardIds.has(r.id));
      expect(raw.map((r) => ({ id: r.id, text: r.text, shrunk: r.shrunk, chunk_turns: r.chunk_turns }))).toEqual(
        w.expected.raw.map((r) => ({ id: r.id, text: r.text, shrunk: r.shrunk, chunk_turns: r.chunk_turns })),
      );
      expect(raw.map(rawLine)).toEqual(w.expected.raw.map((r) => r.line));
      // strip: nothing of the stored turn leaves
      for (const r of assembled)
        for (const k of ["turn_len", "turn_text", "full_text", "parts"]) expect(r).not.toHaveProperty(k);
    });
  }
  it("the walks exercise a shrink, an elision, a served card and the limit", () => {
    const raws = fx.walks.flatMap((w) => w.expected.raw);
    expect(raws.some((r) => r.shrunk)).toBe(true);
    expect(raws.some((r) => r.text.includes("..."))).toBe(true);
    expect(fx.walks.some((w) => w.card_count > 0)).toBe(true);
    expect(fx.walks.some((w) => w.expected.raw.length === w.total)).toBe(true);
  });
  it("a served card changes the walk (its text and vectors seed the cover test)", () => {
    const a = fx.walks.find((w) => w.name === "no-cards-ensemble");
    const b = fx.walks.find((w) => w.name === "with-card-cover");
    expect(a?.expected.raw.map((r) => r.id)).not.toEqual(b?.expected.raw.map((r) => r.id));
  });
});
