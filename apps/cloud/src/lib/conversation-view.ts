// Pure, testable helpers for /conversations/[id] (maintainer product-review
// feedback: "looks fcked .. too much going on in there besides the
// content"). Nothing here touches the network or Supabase — same rationale
// as lib/code-sessions/view.ts: keep the page.tsx server component thin and
// covered by plain vitest unit tests instead of e2e.
//
// Noise inventory — found first by reading how each provider actually
// renders `messages[].content` (not by guessing), THEN confirmed against the
// live founder-1k corpus via a read-only psql scan (`select distinct
// (regexp_match(m->>'content', '^\[([^\]]{1,60})\]'))[1] ... where
// m->>'content' like '[%'`). Real tag inventory found, and how each is
// classified:
//
//   NOISE (provider/tool-internal scratchpad, collapsed):
//     - user_editable_context (31), model_editable_context (164) — ChatGPT's
//       memory/system-context blob.
//     - thoughts (106) — ChatGPT's internal "thinking" content_type (plural
//       — distinct from Claude's own [thinking] tag below, which stays
//       visible).
//     - reasoning_recap (85) — ChatGPT's "Thought for Ns" recap card.
//     - tether_browsing_display (35) — ChatGPT's internal browsing-tool
//       display state (body observed as `{"result":"","summary":"",...}`).
//     - app_pairing_content (11) — ChatGPT desktop app-pairing/window
//       context (e.g. "workspaces":[{"app_name":"iTerm2",...}]).
//     - convo search (5) — ChatGPT's internal memory-retrieval scratchpad,
//       rendered as an assistant message but NOT JSON (body reads like
//       "[USER_FACT] [c0] U@2026-...: user said ..."); a
//       browser-verified ChatGPT export is exactly this shape.
//     - tool_use / tool_result (Claude's renderContentBlock fallback; also
//       ChatGPT's undifferentiated tool sender) — tool-call/result payloads.
//     - part (a lone unrecognized `content.parts[]` entry rendered as
//       `[part: {...}]`).
//
//   KEPT VISIBLE (real conversational content, despite the bracket tag):
//     - artifact: ... — Claude's hoisted file/artifact bodies (real content).
//     - quote: ... — tether_quote'd document/browse excerpts (real content).
//     - asset: ... — inline image/file references (real content).
//     - execution_output (145), system_error (8) — actual tool output / a
//       human-readable error string a user would want to see; body is plain
//       text, not JSON, so the generalized rule below doesn't touch it.
//     - thinking (427) — Claude's own extended-thinking transcript (plain
//       text reasoning, not a system/memory blob).
//     - eslint, and anything else not on the noise list above.
//
// Both providers only ever push role "user"/"assistant" into
// conversations.messages (Claude's "human" sender is remapped to "user"
// before it gets there, and ChatGPT's "tool" sender is remapped to
// "assistant") — but @membral/core's normalizeMessage will still stamp
// "system"/"unknown" onto anything that doesn't validate, and older/
// other-source rows may carry those roles directly. Treated as noise
// defensively.
//
// classifyMessage never inspects order/count and never mutates content — it
// only decides how ONE message renders. Search spans cite message indices
// into the stored `messages` array (conversation-chunks.ts /
// mcp/graph-tools.ts), so the page must keep rendering every array entry at
// its original index — classification is purely visual (collapsed vs. full
// bubble), never a filter.

export interface MessageClassification {
  /** true = render as a single muted collapsed row instead of a full bubble. */
  isNoise: boolean;
  reason?: "role" | "empty" | "json-payload" | "bracket-tag";
}

const CONVERSATIONAL_ROLES = new Set(["user", "assistant", "human"]);

// Keys that mark a JSON object as a tool-call/tool-result payload regardless
// of its content_type.
const TOOL_PAYLOAD_KEYS = ["tool_use_id", "tool_call_id", "is_error", "function_call"];

