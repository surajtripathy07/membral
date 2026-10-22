// G2 step 2.4e: the pure row shaping lifted out of write.ts's retire writes.
// The updates and their filters stay in write.ts; these pin the payloads
// (keys and key order) and the returned-id read they produced before.
import { describe, expect, it } from "vitest";
import { RERUN_RETIRE_REASON, RESOLVED_LATER_RETIRE_REASON } from "@/lib/domain/retire-reasons";
import { resolvedBlockerUpdate, retireUpdate, returnedIds } from "../retire";

const AT = "2026-09-28T10:00:00.000Z";

describe("retireUpdate", () => {
  it("sets retired_at then retire_reason, nothing else", () => {
    const update = retireUpdate(AT, RERUN_RETIRE_REASON);
    expect(update).toEqual({ retired_at: AT, retire_reason: RERUN_RETIRE_REASON });
    expect(Object.keys(update)).toEqual(["retired_at", "retire_reason"]);
  });
});

describe("resolvedBlockerUpdate", () => {
  it("carries the receipt into the migration 092 columns, in the original order", () => {
    const update = resolvedBlockerUpdate(AT, RESOLVED_LATER_RETIRE_REASON, {
      resolvedBySessionId: "sess-2",
      quote: "the key is set now",
      turnIdx: 7,
    });
    expect(update).toEqual({
      retired_at: AT,
      retire_reason: RESOLVED_LATER_RETIRE_REASON,
      resolved_by_session_id: "sess-2",
      resolution_quote: "the key is set now",
      resolution_turn_idx: 7,
    });
    expect(Object.keys(update)).toEqual([
      "retired_at",
      "retire_reason",
      "resolved_by_session_id",
      "resolution_quote",
      "resolution_turn_idx",
    ]);
  });

  it("drops receipt fields beyond the three columns", () => {
    const update = resolvedBlockerUpdate(AT, "resolved_observed", {
      memoryId: "m1",
      resolvedBySessionId: "s",
      quote: "q",
      turnIdx: 0,
    } as Parameters<typeof resolvedBlockerUpdate>[2]);
    expect(update).not.toHaveProperty("memoryId");
    expect(update.retire_reason).toBe("resolved_observed");
  });
});

describe("returnedIds", () => {
  it("maps returned rows to their ids in order", () => {
    expect(returnedIds([{ id: "b" }, { id: "a", retire_reason: "rerun" }])).toEqual(["b", "a"]);
  });

  it("reads a null result as no ids", () => {
    expect(returnedIds(null)).toEqual([]);
    expect(returnedIds(undefined)).toEqual([]);
  });
});
