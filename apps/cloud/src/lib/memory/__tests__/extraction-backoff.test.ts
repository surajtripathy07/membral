// Issue #339: the cron's per-user backoff after a counted failure (rule 4).
import { describe, expect, it } from "vitest";
import {
  isMemoryBackoffActive,
  MEMORY_BACKOFF_BASE_MS,
  MEMORY_LATE_START_NO_PROGRESS_REASON,
  memoryBackoffMs,
  partitionUsersForKick,
} from "../extraction-backoff";

const NOW = new Date("2026-09-29T12:00:00Z");
const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();

describe("isMemoryBackoffActive", () => {
  it("waits 15 min after the first counted failure and 30 min after the second", () => {
    expect(MEMORY_BACKOFF_BASE_MS).toBe(15 * 60_000);
    expect(memoryBackoffMs(0)).toBe(0);
    expect(memoryBackoffMs(1)).toBe(15 * 60_000);
    expect(memoryBackoffMs(2)).toBe(30 * 60_000);
  });

  it("attempts 0 never backs off, however recent", () => {
    expect(isMemoryBackoffActive(0, ago(0), NOW)).toBe(false);
    expect(isMemoryBackoffActive(0, NOW, NOW)).toBe(false);
  });

  it("attempts 1: inside 15 min backs off, beyond it does not", () => {
    expect(isMemoryBackoffActive(1, ago(5), NOW)).toBe(true);
    expect(isMemoryBackoffActive(1, ago(14.9), NOW)).toBe(true);
    expect(isMemoryBackoffActive(1, ago(15), NOW)).toBe(false);
    expect(isMemoryBackoffActive(1, ago(20), NOW)).toBe(false);
  });

  it("attempts 2: inside its longer 30 min window backs off, beyond it does not", () => {
    expect(isMemoryBackoffActive(2, ago(20), NOW)).toBe(true);
    expect(isMemoryBackoffActive(2, ago(29.9), NOW)).toBe(true);
    expect(isMemoryBackoffActive(2, ago(31), NOW)).toBe(false);
  });

  it("an unreadable time does not back off", () => {
    expect(isMemoryBackoffActive(1, null, NOW)).toBe(false);
    expect(isMemoryBackoffActive(1, "not a date", NOW)).toBe(false);
  });
});

describe("partitionUsersForKick", () => {
  it("skips a recently failed user, kicks a clean user and an expired-lease-only user", () => {
    const r = partitionUsersForKick(
      [
        { user_id: "A", status: "pending", attempts: 1, updated_at: ago(5) },
        { user_id: "B", status: "pending", attempts: 0, updated_at: ago(1) },
        { user_id: "C", status: "running", attempts: 1, updated_at: ago(3) },
      ],
      NOW,
    );
    expect(r).toEqual({ kick: ["B", "C"], skippedBackoff: ["A"] });
  });

  it("uses the user's MOST RECENT counted failure", () => {
    // Older row with attempts 2 at 20 min (inside 30) but the newest failure (attempts 1, 16 min) has expired.
    const r = partitionUsersForKick(
      [
        { user_id: "A", status: "pending", attempts: 2, updated_at: ago(20) },
        { user_id: "A", status: "pending", attempts: 1, updated_at: ago(16) },
      ],
      NOW,
    );
    expect(r).toEqual({ kick: ["A"], skippedBackoff: [] });
  });

  it("a release that made progress or started late is not a counted failure", () => {
    const r = partitionUsersForKick(
      [
        { user_id: "A", status: "pending", attempts: 1, updated_at: ago(1), last_reason: "deadline_partial" },
        {
          user_id: "B",
          status: "pending",
          attempts: 2,
          updated_at: ago(1),
          last_reason: MEMORY_LATE_START_NO_PROGRESS_REASON,
        },
        { user_id: "C", status: "pending", attempts: 1, updated_at: ago(1), last_reason: "windows_failed" },
      ],
      NOW,
    );
    expect(r).toEqual({ kick: ["A", "B"], skippedBackoff: ["C"] });
  });
});
