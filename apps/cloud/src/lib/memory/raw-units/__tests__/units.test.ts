// The TypeScript unit builder must equal the lab's own builder byte for byte. unit-fixtures.json was produced by
// fixtures/generate-lab-fixtures.mjs running the lab's recordPostProcess on synthetic (fictional) transcripts.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NOMIC_DOCUMENT_PREFIX, unitEmbeddingModel, unitTextHash } from "../embed";
import { buildRawUnits, computeSourceHash, sha256Hex, TURN_STORE_MAX, UNITS_VERSION, type UnitTurn } from "../units";

interface Expected {
  unit: string;
  ord: number;
  turn_idx: number;
  turn_from: number;
  turn_to: number;
  parts: unknown;
  win: unknown;
  text: string;
  full_text: string | null;
  turn_text: string | null;
  text_hash: string;
  text_hash_nomic: string;
}
interface Fixture {
  name: string;
  turns: UnitTurn[];
  units?: Expected[];
  counts?: Record<string, number>;
  units_digest?: string;
}
const fixtures: Fixture[] = JSON.parse(readFileSync(join(__dirname, "fixtures", "unit-fixtures.json"), "utf8"));

describe("buildRawUnits equals the lab builder", () => {
  for (const f of fixtures) {
    it(f.name, () => {
      const got = buildRawUnits(f.turns);
      // turn_len is the port's addition (not in the lab's rows): checked below, dropped from the byte comparison.
      const withHashes = got.map(({ turn_len: _t, ...u }) => ({
        ...u,
        text_hash: unitTextHash(u.text, "text-embedding-3-small"),
        text_hash_nomic: unitTextHash(u.text, "nomic-embed-text"),
      }));
      if (f.units) {
        // Exact: text, spans, order, hashes.
        expect(withHashes).toEqual(f.units);
        expect(JSON.stringify(withHashes)).toBe(JSON.stringify(f.units));
      } else {
        const count = (k: string) => got.filter((u) => u.unit === k).length;
        expect({ c700: count("c700"), win: count("win"), turn: count("turn") }).toEqual(f.counts);
        const digest = sha256Hex(
          JSON.stringify(
            withHashes.map((u) => ({
              unit: u.unit,
              ord: u.ord,
              turn_idx: u.turn_idx,
              turn_from: u.turn_from,
              turn_to: u.turn_to,
              parts: u.parts,
              win: u.win,
              text: u.text,
              full_text: u.full_text,
              turn_text: u.turn_text,
              text_hash: u.text_hash,
              text_hash_nomic: u.text_hash_nomic,
            })),
          ),
        );
        expect(digest).toBe(f.units_digest);
      }
    });
  }

  it("caps the stored turn text at 30000 chars", () => {
    const text = Array.from({ length: 9000 }, (_, i) => `word${i}`).join(" ");
    expect(text.length).toBeGreaterThan(TURN_STORE_MAX);
    const rows = buildRawUnits([{ idx: 0, role: "user", kind: "tool_result", text }]).filter((u) => u.unit === "turn");
    expect(rows).toHaveLength(1);
    expect(rows[0].turn_text?.length).toBe(TURN_STORE_MAX);
    expect(rows[0].full_text?.length ?? 0).toBeGreaterThan(TURN_STORE_MAX);
  });

  it("turn_len is the full piece length on turn rows and null elsewhere", () => {
    const text = Array.from({ length: 9000 }, (_, i) => `word${i}`).join(" ");
    const got = buildRawUnits([{ idx: 0, role: "user", kind: "tool_result", text }]);
    const turn = got.find((u) => u.unit === "turn");
    expect(turn?.turn_len).toBeGreaterThan(TURN_STORE_MAX);
    expect(got.filter((u) => u.unit !== "turn").every((u) => u.turn_len === null)).toBe(true);
  });

  it("emoji cut by a window, a chunk, a head or the 30000 cap leaves no lone surrogate and survives JSON", () => {
    const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
    for (const text of [`hi ${"\u{1F680}".repeat(700)}`, "\u{1F680}".repeat(20000), `x${"\u{1F680}".repeat(4000)}`]) {
      const got = buildRawUnits([{ idx: 0, role: "user", kind: "prose", text }]);
      expect(got.length).toBeGreaterThan(0);
      for (const u of got) {
        for (const f of [u.text, u.full_text, u.turn_text]) {
          if (f === null) continue;
          expect(lone.test(f)).toBe(false);
          expect(JSON.parse(JSON.stringify(f))).toBe(f);
          expect(f.isWellFormed()).toBe(true);
        }
      }
    }
  });

  it("orders c700, then win, then turn, ord counting within each type", () => {
    const got = buildRawUnits(fixtures[1].turns);
    const order = got.map((u) => u.unit);
    expect(order).toEqual(
      [...order].sort((a, b) => ["c700", "win", "turn"].indexOf(a) - ["c700", "win", "turn"].indexOf(b)),
    );
    for (const k of ["c700", "win", "turn"]) {
      expect(got.filter((u) => u.unit === k).map((u) => u.ord)).toEqual(
        got.filter((u) => u.unit === k).map((_, i) => i),
      );
    }
  });
});

describe("hashes", () => {
  it("nomic hashes the prefixed string and default family the plain text", () => {
    expect(unitTextHash("hello", "nomic-embed-text")).toBe(sha256Hex(`${NOMIC_DOCUMENT_PREFIX}hello`));
    expect(unitTextHash("hello", "text-embedding-3-small")).toBe(sha256Hex("hello"));
    expect(unitEmbeddingModel("nomic-embed-text")).toBe("nomic-embed-text+doc-v1");
  });

  it("source_hash changes with the turns and with UNITS_VERSION, not with other fields", () => {
    const turns: UnitTurn[] = [{ idx: 0, role: "user", kind: "prose", text: "a" }];
    const base = computeSourceHash(turns);
    expect(computeSourceHash([{ ...turns[0] }])).toBe(base);
    expect(computeSourceHash([{ ...turns[0], text: "b" }])).not.toBe(base);
    expect(computeSourceHash(turns, UNITS_VERSION + 1)).not.toBe(base);
    expect(computeSourceHash([{ ...turns[0], ts: "x" } as UnitTurn])).toBe(base);
  });
});
