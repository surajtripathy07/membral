import { afterEach, describe, expect, it, vi } from "vitest";
import { startMaintenance } from "../maintenance";

afterEach(() => vi.useRealTimers());

describe("store maintenance", () => {
  it("analyzes on the interval only when a write happened", async () => {
    vi.useFakeTimers();
    const analyze = vi.fn(async () => undefined);
    const m = startMaintenance(analyze, { intervalMs: 1000 });
    await vi.advanceTimersByTimeAsync(3000);
    expect(analyze).not.toHaveBeenCalled();
    m.noteWrite();
    await vi.advanceTimersByTimeAsync(1000);
    expect(analyze).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(analyze).toHaveBeenCalledTimes(1);
    m.stop();
  });

  it("analyzes after afterWrites writes without waiting for the interval", async () => {
    const analyze = vi.fn(async () => undefined);
    const m = startMaintenance(analyze, { intervalMs: 3_600_000, afterWrites: 3 });
    m.noteWrite();
    m.noteWrite();
    expect(analyze).not.toHaveBeenCalled();
    m.noteWrite();
    await m.analyzeNow();
    expect(analyze).toHaveBeenCalledTimes(1);
    m.stop();
  });

  it("reports a failing analyze and keeps going", async () => {
    const onError = vi.fn();
    const m = startMaintenance(
      async () => {
        throw new Error("boom");
      },
      { onError },
    );
    await m.analyzeNow();
    expect(onError).toHaveBeenCalledTimes(1);
    m.stop();
  });
});
