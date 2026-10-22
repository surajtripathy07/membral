// Orchestrates the P1c code-dimension synthesis pass (ADR 0021 Q5):
// per-session summaries -> per-CodeProject rollups -> cross-links to the chat
// graph. Order matters: a project's rollup is built from its sessions'
// summaries (so summaries must exist first), and cross-link matching reads
// each project's freshly written rollup.people (so rollups must run before
// cross-links).
//
// Two callers trigger this (see ADR P1c phase entry):
//  - POST /api/code-sessions, fire-and-forget after a successful import batch
//    (mirrors how /api/sync triggers processKgPass1).
//  - POST /api/code-sessions/synthesize, synchronously, for manual/backfill
//    re-runs.
//
// ISOLATION (ADR Q2 / ADR 0023 Q3): this module calls the three P1c
// code-sessions steps below PLUS the Stage-1 code-graph build (ADR 0023
// Q4/P2a — zero LLM cost, writes only code_kg_nodes/code_kg_edges). The only
// kg_* touch anywhere in this pass is cross-links.ts's read-only kg_nodes
// select — see code-isolation.test.ts, extended to also snapshot
// code_kg_nodes/code_kg_edges isolation from the CHAT graph across a full
// synthesize run.

import { getServiceClient, SUPABASE_ENV_MISSING_MESSAGE } from "@/lib/db/clients";
import type { Db } from "@/lib/db/types";
import { checkFeature, type FeatureCheckReason } from "../feature-flags";
import { LlmClient } from "../llm/client";
import { resolveCostCapConfig, resolveModelConfig } from "../llm/config";
import { checkMonthlyCeiling, createSpendLedger } from "../llm/spend-ledger";
import { log } from "../log";
import { checkGlobalCeilings, type GlobalCeilingReason, globalHeadroomUsd } from "../memory/global-ceiling";
import { type BuildCodeGraphResult, buildCodeGraphForUser } from "./code-graph";
import { type MatchCrossLinksResult, matchCodeProjectCrossLinks } from "./cross-links";
import { type RollupCodeProjectsResult, rollupCodeProjects } from "./rollup";
import { type SummarizeCodeSessionsResult, summarizeCodeSessions } from "./summarize";

export interface SynthesizeCodeDimensionResult {
  summarize: SummarizeCodeSessionsResult;
  rollup: RollupCodeProjectsResult;
  crossLinks: MatchCrossLinksResult;
  codeGraph: BuildCodeGraphResult[];
  costUsd: number;
}

export interface SynthesizeCodeDimensionDeps {
  supabase: Db;
  llm: LlmClient;
  userId: string;
}

/**
 * Runs the P1c steps in order: summaries -> rollups -> cross-links, plus the
 * Stage-1 deterministic code-graph build (ADR 0023 P2a). The graph build
 * runs LAST and is independent of the LLM steps' outcome — it folds
 * code_projects/code_sessions/code_session_turns columns that exist
 * regardless of whether summarize/rollup succeeded, so a malformed LLM
 * completion (which those two already degrade gracefully on) never blocks
 * the free deterministic graph from staying current.
 */
export async function synthesizeCodeDimension(
  deps: SynthesizeCodeDimensionDeps,
): Promise<SynthesizeCodeDimensionResult> {
  const summarize = await summarizeCodeSessions(deps);
  const rollup = await rollupCodeProjects(deps);
  const crossLinks = await matchCodeProjectCrossLinks(deps);
  const codeGraph = await buildCodeGraphForUser(deps.supabase, deps.userId);
  const costUsd = summarize.costUsd + rollup.costUsd;

  log.info("code_dimension_synthesize complete", {
    user_id: deps.userId,
    sessions_processed: summarize.processed,
    projects_rolled_up: rollup.processed,
    cross_links_created: crossLinks.created,
    code_graph_projects: codeGraph.length,
    cost_usd: costUsd,
  });

  return { summarize, rollup, crossLinks, codeGraph, costUsd };
}

type CreateCodeSessionClientsResult =
  | { ok: true; supabase: Db; llm: LlmClient; flushSpend: () => Promise<void> }
  | { ok: false; reason: "monthly_ceiling_exceeded" }
  | { ok: false; reason: "global_ceiling_exceeded"; detail: GlobalCeilingReason }
  | { ok: false; reason: "feature_disabled"; detail: Exclude<FeatureCheckReason, "ok">; contact: string };

