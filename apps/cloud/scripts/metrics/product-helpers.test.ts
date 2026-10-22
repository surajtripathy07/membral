import { describe, expect, it } from "vitest";
import {
  bucketByUser,
  dailyMatrix,
  flagGapsAfterFirstActivity,
  formatTable,
  groupCount,
  lastNDaysUTC,
  money,
  pct,
  percentile,
  utcDayKey,
  utcIsoWeekKey,
} from "./product-helpers";

describe("utcDayKey", () => {
  it("truncates an ISO timestamp to its UTC calendar day", () => {
    expect(utcDayKey("2026-09-25T23:59:00.000Z")).toBe("2026-09-25");
    expect(utcDayKey(new Date("2026-01-01T00:00:00.000Z"))).toBe("2026-01-01");
  });
});

describe("utcIsoWeekKey", () => {
  it("assigns Monday-start ISO weeks, including a year-boundary week", () => {
    expect(utcIsoWeekKey("2026-09-25T00:00:00.000Z")).toBe("2026-W39");
    // 2025-12-29 (Mon) belongs to ISO week 1 of 2026 (contains Jan 1 Thu... verify via known anchor)
    expect(utcIsoWeekKey("2026-01-01T00:00:00.000Z")).toBe("2026-W01");
  });
});

describe("lastNDaysUTC", () => {
  it("returns n ascending day keys ending on the given day", () => {
    const days = lastNDaysUTC(3, new Date("2026-09-25T12:00:00.000Z"));
    expect(days).toEqual(["2026-09-23", "2026-09-24", "2026-09-25"]);
  });
});

describe("percentile", () => {
  it("nearest-rank p50/p95 over an ascending array", () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(sorted, 50)).toBe(5);
    expect(percentile(sorted, 95)).toBe(10);
  });
  it("returns null for an empty array", () => {
    expect(percentile([], 50)).toBeNull();
  });
});

describe("groupCount / bucketByUser", () => {
  it("counts by key and buckets rows by user_id", () => {
    const rows = [{ user_id: "a", k: "x" }, { user_id: "a", k: "y" }, { user_id: "b", k: "x" }];
    expect(groupCount(rows, (r) => r.k)).toEqual(new Map([["x", 2], ["y", 1]]));
    const byUser = bucketByUser(rows);
    expect(byUser.get("a")?.length).toBe(2);
    expect(byUser.get("b")?.length).toBe(1);
  });
});

describe("dailyMatrix + flagGapsAfterFirstActivity", () => {
  it("flags a key going quiet after activity, never before its first day", () => {
    const dayKeys = ["2026-09-01", "2026-09-02", "2026-09-03"];
    const rows = [
      { day: "2026-09-01", k: "main" },
      { day: "2026-09-03", k: "main" },
      { day: "2026-09-02", k: "sub-agent" },
    ];
    const { keys, counts } = dailyMatrix(rows, (r) => r.day, (r) => r.k, dayKeys);
    expect(keys).toEqual(["main", "sub-agent"]);
    const flags = flagGapsAfterFirstActivity(dayKeys, keys, counts);
    // "main" is active on day1 and day3 but silent on day2 -> flagged.
    expect(flags.get("2026-09-02")).toEqual(["main"]);
    // "sub-agent" is never flagged before its first (and only) active day.
    expect(flags.get("2026-09-01")).toBeUndefined();
    // ...but IS flagged on day3, having gone quiet after its day2 activity.
    expect(flags.get("2026-09-03")).toEqual(["sub-agent"]);
  });
});

describe("pct / money", () => {
  it("formats percentages safely and USD to 4dp", () => {
    expect(pct(1, 4)).toBe("25.0%");
    expect(pct(0, 0)).toBe("n/a");
    expect(money(1.5)).toBe("$1.5000");
  });
});

describe("formatTable", () => {
  it("pads columns to the widest cell", () => {
    const out = formatTable(["day", "count"], [["2026-09-25", 3], ["2026-09-01", 12]]);
    const lines = out.split("\n");
    expect(lines[0]).toBe("day         count");
    expect(lines[2]).toBe("2026-09-25  3    ");
  });
});
