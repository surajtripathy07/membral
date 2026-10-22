// Unit tests for RateController's cancellation-aware wait() (MN5 fix,
// adversarial review): a rate-limit backoff wait used to always block for
// its full duration (up to 120s at the top of the backoff curve) with no way
// to observe a cancellation request mid-wait.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateController } from "../common/rate-controller.js";

describe("RateController.wait", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("without isCancelled, behaves exactly as before -- waits the full delay", async () => {
    const rc = new RateController("test");
    rc.on429(); // bumps delayMs above the initial value
    const before = rc.stats.currentDelayMs;
    expect(before).toBeGreaterThan(0);

    const promise = rc.wait();
    await vi.advanceTimersByTimeAsync(before);
    await promise; // resolves once the full delay has elapsed
  });

  it("MN5 fix: resolves early once isCancelled() becomes true, without waiting out the full delay", async () => {
    const rc = new RateController("test");
    rc.on429();
    rc.on429(); // push the delay up further so the difference is unambiguous
    const fullDelay = rc.stats.currentDelayMs;
    expect(fullDelay).toBeGreaterThan(200);

    let cancelled = false;
    const isCancelled = () => cancelled;

    const promise = rc.wait(isCancelled);
    let resolved = false;
    promise.then(() => {
      resolved = true;
    });

    // Advance well past the first cancellation poll tick, but nowhere near
    // the full delay -- it must still be pending because isCancelled() is
    // still false.
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(false);

    cancelled = true;
    // The poll interval is <= 100ms, so this is enough for the pending poll
    // to observe the flag and resolve, well short of `fullDelay`.
    await vi.advanceTimersByTimeAsync(100);
    expect(resolved).toBe(true);
  });

  it("does not throw or hang when isCancelled is provided but delayMs is 0", async () => {
    const rc = new RateController("test", { initialDelayMs: 0, minDelayMs: 0 });
    await expect(rc.wait(() => false)).resolves.toBeUndefined();
  });
});
