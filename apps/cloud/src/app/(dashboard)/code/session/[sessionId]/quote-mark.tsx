import { splitAroundQuote } from "@/lib/code-sessions/quote-highlight";

/** Token-only mark for the quote a memory record cites (globals.css accent tokens; never a raw colour). */
export const QUOTE_MARK_CLASS = "rounded-xs bg-accent-soft px-0.5 text-ink underline decoration-accent decoration-2 underline-offset-2";

/**
 * `text` with the cited quote wrapped in a <mark>, or null when `quote` is absent or not in the text (the caller then
 * renders the turn as before). Segments render as React text nodes: nothing here is parsed as HTML.
 */
export function markQuote(text: string, quote: string | null | undefined) {
  const parts = splitAroundQuote(text, quote);
  if (!parts) return null;
  return parts.map((p, i) =>
    p.match ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
      <mark key={i} className={QUOTE_MARK_CLASS} data-testid="quote-mark">
        {p.text}
      </mark>
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional and never reorder
      <span key={i}>{p.text}</span>
    ),
  );
}
