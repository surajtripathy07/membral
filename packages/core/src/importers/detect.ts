export type ExportProvider = "chatgpt" | "claude";

/**
 * Sniff whether a parsed `conversations.json` came from a ChatGPT or a
 * Claude.ai data export. Both are a bare array of conversation objects with
 * no top-level format marker, so we look at shape:
 *
 *   - ChatGPT: each entry has a `mapping` tree + `current_node`.
 *   - Claude:  each entry has a `chat_messages` array + a `uuid`.
 *
 * Samples up to the first 5 entries (an export can legitimately start with a
 * degenerate/empty conversation) and returns `null` if neither shape is
 * recognized, so callers can reject the upload with a clear error rather
 * than guessing.
 */
export function detectExportProvider(json: unknown): ExportProvider | null {
  if (!Array.isArray(json)) return null;

  for (const item of json.slice(0, 5)) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;

    if (r.mapping && typeof r.mapping === "object" && "current_node" in r) {
      return "chatgpt";
    }
    if (Array.isArray(r.chat_messages) && typeof r.uuid === "string") {
      return "claude";
    }
  }

  return null;
}
