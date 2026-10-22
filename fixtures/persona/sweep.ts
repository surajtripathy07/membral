// Multi-scale clustering eval sweep (bead membral-b8w).
//
// This harness is the acceptance test — and the working definition — of
// "scale-generic clustering": it deterministically subsamples the Tusk fixture
// at several corpus sizes, re-bootstraps each subsample through the REAL
// pipeline (Pass 1 -> embed -> Stage A with computeClusterOpts -> promote ->
// Stage B) under its own demo user, and computes structural metrics from the
// resulting graph. A clustering rule qualifies only if every metric holds at
// EVERY scale with zero per-corpus retuning. Feeds bead membral-ieo.
//
// Metrics + acceptance bands (per scale N):
// - no-blob: no top-level LifeArea subtree > 35% of N (the membral-b8w wart:
//   Work held 89/200 = 44.5%). Secondary: largest single depth-1 block <= 35%.
// - entity-home recall: each top-K recurring home-eligible entity (Organization,
//   Tool, or Artifact; >= 3 attached convs) has exactly one dominant subtree
//   (some area/item subtree holds >= 60% of its attached conversations). Recall
//   must be 1.0. Label variants are canonicalized first so an entity's support
//   is not fragmented across near-duplicate nodes (membral-x34 fix). GATED only
//   on entities with >= ENTITY_HOME_MASS_THRESHOLD (8) attached convs — below
//   that mass, the attach.ts reroute can't seed a home at small corpus scale
//   regardless of clustering quality, so it's reported informationally
//   (entityHomeRecallInformational) but never fails the sweep (membral-x34
//   Path A). The metric core lives in apps/cloud/src/lib/kg/sweep-metrics.ts
//   (unit-tested under the kg suite; this driver only wires Supabase +
//   bootstrap around it).
// - duplicate-item rate (the "duplicate-sibling" wart, Groak x3 /
//   Mars-planning x3): pairs of Item nodes ANYWHERE in the forest whose labels
//   near-duplicate (token Jaccard >= 0.5). The observed warts are both
//   redundant nesting (parent/child with near-identical labels) and sibling
//   scatter, so all item pairs are compared, not just siblings. Band:
//   <= 0.10 dup pairs per item. (Driving this to ~0 is the follow-up
//   entity-aware refinement bead, not this one.)
// - orphan rate: <= 25% of N (the fixture carries 5% designed no-arc noise).
// - area count: 3..8 top-level LifeAreas at every scale.
//
// Determinism: subsampling uses a seeded PRNG (mulberry32) over the sorted
// corpus — same seed, same subsets, at any time, on any machine. Pass 1 +
// embeddings are cached per conversation, so re-running the sweep after a
// knob change only re-spends on Stage A naming + Stage B attach (~cents).
//
// Run from the repo root (needs apps/cloud/.env.local with OPENAI_API_KEY and
// local Supabase running):
//   npx tsx fixtures/persona/sweep.ts [--scales 60,100,200] [--seed 42] [--metrics-only]
//
// --metrics-only skips import/bootstrap and recomputes metrics from the
// existing per-scale graphs (zero LLM cost; useful when iterating on metrics).
// --baseline scores the standing tusk-demo graph (the eyeball-gate artifact)
// against the same bands instead of running the sweep (zero LLM cost).
// --fresh-pass1 drops each sweep user's per-conversation Pass-1 + embedding
// caches before bootstrapping, forcing a full re-classification. Needed when
// Pass 1's output schema gains fields the cached rows predate (e.g. the
// membral-y13 `entities` tags — rows cached before that field parse as [] and
// entity refinement silently no-ops). Costs a full bootstrap per scale
// (~$0.02-0.08 each) instead of Stage A/B only.

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Conversation } from "@membral/core";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runBootstrap } from "../../apps/cloud/src/lib/kg/bootstrap";
import { mulberry32 } from "../../apps/cloud/src/lib/kg/cluster-opts";
import { createKgClients } from "../../apps/cloud/src/lib/kg/queue";
import {
  checkMetrics,
  computeMetrics,
  type ScaleChecks,
  type ScaleMetrics,
  SWEEP_BANDS as BANDS,
} from "../../apps/cloud/src/lib/kg/sweep-metrics";
import {
  buildSnapshot,
  ensureUser,
  getServiceClient,
  importConversations,
  loadCorpus,
  selectAll,
} from "./lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = resolve(HERE, "sweep-results.json");

// ---------------------------------------------------------------------------
// Deterministic subsampling
// ---------------------------------------------------------------------------

