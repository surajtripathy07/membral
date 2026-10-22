import { describe, expect, it } from "vitest";
import {
  formatElapsed,
  formatParseLine,
  formatRateLimitLine,
  formatUploadLine,
  ProgressEmitter,
  RateTracker,
  shouldEmitNonTTY,
} from "../import-progress.js";

describe("formatParseLine", () => {
  it("shows done/total when the total is known (claude-code)", () => {
    expect(formatParseLine("claude-code", 120, 288)).toBe("claude-code: Parsing 120/288…");
  });

  it("omits the total when it isn't known yet (opencode's streaming generator)", () => {
    expect(formatParseLine("opencode", 42)).toBe("opencode: Parsing 42…");
  });
});

describe("formatUploadLine", () => {
  it("includes rate/ETA once given, and the harness prefix", () => {
    const line = formatUploadLine({
      harness: "claude-code",
      done: 145,
      total: 1166,
      ratePerMinute: 27,
      etaMs: 38 * 60_000,
      errors: 0,
    });
    expect(line).toBe("claude-code: Uploading 145/1166 · 27/min · ~38 min left · 0 errors");
  });

  it("omits rate/ETA before enough batches have run", () => {
    const line = formatUploadLine({ harness: "opencode", done: 5, total: 40, errors: 1 });
    expect(line).toBe("opencode: Uploading 5/40 · 1 error");
  });

  it("pluralizes errors", () => {
    const line = formatUploadLine({ harness: "opencode", done: 5, total: 40, errors: 2 });
    expect(line).toContain("2 errors");
  });
});

describe("formatRateLimitLine", () => {
  it("rounds ms to whole seconds", () => {
    expect(formatRateLimitLine("claude-code", 12_400)).toBe("claude-code: rate limited — waiting 12s");
  });

  it("never reports 0s for a small wait", () => {
    expect(formatRateLimitLine("claude-code", 200)).toBe("claude-code: rate limited — waiting 1s");
  });
});

