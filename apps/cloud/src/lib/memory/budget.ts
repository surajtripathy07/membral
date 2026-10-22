// Memory v1, source C — per-session budget + degrade order (docs/design/
// memory-v1.md §3: "Per-session budget $0.25 (≈ 64 windows) through the
// existing feature_flags.budget_usd/MEMBRAL_LLM_DEFAULT_BUDGET_USD
// machinery; over budget the degrade order is fixed and never drops a
// window containing a user prose turn").
//
// This is a PLANNING estimate, not the real-time spend guard — the real
// guard is the LlmClient's own capUsd (createCostGuardedLlm, kg/spend-
// ledger.ts), enforced call-by-call regardless of what this module predicts.
// estimateWindowCostUsd deliberately prices the WORST case (max_tokens fully
// used on output) so the degrade selection errs toward dropping rather than
// silently overspending — actual spend is almost always lower (see
// backfill.ts's real measured total in the goal's D2 evidence).
import { chatCostUsd } from "@/lib/llm/client";
import { parseNonNegativeUsd } from "@/lib/llm/config";
import type { MemoryWindow } from "./windows";

/** design §3: "$0.25 (≈ 64 windows)". */
export const DEFAULT_SESSION_BUDGET_USD = 0.25;

/** Same max_tokens the extraction call itself uses (extract.ts) — kept here so the worst-case cost estimate and the real call can never silently drift apart. */
export const EXTRACT_MAX_OUTPUT_TOKENS = 2000;

export function resolveSessionBudgetUsd(env: Record<string, string | undefined> = process.env): number {
  return (
    parseNonNegativeUsd(env.MEMBRAL_MEMORY_SESSION_BUDGET_USD, "MEMBRAL_MEMORY_SESSION_BUDGET_USD") ??
    DEFAULT_SESSION_BUDGET_USD
  );
}

/**
 * Worst-case cost of ONE extraction call over `window`, given the header +
 * chat-precontext chars every window carries (windows.ts prepends both).
 *
 * step2d finding 5 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
 * #151): `chatCostUsd` returns `null` (never `0`) for an unpriced model —
 * this planning estimate must fail closed the same way every real-spend
 * guard now does, rather than silently pricing every window at $0 (which
 * would have let the degrade selection keep everything, unconditionally,
 * for a model nobody has actually priced).
 */
export function estimateWindowCostUsd(
  window: MemoryWindow,
  model: string,
  headerAndPrecontextChars: number,
  opts?: { selfHosted?: boolean },
): number {
  const inputTokens = Math.ceil((window.charLen + headerAndPrecontextChars) / 4);
  const cost = chatCostUsd(model, inputTokens, EXTRACT_MAX_OUTPUT_TOKENS, opts);
  if (cost === null) {
    throw new Error(
      `memory: no pricing entry for model "${model}" — refusing to estimate its cost as $0. Configure a priced model (see CHAT_PRICING in apps/cloud/src/lib/llm/client.ts).`,
    );
  }
  return cost;
}

export interface DegradeResult {
  /** Windows to actually extract, in original session order. */
  selected: MemoryWindow[];
  /** Windows dropped by degrade, in the order they were dropped. */
  dropped: MemoryWindow[];
  estimatedCostUsd: number;
  budgetHit: boolean;
  /** Sanity counter for D2's evidence — must always be 0 (a user-prose window is never an eligible drop candidate below). */
  droppedContainingUserProse: number;
}

/**
 * Fixed degrade order (design §3, verbatim): drop sub-agent windows, then
 * tool-only windows, then by density (lowest prose density first) — NEVER a
 * window containing a user prose turn, and ALWAYS keeping the first and last
 * main-transcript windows (by original position in the session, not by
 * position among whatever remains after earlier drops).
 */
export function selectWindowsWithinBudget(
  windows: MemoryWindow[],
  opts: { budgetUsd: number; model: string; headerAndPrecontextChars: number; selfHosted?: boolean },
): DegradeResult {
  if (windows.length === 0) {
    return { selected: [], dropped: [], estimatedCostUsd: 0, budgetHit: false, droppedContainingUserProse: 0 };
  }

  const costOf = (w: MemoryWindow): number =>
    estimateWindowCostUsd(w, opts.model, opts.headerAndPrecontextChars, {
      selfHosted: opts.selfHosted,
    });
  const firstIdx = windows[0].windowIndex;
  const lastIdx = windows[windows.length - 1].windowIndex;

  const selected = new Map<number, MemoryWindow>(windows.map((w) => [w.windowIndex, w]));
  let total = windows.reduce((n, w) => n + costOf(w), 0);

  const dropped: MemoryWindow[] = [];
  if (total > opts.budgetUsd) {
    // Eligible-to-drop pool: never the first/last window, never one with user prose.
    const eligible = () =>
      [...selected.values()].filter(
        (w) => w.windowIndex !== firstIdx && w.windowIndex !== lastIdx && !w.containsUserProse,
      );

    const pickNextToDrop = (): MemoryWindow | undefined => {
      const pool = eligible();
      if (pool.length === 0) return undefined;
      // NOTE: isSubAgent is always false today (see MemoryWindow's doc
      // comment — no per-turn agent_id exists yet) — this tier is future-
      // proofing, not dead code: the moment the parser starts recording
      // sub-agent turns, this ordering applies with no change here.
      const subAgent = pool.filter((w) => w.isSubAgent);
      if (subAgent.length > 0) return subAgent[0];
      const toolOnly = pool.filter((w) => w.isToolOnly);
      if (toolOnly.length > 0) return toolOnly[0];
      return pool.reduce((lowest, w) => (w.proseDensity < lowest.proseDensity ? w : lowest), pool[0]);
    };

    while (total > opts.budgetUsd) {
      const next = pickNextToDrop();
      if (!next) break; // nothing left we're allowed to drop
      selected.delete(next.windowIndex);
      dropped.push(next);
      total -= costOf(next);
    }
  }

  const finalSelected = windows.filter((w) => selected.has(w.windowIndex));
  return {
    selected: finalSelected,
    dropped,
    estimatedCostUsd: finalSelected.reduce((n, w) => n + costOf(w), 0),
    budgetHit: dropped.length > 0,
    droppedContainingUserProse: dropped.filter((w) => w.containsUserProse).length,
  };
}
