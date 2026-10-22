// Memory v1, source C — windowing (docs/design/memory-v1.md §3 "C — tail
// capture"). Splits a session's rendered turn lines into ~6,000-token
// windows on turn boundaries with a one-turn overlap (a decision arc that
// straddles a window boundary must not be cut in half). Token counts are
// estimated as chars/4 (no tokenizer dependency) — the same approximation
// §6's cost model itself uses.
//
// Chat pre-context (§3 "Shared by all three"): up to 3 `code_cross_links`
// conversations for the session's project, one line each, <= 500 tokens,
// prepended to EVERY window alongside the header. Locally there are 0
// code_cross_links rows (BRIEF.md) — fetchChatPrecontext handles that by
// simply returning no lines, never throwing.
import type { Db } from "@/lib/db/types";
import { log } from "@/lib/log";
import type { RenderedTurn } from "./render";

/** chars-per-token estimate used throughout memory v1 (matches §6's own median-session estimate). */
const CHARS_PER_TOKEN = 4;
/**
 * D3 decision C1 (2026-09-24, prompt v6): halved from 12_000 — a recall
 * lever (D-047): gpt-4o-mini skims long appended input, so fewer turns per
 * call means fewer skipped ones, at roughly the same input spend (each turn
 * is still read once; only the per-window header and one-turn overlap
 * repeat). The per-session budget guard
 * (budget.ts) and the checkpoint semantics (tail-capture.ts) are unchanged.
 */
export const WINDOW_TARGET_TOKENS = 6_000;
const WINDOW_TARGET_CHARS = WINDOW_TARGET_TOKENS * CHARS_PER_TOKEN;
const PRECONTEXT_MAX_TOKENS = 500;
const PRECONTEXT_MAX_CHARS = PRECONTEXT_MAX_TOKENS * CHARS_PER_TOKEN;
const MAX_PRECONTEXT_CONVERSATIONS = 3;

export interface MemoryWindow {
  /** 0-based position among this session's windows, in order. */
  windowIndex: number;
  turns: RenderedTurn[];
  /** True when at least one turn in this window is user prose (§3: never dropped by budget degrade). */
  containsUserProse: boolean;
  /** True when every turn is tool_use/tool_result (no prose at all, from either role). */
  isToolOnly: boolean;
  /** From turn props.agent_id, when the parser records one — the parser doesn't today (sub-agent turns aren't imported at all, see packages/core/src/sessions/claude-code.ts), so this is always false; kept as a real field rather than a hardcoded constant so a future parser change is honored automatically. */
  isSubAgent: boolean;
  /** proseChars / totalChars — the degrade tiebreak (§3: "density-first would discard exactly what the product promises" applies to windows WITHOUT user prose only; see budget.ts). */
  proseDensity: number;
  charLen: number;
}

/** Turn boundaries only — never splits a single turn's line across two windows. One-turn overlap: window N+1 starts at the LAST turn of window N. */
export function buildWindows(turns: RenderedTurn[]): MemoryWindow[] {
  if (turns.length === 0) return [];
  const windows: MemoryWindow[] = [];
  let start = 0;
  while (start < turns.length) {
    let end = start; // inclusive
    let chars = turns[start].charLen;
    while (end + 1 < turns.length && chars + turns[end + 1].charLen <= WINDOW_TARGET_CHARS) {
      end += 1;
      chars += turns[end].charLen;
    }
    // A single oversized turn (its own line already over budget) stands
    // alone in its own window — `end` never advances past `start` here.
    const slice = turns.slice(start, end + 1);
    windows.push(makeWindow(windows.length, slice));
    if (end + 1 >= turns.length) break;
    // One-turn overlap: the next window re-includes this one's last turn —
    // EXCEPT when this window held only that one (oversized) turn, where
    // "overlapping" would mean starting the next window at the exact same
    // index, never advancing (an infinite loop). In that case skip past it
    // with no overlap instead.
    start = end > start ? end : end + 1;
  }
  return windows;
}

function makeWindow(windowIndex: number, turns: RenderedTurn[]): MemoryWindow {
  const charLen = turns.reduce((n, t) => n + t.charLen, 0);
  const proseChars = turns.filter((t) => t.isProse).reduce((n, t) => n + t.charLen, 0);
  const containsUserProse = turns.some((t) => t.isProse && t.role === "user");
  // A tool_use turn with written text (Write/Edit content) is authored text: its window is not tool-only.
  const isToolOnly = turns.every((t) => (t.kind === "tool_use" && !t.hasWrittenText) || t.kind === "tool_result");
  return {
    windowIndex,
    turns,
    containsUserProse,
    isToolOnly,
    isSubAgent: false, // see MemoryWindow.isSubAgent doc — no per-turn agent_id exists to read yet
    proseDensity: charLen > 0 ? proseChars / charLen : 0,
    charLen,
  };
}

export interface ChatPrecontextLine {
  conversationId: string;
  line: string;
}

interface CrossLinkRow {
  conversation_id: string;
}
interface ConversationPreviewRow {
  id: string;
  title: string | null;
  messages: unknown;
}

function firstMessageSnippet(messages: unknown): string {
  if (!Array.isArray(messages) || messages.length === 0) return "";
  const first = messages[0] as { content?: unknown } | undefined;
  const content = typeof first?.content === "string" ? first.content : "";
  return content.replace(/\s+/g, " ").trim().slice(0, 160);
}

/**
 * Up to 3 code_cross_links conversations for this project, one line each,
 * capped at ~500 tokens total (design §3). Never throws — a query failure or
 * an empty result both degrade to `[]`, exactly like the 0-rows-locally case
 * (BRIEF.md: code_cross_links has 3 rows total, none backfilled to a
 * conversation yet on this corpus).
 */
export async function fetchChatPrecontext(
  supabase: Db,
  userId: string,
  codeProjectId: string,
): Promise<ChatPrecontextLine[]> {
  try {
    const linksRes = await supabase
      .from("code_cross_links")
      .select("conversation_id")
      .eq("user_id", userId)
      .eq("code_project_id", codeProjectId)
      .is("dismissed_at", null)
      .limit(MAX_PRECONTEXT_CONVERSATIONS);
    if (linksRes.error) throw new Error(linksRes.error.message);
    const links = (linksRes.data ?? []) as CrossLinkRow[];
    if (links.length === 0) return [];

    const convRes = await supabase
      .from("conversations")
      .select("id, title, messages")
      .eq("user_id", userId)
      .in(
        "id",
        links.map((l) => l.conversation_id),
      );
    if (convRes.error) throw new Error(convRes.error.message);
    const rows = (convRes.data ?? []) as ConversationPreviewRow[];

    let budget = PRECONTEXT_MAX_CHARS;
    const out: ChatPrecontextLine[] = [];
    for (const r of rows) {
      const snippet = firstMessageSnippet(r.messages);
      const line = `- (chat) ${r.title ?? "Untitled"}${snippet ? `: ${snippet}` : ""}`;
      if (line.length > budget) break;
      budget -= line.length;
      out.push({ conversationId: r.id, line });
    }
    return out;
  } catch (err) {
    log.warn("memory: fetchChatPrecontext failed — proceeding with no chat pre-context", {
      user_id: userId,
      code_project_id: codeProjectId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export function renderPrecontextBlock(lines: ChatPrecontextLine[]): string {
  if (lines.length === 0) return "Chat pre-context: (none)";
  return ["Chat pre-context (background only, never quotable):", ...lines.map((l) => l.line)].join("\n");
}
