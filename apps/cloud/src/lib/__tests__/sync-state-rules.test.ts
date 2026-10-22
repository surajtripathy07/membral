import { describe, expect, it } from "vitest";
import {
  ageMs,
  CHAT_QUIET_NO_ITEM_MS,
  CHAT_STALE_MS,
  CODE_STALE_MS,
  deriveChatSourceState,
  deriveCodeHarnessState,
  deriveSourceState,
  minutesSince,
  SYNCING_WINDOW_MS,
} from "../sync-state-rules";

const NOW = new Date("2026-08-26T12:00:00.000Z");
const isoMinutesAgo = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
const isoMsAgo = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

describe("ageMs / minutesSince", () => {
  it("returns null for missing/unparseable input", () => {
    expect(ageMs(null, NOW)).toBeNull();
    expect(ageMs(undefined, NOW)).toBeNull();
    expect(ageMs("not-a-date", NOW)).toBeNull();
    expect(minutesSince(null, NOW)).toBeNull();
  });

  it("computes whole minutes, floored at 0 for a future timestamp", () => {
    expect(minutesSince(isoMinutesAgo(5), NOW)).toBe(5);
    expect(minutesSince(new Date(NOW.getTime() + 60_000).toISOString(), NOW)).toBe(0);
  });
});

describe("deriveSourceState (shared decision tree)", () => {
  const base = { staleMs: CHAT_STALE_MS, quietNoItemMs: CHAT_QUIET_NO_ITEM_MS };

  it("never: nothing has ever been seen for this source", () => {
    expect(deriveSourceState({ ...base, hasEverSeen: false, lastRunAt: null, lastItemAt: null }, NOW)).toBe("never");
    // Even if lastRunAt/lastItemAt were somehow set, hasEverSeen=false wins.
    expect(
      deriveSourceState(
        { ...base, hasEverSeen: false, lastRunAt: isoMinutesAgo(1), lastItemAt: isoMinutesAgo(1) },
        NOW,
      ),
    ).toBe("never");
  });

  it("syncing: last run finished within SYNCING_WINDOW_MS", () => {
    expect(
      deriveSourceState(
        { ...base, hasEverSeen: true, lastRunAt: isoMsAgo(SYNCING_WINDOW_MS - 1), lastItemAt: null },
        NOW,
      ),
    ).toBe("syncing");
  });

  it("stale: no run ever recorded despite hasEverSeen (pre-heartbeat content)", () => {
    expect(deriveSourceState({ ...base, hasEverSeen: true, lastRunAt: null, lastItemAt: isoMinutesAgo(1) }, NOW)).toBe(
      "stale",
    );
  });

  it("stale: last run older than staleMs", () => {
    expect(
      deriveSourceState({ ...base, hasEverSeen: true, lastRunAt: isoMsAgo(base.staleMs + 1), lastItemAt: null }, NOW),
    ).toBe("stale");
  });

  it("quiet: run is fresh but no item within quietNoItemMs", () => {
    expect(
      deriveSourceState(
        { ...base, hasEverSeen: true, lastRunAt: isoMinutesAgo(10), lastItemAt: isoMsAgo(base.quietNoItemMs + 1) },
        NOW,
      ),
    ).toBe("quiet");
  });

  it("quiet: run is fresh but lastItemAt is null", () => {
    expect(deriveSourceState({ ...base, hasEverSeen: true, lastRunAt: isoMinutesAgo(10), lastItemAt: null }, NOW)).toBe(
      "quiet",
    );
  });

  it("idle: fresh run, fresh item", () => {
    expect(
      deriveSourceState(
        { ...base, hasEverSeen: true, lastRunAt: isoMinutesAgo(120), lastItemAt: isoMinutesAgo(120) },
        NOW,
      ),
    ).toBe("idle");
  });

  it("boundary: exactly SYNCING_WINDOW_MS old still counts as syncing (<=)", () => {
    expect(
      deriveSourceState({ ...base, hasEverSeen: true, lastRunAt: isoMsAgo(SYNCING_WINDOW_MS), lastItemAt: null }, NOW),
    ).toBe("syncing");
  });

  it("boundary: exactly staleMs old is NOT yet stale (only strictly greater is)", () => {
    expect(
      deriveSourceState(
        { ...base, hasEverSeen: true, lastRunAt: isoMsAgo(base.staleMs), lastItemAt: isoMinutesAgo(1) },
        NOW,
      ),
    ).toBe("idle");
  });
});

describe("deriveChatSourceState / deriveCodeHarnessState (threshold wiring)", () => {
  it("chat uses CHAT_STALE_MS: just past code's 2h threshold is NOT stale for chat", () => {
    const lastRunAt = isoMsAgo(CODE_STALE_MS + 1000); // > code stale, well within chat's 36h
    expect(deriveChatSourceState({ hasEverSeen: true, lastRunAt, lastItemAt: lastRunAt }, NOW)).toBe("idle");
  });

  it("code uses CODE_STALE_MS: 3h since last run is stale for code but not for chat", () => {
    const lastRunAt = isoMsAgo(3 * 60 * 60 * 1000);
    expect(deriveCodeHarnessState({ hasEverSeen: true, lastRunAt, lastItemAt: lastRunAt }, NOW)).toBe("stale");
    expect(deriveChatSourceState({ hasEverSeen: true, lastRunAt, lastItemAt: lastRunAt }, NOW)).toBe("idle");
  });
});
