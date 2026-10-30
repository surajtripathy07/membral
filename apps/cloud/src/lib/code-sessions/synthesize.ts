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
  // Only projects whose rollup changed this run: an unchanged rollup would embed to the same vector (cross-links.ts).
  const crossLinks = await matchCodeProjectCrossLinks({ ...deps, projectIds: rollup.rolledUpIds });
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

// Single-flight per user, in this process. Every import batch with new sessions fires a synthesis run, and a bulk
// sweep sends many batches back to back; overlapping runs read the same dirty projects and repeat the same LLM and
// embedding work. A trigger that arrives while a run is in flight does not start a second one: it marks the user
// "rerun wanted" and returns at once, and the in-flight run does ONE follow-up pass when it ends (so sessions
// imported mid-run are still summarized, however many triggers piled up). LIMIT: the map lives in module memory.
// The local server is one process, so this is exact there; on Vercel each invocation may be its own instance, so
// it only de-duplicates within one warm instance (the rollup's dirty flag keeps cross-instance reruns cheap).
const inFlight = new Map<string, { rerun: boolean }>();

type SynthesizeForUserOutcome =
  | SynthesizeCodeDimensionResult
  | { refused: true; reason: "already_running" }
  | { refused: true; reason: "monthly_ceiling_exceeded" }
  | { refused: true; reason: "global_ceiling_exceeded"; detail: GlobalCeilingReason }
  | { refused: true; reason: "feature_disabled"; detail: Exclude<FeatureCheckReason, "ok">; contact: string };

/**
 * Convenience wrapper for the route trigger — builds service-role + LLM
 * clients (capped + ledgered, issue #21) and runs the full pass for one user.
 * A monthly-ceiling refusal (or, issue #126, a disabled `llm` feature flag)
 * is a clean, logged no-op surfaced as `{ refused: true, reason }` rather
 * than a throw — callers must check for it. At most one run per user at a
 * time (see `inFlight` above); a coalesced trigger returns
 * `{ refused: true, reason: "already_running" }`, and the run that is in
 * flight returns the result of its last pass.
 */
export async function synthesizeCodeDimensionForUser(userId: string): Promise<SynthesizeForUserOutcome> {
  const running = inFlight.get(userId);
  if (running) {
    running.rerun = true;
    log.info("code dimension synthesis already running for user — coalesced into one follow-up run", {
      user_id: userId,
    });
    return { refused: true, reason: "already_running" };
  }
  const state = { rerun: false };
  inFlight.set(userId, state);
  try {
    let outcome = await runSynthesisOnce(userId);
    // A refusal (ceiling, feature flag) would only repeat, so only a completed pass earns the follow-up.
    while (state.rerun && !("refused" in outcome)) {
      state.rerun = false;
      outcome = await runSynthesisOnce(userId);
    }
    return outcome;
  } finally {
    inFlight.delete(userId);
  }
}

async function runSynthesisOnce(userId: string): Promise<SynthesizeForUserOutcome> {
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
