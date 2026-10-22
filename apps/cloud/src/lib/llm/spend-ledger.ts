// Spend ledger — durable, append-only record of every billable LLM call
// (GitHub issue #21, ADR 0027 J6.2). Backs three things:
//   1. carrying a per-run cap forward across a phase-split client rebuild
//      (bootstrap.ts's Phase 1 -> Phase 2 seedCostUsd), scoped by run_id;
//   2. the rolling per-user monthly ceiling preflight (checkMonthlyCeiling);
//   3. createCostGuardedLlm — the one shared factory every LLM-spending entry
//      point (bootstrap, code-sessions sweep) should build its LlmClient through, so
//      the ceiling gate + per-run cap + ledger wiring can't be forgotten at a
//      new call site.
//
// Table: migration 035 (llm_spend), service-role only, same lock-down
// pattern as migration 028's rate_limit_hits. All sums happen SERVER-SIDE via
// the llm_spend_sum RPC (migration 035) — PostgREST's 1000-row default cap on
// `.select()` makes a client-side fetch-and-reduce silently truncate any sum
// over 1000 rows (adversarial review B1: 1200 rows of $0.001 summed to $1.00,
// not the true $1.20). There must be no row-fetching sum path for this table.

import type { Db } from "@/lib/db/types";
import { checkFeature, type FeatureCheckReason } from "../feature-flags";
import { log } from "../log";
import {
  checkGlobalCeilings,
  type GlobalCeilingReason,
  type GlobalCeilingWindow,
  globalHeadroomUsd,
} from "../memory/global-ceiling";
import { LlmClient, type OnSpendCallback } from "./client";
import { resolveCostCapConfig, resolveModelConfig } from "./config";
import type { CostRecord } from "./passes";

const DEFAULT_FLUSH_EVERY = 20;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Conservative fallback ceiling applied ONLY in production (NODE_ENV ===
 * "production") when MEMBRAL_KG_MONTHLY_CEILING_USD is unset/unparseable
 * (issue #126 verification finding — "no ceiling" is not an acceptable
 * production default even though ADR 0027 J6.2 deliberately left no default
 * for the mechanism itself; this does not change resolveCostCapConfig, which
 * still correctly reports `null`/"not enforcing" for local/test — it only
 * changes what checkMonthlyCeiling DOES with that null in production). Set a
 * real MEMBRAL_KG_MONTHLY_CEILING_USD before your first real user — this
 * fallback is a backstop, not a product/pricing decision.
 */
const DEFAULT_PRODUCTION_MONTHLY_CEILING_USD = 25;

/** Logs the production-default-ceiling fallback at most once per process — checkMonthlyCeiling runs on every gated call and must not spam the log. */
let warnedProductionCeilingFallback = false;

/** Exposed for tests only — the module-level "warned once" flag would otherwise leak state across test cases. */
export function _resetProductionCeilingWarningForTest(): void {
  warnedProductionCeilingFallback = false;
}

export interface SpendLedger {
  /** Hand this straight to `new LlmClient(config, { onSpend })`. Never throws. */
  onSpend: OnSpendCallback;
  /** Flush any buffered rows. Call at run end (finally block) — a crash before this loses at most the buffer. Never throws. */
  flush: () => Promise<void>;
}

interface SpendRow {
  user_id: string;
  pass: string;
  model: string;
  cost_usd: number;
  run_id: string | null;
}

/**
 * Buffers spend rows in memory and flushes in batches of `flushEvery`
 * (default 20) plus whatever is left when `flush()` is called explicitly
 * (callers MUST call flush() at run end — a `finally` block around the
 * pipeline call is the standard shape here). A crash before a flush loses at
 * most that buffer's worth of rows; the ledger is an accounting aid, not a
 * source of truth for the run's own cost reporting (CostRecord/totalCostUsd
 * cover that in-memory, unaffected by this buffer).
 *
 * `runId` (issue #21 adversarial review M5): tags every buffered row with the
 * kg_bootstrap_runs.id this spend belongs to, so a later phase of the SAME
 * run can seed its budget via llm_spend_sum(..., p_run_id) instead of a
 * spent_at time window — a time window can be contaminated by unrelated
 * concurrent spend for the same user (e.g. a steady-state Pass 1 trigger
 * firing while this run sits parked at the review gate). Pass `null` (the
 * default) for every caller with no run concept: steady-state Pass 1, the
 * code-sessions sweep.
 *
 * Insert failures are logged and swallowed — NEVER allowed to crash or halt
 * the run (CLAUDE.md rule / ADR 0027 J6.2).
 */