/** Seeded Fisher-Yates over the sorted corpus; returns the first `n`, re-sorted. */
export function subsampleCorpus(corpus: Conversation[], n: number, seed: number): Conversation[] {
  if (n >= corpus.length) return corpus;
  const idx = corpus.map((_, i) => i);
  const rand = mulberry32(seed);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx
    .slice(0, n)
    .sort((a, b) => a - b)
    .map((i) => corpus[i]);
}

// ---------------------------------------------------------------------------
// Per-scale corpus + graph state management
// ---------------------------------------------------------------------------

/**
 * Make the user's conversations exactly the subsample: upsert the subsample,
 * delete anything else (cascades away its pass1/embedding cache). Cached rows
 * for kept conversations survive, so repeat sweeps only pay for Stage A/B.
 */
async function syncConversations(supabase: SupabaseClient, userId: string, sample: Conversation[]): Promise<number> {
  const keep = new Set(sample.map((c) => `${c.source}:${c.source_id}`));
  const existing = await selectAll<{ id: string; source: string; source_id: string }>((from, to) =>
    supabase.from("conversations").select("id, source, source_id").eq("user_id", userId).order("id").range(from, to),
  );
  const stale = existing.filter((c) => !keep.has(`${c.source}:${c.source_id}`)).map((c) => c.id);
  for (let i = 0; i < stale.length; i += 100) {
    const { error } = await supabase
      .from("conversations")
      .delete()
      .in("id", stale.slice(i, i + 100));
    if (error) throw new Error(`stale-conversation delete failed: ${error.message}`);
  }
  return importConversations(supabase, userId, sample);
}

/**
 * Clear the user's graph output (nodes/edges/tree; histories cascade) while
 * KEEPING the per-conversation pass1 + embedding caches, so a re-bootstrap
 * re-runs clustering/naming/attach on identical inputs.
 */
async function resetGraph(supabase: SupabaseClient, userId: string): Promise<void> {
  for (const table of ["kg_edges", "kg_nodes", "kg_stage_a_tree", "kg_extraction_rejections"]) {
    const { error } = await supabase.from(table).delete().eq("user_id", userId);
    if (error) throw new Error(`reset ${table} failed: ${error.message}`);
  }
}

/**
 * Drop the per-conversation Pass-1 + embedding caches (--fresh-pass1) so the
 * next bootstrap re-classifies and re-embeds every conversation. The embedding
 * cache goes too because embeddings are built from the Pass-1 summary +
 * central_topic — stale text would otherwise survive the re-run.
 */