/**
 * DI-free client construction — mirrors lib/kg/queue.ts's createKgClients(),
 * kept local so this dimension has no import-time coupling to the kg/ module
 * (ISOLATION, ADR Q2). Also mirrors createKgClients' cost-cap wiring (issue
 * #21): this is the timed-sweep entry point the per-run cap and monthly
 * ceiling preflight MUST cover too — a capped bootstrap alone is not a
 * ceiling if a recurring code-session sync can spend uncapped on its own
 * LlmClient. Ceiling refusal is a clean, logged no-op — never a throw.
 *
 * Issue #126 (ADR 0047): a SEPARATE choke point from createCostGuardedLlm
 * (this module hand-rolls its own client/ceiling/ledger wiring rather than
 * reusing that factory — see the module header) — must be gated
 * independently. Same non-throwing result-type shape as the ceiling check,
 * for the same reason: the fire-and-forget POST /api/code-sessions trigger
 * must degrade cleanly, never crash the import response.
 */
async function createCodeSessionClients(userId: string): Promise<CreateCodeSessionClientsResult> {
  const supabase = getServiceClient({
    message: SUPABASE_ENV_MISSING_MESSAGE,
  });

  const check = await checkFeature(userId, "llm");
  if (!check.allowed) {
    log.warn("code dimension synthesis refused: llm feature not enabled/exhausted for this user", {
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

  const ceiling = await checkMonthlyCeiling(supabase, userId);
  if (!ceiling.allowed) {
    log.warn("code dimension synthesis refused: monthly cost ceiling exceeded", {
      user_id: userId,
      spent_usd: ceiling.spentUsd,
      ceiling_usd: ceiling.ceilingUsd,
    });
    return { ok: false, reason: "monthly_ceiling_exceeded" };
  }

  // Issue #335: the all-users daily + monthly ceilings — session summaries,
  // roll-ups and cross-links spend through this client, not
  // createCostGuardedLlm, so they need their own check. Fails closed.
  const global = await checkGlobalCeilings(supabase);
  if (!global.allowed) {
    const detail = global.reason ?? "global_ceiling_unchecked";
    // Error level: the fire-and-forget route trigger ignores the result, so
    // this line is the only trace of the refusal.
    log.error("code dimension synthesis refused: global LLM spend ceiling", {
      user_id: userId,
      detail,
      spent_usd: global.spentUsd,
      ceiling_usd: global.ceilingUsd,
    });
    return { ok: false, reason: "global_ceiling_exceeded", detail };
  }

  const costCap = resolveCostCapConfig();
  const ledger = createSpendLedger(supabase, userId);
  // Issue #335 review: the run never spends past the global headroom left.
  const capUsd = Math.min(costCap.perRunCapUsd, globalHeadroomUsd(global));
  const llm = new LlmClient(resolveModelConfig(), { capUsd, onSpend: ledger.onSpend });
  return { ok: true, supabase, llm, flushSpend: ledger.flush };
}

/**
 * Convenience wrapper for the two route triggers — builds service-role + LLM
 * clients (capped + ledgered, issue #21) and runs the full pass for one user.
 * A monthly-ceiling refusal (or, issue #126, a disabled `llm` feature flag)
 * is a clean, logged no-op surfaced as `{ refused: true, reason }` rather
 * than a throw — callers must check for it.
 */
export async function synthesizeCodeDimensionForUser(
  userId: string,
): Promise<
  | SynthesizeCodeDimensionResult
  | { refused: true; reason: "monthly_ceiling_exceeded" }
  | { refused: true; reason: "global_ceiling_exceeded"; detail: GlobalCeilingReason }
  | { refused: true; reason: "feature_disabled"; detail: Exclude<FeatureCheckReason, "ok">; contact: string }
> {
  const clients = await createCodeSessionClients(userId);
  if (!clients.ok) {
    if (clients.reason === "feature_disabled") {
      return { refused: true, reason: "feature_disabled", detail: clients.detail, contact: clients.contact };
    }
    if (clients.reason === "global_ceiling_exceeded") {
      return { refused: true, reason: "global_ceiling_exceeded", detail: clients.detail };
    }
    return { refused: true, reason: "monthly_ceiling_exceeded" };
  }
  const { supabase, llm, flushSpend } = clients;
  try {
    return await synthesizeCodeDimension({ supabase, llm, userId });
  } finally {
    await flushSpend();
  }
}
