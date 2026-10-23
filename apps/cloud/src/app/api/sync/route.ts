import { after, type NextRequest, NextResponse } from "next/server";
import { corsPreflight } from "@/lib/api/cors";
import { withRoute } from "@/lib/api/route";
import { getConversationQuota, parseConversationLimitError, partitionByConversationQuota } from "@/lib/billing";
import { chunkMissingConversations, embedMissingChunks } from "@/lib/conversation-chunks";
import { embedMissingConversations } from "@/lib/conversation-embeddings";
import { upsertConversations } from "@/lib/conversations/queries";
import type { ConversationInsert } from "@/lib/database.types";
import { getServiceClient } from "@/lib/db/clients";
import { readTextBodyWithLimit } from "@/lib/http-body";
import { findExistingConversationKeys } from "@/lib/import/ingest";
import { embeddingsConfigured } from "@/lib/llm/embedding-client";
import { log, requestId } from "@/lib/log";
import { userBucket } from "@/lib/rate-limit";
import { recordChatHeartbeats } from "@/lib/sync-heartbeat";
import { CHAT_SOURCES, conversationCountCapMessage, validateConversations } from "@/lib/sync-validator";

// Issue #127 abuse-hardening audit (B3): a body-size ceiling — no default
// Next.js app-router body-size cap exists (that's a Pages-Router-only
// config knob), so an authenticated caller (a stolen JWT or lls_ key; this
// route takes a Supabase JWT or an unscoped lls_ key) could otherwise POST an arbitrarily large
// payload. 25MB is comfortably
// above one extension sync batch (MAX_CONVERSATIONS_PER_REQUEST = 500
// conversations, cloud-push.ts chunks to the same number) while bounding a
// single request's parse/upsert work.
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const SYNC_CORS_METHODS = "POST, OPTIONS";

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req, SYNC_CORS_METHODS);
}