export function createSpendLedger(
  supabase: Db,
  userId: string,
  opts: { flushEvery?: number; runId?: string | null } = {},
): SpendLedger {
  const flushEvery = opts.flushEvery ?? DEFAULT_FLUSH_EVERY;
  const runId = opts.runId ?? null;
  let buffer: SpendRow[] = [];

  async function flush(): Promise<void> {
    if (buffer.length === 0) return;
    const rows = buffer;
    buffer = [];
    try {
      const { error } = await supabase.from("llm_spend").insert(rows);
      if (error) log.warn("llm_spend flush failed", { user_id: userId, rows: rows.length, err: error.message });
    } catch (e) {
      log.warn("llm_spend flush threw", { user_id: userId, rows: rows.length, err: (e as Error).message });
    }
  }

  const onSpend: OnSpendCallback = (record: CostRecord) => {
    buffer.push({ user_id: userId, pass: record.pass, model: record.model, cost_usd: record.cost_usd, run_id: runId });
    if (buffer.length >= flushEvery) {
      // Fire-and-forget: onSpend is a sync callback off LlmClient.record();
      // never make callJson/embed wait on a ledger write.
      void flush();
    }
  };

  return { onSpend, flush };
}

/**
 * Server-side sum of llm_spend.cost_usd via the llm_spend_sum RPC (migration
 * 035) — NEVER fetch rows and reduce client-side (see the file header: this
 * is exactly the bug adversarial review B1 caught). Two mutually exclusive
 * modes:
 *   - `runId` set: sums ONLY rows tagged with that run_id (phase-split seed).
 *   - `runId` unset: sums rows with spent_at > `sinceIso` (monthly ceiling).
 * Fails to 0 on an RPC error (logged) — callers decide whether that's a
 * fail-open (ceiling preflight) or fail-safe-low (phase-2 seed) posture.
 */
export async function llmSpendSum(
  supabase: Db,
  userId: string,
  opts: { sinceIso?: string; runId?: string } = {},
): Promise<number> {
  const { data, error } = await supabase.rpc("llm_spend_sum", {
    p_user_id: userId,
    p_since: opts.sinceIso ?? new Date(0).toISOString(),
    p_run_id: opts.runId ?? null,
  });
  if (error) {
    log.warn("llm_spend_sum rpc failed — returning 0", {
      user_id: userId,
      run_id: opts.runId ?? null,
      err: error.message,
    });
    return 0;
  }
  const n = Number(data);
  return Number.isFinite(n) ? n : 0;
}

export interface MonthlyCeilingCheck {
  allowed: boolean;
  /** Sum of cost_usd over the trailing 30 days for this user. 0 when the ceiling isn't configured (query skipped). */
  spentUsd: number;
  /** The configured ceiling, or null when the mechanism is present but not enforcing (ADR 0027 J6.2). 0 is a valid, enforcing value ("block all runs"). */
  ceilingUsd: number | null;
}

/**
 * Rolling 30-day per-user spend ceiling preflight (ADR 0027 J6.2). When
 * MEMBRAL_KG_MONTHLY_CEILING_USD is unset, the mechanism exists but does not
 * enforce (`allowed: true` unconditionally, no query issued) — there is no
 * default dollar figure to fall back to. A configured `0` IS a valid,
 * enforcing ceiling (driver decision): it blocks every run outright, since
 * spend can never be negative.
 *
 * Fails OPEN on a query error (allowed: true) — a transient DB read failure on
 * a preflight check must never block a legitimate run; the query itself is
 * defense against runaway spend, not the run's actual budget enforcement
 * (that's LlmClient.capUsd, which fails closed).
 */
