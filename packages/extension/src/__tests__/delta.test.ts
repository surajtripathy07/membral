// Unit tests for the delta-sync pure helpers (goal 2026-07-26 step 15, #27/#57
// requirement 7): cursor computation from the cloud manifest, the pagination
// stop condition (including the epoch-seconds conversion boundary that
// CLAUDE.md's Extension Runtime Rules call out explicitly), and
// changed-vs-known partitioning. Cancel-mid-pagination is covered separately
// in claude-fetch-list.test.ts, which exercises fetchConversationList's
// actual loop.
import { describe, expect, it } from "vitest";
import {
  applyCursorOverlap,
  CURSOR_OVERLAP_MS,
  computeCursor,
  computeSyncWindowCutoff,
  isAtOrBeforeCursor,
  isWideningSyncWindow,
  laterCutoff,
  maxKnownUpdatedAt,
  partitionByChangeStatus,
  toIsoTimestamp,
} from "../sync/delta.js";

describe("toIsoTimestamp", () => {
  it("converts ChatGPT-style epoch seconds to ISO", () => {
    // 2024-01-01T00:00:00.000Z in epoch seconds
    expect(toIsoTimestamp(1704067200, true)).toBe("2024-01-01T00:00:00.000Z");
  });

  it("leaves an already-ISO string alone when epochSeconds is false (Claude)", () => {
    expect(toIsoTimestamp("2024-01-01T00:00:00.000Z", false)).toBe("2024-01-01T00:00:00.000Z");
  });

  it("does NOT multiply by 1000 for a string even when epochSeconds is true", () => {
    // Guards the "always convert to ISO" rule from misfiring on a provider
    // that already sent a string -- only a numeric epoch gets the *1000.
    expect(toIsoTimestamp("2024-01-01T00:00:00.000Z", true)).toBe("2024-01-01T00:00:00.000Z");
  });

  it("returns null for null/undefined/empty", () => {
    expect(toIsoTimestamp(null, true)).toBeNull();
    expect(toIsoTimestamp(undefined, true)).toBeNull();
    expect(toIsoTimestamp("", true)).toBeNull();
  });

  it("returns null for unparseable input instead of throwing", () => {
    expect(toIsoTimestamp("not-a-date", false)).toBeNull();
  });
});

describe("isAtOrBeforeCursor", () => {
  it("never stops when cursor is null (no cursor yet -- full sync)", () => {
    expect(isAtOrBeforeCursor("2024-01-01T00:00:00.000Z", null)).toBe(false);
    expect(isAtOrBeforeCursor(null, null)).toBe(false);
  });

  it("stops exactly AT the cursor boundary (equal timestamps)", () => {
    expect(isAtOrBeforeCursor("2024-06-01T00:00:00.000Z", "2024-06-01T00:00:00.000Z")).toBe(true);
  });

  it("does not stop for a timestamp strictly newer than the cursor", () => {
    expect(isAtOrBeforeCursor("2024-06-01T00:00:01.000Z", "2024-06-01T00:00:00.000Z")).toBe(false);
  });

  it("stops for a timestamp older than the cursor", () => {
    expect(isAtOrBeforeCursor("2024-05-01T00:00:00.000Z", "2024-06-01T00:00:00.000Z")).toBe(true);
  });

  it("B2 fix (adversarial review): NEVER treats a missing/unparseable updatedAtIso as at-or-before, even with a cursor set -- it must never be a stop signal (the old behavior truncated the rest of an otherwise-newer page on a single malformed entry)", () => {
    expect(isAtOrBeforeCursor(null, "2024-06-01T00:00:00.000Z")).toBe(false);
  });

  it("boundary case: epoch-seconds conversion lands exactly on the cursor", () => {
    // ChatGPT update_time = 1719792000 -> 2024-07-01T00:00:00.000Z
    const iso = toIsoTimestamp(1719792000, true);
    expect(isAtOrBeforeCursor(iso, "2024-07-01T00:00:00.000Z")).toBe(true);
    // One second later must NOT be at-or-before.
    const isoLater = toIsoTimestamp(1719792001, true);
    expect(isAtOrBeforeCursor(isoLater, "2024-07-01T00:00:00.000Z")).toBe(false);
  });
});