// Auth -> rate limit (issue #127 abuse-hardening audit B2/B3: this route had
// no rate limit at all before, despite triggering fire-and-forget
// embedding/KG-extraction work on every call) -> handler; withRoute sets the
// SYNC_CORS_METHODS CORS headers on every exit, as withCors did by hand.
export const POST = withRoute(
  {
    // Supabase JWT (the hosted extension sign-in) or an unscoped lls_ key (the local stack's key, pasted into
    // the extension's options page). A scoped key is a read lens, never a write grant: 403.
    auth: {
      kind: "dual",
      missing: "Missing authorization",
      invalidToken: "Invalid token",
      invalidKey: "Invalid API key",
      scoped: { reject: "Scoped API keys cannot sync conversations" },
    },
    rateLimit: { name: "sync", bucket: ({ userId }) => userBucket("sync", userId) },
    cors: { methods: SYNC_CORS_METHODS },
  },
  async ({ req, userId }) => {
    const supabase = getServiceClient();
    const rlog = log.withContext({ request_id: requestId(req), route: "/api/sync" }).withContext({ user_id: userId });

    // 1c. Body-size ceiling — issue #127, hardened round-2 review MED 7:
    // readTextBodyWithLimit counts bytes across STREAM CHUNKS as they arrive
    // (never trusting the client-controlled Content-Length header, and never
    // buffering an oversized body in full before checking) — chunked
    // transfer encoding or a lying Content-Length can't walk past this.
    let rawText: string;
    try {
      const result = await readTextBodyWithLimit(req.body, MAX_BODY_BYTES);
      if ("tooLarge" in result) {
        return NextResponse.json({ error: "Request body too large" }, { status: 413 });
      }
      rawText = result.text;
    } catch {
      return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
    }

    // 2. Parse and validate request body
    let body: unknown;
    try {
      body = JSON.parse(rawText);
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const { conversations, sources: sourcesField } = (body as Record<string, unknown>) ?? {};

    if (!Array.isArray(conversations)) {
      return NextResponse.json({ error: "Request body must include a conversations array" }, { status: 400 });
    }

    // 1d. Per-request count ceiling (issue #127).
    const countCapMessage = conversationCountCapMessage(conversations.length);
    if (countCapMessage) {
      return NextResponse.json({ error: countCapMessage }, { status: 400 });
    }

    // Optional `sources` field (MAJOR 2 fix, goal 2026-07-26 step 2, #63/#58):
    // provider ids the extension confirms it just ran a successful sync cycle
    // for, even when that cycle found zero new conversations. Backward
    // compatible — an old-format request with no `sources` field behaves
    // exactly as before (heartbeat only follows actual new rows).
    //
    // VALIDATED against the canonical CHAT_SOURCES set (round-2 adversarial
    // review, MAJOR 2): unvalidated, this field would let a caller post
    // `sources: ["code"]` to /api/sync and forge the CODE freshness row
    // (defeating the exact detection this feature exists for — the code
    // pipeline silently dying would then look healthy), and any junk string
    // would create an unbounded sync_heartbeats row and land verbatim in
    // every MCP tool response. Filtered + deduped.
    const declaredSources = Array.isArray(sourcesField)
      ? [...new Set(sourcesField.filter((s): s is string => typeof s === "string" && CHAT_SOURCES.has(s)))]
      : [];

    // 3. Validate conversations
    const { valid: validatedAll, errors } = validateConversations(conversations);

    // 4. Enforce profiles.conversation_limit (issue #127 abuse-hardening
    // audit — the limit was not enforced at the API layer before this).
    // Existing rows (updates) always go through; brand-new rows are accepted
    // only up to the remaining headroom — see partitionByConversationQuota.
    let valid = validatedAll;
    let skippedCount = 0;
    let quota: { limit: number; count: number } | undefined;
    if (validatedAll.length > 0) {
      quota = await getConversationQuota(userId);
      const { keys: existingKeys, degraded } = await findExistingConversationKeys(supabase, userId, validatedAll, rlog);
      // Round-2 review MED 11: a degraded lookup can't be trusted to tell
      // updates from new rows — skip the pre-partition rather than risk
      // misclassifying a pure-update batch as brand-new and 402ing it.
      // Migration 078's DB trigger still enforces the real limit below.
      if (!degraded) {
        const partition = partitionByConversationQuota(validatedAll, existingKeys, quota);
        valid = partition.accepted;
        skippedCount = partition.skipped.length;
      }
    }

    // Full rejection: every conversation in the batch was brand-new and NONE
    // fit under the remaining headroom. A partial batch (some accepted, some
    // skipped) still returns 200 below with `skipped`/`atLimit` set — the
    // extension already treats `atLimit: true` as "don't advance the local
    // push cursor, re-send the remainder next cycle" (cloud-push.ts).
    if (valid.length === 0 && skippedCount > 0 && quota) {
      return NextResponse.json(
        { error: "conversation_limit", limit: quota.limit, count: quota.count },
        { status: 402 },
      );
    }

    if (valid.length === 0) {
      // A genuinely quiet cycle (source declared, nothing new) still records a
      // heartbeat — see the header note on the `sources` field above.
      if (declaredSources.length > 0) {
        await recordChatHeartbeats(
          supabase,
          userId,
          declaredSources.map((source) => ({ source, itemAt: null })),
        );
      }
      return NextResponse.json(
        {
          synced: 0,
          total: conversations.length,
          errors,
        },
        { status: 200 },
      );
    }

    // 5. Upsert conversations
    const rows: ConversationInsert[] = valid.map((c) => ({
      user_id: userId,
      source: c.source,
      source_id: c.source_id,
      title: c.title || "Untitled",
      created_at: c.created_at,
      updated_at: c.updated_at,
      model: c.model,
      messages: c.messages,
      metadata: c.metadata,
      synced_at: c.synced_at,
    }));

    const { error: upsertError } = await upsertConversations(supabase, rows, {
      onConflict: "user_id,source,source_id",
      ignoreDuplicates: false,
    });

    if (upsertError) {
      const limitInfo = parseConversationLimitError(upsertError);
      if (!limitInfo) {
        return NextResponse.json({ error: "Database error", detail: upsertError.message }, { status: 500 });
      }

      // Round-2 review HIGH 6: migration 078's DB trigger rejected this
      // bulk upsert — the app-level pre-partition above raced a concurrent
      // request and computed stale headroom. A single multi-row upsert is
      // one Postgres statement: the trigger raising on ANY row rolls back
      // ALL of them, so retry row-by-row to salvage whichever still fit
      // under the (now-accurate) count, same recovery ingestConversations
      // already does for a batch-level failure.
      const landedRowIdx: number[] = [];
      let quotaRejectedInRetry = 0;
      for (let i = 0; i < rows.length; i++) {
        const { error: rowError } = await upsertConversations(supabase, [rows[i]], {
          onConflict: "user_id,source,source_id",
          ignoreDuplicates: false,
        });
        if (!rowError) {
          landedRowIdx.push(i);
          continue;
        }
        const rowLimitInfo = parseConversationLimitError(rowError);
        if (!rowLimitInfo) {
          return NextResponse.json({ error: "Database error", detail: rowError.message }, { status: 500 });
        }
        quotaRejectedInRetry++;
        quota = rowLimitInfo;
      }

      if (landedRowIdx.length === 0) {
        return NextResponse.json(
          { error: "conversation_limit", limit: quota?.limit, count: quota?.count },
          { status: 402 },
        );
      }

      valid = landedRowIdx.map((i) => valid[i]);
      skippedCount += quotaRejectedInRetry;
    }

    const synced = valid.length;

    // Freshness heartbeat (goal 2026-07-26 step 2, #63/#58) — one row per
    // provider source present in this batch, PLUS any declared `sources` that
    // landed no new rows this cycle (MAJOR 2 fix: a quiet-but-healthy provider
    // must still heartbeat, not just a provider with new content). Never let
    // this fail the sync response: recordChatHeartbeats catches and logs
    // internally.
    const heartbeatItems = valid.map((c) => ({ source: c.source, itemAt: c.updated_at }));
    for (const source of declaredSources) {
      if (!heartbeatItems.some((item) => item.source === source)) {
        heartbeatItems.push({ source, itemAt: null });
      }
    }
    if (heartbeatItems.length > 0) {
      await recordChatHeartbeats(supabase, userId, heartbeatItems);
    }

    // Issue #132 (hosted extraction engine): every post-response step below
    // used to be a bare `.then()/.catch()` — never awaited, never registered
    // with the platform, so on Vercel it had NO guarantee of running at all
    // once the response flushed (the instance can be frozen/recycled the
    // moment the `return` below completes). `after()` (Next 15,
    // stable) keeps this invocation alive/billed until the whole callback
    // settles, up to maxDuration (raised to 300s for this route in
    // vercel.json — after() work counts against that budget, same as any
    // other code the platform keeps the instance alive for). Order/guards are
    // unchanged from the pre-#132 fire-and-forget version: embed conversations
    // (embeddings-gated) -> chunk conversations -> embed chunks (nested,
    // embeddings-gated, only after chunking resolves) -> KG pass1
    // (MEMBRAL_KG_ENABLED-gated). Each step keeps its OWN try/catch (not one
    // wrapping try for all four) so a failure in one never blocks the next —
    // same isolation the separate `.catch()`s used to provide. Steps now run
    // sequentially (awaited) rather than concurrently: after() needs the
    // callback's OWN returned promise to settle before it's considered done,
    // so anything still fire-and-forget INSIDE this callback would reintroduce
    // the exact bug this migration fixes.
    if (synced > 0) {
      after(async () => {
        if (embeddingsConfigured()) {
          // Limit capped at 50 like /api/import — bounds post-response work.
          // Any remainder (including rows that fail every time) self-heals on
          // the next sync via the `embedding is null` filter, now
          // newest-first so doomed rows never block fresh ones. Passing
          // `synced` as the limit would also re-burn API cost re-attempting
          // permanently-failing rows on every large sync; the cap bounds that
          // too.
          try {
            const { processed, errors } = await embedMissingConversations(supabase, userId, Math.min(synced, 50));
            if (errors.length > 0) {
              rlog.warn("embedding errors", { processed, errorCount: errors.length, errors: errors.slice(0, 3) });
            }
          } catch (err) {
            rlog.error("embedding failed", { err: err instanceof Error ? err.message : String(err) });
          }
        }

        // Chunk-level chat index (goal 2026-07-26 step 11, #39 folded in) —
        // additive, same isolation as the embedding step above. Chunking
        // itself is zero-LLM (no embeddings gate); embedding those chunks
        // reuses the same cost-guarded path/env gate as conversation embeds,
        // and only runs once chunking resolves (a real dependency: chunks
        // must exist before they can be embedded). Capped at 50 for the same
        // reason embedMissingConversations is.
        try {
          const { processed, errors } = await chunkMissingConversations(supabase, userId, Math.min(synced, 50));
          if (errors.length > 0) {
            rlog.warn("chunking errors", { processed, errorCount: errors.length, errors: errors.slice(0, 3) });
          }
          // MAJOR-1 fix (round-2 adversarial re-verification, 2026-07-26): this
          // used to gate on `processed > 0`, which is ALWAYS 0 on a converged
          // corpus (chunking itself has nothing left to do once every
          // conversation is covered) — so the chunk EMBEDDING backlog could
          // never drain; a batch of already-chunked-but-unembedded rows sat
          // forever because this call never even ran. Embedding is a SEPARATE
          // concern from "did chunking find new/stale conversations this
          // cycle" (conversation-chunks.ts's ASC-ordered missing-embedding scan
          // is the other half of this fix — see that file). Still gated on
          // a configured embeddings key and still isolated in
          // its own try/catch so a chunking failure never blocks this call and
          // an embedding failure never fails the request.
          if (embeddingsConfigured()) {
            try {
              const { processed: embedded, errors: embedErrors } = await embedMissingChunks(supabase, userId, 50);
              if (embedErrors.length > 0) {
                rlog.warn("chunk embedding errors", {
                  embedded,
                  errorCount: embedErrors.length,
                  errors: embedErrors.slice(0, 3),
                });
              }
            } catch (err) {
              rlog.error("chunk embedding failed", { err: err instanceof Error ? err.message : String(err) });
            }
          }
        } catch (err) {
          rlog.error("chunking failed", { err: err instanceof Error ? err.message : String(err) });
        }
      });
    }

    return NextResponse.json({
      synced,
      total: conversations.length,
      errors,
      skipped: skippedCount,
      atLimit: skippedCount > 0,
    });
  },
);
