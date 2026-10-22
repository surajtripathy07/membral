// Goal 2026-09-24 memory-on-prod P2: a global daily LLM spend ceiling, so a
// burst of signups cannot run up the bill. Summed server-side from the
// llm_spend ledger across ALL users for the current UTC day (migration 087's
// llm_spend_global_sum — never a client-side fetch-and-reduce, see
// migration 035 WHY #3).
//
// FAILS CLOSED (review M3): if the sum cannot be read — the RPC is missing
// because migration 087 is not applied (PGRST202 / 42883), or any other
// error — the check reports `allowed: false` with reason
// "global_ceiling_unchecked". Spend safety outranks availability: the
// session stays pending and the daily cron retries it.
//
// Issue #335: a second, MONTHLY global ceiling
// (MEMBRAL_LLM_GLOBAL_MONTHLY_CEILING_USD) sums the same RPC from midnight
// UTC on the 1st of the month. checkGlobalCeilings runs both and is what
// every LLM entry point calls (memory extraction, pattern drafts,
// createCostGuardedLlm, code-session synthesis). Same fail-closed rule.
import type { Db } from "@/lib/db/types";
import { parseUsdEnv } from "@/lib/feature-flags";
import { log } from "@/lib/log";

/** Global (all users) USD ceiling per UTC day when MEMBRAL_LLM_GLOBAL_DAILY_CEILING_USD is unset (maintainer decision 2026-09-25). */
export const DEFAULT_LLM_GLOBAL_DAILY_CEILING_USD = 2;

/**
 * Global (all users) USD ceiling per UTC calendar month when
 * MEMBRAL_LLM_GLOBAL_MONTHLY_CEILING_USD is unset (issue #335). $30 is 15
 * days of the $2 daily ceiling: the daily ceiling alone allows ~$60 a month,
 * so a burst that pins the daily ceiling every day stops halfway through
 * the month instead of running all month.
 */
export const DEFAULT_LLM_GLOBAL_MONTHLY_CEILING_USD = 30;

/** Invalid or negative env values resolve to 0 (every run blocked), never to the default (review m2). */
export function resolveGlobalDailyCeilingUsd(env: Record<string, string | undefined> = process.env): number {
  return parseUsdEnv(
    env.MEMBRAL_LLM_GLOBAL_DAILY_CEILING_USD,
    DEFAULT_LLM_GLOBAL_DAILY_CEILING_USD,
    "MEMBRAL_LLM_GLOBAL_DAILY_CEILING_USD",
  );
}

/** Invalid or negative env values resolve to 0 (every run blocked), never to the default (review m2). */
export function resolveGlobalMonthlyCeilingUsd(env: Record<string, string | undefined> = process.env): number {
  return parseUsdEnv(
    env.MEMBRAL_LLM_GLOBAL_MONTHLY_CEILING_USD,
    DEFAULT_LLM_GLOBAL_MONTHLY_CEILING_USD,
    "MEMBRAL_LLM_GLOBAL_MONTHLY_CEILING_USD",
  );
}

/**
 * Midnight UTC on the 1st of `now`'s month. Same as monthly-spend.ts's
 * startOfUtcMonthIso, kept here so this module never loads monthly-spend
 * (which reads MEMORY_PASSES from feature-flags at import time — every
 * spend-ledger importer would then need it in its feature-flags mock).
 */
export function startOfUtcMonthIsoForGlobalCeiling(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** Midnight UTC of `now`'s day, as an ISO string. */
export function startOfUtcDayIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}

export type GlobalCeilingReason = "global_daily_ceiling" | "global_monthly_ceiling" | "global_ceiling_unchecked";

export interface GlobalDailyCeilingCheck {
  allowed: boolean;
  /** Set when not allowed: "global_daily_ceiling" / "global_monthly_ceiling" (reached) or "global_ceiling_unchecked" (sum unreadable). */
  reason?: GlobalCeilingReason;
  spentUsd: number;
  ceilingUsd: number;
  /** Set on an allowed result: which window it describes (checkGlobalCeilings returns the tighter one). */
  window?: GlobalCeilingWindow;
}

