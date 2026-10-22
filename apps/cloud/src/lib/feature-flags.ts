// Per-user feature flag + spend budget for every LLM-spending surface
// (issue #126, ADR 0047; budgets/teaser added issue #128, ADR 0047 v2).
// Every choke point that spends money on an external provider (embeddings,
// KG/portrait chat completions, code-session synthesis, the bridge's
// OpenRouter path) must check `hasFeature`/`assertFeature`/`checkFeature`
// BEFORE issuing the call — fail-closed: a user with no row, or a row with
// enabled=false, is treated as disabled.
//
// Table: migration 077 (feature_flags) + migration 080 (budget_usd,
// daily_usd). RLS: authenticated may SELECT their own row; no insert/
// update/delete policy — every write goes through the service-role client
// (this module, or apps/cloud/scripts/flags.ts).
//
// Three features (ADR 0047 v2; "memory" added goal 2026-09-24 M1 — the
// memory_backfill extraction pass): "embeddings" (chunk/conversation/query
// embedding passes) and "llm" (every other LLM-spending pass — KG pass1,
// portraits, code-session synthesis, the bridge). Each is resolved
// independently — an account can have embeddings on and llm off, which is
// exactly the public-launch default (see resolveDefaults below).
//
// RESOLUTION ORDER for one (userId, feature):
//   1. An EXPLICIT `feature_flags` row (enabled=true OR enabled=false)
//      always wins — its own enabled/budget_usd/daily_usd apply verbatim.
//      This is what makes `scripts/flags.ts revoke` actually revoke a user
//      even if their email/id is still sitting in MEMBRAL_FEATURE_ALLOWLIST
//      (issue #126 finding 4).
//   2. No row: MEMBRAL_FEATURE_ALLOWLIST (env bootstrap — see
//      parseAllowlist below) — a match is enabled, UNLIMITED (budget/daily
//      both null), matching the pre-#128 allowlist semantics exactly.
//   3. No row, no allowlist match: per-feature DEFAULTS (resolveDefaults) —
//      embeddings defaults to ENABLED with a small lifetime + daily budget
//      (every fresh signup can search/build memory a little for free); llm
//      defaults to DISABLED (MEMBRAL_LLM_DEFAULT_BUDGET_USD, default 0 —
//      maintainer decision 2026-09-13: no LLM allowance until a pricing
//      review; set MEMBRAL_LLM_DEFAULT_BUDGET_USD to grant one); memory
//      (goal 2026-09-24 M1) defaults to ENABLED with no lifetime budget —
//      its spend is bounded by the MONTHLY per-user budget and the global
//      daily ceiling, both enforced in lib/memory/extraction-queue.ts.
//      An invalid or negative budget env value resolves to 0 (disabled),
//      with a warning — never to an enabled default (review m2).
//
// SPEND CHECK (only reached when enabled=true): sums llm_spend.cost_usd for
// this user, restricted to the feature's PASS GROUP (PASS_GROUPS below), via
// the llm_spend_sum RPC (migration 080's p_include_passes/p_exclude_passes)
// — server-side, never a client-side fetch-and-reduce (see spend-ledger.ts's
// header for why: PostgREST's 1000-row default .select() cap silently
// truncates a client-side sum).
//
//   allowed = enabled AND ( (budget_usd is null AND daily_usd is null)
//                           OR (budget_usd is not null AND spent_total < budget_usd)
//                           OR (daily_usd is not null AND spent_last_24h < daily_usd) )
//
// i.e. budget_usd is the big up-front allowance (the "teaser"/initial
// grant); once it's used up, daily_usd (if set) becomes an ongoing trickle
// rather than a hard wall — matching issue #128's "one time budget... after
// that delta to be very low" framing. Each of the three OR-arms is
// evaluated independently — a daily-only grant (budget_usd null,
// daily_usd set) must NOT fall into the "budget_usd is null" unlimited
// case; only BOTH null is unlimited (round-3 review A-1 BLOCKER: a
// daily-only budget used to be silently unenforced because the old code
// treated `budget_usd === null` alone as "within lifetime budget" and
// returned allowed before ever evaluating daily_usd). `reason` when
// refused:
//   "disabled"        — enabled=false (explicit row, or defaulted off)
//   "budget_exhausted" — budget_usd is set and exhausted, AND daily_usd is
//                         null (no daily allowance configured to fall back on)
//   "daily_exhausted"  — daily_usd is set and its trailing-24h allowance is
//                         exhausted, AND EITHER budget_usd is null (daily is
//                         the only constraint) OR budget_usd is also set and
//                         exhausted
//
// CACHE (round-3 review A-3/A-4 fix): only the enabled/budget_usd/daily_usd
// ROW resolution (the explicit-row-vs-allowlist-vs-defaults lookup) is
// cached in-process for CACHE_TTL_MS (30s), keyed by `${userId}:${feature}`.
// spentTotal/spentLast24h are summed LIVE on every single checkFeature call
// via one indexed `llm_spend_sum` RPC (two only when the lifetime budget is
// both set AND already exhausted, so the daily trickle must also be
// checked) — see resolveAllowedFromSpend. Previously the WHOLE
// CheckFeatureResult (including spend) was cached for 30s; that let a
// user's spend "reset" to a stale-low number every time the cache
// re-populated, which — compounded across the trailing-24h window rolling
// over — let a nominal $0.01/day trickle be re-exploited to ≈$0.25/day
// (≈25×, ≈$7.50/account/month) forever. Making spend live closes that
// REPEATED/steady-state overshoot: once any batch's llm_spend rows are
// flushed, every subsequent checkFeature call (even from a different
// warm instance, since the RPC hits the shared Postgres row, not the
// per-process cache) sees the true total immediately, not after up to 30s.
//
// OVERSHOOT BOUND, honestly (what remains after this fix): llm_spend rows
// are written AFTER the provider call (embeddings.ts's cost-guarded client
// records cost post-response), and hasFeature()/checkFeature() is called
// ONCE at the TOP of a batch (conversation-embeddings.ts:108,
// conversation-chunks.ts:587) — not re-checked per row or per batch tick
// (the batch's own i % CEILING_RECHECK_INTERVAL loop rechecks the
// *monthly* ceiling, not this per-user budget_usd/daily_usd). So requests
// that are truly concurrent — issued closely enough together that none of
// their batches has flushed a single llm_spend row yet when the others
// call checkFeature — can still all read the same pre-burst total and all
// be admitted. That is a genuine in-flight race this fix does not close;
// closing it needs a per-user in-flight guard (e.g. a
// pg_advisory_xact_lock on the user id, matching migration 078's pattern)
// or claiming/locking the selected rows before embedding them, neither of
// which is implemented here.
//
// Concrete worst case, unchanged from before this fix (SINGLE burst):
// `/api/sync` is rate-limited to 60/min/user (rate-limit.ts); a burst of up
// to 30 requests can each fire two fire-and-forget batches
// (conversation-embeddings.ts + conversation-chunks.ts, limit 50 each)
// before any of the first batch's rows are flushed. At
// text-embedding-3-small pricing ($0.02/1M tokens; conversation embeds up
// to 8192 tokens, chunks ~375 tokens): one sync request's pair of batches
// costs ≈50×8192×$0.02/1e6 + 50×375×$0.02/1e6 ≈ $0.0082 + $0.000375 ≈
// $0.0086; × 30 concurrent requests ≈ **$0.26** — essentially the same
// single-burst figure the old (wrong) "~$0.002/100-item-batch" comment
// undercounted by ~125×. What this fix DOES eliminate is that figure
// repeating: previously a fresh ≈$0.25 burst was available every ~30s (or
// at minimum every 24h daily-window rollover) indefinitely; now it is
// available once per accumulation cycle — the next admission anywhere
// (any instance, any request) sees the flushed spend and is blocked once
// budget_usd/daily_usd is genuinely exceeded. `MEMBRAL_KG_MONTHLY_CEILING_USD`
// ($25/user/30d default) remains the only hard wall against a sustained
// attacker who keeps re-triggering single bursts.
//
// MEMBRAL_FEATURE_ALLOWLIST format: `feature:entry1,entry2;feature2:entry3`
// — semicolon-separated feature groups, each `feature:comma,separated,entries`,
// entries either an email or a Supabase auth user id (uuid). Feature keys and
// emails are matched case-insensitively; blank segments/entries are silently
// ignored. A user-id entry matches unconditionally. An email entry ONLY
// matches when that account's email is CONFIRMED
// (auth.admin.getUserById(userId).email_confirmed_at set) — see issue #126
// finding 1: an unconfirmed self-registered email must not self-grant.
//
// APP MODE (issue #127 self-hosting decision, 2026-09-08, migration 081):
// `getAppMode()` reads `app_settings` row `key='mode'` — 'open' or
// 'hosted', 60s in-process cache (separate from the per-(user,feature)
// cache above). NO ROW = 'open'. A query ERROR fails closed to 'hosted'
// (this module's contract is "fail closed on money" — an unreadable mode
// must not silently unlock unlimited spend). `resolveFlags` consults the
// mode ONLY on the "no explicit feature_flags row" path, BEFORE the
// allowlist/defaults step: in 'open' mode, no row means enabled+unlimited
// outright (skipping the allowlist entirely — it exists to bootstrap a
// HOSTED deployment before `scripts/flags.ts` has run, which has no
// purpose once open mode already grants everything); in 'hosted' mode the
// pre-#127 allowlist -> per-feature-defaults resolution runs exactly as
// before. An EXPLICIT `feature_flags` row always wins regardless of mode
// — same rule as step 1 above, unchanged. See migration 081's header for
// the SQL-side mirror of this (`public.app_mode()`, used by the
// profile-creation and conversation-limit triggers) — the two reads are
// independent, not one calling the other.

