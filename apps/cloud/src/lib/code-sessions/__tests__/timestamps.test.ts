import { describe, expect, it } from "vitest";
import { usableTimestamp } from "../timestamps";

describe("usableTimestamp", () => {
  it("keeps valid ISO timestamps byte for byte", () => {
    expect(usableTimestamp("2026-07-01T10:00:00.000Z")).toBe("2026-07-01T10:00:00.000Z");
    expect(usableTimestamp("2026-07-01T10:00:00Z")).toBe("2026-07-01T10:00:00Z");
    expect(usableTimestamp("2026-07-01T10:00:00+05:30")).toBe("2026-07-01T10:00:00+05:30");
  });

  it("trims surrounding whitespace", () => {
    expect(usableTimestamp("  2026-07-01T10:00:00.000Z\n")).toBe("2026-07-01T10:00:00.000Z");
  });

  it("treats empty, whitespace, non-string and unparseable values as missing", () => {
    for (const v of [
      "",
      "   ",
      "\t\n",
      "not a date",
      "2026-13-45T00:00:00Z",
      "yesterday",
      "1700000000",
      null,
      undefined,
      5,
    ]) {
      expect(usableTimestamp(v)).toBeNull();
    }
  });
});