describe("formatElapsed", () => {
  it("formats seconds only under a minute", () => {
    expect(formatElapsed(45_000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatElapsed(41 * 60_000 + 12_000)).toBe("41m 12s");
  });

  it("formats hours and minutes", () => {
    expect(formatElapsed(90 * 60_000)).toBe("1h 30m");
  });
});

describe("RateTracker", () => {
  it("reports no rate/ETA with fewer than 2 samples", () => {
    const t = new RateTracker();
    t.record(0, 20);
    expect(t.ratePerMinute(0)).toBeUndefined();
    expect(t.etaMs(0, 100)).toBeUndefined();
    expect(t.batchesRecorded).toBe(1);
  });

  it("computes sessions/minute from a moving window and an ETA for the remainder", () => {
    const t = new RateTracker();
    // 40 sessions over 88.8s ≈ 27/min, matching the real report's pacing.
    t.record(0, 20);
    t.record(88_800, 20);
    const rate = t.ratePerMinute(88_800);
    expect(rate).toBeGreaterThan(26);
    expect(rate).toBeLessThan(28);
    const eta = t.etaMs(88_800, 1166 - 40);
    expect(eta).toBeDefined();
    // ~1126 remaining at ~27/min ≈ 41.7 minutes.
    expect(eta! / 60_000).toBeGreaterThan(40);
    expect(eta! / 60_000).toBeLessThan(43);
  });

  it("gates the ETA on >=2 batches even after old samples age out of the window", () => {
    const t = new RateTracker(1000); // tiny window
    t.record(0, 20);
    t.record(5000, 20); // first sample would be outside a strict window — kept anyway (min 2 samples)
    expect(t.batchesRecorded).toBe(2);
    expect(t.etaMs(5000, 100)).toBeDefined();
  });

  it("returns undefined once nothing remains", () => {
    const t = new RateTracker();
    t.record(0, 20);
    t.record(1000, 20);
    expect(t.etaMs(1000, 0)).toBeUndefined();
  });
});

describe("shouldEmitNonTTY", () => {
  it("always emits the first line", () => {
    expect(shouldEmitNonTTY({ lastEmitMs: 0, lastEmitPct: -1 }, 12_345, 3)).toBe(true);
  });

  it("always emits at completion", () => {
    expect(shouldEmitNonTTY({ lastEmitMs: 10_000, lastEmitPct: 95 }, 10_500, 100)).toBe(true);
  });

  it("suppresses a line under both the 10% step and the 30s interval", () => {
    expect(shouldEmitNonTTY({ lastEmitMs: 10_000, lastEmitPct: 20 }, 15_000, 25)).toBe(false);
  });

  it("emits once >=10% has passed even with time left on the clock", () => {
    expect(shouldEmitNonTTY({ lastEmitMs: 10_000, lastEmitPct: 20 }, 15_000, 30)).toBe(true);
  });

  it("emits once >=30s has passed even with <10% progress", () => {
    expect(shouldEmitNonTTY({ lastEmitMs: 10_000, lastEmitPct: 20 }, 41_000, 22)).toBe(true);
  });

  it("falls back to time-only gating when pct is unknown (opencode's parse phase)", () => {
    const state = { lastEmitMs: 10_000, lastEmitPct: -1 };
    expect(shouldEmitNonTTY(state, 20_000, undefined)).toBe(false);
    expect(shouldEmitNonTTY(state, 41_000, undefined)).toBe(true);
  });
});

describe("ProgressEmitter", () => {
  function makeEmitter(isTTY: boolean, now = { t: 0 }) {
    const writes: string[] = [];
    const logs: string[] = [];
    const emitter = new ProgressEmitter({
      isTTY,
      write: (s) => writes.push(s),
      log: (s) => logs.push(s),
      now: () => now.t,
    });
    return { emitter, writes, logs, now };
  }

  it("TTY: rewrites one line in place with \\r and a clear-to-end-of-line, no newline until finish()", () => {
    const { emitter, writes } = makeEmitter(true);
    emitter.update("claude-code: Parsing 1/3…", 33);
    emitter.update("claude-code: Parsing 2/3…", 66);
    expect(writes).toEqual(["\rclaude-code: Parsing 1/3…\x1b[K", "\rclaude-code: Parsing 2/3…\x1b[K"]);
    emitter.finish();
    expect(writes[2]).toBe("\n");
  });

  it("TTY: finish() is a no-op when nothing was ever written in place", () => {
    const { emitter, writes } = makeEmitter(true);
    emitter.finish();
    expect(writes).toEqual([]);
  });

  it("non-TTY: throttles routine updates (at most every 10% or 30s), never uses \\r", () => {
    const { emitter, writes, logs, now } = makeEmitter(false);
    emitter.update("claude-code: Uploading 10/1000 · 0 errors", 1);
    now.t = 5_000;
    emitter.update("claude-code: Uploading 15/1000 · 0 errors", 1.5); // < 10% step, < 30s — suppressed
    now.t = 31_000;
    emitter.update("claude-code: Uploading 20/1000 · 0 errors", 2); // 30s elapsed — emitted
    expect(writes).toEqual([]);
    expect(logs).toEqual(["claude-code: Uploading 10/1000 · 0 errors", "claude-code: Uploading 20/1000 · 0 errors"]);
  });

  it("non-TTY: interrupt() always shows, bypassing the throttle", () => {
    const { emitter, logs, now } = makeEmitter(false);
    emitter.update("claude-code: Uploading 10/1000 · 0 errors", 1);
    now.t = 1_000; // well under the 30s/10% gate
    emitter.interrupt("claude-code: rate limited — waiting 12s");
    expect(logs).toEqual(["claude-code: Uploading 10/1000 · 0 errors", "claude-code: rate limited — waiting 12s"]);
  });

  it("TTY: interrupt() breaks out of the in-place line so the pause is visible in scrollback", () => {
    const { emitter, writes } = makeEmitter(true);
    emitter.update("claude-code: Uploading 10/1000 · 0 errors", 1);
    emitter.interrupt("claude-code: rate limited — waiting 12s");
    expect(writes).toEqual([
      "\rclaude-code: Uploading 10/1000 · 0 errors\x1b[K",
      "\rclaude-code: rate limited — waiting 12s\x1b[K\n",
    ]);
  });
});
