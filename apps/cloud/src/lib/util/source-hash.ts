// Stable content hash for a conversation's message array (role + content only,
// normalized so raw jsonb and already-parsed arrays hash identically). Used by
// lib/code-sessions/mirror-conversations.ts to decide whether a mirrored
// session's messages changed.

import { createHash } from "node:crypto";

export interface SourceHashMessage {
  role: string;
  content: string;
}

/**
 * Roles pass1.ts's own extraction accepts. Duplicated here rather than
 * imported — this repo's own convention already keeps a private copy of this
 * exact set per module that needs it (see pass1.ts's own VALID_MESSAGE_ROLES,
 * lib/sync-validator.ts's, and packages/core/src/normalizer.ts's), since none
 * of those modules share a common dependency this file could pull from
 * without introducing one. Keep in sync with pass1.ts's copy if the accepted
 * role vocabulary ever changes.
 */
const VALID_MESSAGE_ROLES: ReadonlySet<string> = new Set(["user", "assistant", "system", "unknown"]);

/**
 * Normalizes raw (possibly malformed) message data into the exact (role,
 * content) shape pass1.ts's ConvRowSchema used to produce: an invalid or
 * missing `role` becomes "unknown", non-string `content` becomes "". Mirrors
 * `z.array(ConvRowSchema).catch([])`'s all-or-nothing behavior for the one
 * edge case that isn't a per-field default — a message that isn't even a
 * plain object (not just a bad field on one) wipes the WHOLE array to `[]`,
 * so a pre-Zod-parsed caller and a raw-jsonb caller can never disagree on
 * that case either.
 */
function normalizeMessages(raw: unknown): SourceHashMessage[] {
  if (!Array.isArray(raw)) return [];
  const out: SourceHashMessage[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return [];
    const roleRaw = (item as { role?: unknown }).role;
    const role = typeof roleRaw === "string" && VALID_MESSAGE_ROLES.has(roleRaw) ? roleRaw : "unknown";
    const contentRaw = (item as { content?: unknown }).content;
    const content = typeof contentRaw === "string" ? contentRaw : "";
    out.push({ role, content });
  }
  return out;
}

export function computeSourceHash(messages: unknown): string {
  const normalized = normalizeMessages(messages);
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
