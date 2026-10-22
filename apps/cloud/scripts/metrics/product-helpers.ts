// Pure, DB-free helpers for scripts/metrics/product.ts. Kept in their own
// file so the date-bucketing, percentile, and table-formatting logic gets a
// real vitest suite instead of only being exercised by a live DB run.

/** "YYYY-MM-DD" for the UTC calendar day of `input`. */
export function utcDayKey(input: string | Date): string {
  const d = typeof input === "string" ? new Date(input) : input;
  return d.toISOString().slice(0, 10);
}

/** ISO-8601 week key "YYYY-Www" (Monday-start, week 1 = week containing Jan 4) for the UTC day of `input`. */
export function utcIsoWeekKey(input: string | Date): string {
  const d = typeof input === "string" ? new Date(input) : input;
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // nearest Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const weekNum = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${date.getUTCFullYear()}-W${String(weekNum).padStart(2, "0")}`;
}

/** Ascending "YYYY-MM-DD" UTC day keys for the `n` days ending on `end` (inclusive). */
export function lastNDaysUTC(n: number, end: Date = new Date()): string[] {
  const endKey = utcDayKey(end);
  const endDate = new Date(`${endKey}T00:00:00.000Z`);
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(utcDayKey(new Date(endDate.getTime() - i * 86_400_000)));
  }
  return out;
}

/** Linear-interpolation-free percentile (nearest-rank) over an ASCENDING-sorted array. Null on empty input. */
export function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1);
  return sortedAsc[Math.max(0, idx)];
}

/** Counts rows into a Map<key, count>, via keyFn. */
export function groupCount<T>(rows: T[], keyFn: (row: T) => string): Map<string, number> {
  const out = new Map<string, number>();
  for (const row of rows) {
    const k = keyFn(row);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** Buckets rows by `user_id`. */
export function bucketByUser<T extends { user_id: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const arr = out.get(row.user_id);
    if (arr) arr.push(row);
    else out.set(row.user_id, [row]);
  }
  return out;
}

/**
 * Day x key matrix (e.g. day x harness). `dayKeys` is the full ascending
 * window so days with zero rows still appear. `keys` is every distinct
 * groupKeyFn value seen anywhere in `rows` (stable insertion order).
 */
export function dailyMatrix<T>(
  rows: T[],
  dayKeyFn: (row: T) => string,
  groupKeyFn: (row: T) => string,
  dayKeys: string[],
): { keys: string[]; counts: Map<string, Map<string, number>> } {
  const keys: string[] = [];
  const counts = new Map<string, Map<string, number>>();
  for (const day of dayKeys) counts.set(day, new Map());
  for (const row of rows) {
    const day = dayKeyFn(row);
    const key = groupKeyFn(row);
    if (!counts.has(day)) continue; // outside the requested window
    if (!keys.includes(key)) keys.push(key);
    const dayMap = counts.get(day)!;
    dayMap.set(key, (dayMap.get(key) ?? 0) + 1);
  }
  return { keys, counts };
}

/**
 * For each key in `keys`, finds the first day (in `dayKeys` order) with a
 * nonzero count, then flags every LATER day where that key's count is zero
 * — "a harness/source that had activity earlier in the window has zero".
 * Returns day -> list of flagged key names.
 */
export function flagGapsAfterFirstActivity(
  dayKeys: string[],
  keys: string[],
  counts: Map<string, Map<string, number>>,
): Map<string, string[]> {
  const flagsByDay = new Map<string, string[]>();
  for (const key of keys) {
    let seenActivity = false;
    for (const day of dayKeys) {
      const count = counts.get(day)?.get(key) ?? 0;
      if (count > 0) {
        seenActivity = true;
        continue;
      }
      if (seenActivity) {
        const flags = flagsByDay.get(day) ?? [];
        flags.push(key);
        flagsByDay.set(day, flags);
      }
    }
  }
  return flagsByDay;
}

/** Formats a percentage string, safe for a zero denominator. */
export function pct(numerator: number, denominator: number): string {
  if (denominator <= 0) return "n/a";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/** Formats a USD amount to 4dp (spend rows are small; 2dp hides real differences). */
export function money(n: number): string {
  return `$${n.toFixed(4)}`;
}

/** Renders a small left-aligned, space-padded table as one string (no trailing newline). */
export function formatTable(headers: string[], rows: (string | number)[][]): string {
  const cells = [headers.map(String), ...rows.map((r) => r.map(String))];
  const widths = headers.map((_, col) => Math.max(...cells.map((r) => (r[col] ?? "").length)));
  const renderRow = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ");
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  return [renderRow(cells[0]), sep, ...rows.map((r) => renderRow(r.map(String)))].join("\n");
}
