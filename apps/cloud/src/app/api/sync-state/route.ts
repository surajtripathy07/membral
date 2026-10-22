// GET /api/sync-state — the Sync State panel's one read endpoint
// (Today page). Tells the truth about what is synced and what is syncing, using only real signals already written elsewhere in
// this codebase — see sync-state-rules.ts's header for the full source list.
//
// Cookie-session auth (requireUserId, same pattern as /api/spike and
// /api/agent-stats) identifies the caller; a short-lived SERVICE-ROLE client
// (same construction as lib/freshness.ts's getFreshnessForUser) reads the
// tables below. Every query is EXPLICITLY `.eq("user_id", userId)` regardless
// of which client issues it, so user-scoping never depends on RLS alone
// (defense in depth, matching lib/code-sessions/queries.ts's own header).

import type { SupabaseClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { type CodeSessionSignalRow, listCodeSessionSignalRows } from "@/lib/code-sessions/queries";
import { getLatestConversationForSource } from "@/lib/conversations/queries";
import { tryServiceClient } from "@/lib/db/clients";
import { log } from "@/lib/log";
import type { RawChatSourceSignal, RawCodeHarnessSignal } from "@/lib/sync-state-shape";
import { shapeSyncState } from "@/lib/sync-state-shape";

// round-5 verification MED 7: "grok" dropped — there is no Grok sync
// provider (packages/extension/src/providers/ only has chatgpt.ts/claude.ts,
// and manifest.json requests no grok.com host permission), so a "Grok /
// Never synced — install the extension" row could never become true. Grok
// stays a valid schema-level `source` value (CLAUDE.md) and SOURCE_LABEL in
// sync-state-content.tsx still maps it, so a
// historically-imported grok conversation/claim still renders correctly —
// this only stops the UI from advertising it as a syncable provider.
const CHAT_SOURCES = ["claude", "chatgpt"] as const;
const CODE_SESSION_FETCH_CEILING = 4000; // 4 PostgREST pages — bounded, demo-scale; see listCodeSessionSignalRows (lib/code-sessions/queries.ts).

/** Later of two ISO timestamps (nulls ignored), mirroring mcp_freshness's GREATEST-ignores-null behavior. */
function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta)) return b;
  if (!Number.isFinite(tb)) return a;
  return ta >= tb ? a : b;
}

// ---------------------------------------------------------------------------
// Chat sources
// ---------------------------------------------------------------------------

interface HeartbeatRow {
  source: string;
  last_run_at: string | null;
  last_item_at: string | null;
}

async function fetchHeartbeats(supabase: SupabaseClient, userId: string): Promise<Map<string, HeartbeatRow>> {
  const { data, error } = await supabase
    .from("sync_heartbeats")
    .select("source, last_run_at, last_item_at")
    .eq("user_id", userId);
  if (error) {
    log.warn("sync-state: sync_heartbeats read failed — treating as no heartbeats", {
      user_id: userId,
      err: error.message,
    });
    return new Map();
  }
  return new Map(((data ?? []) as HeartbeatRow[]).map((r) => [r.source, r]));
}

async function fetchChatSources(
  supabase: SupabaseClient,
  userId: string,
  heartbeats: Map<string, HeartbeatRow>,
): Promise<RawChatSourceSignal[]> {
  const out: RawChatSourceSignal[] = [];
  for (const source of CHAT_SOURCES) {
    const heartbeat = heartbeats.get(source) ?? null;
    let conversations = 0;
    let contentLastItemAt: string | null = null;
    try {
      const { data, count, error } = await getLatestConversationForSource(supabase, userId, source);
      if (error) throw new Error(error.message);
      conversations = count ?? 0;
      contentLastItemAt = (data?.[0] as { updated_at: string | null } | undefined)?.updated_at ?? null;
    } catch (err) {
      log.warn("sync-state: conversations read failed for source", {
        user_id: userId,
        source,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    out.push({
      source,
      conversations,
      lastItemAt: laterIso(heartbeat?.last_item_at ?? null, contentLastItemAt),
      lastRunAt: heartbeat?.last_run_at ?? null,
      hasEverSeen: heartbeat !== null || conversations > 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Code harnesses
// ---------------------------------------------------------------------------

async function fetchCodeHarnesses(
  supabase: SupabaseClient,
  userId: string,
  heartbeats: Map<string, HeartbeatRow>,
): Promise<RawCodeHarnessSignal[]> {
  const codeHeartbeat = heartbeats.get("code") ?? null;
  let rows: CodeSessionSignalRow[] = [];
  try {
    rows = await listCodeSessionSignalRows(supabase, userId, CODE_SESSION_FETCH_CEILING);
  } catch (err) {
    log.warn("sync-state: code_sessions read failed", {
      user_id: userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const byHarness = new Map<string, { sessions: number; projectIds: Set<string>; lastSessionAt: string | null }>();
  for (const row of rows) {
    const harness = row.source ?? "unknown";
    let bucket = byHarness.get(harness);
    if (!bucket) {
      bucket = { sessions: 0, projectIds: new Set(), lastSessionAt: null };
      byHarness.set(harness, bucket);
    }
    bucket.sessions += 1;
    if (row.code_project_id) bucket.projectIds.add(row.code_project_id);
    bucket.lastSessionAt = laterIso(bucket.lastSessionAt, row.started_at);
  }

  return Array.from(byHarness.entries()).map(([harness, bucket]) => ({
    harness,
    projects: bucket.projectIds.size,
    sessions: bucket.sessions,
    lastSessionAt: bucket.lastSessionAt,
    lastRunAt: codeHeartbeat?.last_run_at ?? null,
    hasHeartbeat: codeHeartbeat !== null,
  }));
}

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const GET = withRoute(
  { auth: { kind: "session", unauthorized: "unauthorized" } },
  async ({ user, supabase: cookieSupabase }) => {
    const userId = user.id;
    // Service-role client for tables/RPCs with no (or service-role-only) RLS
    // policies — see this file's header. Falls back to the cookie-bound client
    // (RLS still scopes correctly for the tables that have owner policies) if
    // env vars are somehow missing, matching getFreshnessForUser's own
    // graceful-degrade posture rather than 500ing the whole panel.
    const serviceSupabase = tryServiceClient() ?? cookieSupabase;

    try {
      const heartbeats = await fetchHeartbeats(serviceSupabase, userId);
      const [chat, code] = await Promise.all([
        fetchChatSources(serviceSupabase, userId, heartbeats),
        fetchCodeHarnesses(serviceSupabase, userId, heartbeats),
      ]);

      return NextResponse.json(shapeSyncState({ chat, code }, new Date()));
    } catch (err) {
      log.error("sync-state: unexpected failure", {
        user_id: userId,
        err: err instanceof Error ? err.message : String(err),
      });
      return NextResponse.json({ error: "failed to load sync state" }, { status: 500 });
    }
  },
);
