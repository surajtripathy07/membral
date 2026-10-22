// One shared "which timezone" rule (issue #166, maintainer decision): the
// browser's IANA zone, everywhere a day boundary is drawn — the /code pages'
// 30-day cost read, the Today page, and /api/agent-stats (called by
// cost-line.tsx) all bucket by the SAME zone, read from one place instead of
// three local Intl.DateTimeFormat calls (route.ts's isValidTz/dayString,
// aggregate.ts's own dayKey, cost-line's old browserTimeZone) diverging.
//
// Deliberately isomorphic — no `next/headers` import here, so a "use client"
// file (cost-line.tsx, the cookie-sync mount) can import this module without
// pulling a server-only API into the client bundle. A Server Component reads
// the cookie itself (`await cookies()`, already a Next.js requirement to get
// a cookie store at all) and hands the resolved value to `getServerTimeZone`.

export const TZ_COOKIE = "membral_tz";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

/** Intl throws on an unknown zone name; anything else is accepted as-is (no allowlist — IANA has ~600 names). */
export function isValidTimeZone(tz: string | undefined | null): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** A candidate zone name, falling back to `fallback` ("UTC") when missing or invalid. */
export function normalizeTimeZone(tz: string | undefined | null, fallback = "UTC"): string {
  return isValidTimeZone(tz) ? tz : fallback;
}

/**
 * Server Components only: `getServerTimeZone(await cookies())`. Takes an
 * already-resolved cookie store rather than importing `next/headers` itself
 * (see file doc) — falls back to "UTC" when the cookie is missing, invalid,
 * or `cookies()` itself is unavailable (e.g. a non-request context).
 */
export function getServerTimeZone(
  cookieStore: { get(name: string): { value: string } | undefined } | undefined | null,
): string {
  return normalizeTimeZone(cookieStore?.get(TZ_COOKIE)?.value);
}

/** Browser-side only: the viewer's own IANA zone via Intl, "UTC" if unavailable. */
export function detectBrowserTimeZone(): string {
  try {
    return normalizeTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return "UTC";
  }
}

/** The `document.cookie` assignment that stores the viewer's zone (path=/, 1y, SameSite=Lax). */
export function tzCookieString(tz: string): string {
  return `${TZ_COOKIE}=${encodeURIComponent(tz)}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax`;
}

/** `YYYY-MM-DD` calendar day of `date` in `tz` (en-CA formats as YYYY-MM-DD directly — same trick aggregate.ts/route.ts already use). */
export function dayKeyInZone(date: Date | number | string, tz: string): string {
  const d = date instanceof Date ? date : new Date(date);
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    d,
  );
}

/** The zone's UTC offset (ms to ADD to a UTC instant to get that zone's wall-clock, as a UTC-labelled instant) at `ms` — recomputed per call since it can change across a DST boundary. */
function wallClockOffsetMs(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - ms;
}

/** Epoch-ms of local midnight, in `tz`, for the calendar day `y-m-d` (1-indexed month). */
function zonedMidnight(y: number, m: number, d: number, tz: string): number {
  const utcGuess = Date.UTC(y, m - 1, d);
  return utcGuess - wallClockOffsetMs(utcGuess, tz);
}

/** [start, end) epoch-ms of the local calendar day containing `ms`, in `tz` — a zone-aware `yesterdayBounds`/`dayBoundsAt`. */
export function zonedDayBounds(ms: number, tz: string): { start: number; end: number } {
  const [y, m, d] = dayKeyInZone(ms, tz).split("-").map(Number);
  return { start: zonedMidnight(y, m, d, tz), end: zonedMidnight(y, m, d + 1, tz) };
}
