// Handoff-note embeddings (MEMBRAL_HANDOFF_SEARCH). The note is written by replace_session_handoff (migration 136) with
// no vector; this stores one on the row afterwards, through the same embedTexts path and family tagging as every other
// session_memories writer (embedding_model recorded for a non-default family, NULL = default; the one-family check
// returns null vectors). No chat call, no new paid call: only the configured embedding provider. Never throws.

import type { Db } from "@/lib/db/types";
import type { LlmClient } from "@/lib/llm/client";
import { embeddingModelField } from "@/lib/llm/embedding-client";
import { log } from "@/lib/log";
import { embedTexts, toVectorString } from "./embed";

/** Only the first characters of a note are embedded: a note is a few hundred words, and one vector cannot hold more. */
export const HANDOFF_EMBED_MAX_CHARS = 4_000;

export type EmbedHandoffStatus = "embedded" | "skipped_empty" | "no_vector" | "write_failed";

/** Embeds `text` and stores it on the live handoff row `noteId` (only while its embedding is still null). A failed embed leaves null. */
export async function embedHandoffNote(
  db: Db,
  llm: LlmClient,
  userId: string,
  noteId: string,
  text: string,
): Promise<{ status: EmbedHandoffStatus; costUsd: number }> {
  const input = text.trim().slice(0, HANDOFF_EMBED_MAX_CHARS);
  if (input.length === 0) return { status: "skipped_empty", costUsd: 0 };
  try {
    const { vectors, costUsd } = await embedTexts(llm, [input], `handoff-embed:${noteId}`, db);
    const vector = vectors[0] ?? null;
    if (!vector) return { status: "no_vector", costUsd };
    const { error } = await db
      .from("session_memories")
      .update({ embedding: toVectorString(vector), ...embeddingModelField(true) })
      .eq("id", noteId)
      .eq("user_id", userId)
      .eq("kind", "handoff")
      .is("embedding", null);
    if (error) {
      log.warn("memory: handoff embedding write failed", { note_id: noteId, err: error.message });
      return { status: "write_failed", costUsd };
    }
    return { status: "embedded", costUsd };
  } catch (err) {
    log.warn("memory: handoff embedding failed", {
      note_id: noteId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { status: "no_vector", costUsd: 0 };
  }
}
