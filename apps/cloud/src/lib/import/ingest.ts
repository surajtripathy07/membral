import { after } from "next/server";
import {
  type ConversationQuota,
  getConversationQuota,
  parseConversationLimitError,
  partitionByConversationQuota,
} from "@/lib/billing";
import { chunkMissingConversations, embedMissingChunks } from "@/lib/conversation-chunks";
import { embedMissingConversations } from "@/lib/conversation-embeddings";
import type { ConversationInsert } from "@/lib/database.types";
import type { Db } from "@/lib/db/types";
import { embeddingsConfigured } from "@/lib/llm/embedding-client";
import { type Logger, log } from "@/lib/log";
import { recordChatHeartbeats } from "@/lib/sync-heartbeat";
import { CHAT_SOURCES, validateConversations } from "@/lib/sync-validator";

/**
 * The single ingest path (validate -> upsert -> heartbeat -> post-ingest
 * hooks) shared by every chat-conversation writer: POST /api/import (the
 * extension/CLI's JSON path) and POST /api/import/upload (the bulk
 * ChatGPT/Claude export importer). Extracted from the original /api/import
 * route.ts unchanged in behavior — see that route for the pre-extraction
 * history/comments this carries forward.
 */

const DEFAULT_UPSERT_BATCH_SIZE = 50;
/** Cap applied to every post-ingest hook's limit — unchanged from the pre-extraction /api/import route. */
const POST_INGEST_HOOK_CAP = 50;

/**
 * C0 control characters other than tab/newline/CR, plus DEL — stripped
 * recursively from every string field before upsert (NEW-2, round-2
 * review). Postgres rejects a NUL byte (U+0000) inside jsonb outright
 * ("unsupported Unicode escape sequence"), which meant a single poison
 * character anywhere in one conversation's title/messages/metadata could
 * fail its entire upsert batch. The other C0 controls aren't rejected by
 * Postgres but have no legitimate place in chat content either, so they're
 * stripped for the same reason. \t \n \r are preserved — real conversation
 * text uses them.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally matching C0 controls (except \t\n\r) to strip them — see comment above
const STRIP_CONTROL_CHARS_RE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function sanitizeControlChars<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(STRIP_CONTROL_CHARS_RE, "") as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => sanitizeControlChars(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = sanitizeControlChars(v);
    }
    return out as T;
  }
  return value;
}

export interface IngestOptions {
  /** Upsert batch size. Default 50 — matches the original /api/import route. */
  batchSize?: number;
  /**
   * Optional/undefined means "leave whatever is already stored untouched" is
   * NOT in play here — these are sources to heartbeat even if this call's
   * batch contains zero valid rows for them (symmetric with /api/sync).
   * Pre-filtered against CHAT_SOURCES by the caller or here — either way,
   * junk values are dropped.
   */
  declaredSources?: string[];
  rlog?: Logger;
  /**
   * Skip the fire-and-forget embedding/chunking/KG hooks — used by the bulk
   * upload route, which calls `ingestConversations` once per ~100-row chunk
   * and wants the hooks triggered once per HTTP request, not once per chunk.
   */
  skipPostIngestHooks?: boolean;
  /**
   * Issue #127 (conversation_limit enforcement, /api/import only —
   * /api/import/upload keeps its own pre-existing behavior unchanged so
   * this doesn't ripple into that route's already-tested imported/updated
   * split): when true, rows that are brand-new for this user (not already
   * present, per `source`+`source_id`) are accepted only up to the user's
   * remaining `profiles.conversation_limit` headroom — the rest are
   * reported via `IngestResult.skipped`/`quota` instead of upserted.
   * Existing rows (updates) are never blocked by this.
   */
  enforceQuota?: boolean;
}