import { NextResponse } from "next/server";
import { tryServiceClient } from "@/lib/db/clients";
import type { Db } from "@/lib/db/types";
import { CONTACT_EMAIL_FALLBACK, getContactEmail } from "./contact";
import { featureAllowlistRaw, llmDefaultDailyUsdRaw, SERVICE_ROLE_KEY_ENV } from "./env";
import { log } from "./log";

export type Feature = "llm" | "embeddings" | "memory";

/** Issue #127 self-hosting decision — see file header's APP MODE section and migration 081. */
export type AppMode = "open" | "hosted";

/** Every reason checkFeature can report. "ok" is the only allowed=true reason. */
export type FeatureCheckReason = "ok" | "disabled" | "budget_exhausted" | "daily_exhausted";

const CACHE_TTL_MS = 30_000;

/** Simple FIFO cap (issue #126 finding 13) — a long-lived instance serving many distinct (user, feature) pairs must not grow this map forever. Generous enough that normal traffic never hits it in practice. */
let maxCacheEntries = 10_000;

export interface CheckFeatureResult {
  allowed: boolean;
  reason: FeatureCheckReason;
  /** Lifetime spend (this feature's pass group) summed from llm_spend. 0 when not enabled (no query issued). */
  spentUsd: number;
  /** The resolved lifetime budget (row, or the feature's default), or null = unlimited. */
  budgetUsd: number | null;
  /** The resolved trailing-24h budget (row, or the feature's default), or null = unlimited. */
  dailyUsd: number | null;
  /** MEMBRAL_CONTACT_EMAIL, or the support address already shown on /privacy — always populated so the UI/error body never needs a second env read. */
  contact: string;
}

