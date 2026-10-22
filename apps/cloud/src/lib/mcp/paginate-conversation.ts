/**
 * Splits one conversation into parts for the MCP `get_conversation` tool.
 *
 * MCP hosts cap tool output (Claude Code: MAX_MCP_OUTPUT_TOKENS, 25,000 tokens
 * by default). A long chat serialised whole overflows that cap and the host
 * shows the model only a preview. This returns whole messages from `start`
 * until the next one would push the cumulative content past `maxChars`, plus
 * the counts and `next_start` a caller needs to fetch the rest.
 *
 * Tool layer only: the web UI and other routes read conversations through
 * their own paths and are not paginated. The core (`paginateList`) is shared
 * with `get_code_session` (see paginate-code-session.ts), which pages `turns`.
 */

export const DEFAULT_MAX_CHARS = 60_000;
export const MIN_MAX_CHARS = 5_000;
export const MAX_MAX_CHARS = 200_000;

export interface ConversationPart {
  /** The conversation with `messages` replaced by this part's slice, plus the paging fields. */
  data: Record<string, unknown>;
  /** One plain-text line for the model when more messages remain (or start is past the end); null otherwise. */
  note: string | null;
}

export function clampMaxChars(maxChars: number | undefined): number {
  if (maxChars === undefined || !Number.isFinite(maxChars)) return DEFAULT_MAX_CHARS;
  return Math.min(MAX_MAX_CHARS, Math.max(MIN_MAX_CHARS, Math.floor(maxChars)));
}

function clampStart(start: number | undefined): number {
  if (start === undefined || !Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor(start));
}

/** What varies between paged payloads: which list is paged, which field holds each item's text, and the words used in the note. */
export interface PageSpec {
  /** Key of the array to page (e.g. "messages", "turns"). */
  listKey: string;
  /** Key of each item's string content, used for sizing and truncation (e.g. "content", "text"). */
  contentKey: string;
  /** What the payload is called in the past-the-end note (e.g. "conversation", "session"). */
  subject: string;
  /** Tool the note tells the model to call again. */
  toolName: string;
}

const CONVERSATION_SPEC: PageSpec = {
  listKey: "messages",
  contentKey: "content",
  subject: "conversation",
  toolName: "get_conversation",
};

/** Size of one item: its content string length, or its JSON length when it has no string content. */
function itemChars(item: unknown, contentKey: string): number {
  if (item && typeof item === "object") {
    const content = (item as Record<string, unknown>)[contentKey];
    if (typeof content === "string") return content.length;
  }
  return JSON.stringify(item ?? null).length;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

/** Cuts a single oversized item down to `maxChars` and flags it. */
function truncateItem(item: unknown, size: number, maxChars: number, contentKey: string): unknown {
  const note = `Content cut to ${fmt(maxChars)} of ${fmt(size)} chars (${fmt(size - maxChars)} omitted).`;
  if (item && typeof item === "object" && typeof (item as Record<string, unknown>)[contentKey] === "string") {
    const m = item as Record<string, unknown>;
    return { ...m, [contentKey]: (m[contentKey] as string).slice(0, maxChars), truncated: true, truncation_note: note };
  }
  // No string content to cut: carry the serialised item, cut to the budget.
  return { [contentKey]: JSON.stringify(item ?? null).slice(0, maxChars), truncated: true, truncation_note: note };
}

/**
 * Pages `payload[spec.listKey]`: whole items from `start` until the next one
 * would push the cumulative content past `maxChars`. Adds
 * `total_<listKey>`, `total_chars`, `returned {start, end}` and `next_start`.
 */
export function paginateList(
  payload: Record<string, unknown>,
  spec: PageSpec,
  opts: { start?: number; maxChars?: number } = {},
): ConversationPart {
  const { listKey, contentKey, subject, toolName } = spec;
  const maxChars = clampMaxChars(opts.maxChars);
  const start = clampStart(opts.start);
  const raw = payload[listKey];
  const items: unknown[] = Array.isArray(raw) ? raw : [];
  const sizes = items.map((item) => itemChars(item, contentKey));
  const total = items.length;
  const totalChars = sizes.reduce((a, b) => a + b, 0);

  const slice: unknown[] = [];
  let end = Math.min(start, total);
  let used = 0;
  while (end < total) {
    const size = sizes[end];
    if (slice.length === 0 && size > maxChars) {
      // A single item larger than the whole budget: return it cut, alone.
      slice.push(truncateItem(items[end], size, maxChars, contentKey));
      used = maxChars;
      end++;
      break;
    }
    if (used + size > maxChars) break;
    slice.push(items[end]);
    used += size;
    end++;
  }

  const nextStart = end < total ? end : null;
  const data: Record<string, unknown> = {
    ...payload,
    [listKey]: Array.isArray(raw) ? slice : raw,
    [`total_${listKey}`]: total,
    total_chars: totalChars,
    returned: { start: Math.min(start, total), end },
    next_start: nextStart,
  };

  let note: string | null = null;
  if (start >= total && total > 0) {
    note = `start=${start} is past the end: this ${subject} has ${total} ${listKey} (indexes 0–${total - 1}).`;
  } else if (nextStart !== null) {
    note =
      `Showing ${listKey} ${start}–${end - 1} of ${total} (${fmt(used)} of ${fmt(totalChars)} chars). ` +
      `Call ${toolName} with start=${nextStart} for the rest.`;
  }
  return { data, note };
}

export function paginateConversation(
  conversation: Record<string, unknown>,
  opts: { start?: number; maxChars?: number } = {},
): ConversationPart {
  return paginateList(conversation, CONVERSATION_SPEC, opts);
}