export interface IngestResult {
  /** Rows successfully upserted this call (across every internal batch). */
  imported: number;
  /** Validation errors (from `rawConversations`) plus any per-batch/per-row upsert errors. */
  errors: string[];
  /**
   * "source:source_id" for every row that was validated and ATTEMPTED but
   * still failed to upsert even after the per-row retry below (NEW-2,
   * round-2 review) — e.g. a value Postgres genuinely rejects regardless of
   * sanitization. Callers that need to know exactly which conversations
   * landed (the upload route's imported/updated split) should treat
   * anything NOT in this set, among what they attempted, as having landed.
   */
  failedKeys: string[];
  /**
   * Count of NEW conversations rejected by conversation_limit — either the
   * app-level pre-partition (`options.enforceQuota`) or migration 078's DB
   * trigger catching a row the pre-partition missed/skipped (round-2
   * review, HIGH 3/4/6). Set whenever either mechanism rejected at least
   * one row, regardless of `options.enforceQuota`.
   */
  skipped?: number;
  /**
   * "source:source_id" for every row rejected specifically by
   * conversation_limit (as opposed to a genuine write failure, in
   * `failedKeys`) — callers that compute their own imported/updated split
   * (the upload route) must exclude these, not count them as landed.
   */
  quotaSkippedKeys: string[];
  /** The quota snapshot enforcement was checked against (issue #127). Set whenever `skipped` is. */
  quota?: ConversationQuota;
}

