import type { Conversation, Message, MessageRole } from "./types.js";

interface RawConversationInput {
  source: string;
  source_id: string;
  title?: string | null;
  created_at?: string | number | Date | null;
  updated_at?: string | number | Date | null;
  model?: string | null;
  messages?: RawMessageInput[] | null;
  metadata?: Record<string, unknown> | null;
}

interface RawMessageInput {
  role?: string;
  content?: string;
  timestamp?: string | number | Date | null;
  metadata?: Record<string, unknown> | null;
}

interface NormalizeOptions {
  synced_at?: string;
}

export function normalizeConversation(input: RawConversationInput, options?: NormalizeOptions): Conversation {
  return {
    id: `${input.source}:${input.source_id}`,
    source: input.source,
    source_id: input.source_id,
    title: input.title || "Untitled",
    created_at: toISO(input.created_at),
    updated_at: toISO(input.updated_at),
    model: input.model || null,
    messages: (input.messages || []).map(normalizeMessage),
    metadata: input.metadata || {},
    synced_at: (options?.synced_at ? toISO(options.synced_at) : null) ?? new Date().toISOString(),
  };
}

// F14 ingest canary: validated against the closed MessageRole vocabulary rather than
// a bare cast, so an importer emitting an unrecognized role (e.g. "human") degrades to
// "unknown" instead of silently mislabeling the message — the pass-1 claims gate's G2
// rejects every claim cited from a non-"user" turn, so a mislabeled "user" role would
// silently fail every claim for that corpus (see the G2 canary in kg/claims.ts).
const VALID_MESSAGE_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "system", "unknown"]);

export function normalizeMessage(input: RawMessageInput): Message {
  const role: MessageRole =
    typeof input.role === "string" && VALID_MESSAGE_ROLES.has(input.role) ? (input.role as MessageRole) : "unknown";
  return {
    role,
    content: input.content || "",
    timestamp: toISO(input.timestamp),
    metadata: input.metadata || {},
  };
}

export function toISO(value?: string | number | Date | null): string | null {
  if (value == null) return null;
  if (typeof value === "string") {
    if (value === "") return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  if (value instanceof Date) return value.toISOString();
  return null;
}