describe("computeCursor", () => {
  it("returns the max updated_at from the manifest for the given provider", () => {
    const idMap = new Map([
      ["claude:a", "2024-01-01T00:00:00.000Z"],
      ["claude:b", "2024-03-01T00:00:00.000Z"],
      ["chatgpt:x", "2024-06-01T00:00:00.000Z"], // different provider, must be ignored
    ]);
    expect(computeCursor(idMap, "claude")).toBe("2024-03-01T00:00:00.000Z");
  });

  it("self-heals a wiped/reinstalled extension: manifest is used regardless of local state", () => {
    const idMap = new Map([["claude:a", "2024-05-01T00:00:00.000Z"]]);
    expect(computeCursor(idMap, "claude")).toBe("2024-05-01T00:00:00.000Z");
  });

  it("returns null when the manifest has nothing for this provider (B1 fix: computeCursor no longer merges in a local fallback -- callers needing one use maxKnownUpdatedAt over local storage separately)", () => {
    const idMap = new Map([["chatgpt:x", "2024-06-01T00:00:00.000Z"]]);
    expect(computeCursor(idMap, "claude")).toBeNull();
  });

  it("returns null for a true fresh start (empty manifest)", () => {
    expect(computeCursor(new Map(), "claude")).toBeNull();
  });

  it("B1 regression: the manifest ALWAYS governs, even though computeCursor no longer takes (or could be tricked by) a local wall-clock value at all", () => {
    // The old signature accepted a third "local cursor" arg and took the
    // LATER of the two -- a local lastSyncAt that raced ahead of the
    // manifest (pure wall-clock, not data) used to win outright. There is
    // no such parameter anymore: the manifest's own max is the only input.
    const idMap = new Map([["claude:a", "2024-01-01T00:00:00.000Z"]]);
    expect(computeCursor(idMap, "claude")).toBe("2024-01-01T00:00:00.000Z");
  });
});

describe("maxKnownUpdatedAt", () => {
  it("returns the max updated_at across a local known map", () => {
    const known = new Map([
      ["a", "2024-01-01T00:00:00.000Z"],
      ["b", "2024-04-01T00:00:00.000Z"],
    ]);
    expect(maxKnownUpdatedAt(known)).toBe("2024-04-01T00:00:00.000Z");
  });

  it("returns null for an empty map", () => {
    expect(maxKnownUpdatedAt(new Map())).toBeNull();
  });
});

describe("applyCursorOverlap", () => {
  it("subtracts the overlap window from a non-null cursor", () => {
    const cursor = "2024-06-01T00:00:00.000Z";
    const expected = new Date(new Date(cursor).getTime() - CURSOR_OVERLAP_MS).toISOString();
    expect(applyCursorOverlap(cursor)).toBe(expected);
  });

  it("leaves a null cursor as null", () => {
    expect(applyCursorOverlap(null)).toBeNull();
  });

  it("accepts a custom overlap window", () => {
    const cursor = "2024-06-01T00:00:00.000Z";
    expect(applyCursorOverlap(cursor, 60_000)).toBe(new Date(new Date(cursor).getTime() - 60_000).toISOString());
  });
});

describe("partitionByChangeStatus", () => {
  it("classifies an id absent from `known` as new", () => {
    const result = partitionByChangeStatus([{ id: "c1", updatedAtIso: "2024-01-01T00:00:00.000Z" }], new Map());
    expect(result.newIds).toEqual(["c1"]);
    expect(result.updatedIds).toEqual([]);
    expect(result.unchangedIds).toEqual([]);
  });

  it("classifies a known id with a strictly newer updatedAtIso as updated", () => {
    const known = new Map([["c1", "2024-01-01T00:00:00.000Z"]]);
    const result = partitionByChangeStatus([{ id: "c1", updatedAtIso: "2024-02-01T00:00:00.000Z" }], known);
    expect(result.updatedIds).toEqual(["c1"]);
    expect(result.newIds).toEqual([]);
    expect(result.unchangedIds).toEqual([]);
  });

  it("classifies a known id with an equal timestamp as unchanged (skip-safe)", () => {
    const known = new Map([["c1", "2024-01-01T00:00:00.000Z"]]);
    const result = partitionByChangeStatus([{ id: "c1", updatedAtIso: "2024-01-01T00:00:00.000Z" }], known);
    expect(result.unchangedIds).toEqual(["c1"]);
  });

  it("classifies a known id with an older timestamp as unchanged", () => {
    const known = new Map([["c1", "2024-06-01T00:00:00.000Z"]]);
    const result = partitionByChangeStatus([{ id: "c1", updatedAtIso: "2024-01-01T00:00:00.000Z" }], known);
    expect(result.unchangedIds).toEqual(["c1"]);
  });

  it("classifies a known id with no usable updatedAtIso as updated (never silently drop a known id)", () => {
    const known = new Map([["c1", "2024-01-01T00:00:00.000Z"]]);
    const result = partitionByChangeStatus([{ id: "c1", updatedAtIso: null }], known);
    expect(result.updatedIds).toEqual(["c1"]);
  });

  it("partitions a mixed page of new/updated/unchanged conversations correctly", () => {
    const known = new Map([
      ["known-unchanged", "2024-03-01T00:00:00.000Z"],
      ["known-updated", "2024-01-01T00:00:00.000Z"],
    ]);
    const result = partitionByChangeStatus(
      [
        { id: "brand-new", updatedAtIso: "2024-05-01T00:00:00.000Z" },
        { id: "known-unchanged", updatedAtIso: "2024-03-01T00:00:00.000Z" },
        { id: "known-updated", updatedAtIso: "2024-04-01T00:00:00.000Z" },
      ],
      known,
    );
    expect(result.newIds).toEqual(["brand-new"]);
    expect(result.updatedIds).toEqual(["known-updated"]);
    expect(result.unchangedIds).toEqual(["known-unchanged"]);
  });
});

