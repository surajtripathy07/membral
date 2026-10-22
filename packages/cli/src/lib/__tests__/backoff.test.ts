import { describe, expect, it } from "vitest";
import { KICK_BACKOFF } from "../backoff.js";

// Oracles below are frozen, verbatim copies of the pre-consolidation code
// (G3 step 3C-1) — the ground truth this test proves backoff.ts against.
// The caller never used Math.random, so no random source needed to
// be injected: every delay is a pure function of its inputs.

const KICK_OLD_INITIAL_DELAY_MS = 10_000;
const KICK_OLD_MAX_DELAY_MS = 60 * 60_000;
function kickOldNextDelay(delayMs: number): number {
  return Math.min(KICK_OLD_MAX_DELAY_MS, Math.round(delayMs < 60_000 ? delayMs * 3 : delayMs * 1.5));
}
function kickOldClampDelay(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return KICK_OLD_INITIAL_DELAY_MS;
  return Math.min(KICK_OLD_MAX_DELAY_MS, Math.max(KICK_OLD_INITIAL_DELAY_MS, ms));
}

/** Calls `fn` at every integer in [0, max], fine-grained near the thresholds and strided further out, staying well under ~2s. */
function sweep(max: number, fn: (n: number) => void): void {
  for (let n = 0; n <= 20000 && n <= max; n++) fn(n);
  for (let n = 20000; n <= max; n += 137) fn(n);
  fn(max);
}

describe("KICK_BACKOFF matches the old memory-kick.ts computation", () => {
  it("nextDelay over 0..200000 plus boundaries", () => {
    sweep(200000, (n) => expect(KICK_BACKOFF.nextDelay(n)).toBe(kickOldNextDelay(n)));
    for (const n of [0, 1, 59999, 60000, 60001, 3600000, 4000000]) {
      expect(KICK_BACKOFF.nextDelay(n)).toBe(kickOldNextDelay(n));
    }
  });
  it("clampDelay over 0..200000 plus boundaries, including non-finite/negative input", () => {
    sweep(200000, (n) => expect(KICK_BACKOFF.clampDelay(n)).toBe(kickOldClampDelay(n)));
    for (const n of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -1,
      0,
      1,
      9999,
      10000,
      3600000,
      4000000,
    ]) {
      expect(KICK_BACKOFF.clampDelay(n)).toBe(kickOldClampDelay(n));
    }
  });
});