/**
 * Liveflow phase B defect 2 (2026-09-08): the settings "AI features" card
 * and {@link FeatureDisabledNotice} both used to render `spentUsd` with a
 * flat `.toFixed(2)` — real sub-cent spend (e.g. $0.0032, typical for a
 * gpt-4o-mini pass-1 call against a few short fictional conversations)
 * rounded straight to "$0.00", so a granted teaser account that HAD spent
 * money looked identical to one that hadn't spent anything at all.
 *
 * Shared so every surface that shows a spend figure formats it identically:
 * below one cent, show 4 decimal places (enough to show a nonzero digit for
 * real sub-cent LLM spend); at or above one cent, the existing 2 decimals.
 * Budget/daily-allowance figures (set by us, in whole cents in practice)
 * are NOT run through this — only the live `spentUsd` figure needs it.
 */
export function formatUsdSpend(amountUsd: number): string {
  return amountUsd > 0 && amountUsd < 0.01 ? amountUsd.toFixed(4) : amountUsd.toFixed(2);
}

/**
 * The enabled/budget_usd/daily_usd ROW resolution only — NOT spend, and
 * NOT the final `allowed` verdict. This is the only thing CACHE_TTL_MS
 * covers now (round-3 review A-3/A-4 fix); spentTotal/spentLast24h are
 * always summed live. See the file header's CACHE comment.
 */
interface FlagsResolution {
  enabled: boolean;
  budgetUsd: number | null;
  dailyUsd: number | null;
}

interface CacheEntry {
  value: FlagsResolution;
  expiresAt: number;
}

/** Module-level, in-process only — never shared across server instances; a 30s staleness window on the enabled/budget/daily ROW is an accepted tradeoff (grant/revoke can take up to CACHE_TTL_MS to bite on a warm instance — document this next to `flags.ts revoke` in docs/DEPLOY.md). Spend itself is no longer cached — see file header's OVERSHOOT BOUND. */
const cache = new Map<string, CacheEntry>();

function cacheKey(userId: string, feature: Feature): string {
  return `${userId}:${feature}`;
}

function getCached(userId: string, feature: Feature): FlagsResolution | undefined {
  const entry = cache.get(cacheKey(userId, feature));
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(cacheKey(userId, feature));
    return undefined;
  }
  return entry.value;
}

