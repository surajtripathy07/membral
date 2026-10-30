// Issue #598 / migration 138: repairs session_memories rows whose embedding failed at extraction. A failed embed batch
// stamps `embedding_failed_at` (tail-capture.ts -> write/insert.ts); this pass re-embeds those rows once the marker is
// older than the retry window (compared inside Postgres), so a down embedder is retried once per window, not every kick.
//
// Same embedding input as extraction (the record text, no prefix) and the same `embedding_model` tag
// (`embeddingModelField`). Success sets the vector and clears the marker; a failure bumps the marker. Rows with empty
// text are never selected. Every read and write is scoped by user_id; the batch and the user count are bounded.
// It never throws: a failure is logged and the pass moves on. Run by kickExtraction, i.e. by the hosted cron and the
// local in-process loop, the same triggers as extraction itself.
import type { Db } from "@/lib/db/types";
import { embeddingModelField } from "@/lib/llm/embedding-client";
import { embeddingWriteBlockedReason } from "@/lib/llm/embedding-family";
import { toVectorString } from "@/lib/llm/vector";
import { log } from "@/lib/log";
import {
  createDefaultUnitEmbedder,
  EMBED_RETRY_AFTER_SECONDS,
  isUsableVector,
  type UnitEmbedder,
} from "./raw-units/embed";

/** Rows re-embedded per user per pass. */
export const MEMORY_EMBED_RETRY_BATCH = 50;

/** Users repaired per pass. */
export const MEMORY_EMBED_RETRY_MAX_USERS = 20;

export interface MemoryEmbedRetrySummary {
  users: number;
  embedded: number;
  failed: number;
  skipped: boolean;
}

export interface RetryUserOptions {
  retrySeconds?: number;
  batchSize?: number;
  /** Test seam: defaults to the process's configured embedder (null when none). */
  embedder?: UnitEmbedder | null;
}

/** Re-embeds one user's due rows. Returns the counts; never throws. */
export async function retryMemoryEmbeddingsForUser(
  db: Db,
  userId: string,
  opts: RetryUserOptions = {},
): Promise<{ embedded: number; failed: number }> {
  const none = { embedded: 0, failed: 0 };
  const retrySeconds = opts.retrySeconds ?? EMBED_RETRY_AFTER_SECONDS;
  const batchSize = opts.batchSize ?? MEMORY_EMBED_RETRY_BATCH;
  try {
    const embedder = opts.embedder === undefined ? createDefaultUnitEmbedder() : opts.embedder;
    if (!embedder) return none; // unconfigured: nothing failed, nothing to retry yet
    // A store that holds another family's vectors takes no new vector: leave the rows and their markers alone.
    if (await embeddingWriteBlockedReason(db, embedder.family)) return none;

    const { data, error } = await db.rpc("memory_embed_retry_batch", {
      p_user_id: userId,
      p_retry_seconds: retrySeconds,
      p_limit: batchSize,
    });
    if (error) throw new Error(error.message);
    const rows = ((data ?? []) as { id: string; text: string }[]).filter((r) => r.text.trim() !== "");
    if (rows.length === 0) return none;

    let vectors: (number[] | null)[];
    try {
      const out = await embedder.embedBatch(rows.map((r) => r.text));
      vectors = rows.map((_, i) => (isUsableVector(out[i]) ? out[i] : null));
    } catch (err) {
      log.warn("memory: embed retry batch failed — markers bumped, next try after the window", {
        user_id: userId,
        size: rows.length,
        err: err instanceof Error ? err.message : String(err),
      });
      vectors = rows.map(() => null);
    }

    const model = embeddingModelField(true, embedder.family).embedding_model ?? null;
    const { error: applyError } = await db.rpc("memory_embed_retry_apply", {
      p_user_id: userId,
      p_rows: rows.map((r, i) => ({ id: r.id, embedding: vectors[i] ? toVectorString(vectors[i]) : null })),
      p_embedding_model: model as string,
    });
    if (applyError) throw new Error(applyError.message);
    const embedded = vectors.filter((v) => v !== null).length;
    return { embedded, failed: rows.length - embedded };
  } catch (err) {
    log.warn("memory: embed retry failed for a user — rows stay as they are", {
      user_id: userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return none;
  }
}

/** Finds users with due rows and repairs each, stopping at `deadlineMs` (epoch). Never throws. */
export async function retryMemoryEmbeddings(
  db: Db,
  opts: RetryUserOptions & { deadlineMs?: number; maxUsers?: number } = {},
): Promise<MemoryEmbedRetrySummary> {
  const summary: MemoryEmbedRetrySummary = { users: 0, embedded: 0, failed: 0, skipped: false };
  try {
    const { data, error } = await db.rpc("memory_embed_retry_users", {
      p_retry_seconds: opts.retrySeconds ?? EMBED_RETRY_AFTER_SECONDS,
      p_limit: opts.maxUsers ?? MEMORY_EMBED_RETRY_MAX_USERS,
    });
    if (error) throw new Error(error.message);
    for (const userId of (data ?? []) as string[]) {
      if (opts.deadlineMs !== undefined && Date.now() > opts.deadlineMs) {
        summary.skipped = true;
        break;
      }
      const r = await retryMemoryEmbeddingsForUser(db, userId, opts);
      summary.users++;
      summary.embedded += r.embedded;
      summary.failed += r.failed;
    }
  } catch (err) {
    // Before migration 138 the functions do not exist: the pass is a no-op.
    log.warn("memory: embed retry pass skipped", { err: err instanceof Error ? err.message : String(err) });
    summary.skipped = true;
  }
  if (summary.embedded > 0 || summary.failed > 0) log.info("memory: embed retry pass", { ...summary });
  return summary;
}
