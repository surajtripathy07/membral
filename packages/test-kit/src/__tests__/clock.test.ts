import { describe, expect, it } from "vitest";
import { createFixedClock, createIdSequence } from "../index.js";

describe("createFixedClock", () => {
  it("returns the same instant repeatedly until advanced", () => {
    const clock = createFixedClock("2026-01-01T00:00:00.000Z");
    expect(clock.now()).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(clock.now()).toEqual(new Date("2026-01-01T00:00:00.000Z"));
    expect(clock.iso()).toBe("2026-01-01T00:00:00.000Z");
    expect(clock.iso()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("advances by the given number of ms and stays there", () => {
    const clock = createFixedClock("2026-01-01T00:00:00.000Z");
    clock.advance(1500);
    expect(clock.iso()).toBe("2026-01-01T00:00:01.500Z");
    expect(clock.iso()).toBe("2026-01-01T00:00:01.500Z");
    clock.advance(-500);
    expect(clock.iso()).toBe("2026-01-01T00:00:01.000Z");
  });

  it("returns a fresh Date instance on each now() call", () => {
    const clock = createFixedClock("2026-01-01T00:00:00.000Z");
    const a = clock.now();
    const b = clock.now();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  it("throws on an unparseable instant", () => {
    expect(() => createFixedClock("not-a-date")).toThrow(/unparseable instant/);
  });
});

describe("createIdSequence", () => {
  it("yields deterministic, distinct, well-formed ids from the default prefix", () => {
    const next = createIdSequence();
    const a = next();
    const b = next();
    const c = next();
    expect(a).toBe("901d0000-0000-4000-8000-000000000001");
    expect(b).toBe("901d0000-0000-4000-8000-000000000002");
    expect(c).toBe("901d0000-0000-4000-8000-000000000003");
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).toMatch(/^[0-9a-f]{8}-0000-4000-8000-\d{12}$/);
  });

  it("accepts a custom 8-hex-char prefix and is independent across sequences", () => {
    const next1 = createIdSequence("abcdef01");
    const next2 = createIdSequence("abcdef01");
    expect(next1()).toBe("abcdef01-0000-4000-8000-000000000001");
    // A second sequence with the same prefix starts its own counter from 1,
    // proving state is per-sequence, not shared/global.
    expect(next2()).toBe("abcdef01-0000-4000-8000-000000000001");
    expect(next1()).toBe("abcdef01-0000-4000-8000-000000000002");
  });

  it("rejects a prefix that is not 8 lowercase hex chars", () => {
    expect(() => createIdSequence("ABCDEF01")).toThrow(/prefix must be 8 lowercase hex chars/);
    expect(() => createIdSequence("short")).toThrow(/prefix must be 8 lowercase hex chars/);
  });
});
