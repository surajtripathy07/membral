/**
 * get_conversation's default (include_tool_io=false) rewrite: tool_call and
 * tool_result segments become short stubs before pagination, so a chat whose
 * bulk is raw tool output (e.g. a ~40k-char web-search result inside one
 * message) doesn't blow past the MCP host's output cap (Claude Code: 25,000
 * tokens). Reuses conversation-view's segment splitter — the same one the
 * web viewer uses — rather than re-parsing the `[tag]…[/tag]` markers here.
 */
import { type MessageSegment, parseMessageSegments } from "@/lib/conversation-view";

/** Tool-call input is kept, not omitted, but capped to this many chars. */
export const TOOL_INPUT_STUB_CHARS = 200;

function stubSegment(seg: MessageSegment): { text: string; omittedChars: number } {
  switch (seg.kind) {
    case "text":
      return { text: seg.text, omittedChars: 0 };
    case "thinking":
      return { text: `[thinking]\n${seg.text}`, omittedChars: 0 };
    case "artifact":
      return { text: `[artifact: ${seg.label}]\n${seg.text}`, omittedChars: 0 };
    case "unknown":
      return { text: `[${seg.label}]\n${seg.text}`, omittedChars: 0 };
    case "tool_call": {
      const truncated =
        seg.input.length > TOOL_INPUT_STUB_CHARS ? `${seg.input.slice(0, TOOL_INPUT_STUB_CHARS)}…` : seg.input;
      return {
        text: `[tool_use: ${seg.name}] ${truncated}`,
        omittedChars: Math.max(0, seg.input.length - TOOL_INPUT_STUB_CHARS),
      };
    }
    case "tool_result":
      return {
        text: `[tool_result omitted: ${seg.text.length} chars; include_tool_io=true to see it]`,
        omittedChars: seg.text.length,
      };
  }
}

function hasToolSegments(segs: MessageSegment[]): boolean {
  return segs.some((s) => s.kind === "tool_call" || s.kind === "tool_result");
}

/**
 * Rewrites one message's content, replacing tool_call/tool_result segments
 * with stubs. Content with no tool segments is returned unchanged (same
 * string) so callers can tell nothing moved.
 */
export function omitToolIOFromContent(content: string): { content: string; omittedChars: number } {
  const segs = parseMessageSegments(content);
  if (!hasToolSegments(segs)) return { content, omittedChars: 0 };
  let omittedChars = 0;
  const parts = segs.map((seg) => {
    const stub = stubSegment(seg);
    omittedChars += stub.omittedChars;
    return stub.text;
  });
  return { content: parts.join("\n\n"), omittedChars };
}

/**
 * Rewrites every message's `content` in a conversation payload. Messages
 * that contain no tool segments are left byte-identical (same object
 * reference). Call this before `paginateConversation` so paging sizes
 * messages by their shrunk content, not the original.
 */
export function omitToolIO(conversation: Record<string, unknown>): {
  data: Record<string, unknown>;
  omittedChars: number;
} {
  const messages = conversation.messages;
  if (!Array.isArray(messages)) return { data: conversation, omittedChars: 0 };

  let omittedChars = 0;
  const rewritten = messages.map((item) => {
    if (!item || typeof item !== "object") return item;
    const msg = item as Record<string, unknown>;
    if (typeof msg.content !== "string") return item;
    const { content, omittedChars: n } = omitToolIOFromContent(msg.content);
    if (n === 0 && content === msg.content) return item;
    omittedChars += n;
    return { ...msg, content };
  });

  return { data: { ...conversation, messages: rewritten }, omittedChars };
}
