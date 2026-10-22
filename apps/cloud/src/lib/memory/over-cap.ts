// Over-cap backstop. The schema caps a record's `text` / `statement` at MEMORY_TEXT_MAX_HARD; a value over it
// used to fail validation and the record was dropped. It is now cut deterministically instead and kept
// (maintainer, 2026-10-11: "keep all facts and just shorten it"). The cap itself sits above what the model
// writes (measured under v24: 18 of 218 records ran past 240, none past 300), so this fires rarely.
// The reason code in the L6 log is repaired:over_cap_trim; no record text is ever logged.
import { MEMORY_TEXT_MAX_HARD } from "./memory-limits";

export const OVER_CAP_TRIM = "over_cap_trim";

/** A sentence boundary earlier than this is a loss, not a shortening: fall to the word boundary. */
const MIN_SENTENCE_CUT = 80;
const ELLIPSIS = "…";
/** The schema's minimum text length (schema.ts min(8)): a trim shorter than this would drop the record. */
const MIN_TRIMMED_CHARS = 8;

/** `s.slice(0, n)` that never ends on the high half of a surrogate pair. */
export function safeSlice(s: string, n: number): string {
  const end = n > 0 && n < s.length && /[\uD800-\uDBFF]/.test(s.charAt(n - 1)) ? n - 1 : n;
  return s.slice(0, end);
}

/**
 * The longest prefix ending at a sentence boundary within `max` characters (when it keeps at least
 * MIN_SENTENCE_CUT of them), else the last word boundary with a trailing "…". The cut is always at whitespace
 * (or, for one unbroken token longer than `max`, inside that token), so an identifier, path or number that would
 * straddle the limit is dropped whole rather than split. Always <= `max`; text already within `max` is returned
 * trimmed and otherwise unchanged.
 */
export function trimToCap(text: string, max = MEMORY_TEXT_MAX_HARD): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const head = t.slice(0, max);
  let sentenceEnd = -1;
  for (const m of head.matchAll(/[.!?](?=\s|$)/g)) sentenceEnd = (m.index ?? 0) + 1;
  // A boundary exactly at the cut counts only when the next character really is whitespace.
  if (sentenceEnd >= MIN_SENTENCE_CUT && (sentenceEnd < max || /\s/.test(t[max] ?? " "))) {
    return head.slice(0, sentenceEnd).trimEnd();
  }
  const lastSpace = head.search(/\s\S*$/);
  const cut = lastSpace > 0 ? head.slice(0, lastSpace) : safeSlice(head, max - ELLIPSIS.length);
  const out = `${cut.replace(/[\s,;:(\-–—]+$/, "")}${ELLIPSIS}`;
  // Stripping must never leave a stub the schema's minimum would drop ("…" alone): fall back to a plain cut.
  return out.length >= MIN_TRIMMED_CHARS ? out : `${safeSlice(t, max - ELLIPSIS.length)}${ELLIPSIS}`;
}

/**
 * Runs before the strict parse: a record whose `text` (a preference's `statement`) is over the cap gets
 * that field cut by `trimToCap`; anything else is returned as is.
 */
export function trimOverCap(raw: Record<string, unknown>): { record: Record<string, unknown>; trimmed: boolean } {
  const field = typeof raw.kind === "string" && raw.kind.trim().toLowerCase() === "preference" ? "statement" : "text";
  const value = raw[field];
  if (typeof value !== "string" || value.trim().length <= MEMORY_TEXT_MAX_HARD) return { record: raw, trimmed: false };
  return { record: { ...raw, [field]: trimToCap(value) }, trimmed: true };
}