export async function checkMonthlyCeiling(
  supabase: Db,
  userId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<MonthlyCeilingCheck> {
  const { monthlyCeilingUsd: configuredCeilingUsd } = resolveCostCapConfig(env);
  let monthlyCeilingUsd = configuredCeilingUsd;

  // issue #126 verification finding: an unset ceiling in PRODUCTION must not
  // mean "unlimited spend" — apply a conservative built-in default instead.
  // Local/test (env.NODE_ENV !== "production") keep the ADR 0027 J6.2
  // "not enforcing" behavior exactly as before.
  if (monthlyCeilingUsd === null && env.NODE_ENV === "production") {
    monthlyCeilingUsd = DEFAULT_PRODUCTION_MONTHLY_CEILING_USD;
    if (!warnedProductionCeilingFallback) {
      warnedProductionCeilingFallback = true;
      log.warn(
        "MEMBRAL_KG_MONTHLY_CEILING_USD is unset in production — applying a conservative built-in default ceiling instead of running unenforced; set this var explicitly to override",
        { default_ceiling_usd: DEFAULT_PRODUCTION_MONTHLY_CEILING_USD },
      );
    }
  }

  if (monthlyCeilingUsd === null) {
    return { allowed: true, spentUsd: 0, ceilingUsd: null };
  }

  const since = new Date(Date.now() - THIRTY_DAYS_MS).toISOString();
  const spentUsd = await llmSpendSum(supabase, userId, { sinceIso: since });
  return { allowed: spentUsd < monthlyCeilingUsd, spentUsd, ceilingUsd: monthlyCeilingUsd };
}

// ---------------------------------------------------------------------------
// createCostGuardedLlm — the shared "build me a capped, ledgered, ceiling-
// gated LlmClient" factory (issue #21 adversarial review B2). ANY route or
// script that spends LLM money must go through this rather than `new
// LlmClient(resolveModelConfig())` directly — that bare-client shape is
// exactly the hole adversarial review found in the portrait route.
// ---------------------------------------------------------------------------

export type CostGuardedLlmResult =
  | {
      ok: true;
      llm: LlmClient;
      flushSpend: () => Promise<void>;
      /** Issue #335: set when a global window's headroom (not the run cap) set this client's cap — a cap hit then means that ceiling was reached. */
      globalCapWindow?: GlobalCeilingWindow;
    }
  | { ok: false; reason: "monthly_ceiling_exceeded"; spentUsd: number; ceilingUsd: number }
  | {
      ok: false;
      /**
       * Issue #335: the ALL-USERS spend ceiling (global-ceiling.ts) refused.
       * `detail` says which: "global_daily_ceiling", "global_monthly_ceiling",
       * or "global_ceiling_unchecked" (sum unreadable — fails closed).
       */
      reason: "global_ceiling_exceeded";
      detail: GlobalCeilingReason;
      spentUsd: number;
      ceilingUsd: number;
    }
  | {
      ok: false;
      reason: "feature_disabled";
      /**
       * Issue #128 (ADR 0047 v2): the SPECIFIC check-feature reason
       * ("disabled" | "budget_exhausted" | "daily_exhausted") folded under
       * the existing "feature_disabled" result-type member rather than
       * added as new sibling union members — every existing caller of this
       * factory (bootstrap, steady-state pass1, the arrival loop,
       * processKgPass1) already pattern-matches `reason === "feature_disabled"`
       * as a single clean no-op branch; adding new top-level reasons would
       * require every one of those call sites to learn two new cases just to
       * keep behaving the same way. `detail` is purely additive — callers
       * that want the SPECIFIC reason for a user-facing message (e.g.
       * api/portrait/route.ts) read it; callers that only care "did this
       * refuse" keep working unchanged.
       */
      detail: Exclude<FeatureCheckReason, "ok">;
      contact: string;
    };

/**
 * `serviceSupabase` MUST be a service-role client (llm_spend has no RLS
 * policies — an RLS-scoped cookie client would read/write zero rows and the
 * ceiling check would silently never trigger). This is deliberately
 * DECOUPLED from whatever supabase client the caller uses for its own data
 * reads/writes (e.g. the portrait route's user-scoped cookie client for
 * kg_user_portraits) — callers pass their OWN data client to whatever they
 * call next; only the cost-guard plumbing needs service-role.
 *
 * Issue #126 (ADR 0047): checks the per-user `llm` feature flag BEFORE the
 * monthly-ceiling preflight — this is the single factory that covers every
 * chat-completion LlmClient in the KG pipeline (bootstrap, steady-state
 * pass1, the claims-advance
 * arrival loop, all via createKgClients) PLUS the portrait route's direct
 * call, so gating here is the one place that protects all of them at once.
 * Returned as a result-type reason (`{ ok: false, reason: "feature_disabled"
 * }`), not a thrown FeatureDisabledError — this keeps the EXISTING contract
 * every caller already implements for "monthly_ceiling_exceeded" (a clean,
 * logged no-op: `if (!clients.ok) return ...`), which is exactly the
 * fail-closed-but-non-crashing degrade the fire-and-forget queue callers
 * (processKgPass1, the arrival loop) need — sync/import must still succeed
 * for a flagged-off user. HTTP routes that want an honest 403 (rather than a
 * silent no-op) check `reason === "feature_disabled"` explicitly and call
 * featureDisabledResponse — see api/portrait/route.ts.
 *
 * `opts.bypassFeatureGate` (issue #126): operator scripts under
 * apps/cloud/scripts/kg (bootstrap.ts, claims-refresh.ts, etc.) are never HTTP-reachable — a `--user-id` is
 * supplied by hand by a trusted operator — so they opt out of this ONE
 * check explicitly rather than requiring the target account to be flagged
 * on first. Defaults false: every HTTP-route caller (createKgClients'
 * default, the portrait route) stays gated.
 */
export async function createCostGuardedLlm(
  serviceSupabase: Db,
  userId: string,
  opts: {
    runId?: string | null;
    seedCostUsd?: number;
    capUsdOverride?: number;
    bypassFeatureGate?: boolean;
    /** Ledger batch size (default 20). Memory extraction passes 1 so a killed invocation loses no recorded spend (P10 re-review N2). */
    flushEvery?: number;
    /** Per-request LLM timeout (ms) and SDK retry count — see LlmClient. Defaults unchanged for every other caller. */
    timeoutMs?: number;
    maxRetries?: number;
    /** Embedding client only (P10 round 3 R3-m2) — see LlmClient. */
    embedTimeoutMs?: number;
    embedMaxRetries?: number;
  } = {},
): Promise<CostGuardedLlmResult> {
  if (!opts.bypassFeatureGate) {
    const check = await checkFeature(userId, "llm");
    if (!check.allowed) {
      log.warn("createCostGuardedLlm refused: llm feature not enabled/exhausted for this user", {
        user_id: userId,
        detail: check.reason,
      });
      return {
        ok: false,
        reason: "feature_disabled",
        detail: check.reason as Exclude<FeatureCheckReason, "ok">,
        contact: check.contact,
      };
    }
  }

  const ceiling = await checkMonthlyCeiling(serviceSupabase, userId);
  if (!ceiling.allowed) {
    log.warn("createCostGuardedLlm refused: monthly cost ceiling exceeded", {
      user_id: userId,
      spent_usd: ceiling.spentUsd,
      ceiling_usd: ceiling.ceilingUsd,
    });
    return {
      ok: false,
      reason: "monthly_ceiling_exceeded",
      spentUsd: ceiling.spentUsd,
      ceilingUsd: ceiling.ceilingUsd as number,
    };
  }

  // Issue #335: the all-users daily + monthly ceilings, checked on EVERY
  // client built here (bypassFeatureGate skips only the per-user flag above,
  // never this). Fails closed when the sum is unreadable.
  const global = await checkGlobalCeilings(serviceSupabase);
  if (!global.allowed) {
    const detail = global.reason ?? "global_ceiling_unchecked";
    log.warn("createCostGuardedLlm refused: global LLM spend ceiling", {
      user_id: userId,
      detail,
      spent_usd: global.spentUsd,
      ceiling_usd: global.ceilingUsd,
    });
    return {
      ok: false,
      reason: "global_ceiling_exceeded",
      detail,
      spentUsd: global.spentUsd,
      ceilingUsd: global.ceilingUsd,
    };
  }

  const costCap = resolveCostCapConfig();
  const runCapUsd = opts.capUsdOverride ?? costCap.perRunCapUsd;
  const globalCapUsd = (opts.seedCostUsd ?? 0) + globalHeadroomUsd(global);
  const ledger = createSpendLedger(serviceSupabase, userId, { runId: opts.runId ?? null, flushEvery: opts.flushEvery });
  const llm = new LlmClient(resolveModelConfig(), {
    // D5 (ADR 0030 addendum "D9 — the arrival loop"): `capUsdOverride` lets the
    // arrival-loop's incremental cap (MEMBRAL_KG_INCREMENTAL_CAP_USD, default
    // $0.25/cycle — see arrival-loop.ts's resolveIncrementalCapUsd) stand in
    // for the bootstrap-sized per-run cap (MEMBRAL_KG_COST_CAP_USD, default
    // $5) on this ONE call, without touching perRunCapUsd's own default for
    // every OTHER caller of this factory (bootstrap, steady-state pass1, …).
    //
    // Issue #335 review: never more than the global headroom left. The seed
    // is spend already in the ledger (so already in global.spentUsd), hence
    // seed + headroom.
    capUsd: Math.min(runCapUsd, globalCapUsd),
    seedCostUsd: opts.seedCostUsd,
    onSpend: ledger.onSpend,
    timeoutMs: opts.timeoutMs,
    maxRetries: opts.maxRetries,
    embedTimeoutMs: opts.embedTimeoutMs,
    embedMaxRetries: opts.embedMaxRetries,
  });
  return globalCapUsd < runCapUsd
    ? { ok: true, llm, flushSpend: ledger.flush, globalCapWindow: global.window }
    : { ok: true, llm, flushSpend: ledger.flush };
}