async function resetPass1Cache(supabase: SupabaseClient, userId: string): Promise<void> {
  for (const table of ["kg_conversations_processed", "kg_conv_embeddings"]) {
    const { error } = await supabase.from(table).delete().eq("user_id", userId);
    if (error) throw new Error(`reset ${table} failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Sweep driver
// ---------------------------------------------------------------------------

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function printScale(n: number, metrics: ScaleMetrics, checks: ScaleChecks): void {
  console.log(`[sweep] N=${n} ${Object.values(checks).every(Boolean) ? "PASS" : "FAIL"}`);
  console.log(
    `  areas=${metrics.areaCount} [${checks.areaCount ? "ok" : "FAIL"}] ` +
      `maxAreaShare=${(metrics.maxAreaShare * 100).toFixed(1)}% [${checks.noBlobArea ? "ok" : "FAIL"}] ` +
      `maxBlockShare=${(metrics.maxBlockShare * 100).toFixed(1)}% (${metrics.maxBlockLabel}) [${checks.noBlobBlock ? "ok" : "FAIL"}]`,
  );
  console.log(
    `  orphanRate=${(metrics.orphanRate * 100).toFixed(1)}% [${checks.orphanRate ? "ok" : "FAIL"}] ` +
      `entityHomeRecall=${metrics.entityHomeRecall.toFixed(2)} [${checks.entityHomeRecall ? "ok" : "FAIL"}] ` +
      `entityHomeRecallInformational=${metrics.entityHomeRecallInformational.toFixed(2)} (not gated) ` +
      `dupItems=${metrics.dupItemPairs.length} pairs/${metrics.itemCount} items [${checks.dupItemRate ? "ok" : "FAIL"}]`,
  );
  for (const a of metrics.areaShares) {
    console.log(`    area "${a.label}": ${a.convs} convs (${(a.share * 100).toFixed(1)}%)`);
  }
  for (const h of metrics.entityHomes) {
    console.log(
      `    org "${h.entity}" (x${h.mentions}, ${h.attachedConvs} attached${h.gateable ? "" : ", informational"}): home=` +
        (h.home ? `"${h.home}" depth=${h.homeDepth} share=${(h.homeShare * 100).toFixed(0)}%` : "NONE"),
    );
  }
  for (const d of metrics.dupItemPairs) {
    console.log(`    dup items: "${d.a}" ~ "${d.b}" (jaccard ${d.jaccard.toFixed(2)})`);
  }
}

/** Score the standing tusk-demo graph against the same bands (folded in from the metrics validation scratch). */
async function runBaseline(supabase: SupabaseClient): Promise<void> {
  const email = process.env.DEMO_EMAIL ?? "tusk-demo@membral.demo";
  const userId = await ensureUser(supabase, email);
  const n = await selectAll<{ id: string }>((from, to) =>
    supabase.from("conversations").select("id").eq("user_id", userId).order("id").range(from, to),
  ).then((rows) => rows.length);
  console.log(`===== baseline (${email}, ${n} conversations) =====`);
  const snapshot = await buildSnapshot(supabase, userId, email);
  const metrics = computeMetrics(snapshot, n);
  printScale(n, metrics, checkMetrics(metrics));
}

async function main(): Promise<void> {
  const scales = (argValue("--scales") ?? "60,100,200")
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10))
    .filter((s) => Number.isFinite(s) && s > 0);
  const seed = Number.parseInt(argValue("--seed") ?? "42", 10);
  const metricsOnly = process.argv.includes("--metrics-only");
  const freshPass1 = process.argv.includes("--fresh-pass1");

  const supabase = getServiceClient();
  if (process.argv.includes("--baseline")) {
    await runBaseline(supabase);
    return;
  }
  const corpus = loadCorpus();
  console.log(`[sweep] corpus ${corpus.length} conversations, scales [${scales.join(", ")}], seed ${seed}`);

  const results: {
    scale: number;
    email: string;
    userId: string;
    clusterKnobs: string | null;
    costUsd: number;
    metrics: ScaleMetrics;
    checks: ScaleChecks;
    pass: boolean;
  }[] = [];
  let totalCost = 0;

  for (const scale of scales) {
    const email = `tusk-sweep-${scale}@membral.demo`;
    console.log(`\n===== scale ${scale} (${email}) =====`);
    const userId = await ensureUser(supabase, email);
    let clusterKnobs: string | null = null;
    let costUsd = 0;

    if (!metricsOnly) {
      const sample = subsampleCorpus(corpus, scale, seed);
      const imported = await syncConversations(supabase, userId, sample);
      console.log(`[sweep] synced ${imported} conversations`);
      await resetGraph(supabase, userId);
      if (freshPass1) {
        await resetPass1Cache(supabase, userId);
        console.log("[sweep] dropped pass1 + embedding caches (--fresh-pass1)");
      }

      const { supabase: kgSupabase, llm } = createKgClients();
      const summary = await runBootstrap({ supabase: kgSupabase, llm }, userId, {
        onProgress: (stage, detail) => {
          if (detail.startsWith("clustering knobs")) clusterKnobs = detail;
          console.log(`  [${stage}] ${detail}`);
        },
      });
      costUsd = summary.totalCostUsd;
      totalCost += costUsd;
    }

    const snapshot = await buildSnapshot(supabase, userId, email);
    const metrics = computeMetrics(snapshot, scale);
    const checks = checkMetrics(metrics);
    const pass = Object.values(checks).every(Boolean);
    results.push({ scale, email, userId, clusterKnobs, costUsd, metrics, checks, pass });

    printScale(scale, metrics, checks);
  }

  const allPass = results.every((r) => r.pass);
  const out = {
    bead: "membral-b8w + membral-y13 (joint gate)",
    generated_at: new Date().toISOString(),
    seed,
    fresh_pass1: freshPass1,
    bands: BANDS,
    total_cost_usd: totalCost,
    all_pass: allPass,
    results,
  };
  writeFileSync(OUT_FILE, `${JSON.stringify(out, (_k, v) => (v instanceof Map ? undefined : v), 2)}\n`);

  console.log(`\n===== sweep ${allPass ? "PASS" : "FAIL"} at ${results.length} scales, total LLM cost $${totalCost.toFixed(4)} =====`);
  console.log(`results written to ${OUT_FILE}`);
  if (!allPass) process.exitCode = 1;
}

// Only run when executed directly (the metric functions are importable for tests/tools).
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
