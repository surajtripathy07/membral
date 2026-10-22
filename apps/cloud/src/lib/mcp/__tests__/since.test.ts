import { describe, expect, it } from "vitest";
import { InvalidSinceError, resolveSince } from "../since";

const NOW = new Date("2026-09-25T12:00:00.000Z");

describe("resolveSince", () => {
  it("returns null when neither since nor days is given", () => {
    expect(resolveSince({}, NOW)).toBeNull();
    expect(resolveSince({ since: "  " }, NOW)).toBeNull();
  });

  it("reads a plain ISO date as 00:00 UTC that day", () => {
    expect(resolveSince({ since: "2026-09-24" }, NOW)).toBe("2026-09-24T00:00:00.000Z");
  });

  it("accepts a full ISO datetime, with Z, with an offset, or with no zone (read as UTC)", () => {
    expect(resolveSince({ since: "2026-09-24T09:30:00Z" }, NOW)).toBe("2026-09-24T09:30:00.000Z");
    expect(resolveSince({ since: "2026-09-24T09:30:00+05:30" }, NOW)).toBe("2026-09-24T04:00:00.000Z");
    expect(resolveSince({ since: "2026-09-24T09:30" }, NOW)).toBe("2026-09-24T09:30:00.000Z");
    expect(resolveSince({ since: "2026-09-24T09:30:15.250Z" }, NOW)).toBe("2026-09-24T09:30:15.250Z");
  });

  it("days means now minus that many days", () => {
    expect(resolveSince({ days: 1 }, NOW)).toBe("2026-09-24T12:00:00.000Z");
    expect(resolveSince({ days: 365 }, NOW)).toBe("2025-09-25T12:00:00.000Z");
  });

  it("since wins when both are given", () => {
    expect(resolveSince({ since: "2026-09-20", days: 1 }, NOW)).toBe("2026-09-20T00:00:00.000Z");
    // Even a days value that would itself be invalid is ignored.
    expect(resolveSince({ since: "2026-09-20", days: 0 }, NOW)).toBe("2026-09-20T00:00:00.000Z");
  });

  it.each([
    "yesterday",
    "2026-02-30",
    "2026-13-01",
    "24/09/2026",
    "2026-09-24T25:00:00Z",
    "2026-09-24 09:30",
  ])("rejects since=%s with InvalidSinceError naming the accepted formats", (since) => {
    expect(() => resolveSince({ since }, NOW)).toThrow(InvalidSinceError);
    expect(() => resolveSince({ since }, NOW)).toThrow(/Invalid since/);
  });

  it.each([0, 366, 1.5, -3])("rejects days=%s", (days) => {
    expect(() => resolveSince({ days }, NOW)).toThrow(/Invalid days: .*1 to 365/);
  });
});
