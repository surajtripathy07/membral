import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const kickExtraction = vi.fn();
vi.mock("../extraction-kick", () => ({ kickExtraction: (...a: unknown[]) => kickExtraction(...a) }));
vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const warm = vi.fn();
vi.mock("@/lib/llm/bundled-embedder", async (orig) => ({
  ...(await orig<typeof import("@/lib/llm/bundled-embedder")>()),
  warmBundledEmbedder: () => warm(),
}));

import {
  EXTRACTION_LOOP_FIRST_TICK_MS,
  EXTRACTION_LOOP_INTERVAL_MS,
  extractionLoopEnabled,
  startExtractionLoop,
  stopExtractionLoop,
} from "../extraction-loop";

const LOCAL = { MEMBRAL_LOCAL: "1", NEXT_RUNTIME: "nodejs" };

describe("extraction loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    kickExtraction.mockReset();
    warm.mockReset();
    kickExtraction.mockResolvedValue({ ok: true });
  });
  afterEach(() => {
    stopExtractionLoop();
    vi.useRealTimers();
  });

  it("starts only in local mode on the nodejs runtime", () => {
    expect(extractionLoopEnabled(LOCAL)).toBe(true);
    expect(extractionLoopEnabled({ NEXT_RUNTIME: "nodejs" })).toBe(false);
    expect(extractionLoopEnabled({ MEMBRAL_LOCAL: "1", NEXT_RUNTIME: "edge" })).toBe(false);
    expect(extractionLoopEnabled({ ...LOCAL, VERCEL: "1" })).toBe(false);
    expect(startExtractionLoop({ NEXT_RUNTIME: "nodejs" })).toBe(false);
    vi.advanceTimersByTime(EXTRACTION_LOOP_INTERVAL_MS * 2);
    expect(kickExtraction).not.toHaveBeenCalled();
  });

  it("MEMBRAL_EXTRACTION_LOOP=0 opts out", () => {
    expect(startExtractionLoop({ ...LOCAL, MEMBRAL_EXTRACTION_LOOP: "0" })).toBe(false);
  });

  it("is a globalThis singleton: a second start does not add a timer", async () => {
    expect(startExtractionLoop(LOCAL)).toBe(true);
    expect(startExtractionLoop(LOCAL)).toBe(false);
    await vi.advanceTimersByTimeAsync(EXTRACTION_LOOP_INTERVAL_MS);
    expect(kickExtraction).toHaveBeenCalledTimes(2); // the first tick plus one interval
    expect(kickExtraction).toHaveBeenCalledWith("kick");
  });

  it("runs the first tick shortly after start, not after a full interval", async () => {
    startExtractionLoop(LOCAL);
    await vi.advanceTimersByTimeAsync(EXTRACTION_LOOP_FIRST_TICK_MS - 1);
    expect(kickExtraction).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(kickExtraction).toHaveBeenCalledTimes(1);
  });

  it("warms the bundled embedder in the background at start (local default), not when a key is configured", () => {
    startExtractionLoop(LOCAL);
    expect(warm).toHaveBeenCalledTimes(1);
    stopExtractionLoop();
    startExtractionLoop({ ...LOCAL, OPENAI_API_KEY: "sk-test" });
    expect(warm).toHaveBeenCalledTimes(1);
  });

  it("never overlaps: a tick during a running kick is skipped", async () => {
    let release: (v: unknown) => void = () => {};
    kickExtraction.mockReturnValue(new Promise((r) => (release = r)));
    startExtractionLoop(LOCAL);
    await vi.advanceTimersByTimeAsync(EXTRACTION_LOOP_INTERVAL_MS * 3);
    expect(kickExtraction).toHaveBeenCalledTimes(1);
    release({ ok: true });
    await vi.advanceTimersByTimeAsync(EXTRACTION_LOOP_INTERVAL_MS);
    expect(kickExtraction).toHaveBeenCalledTimes(2);
  });

  it("an error (thrown or returned) does not stop the loop", async () => {
    kickExtraction.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({ ok: false, error: "db down" });
    startExtractionLoop(LOCAL);
    await vi.advanceTimersByTimeAsync(EXTRACTION_LOOP_INTERVAL_MS * 3);
    expect(kickExtraction).toHaveBeenCalledTimes(4); // first tick + three intervals
  });
});