export async function ingestConversations(
  supabase: Db,
  userId: string,
  rawConversations: unknown[],
  options: IngestOptions = {},
): Promise<IngestResult> {
  const batchSize = options.batchSize ?? DEFAULT_UPSERT_BATCH_SIZE;
  const rlog = options.rlog ?? log;
  const declaredSources = [...new Set((options.declaredSources ?? []).filter((s) => CHAT_SOURCES.has(s)))];

  const { valid: validAll, errors } = validateConversations(rawConversations);

  if (validAll.length === 0) {
    if (declaredSources.length > 0) {
      await recordChatHeartbeats(
        supabase,
        userId,
        declaredSources.map((source) => ({ source, itemAt: null })),
      );
    }
    return { imported: 0, errors, failedKeys: [], quotaSkippedKeys: [] };
  }

  // Issue #127: conversation_limit enforcement. Existing rows (updates) are
  // always let through; brand-new rows are accepted only up to the
  // remaining headroom. Checked BEFORE the upsert loop below so a rejected
  // row is never written at all — accurate, not best-effort.
  //
  // Round-2 review MED 11: findExistingConversationKeys now reports
  // `degraded` when a lookup for some source errored (e.g. a transient DB
  // blip). Partitioning against an incomplete existingKeys set would
  // misclassify real UPDATES as brand-new inserts, which can 402 a batch of
  // pure updates for an account already at its limit. When degraded, skip
  // the app-level pre-partition entirely for this call — every row is
  // attempted, and migration 078's DB trigger (the atomic backstop, not
  // best-effort) is what actually enforces the limit; genuinely-over-quota
  // new rows still get rejected below, just via the trigger/row-retry path
  // instead of a pre-emptive filter.
  let valid = validAll;
  let skipped: number | undefined;
  let quota: ConversationQuota | undefined;
  if (options.enforceQuota) {
    quota = await getConversationQuota(userId);
    const { keys: existingKeys, degraded } = await findExistingConversationKeys(supabase, userId, validAll, rlog);
    if (!degraded) {
      const partition = partitionByConversationQuota(validAll, existingKeys, quota);
      valid = partition.accepted;
      skipped = partition.skipped.length;
    } else {
      rlog.warn(
        "ingestConversations: findExistingConversationKeys degraded, skipping app-level quota pre-partition for this call — DB trigger still enforces",
      );
    }
  }

  if (valid.length === 0) {
    if (declaredSources.length > 0) {
      await recordChatHeartbeats(
        supabase,
        userId,
        declaredSources.map((source) => ({ source, itemAt: null })),
      );
    }
    return { imported: 0, errors, failedKeys: [], quotaSkippedKeys: [], skipped, quota };
  }

  let totalImported = 0;
  const upsertErrors: string[] = [...errors];
  const failedKeys: string[] = [];
  const quotaSkippedKeys: string[] = [];
  let quotaSkippedCount = skipped ?? 0;
  const importedItems: { source: string; itemAt: string | null }[] = [];

  const upsertRow = (row: ConversationInsert) =>
    supabase.from("conversations").upsert([row], { onConflict: "user_id,source,source_id", ignoreDuplicates: false });

  for (let i = 0; i < valid.length; i += batchSize) {
    const batch = valid.slice(i, i + batchSize);

    // NEW-2 (round-2 review, part a): recursively strip NUL and other C0
    // control chars from every string field BEFORE the row ever reaches
    // Postgres — this is what prevents most poison-content failures from
    // happening at all (see sanitizeControlChars above).
    const rows: ConversationInsert[] = batch.map((c) =>
      sanitizeControlChars<ConversationInsert>({
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
      }),
    );

    const { error: upsertError } = await supabase.from("conversations").upsert(rows, {
      onConflict: "user_id,source,source_id",
      ignoreDuplicates: false,
    });

    if (!upsertError) {
      totalImported += batch.length;
      for (const c of batch) importedItems.push({ source: c.source, itemAt: c.updated_at });
      continue;
    }

    // NEW-2 (round-2 review, part b): the whole-batch upsert failed —
    // sanitization above handles the common NUL case, but Postgres can
    // still reject a row for other reasons (e.g. a lone UTF-16 surrogate).
    // Retry ONE ROW AT A TIME to isolate exactly which row(s) are the
    // problem, rather than letting one poison row sink every other
    // (perfectly good) row in the same batch. Only ever taken on the
    // (rare) failure path — the common case stays a single round trip.
    upsertErrors.push(
      `Batch ${Math.floor(i / batchSize) + 1}: ${upsertError.message} — retrying ${rows.length} row(s) individually`,
    );
    for (let j = 0; j < rows.length; j++) {
      const row = rows[j];
      const c = batch[j];
      const { error: rowError } = await upsertRow(row);
      if (rowError) {
        const key = `${c.source}:${c.source_id}`;
        // Round-2 review HIGH 3/4/6: migration 078's trigger caught this
        // row — either the app-level pre-partition above wasn't run for
        // this call (options.enforceQuota false, e.g. /api/import/upload
        // before its own fix) or it raced another concurrent request
        // (HIGH 6's TOCTOU window). Classify as a quota skip, NOT a
        // generic write failure — this is expected, correct behavior, not
        // a bug to surface in `errors`/`failedKeys`.
        const limitInfo = parseConversationLimitError(rowError);
        if (limitInfo) {
          quotaSkippedCount++;
          quotaSkippedKeys.push(key);
          if (!quota) quota = limitInfo;
          continue;
        }
        failedKeys.push(key);
        upsertErrors.push(`${key}: ${rowError.message}`);
      } else {
        totalImported += 1;
        importedItems.push({ source: c.source, itemAt: c.updated_at });
      }
    }
  }

  for (const source of declaredSources) {
    if (!importedItems.some((item) => item.source === source)) {
      importedItems.push({ source, itemAt: null });
    }
  }
  if (importedItems.length > 0) {
    await recordChatHeartbeats(supabase, userId, importedItems);
  }

  if (!options.skipPostIngestHooks && totalImported > 0) {
    triggerPostIngestHooks(supabase, userId, totalImported, rlog);
  }

  return {
    imported: totalImported,
    errors: upsertErrors,
    failedKeys,
    quotaSkippedKeys,
    skipped: quotaSkippedCount > 0 ? quotaSkippedCount : skipped,
    quota,
  };
}

