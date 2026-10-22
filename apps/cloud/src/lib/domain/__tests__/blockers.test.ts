import { describe, expect, it } from "vitest";
import { BLOCKER_FRESH_DAYS, blockerAge, blockerFreshCutoff, isFreshBlocker } from "../blockers";

const NOW = Date.parse("2026-10-04T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe("blocker freshness (#436)", () => {
  it("is one 7-day window", () => {
    expect(BLOCKER_FRESH_DAYS).toBe(7);
  });

  it("a blocker 6.9 days old is fresh; 7.1 days old is old", () => {
    expect(isFreshBlocker({ kind: "blocker", created_at: daysAgo(6.9) }, NOW)).toBe(true);
    expect(isFreshBlocker({ kind: "blocker", created_at: daysAgo(7.1) }, NOW)).toBe(false);
  });

  it("never narrows a non-blocker; an unparseable date counts as old", () => {
    expect(isFreshBlocker({ kind: "decision", created_at: daysAgo(90) }, NOW)).toBe(true);
    expect(isFreshBlocker({ kind: "blocker", created_at: "not a date" }, NOW)).toBe(false);
  });

  it("the cutoff is 7 days before now", () => {
    expect(blockerFreshCutoff(NOW)).toBe(daysAgo(7));
  });

  it("labels the age with the shared relative formatter", () => {
    expect(blockerAge(daysAgo(3), NOW)).toBe("3d ago");
    expect(blockerAge(daysAgo(0.25), NOW)).toBe("6h ago");
  });
});
