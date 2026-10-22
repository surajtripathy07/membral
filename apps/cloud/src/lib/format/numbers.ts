// Cloud UI numeric/count formatters (G3 3D-1).

/** Compact "1.2k" / "3.4M" token-count formatting — same spirit as `formatDuration`'s compactness, tuned for large integer counts instead of durations.
 *  Moved from lib/code-sessions/view.ts's formatTokenCount. */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${Math.round(n)}`;
}

/** "$0.0231" style cost formatting — most code sessions cost well under a dollar, so 4-decimal precision below $1 keeps the number meaningful instead of rounding a cheap session down to "$0.02".
 *  Moved from lib/code-sessions/view.ts's formatCostUsd. */
export function formatCostUsd(amount: number | null): string {
  if (amount === null || !Number.isFinite(amount)) return "—";
  if (amount < 1) return `$${amount.toFixed(4)}`;
  return `$${amount.toFixed(2)}`;
}

/** A similarity score (0..1) as a rounded percentage; null/undefined -> null.
 *  Moved from components/search-result.tsx's formatSimilarity. */
export function formatSimilarity(score: number | null): string | null {
  if (score === null || score === undefined) return null;
  return `${Math.round(score * 100)}%`;
}
