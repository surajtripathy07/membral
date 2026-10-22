/** One day in milliseconds. */
export const DAY_MS = 86_400_000;

/** A relative age: minutes under 1h, hours under 48h, then days (`5m ago`, `5h ago`, `3d ago`). No timezone. */
export function ageText(at: string, now: number): string {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return at.slice(0, 10);
  const ms = Math.max(0, now - t);
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 48 * 3_600_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / DAY_MS)}d ago`;
}
