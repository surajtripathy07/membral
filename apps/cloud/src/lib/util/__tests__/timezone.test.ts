import { describe, expect, it } from "vitest";
import {
  dayKeyInZone,
  detectBrowserTimeZone,
  getServerTimeZone,
  isValidTimeZone,
  normalizeTimeZone,
  TZ_COOKIE,
  tzCookieString,
  zonedDayBounds,
} from "../timezone";

describe("isValidTimeZone / normalizeTimeZone", () => {
  it("accepts a real IANA zone", () => {
    expect(isValidTimeZone("Asia/Kathmandu")).toBe(true);
    expect(normalizeTimeZone("Asia/Kathmandu")).toBe("Asia/Kathmandu");
  });

  it("an invalid zone name falls back to UTC", () => {
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(normalizeTimeZone("Not/AZone")).toBe("UTC");
  });

  it("missing/empty falls back to UTC", () => {
    expect(normalizeTimeZone(undefined)).toBe("UTC");
    expect(normalizeTimeZone(null)).toBe("UTC");
    expect(normalizeTimeZone("")).toBe("UTC");
  });
});

describe("getServerTimeZone", () => {
  it("reads a valid cookie value", () => {
    const store = { get: (name: string) => (name === TZ_COOKIE ? { value: "Asia/Kathmandu" } : undefined) };
    expect(getServerTimeZone(store)).toBe("Asia/Kathmandu");
  });

  it("falls back to UTC when the cookie is missing, invalid, or the store is absent", () => {
    expect(getServerTimeZone({ get: () => undefined })).toBe("UTC");
    expect(getServerTimeZone({ get: () => ({ value: "bogus" }) })).toBe("UTC");
    expect(getServerTimeZone(undefined)).toBe("UTC");
    expect(getServerTimeZone(null)).toBe("UTC");
  });
});

describe("detectBrowserTimeZone / tzCookieString", () => {
  it("returns a non-empty zone string (whatever the test runner's own zone is)", () => {
    expect(typeof detectBrowserTimeZone()).toBe("string");
    expect(detectBrowserTimeZone().length).toBeGreaterThan(0);
  });

  it("cookie string carries path=/, 1y max-age, SameSite=Lax", () => {
    expect(tzCookieString("Asia/Kathmandu")).toBe(
      `${TZ_COOKIE}=Asia%2FKathmandu; path=/; max-age=31536000; samesite=lax`,
    );
  });
});

describe("dayKeyInZone: a session at 2026-09-27T20:00Z", () => {
  const iso = "2026-09-27T20:00:00.000Z";

  it("lands on 2026-09-28 in Asia/Kathmandu (UTC+5:45)", () => {
    expect(dayKeyInZone(iso, "Asia/Kathmandu")).toBe("2026-09-28");
  });

  it("lands on 2026-09-27 in UTC", () => {
    expect(dayKeyInZone(iso, "UTC")).toBe("2026-09-27");
  });
});

describe("zonedDayBounds — a Today-bounds test in a non-UTC zone", () => {
  it("Asia/Kathmandu's calendar day starts/ends 5:45 before the same UTC clock day", () => {
    // Local midnight 2026-09-28 00:00 NPT == 2026-09-27T18:15:00Z.
    const noonLocal = Date.parse("2026-09-28T06:15:00.000Z"); // 12:00 NPT
    const bounds = zonedDayBounds(noonLocal, "Asia/Kathmandu");
    expect(new Date(bounds.start).toISOString()).toBe("2026-09-27T18:15:00.000Z");
    expect(new Date(bounds.end).toISOString()).toBe("2026-09-28T18:15:00.000Z");
    expect(bounds.start).toBeLessThanOrEqual(noonLocal);
    expect(bounds.end).toBeGreaterThan(noonLocal);
  });

  it("UTC's bounds are plain midnight-to-midnight", () => {
    const ms = Date.parse("2026-09-27T20:00:00.000Z");
    const bounds = zonedDayBounds(ms, "UTC");
    expect(new Date(bounds.start).toISOString()).toBe("2026-09-27T00:00:00.000Z");
    expect(new Date(bounds.end).toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });
});
