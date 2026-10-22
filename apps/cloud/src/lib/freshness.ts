// Per-source freshness stamp (goal 2026-07-26 step 2 — GitHub #63 silent-
// breakage class, #58 adjacent). The chat corpus went stale for ~12 weeks
// with no signal anywhere that said so; this module is the single source of
// truth for "how current is this user's data," read by three surfaces:
// every MCP tool response (lib/mcp/server.ts), /pulse (api/spike/route.ts +
// pulse-content.tsx), and (indirectly, via its own SyncState-based logic)
// the extension toolbar badge.
//
// getFreshness() is the ONLY network-touching export here — it calls the
// migration-036 `mcp_freshness` RPC (SECURITY INVOKER, service_role-only,
// same discipline as every other mcp_* RPC in migration 016/030) and NEVER
// throws: a failed/unavailable RPC degrades to `null`, per this goal step's
// explicit requirement that a freshness failure must never break the tool
// response it's attached to.
//
// Everything else below is pure (no I/O), so it's covered by plain vitest —
// no Supabase mocking needed for the staleness/shaping logic itself.

import { tryServiceClient } from "@/lib/db/clients";
import type { Db } from "@/lib/db/types";

export interface FreshnessSource {
  last_item_at: string | null;
  last_synced_at: string | null;
}

/** Keyed by source: 'claude' | 'chatgpt' | 'grok' | 'code'. Sources with no heartbeat AND no content are omitted entirely (mcp_freshness's own contract) — never present as a null-filled placeholder. */
export type FreshnessMap = Record<string, FreshnessSource>;

export interface FreshnessPayload {
  corpus_current_through: FreshnessMap;
  generated_at: string;
}

/**
 * "source ISO · source ISO" — the content shared by formatFreshnessPrefix
 * (bracketed, for plain-text tool responses) and the compact JSON-embedded
 * form (NOTE fix below). Sorted alphabetically by source for a
 * deterministic, test-stable line. Null when freshness is null or has no
 * sources — callers render nothing in that case, not an empty bracket pair.
 */
function compactFreshnessLine(freshness: FreshnessPayload | null): string | null {
  if (!freshness) return null;
  const entries = Object.entries(freshness.corpus_current_through);
  if (entries.length === 0) return null;
  return entries
    .slice()
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([source, s]) => `${source} ${s.last_item_at ?? "unknown"}`)
    .join(" · ");
}

/**
 * Compact single-line freshness stamp, as a PREFIX, for PLAIN-TEXT
 * (non-JSON) MCP tool responses — the manually-handled tools' success/
 * not-found text and toolResult's isError text (BLOCKER 1 fix: the stamp
 * was previously a protocol-level sibling of `content`, which hosts never
 * hand to the model — proven via SDK round-trip. It must live INSIDE the
 * text a model actually reads).
 *
 * PREFIX, not suffix (MINOR 5 fix, round-2 adversarial review): a large
 * payload (a long conversation, a big project rollup) can run well past
 * what a truncating consumer reads — this eval harness included, which caps
 * captured tool-call text at MAX_RESPONSE_CHARS. A stamp appended at the END
 * of such a response is silently lost. One convention, applied everywhere a
 * plain-text response carries the stamp: it always LEADS the text, mirroring
 * how toolResult's JSON envelope puts `freshness` as the first key.
 *
 * Empty string (nothing prepended, no leftover blank line) when freshness is
 * null or has no sources.
 */
export function formatFreshnessPrefix(freshness: FreshnessPayload | null): string {
  const line = compactFreshnessLine(freshness);
  return line ? `[corpus current through: ${line}]\n\n` : "";
}

/**
 * Compact value for the JSON-embedded `freshness` field inside toolResult's
 * `{freshness, data}` envelope (NOTE fix, round-2 adversarial review): the
 * full FreshnessPayload object, pretty-printed at 2-space indent inside
 * EVERY tool response, ran to ~15 lines purely for the stamp — real token
 * cost paid on every single call. This carries the same information (which
 * source, current through when) as one string, same as formatFreshnessPrefix
 * minus the brackets (redundant once it's already a well-named JSON field).
 * Null when there's nothing to show — the JSON value is `"freshness": null`,
 * not an empty string.
 */
export function formatFreshnessCompactValue(freshness: FreshnessPayload | null): string | null {
  return compactFreshnessLine(freshness);
}

/**
 * Compute the freshness payload for one user. Never throws: an RPC error (or
 * any other failure — a bad client, a network blip) degrades to `null` so a
 * caller can always do `freshness ?? null` without a try/catch of its own.
 */
