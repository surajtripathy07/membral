// Verify affordance (goal 2026-10-25 box 3.5): a memory record links to its source turn with `?quote=<text>`, and
// the session page marks that text in the turn. Pure and server-safe: the page renders the segments as React
// text nodes and a <mark>, never as HTML, so a hostile quote cannot inject markup.

/** Longest quote carried in a URL. A longer quote is cut; the cut prefix is what gets marked. */
export const QUOTE_PARAM_MAX_CHARS = 240;
const QUOTE_PARAM_MIN_CHARS = 3;

export interface QuoteSegment {
  text: string;
  match: boolean;
}

function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The quote as it goes into a link: whitespace squashed, capped. Null when too short to mark usefully. */
export function quoteForLink(quote: string | null | undefined): string | null {
  const q = squash(quote ?? "");
  if (q.length < QUOTE_PARAM_MIN_CHARS) return null;
  return q.slice(0, QUOTE_PARAM_MAX_CHARS).trimEnd();
}

/** The `?quote=` search param as quote text, or null when absent/too short. Caps the length again (the URL is user-editable). */
export function parseQuoteParam(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  return typeof v === "string" ? quoteForLink(v) : null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Splits `text` around the first occurrence of `quote` (case-insensitive; any run of whitespace in the quote matches
 * any run of whitespace in the text, since a transcript's line breaks differ from the squashed quote). Returns null
 * when the quote is not in the text, so the caller renders the turn unchanged.
 */
export function splitAroundQuote(text: string, quote: string | null | undefined): QuoteSegment[] | null {
  const q = squash(quote ?? "");
  if (q.length < QUOTE_PARAM_MIN_CHARS) return null;
  const pattern = q.split(" ").map(escapeRegExp).join("\\s+");
  const m = new RegExp(pattern, "i").exec(text);
  if (!m) return null;
  const out: QuoteSegment[] = [];
  if (m.index > 0) out.push({ text: text.slice(0, m.index), match: false });
  out.push({ text: m[0], match: true });
  const end = m.index + m[0].length;
  if (end < text.length) out.push({ text: text.slice(end), match: false });
  return out;
}
