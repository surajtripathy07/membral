// Goal 2026-09-24 memory-on-prod P7: the [memory-extraction] log line never
// carries record content — only allowlisted ids, counts, costs and codes.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildMemoryExtractionLogPayload,
  logMemoryExtraction,
  MEMORY_EXTRACTION_LOG_MSG,
  type MemoryExtractionLogFields,
} from "../extraction-log";
import { resolveGlobalDailyCeilingUsd, startOfUtcDayIso } from "../global-ceiling";

afterEach(() => vi.restoreAllMocks());

describe("logMemoryExtraction", () => {
  it("emits one JSON line with msg [memory-extraction] and snake_case allowlisted fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logMemoryExtraction({
      event: "done",
      userId: "u1",
      sessionCount: 2,
      runId: "r1",
      costUsd: 0.01,
      durationMs: 1200,
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(spy.mock.calls[0][0]));
    expect(line).toMatchObject({
      level: "info",
      msg: MEMORY_EXTRACTION_LOG_MSG,
      event: "done",
      user_id: "u1",
      session_count: 2,
      run_id: "r1",
      cost_usd: 0.01,
      duration_ms: 1200,
    });
  });

  it("logs fail events at error level", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logMemoryExtraction({
      event: "fail",
      userId: "u1",
      reason: "batch_error",
      error: "db down",
    });
    expect(JSON.parse(String(spy.mock.calls[0][0]))).toMatchObject({
      level: "error",
      event: "fail",
      error: "db down",
    });
  });

  it("never includes content fields, even when a caller smuggles them in", () => {
    const secret = "TRANSCRIPT: please rotate the prod key sk-123";
    const smuggled = {
      event: "run",
      userId: "u1",
      sessionId: "s1",
      text: secret,
      transcript: secret,
      prompt: secret,
      content: secret,
      records: [{ text: secret }],
      quote: secret,
      memory: { text: secret },
    } as unknown as MemoryExtractionLogFields;
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    logMemoryExtraction(smuggled);
    const raw = String(spy.mock.calls[0][0]);
    expect(raw).not.toContain("TRANSCRIPT");
    expect(raw).not.toContain("sk-123");
    const payload = buildMemoryExtractionLogPayload(smuggled);
    expect(Object.keys(payload).sort()).toEqual(["event", "session_id", "user_id"]);
  });

  it("drops non-scalar values for allowlisted keys and truncates error to 200 chars", () => {
    const payload = buildMemoryExtractionLogPayload({
      event: "fail",
      userId: "u1",
      reason: { text: "x" } as unknown as string,
      error: "e".repeat(1000),
    });
    expect(payload.reason).toBeUndefined();
    expect(String(payload.error)).toHaveLength(200);
  });
});

describe("global daily ceiling config", () => {
  it("defaults to $2 when unset, treats invalid or negative as 0 (review m2), honours an explicit value", () => {
    expect(resolveGlobalDailyCeilingUsd({})).toBe(2);
    expect(
      resolveGlobalDailyCeilingUsd({
        MEMBRAL_LLM_GLOBAL_DAILY_CEILING_USD: "abc",
      }),
    ).toBe(0);
    expect(
      resolveGlobalDailyCeilingUsd({
        MEMBRAL_LLM_GLOBAL_DAILY_CEILING_USD: "-1",
      }),
    ).toBe(0);
    expect(
      resolveGlobalDailyCeilingUsd({
        MEMBRAL_LLM_GLOBAL_DAILY_CEILING_USD: "12.5",
      }),
    ).toBe(12.5);
    expect(
      resolveGlobalDailyCeilingUsd({
        MEMBRAL_LLM_GLOBAL_DAILY_CEILING_USD: "0",
      }),
    ).toBe(0);
  });

  it("starts the day at midnight UTC", () => {
    expect(startOfUtcDayIso(new Date("2026-09-24T23:59:59.000Z"))).toBe("2026-09-24T00:00:00.000Z");
  });
});
