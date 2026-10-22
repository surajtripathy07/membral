// Cloud UI date/relative-time formatters, gathered here (G3 3D-1) from the
// route/component files that each grew their own. Every variant here was a
// distinct implementation before the move — same output, new home, own name.
// None were merged: differing null-handling, locale, or precision meant a
// merge could change what a page renders.

/**
 * "today" / "3d ago" / "2mo ago" style relative date, matching the
 * convention used elsewhere in the dashboard (e.g. /people). NULL -> "—".
 * Moved from lib/code-sessions/view.ts's formatRelativeDate.
 */
export function formatRelativeDate(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "—";
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  if (days < 31) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/**
 * "Today" / "Yesterday" / "Nd ago" / "Nw ago", falling back to a short
 * month-day date past 30 days. No `now` parameter (reads `new Date()`
 * internally) — a distinct signature from `formatRelativeDate` above, so
 * kept as its own export rather than merged into it.
 * Moved from app/(dashboard)/conversations/page.tsx's formatRelativeDate.
 */
export function formatRelativeDateShort(dateStr: string): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/**
 * Deterministic "YYYY-MM-DD HH:mm UTC" absolute-date formatting for hover
 * titles on client components (e.g. a session timeline row) — NEVER use
 * `Date#toLocaleString`/`toLocaleDateString` for SSR-rendered markup: they
 * resolve the runtime's default locale/timezone, which can (and did, live)
 * differ between the Node SSR pass and the browser's hydration pass,
 * producing a React hydration mismatch. getUTC* accessors are
 * locale/timezone-independent, so server and client always agree.
 * Moved from lib/code-sessions/view.ts's formatAbsoluteUtc.
 */
export function formatAbsoluteUtc(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "YYYY-MM-DD" from an ISO timestamp, UTC — date-only companion to `formatAbsoluteUtc` above.
 *  Moved from lib/code-sessions/view.ts's (private) formatDateOnlyUtc. */
export function formatDateOnlyUtc(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/**
 * Relative time down to seconds/minutes/hours/days granularity — coarser
 * `formatRelativeDate` above only goes down to "today", too coarse for a
 * panel meant to show a sync finishing 40 seconds ago.
 * Moved from app/(dashboard)/pulse/sync-state-content.tsx's formatRelativeShort.
 */
export function formatRelativeShort(iso: string | null, now: Date = new Date()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const ms = now.getTime() - t;
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 10) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** "14 days ago" / "3 hours ago" / "just now" — plain-English age for a status line.
 *  Moved from app/(dashboard)/pulse/sync-state-content.tsx's formatAgoLong. */
export function formatAgoLong(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const mins = Math.floor((now.getTime() - t) / 60_000);
  if (mins < 1) return "just now";
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (mins < 60) return unit(mins, "minute");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return unit(hours, "hour");
  const days = Math.floor(hours / 24);
  return unit(days, "day");
}

/** "today" / "yesterday" / "Nd ago", given both timestamps as ISO strings (no `Date` injection).
 *  Moved from app/(dashboard)/code/[projectId]/pattern-card.tsx's relativeDay. */
export function relativeDay(iso: string | null, nowIso: string): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  const days = Math.max(0, Math.floor((now - then) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

/** "Mon D, YYYY" for a non-nullable ISO string; an unparseable date falls back to the raw string.
 *  Moved from app/(dashboard)/code/stats/issues/issues-content.tsx's fmtAt. */
export function formatDateAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "Mon D, YYYY"; null -> "unknown date", unparseable -> the raw string.
 *  Moved from app/(dashboard)/code/stats/sessions-outcome-table.tsx's formatDate. */
export function formatDateOrUnknown(iso: string | null): string {
  if (!iso) return "unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "YYYY-MM-DD HH:mm UTC"; null -> "Never", unparseable -> "".
 *  Moved from components/device-keys-list.tsx's formatDate. */
export function formatDateTimeUtc(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

/** "Mon D, YYYY"; null -> "", unparseable -> "".
 *  Moved from components/search-result.tsx's formatDate. */
export function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/** "Mon D, YYYY"; null -> "", unparseable -> "Invalid Date" (no NaN guard in the original).
 *  Moved from components/second-brain/node-inspector.tsx's fmtDate. */
export function formatDateLong(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "Mon D" (no year); null -> "".
 *  Moved from app/(dashboard)/pulse/pulse-content.tsx's fmtDate. */
export function formatShortDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** "Mon D", en-US locale explicit; unparseable -> "—" (non-nullable `iso`).
 *  Moved from app/(dashboard)/code/[projectId]/memory-section.tsx's fmtDay. */
export function formatDayEnUs(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** "Mon D" for a UTC calendar day (`isoDay` as "YYYY-MM-DD"); unparseable -> the raw `isoDay`.
 *  Moved from app/(dashboard)/code/stats/overview-content.tsx's fmtDay. */
export function formatDayUtc(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDay;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Mon D, h:mm AM/PM"; null/undefined/unparseable -> null.
 *  Moved from app/(dashboard)/conversations/[id]/message-list.tsx's formatMessageTime. */
export function formatMessageTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
