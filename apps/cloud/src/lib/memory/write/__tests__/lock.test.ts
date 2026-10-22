// G2 step 2.4f: the pure lock shaping lifted out of write.ts's
// setMemoryExtractionLock. isMemoryExtractionLockHeld keeps its existing
// coverage in lib/memory/__tests__/write.test.ts; these pin the lock value
// and the returned local props view it produced before.
import { describe, expect, it } from "vitest";
import { buildLock, isMemoryExtractionLockHeld, withLock } from "../lock";

const AT = "2026-09-28T10:00:00.000Z";

describe("buildLock", () => {
  it("sets at then run_id, nothing else", () => {
    const lock = buildLock(AT, "run-1");
    expect(lock).toEqual({ at: AT, run_id: "run-1" });
    expect(Object.keys(lock)).toEqual(["at", "run_id"]);
  });

  it("builds a lock isMemoryExtractionLockHeld reads as held at its own timestamp", () => {
    expect(isMemoryExtractionLockHeld({ memory_extraction_lock: buildLock(AT, "run-1") }, Date.parse(AT))).toBe(true);
  });
});

describe("withLock", () => {
  it("returns a new props object with the lock added last, leaving the input untouched", () => {
    const props = { memory_extraction: { status: "done" }, other: 1 };
    const lock = buildLock(AT, "run-1");
    const out = withLock(props, lock);
    expect(out).toEqual({ memory_extraction: { status: "done" }, other: 1, memory_extraction_lock: lock });
    expect(Object.keys(out)).toEqual(["memory_extraction", "other", "memory_extraction_lock"]);
    expect(out).not.toBe(props);
    expect(props).toEqual({ memory_extraction: { status: "done" }, other: 1 });
  });

  it("replaces an existing lock in place (key keeps its position)", () => {
    const old = buildLock("2026-09-28T09:00:00.000Z", "run-0");
    const lock = buildLock(AT, "run-1");
    const out = withLock({ memory_extraction_lock: old, other: 1 }, lock);
    expect(out.memory_extraction_lock).toBe(lock);
    expect(Object.keys(out)).toEqual(["memory_extraction_lock", "other"]);
  });
});