export type GlobalCeilingWindow = "global_daily_ceiling" | "global_monthly_ceiling";

/** Same shape as the daily check; the name says it may be either window. */
export type GlobalCeilingCheck = GlobalDailyCeilingCheck;

/** PostgREST "function not found in schema cache" / Postgres "undefined_function": migration 087 is not applied. */
function isMissingFunction(error: { code?: string; message?: string }): boolean {
  return error.code === "PGRST202" || error.code === "42883";
}

/** Sums llm_spend across all users since `sinceIso` and compares it to `ceilingUsd`. Fails closed. */
async function checkGlobalWindow(
  supabase: Db,
  sinceIso: string,
  ceilingUsd: number,
  reachedReason: "global_daily_ceiling" | "global_monthly_ceiling",
): Promise<GlobalCeilingCheck> {
  const unchecked = (err: string, missing: boolean): GlobalCeilingCheck => {
    log.error("llm_spend_global_sum unreadable — global ceiling fails closed, run skipped", {
      err,
      missing_function: missing,
      window: reachedReason,
    });
    return { allowed: false, reason: "global_ceiling_unchecked", spentUsd: 0, ceilingUsd };
  };
  try {
    const { data, error } = await supabase.rpc("llm_spend_global_sum", { p_since: sinceIso });
    if (error) return unchecked(error.message, isMissingFunction(error));
    // The RPC coalesces to 0, so null/empty means something is wrong — never
    // let Number(null) / Number("") read as $0 spent (issue #335 review).
    if (data === null || data === undefined || (typeof data === "string" && data.trim() === "")) {
      return unchecked(`empty sum: ${String(data)}`, false);
    }
    const n = Number(data);
    if (!Number.isFinite(n)) return unchecked(`non-numeric sum: ${String(data)}`, false);
    const allowed = n < ceilingUsd;
    return allowed
      ? { allowed, spentUsd: n, ceilingUsd, window: reachedReason }
      : { allowed, reason: reachedReason, spentUsd: n, ceilingUsd };
  } catch (err) {
    return unchecked(err instanceof Error ? err.message : String(err), false);
  }
}

/**
 * `supabase` must be a service-role client (llm_spend has no RLS policies).
 * A configured ceiling of 0 blocks every run.
 */
export async function checkGlobalDailyCeiling(
  supabase: Db,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): Promise<GlobalDailyCeilingCheck> {
  return checkGlobalWindow(supabase, startOfUtcDayIso(now), resolveGlobalDailyCeilingUsd(env), "global_daily_ceiling");
}

/** Issue #335: the all-users sum since the start of the UTC month. Fails closed like the daily check. */
export async function checkGlobalMonthlyCeiling(
  supabase: Db,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): Promise<GlobalCeilingCheck> {
  return checkGlobalWindow(
    supabase,
    startOfUtcMonthIsoForGlobalCeiling(now),
    resolveGlobalMonthlyCeilingUsd(env),
    "global_monthly_ceiling",
  );
}

/** USD still spendable under an allowed check (0 when refused). Callers clamp per-run caps to it. */
export function globalHeadroomUsd(check: GlobalCeilingCheck): number {
  return check.allowed ? Math.max(0, check.ceilingUsd - check.spentUsd) : 0;
}

/**
 * Issue #335: daily, then monthly. Denies as soon as either denies (the
 * monthly sum is not read once the daily one refused). When both allow, it
 * returns the window with LESS headroom, so `ceilingUsd - spentUsd` is the
 * global allowance a caller may still spend.
 */
export async function checkGlobalCeilings(
  supabase: Db,
  env: Record<string, string | undefined> = process.env,
  now: Date = new Date(),
): Promise<GlobalCeilingCheck> {
  const daily = await checkGlobalDailyCeiling(supabase, env, now);
  if (!daily.allowed) return daily;
  const monthly = await checkGlobalMonthlyCeiling(supabase, env, now);
  if (!monthly.allowed) return monthly;
  return monthly.ceilingUsd - monthly.spentUsd < daily.ceilingUsd - daily.spentUsd ? monthly : daily;
}
