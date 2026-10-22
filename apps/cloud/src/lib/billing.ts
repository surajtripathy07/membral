import { getServiceClient } from "@/lib/db/clients";
import type { TypedDb } from "@/lib/db/types";

/** Conversations a free-tier account may hold when `profiles.conversation_limit` has no row to read. */
const FREE_CONVERSATION_LIMIT = 100;

export interface ConversationQuota {
  /** `Number.POSITIVE_INFINITY` for pro/unlimited accounts. */
  limit: number;
  /** Current non-code (chat-provider) conversation count for this user. */
  count: number;
}

/**
 * Issue #127: `profiles.conversation_limit` enforcement wiring. Before this
 * existed, nothing enforced the limit at the API layer (the audit's
 * B-section finding). `getConversationQuota` exposes the raw limit/count so a caller can do a
 * PARTIAL accept (allow updates to existing rows + as many new rows as fit
 * under the remaining headroom, reject only the overflow) instead of an
 * all-or-nothing boolean gate.
 */
export async function getConversationQuota(userId: string): Promise<ConversationQuota> {
  const supabase: TypedDb = getServiceClient();

  const { data: profile } = await supabase
    .from("profiles")
    .select("tier, conversation_limit")
    .eq("id", userId)
    .single();

  // Issue #127 self-hosting decision (migration 081): NULL conversation_limit
  // is now a real, distinct value — "unlimited" (the open-mode default for a
  // fresh signup) — not "unset, fall back to the free-tier default." Only
  // the "no profiles row at all" case (should not happen — migration 004's
  // handle_new_user trigger always creates one) still falls back to
  // FREE_CONVERSATION_LIMIT. Matches migration 081's
  // enforce_conversation_limit() trigger, which treats the same NULL as
  // "skip the count entirely."
  const limit = !profile
    ? FREE_CONVERSATION_LIMIT
    : profile.tier === "pro"
      ? Number.POSITIVE_INFINITY
      : profile.conversation_limit === null
        ? Number.POSITIVE_INFINITY
        : profile.conversation_limit;

  // Issue #127 round-2 review (HIGH 4): this used to `.neq("source",
  // "claude-code")` per ADR 0039 M3 ("a mirrored code session shouldn't
  // consume chat quota") — but nothing else bounded the code-session mirror
  // path at all, so it was an unbounded write amplifier invisible to any
  // ceiling. Deliberately narrowing ADR 0039 M3 here: mirrored code
  // sessions now count against the SAME conversation_limit as chat
  // conversations (matching migration 078's DB trigger, which counts every
  // source with no exclusion) — a real, if coarser, bound beats an
  // unbounded one. Flagged in the fix report for a maintainer follow-up
  // (a dedicated code_session_limit, per the original finding's suggestion,
  // is the more precise fix if the shared-quota tradeoff proves too tight).
  const cached = getCachedCount(userId);
  let count: number;
  if (cached !== undefined) {
    count = cached;
  } else {
    const { count: fresh } = await supabase
      .from("conversations")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId);
    count = fresh ?? 0;
    setCachedCount(userId, count);
  }

  return { limit: Number.isFinite(limit) ? limit : Number.POSITIVE_INFINITY, count };
}

// Issue #127 round-2 review (LOW 15): getConversationQuota() ran a full
// exact count(*) on `conversations` on EVERY sync/import request — for a
// founder-scale account (1000s of rows) that's a real per-request cost on
// top of findExistingConversationKeys' own lookup. Safe to cache briefly
// now that migration 078's DB trigger is the ATOMIC enforcement backstop:
// a stale (slightly low) cached count can at worst let the app-level
// pre-partition accept a few more rows than are truly available, which the
// trigger then rejects individually (see parseConversationLimitError below)
// — never an over-quota write. A short TTL (not "cache forever") still
// keeps the common case (well under quota) fast without the count ever
// drifting far from reality.
const COUNT_CACHE_TTL_MS = 5_000;
const countCache = new Map<string, { count: number; expiresAt: number }>();

function getCachedCount(userId: string): number | undefined {
  const entry = countCache.get(userId);
  if (!entry || entry.expiresAt < Date.now()) return undefined;
  return entry.count;
}

function setCachedCount(userId: string, count: number): void {
  countCache.set(userId, { count, expiresAt: Date.now() + COUNT_CACHE_TTL_MS });
}

/** Test-only: force the next getConversationQuota() call to skip the cache. */
export function _clearConversationCountCacheForTest(): void {
  countCache.clear();
}

/**
 * Issue #127 round-2 review (HIGH 3/4/6): translates migration 078's
 * `enforce_conversation_limit()` trigger error back into a typed result.
 * Postgres raises `RAISE EXCEPTION 'conversation_limit' USING ERRCODE =
 * 'P0001', DETAIL = '{"limit":N,"count":N}'`; PostgREST (and therefore
 * supabase-js's PostgrestError) surfaces the raised text verbatim as
 * `.message` and the DETAIL text verbatim as `.details`. Returns null for
 * any other error (including a malformed/missing detail — still recognized
 * as a quota rejection via `.message`, just without exact numbers).
 */
export interface ConversationLimitErrorInfo {
  limit: number;
  count: number;
}

export function parseConversationLimitError(
  error: { message?: string | null; details?: string | null } | null | undefined,
): ConversationLimitErrorInfo | null {
  if (!error || error.message !== "conversation_limit") return null;
  if (error.details) {
    try {
      const parsed = JSON.parse(error.details);
      if (typeof parsed?.limit === "number" && typeof parsed?.count === "number") {
        return { limit: parsed.limit, count: parsed.count };
      }
    } catch {
      // fall through to the unknown-shape fallback below
    }
  }
  return { limit: Number.NaN, count: Number.NaN };
}

/**
 * Partitions a batch of incoming conversations against the user's
 * conversation_limit: every row that already exists for this user (an
 * UPDATE — `existingKeys` from `findExistingConversationKeys`) is always
 * accepted, regardless of quota; NEW rows are accepted only up to the
 * remaining headroom (`limit - count`), in array order, and the rest are
 * reported back as `skipped` so the caller can surface a clear, partial
 * result instead of silently dropping them.
 */
export function partitionByConversationQuota<T extends { source: string; source_id: string }>(
  items: T[],
  existingKeys: Set<string>,
  quota: ConversationQuota,
): { accepted: T[]; skipped: T[] } {
  if (!Number.isFinite(quota.limit)) return { accepted: items, skipped: [] };

  const remaining = Math.max(0, quota.limit - quota.count);
  let newAccepted = 0;
  const accepted: T[] = [];
  const skipped: T[] = [];

  for (const item of items) {
    const key = `${item.source}:${item.source_id}`;
    if (existingKeys.has(key)) {
      accepted.push(item);
      continue;
    }
    if (newAccepted < remaining) {
      accepted.push(item);
      newAccepted++;
    } else {
      skipped.push(item);
    }
  }

  return { accepted, skipped };
}
