// Old-vs-new oracle tables for the G3 3D-1 formatter move (zero behaviour
// change). Each block below is the ORIGINAL implementation, pasted verbatim
// from base commit 0586916, kept private to this file as `old*`, and
// compared row-by-row against the moved export from lib/format/* for the
// same inputs. We assert equality of outputs rather than hardcoding expected
// strings, so the table only needs to cover the input space, not the
// arithmetic.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  formatAbsoluteUtc,
  formatAgoLong,
  formatDate,
  formatDateAt,
  formatDateLong,
  formatDateOnlyUtc,
  formatDateOrUnknown,
  formatDateTimeUtc,
  formatDayEnUs,
  formatDayUtc,
  formatMessageTime,
  formatRelativeDate,
  formatRelativeDateShort,
  formatRelativeShort,
  formatShortDate,
  relativeDay,
} from "@/lib/format/dates";
import { formatDuration } from "@/lib/format/durations";
import { formatCostUsd, formatSimilarity, formatTokenCount } from "@/lib/format/numbers";
import { truncatePathLeft } from "@/lib/format/text";

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Oracles — verbatim originals.
// ---------------------------------------------------------------------------

// lib/code-sessions/view.ts:273
function oldFormatRelativeDate(iso: string | null, now: Date = new Date()): string {
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

// app/(dashboard)/conversations/page.tsx:330
function oldFormatRelativeDateShort(dateStr: string): string {
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

// lib/code-sessions/view.ts:296
function oldFormatAbsoluteUtc(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// lib/code-sessions/view.ts:239
function oldFormatDateOnlyUtc(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

// app/(dashboard)/pulse/sync-state-content.tsx:30
function oldFormatRelativeShort(iso: string | null, now: Date = new Date()): string {
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

// app/(dashboard)/pulse/sync-state-content.tsx:106
function oldFormatAgoLong(iso: string | null, now: Date = new Date()): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const mins = Math.floor((now.getTime() - t) / 60_000);
  if (mins < 1) return "just now";
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"} ago`;
  if (mins < 60) return unit(mins, "minute");
  const hours = Math.floor(mins / 60);
  if (hours < 24) return unit(hours, "hour");
  return unit(Math.floor(hours / 24), "day");
}

// app/(dashboard)/code/[projectId]/pattern-card.tsx:13
function oldRelativeDay(iso: string | null, nowIso: string): string | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (!Number.isFinite(then) || !Number.isFinite(now)) return null;
  const days = Math.max(0, Math.floor((now - then) / 86_400_000));
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  return `${days}d ago`;
}

// app/(dashboard)/code/stats/issues/issues-content.tsx:92
function oldFormatDateAt(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// app/(dashboard)/code/stats/sessions-outcome-table.tsx:37
function oldFormatDateOrUnknown(iso: string | null): string {
  if (!iso) return "unknown date";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// components/device-keys-list.tsx:30
function oldFormatDateTimeUtc(iso: string | null): string {
  if (!iso) return "Never";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

// components/search-result.tsx:13
function oldFormatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// components/search-result.tsx:24
function oldFormatSimilarity(score: number | null): string | null {
  if (score === null || score === undefined) return null;
  return `${Math.round(score * 100)}%`;
}

// components/second-brain/node-inspector.tsx:64
function oldFormatDateLong(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// app/(dashboard)/pulse/pulse-content.tsx:45
function oldFormatShortDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// app/(dashboard)/code/[projectId]/memory-section.tsx:37
function oldFormatDayEnUs(iso: string): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return "—";
  return then.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// app/(dashboard)/code/stats/overview-content.tsx:37
function oldFormatDayUtc(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return isoDay;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

// app/(dashboard)/conversations/[id]/message-list.tsx:42
function oldFormatMessageTime(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

// lib/code-sessions/view.ts:94
function oldFormatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// lib/code-sessions/view.ts:651
function oldFormatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

// lib/code-sessions/view.ts:659
function oldFormatCostUsd(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return "—";
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

// lib/code-sessions/view.ts:706
function oldTruncatePathLeft(path: string, maxChars = 44): string {
  if (path.length <= maxChars) return path;
  return `…${path.slice(path.length - (maxChars - 1))}`;
}

// ---------------------------------------------------------------------------
// Shared fixture inputs.
// ---------------------------------------------------------------------------

const ISO_INPUTS: (string | null)[] = [
  null,
  "",
  "not-a-date",
  "1970-01-01T00:00:00.000Z", // epoch
  "2026-09-28T12:00:00.000Z", // "now" itself
  "2026-09-28T11:59:50.000Z", // seconds ago
  "2026-09-27T12:00:00.000Z", // exactly 1 day ago
  "2026-09-21T12:00:00.000Z", // exactly 1 week ago
  "2026-08-01T00:00:00.000Z", // ~2 months ago
  "2024-01-01T00:00:00.000Z", // ~2 years ago
  "2099-01-01T00:00:00.000Z", // far future
];

const FIXED_NOW_1 = new Date("2026-09-28T12:00:00.000Z");
const FIXED_NOW_2 = new Date("2027-01-15T03:30:00.000Z");

describe("dates: formatRelativeDate", () => {
  it("matches the original for explicit `now` across boundaries", () => {
    for (const iso of ISO_INPUTS) {
      for (const now of [FIXED_NOW_1, FIXED_NOW_2]) {
        expect(formatRelativeDate(iso, now)).toBe(oldFormatRelativeDate(iso, now));
      }
    }
  });

  it("matches the original on the default `now = new Date()` path under two fake clocks", () => {
    for (const now of [FIXED_NOW_1, FIXED_NOW_2]) {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      expect(formatRelativeDate("2026-01-01T00:00:00.000Z")).toBe(oldFormatRelativeDate("2026-01-01T00:00:00.000Z"));
      expect(formatRelativeDate(null)).toBe(oldFormatRelativeDate(null));
      vi.useRealTimers();
    }
  });
});

describe("dates: formatRelativeDateShort", () => {
  it("matches the original (internal `new Date()`) under two fake clocks", () => {
    const inputs = ["", ...ISO_INPUTS.filter((s): s is string => s !== null && s !== "")];
    for (const now of [FIXED_NOW_1, FIXED_NOW_2]) {
      vi.useFakeTimers();
      vi.setSystemTime(now);
      for (const iso of inputs) {
        expect(formatRelativeDateShort(iso)).toBe(oldFormatRelativeDateShort(iso));
      }
      vi.useRealTimers();
    }
  });
});

describe("dates: formatAbsoluteUtc", () => {
  it("matches the original", () => {
    for (const iso of ISO_INPUTS) {
      expect(formatAbsoluteUtc(iso)).toBe(oldFormatAbsoluteUtc(iso));
    }
  });
});

describe("dates: formatDateOnlyUtc", () => {
  it("matches the original", () => {
    for (const iso of ISO_INPUTS) {
      expect(formatDateOnlyUtc(iso)).toBe(oldFormatDateOnlyUtc(iso));
    }
  });
});

describe("dates: formatRelativeShort", () => {
  it("matches the original for explicit `now` across boundaries", () => {
    const extra = ["2026-09-28T12:00:09.500Z", "2026-09-28T11:59:00.000Z", "2026-09-28T09:00:00.000Z"];
    for (const iso of [...ISO_INPUTS, ...extra]) {
      for (const now of [FIXED_NOW_1, FIXED_NOW_2]) {
        expect(formatRelativeShort(iso, now)).toBe(oldFormatRelativeShort(iso, now));
      }
    }
  });

  it("matches the original on the default `now` path under a fake clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_1);
    expect(formatRelativeShort("2026-09-28T11:59:55.000Z")).toBe(oldFormatRelativeShort("2026-09-28T11:59:55.000Z"));
    expect(formatRelativeShort(null)).toBe(oldFormatRelativeShort(null));
    vi.useRealTimers();
  });
});

describe("dates: formatAgoLong", () => {
  it("matches the original for explicit `now` across boundaries", () => {
    const extra = ["2026-09-28T11:59:45.000Z", "2026-09-28T11:00:00.000Z", "2026-09-27T13:00:00.000Z"];
    for (const iso of [...ISO_INPUTS, ...extra]) {
      for (const now of [FIXED_NOW_1, FIXED_NOW_2]) {
        expect(formatAgoLong(iso, now)).toBe(oldFormatAgoLong(iso, now));
      }
    }
  });

  it("matches the original on the default `now` path under a fake clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_2);
    expect(formatAgoLong("2027-01-14T00:00:00.000Z")).toBe(oldFormatAgoLong("2027-01-14T00:00:00.000Z"));
    expect(formatAgoLong(null)).toBe(oldFormatAgoLong(null));
    vi.useRealTimers();
  });
});

describe("dates: relativeDay", () => {
  it("matches the original", () => {
    const nowIsos = ["2026-09-28T12:00:00.000Z", "not-a-date", ""];
    for (const iso of [...ISO_INPUTS, "2026-09-28T12:00:00.001Z"]) {
      for (const nowIso of nowIsos) {
        expect(relativeDay(iso, nowIso)).toBe(oldRelativeDay(iso, nowIso));
      }
    }
  });
});

describe("dates: formatDateAt", () => {
  it("matches the original", () => {
    for (const iso of ISO_INPUTS.filter((s): s is string => s !== null)) {
      expect(formatDateAt(iso)).toBe(oldFormatDateAt(iso));
    }
  });
});

describe("dates: formatDateOrUnknown", () => {
  it("matches the original", () => {
    for (const iso of ISO_INPUTS) {
      expect(formatDateOrUnknown(iso)).toBe(oldFormatDateOrUnknown(iso));
    }
  });
});

describe("dates: formatDateTimeUtc", () => {
  it("matches the original", () => {
    for (const iso of ISO_INPUTS) {
      expect(formatDateTimeUtc(iso)).toBe(oldFormatDateTimeUtc(iso));
    }
  });
});

describe("dates: formatDate (search-result)", () => {
  it("matches the original", () => {
    for (const iso of ISO_INPUTS) {
      expect(formatDate(iso)).toBe(oldFormatDate(iso));
    }
  });
});

describe("dates: formatDateLong (node-inspector)", () => {
  it("matches the original, including the unguarded 'Invalid Date' case", () => {
    for (const iso of ISO_INPUTS.filter((s): s is string => s !== null)) {
      expect(formatDateLong(iso)).toBe(oldFormatDateLong(iso));
    }
    expect(formatDateLong(null)).toBe(oldFormatDateLong(null));
  });
});

describe("dates: formatShortDate (pulse-content)", () => {
  it("matches the original", () => {
    for (const iso of ISO_INPUTS.filter((s): s is string => s !== null)) {
      expect(formatShortDate(iso)).toBe(oldFormatShortDate(iso));
    }
    expect(formatShortDate(null)).toBe(oldFormatShortDate(null));
  });
});

describe("dates: formatDayEnUs (memory-section)", () => {
  it("matches the original", () => {
    for (const iso of ISO_INPUTS.filter((s): s is string => s !== null && s !== "")) {
      expect(formatDayEnUs(iso)).toBe(oldFormatDayEnUs(iso));
    }
  });
});

describe("dates: formatDayUtc (overview-content)", () => {
  it("matches the original", () => {
    const days = ["2026-09-28", "2026-01-01", "2026-12-31", "not-a-day", "", "2024-02-29", "2026-02-29"];
    for (const isoDay of days) {
      expect(formatDayUtc(isoDay)).toBe(oldFormatDayUtc(isoDay));
    }
  });
});

describe("dates: formatMessageTime", () => {
  it("matches the original, including null/undefined", () => {
    for (const iso of [...ISO_INPUTS, undefined]) {
      expect(formatMessageTime(iso)).toBe(oldFormatMessageTime(iso));
    }
  });
});

describe("durations: formatDuration", () => {
  it("matches the original across boundaries", () => {
    const inputs: (number | null | undefined)[] = [
      null,
      undefined,
      NaN,
      Infinity,
      -Infinity,
      0,
      -5,
      0.4,
      1,
      59,
      59.6,
      60,
      61,
      3599,
      3600,
      3661,
      86_399,
      86_400,
    ];
    for (const s of inputs) {
      expect(formatDuration(s)).toBe(oldFormatDuration(s));
    }
  });
});

describe("numbers: formatTokenCount", () => {
  it("matches the original across boundaries", () => {
    const inputs = [
      NaN,
      Infinity,
      -Infinity,
      -5,
      0,
      0.4,
      1,
      999,
      1000,
      1500,
      999_999,
      1_000_000,
      1_500_000,
      12_345_678,
    ];
    for (const n of inputs) {
      expect(formatTokenCount(n)).toBe(oldFormatTokenCount(n));
    }
  });
});

describe("numbers: formatCostUsd", () => {
  it("matches the original across boundaries", () => {
    const inputs: (number | null)[] = [
      null,
      NaN,
      Infinity,
      -Infinity,
      0,
      -1.5,
      0.0001,
      0.9999,
      1,
      1.005,
      9.999,
      10,
      123.456,
    ];
    for (const amount of inputs) {
      expect(formatCostUsd(amount)).toBe(oldFormatCostUsd(amount));
    }
  });
});

describe("numbers: formatSimilarity", () => {
  it("matches the original across boundaries", () => {
    const inputs: (number | null | undefined)[] = [null, undefined, 0, -0.2, 0.004, 0.005, 0.5, 0.999, 1, 1.5, NaN];
    for (const score of inputs) {
      // The original signature is `number | null`; `undefined` is exercised
      // too since the original's `=== undefined` branch is reachable at
      // runtime from a caller passing an optional value.
      // @ts-expect-error -- exercising the undefined case the original code checks for
      expect(formatSimilarity(score)).toBe(oldFormatSimilarity(score));
    }
  });
});

describe("text: truncatePathLeft", () => {
  it("matches the original across boundaries", () => {
    const cases: [string, number?][] = [
      ["", undefined],
      ["short", undefined],
      ["a".repeat(44), undefined],
      ["a".repeat(45), undefined],
      ["a".repeat(200), undefined],
      ["/Users/alice/dev/some-monorepo/packages/app/src/index.ts", undefined],
      ["/Users/alice/dev/some-monorepo/packages/app/src/index.ts", 10],
      ["exact", 5],
      ["exceeds", 5],
      ["unicode/🎉/path/file.ts", 12],
      ["x", 0],
    ];
    for (const [path, maxChars] of cases) {
      expect(maxChars === undefined ? truncatePathLeft(path) : truncatePathLeft(path, maxChars)).toBe(
        maxChars === undefined ? oldTruncatePathLeft(path) : oldTruncatePathLeft(path, maxChars),
      );
    }
  });
});
