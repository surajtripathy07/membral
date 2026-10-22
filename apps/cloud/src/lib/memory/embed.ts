// Memory v1 — embeddings for session_memories.embedding (docs/design/
// memory-v1.md §2: "the semantic leg of memory_search, the merge, the
// supersede rule and the recurrence query"). Thin wrapper around the shared
// kg/llm.ts LlmClient (text-embedding-3-small, 1536-dim, kept per §5) so
// every embed call in this module is billed with `pass: "memory_embedding"`
// (goal 2026-09-13 D2's SQL evidence keys off that exact pass name).
//
// step2d finding 8 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
// #151): the old single-call `embedMany(texts)` had no batching and no
// try/catch — an embeddings outage or a request-size cap thrown mid-call
// discarded a WHOLE session's already-paid-for extraction (the hook logs and
// returns before ever stamping `props`, so the next upload re-pays for the
// entire session). Now chunks into batches of `EMBED_BATCH_SIZE` and catches
// per batch: a failed batch's texts get `embedding: null` in the returned
// array rather than throwing — the caller (tail-capture.ts) still writes
// those records (nullable column), just skipping cosine dedupe/supersede for
// them (merge.ts's `dedupeByCosine`, write.ts's `supersedeRecords`).

import type { Db } from "@/lib/db/types";
import type { LlmClient } from "@/lib/llm/client";
import { embeddingWriteBlockedReason } from "@/lib/llm/embedding-family";
import { toVectorString } from "@/lib/llm/vector";
import { log } from "@/lib/log";

export { toVectorString };

/** OpenAI's own batch limit is 2048; this is a much smaller, conservative chunk so ONE outage/size-cap failure never costs more than this many records' worth of embedding. */
export const EMBED_BATCH_SIZE = 100;

export interface EmbedTextsResult {
  /** Aligned to `texts` by position. `null` at an index means that text's batch failed to embed — never a discarded record, just an unembedded one. */
  vectors: (number[] | null)[];
  costUsd: number;
  /** Count of texts whose batch failed (folds into `props.memory_extraction.embed_failed`). */
  failedCount: number;
  /** D-072: set when the store holds another embedding model's vectors — every vector is null (keyword-only), nothing was called or billed. */
  familyBlocked?: string;
}

/**
 * Embeds a batch of record texts, chunked at `EMBED_BATCH_SIZE` per call. Empty input short-circuits — never calls out for zero texts.
 * With `supabase`, a non-default embedding model first passes the store's
 * one-family check (lib/llm/embedding-family.ts); a refusal returns all-null
 * vectors, never throws. The default model skips the check (no query).
 */
export async function embedTexts(
  llm: LlmClient,
  texts: string[],
  conversationId: string,
  supabase?: Db,
): Promise<EmbedTextsResult> {
  if (texts.length === 0) return { vectors: [], costUsd: 0, failedCount: 0 };
  if (supabase) {
    const blocked = await embeddingWriteBlockedReason(supabase);
    if (blocked) {
      log.warn("memory: embeddings skipped — records stored with embedding=null", {
        conversation_id: conversationId,
        reason: blocked,
      });
      return { vectors: new Array(texts.length).fill(null), costUsd: 0, failedCount: 0, familyBlocked: blocked };
    }
  }
  const vectors: (number[] | null)[] = new Array(texts.length).fill(null);
  let costUsd = 0;
  let failedCount = 0;

  for (let start = 0; start < texts.length; start += EMBED_BATCH_SIZE) {
    const chunk = texts.slice(start, start + EMBED_BATCH_SIZE);
    try {
      const { vectors: chunkVectors, record } = await llm.embedMany({
        texts: chunk,
        pass: "memory_embedding",
        conversationId,
      });
      costUsd += record.cost_usd;
      for (let i = 0; i < chunkVectors.length; i++) vectors[start + i] = chunkVectors[i];
    } catch (err) {
      failedCount += chunk.length;
      log.warn("memory: embed batch failed — storing these records with embedding=null, extraction is not discarded", {
        conversation_id: conversationId,
        batch_start: start,
        batch_size: chunk.length,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { vectors, costUsd, failedCount };
}

export { cosineSimilarityMutable as cosineSimilarity } from "@/lib/domain/similarity";
