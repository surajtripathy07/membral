import { APIConnectionError } from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  backoffMultiplier,
  currentBackoffDelayMs,
  DEFAULT_MAX_RETRIES,
  INITIAL_DELAY_MS,
  MAX_DELAY_MS,
  resetBackoffState,
  withLlmRetry,
} from "../retry";

const httpErr = (status: number, headers?: Record<string, string>) =>
  Object.assign(new Error(`http ${status}`), { status, headers });

function harness() {
  const sleeps: number[] = [];
  const deps = {
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    now: () => 0,
  };
  return { sleeps, deps };
}

function failing(errs: unknown[], final = "ok") {
  const fn = vi.fn(async () => {
    if (errs.length) throw errs.shift();
    return final;
  });
  return fn;
}

describe("withLlmRetry", () => {
  beforeEach(() => resetBackoffState());

  it("429 without Retry-After waits the current delay, never zero", async () => {
    const { sleeps, deps } = harness();
    const fn = failing([httpErr(429)]);
    await expect(withLlmRetry(fn, { deps })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([INITIAL_DELAY_MS]);
  });

  it("429 with Retry-After seconds / retry-after-ms honors the header", async () => {
    const a = harness();
    await withLlmRetry(failing([httpErr(429, { "retry-after": "7" })]), { deps: a.deps });
    expect(a.sleeps).toEqual([7000]);
    const b = harness();
    await withLlmRetry(failing([httpErr(429, { "retry-after-ms": "2500" })]), { deps: b.deps });
    expect(b.sleeps).toEqual([2500]);
  });

  it("reads a Headers object and clamps Retry-After: 0 to the floor", async () => {
    const { sleeps, deps } = harness();
    await withLlmRetry(failing([httpErr(429, new Headers({ "retry-after": "0" }) as never)]), { deps });
    expect(sleeps).toEqual([INITIAL_DELAY_MS]);
  });

  it("a Retry-After beyond the max wait is not waited out", async () => {
    const { sleeps, deps } = harness();
    const e = httpErr(429, { "retry-after": "600" });
    const fn = failing([e]);
    await expect(withLlmRetry(fn, { deps })).rejects.toBe(e);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
  });

  it("growth: multiplier shrinks as delay grows, delay is capped", async () => {
    const m = [1000, 4000, 16000, 60000].map(backoffMultiplier);
    expect(m[0]).toBeGreaterThan(m[1]);
    expect(m[1]).toBeGreaterThan(m[2]);
    expect(m[2]).toBeGreaterThan(m[3]);
    expect(m[3]).toBeGreaterThan(1);
    const { sleeps, deps } = harness();
    const fn = failing(Array.from({ length: 5 }, () => httpErr(429)));
    await withLlmRetry(fn, { maxRetries: 5, deps });
    expect(sleeps[0]).toBe(1000);
    for (let i = 1; i < sleeps.length; i++) expect(sleeps[i]).toBeGreaterThan(sleeps[i - 1]);
    const ratios = sleeps.slice(1).map((s, i) => s / sleeps[i]);
    for (let i = 1; i < ratios.length; i++) expect(ratios[i]).toBeLessThan(ratios[i - 1]);
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(MAX_DELAY_MS);
    expect(currentBackoffDelayMs()).toBeLessThanOrEqual(MAX_DELAY_MS);
  });

  it("success decays by 0.9x, never resets, floor is the initial delay", async () => {
    const { deps } = harness();
    await withLlmRetry(failing([httpErr(503), httpErr(503)]), { deps });
    const afterFail = currentBackoffDelayMs();
    expect(afterFail).toBeGreaterThan(INITIAL_DELAY_MS);
    // the successful call above already decayed once
    await withLlmRetry(async () => 1, { deps });
    const next = currentBackoffDelayMs();
    expect(next).toBeCloseTo(afterFail * 0.9, 6);
    expect(next).toBeGreaterThan(INITIAL_DELAY_MS);
    for (let i = 0; i < 200; i++) await withLlmRetry(async () => 1, { deps });
    expect(currentBackoffDelayMs()).toBe(INITIAL_DELAY_MS);
  });

  it("state persists across calls: next 429 waits the elevated delay", async () => {
    const { sleeps, deps } = harness();
    await withLlmRetry(failing([httpErr(429)]), { deps });
    await withLlmRetry(failing([httpErr(429)]), { deps });
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] * 0.9);
  });

  it("retries 5xx and connection errors", async () => {
    const { sleeps, deps } = harness();
    const conn = new APIConnectionError({ message: "boom" });
    await expect(withLlmRetry(failing([httpErr(502), conn]), { deps })).resolves.toBe("ok");
    expect(sleeps).toHaveLength(2);
  });

  it("does not retry 400 / 401 / 404", async () => {
    for (const status of [400, 401, 404]) {
      const { sleeps, deps } = harness();
      const e = httpErr(status);
      const fn = failing([e]);
      await expect(withLlmRetry(fn, { deps })).rejects.toBe(e);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleeps).toEqual([]);
    }
  });

  it("attempts are bounded and the last original error is rethrown", async () => {
    const { sleeps, deps } = harness();
    const errs = Array.from({ length: 20 }, () => httpErr(429));
    const fourth = errs[3];
    const fn = failing(errs);
    await expect(withLlmRetry(fn, { maxRetries: 3, deps })).rejects.toBe(fourth);
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleeps).toHaveLength(3);
    const d = harness();
    const fn2 = failing(Array.from({ length: 20 }, () => httpErr(500)));
    await expect(withLlmRetry(fn2, { deps: d.deps })).rejects.toThrow("http 500");
    expect(fn2).toHaveBeenCalledTimes(DEFAULT_MAX_RETRIES + 1);
  });
});