/**
 * A message payload only ever reaches the page as a raw `{...}` JSON object
 * (rather than the text/fenced-code the providers normally render) when a
 * content_type went through renderChatgptContent's/renderContentBlock's
 * fallback path — i.e. it's provider-internal envelope, not something the
 * user typed or the model said. Any `content_type` key at all is therefore
 * itself the noise marker (a legitimate message never carries one), plus an
 * explicit check for the "user_editable_context" memory/system-context blob
 * by key in case it ever shows up without a content_type wrapper, plus
 * tool-call/tool-result marker keys.
 */
function looksLikeNoisePayload(obj: Record<string, unknown>): boolean {
  if (typeof obj.content_type === "string") return true;
  if ("user_editable_context" in obj || "model_editable_context" in obj) return true;
  return TOOL_PAYLOAD_KEYS.some((k) => k in obj);
}

// Exact bracket-tag names (case-insensitive) that ALWAYS mean "provider/tool
// scratchpad, not conversational" — regardless of whether the body parses
// as JSON. This covers both actual JSON payloads (thoughts, reasoning_recap,
// tether_browsing_display, app_pairing_content, {user,model}_editable_context)
// AND the plain-text "convo search" scratchpad, and is robust to a payload
// getting cut off mid-JSON by the extension's `JSON.stringify(c).slice(0,
// 4000)` cap (renderChatgptContent/renderContentBlock) — the tag name alone
// is signal enough here, we don't need JSON.parse to succeed.
const KNOWN_NOISE_BRACKET_TAGS = new Set([
  "tool_use",
  "tool_result",
  "part",
  "user_editable_context",
  "model_editable_context",
  "thoughts",
  "reasoning_recap",
  "tether_browsing_display",
  "app_pairing_content",
  "convo search",
]);

// The bracket-tag LINE both providers' fallback rendering prepends ahead of
// a JSON dump (or, for "convo search"/artifacts/quotes/assets, ahead of
// plain text): "[tag]\n..." or "[tag: detail]\n...". Captures just the tag
// name (before any ": detail" suffix) so "tool_use: Bash" -> "tool_use" and
// "quote: some-file.js — file-abc123" -> "quote".
const BRACKET_TAG_LINE = /^\[([a-z][a-z_ -]*?)(?::[^\]]*)?\]\s*\n?/i;

/**
 * Classify a single message as ordinary conversational content or
 * non-conversational noise (system/memory context, a tool call/result
 * payload, or an empty message) that should render collapsed. Pure function
 * — no React, no DOM — so the predicate has direct fixture coverage instead
 * of only being exercised transitively through the page.
 */
export function classifyMessage(role: string, content: string): MessageClassification {
  const normalizedRole = (role ?? "").toLowerCase();
  if (!CONVERSATIONAL_ROLES.has(normalizedRole)) return { isNoise: true, reason: "role" };

  const trimmed = (content ?? "").trim();
  if (trimmed.length === 0) return { isNoise: true, reason: "empty" };

  // Case 1: content IS the raw JSON object, with no bracket-tag line ahead
  // of it (defensive — not observed in the corpus, but cheap to keep).
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        looksLikeNoisePayload(parsed as Record<string, unknown>)
      ) {
        return { isNoise: true, reason: "json-payload" };
      }
    } catch {
      // Not JSON after all — an ordinary (if oddly-formatted) message.
    }
  }

  // Case 2: a bracket-tag line, as both providers' fallback rendering
  // actually emits it in the corpus ("[thoughts]\n{...}", "[convo
  // search]\n[USER_FACT] ...").
  const tagMatch = trimmed.match(BRACKET_TAG_LINE);
  if (tagMatch) {
    const tag = tagMatch[1].toLowerCase();
    if (KNOWN_NOISE_BRACKET_TAGS.has(tag)) return { isNoise: true, reason: "bracket-tag" };

    // Forward defense against a content_type we haven't seen/enumerated
    // yet: renderChatgptContent's/renderContentBlock's fallback path is the
    // ONLY thing that ever emits a bracket-tag line immediately followed by
    // a raw JSON object — real content (artifacts, quotes, assets, eslint
    // output, etc.) never does. A bracket tag whose body IS valid JSON is
    // therefore itself the provider-fallback signature, independent of the
    // specific tag name.
    const rest = trimmed.slice(tagMatch[0].length).trim();
    if (rest.startsWith("{")) {
      try {
        const parsed: unknown = JSON.parse(rest);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          return { isNoise: true, reason: "bracket-tag" };
        }
      } catch {
        // Not JSON — an ordinary bracket-prefixed message (e.g. "[eslint]\nsrc/...").
      }
    }
  }

  return { isNoise: false };
}

