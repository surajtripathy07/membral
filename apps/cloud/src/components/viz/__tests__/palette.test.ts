// ADR 0032 §7 "Verification hook" — pin the four validated series hexes so a
// drive-by color edit fails CI instead of silently breaking CVD safety. The
// validator run itself (node scripts/validate_palette.js ... --mode dark
// --surface "#16161b") is recorded in ADR 0032 §7 and in this feature's PR
// evidence; this test only guards the constant against unreviewed drift.
import { describe, expect, it } from "vitest";
import { MODEL_TIER_COLORS } from "../palette";

describe("MODEL_TIER_COLORS", () => {
  it("equals the ADR 0032 §7 validated palette (+ membral-k89 Fable slot), in fixed tier order", () => {
    expect(MODEL_TIER_COLORS).toEqual({
      Fable: "#c94f9e",
      Opus: "#3987e5",
      Sonnet: "#d95926",
      Haiku: "#199e70",
      Other: "#c98500",
    });
  });

  it("has no duplicate hex values across slots", () => {
    const values = Object.values(MODEL_TIER_COLORS);
    expect(new Set(values).size).toBe(values.length);
  });
});
