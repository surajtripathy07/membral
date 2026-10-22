// The per-user monthly memory budget (hosted mode), shared by memory
// extraction (extraction-queue.ts) and pattern skill drafts
// (patterns/derive.ts) — both bill the `memory` pass group, so both answer
// to the same monthly cap (review N3).
import type { Db } from "@/lib/db/types";
import { getAppMode, MEMORY_PASSES, resolveMemoryMonthlyBudgetUsd } from "@/lib/feature-flags";

/** Passes counted against the memory budgets: the extraction/draft chat calls plus memory embeddings. */
export const MEMORY_SPEND_PASSES = [...MEMORY_PASSES, "memory_embedding"];

/** Midnight UTC on the first of `now`'s month, as an ISO string. */
export function startOfUtcMonthIso(now: Date = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

/** The user's memory spend (USD) since `sinceIso`. Throws when unreadable — callers fail closed. */
export async function memorySpendSinceUsd(supabase: Db, userId: string, sinceIso: string): Promise<number> {
  const { data, error } = await supabase.rpc("llm_spend_sum", {
    p_user_id: userId,
    p_since: sinceIso,
    p_run_id: null,
    p_include_passes: MEMORY_SPEND_PASSES,
    p_exclude_passes: null,
  });
  if (error) throw new Error(`llm_spend_sum failed: ${error.message}`);
  const n = Number(data);
  if (!Number.isFinite(n)) throw new Error(`llm_spend_sum returned a non-number: ${String(data)}`);
  return n;
}

/**
 * USD left in the user's monthly memory budget, or null when no monthly cap
 * applies (open/self-hosted mode). Throws when the spend is unreadable.
 */
export async function memoryMonthlyRemainingUsd(
  supabase: Db,
  userId: string,
  now: Date = new Date(),
  env: Record<string, string | undefined> = process.env,
): Promise<number | null> {
  if ((await getAppMode()) !== "hosted") return null;
  const spent = await memorySpendSinceUsd(supabase, userId, startOfUtcMonthIso(now));
  return resolveMemoryMonthlyBudgetUsd(env) - spent;
}
