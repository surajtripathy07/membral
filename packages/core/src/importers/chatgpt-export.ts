import { normalizeConversation } from "../normalizer.js";
import type { Conversation } from "../types.js";
import type { RawImportedMessage, SkippedItem } from "./types.js";

/**
 * Render a ChatGPT message `content` payload to text, preserving as many
 * useful artifacts as we can:
 *
 *   - text                  — plain text or markdown
 *   - multimodal_text       — text + image/file references
 *   - code                  — code interpreter / canvas code blocks
 *   - execution_output      — code interpreter results
 *   - tether_quote          — quoted browse / file content
 *   - system_error          — surfaced errors
 *
 * Unknown shapes fall back to a JSON-tagged dump so we never silently
 * drop content.
 *
 * Shared by the live extension sync (packages/extension/src/providers/chatgpt.ts,
 * which fetches this same `mapping`-tree shape from ChatGPT's backend API) and
 * the bulk `conversations.json` export importer below — both walk the same
 * tree shape, so this lives in one place rather than two.
 */
export function renderChatgptContent(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const c = content as Record<string, unknown>;
  const type = (c.content_type as string) || "";

  const renderParts = (parts: unknown): string => {
    if (!Array.isArray(parts)) return "";
    return parts
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const part = p as Record<string, unknown>;
          if (part.asset_pointer) return `[asset: ${part.asset_pointer}]`;
          if (typeof part.text === "string") return part.text;
          return `[part: ${JSON.stringify(part).slice(0, 500)}]`;
        }
        return "";
      })
      .filter((s) => s.length > 0)
      .join("\n");
  };

  if (type === "text" || type === "multimodal_text") {
    return renderParts(c.parts);
  }

  if (type === "code") {
    const lang = (c.language as string) || "";
    const text = (c.text as string) || renderParts(c.parts);
    return text ? `\`\`\`${lang}\n${text}\n\`\`\`` : "";
  }

  if (type === "execution_output") {
    const text = (c.text as string) || "";
    return text ? `[execution_output]\n${text}` : "";
  }

  if (type === "tether_quote") {
    const url = (c.url as string) || "";
    const title = (c.title as string) || "";
    const text = (c.text as string) || "";
    const head = [title, url].filter(Boolean).join(" — ");
    return [head ? `[quote: ${head}]` : "[quote]", text].filter(Boolean).join("\n");
  }

  if (type === "system_error") {
    return `[system_error]\n${(c.text as string) || JSON.stringify(c).slice(0, 500)}`;
  }

  // Fallback — keep the payload visible rather than dropping it.
  const safe = JSON.stringify(c).slice(0, 4000);
  return `[${type || "unknown"}]\n${safe}`;
}

/**
 * Walk a ChatGPT `mapping` tree (either the live backend API's full
 * conversation payload, or one `conversations.json` entry from an official
 * data export — both share this exact shape) from `current_node` up through
 * `parent` pointers, then reverse to get the linear active-branch transcript.
 *
 * A `visited` set guards against a cyclic/malformed `parent` chain (untrusted
 * user-uploaded export data) looping forever; real API/export payloads are
 * always acyclic so this never changes behavior for well-formed input.
 */
export function treeToLinearMessages(raw: unknown): RawImportedMessage[] {
  if (!raw || typeof raw !== "object") return [];
  const root = raw as Record<string, unknown>;
  const mapping = (root.mapping && typeof root.mapping === "object" ? root.mapping : {}) as Record<
    string,
    {
      message?: {
        content?: unknown;
        author?: { role?: string };
        create_time?: number;
        metadata?: { model_slug?: string };
        id?: string;
      } | null;
      parent?: string;
    } | null
  >;
  let nodeId: string | undefined = typeof root.current_node === "string" ? root.current_node : undefined;

  const chain: NonNullable<(typeof mapping)[string]>["message"][] = [];
  const visited = new Set<string>();

  while (nodeId && mapping[nodeId] && !visited.has(nodeId)) {
    visited.add(nodeId);
    const node = mapping[nodeId];
    if (node?.message && node.message.content) {
      chain.push(node.message);
    }
    nodeId = node?.parent;
  }

  chain.reverse();
  const messages: RawImportedMessage[] = [];

  for (const msg of chain) {
    if (!msg) continue;
    const role: string | undefined = msg.author?.role;
    if (role === "system") continue;

    const content = renderChatgptContent(msg.content);

    if (content && (role === "user" || role === "assistant" || role === "tool")) {
      messages.push({
        role: role === "tool" ? "assistant" : role,
        content,
        timestamp: msg.create_time,
        metadata: {
          ...(msg.metadata?.model_slug && { model: msg.metadata.model_slug }),
          ...(msg.id && { message_id: msg.id }),
          ...(role === "tool" && { tool_role: true }),
        },
      });
    }
  }

  return messages;
}

export interface ParsedExportResult {
  conversations: Conversation[];
  skipped: SkippedItem[];
}

/**
 * Parse an official ChatGPT `conversations.json` export (an array of
 * {id, title, create_time, update_time, current_node, mapping}) into
 * normalized Conversations. Never throws on a malformed entry — it's
 * recorded in `skipped` instead so one bad conversation doesn't sink an
 * entire import.
 */
export function parseChatGptExport(json: unknown): ParsedExportResult {
  const conversations: Conversation[] = [];
  const skipped: SkippedItem[] = [];

  if (!Array.isArray(json)) {
    return { conversations: [], skipped: [{ id: "<root>", reason: "export root is not an array" }] };
  }

  for (let i = 0; i < json.length; i++) {
    const raw = json[i];
    let idLabel = `index:${i}`;
    try {
      if (!raw || typeof raw !== "object") {
        skipped.push({ id: idLabel, reason: "entry is not an object" });
        continue;
      }
      const r = raw as Record<string, unknown>;
      const id = typeof r.id === "string" && r.id.length > 0 ? r.id : undefined;
      if (!id) {
        skipped.push({ id: idLabel, reason: "missing id" });
        continue;
      }
      idLabel = id;

      const messages = treeToLinearMessages(r);
      const model = (messages.find((m) => m.metadata?.model)?.metadata?.model as string | undefined) ?? null;

      const conv = normalizeConversation({
        source: "chatgpt",
        source_id: id,
        title: typeof r.title === "string" && r.title ? r.title : "Untitled",
        created_at: r.create_time as string | number | null | undefined,
        updated_at: r.update_time as string | number | null | undefined,
        model,
        messages,
        metadata: {},
      });
      conversations.push(conv);
    } catch (err) {
      skipped.push({ id: idLabel, reason: err instanceof Error ? err.message : "parse error" });
    }
  }

  return { conversations, skipped };
}