export async function getFreshness(supabase: Db, userId: string): Promise<FreshnessPayload | null> {
  try {
    const { data, error } = await supabase.rpc("mcp_freshness", { p_user_id: userId });
    if (error) return null;
    return {
      corpus_current_through: (data ?? {}) as FreshnessMap,
      generated_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/**
 * Convenience wrapper for a caller that doesn't already hold a service-role
 * Supabase client (mcp_freshness is service_role-only, per migration 036 —
 * see its header) — e.g. /pulse's api/spike/route.ts, which otherwise only
 * has the cookie-bound RLS client. Builds its own short-lived service client
 * from env vars.
 *
 * MAJOR 3 fix (adversarial review): constructing that client from missing
 * env vars throws SYNCHRONOUSLY. If that construction happens while still
 * being evaluated as an argument to getFreshness(...) — e.g.
 * `getFreshness(makeClient(), userId).catch(...)` — the throw happens
 * BEFORE getFreshness is even invoked, so it is not inside the promise
 * chain a trailing `.catch()` attaches to; it propagates straight out of
 * the caller as an uncaught exception (a hard 500 on /pulse — exactly the
 * silent-breakage failure mode this whole feature exists to prevent).
 * Wrapping BOTH the client construction and the getFreshness call in one
 * try/catch here closes that gap.
 */
export async function getFreshnessForUser(userId: string): Promise<FreshnessPayload | null> {
  try {
    const supabase = tryServiceClient();
    if (!supabase) return null;
    return await getFreshness(supabase, userId);
  } catch {
    return null;
  }
}

// ---- Staleness thresholds (brief: code sweep runs every 20min, chat has no
// comparable cadence yet) ----------------------------------------------------

/** Code is stale once its last confirmed sync run is older than this — the sweep's own cadence is 20 minutes, so 2h is several missed cycles, not noise. */
export const CODE_STALE_MS = 2 * 60 * 60 * 1000;
/** Chat is stale once its last confirmed sync run is older than this — chat sync is user/extension-driven, not a fixed cadence, so the bar is looser. */
export const CHAT_STALE_MS = 7 * 24 * 60 * 60 * 1000;

const CHAT_SOURCES = ["claude", "chatgpt", "grok"] as const;

/**
 * Is `source`'s last confirmed sync RUN (not its content watermark) stale?
 * A missing `lastSyncedAt` (content exists but no heartbeat has ever
 * recorded a run for it — e.g. pre-migration rows) counts as stale: there is
 * no confirmed "we checked recently" signal, so treating it as fresh would
 * be exactly the silent-breakage failure mode this goal step exists to fix.
 */
export function isSourceStale(source: string, lastSyncedAt: string | null, now: Date = new Date()): boolean {
  if (!lastSyncedAt) return true;
  const thresholdMs = source === "code" ? CODE_STALE_MS : CHAT_STALE_MS;
  const age = now.getTime() - new Date(lastSyncedAt).getTime();
  return !Number.isFinite(age) || age > thresholdMs;
}

export interface PulseFreshnessRow {
  /** Stable key for React lists / tests: "chat" | "code". */
  key: string;
  /** Display label: "Chat" | "Code". */
  label: string;
  /** Freshest last_item_at across the row's underlying source(s), or null if none reported one. */
  currentThroughIso: string | null;
  /** True when ANY underlying source backing this row is stale (see isSourceStale). */
  stale: boolean;
}

/**
 * Shape the raw per-source freshness map into the compact rows /pulse
 * renders. The three chat sources collapse into a single "Chat" row (the
 * brief's own example: "Chat current through Jul 25 · Code current through
 * today") — whichever of claude/chatgpt/grok are actually present
 * contribute their freshest last_item_at and their own staleness. 'code'
 * stays its own row. A source absent from `freshness` (mcp_freshness omits
 * sources with no data) contributes nothing and — if no chat source is
 * present at all — the Chat row itself is omitted, not shown empty.
 */
export function shapePulseFreshness(freshness: FreshnessMap, now: Date = new Date()): PulseFreshnessRow[] {
  const rows: PulseFreshnessRow[] = [];

  const presentChatSources = CHAT_SOURCES.filter((s) => freshness[s]);
  if (presentChatSources.length > 0) {
    let currentThroughIso: string | null = null;
    let currentThroughMs = -Infinity;
    let stale = false;
    for (const s of presentChatSources) {
      const entry = freshness[s];
      // MINOR 1 fix (adversarial review): compare parsed epoch millis, not
      // raw ISO strings — string comparison only happens to work when every
      // timestamp shares the exact same format (UTC 'Z', same precision),
      // which isn't guaranteed across writers (heartbeat vs. content
      // watermark, different sources/clients).
      if (entry.last_item_at) {
        const ms = Date.parse(entry.last_item_at);
        if (Number.isFinite(ms) && ms > currentThroughMs) {
          currentThroughMs = ms;
          currentThroughIso = entry.last_item_at;
        }
      }
      if (isSourceStale(s, entry.last_synced_at, now)) stale = true;
    }
    rows.push({ key: "chat", label: "Chat", currentThroughIso, stale });
  }

  const code = freshness.code;
  if (code) {
    rows.push({
      key: "code",
      label: "Code",
      currentThroughIso: code.last_item_at,
      stale: isSourceStale("code", code.last_synced_at, now),
    });
  }

  return rows;
}
