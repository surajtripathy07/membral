// Heartbeat writer (goal 2026-07-26 step 2 — GitHub #63 silent-breakage
// class, #58 adjacent). Upserted into public.sync_heartbeats (migration 036)
// by every successful ingest route: POST /api/sync, POST /api/import (both
// chat, per provider source present in the batch), and POST /api/code-sessions
// ('code'). Backs the freshness stamp computed in lib/freshness.ts.
//
// NEVER let a heartbeat write fail the ingest it rides along with (CLAUDE.md:
// "log and continue" — same discipline as the spend-ledger and embedding/KG
// fire-and-forget triggers elsewhere in these same routes): every call here
// is fully try/catch'd internally and only ever logs on failure.
import type { Db } from "@/lib/db/types";
import { log } from "@/lib/log";

export interface ChatHeartbeatItem {
  source: string;
  /** ISO updated_at of one synced/imported conversation, or null/undefined if it didn't carry one. */
  itemAt: string | null | undefined;
}

/**
 * Upsert one sync_heartbeats row per distinct source present in `items`.
 * last_run_at is always "now" (this call only happens after a successful
 * ingest); last_item_at is the max of the batch's own itemAt values for that
 * source — but when NONE of the batch's rows for a source carried one (a
 * quiet-cycle heartbeat with no content signal at all, per the MAJOR 2 fix
 * in the sync/import routes), the existing last_item_at is PRESERVED rather
 * than clobbered with null (adversarial review finding: a quiet cycle must
 * not erase a previously-known-good watermark). This needs an explicit
 * read-then-write: PostgREST's bulk upsert requires every row in one request
 * to share the same key set ("All object keys must match" — verified
 * empirically against a local instance), so a mixed batch can't just omit
 * the key per-row to get "leave untouched" semantics; we look up each
 * such source's current last_item_at first and carry it forward instead.
 * The lookup itself is best-effort (wrapped separately) — a failure there
 * must never block the heartbeat write, only risk momentarily re-writing
 * null for that one source (the ingest failure mode this whole module
 * exists to avoid replicating).
 */
export async function recordChatHeartbeats(supabase: Db, userId: string, items: ChatHeartbeatItem[]): Promise<void> {
  if (items.length === 0) return;

  // Round-3 adversarial review MINOR 2: compare parsed epoch millis, not raw
  // ISO strings — string comparison only happens to work when every
  // timestamp shares the exact same format (UTC 'Z', same precision), which
  // isn't guaranteed across writers/clients (same class of bug fixed in
  // freshness.ts's shapePulseFreshness). Every source seen in `items` still
  // gets an entry (defaulting null) even if every one of its itemAt values
  // is missing or unparseable — a garbage timestamp must not silently drop
  // the source from the heartbeat entirely.
  const bySource = new Map<string, string | null>();
  const bySourceMs = new Map<string, number>();
  for (const { source, itemAt } of items) {
    if (!source) continue;
    if (!bySource.has(source)) bySource.set(source, null);
    if (!itemAt) continue;
    const ms = Date.parse(itemAt);
    if (!Number.isFinite(ms)) continue;
    const currentMs = bySourceMs.get(source);
    if (currentMs === undefined || ms > currentMs) {
      bySourceMs.set(source, ms);
      bySource.set(source, itemAt);
    }
  }
  if (bySource.size === 0) return;

  const sourcesNeedingLookup = Array.from(bySource.entries())
    .filter(([, itemAt]) => itemAt === null)
    .map(([source]) => source);

  const existingItemAt = new Map<string, string | null>();
  if (sourcesNeedingLookup.length > 0) {
    try {
      const { data, error } = await supabase
        .from("sync_heartbeats")
        .select("source, last_item_at")
        .eq("user_id", userId)
        .in("source", sourcesNeedingLookup);
      if (error) {
        log.warn("sync_heartbeats last_item_at lookup failed", { user_id: userId, err: error.message });
      } else {
        for (const row of (data ?? []) as { source: string; last_item_at: string | null }[]) {
          existingItemAt.set(row.source, row.last_item_at);
        }
      }
    } catch (err) {
      log.warn("sync_heartbeats last_item_at lookup threw", {
        user_id: userId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const now = new Date().toISOString();
  const rows = Array.from(bySource.entries()).map(([source, itemAt]) => ({
    user_id: userId,
    source,
    last_run_at: now,
    last_item_at: itemAt ?? existingItemAt.get(source) ?? null,
    updated_at: now,
  }));

  try {
    const { error } = await supabase.from("sync_heartbeats").upsert(rows, { onConflict: "user_id,source" });
    if (error) {
      log.warn("sync_heartbeats upsert failed", { user_id: userId, err: error.message });
    }
  } catch (err) {
    log.warn("sync_heartbeats upsert threw", {
      user_id: userId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Record a 'code' heartbeat run (POST /api/code-sessions). last_item_at is
 * left null on purpose — mcp_freshness derives the code content watermark
 * directly from code_sessions.created_at / code_projects.last_active_at, so
 * this heartbeat's only job is recording that an ingest run completed (the
 * kill-test's staleness signal: last_run_at going quiet means the sweep/hook
 * stopped, independent of whether new content happened to land).
 */
export async function recordCodeHeartbeat(supabase: Db, userId: string): Promise<void> {
  const now = new Date().toISOString();
  try {
    const { error } = await supabase
      .from("sync_heartbeats")
      .upsert([{ user_id: userId, source: "code", last_run_at: now, updated_at: now }], {
        onConflict: "user_id,source",
      });
    if (error) {
      log.warn("sync_heartbeats upsert failed (code)", { user_id: userId, err: error.message });
    }
  } catch (err) {
    log.warn("sync_heartbeats upsert threw (code)", {
      user_id: userId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