// Sync window (#120): a first sync used to fetch a provider's ENTIRE history
// (~10 hours for a large account) -- these cover the cutoff computation, the
// cursor+window combination fed into fetchConversationList's existing
// pagination-stop condition, and the widen-backfill decision.
describe("computeSyncWindowCutoff", () => {
  it("subtracts N days from `now`", () => {
    const now = new Date("2024-07-31T12:00:00.000Z");
    expect(computeSyncWindowCutoff(30, now)).toBe("2024-07-01T12:00:00.000Z");
  });

  it("returns null for `null` days ('All history' -- no floor)", () => {
    expect(computeSyncWindowCutoff(null, new Date("2024-07-31T00:00:00.000Z"))).toBeNull();
  });

  it("defaults `now` to the real current time when not given", () => {
    const before = Date.now();
    const cutoff = computeSyncWindowCutoff(7);
    const after = Date.now();
    const cutoffMs = new Date(cutoff as string).getTime();
    expect(cutoffMs).toBeGreaterThanOrEqual(before - 7 * 24 * 60 * 60 * 1000);
    expect(cutoffMs).toBeLessThanOrEqual(after - 7 * 24 * 60 * 60 * 1000);
  });

  it("a 0-day window resolves to `now` itself -- this low-level primitive does the math it's asked; the guard against a stray/corrupted 0 living further out is common/constants.ts's resolveSyncWindowDays (see constants.test.ts), which clamps BEFORE a day count ever reaches here", () => {
    const now = new Date("2024-07-31T12:00:00.000Z");
    expect(computeSyncWindowCutoff(0, now)).toBe(now.toISOString());
  });
});

describe("laterCutoff", () => {
  it("returns the other side when one input is null (no restriction)", () => {
    expect(laterCutoff(null, "2024-06-01T00:00:00.000Z")).toBe("2024-06-01T00:00:00.000Z");
    expect(laterCutoff("2024-06-01T00:00:00.000Z", null)).toBe("2024-06-01T00:00:00.000Z");
  });

  it("returns null when both inputs are null", () => {
    expect(laterCutoff(null, null)).toBeNull();
  });

  it("returns the LATER (more recent) of two real cutoffs -- the tighter restriction wins", () => {
    // Steady state: the delta cursor (recent activity) is normally far more
    // recent than the window floor -- the cursor should win, preserving the
    // existing fast-delta behavior.
    const deltaCursor = "2024-07-30T00:00:00.000Z";
    const windowFloor = "2024-07-01T00:00:00.000Z"; // 30 days back
    expect(laterCutoff(deltaCursor, windowFloor)).toBe(deltaCursor);
  });

  it("picks the window floor when it is MORE recent than the delta cursor (a narrow window with stale activity)", () => {
    const deltaCursor = "2024-06-01T00:00:00.000Z"; // nothing touched in a while
    const windowFloor = "2024-07-01T00:00:00.000Z"; // narrow window, more recent
    expect(laterCutoff(deltaCursor, windowFloor)).toBe(windowFloor);
  });

  it("is symmetric", () => {
    const a = "2024-01-01T00:00:00.000Z";
    const b = "2024-06-01T00:00:00.000Z";
    expect(laterCutoff(a, b)).toBe(laterCutoff(b, a));
  });
});

describe("isWideningSyncWindow", () => {
  it("never a widen when there is no previous floor (fresh install, or already fully synced)", () => {
    expect(isWideningSyncWindow(null, "2024-01-01T00:00:00.000Z")).toBe(false);
    expect(isWideningSyncWindow(null, null)).toBe(false);
  });

  it("widening to 'All history' (null) from any real previous floor is always a widen", () => {
    expect(isWideningSyncWindow("2024-06-01T00:00:00.000Z", null)).toBe(true);
  });

  it("a strictly earlier new cutoff (moving 30 days -> 90 days) is a widen", () => {
    // 90-day floor is earlier (further back) than a 30-day floor.
    const oldFloor = "2024-07-01T00:00:00.000Z"; // 30 days back from some `now`
    const newFloor = "2024-05-01T00:00:00.000Z"; // 90 days back from the same `now`
    expect(isWideningSyncWindow(oldFloor, newFloor)).toBe(true);
  });

  it("an unchanged or narrower window is NOT a widen", () => {
    const oldFloor = "2024-05-01T00:00:00.000Z";
    expect(isWideningSyncWindow(oldFloor, oldFloor)).toBe(false); // unchanged
    expect(isWideningSyncWindow(oldFloor, "2024-07-01T00:00:00.000Z")).toBe(false); // narrower (later)
  });
});
