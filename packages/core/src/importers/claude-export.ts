import { normalizeConversation } from "../normalizer.js";
import type { Conversation } from "../types.js";
import type { ParsedExportResult } from "./chatgpt-export.js";
import type { RawImportedMessage, SkippedItem } from "./types.js";

function guessLangFromPath(path: string): string {
  const ext = path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  if (!ext) return "";
  const map: Record<string, string> = {
    md: "md",
    markdown: "md",
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    py: "python",
    rb: "ruby",
    go: "go",
    rs: "rust",
    java: "java",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    html: "html",
    css: "css",
    scss: "scss",
    sh: "bash",
    sql: "sql",
  };
  return map[ext] || ext;
}

/**
 * Render a single Claude content block to plain text.
 *
 * Claude messages are an array of typed blocks. We preserve everything that
 * carries useful textual signal:
 *   - text                — plain markdown
 *   - tool_use            — the model invoking a tool. For "artifacts" we
 *                           extract the artifact body so it isn't lost; for
 *                           other tools we keep a compact representation of
 *                           the input/name.
 *   - tool_result         — output of a tool call (e.g. analysis output)
 *   - thinking            — extended-thinking traces (kept compact)
 *
 * Anything we don't recognize is rendered as a JSON-tagged block so the
 * conversation log never silently drops content.
 *
 * Every non-text block also emits an explicit closing marker
 * (`[/tool_use]`, `[/tool_result]`, `[/thinking]`, `[/<type>]`) so a
 * consumer splitting the flattened string never has to guess where a
 * block ends — see conversation-view.ts's parseMessageSegments.
 *
 * Shared by the live extension sync (packages/extension/src/providers/claude.ts,
 * which fetches this same `chat_messages`/content-block shape from Claude.ai's
 * backend API) and the bulk `conversations.json` export importer below.
 */
function renderContentBlock(block: Record<string, unknown>): string {
  const type = (block.type as string) || "";

  if (type === "text") {
    return (block.text as string) || "";
  }

  if (type === "tool_use") {
    const name = (block.name as string) || "tool";
    const input = block.input as Record<string, unknown> | undefined;

    // Artifacts ride on the standard "artifacts" tool. Hoist the body so
    // semantic search can hit on the artifact's actual content.
    if (name === "artifacts" && input) {
      const artifactType = (input.type as string) || "artifact";
      const title = (input.title as string) || (input.id as string) || "";
      const body = (input.content as string) || (input.command as string) || "";
      const lang = (input.language as string) || "";
      const fence = lang ? `\`\`\`${lang}\n${body}\n\`\`\`` : body;
      return `[artifact: ${artifactType}${title ? ` — ${title}` : ""}]\n${fence}`.trim();
    }

    // File-creation tools (create_file / str_replace_editor / write_file etc.)
    // place the body in a documented field. Hoist it inline so its content is
    // searchable instead of being trapped behind a [tool_use] tag.
    if (input) {
      const fileBody =
        (input.file_text as string) ||
        (input.content as string) ||
        (input.text as string) ||
        (input.body as string) ||
        "";
      const path = (input.path as string) || (input.filename as string) || (input.file_path as string) || "";
      const description = (input.description as string) || "";
      if (fileBody && (path || /file|write|create/i.test(name))) {
        const lang = guessLangFromPath(path);
        const fence = lang ? `\`\`\`${lang}\n${fileBody}\n\`\`\`` : fileBody;
        const header = [`[artifact: ${name}`, path && `— ${path}`, description && `— ${description}`]
          .filter(Boolean)
          .join(" ")
          .trim();
        return `${header}]\n${fence}`;
      }
    }

    // Generic tool call — preserve name + a compact input dump.
    const inputStr = input ? JSON.stringify(input) : "";
    return `[tool_use: ${name}]${inputStr ? `\n${inputStr}` : ""}\n[/tool_use]`;
  }

  if (type === "tool_result") {
    const content = block.content;
    if (typeof content === "string") return `[tool_result]\n${content}\n[/tool_result]`;
    if (Array.isArray(content)) {
      return `[tool_result]\n${content.map((c) => renderContentBlock(c as Record<string, unknown>)).join("\n")}\n[/tool_result]`;
    }
    return "[tool_result]\n[/tool_result]";
  }

  if (type === "thinking") {
    const thought = (block.thinking as string) || (block.text as string) || "";
    return thought ? `[thinking]\n${thought}\n[/thinking]` : "";
  }

  // Fallback: keep a tagged JSON dump rather than dropping silently.
  const safe = JSON.stringify(block).slice(0, 4000);
  const tag = type || "unknown";
  return `[${tag}]\n${safe}\n[/${tag}]`;
}

