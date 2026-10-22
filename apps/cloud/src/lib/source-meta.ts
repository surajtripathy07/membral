// Design review #119, item 10 — one source of truth for the conversation
// `source` -> {label, color} styling. This map (and its label overrides,
// e.g. "Bridge chat" for source='claude-code-chat', goal 2026-08-27 D5) used
// to be copy-pasted across /conversations, /conversations/[id], and
// search-result.tsx with slightly different shapes; this is the merge.
//
// /pulse keeps its own copy on purpose (pulse-content.tsx's SOURCE_DOT) —
// it's a much smaller shape (just a dot color) and pulse is a deliberately
// separate design system (CLAUDE.md), so it isn't repointed here.

export interface SourceMeta {
  /** Display label, e.g. "Claude" / "Bridge chat". */
  label: string;
  /** Text color class, e.g. "text-orange-400". */
  text: string;
  /** Soft background tint, e.g. "bg-orange-500/15" — for badges/pills. */
  bg: string;
  /** Solid dot/accent color, e.g. "bg-orange-500" — for small indicator dots. */
  accent: string;
}

const SOURCE_META: Record<string, SourceMeta> = {
  claude: { label: "Claude", text: "text-orange-400", bg: "bg-orange-500/15", accent: "bg-orange-500" },
  chatgpt: { label: "ChatGPT", text: "text-green-400", bg: "bg-green-500/15", accent: "bg-green-500" },
  grok: { label: "Grok", text: "text-blue-400", bg: "bg-blue-500/15", accent: "bg-blue-500" },
  // Bridge's continued-chat lane (source='claude-code-chat', ADR 0039) —
  // chat-shaped, not code-lane, so it gets its own color rather than
  // reusing claude-code's palette; purple keeps it visually distinct from
  // the three extension sources above.
  "claude-code-chat": {
    label: "Bridge chat",
    text: "text-purple-400",
    bg: "bg-purple-500/15",
    accent: "bg-purple-500",
  },
};

const FALLBACK: Omit<SourceMeta, "label"> = { text: "text-gray-400", bg: "bg-gray-500/15", accent: "bg-gray-500" };

/**
 * Looks up source styling (case-insensitive). An unrecognized source falls
 * back to gray with the raw source string, capitalized, as the label.
 */
export function getSourceMeta(source: string): SourceMeta {
  const meta = SOURCE_META[source.toLowerCase()];
  if (meta) return meta;
  return { ...FALLBACK, label: source.charAt(0).toUpperCase() + source.slice(1) };
}
