// Unit test for resolveSyncWindowDays and the options.ts <select>
// encode/decode helpers (#120) -- guards against the specific bugs these
// exist to avoid:
// - `??` treats `null` and `undefined` the same, so a naive
//   `settings.syncWindowDays ?? DEFAULT_SYNC_WINDOW_DAYS` would silently
//   collapse an explicit "All history" choice (`null`) back down to the
//   30-day default. Every reader (engine.ts, options.ts, popup.ts) goes
//   through resolveSyncWindowDays instead.
// - MINOR fix (adversarial review): a non-preset/corrupted stored day count
//   makes options.ts's <select> silently reset to no selection
//   (`.value === ""`), and the next auto-save previously read that back as
//   `Number("") = 0` -- which computeSyncWindowCutoff resolves to "now,"
//   excluding every conversation from every future sync. Both
//   optionValueToDays and resolveSyncWindowDays now clamp a non-positive or
//   non-finite value to the default instead of passing it through.
import { describe, expect, it } from "vitest";
import {
  ALL_HISTORY_OPTION_VALUE,
  DEFAULT_SYNC_WINDOW_DAYS,
  daysToOptionValue,
  optionValueToDays,
  resolveSyncWindowDays,
  SYNC_WINDOW_PRESETS,
} from "../common/constants.js";

describe("resolveSyncWindowDays", () => {
  it("falls back to the default when undefined (unset / pre-#120 stored settings)", () => {
    expect(resolveSyncWindowDays(undefined)).toBe(DEFAULT_SYNC_WINDOW_DAYS);
  });

  it("preserves an explicit null ('All history') instead of collapsing it to the default", () => {
    expect(resolveSyncWindowDays(null)).toBeNull();
  });

  it("passes through an explicit day count unchanged", () => {
    expect(resolveSyncWindowDays(7)).toBe(7);
    expect(resolveSyncWindowDays(90)).toBe(90);
  });

  it("MINOR fix: clamps 0 to the default instead of syncing nothing forever", () => {
    expect(resolveSyncWindowDays(0)).toBe(DEFAULT_SYNC_WINDOW_DAYS);
  });

  it("MINOR fix: clamps a negative or non-finite value to the default", () => {
    expect(resolveSyncWindowDays(-5)).toBe(DEFAULT_SYNC_WINDOW_DAYS);
    expect(resolveSyncWindowDays(Number.NaN)).toBe(DEFAULT_SYNC_WINDOW_DAYS);
    expect(resolveSyncWindowDays(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SYNC_WINDOW_DAYS);
  });
});

describe("daysToOptionValue / optionValueToDays round-trip (test gap (d), adversarial review)", () => {
  it("round-trips every preset's days through the option-value encoding", () => {
    for (const preset of SYNC_WINDOW_PRESETS) {
      const encoded = daysToOptionValue(preset.days);
      expect(optionValueToDays(encoded)).toBe(preset.days);
    }
  });

  it("'All history' (null) round-trips through the dedicated sentinel value", () => {
    expect(daysToOptionValue(null)).toBe(ALL_HISTORY_OPTION_VALUE);
    expect(optionValueToDays(ALL_HISTORY_OPTION_VALUE)).toBeNull();
  });

  it("a real day count round-trips exactly", () => {
    expect(daysToOptionValue(30)).toBe("30");
    expect(optionValueToDays("30")).toBe(30);
  });

  it("a non-preset day count still encodes to a real numeric string (even though no matching <option> exists in the DOM)", () => {
    expect(daysToOptionValue(14)).toBe("14");
  });

  it("MINOR fix: the empty string (what a <select> reports when .value was set to something with no matching <option>) falls back to the default, not 0", () => {
    expect(optionValueToDays("")).toBe(DEFAULT_SYNC_WINDOW_DAYS);
  });

  it("MINOR fix: a corrupted/non-numeric value falls back to the default", () => {
    expect(optionValueToDays("not-a-number")).toBe(DEFAULT_SYNC_WINDOW_DAYS);
  });

  it("MINOR fix: a negative or zero value falls back to the default", () => {
    expect(optionValueToDays("0")).toBe(DEFAULT_SYNC_WINDOW_DAYS);
    expect(optionValueToDays("-5")).toBe(DEFAULT_SYNC_WINDOW_DAYS);
  });
});