function setCached(userId: string, feature: Feature, value: FlagsResolution): void {
  const key = cacheKey(userId, feature);
  if (!cache.has(key) && cache.size >= maxCacheEntries) {
    // Map iteration order is insertion order — evict the oldest entry first.
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Exposed for tests only — the module-level cache would otherwise leak state across test cases. */
export function _clearFeatureFlagCache(): void {
  cache.clear();
}

/** Exposed for tests only — lets a test exercise the FIFO eviction path without inserting 10,000 rows. */
export function _setMaxCacheEntriesForTest(n: number): void {
  maxCacheEntries = n;
}

/** Exposed for tests only. */
export function _cacheSizeForTest(): number {
  return cache.size;
}

// ---------------------------------------------------------------------------
// App mode (issue #127 self-hosting decision, migration 081) — see file
// header's APP MODE section.
// ---------------------------------------------------------------------------
const APP_MODE_CACHE_TTL_MS = 60_000;
let appModeCache: { value: AppMode; expiresAt: number } | null = null;

/** Exposed for tests only — the module-level app-mode cache would otherwise leak state across test cases. */
export function _clearAppModeCacheForTest(): void {
  appModeCache = null;
}

/**
 * Reads `app_settings` row `key='mode'` — see file header's APP MODE
 * section. NO ROW resolves to 'open'; a query ERROR (or thrown exception)
 * fails closed to 'hosted' (money-safety — an unreadable mode must not
 * silently unlock unlimited spend). 60s in-process cache, separate from
 * the per-(user,feature) cache above. Never throws.
 */
export async function getAppMode(): Promise<AppMode> {
  if (appModeCache && appModeCache.expiresAt > Date.now()) return appModeCache.value;

  let mode: AppMode;
  const supabase = getServiceSupabase();
  if (!supabase) {
    // No service-role client configured at all — can't read the row;
    // fail closed to hosted, same posture as a query error below.
    mode = "hosted";
  } else {
    try {
      const { data, error } = await supabase.from("app_settings").select("value").eq("key", "mode").maybeSingle();
      if (error) {
        log.warn("feature-flags: app_settings mode query failed — failing closed to hosted", { err: error.message });
        mode = "hosted";
      } else if (!data) {
        mode = "open";
      } else {
        const raw = (data as { value: unknown }).value;
        mode = raw === "hosted" ? "hosted" : "open";
      }
    } catch (err) {
      log.warn("feature-flags: app_settings mode query threw — failing closed to hosted", {
        err: err instanceof Error ? err.message : String(err),
      });
      mode = "hosted";
    }
  }

  appModeCache = { value: mode, expiresAt: Date.now() + APP_MODE_CACHE_TTL_MS };
  return mode;
}

// Memoized (issue #126 finding 13) — every previous call built a fresh
// SupabaseClient on every cache miss; checkFeature sits on generateEmbedding's
// per-call path, so that was a fresh client (and, for the Node http agent,
// fresh sockets) per miss. Env vars are static for the life of the process,
// so a single client is safe to reuse — matches lib/kg/queue.ts's
// getServiceSupabase.
let cachedServiceClient: Db | null = null;

function getServiceSupabase(): Db | null {
  if (cachedServiceClient) return cachedServiceClient;
  const client = tryServiceClient();
  if (!client) {
    log.warn(`feature-flags: ${SERVICE_ROLE_KEY_ENV}/NEXT_PUBLIC_SUPABASE_URL not set — checkFeature fails closed`);
    return null;
  }
  cachedServiceClient = client;
  return cachedServiceClient;
}

interface AllowlistGroup {
  /** Lowercased email addresses. */
  emails: Set<string>;
  /** Lowercased user ids (uuids) — matched unconditionally, no confirmation check. */
  userIds: Set<string>;
}

/**
 * Parses MEMBRAL_FEATURE_ALLOWLIST — see file header — into a map of
 * lowercased-feature -> {emails, userIds}. Malformed segments, blank
 * entries, and a wrong separator are all silently skipped (never thrown —
 * an env var typo must not crash every request that checks a feature flag,
 * issue #126 finding 11).
 */
function parseAllowlist(raw: string | undefined): Map<string, AllowlistGroup> {
  const map = new Map<string, AllowlistGroup>();
  if (!raw) return map;
  for (const group of raw.split(";")) {
    const trimmed = group.trim();
    if (!trimmed) continue;
    const sepIdx = trimmed.indexOf(":");
    if (sepIdx < 0) continue;
    const feature = trimmed.slice(0, sepIdx).trim().toLowerCase();
    const entries = trimmed
      .slice(sepIdx + 1)
      .split(",")
      .map((e) => e.trim())
      .filter((e) => e.length > 0);
    if (!feature || entries.length === 0) continue;
    const existing = map.get(feature) ?? { emails: new Set<string>(), userIds: new Set<string>() };
    for (const entry of entries) {
      if (entry.includes("@")) {
        existing.emails.add(entry.toLowerCase());
      } else {
        existing.userIds.add(entry.toLowerCase());
      }
    }
    map.set(feature, existing);
  }
  return map;
}

interface ResolvedUser {
  email: string | null;
  /** true only when auth.users.email_confirmed_at is set for THIS email. */
  emailConfirmed: boolean;
}

/**
 * Single source of truth for both the email and its confirmation status —
 * deliberately NOT profiles.email (issue #126 finding 1 secondary point):
 * profiles is a denormalized copy that can be null/stale, and
 * email_confirmed_at only exists on auth.users, so using two different
 * sources for "which email" vs. "is it confirmed" could let a stale/
 * different profiles.email ride on another email's confirmation. Service-
 * role only; never callable client-side.
 */
async function resolveUser(supabase: Db, userId: string): Promise<ResolvedUser> {
  try {
    const { data, error } = await supabase.auth.admin.getUserById(userId);
    if (error || !data?.user) return { email: null, emailConfirmed: false };
    return {
      email: data.user.email ?? null,
      emailConfirmed: Boolean(data.user.email_confirmed_at),
    };
  } catch (err) {
    log.warn("feature-flags: auth.admin.getUserById failed", {
      user_id: userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { email: null, emailConfirmed: false };
  }
}

async function checkAllowlist(supabase: Db, userId: string, feature: Feature): Promise<boolean> {
  const allowlist = parseAllowlist(featureAllowlistRaw());
  const group = allowlist.get(feature.toLowerCase());
  if (!group || (group.emails.size === 0 && group.userIds.size === 0)) return false;

  if (group.userIds.has(userId.toLowerCase())) return true;
  if (group.emails.size === 0) return false;

  const { email, emailConfirmed } = await resolveUser(supabase, userId);
  if (!email || !emailConfirmed) return false;
  return group.emails.has(email.toLowerCase());
}

// ---------------------------------------------------------------------------
// Pass groups (issue #128) — which llm_spend.pass values count against which
// feature's budget. EMBEDDING_PASSES is the allowlist for "embeddings"; the
// SAME set is the denylist for "llm" (every pass NOT in this set) so a
// future new KG pass name is automatically covered by the llm budget without
// a code change here. Confirmed against a live corpus (psql `select distinct
// pass from llm_spend`, 2026-09-06) — matches lib/embeddings.ts's own
// EmbeddingPass union exactly, for the passes that go through
// lib/embeddings.ts's generateEmbedding/batch callers.
//
// NOT everything that calls an embedding model is billed to "embeddings",
// though: `pass: "embed"` (lib/kg/embeddings.ts's Stage-A cluster
// embeddings, via `deps.llm.embedMany`) is embedding-model spend that
// happens INSIDE the llm-gated KG bootstrap pipeline and is deliberately
// billed to the "llm" budget, not "embeddings" — it has no rows in the
// local corpus this comment was confirmed against (the cluster tree was
// never rebuilt here), so don't read the corpus confirmation above as
// covering it. This is intentional (that call sits behind the "llm" gate
// end to end), just worth knowing when reading llm_spend by pass name.
//
// "memory_embedding" (memory v1 source C, embed.ts) added step2d finding 9
// (docs/goals/2026-09-13_memory-v1-build_goal.md; issue #151): it's an
// embedding-model call and belongs in the "embeddings" budget, matching
// design §6 — it used to fall into the "llm" denylist bucket by omission.
// ---------------------------------------------------------------------------
const EMBEDDING_PASSES = ["chunk_embedding", "conversation_embedding", "query_embedding", "memory_embedding"];

// Goal 2026-09-24 review M1: memory extraction's chat passes are their own
// group, so memory spend never eats a KG/synthesis/portrait (`llm`) budget
// and `llm` spend never starves memory. `llm` excludes both groups.
/** D-057: `session_assoc` runs inside memory extraction and answers to the same budgets. */
export const MEMORY_PASSES = ["memory_backfill", "session_assoc"];

function passGroupParams(feature: Feature): { include?: string[]; exclude?: string[] } {
  if (feature === "embeddings") return { include: EMBEDDING_PASSES };
  if (feature === "memory") return { include: MEMORY_PASSES };
  return { exclude: [...EMBEDDING_PASSES, ...MEMORY_PASSES] };
}

// Round-5 verification F2: the contact-address logic itself now lives in
// lib/contact.ts, the ONE source every public page + this module reads from
// — DEFAULT_CONTACT_EMAIL/resolveContactEmail here are re-exports of that
// module for the callsites below, not a second implementation.
const DEFAULT_CONTACT_EMAIL = CONTACT_EMAIL_FALLBACK;
const resolveContactEmail = getContactEmail;

/**
 * Unset/blank -> `fallback`. A non-blank value that is not a finite,
 * non-negative number resolves to 0 (off) with a warning — review m2: a typo
 * like "off" or "-1" must never switch a spend default ON.
 */
export function parseUsdEnv(raw: string | undefined, fallback: number, envKey = "budget env"): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  log.warn(`${envKey}: invalid or negative value — treated as 0 (disabled)`, { env_key: envKey, raw });
  return 0;
}

/** Goal 2026-09-24 M1 + maintainer decision 2026-09-25: memory extraction's per-user budget, per UTC calendar month. */
export const DEFAULT_MEMORY_MONTHLY_BUDGET_USD_PER_USER = 2;

export function resolveMemoryMonthlyBudgetUsd(env: Record<string, string | undefined> = process.env): number {
  return parseUsdEnv(
    env.MEMBRAL_MEMORY_MONTHLY_BUDGET_USD,
    DEFAULT_MEMORY_MONTHLY_BUDGET_USD_PER_USER,
    "MEMBRAL_MEMORY_MONTHLY_BUDGET_USD",
  );
}

interface FeatureDefaults {
  enabled: boolean;
  budgetUsd: number | null;
  dailyUsd: number | null;
}

/**
 * Defaults applied when there is NO explicit feature_flags row and NO
 * allowlist match (issue #128, ADR 0047 v2). Read lazily (not module-level
 * constants) so env vars set after import (tests) still take effect.
 */
function resolveDefaults(feature: Feature, env: Record<string, string | undefined> = process.env): FeatureDefaults {
  if (feature === "embeddings") {
    return {
      enabled: true,
      budgetUsd: parseUsdEnv(env.MEMBRAL_EMBED_DEFAULT_BUDGET_USD, 0.5, "MEMBRAL_EMBED_DEFAULT_BUDGET_USD"),
      dailyUsd: parseUsdEnv(env.MEMBRAL_EMBED_DEFAULT_DAILY_USD, 0.01, "MEMBRAL_EMBED_DEFAULT_DAILY_USD"),
    };
  }
  if (feature === "memory") {
    // Goal 2026-09-24 M1: on by default, no lifetime budget here — the
    // monthly per-user budget is checked in lib/memory/extraction-queue.ts
    // (this module's budget machinery is lifetime/24h only). A monthly
    // budget of 0 switches memory off by default.
    return { enabled: resolveMemoryMonthlyBudgetUsd(env) > 0, budgetUsd: null, dailyUsd: null };
  }
  // "llm": maintainer decision 2026-09-13: default $0 until a pricing
  // review; set MEMBRAL_LLM_DEFAULT_BUDGET_USD to grant. Memory extraction
  // does not need `llm` (goal 2026-09-24 review M1).
  const llmDefaultBudget = parseUsdEnv(env.MEMBRAL_LLM_DEFAULT_BUDGET_USD, 0, "MEMBRAL_LLM_DEFAULT_BUDGET_USD");
  return {
    enabled: llmDefaultBudget > 0,
    budgetUsd: llmDefaultBudget > 0 ? llmDefaultBudget : null,
    dailyUsd: null,
  };
}

interface FeatureFlagRow {
  enabled: boolean;
  budget_usd: number | string | null;
  daily_usd: number | string | null;
}

/**
 * feature_flags.budget_usd/daily_usd are `numeric` — supabase-js returns
 * numeric as a string when it doesn't fit safely in a JS number; parse
 * defensively either way. Distinguishes "absent" (null/undefined -> `null`
 * = unlimited, correct — this is the intended shape of a bare `enabled`
 * row) from "present but unparseable" (`'NaN'`, a value beyond double
 * range, a future column-type surprise) — round-3 review MED 4: the old
 * code collapsed BOTH cases to `null` = unlimited, so a corrupt budget_usd
 * failed OPEN in a module whose stated contract is fail-closed. An
 * unparseable value now fails CLOSED (treated as `0`, the strictest
 * budget — `spent < 0` is always false) and is logged, rather than
 * silently granting unlimited spend.
 */
function toNullableNumber(v: number | string | null, field: "budget_usd" | "daily_usd", userId: string): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (Number.isFinite(n)) return n;
  log.warn("feature-flags: unparseable numeric column — failing closed to 0", { user_id: userId, field, raw: v });
  return 0;
}

// Round-5 verification F6 — per-user spend RATE on hosted, not just lifetime
// budget. `scripts/flags.ts grant --feature llm --daily-usd none` writes this
// sentinel into `feature_flags.daily_usd` (a `numeric` column — chosen over a
// new migration-requiring boolean column as the smallest change that fits
// the existing type) to mean "explicitly, permanently unlimited" — distinct
// from `null` ("no daily cap set", which now gets the HOSTED-mode default
// below applied to it). `-1` can never be a real daily budget (budgets are
// non-negative, enforced by both `grant`'s own validation and
// toNullableNumber's fail-closed-to-0 path above), so it's unambiguous.
const DAILY_UNLIMITED_SENTINEL = -1;

/**
 * Resolves the enabled/budget_usd/daily_usd ROW for (userId, feature) —
 * explicit row, else allowlist, else defaults — and caches ONLY this
 * result (see file header's CACHE comment). Never throws.
 */
async function resolveFlags(supabase: Db, userId: string, feature: Feature): Promise<FlagsResolution> {
  const cached = getCached(userId, feature);
  if (cached !== undefined) return cached;

  let enabled = false;
  let budgetUsd: number | null = null;
  let dailyUsd: number | null = null;
  let hasExplicitRow = false;
  // Set only when the row's daily_usd was the DAILY_UNLIMITED_SENTINEL — an
  // operator's explicit "no, really unlimited" (issue F6), which must never
  // get the hosted-mode default daily cap applied on top of it below.
  let explicitDailyUnlimited = false;
  // A query ERROR is neither "explicitly enabled" nor "explicitly revoked" —
  // it's unknown state; must not fall through to the allowlist/defaults
  // (issue #126 finding, round-2 review LOW 12 — carried forward here).
  let queryFailed = false;

  try {
    const { data, error } = await supabase
      .from("feature_flags")
      .select("enabled, budget_usd, daily_usd")
      .eq("user_id", userId)
      .eq("feature", feature)
      .maybeSingle();
    if (error) {
      queryFailed = true;
      log.warn("feature-flags: resolveFlags query failed — failing closed", {
        user_id: userId,
        feature,
        err: error.message,
      });
    } else if (data) {
      hasExplicitRow = true;
      const row = data as FeatureFlagRow;
      enabled = row.enabled === true;
      budgetUsd = toNullableNumber(row.budget_usd, "budget_usd", userId);
      const rawDailyUsd = toNullableNumber(row.daily_usd, "daily_usd", userId);
      if (rawDailyUsd === DAILY_UNLIMITED_SENTINEL) {
        dailyUsd = null;
        explicitDailyUnlimited = true;
      } else {
        dailyUsd = rawDailyUsd;
      }
    }
  } catch (err) {
    queryFailed = true;
    log.warn("feature-flags: resolveFlags query threw — failing closed", {
      user_id: userId,
      feature,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (!hasExplicitRow && !queryFailed) {
    const mode = await getAppMode();
    if (mode === "open") {
      // Issue #127 self-hosting decision: open mode has NO product
      // constraints absent an explicit feature_flags row (already ruled
      // out above) — enabled, unlimited, no allowlist/env-default lookup
      // needed (the allowlist exists solely to bootstrap a HOSTED
      // deployment before scripts/flags.ts has run; open mode already
      // grants everything, so consulting it here would only cost an extra
      // auth.admin API round trip for an email-entry match, for no
      // behavioral difference).
      enabled = true;
      budgetUsd = null;
      dailyUsd = null;
    } else {
      let allowlisted = false;
      try {
        allowlisted = await checkAllowlist(supabase, userId, feature);
      } catch (err) {
        log.warn("feature-flags: checkAllowlist threw — failing closed", {
          user_id: userId,
          feature,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      if (allowlisted) {
        // Existing allowlist semantics preserved verbatim: enabled, unlimited.
        enabled = true;
        budgetUsd = null;
        dailyUsd = null;
      } else {
        const defaults = resolveDefaults(feature);
        enabled = defaults.enabled;
        budgetUsd = defaults.budgetUsd;
        dailyUsd = defaults.dailyUsd;
      }
    }
  }

  // Round-5 verification F6: bound a HOSTED-mode "full" llm grant (an
  // explicit row with BOTH budget_usd and daily_usd null — the shape
  // `scripts/flags.ts grant --feature llm` with no --budget-usd/--daily-usd
  // flags produces) to a per-day trickle by default, so one granted account
  // can't become an unbounded spend source on the maintainer's own key.
  // Deliberately narrow: only explicit rows (a "grant"), only "llm" (the
  // expensive KG/portrait/bridge surface — "embeddings" already has its own
  // always-on default budget), only when the operator didn't say
  // `--daily-usd none` (explicitDailyUnlimited), and only in `hosted` mode —
  // `open` mode's whole point (issue #127) is no product constraints, so a
  // full grant there stays genuinely unlimited, matching migration 081's
  // own "explicit row always wins, but open mode changes what 'no row'
  // means, not what an explicit unlimited grant means" framing.
  if (
    hasExplicitRow &&
    enabled &&
    feature === "llm" &&
    !explicitDailyUnlimited &&
    budgetUsd === null &&
    dailyUsd === null
  ) {
    const mode = await getAppMode();
    if (mode === "hosted") {
      dailyUsd = parseUsdEnv(llmDefaultDailyUsdRaw(), 2, "MEMBRAL_LLM_DEFAULT_DAILY_USD");
    }
  }

  const result: FlagsResolution = { enabled, budgetUsd, dailyUsd };
  setCached(userId, feature, result);
  return result;
}

/**
 * The single read surface for a (userId, feature) budget/enablement check
 * (issue #128, ADR 0047 v2) — see the file header for the full resolution
 * order, spend formula, and cache/overshoot semantics. Never throws: any
 * missing env, query error, or missing row degrades to a safe "disabled"
 * result rather than rejecting the call.
 */
export async function checkFeature(userId: string, feature: Feature): Promise<CheckFeatureResult> {
  const contact = resolveContactEmail();
  const supabase = getServiceSupabase();
  if (!supabase) {
    return { allowed: false, reason: "disabled", spentUsd: 0, budgetUsd: null, dailyUsd: null, contact };
  }

  const flags = await resolveFlags(supabase, userId, feature);
  return resolveAllowedFromSpend(supabase, userId, feature, flags.enabled, flags.budgetUsd, flags.dailyUsd, contact);
}

/**
 * Given the resolved enabled/budget/daily for a user+feature, sums llm_spend
 * LIVE (server-side, pass-group-filtered, never cached — round-3 review A-4)
 * and applies the allowed formula from the file header:
 *
 *   allowed = enabled AND ( (budget_usd is null AND daily_usd is null)
 *                           OR (budget_usd is not null AND spent_total < budget_usd)
 *                           OR (daily_usd is not null AND spent_last_24h < daily_usd) )
 *
 * Each OR-arm is independent — a daily-only grant (budget_usd null,
 * daily_usd set) is evaluated on its own arm, never short-circuited by the
 * "budget_usd is null" unlimited case (round-3 review A-1 BLOCKER fix).
 * Skips the spend query entirely when not enabled, or when both budget and
 * daily are null (unlimited) — no reason to hit the DB for an
 * unconditionally-allowed check. At most 2 `llm_spend_sum` RPC calls: the
 * lifetime sum (only when budget_usd is set) and the trailing-24h sum
 * (only when daily_usd is set AND the lifetime arm didn't already pass).
 */
async function resolveAllowedFromSpend(
  supabase: Db,
  userId: string,
  feature: Feature,
  enabled: boolean,
  budgetUsd: number | null,
  dailyUsd: number | null,
  contact: string,
): Promise<CheckFeatureResult> {
  if (!enabled) {
    return { allowed: false, reason: "disabled", spentUsd: 0, budgetUsd, dailyUsd, contact };
  }
  if (budgetUsd === null && dailyUsd === null) {
    return { allowed: true, reason: "ok", spentUsd: 0, budgetUsd, dailyUsd, contact };
  }

  const passParams = passGroupParams(feature);
  let spentTotal = 0;
  let withinLifetimeBudget = false;
  if (budgetUsd !== null) {
    spentTotal = await llmSpendSumForFeature(supabase, userId, {
      sinceIso: new Date(0).toISOString(),
      ...passParams,
    });
    withinLifetimeBudget = spentTotal < budgetUsd;
  }
  if (withinLifetimeBudget) {
    return { allowed: true, reason: "ok", spentUsd: spentTotal, budgetUsd, dailyUsd, contact };
  }

  // Lifetime budget either not set or exhausted — fall back to the daily
  // trickle, if any (this is the ONLY arm evaluated when budget_usd is
  // null and daily_usd is set — the round-3 review A-1 fix).
  if (dailyUsd === null) {
    return { allowed: false, reason: "budget_exhausted", spentUsd: spentTotal, budgetUsd, dailyUsd, contact };
  }
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const spentLast24h = await llmSpendSumForFeature(supabase, userId, { sinceIso: since24h, ...passParams });
  if (spentLast24h < dailyUsd) {
    return { allowed: true, reason: "ok", spentUsd: spentTotal, budgetUsd, dailyUsd, contact };
  }
  return { allowed: false, reason: "daily_exhausted", spentUsd: spentTotal, budgetUsd, dailyUsd, contact };
}

async function llmSpendSumForFeature(
  supabase: Db,
  userId: string,
  opts: { sinceIso: string; include?: string[]; exclude?: string[] },
): Promise<number> {
  const { data, error } = await supabase.rpc("llm_spend_sum", {
    p_user_id: userId,
    p_since: opts.sinceIso,
    p_run_id: null,
    p_include_passes: opts.include ?? null,
    p_exclude_passes: opts.exclude ?? null,
  });
  if (error) {
    log.warn("feature-flags: llm_spend_sum rpc failed — treating spend as 0", { user_id: userId, err: error.message });
    return 0;
  }
  const n = Number(data);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Boolean wrapper over {@link checkFeature} — kept for the many existing
 * callsites that only need a yes/no gate (createCostGuardedLlm,
 * generateEmbedding's assertFeature, the (dashboard)/layout.tsx notice,
 * etc.) without threading budget/contact details through.
 */
export async function hasFeature(userId: string, feature: Feature): Promise<boolean> {
  const result = await checkFeature(userId, feature);
  return result.allowed;
}

/** Thrown by {@link assertFeature} — callers (HTTP routes) should catch this and respond via {@link featureDisabledResponse}. `status` is always 403. */
export class FeatureDisabledError extends Error {
  public readonly status = 403;
  constructor(
    public readonly feature: Feature,
    public readonly reason: Exclude<FeatureCheckReason, "ok"> = "disabled",
    public readonly contact: string = DEFAULT_CONTACT_EMAIL,
  ) {
    super(`Feature "${feature}" is not enabled for this account (${reason})`);
    this.name = "FeatureDisabledError";
  }
}

/** Throws {@link FeatureDisabledError} when `checkFeature` reports not-allowed. Never returns a value when disabled — callers rely on this throwing to short-circuit before any provider call. */
export async function assertFeature(userId: string, feature: Feature): Promise<void> {
  const result = await checkFeature(userId, feature);
  if (!result.allowed) {
    throw new FeatureDisabledError(feature, result.reason as Exclude<FeatureCheckReason, "ok">, result.contact);
  }
}

const REASON_MESSAGES: Record<Exclude<FeatureCheckReason, "ok">, (feature: Feature, contact: string) => string> = {
  disabled: (_feature, contact) =>
    `Memory features are not enabled for this account. Extracting memories from your conversations costs real money — email ${contact} to enable it.`,
  budget_exhausted: (feature, contact) => `Your ${feature} allowance is used up — email ${contact} to extend it.`,
  daily_exhausted: (feature, contact) => `Daily ${feature} allowance reached; try again tomorrow or email ${contact}.`,
};

/** Standard 403 JSON body for a {@link FeatureDisabledError} — one shape every route in the LLM-spend inventory should return instead of a 500. */
export function featureDisabledResponse(err: FeatureDisabledError): NextResponse {
  return NextResponse.json(
    {
      error: "feature_disabled",
      feature: err.feature,
      reason: err.reason,
      message: REASON_MESSAGES[err.reason](err.feature, err.contact),
      contact: err.contact,
    },
    { status: 403 },
  );
}

/**
 * Shared one-line copy for a NOT-allowed {@link CheckFeatureResult} — used by
 * every UI empty state (memories page, pulse memory panel, settings card,
 * the bridge "About you" panel) that wants the SAME wording the API's own
 * {@link featureDisabledResponse} returns, without constructing a
 * {@link FeatureDisabledError} just to read its message. Returns null when
 * `result.allowed` — callers render their normal state in that case.
 */
export function featureCheckMessage(feature: Feature, result: CheckFeatureResult): string | null {
  if (result.allowed) return null;
  return REASON_MESSAGES[result.reason as Exclude<FeatureCheckReason, "ok">](feature, result.contact);
}