/**
 * Post-ingest embedding / chunk-index triggers.
 * Exported so the upload route (which calls `ingestConversations` once per
 * chunk with `skipPostIngestHooks: true`) can trigger this exactly once per
 * HTTP request instead of once per internal chunk.
 *
 * Issue #132 (hosted extraction engine): the whole pipeline below now runs
 * inside next/server's `after()` instead of bare `.then()/.catch()` chains —
 * see /api/sync/route.ts's matching comment for the full rationale (this
 * function had the IDENTICAL "no platform guarantee it ever runs on
 * Vercel" bug). `after()` must be called from an active request's execution
 * context; this function is only ever reached from POST /api/import and
 * POST /api/import/upload (both real request handlers), so that's always
 * satisfied. Order/guards unchanged: embed conversations
 * (embeddings-gated) -> chunk conversations -> embed chunks (nested,
 * embeddings-gated).
 */
export function triggerPostIngestHooks(supabase: Db, userId: string, totalImported: number, rlog: Logger = log): void {
  if (totalImported <= 0) return;

  after(async () => {
    if (embeddingsConfigured()) {
      try {
        const { processed, errors } = await embedMissingConversations(
          supabase,
          userId,
          Math.min(totalImported, POST_INGEST_HOOK_CAP),
        );
        if (errors.length > 0) {
          rlog.warn("embedding errors", { processed, errorCount: errors.length, errors: errors.slice(0, 3) });
        }
      } catch (err) {
        rlog.error("embedding failed", { err: err instanceof Error ? err.message : String(err) });
      }
    }

    try {
      const { processed, errors } = await chunkMissingConversations(
        supabase,
        userId,
        Math.min(totalImported, POST_INGEST_HOOK_CAP),
      );
      if (errors.length > 0) {
        rlog.warn("chunking errors", { processed, errorCount: errors.length, errors: errors.slice(0, 3) });
      }
      if (embeddingsConfigured()) {
        try {
          const { processed: embedded, errors: embedErrors } = await embedMissingChunks(
            supabase,
            userId,
            POST_INGEST_HOOK_CAP,
          );
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

export interface ExistingConversationKeysResult {
  keys: Set<string>;
  /**
   * Round-2 review MED 11: true when at least one source's lookup errored
   * (a transient DB blip, not a "this source has zero existing rows"
   * result) — `keys` may be INCOMPLETE for that source. Was previously a
   * silent `continue` that returned an empty set for the failed source,
   * which `partitionByConversationQuota` then treated as "every row in
   * that source is brand-new" — for an account already at its
   * conversation_limit, a pure-UPDATE batch could get fully 402'd during
   * exactly the kind of blip this was meant to be resilient to. Callers
   * enforcing quota MUST check this before trusting `keys` for that
   * purpose (see ingestConversations above); the upload route's cosmetic
   * imported/updated split can ignore it, same as before.
   */
  degraded: boolean;
}

/**
 * Read-only helper for the upload route's imported/updated split in its
 * response, and for ingestConversations' quota pre-partition. Returns the
 * set of "source:source_id" keys among `conversations` that already exist
 * for this user, i.e. an upsert of that row will be an UPDATE, not an
 * INSERT.
 */
export async function findExistingConversationKeys(
  supabase: Db,
  userId: string,
  conversations: { source: string; source_id: string }[],
  rlog: Logger = log,
): Promise<ExistingConversationKeysResult> {
  const existing = new Set<string>();
  let degraded = false;
  const bySource = new Map<string, string[]>();
  for (const c of conversations) {
    const list = bySource.get(c.source) ?? [];
    list.push(c.source_id);
    bySource.set(c.source, list);
  }

  for (const [source, sourceIds] of bySource) {
    const { data, error } = await supabase
      .from("conversations")
      .select("source_id")
      .eq("user_id", userId)
      .eq("source", source)
      .in("source_id", sourceIds);

    if (error) {
      // The upload route's cosmetic imported/updated split tolerates this
      // (worst case that split is inaccurate); ingestConversations' quota
      // pre-partition does NOT (see `degraded` above) — the caller decides.
      rlog.warn("findExistingConversationKeys: lookup failed, results for this source may be incomplete", {
        source,
        err: error.message,
      });
      degraded = true;
      continue;
    }
    for (const row of (data ?? []) as { source_id: string }[]) {
      existing.add(`${source}:${row.source_id}`);
    }
  }

  return { keys: existing, degraded };
}
