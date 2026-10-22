import type { Conversation, Message } from "@membral/core";

/**
 * The canonical chat provider source set — single source of truth, exported
 * so callers outside this file (the sync/import routes' `sources[]` field
 * validation, goal 2026-07-26 step 2 MAJOR 2 fix / adversarial review) can
 * validate against the SAME list a conversation's own `source` is checked
 * against here, rather than maintaining a second copy that could drift.
 * NEVER includes 'code' — that's a distinct dimension (ADR 0021 Q2
 * isolation) with its own heartbeat writer (POST /api/code-sessions), and
 * letting a chat-route caller claim it would let `sources: ["code"]` posted
 * to /api/sync forge the code freshness row.
 */
export const CHAT_SOURCES = new Set(["claude", "chatgpt", "grok"]);

/**
 * Per-request ceiling on `conversations[]` (issue #127 abuse-hardening
 * audit, B3) — /api/sync and /api/import previously enforced only per-item
 * SHAPE (this file's own checks below), never a count on the array itself,
 * so an authenticated caller (leaked lls_ key / stolen JWT) could POST an
 * arbitrarily large batch in one request. 500 is comfortably above one
 * extension sync batch (packages/extension/src/sync/cloud-push.ts chunks
 * its own pushes to MAX_SYNC_BATCH_SIZE = 500, the same number, so a
 * well-behaved client never trips this) while bounding a single request's
 * upsert/embedding/KG fan-out work.
 */
export const MAX_CONVERSATIONS_PER_REQUEST = 500;

/** Returns a clear 400-worthy message when `count` exceeds the per-request cap, else null. */
export function conversationCountCapMessage(count: number): string | null {
  if (count <= MAX_CONVERSATIONS_PER_REQUEST) return null;
  return `Request body includes ${count} conversations — the per-request limit is ${MAX_CONVERSATIONS_PER_REQUEST}. Split the batch into smaller requests and retry.`;
}

// F4: the closed MessageRole vocabulary, re-validated at the server ingest boundary.
// The extension already coerces via @membral/core's normalizeMessage (normalizer.ts),
// but this endpoint is reachable by anything that can POST here, not only the
// extension — so an unrecognized role (e.g. "human") must degrade to "unknown" here
// too, in depth, rather than trusting the client to have done it.
const VALID_MESSAGE_ROLES = new Set(["user", "assistant", "system", "unknown"]);

function coerceMessageRole(input: unknown): Message {
  const m = (input ?? {}) as Record<string, unknown>;
  const role = typeof m.role === "string" && VALID_MESSAGE_ROLES.has(m.role) ? (m.role as Message["role"]) : "unknown";
  return { ...m, role } as Message;
}

export function validateConversations(convos: unknown[]): {
  valid: Conversation[];
  errors: string[];
} {
  const valid: Conversation[] = [];
  const errors: string[] = [];

  for (let i = 0; i < convos.length; i++) {
    const c = convos[i] as Record<string, unknown>;
    const issues: string[] = [];

    if (!c || typeof c !== "object") {
      errors.push(`[${i}]: not an object`);
      continue;
    }

    if (!c.source || typeof c.source !== "string") {
      issues.push("source is required and must be a string");
    } else if (!CHAT_SOURCES.has(c.source)) {
      issues.push(`source must be one of: ${[...CHAT_SOURCES].join(", ")} (got "${c.source}")`);
    }

    if (!c.source_id || typeof c.source_id !== "string") {
      issues.push("source_id is required and must be a string");
    }

    if (c.messages !== undefined && !Array.isArray(c.messages)) {
      issues.push("messages must be an array");
    }

    if (issues.length > 0) {
      errors.push(`[${i}]: ${issues.join("; ")}`);
    } else {
      valid.push({
        id: (c.id as string) ?? "",
        source: c.source as string,
        source_id: c.source_id as string,
        title: (c.title as string) ?? "Untitled",
        created_at: (c.created_at as string | null) ?? null,
        updated_at: (c.updated_at as string | null) ?? null,
        model: (c.model as string | null) ?? null,
        messages: Array.isArray(c.messages) ? c.messages.map(coerceMessageRole) : [],
        metadata: c.metadata && typeof c.metadata === "object" ? (c.metadata as Record<string, unknown>) : {},
        synced_at: (c.synced_at as string) ?? new Date().toISOString(),
      });
    }
  }

  return { valid, errors };
}
