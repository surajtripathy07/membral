import type { Db } from "@/lib/db/types";
import type { ConversationRow } from "./database.types";
import {
  createEmbeddingGuardContext,
  EmbeddingTokenOverflowError,
  generateEmbedding,
  prepareTextForEmbedding,
} from "./embeddings";
import { hasFeature } from "./feature-flags";
import { currentEmbeddingFamily, embeddingModelField } from "./llm/embedding-client";
import { embeddingWriteBlockedReason } from "./llm/embedding-family";
import { checkMonthlyCeiling } from "./llm/spend-ledger";

const RATE_LIMIT_MS = 200;

// Issue #92 adversarial review m-batching: re-preflight the ceiling every N
// rows rather than once per row (the pre-hoist behavior, one DB round-trip
// per embed) or only once for the whole batch (no mid-batch protection at
// all). 10 was chosen as a middle ground — bounds round-trips to at most
// batch_size/10 while still catching a ceiling crossed by concurrent spend
// (another sync, the KG pipeline, etc.) partway through a large batch. A
// batch of <= 10 rows (the common case: sync/import cap at 50, but most
// syncs land far fewer new conversations) gets exactly ONE preflight, at
// i===0, before the loop's first row.
const CEILING_RECHECK_INTERVAL = 10;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Embeds any of the user's conversations that don't yet have an embedding.
 *
 * The `embedding is null` filter IS the idempotency mechanism — no separate
 * state table. Safe to call repeatedly; already-embedded rows are never
 * re-selected. Also requires `embedding_failed_at is null` (issue #90) — once
 * a row has been retired as permanently un-embeddable (token overflow that
 * survives every reactive halving in generateEmbedding), it stops being
 * re-selected forever. It IS cleared automatically: migration 038's
 * `conversations_clear_embedding_failure` trigger resets it to NULL whenever
 * a retired row is resynced with a newer `updated_at` (a DB trigger, not an
 * app-layer clear here, precisely because THIS module never re-fetches
 * already-embedded/-failed rows to notice a content change — the sync/import
 * upsert paths are the only place that "new content arrived" is visible).
 *
 * Writer/reader contract: embeddings are serialized as `"[a,b,c]"` (a plain
 * bracketed comma-joined string), matching the exact form `search.ts` builds
 * for `query_embedding` when it calls the `search_conversations` RPC. Do not
 * change the model, dimensions, or serialization here without updating both.
 *
 * Ordered by synced_at (ingest recency), not created_at (provider date) — a
 * resumed old chat must still win the batch over stale failures. synced_at is
 * client-supplied with a now() column default; no index on synced_at yet —
 * fine at current scale, add one if this becomes a Sort hotspot. Without this
 * order the query returns heap order, so a handful of deterministically-failing
 * rows (e.g. content over the embedding model's token limit) can sit at the
 * head indefinitely and starve the rest of the limit window — including
 * conversations from the sync/import call that triggered this run, regardless
 * of how old the conversation itself is on the provider's side. Deterministic
 * failures ARE now retired (embedding_failed_at, issue #90) so they stop
 * competing for the head of this ordering once exhausted.
 *
 * Drain semantics: callers pass a limit smaller than "all missing rows" (sync
 * passes the just-synced count capped at 50; import caps at 50 too). Any
 * remainder — including rows this call's monthly cost ceiling stopped short
 * of reaching — is left for the next sync/import call to pick up again;
 * nothing here guarantees full-corpus convergence in one call.
 *
 * COST GUARD BATCHING (issue #92 adversarial review m-batching): builds ONE
 * {@link EmbeddingGuardContext} (one service-role client, one buffered
 * ledger) for the whole batch instead of generateEmbedding's default
 * per-call guard — the ceiling is preflighted here at CEILING_RECHECK_INTERVAL
 * cadence (flushing the ledger immediately before each recheck, so the check
 * sees this batch's OWN spend so far, not just other concurrent activity),
 * and every generateEmbedding call in the loop is handed the shared guard so
 * its own per-call preflight/ledger-mint/immediate-flush is skipped. The
 * ledger is flushed unconditionally in a `finally` so a mid-batch ceiling
 * stop or an unexpected throw never strands buffered-but-unflushed spend.
 *
 * NO `source` FILTER (review-084.md finding 2, considered and declined): this
 * embeds `source='claude-code'` mirrored-code-session rows (written by
 * mirrorCodeSessionsToConversations) exactly like any chat row, unlike
 * cross-links.ts's fetchConversationCandidates, which now allowlists chat
 * sources only. That allowlist exists to stop a project's rollup from
 * cross-linking to its own mirrored sessions; it is NOT a reason to stop
 * embedding those rows here, because lib/search.ts's general conversation
 * search (ADR 0039's "code sessions mirrored as conversations" lane)
 * depends on every `conversations` row — mirrored or chat — having an
 * embedding to be found by semantic search. Filtering here would silently
 * make mirrored sessions unsearchable.
 */
export async function embedMissingConversations(
  supabase: Db,
  userId: string,
  limit: number,
): Promise<{ processed: number; errors: string[]; queryError?: string }> {
  const { data: conversations, error: queryError } = await supabase
    .from("conversations")
    .select("id, title, messages")
    .eq("user_id", userId)
    .is("embedding", null)
    .is("embedding_failed_at", null)
    .order("synced_at", { ascending: false })
    .limit(limit);

  if (queryError) {
    return { processed: 0, errors: [`Query error: ${queryError.message}`], queryError: queryError.message };
  }

  if (!conversations || conversations.length === 0) {
    return { processed: 0, errors: [] };
  }

  // Issue #126 (ADR 0047); "embeddings" not "llm" as of issue #128 (ADR
  // 0047 v2) — one upfront check + one clean log line rather than letting
  // every row in the batch independently throw/catch generateEmbedding's
  // own per-call gate — sync/import must still succeed for a flagged-off/
  // budget-exhausted user; this is the "skipped, not failed" degrade path.
  // generateEmbedding's own gate (embeddings.ts) still covers every other,
  // non-batched call site — this is a batch-loop efficiency win, not a
  // second, independently-trustworthy gate.
  if (!(await hasFeature(userId, "embeddings"))) {
    console.warn(
      `[embed] feature_disabled — skipping embedding batch for user ${userId} (${conversations.length} pending)`,
    );
    return { processed: 0, errors: [] };
  }

  // D-072: a non-default embedding model may write only into a store that
  // holds no other model's vectors (default model: no check, no query).
  const family = currentEmbeddingFamily();
  const blocked = await embeddingWriteBlockedReason(supabase, family);
  if (blocked) {
    console.warn(`[embed] embeddings skipped for user ${userId} (${conversations.length} pending): ${blocked}`);
    return { processed: 0, errors: [] };
  }

  const rows = conversations as Pick<ConversationRow, "id" | "title" | "messages">[];
  const guard = createEmbeddingGuardContext(userId);

  let processed = 0;
  const errors: string[] = [];

  try {
    for (let i = 0; i < rows.length; i++) {
      const conv = rows[i];

      if (guard.supabase && i % CEILING_RECHECK_INTERVAL === 0) {
        // Flush first so this batch's own spend-so-far is visible to the
        // check, not just other concurrent activity for the same user.
        await guard.ledger?.flush();
        const ceiling = await checkMonthlyCeiling(guard.supabase, userId);
        if (!ceiling.allowed) {
          // Ingest-side ceiling behavior (issue #92): stop cleanly, leaving
          // every remaining row's embedding null so it's picked up again on
          // a future sync/import once spend rolls off the 30-day window —
          // matches #21's capped-rows-stay-pending convention. NOT an
          // error: this is expected, orderly backpressure, not a per-row
          // failure.
          console.warn(
            `[embed] monthly cost ceiling exceeded (spent $${ceiling.spentUsd.toFixed(4)} >= $${(ceiling.ceilingUsd as number).toFixed(4)}) — stopping batch for user ${userId} at row ${i}/${rows.length}, remaining rows left pending`,
          );
          break;
        }
      }

      try {
        const messages = (conv.messages || []).map((m) => ({
          role: m.role,
          content: m.content,
        }));

        const text = prepareTextForEmbedding(conv.title, messages);
        const embedding = await generateEmbedding(text, { userId, pass: "conversation_embedding", guard });
        const embeddingStr = `[${embedding.join(",")}]`;

        const { error: updateError } = await supabase
          .from("conversations")
          .update({ embedding: embeddingStr, ...embeddingModelField(true, family) })
          .eq("id", conv.id)
          .eq("user_id", userId);

        if (updateError) {
          errors.push(`Update error for ${conv.id}: ${updateError.message}`);
        } else {
          processed++;
        }
      } catch (err) {
        if (err instanceof EmbeddingTokenOverflowError) {
          // Permanent failure (issue #90): retire the row so the `embedding is
          // null` scan stops re-selecting it forever. Best-effort — if the
          // retirement write itself fails, the row simply falls back to the
          // pre-#90 behavior of being retried next batch.
          console.warn(`[embed] conversation ${conv.id} permanently un-embeddable — marking embedding_failed_at`);
          const { error: failError } = await supabase
            .from("conversations")
            .update({ embedding_failed_at: new Date().toISOString() })
            .eq("id", conv.id)
            .eq("user_id", userId);
          if (failError) {
            errors.push(`Failed to mark embedding_failed_at for ${conv.id}: ${failError.message}`);
          } else {
            errors.push(`Embedding permanently failed for ${conv.id}: ${err.message}`);
          }
        } else {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`Embedding error for ${conv.id}: ${message}`);
        }
      }

      await delay(RATE_LIMIT_MS);
    }
  } finally {
    // Never leave buffered-but-unflushed spend stranded — a mid-batch
    // ceiling `break` or an unexpected throw must still flush what's
    // already been recorded.
    await guard.ledger?.flush();
  }

  return { processed, errors };
}
