// Cloud UI duration formatters (G3 3D-1). Two distinct variants existed
// (different rounding, different unit words); both kept, neither merged.

/**
 * Format a duration in seconds as a compact "2h 34m" / "45m" / "12s" string.
 * NULL/undefined/non-finite/non-positive durations (a zero-turn session, or
 * a row with duration_seconds not yet computed) render as "—".
 * Moved from lib/code-sessions/view.ts's formatDuration.
 */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}
