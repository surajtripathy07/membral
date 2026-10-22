// Upload size limits shared by the server's Zod schema (apps/cloud
// lib/code-sessions/payload.ts) and the CLI's wire clamp, so the two cannot
// drift (#480). Lengths are UTF-16 code units, as Zod's `.max()` counts them.

/** Max chars of one turn's `text` / `ownerText`. */
export const MAX_TURN_TEXT_CHARS = 100_000;
/** Max chars of a tool_use turn's `inputDigest`. */
export const MAX_INPUT_DIGEST_CHARS = 2_000;
/** Max chars of a sub-agent `description`. */
export const MAX_SUBAGENT_TEXT_CHARS = 20_000;

// Room kept for the marker: "\n…[truncated N chars by membral]" is under 50 chars for any N < 1e9.
const MARKER_RESERVE = 64;

/**
 * Return `s` unchanged when it fits `max`; otherwise cut it and append a visible marker so the
 * result is at most `max` chars. Only the wire copy is clamped; the transcript on disk is never touched.
 */
export function clampWireText(s: string, max: number): string {
  if (s.length <= max) return s;
  let keep = Math.max(0, max - MARKER_RESERVE);
  // Do not end on half of a surrogate pair.
  const last = s.charCodeAt(keep - 1);
  if (keep > 0 && last >= 0xd800 && last <= 0xdbff) keep -= 1;
  return `${s.slice(0, keep)}\n…[truncated ${s.length - keep} chars by membral]`;
}
