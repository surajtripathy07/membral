// R4 step 4.2 — the one rule-4 curve (docs/design/cli-api-client-contract.md §5).
import { describe, expect, it } from "vitest";
import { createBucketState, decayBucketState, growBucketState, parseRetryAfterMs, RULE4_BACKOFF } from "../backoff.js";

describe("RULE4_BACKOFF", () => {
  it("delay curve: 500, 2,500, 7,500, 22,500, 29,250, 38,025, 49,433, then flat", () => {
    const seq = [500];
    for (let i = 0; i < 8; i++) seq.push(RULE4_BACKOFF.nextDelay(seq[seq.length - 1]!));
    expect(seq).toEqual([500, 2500, 7500, 22500, 29250, 38025, 49433, 49433, 49433]);
  });

  it("decay is 0.9x, floored at 500, never a reset", () => {
    expect(RULE4_BACKOFF.decayDelay(22500)).toBe(20250);
    expect(RULE4_BACKOFF.decayDelay(520)).toBe(500);
    expect(RULE4_BACKOFF.decayPace(1000)).toBe(900);
  });

  it("pace: 0 -> 1,000, x2 under 5 s, x1.3 after, capped at 30 s", () => {
    const seq = [0];
    for (let i = 0; i < 12; i++) seq.push(RULE4_BACKOFF.nextPace(seq[seq.length - 1]!));
    expect(seq.slice(0, 6)).toEqual([0, 1000, 2000, 4000, 8000, 10400]);
    expect(seq[seq.length - 1]).toBe(30000);
  });

  it("429 wait: Retry-After wins, 500 ms floor, 120 s clamp", () => {
    expect(RULE4_BACKOFF.rateLimitWaitMs(undefined, 2500)).toBe(2500);
    expect(RULE4_BACKOFF.rateLimitWaitMs(0, 2500)).toBe(500);
    expect(RULE4_BACKOFF.rateLimitWaitMs(1000, 22500)).toBe(1000);
    expect(RULE4_BACKOFF.rateLimitWaitMs(3_600_000, 500)).toBe(120_000);
  });
});

describe("BucketState", () => {
  it("starts at { 500, 0, 0 }", () => {
    expect(createBucketState()).toEqual({ delayMs: 500, paceMs: 0, epoch: 0 });
  });

  it("growth is epoch-guarded; pace still grows when delay growth is skipped", () => {
    const s = createBucketState();
    growBucketState(s, 0, true);
    growBucketState(s, 0, true);
    growBucketState(s, 0, true);
    expect(s).toEqual({ delayMs: 2500, paceMs: 4000, epoch: 1 });
  });

  it("success decays and bumps epoch", () => {
    const s = { delayMs: 7500, paceMs: 2000, epoch: 3 };
    decayBucketState(s);
    expect(s).toEqual({ delayMs: 6750, paceMs: 1800, epoch: 4 });
  });
});

describe("parseRetryAfterMs (raw)", () => {
  const now = 1_800_000_000_000;
  it("delta-seconds, HTTP date, 0, garbage, 3600", () => {
    expect(parseRetryAfterMs("2", now)).toBe(2000);
    expect(parseRetryAfterMs(new Date(now + 9000).toUTCString(), now)).toBe(9000);
    expect(parseRetryAfterMs("0", now)).toBe(0);
    expect(parseRetryAfterMs("soon", now)).toBeUndefined();
    expect(parseRetryAfterMs(null, now)).toBeUndefined();
    expect(parseRetryAfterMs("3600", now)).toBe(3_600_000);
  });
});