/** Very long messages (maintainer feedback) clamp to this many characters before a "Show more" toggle. */
export const LONG_MESSAGE_CLAMP_CHARS = 3000;

export function isLongMessage(content: string): boolean {
  return (content ?? "").length > LONG_MESSAGE_CLAMP_CHARS;
}

// ---------------------------------------------------------------------------
// Markdown-stripped preview (D6). The collapsed preview of a long message is
// plain text; slicing raw markdown left `**`, fences and `#` visible. This
// strips the common inline/block markers so the preview reads as prose.
// ---------------------------------------------------------------------------

export function stripMarkdown(text: string): string {
  return (text ?? "")
    .replace(/^\s*(```|~~~)[^\n]*$/gm, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\w)/g, "$1$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Plain-text, markdown-stripped preview for a long message (D6). */
export function messagePreview(content: string): string {
  return stripMarkdown((content ?? "").slice(0, LONG_MESSAGE_CLAMP_CHARS));
}

// ---------------------------------------------------------------------------
// Segment parsing for Claude.ai imports (D7).
//
// Producer: packages/core/src/importers/claude-export.ts renderContentBlock
// flattens each content block to a string and joins them with "\n\n":
//   text        -> the text itself
//   thinking    -> "[thinking]\n<thought>\n[/thinking]"
//   tool_use    -> "[tool_use: <name>]\n<JSON.stringify(input)>\n[/tool_use]"
//                  or "[artifact: <type> — <title>]\n<body/fence>" (hoisted, no close)
//   tool_result -> "[tool_result]\n<string>\n[/tool_result]" (inner blocks joined by "\n")
//   other       -> "[<type>]\n<JSON.stringify(block).slice(0, 4000)>\n[/<type>]"
//
// Fresh imports carry an explicit closing marker per non-text block, so
// endsWithClosingTag/isBareClosingTag below find it and segmentation is exact
// — no guessing where a block ends. Old stored data (imported before the
// closing marker existed) has none, so every branch falls back to the
// heuristics this comment originally documented:
//   - tool_result keeps its first paragraph plus following paragraphs that
//     still look like tool output (JSON, bracket tags, "=== file", numbered
//     file lines); prose after it is the model's interleaved text.
//   - thinking runs to the next marker. When it is the LAST block, the
//     reply is glued on with no marker, so the reply starts at the first
//     later paragraph that does not open like reasoning ("I'm…", "Now I…",
//     "The user…") and is markdown-structured, addresses the reader
//     ("you"), or is a short lead-in; failing that, the last paragraph.
// ---------------------------------------------------------------------------

export type MessageSegment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_call"; name: string; input: string }
  | { kind: "tool_result"; text: string }
  | { kind: "artifact"; label: string; text: string }
  | { kind: "unknown"; label: string; text: string };

type Marker =
  | { kind: "thinking" | "tool_result"; body: string }
  | { kind: "tool_call"; name: string; body: string }
  | { kind: "artifact"; label: string; body: string }
  | { kind: "unknown"; label: string; body: string };

// First line of a paragraph that is exactly a bracket tag: "[tag]" or "[tag: detail]".
const MARKER_LINE = /^\[([a-z][a-z_]*)(?::\s*([^\]\n]*))?\][ \t]*(?:\n|$)/;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Explicit closing markers (D-follow-up): claude-export.ts's renderContentBlock
// now appends "\n[/tag]" after every non-text block it emits, so a fresh
// import never has to guess a block's end. Old stored data has no closing
// marker, so every call site below falls back to the pre-existing heuristics
// when one isn't found — this only ever makes segmentation MORE precise, never
// changes it for content that lacks the marker.
function endsWithClosingTag(text: string, tag: string): { body: string; matched: boolean } {
  const re = new RegExp(`\\n?\\[/${escapeRegExp(tag)}\\]\\s*$`);
  const m = text.match(re);
  if (!m) return { body: text, matched: false };
  return { body: text.slice(0, m.index), matched: true };
}

function isBareClosingTag(paragraph: string, tag: string): boolean {
  return new RegExp(`^\\[/${escapeRegExp(tag)}\\]\\s*$`).test(paragraph.trim());
}

function matchMarker(paragraph: string): Marker | null {
  const m = paragraph.match(MARKER_LINE);
  if (!m) return null;
  const tag = m[1];
  const detail = (m[2] ?? "").trim();
  const body = paragraph.slice(m[0].length);
  if (tag === "thinking" && !detail) return { kind: "thinking", body };
  if (tag === "tool_result" && !detail) return { kind: "tool_result", body };
  if (tag === "tool_use") return { kind: "tool_call", name: detail || "tool", body };
  if (tag === "artifact") return { kind: "artifact", label: detail || "artifact", body };
  if (tag === "unknown" && !detail) return { kind: "unknown", label: "unknown", body };
  // renderContentBlock's fallback: "[<type>]\n{json" — the JSON body is the signature.
  if (!detail && body.trimStart().startsWith("{")) return { kind: "unknown", label: tag, body };
  return null;
}

/**
 * true when the content carries a Claude.ai thinking / tool_use / tool_result
 * marker worth segmenting. A lone fallback "[type]\n{json}" block does not
 * count: ChatGPT's whole-message scratchpads ("[thoughts]\n{...}") share
 * that shape and stay on classifyMessage's single collapsed noise row.
 */
export function hasContentBlockMarkers(content: string): boolean {
  return splitParagraphs(content).some((p) => {
    const m = matchMarker(p);
    return m !== null && (m.kind === "thinking" || m.kind === "tool_call" || m.kind === "tool_result");
  });
}

function splitParagraphs(content: string): string[] {
  return (content ?? "").split(/\n\n/);
}

const MARKDOWN_BLOCK_START = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\*\*|__|---|\||```|~~~)/;
const ADDRESSES_READER = /\byou(?:r|rs|'re|'ll|'ve|'d)?\b/i;
const TOOL_OUTPUT_START = /^(\{|\[|===|\s*\d+\t)/;

function prettyJson(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return trimmed;
  }
}

// Claude.ai's thinking summaries narrate the model's own process ("I'm
// weighing…", "Now I need…", "The user wants…"); the reply that follows is
// addressed to the reader, formatted, or a short lead-in ("Quick math first.").
const REASONING_OPENER =
  /^(I'm|I am|I'll|I need|I should|I've|I want|I think|I can|Let me|Let's see|Now I|Now let|Looking at|The user|Actually,|Hmm|Okay,|OK,|Wait)/;
const SHORT_LEAD_IN_CHARS = 120;

function replyStartInTerminalThinking(paras: string[]): number {
  // paras[0] is always thinking (it follows the marker line directly).
  for (let i = 1; i < paras.length; i++) {
    const p = paras[i].trim();
    if (!p || REASONING_OPENER.test(p)) continue;
    if (MARKDOWN_BLOCK_START.test(p) || ADDRESSES_READER.test(p) || p.length <= SHORT_LEAD_IN_CHARS) return i;
  }
  return paras.length > 1 ? paras.length - 1 : paras.length;
}

/**
 * Split one stored message into renderable segments. Pure; never drops text —
 * every character of the input lands in exactly one segment (modulo the
 * "\n\n" joins and the marker lines themselves).
 */
export function parseMessageSegments(content: string): MessageSegment[] {
  const paras = splitParagraphs(content);
  const out: MessageSegment[] = [];
  const legacyThinking = new Set<MessageSegment>();
  let textBuf: string[] = [];
  const flushText = () => {
    const text = textBuf.join("\n\n").trim();
    if (text) out.push({ kind: "text", text });
    textBuf = [];
  };

  let i = 0;
  while (i < paras.length) {
    const marker = matchMarker(paras[i]);
    if (!marker) {
      textBuf.push(paras[i]);
      i++;
      continue;
    }
    flushText();
    i++;

    if (marker.kind === "tool_call") {
      const { body, matched } = endsWithClosingTag(marker.body, "tool_use");
      out.push({ kind: "tool_call", name: marker.name, input: prettyJson(body) });
      if (!matched && i < paras.length && isBareClosingTag(paras[i], "tool_use")) i++;
      continue;
    }
    if (marker.kind === "unknown") {
      const { body, matched } = endsWithClosingTag(marker.body, marker.label);
      out.push({ kind: "unknown", label: marker.label, text: prettyJson(body) });
      if (!matched && i < paras.length && isBareClosingTag(paras[i], marker.label)) i++;
      continue;
    }
    if (marker.kind === "tool_result") {
      const closedFirst = endsWithClosingTag(marker.body, "tool_result");
      if (closedFirst.matched) {
        out.push({ kind: "tool_result", text: closedFirst.body.trim() });
        continue;
      }
      // Explicit close, spanning multiple paragraphs (rare — only when the
      // tool result body itself contains a blank line right before the end).
      const scanned: string[] = [];
      let closedAt = -1;
      for (let j = i; j < paras.length && !matchMarker(paras[j]); j++) {
        const stripped = endsWithClosingTag(paras[j], "tool_result");
        scanned.push(stripped.matched ? stripped.body : paras[j]);
        if (stripped.matched) {
          closedAt = j;
          break;
        }
      }
      if (closedAt !== -1) {
        out.push({ kind: "tool_result", text: [marker.body, ...scanned].join("\n\n").trim() });
        i = closedAt + 1;
        continue;
      }
      // Legacy heuristic — no explicit close found in this content.
      const body = [marker.body];
      while (i < paras.length && !matchMarker(paras[i]) && TOOL_OUTPUT_START.test(paras[i])) {
        body.push(paras[i]);
        i++;
      }
      out.push({ kind: "tool_result", text: body.join("\n\n").trim() });
      continue;
    }
    if (marker.kind === "artifact") {
      const body = [marker.body];
      const fenced = /^(```|~~~)/.test(marker.body.trimStart());
      const closed = (s: string) => (s.match(/^(```|~~~)/gm) ?? []).length >= 2;
      if (fenced) {
        while (i < paras.length && !closed(body.join("\n\n"))) {
          body.push(paras[i]);
          i++;
        }
      } else {
        while (i < paras.length && !matchMarker(paras[i])) {
          body.push(paras[i]);
          i++;
        }
      }
      out.push({ kind: "artifact", label: marker.label, text: body.join("\n\n").trim() });
      continue;
    }

    // thinking
    const closedFirst = endsWithClosingTag(marker.body, "thinking");
    if (closedFirst.matched) {
      if (closedFirst.body.trim()) out.push({ kind: "thinking", text: closedFirst.body.trim() });
      continue;
    }
    {
      const scanned: string[] = [];
      let closedAt = -1;
      for (let j = i; j < paras.length && !matchMarker(paras[j]); j++) {
        const stripped = endsWithClosingTag(paras[j], "thinking");
        scanned.push(stripped.matched ? stripped.body : paras[j]);
        if (stripped.matched) {
          closedAt = j;
          break;
        }
      }
      if (closedAt !== -1) {
        const thinkingText = [marker.body, ...scanned].join("\n\n").trim();
        if (thinkingText) out.push({ kind: "thinking", text: thinkingText });
        i = closedAt + 1;
        continue;
      }
    }
    // Legacy heuristic — no explicit close found in this content.
    const thought = [marker.body];
    while (i < paras.length && !matchMarker(paras[i])) {
      thought.push(paras[i]);
      i++;
    }
    const terminal = i >= paras.length;
    const cut = terminal ? replyStartInTerminalThinking(thought) : thought.length;
    const thinkingText = thought.slice(0, cut).join("\n\n").trim();
    if (thinkingText) {
      const seg: MessageSegment = { kind: "thinking", text: thinkingText };
      legacyThinking.add(seg);
      out.push(seg);
    }
    textBuf.push(...thought.slice(cut));
  }
  flushText();
  return promoteHiddenReplies(out, legacyThinking);
}

// Legacy thinking (no [/thinking]) swallows the reply glued after it. Product
// rule: a hidden reply is worse than a visible line of reasoning.
//  1. Thinking right before a tool call (or before the reply a terminal split
//     already found): trailing paragraphs with a STRONG
//     reply signal (markdown structure, or addressing the reader without a
//     planning opener) become visible text, even if the message has other text.
//  2. A message still without any visible text: the last legacy thinking
//     block gives up its trailing reply-like paragraphs, or at least its last
//     one. The first paragraph (right after the marker) always stays thinking.
const MARKDOWN_REPLY = /^(#{1,6}\s|[-*+]\s|\d+[.)]\s|\|)|\*\*[^*\n]+\*\*/m;

function hasStrongReplySignal(p: string): boolean {
  const t = p.trim();
  return MARKDOWN_REPLY.test(t) || (ADDRESSES_READER.test(t) && !REASONING_OPENER.test(t));
}

function looksLikeReply(p: string): boolean {
  const t = p.trim();
  return MARKDOWN_REPLY.test(t) || !REASONING_OPENER.test(t);
}

/** Index where a trailing run of paragraphs matching `test` starts (never 0). */
function trailingRunStart(paras: string[], test: (p: string) => boolean): number {
  let k = paras.length;
  while (k > 1 && test(paras[k - 1])) k--;
  return k;
}

function splitThinking(seg: { kind: "thinking"; text: string }, start: number): MessageSegment[] {
  const paras = seg.text.split(/\n\n/);
  return [
    { kind: "thinking", text: paras.slice(0, start).join("\n\n").trim() },
    { kind: "text", text: paras.slice(start).join("\n\n").trim() },
  ];
}

function promoteHiddenReplies(segs: MessageSegment[], legacy: Set<MessageSegment>): MessageSegment[] {
  if (legacy.size === 0) return segs;
  let out: MessageSegment[] = [];
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    const next = segs[k + 1];
    if (seg.kind === "thinking" && legacy.has(seg) && (next?.kind === "tool_call" || next?.kind === "text")) {
      const paras = seg.text.split(/\n\n/);
      const start = trailingRunStart(paras, hasStrongReplySignal);
      if (start < paras.length) {
        const [t, r] = splitThinking(seg, start);
        legacy.add(t);
        out.push(t);
        if (next.kind === "text") {
          // Contiguous with the reply the terminal split already found: one block.
          out.push({ kind: "text", text: `${r.kind === "text" ? r.text : ""}\n\n${next.text}` });
          k++;
        } else {
          out.push(r);
        }
        continue;
      }
    }
    out.push(seg);
  }
  if (out.some((s) => s.kind === "text")) return out;
  for (let k = out.length - 1; k >= 0; k--) {
    const seg = out[k];
    if (seg.kind !== "thinking" || !legacy.has(seg)) continue;
    const paras = seg.text.split(/\n\n/);
    if (paras.length < 2) continue;
    const run = trailingRunStart(paras, looksLikeReply);
    const start = run < paras.length ? run : paras.length - 1;
    out = [...out.slice(0, k), ...splitThinking(seg, start), ...out.slice(k + 1)];
    break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Quiet rows for claude-code mirrored conversations (D8). The mirror folds
// tool_use/tool_result turns into lines like "[tool: Read src/a.ts]" and
// "[tool_result elided: ok]", and its size cap empties later messages in
// place (their array slot must survive — see mirror-conversations.ts M8).
// ---------------------------------------------------------------------------

const MIRROR_TOOL_LINE = /^\[(tool|tool result|tool_result elided|truncated)\b[^\]]*\]$/;

/** Every non-empty line is a mirrored tool line: nothing a reader would call content. */
export function isToolOnlyMessage(content: string): boolean {
  const lines = (content ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((l) => MIRROR_TOOL_LINE.test(l));
}

/** Number of tool calls in a tool-only message (tool_result/truncated lines don't count as steps). */
export function countToolSteps(content: string): number {
  return (content ?? "").split("\n").filter((l) => /^\[tool[:\]]/.test(l.trim())).length;
}
