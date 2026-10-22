// UX audit B0 (docs section 3.8): one money formatter for every surface that
// shows a dollar figure, so "$1.6K" on Today, "$1577.12" on Sessions/Usage
// and four-decimal values like "$0.2250" never disagree again.
//
// Rule: null, undefined or 0 -> "—"; a positive value under a cent ->
// "<$0.01"; under $1,000 -> two decimals ("$12.40"); $1,000 and over ->
// no decimals, thousands-grouped ("$1,577"). Negative values never occur in
// this product, but are handled the same way with a leading "-".
export function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs < 0.01) return `${sign}<$0.01`;
  if (abs < 1000) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
}

/** Tooltip for spend figures that are counted from session transcripts, not billed. */
export const SPEND_TRANSCRIPT_TITLE = "Counted from your session transcripts; your Claude bill can run higher.";

/** Note under the Usage headline total (issue #410). */
export const SPEND_TRANSCRIPT_NOTE =
  "Counted from your session transcripts. Your Claude bill can run higher: Claude Code also makes small helper requests (titles, page summaries, context compaction) that transcripts don't record.";

/**
 * `fmtUsd` plus the existing "est." marker (see `issues-content.tsx`'s
 * `hasCost`), appended only when `value` is a real, finite number > 0 —
 * never after the null/undefined/0 "—" case.
 */
export function fmtUsdEst(value: number | null | undefined): string {
  const formatted = fmtUsd(value);
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return `${formatted} est.`;
  return formatted;
}