/**
 * Extract a linear message list from a single Claude conversation payload —
 * either the live backend API's `chat_conversations/:id` response or one
 * `conversations.json` entry from an official data export. Both share the
 * same `chat_messages: [{sender, content?: [...blocks], text?}]` shape.
 *
 * Defensive per the export format: prefers `content[]` blocks when present,
 * falls back to the plain `text` field otherwise (some export snapshots only
 * carry `text`).
 */
export function extractMessages(rawConversation: unknown): RawImportedMessage[] {
  const messages: RawImportedMessage[] = [];
  if (!rawConversation || typeof rawConversation !== "object") return messages;
  const chatMessages = (rawConversation as Record<string, unknown>).chat_messages;
  if (!Array.isArray(chatMessages)) return messages;

  for (const raw of chatMessages) {
    if (!raw || typeof raw !== "object") continue;
    const msg = raw as Record<string, unknown>;
    const role = msg.sender === "human" ? "user" : "assistant";

    let content = "";
    if (Array.isArray(msg.content)) {
      content = msg.content
        .map((block) =>
          block && typeof block === "object" ? renderContentBlock(block as Record<string, unknown>) : "",
        )
        .filter((s: string) => s.length > 0)
        .join("\n\n");
    } else if (typeof msg.text === "string") {
      content = msg.text;
    }

    if (content) {
      messages.push({
        role,
        content,
        timestamp: (msg.created_at as string | undefined) || (msg.updated_at as string | undefined),
        metadata: {
          ...(typeof msg.model === "string" && msg.model ? { model: msg.model } : {}),
          ...(typeof msg.uuid === "string" && msg.uuid ? { message_id: msg.uuid } : {}),
        },
      });
    }
  }

  return messages;
}

/**
 * Parse an official Claude.ai `conversations.json` export (an array of
 * {uuid, name, created_at, updated_at, chat_messages: [...]}) into
 * normalized Conversations. Never throws on a malformed entry — it's
 * recorded in `skipped` instead so one bad conversation doesn't sink an
 * entire import.
 */
export function parseClaudeExport(json: unknown): ParsedExportResult {
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
      const id = typeof r.uuid === "string" && r.uuid.length > 0 ? r.uuid : undefined;
      if (!id) {
        skipped.push({ id: idLabel, reason: "missing uuid" });
        continue;
      }
      idLabel = id;

      const messages = extractMessages(r);
      const model =
        (typeof r.model === "string" && r.model) ||
        (messages.find((m) => m.metadata?.model)?.metadata?.model as string | undefined) ||
        null;

      const conv = normalizeConversation({
        source: "claude",
        source_id: id,
        title: typeof r.name === "string" && r.name ? r.name : "Untitled",
        created_at: r.created_at as string | number | null | undefined,
        updated_at: r.updated_at as string | number | null | undefined,
        model,
        messages,
        metadata: {
          ...(typeof r.project_uuid === "string" && { project_id: r.project_uuid }),
        },
      });
      conversations.push(conv);
    } catch (err) {
      skipped.push({ id: idLabel, reason: err instanceof Error ? err.message : "parse error" });
    }
  }

  return { conversations, skipped };
}
