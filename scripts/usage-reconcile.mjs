#!/usr/bin/env node
// scripts/usage-reconcile.mjs — #93 / D6 (goal 2026-09-12 "usage numbers
// reconcile"): recompute one user's total agent-usage cost directly from
// code_sessions.props.usage (main + sub-agents), independently of the app's
// own aggregation code path, then compare it against what
// GET /api/code-sessions/stats renders for the same window. The two numbers
// existing means the dashboard's total isn't quietly drifting from the raw
// usage rows it's supposed to be summarizing.
//
// Usage:
//   node scripts/usage-reconcile.mjs --user <uuid> [--days 30] [--base-url http://localhost:3001] [--api-key lls_...]
//
// PRICE TABLE: this script does NOT reimplement pricing. It dynamically
// imports the app's own price table module —
// apps/cloud/src/lib/code-sessions/price-table.ts — by RELATIVE PATH from
// this file (see loadPriceTable() below), and calls its exported
// computeCost()/PRICE_TABLE_VERSION directly. That file has exactly one
// runtime import, `import type { RawUsage } from "@membral/core"` — a
// type-only import, erased at parse time — so it has no runtime dependency
// on the @membral/core package actually being built, and can be imported
// standalone via Node's native TypeScript type-stripping (stable since Node
// 23.6; this repo's CI/dev machines run newer Node, see package.json's
// engines and CLAUDE.md). If that native import ever fails (older Node), we
// fall back to spawning the `tsx` CLI (already a devDependency of
// apps/cloud, hoisted to the repo root's node_modules/.bin) against a tiny
// generated entry file that re-exports the same module — still the SAME
// source file, never a duplicate implementation.
//
// AUTH for the HTTP comparison step: GET /api/code-sessions/stats
// (apps/cloud/src/app/api/code-sessions/stats/route.ts) requires a Bearer
// Supabase JWT or an unscoped `lls_` API key belonging to the SAME user
// passed via --user. Supply it with --api-key or the MEMBRAL_API_KEY env
// var (the same env var `membral login`/the CLI already use — see
// packages/cli/src/credentials.ts). Without one, the request will
// authenticate as nobody and 401 — this script treats that the same as
// "server unreachable" (exit 2, recomputed total printed) since there is
// nothing to compare against.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");
const PRICE_TABLE_TS = path.join(REPO_ROOT, "apps/cloud/src/lib/code-sessions/price-table.ts");
const ENV_LOCAL_PATH = path.join(REPO_ROOT, "apps/cloud/.env.local");

const RECONCILE_TOLERANCE = 0.01; // 1%

// ---- .env.local loading (no dotenv dependency needed — the repo already
// has one in apps/cloud, but this script has no reason to depend on the
// cloud workspace's node_modules being resolvable from the repo root) -----

export function parseEnvFile(text) {
  /** @type {Record<string,string>} */
  const out = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Strip a trailing inline comment only when the value isn't quoted —
    // matches the shape actually used in apps/cloud/.env.local (e.g.
    // `MEMBRAL_KG_MONTHLY_CEILING_USD=8  # comment`).
    if (!(value.startsWith('"') || value.startsWith("'"))) {
      const hashIdx = value.indexOf(" #");
      if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
    }
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadEnvLocal() {
  if (!existsSync(ENV_LOCAL_PATH)) {
    throw new Error(`Missing ${ENV_LOCAL_PATH} — this script reads Supabase env vars from it directly.`);
  }
  return parseEnvFile(readFileSync(ENV_LOCAL_PATH, "utf8"));
}

// ---- Price table loading (the app's own module, not a reimplementation) --

/**
 * Dynamically import apps/cloud/src/lib/code-sessions/price-table.ts and
 * return its exports. Tries Node's native TS support first (fast path, no
 * subprocess); falls back to spawning `tsx` against a one-line re-export
 * shim when that throws (e.g. an older Node without type-stripping).
 */
export async function loadPriceTable() {
  try {
    return await import(pathToFileURL(PRICE_TABLE_TS).href);
  } catch (nativeErr) {
    let tmpDir;
    try {
      const tsxBin = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
      if (!existsSync(tsxBin)) throw nativeErr;
      tmpDir = mkdtempSync(path.join(tmpdir(), "membral-price-table-"));
      const shimTs = path.join(tmpDir, "run.ts");
      const outJson = path.join(tmpDir, "out.json");
      // Re-exports the SAME source file's computeCost for every tier below,
      // then writes the results as JSON — the .mjs process reads that back.
      // (We can't get live function values back across a subprocess
      // boundary, so this fallback path prices the fixed usage the caller
      // handed loadPriceTable's caller — see priceUsage() below, which calls
      // this shim only when the native import failed.)
      writeFileSync(
        shimTs,
        [
          `import { computeCost, PRICE_TABLE_VERSION } from ${JSON.stringify(PRICE_TABLE_TS)};`,
          `import { writeFileSync } from "node:fs";`,
          `const input = JSON.parse(process.argv[2]);`,
          `const results = input.map((r) => ({ ...computeCost(r.usage, r.model), version: PRICE_TABLE_VERSION }));`,
          `writeFileSync(${JSON.stringify(outJson)}, JSON.stringify({ results, PRICE_TABLE_VERSION }));`,
        ].join("\n"),
      );
      return { __shimTsxBin: tsxBin, __shimTs: shimTs, __shimOut: outJson, __shimTmpDir: tmpDir };
    } finally {
      // tmpDir cleanup happens after use in the fallback caller, not here —
      // this branch only prepares the shim.
    }
  }
}

/**
 * Price a batch of {usage, model} entries using the app's REAL price table.
 * Returns an array of ComputedCost-shaped objects (or undefined entries for
 * unpriceable usage), aligned index-for-index with `entries`.
 */
export async function priceUsageBatch(entries) {
  const mod = await loadPriceTable();
  if (mod.computeCost) {
    return entries.map((e) => mod.computeCost(e.usage, e.model));
  }
  // Fallback shim path (native TS import unavailable).
  try {
    execFileSync(mod.__shimTsxBin, [mod.__shimTs, JSON.stringify(entries)], { stdio: ["ignore", "ignore", "inherit"] });
    const out = JSON.parse(readFileSync(mod.__shimOut, "utf8"));
    return out.results;
  } finally {
    rmSync(mod.__shimTmpDir, { recursive: true, force: true });
  }
}

// ---- Usage extraction (mirrors lib/agent-stats/aggregate.ts's asRawUsage/
// asSubAgentList gates — duplicated here deliberately: this script's whole
// point is to recompute INDEPENDENTLY of the app's aggregation code, using
// only the shared price table, not aggregate.ts itself.) ------------------

function isFiniteNonNegative(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

export function asRawUsage(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw;
  if (
    !isFiniteNonNegative(u.inputTokens) ||
    !isFiniteNonNegative(u.outputTokens) ||
    !isFiniteNonNegative(u.cacheReadInputTokens) ||
    !isFiniteNonNegative(u.cacheCreationInputTokens)
  ) {
    return undefined;
  }
  return {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cacheReadInputTokens: u.cacheReadInputTokens,
    cacheCreationInputTokens: u.cacheCreationInputTokens,
  };
}

function emptyBuckets() {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
}

function addUsage(target, usage) {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheReadInputTokens += usage.cacheReadInputTokens;
  target.cacheCreationInputTokens += usage.cacheCreationInputTokens;
}

/**
 * Recompute totals for a batch of code_sessions rows: main-transcript usage
 * plus every non-fork sub-agent's own usage, each priced with ITS OWN model
 * (same rule as aggregate.ts's aggregateAgentStats — main + sub-agents,
 * never main-only). Returns { sessionsCounted, tokens, perModel, totalCost }.
 */
export async function reconcileSessions(sessions) {
  const priceEntries = [];
  // priceEntries[i] -> { sessionId, isMain, model }
  const entryMeta = [];

  for (const s of sessions) {
    const props = s.props ?? {};
    const usage = asRawUsage(props.usage);
    const models = Array.isArray(props.models) ? props.models.filter((m) => typeof m === "string") : [];
    const primaryModel = models[0];
    if (usage) {
      priceEntries.push({ usage, model: primaryModel });
      entryMeta.push({ sessionId: s.id, isMain: true, model: primaryModel });
    }
    const subAgents = Array.isArray(props.subAgents) ? props.subAgents : [];
    for (const sub of subAgents) {
      if (!sub || typeof sub !== "object" || sub.isFork === true) continue;
      const subUsage = asRawUsage(sub.usage);
      if (!subUsage) continue;
      priceEntries.push({ usage: subUsage, model: sub.model });
      entryMeta.push({ sessionId: s.id, isMain: false, model: sub.model });
    }
  }

  const priced = await priceUsageBatch(priceEntries);

  const tokens = emptyBuckets();
  const perModel = new Map(); // model string -> { cost, tokens, runs }
  let totalCost = 0;
  const pricedSessionIds = new Set();
  let priceTableVersion = null;

  for (let i = 0; i < priced.length; i++) {
    const cost = priced[i];
    if (!cost) continue;
    const meta = entryMeta[i];
    const usage = priceEntries[i].usage;
    priceTableVersion = cost.price_table_version ?? priceTableVersion;

    addUsage(tokens, usage);
    totalCost += cost.amount;
    pricedSessionIds.add(meta.sessionId);

    const key = meta.model ?? "(no model)";
    const entry = perModel.get(key) ?? { cost: 0, tokens: 0, runs: 0 };
    entry.cost += cost.amount;
    entry.tokens += usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
    entry.runs += 1;
    perModel.set(key, entry);
  }

  return {
    sessionsCounted: sessions.length,
    sessionsPriced: pricedSessionIds.size,
    tokens,
    perModel,
    totalCost: Math.round(totalCost * 1_000_000) / 1_000_000,
    priceTableVersion,
  };
}

// ---- CLI ------------------------------------------------------------------

function parseArgs(argv) {
  const args = { days: 30, baseUrl: "http://localhost:3001" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user") args.user = argv[++i];
    else if (a === "--days") args.days = Number(argv[++i]);
    else if (a === "--base-url") args.baseUrl = argv[++i];
    else if (a === "--api-key") args.apiKey = argv[++i];
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function usd(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function fmtTokens(n) {
  if (!Number.isFinite(n) || n <= 0) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

async function fetchSessionsForUser(env, userId, sinceIso) {
  const url = new URL(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/code_sessions`);
  url.searchParams.set("select", "id,started_at,turn_count,user_turn_count,props");
  url.searchParams.set("user_id", `eq.${userId}`);
  url.searchParams.set("started_at", `gte.${sinceIso}`);
  url.searchParams.set("order", "started_at.asc");
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase REST query failed: ${res.status} ${res.statusText} — ${await res.text()}`);
  }
  return res.json();
}

async function fetchPageTotal(baseUrl, days, apiKey) {
  const url = new URL("/api/code-sessions/stats", baseUrl);
  url.searchParams.set("days", String(days));
  const headers = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers });
  return { res, body: await res.json().catch(() => null) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.user) {
    console.log(
      "Usage: node scripts/usage-reconcile.mjs --user <uuid> [--days 30] [--base-url http://localhost:3001] [--api-key lls_...]",
    );
    process.exit(args.help ? 0 : 1);
    return;
  }
  if (!Number.isFinite(args.days) || args.days <= 0) {
    console.error("--days must be a positive number");
    process.exit(1);
    return;
  }

  const env = loadEnvLocal();
  if (!env.NEXT_PUBLIC_SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(`Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in ${ENV_LOCAL_PATH}`);
    process.exit(1);
    return;
  }

  const since = new Date(Date.now() - args.days * 24 * 60 * 60 * 1000);
  const sessions = await fetchSessionsForUser(env, args.user, since.toISOString());
  const result = await reconcileSessions(sessions);

  console.log(`usage-reconcile — user ${args.user}, last ${args.days}d`);
  console.log(`  price table: ${result.priceTableVersion ?? "(no priced usage)"}`);
  console.log(`  sessions counted: ${result.sessionsCounted} (priced: ${result.sessionsPriced})`);
  console.log(
    `  tokens — input ${fmtTokens(result.tokens.inputTokens)} · output ${fmtTokens(result.tokens.outputTokens)} · ` +
      `cache-read ${fmtTokens(result.tokens.cacheReadInputTokens)} · cache-write ${fmtTokens(result.tokens.cacheCreationInputTokens)}`,
  );
  console.log("  per-model cost:");
  for (const [model, entry] of [...result.perModel.entries()].sort((a, b) => b[1].cost - a[1].cost)) {
    console.log(`    ${model}: ${entry.runs} run(s), ${fmtTokens(entry.tokens)} tokens, ${usd(entry.cost)}`);
  }
  console.log(`  recomputed total cost: ${usd(result.totalCost)}`);

  let pageRes;
  try {
    pageRes = await fetchPageTotal(args.baseUrl, args.days, args.apiKey ?? process.env.MEMBRAL_API_KEY);
  } catch (err) {
    console.error(
      `\nCould not reach ${args.baseUrl} (${err instanceof Error ? err.message : String(err)}). ` +
        `Recomputed total from code_sessions.props.usage: ${usd(result.totalCost)}. ` +
        "Rerun with the dev server up (and --base-url/--api-key if needed) to compare against the page.",
    );
    process.exit(2);
    return;
  }

  if (!pageRes.res.ok) {
    const detail = pageRes.body && typeof pageRes.body === "object" ? JSON.stringify(pageRes.body) : String(pageRes.body);
    console.error(
      `\n${args.baseUrl}/api/code-sessions/stats returned ${pageRes.res.status}: ${detail}. ` +
        `Recomputed total from code_sessions.props.usage: ${usd(result.totalCost)}. ` +
        "Pass --api-key (or set MEMBRAL_API_KEY) for a JWT/lls_ key belonging to this --user, then rerun.",
    );
    process.exit(2);
    return;
  }

  const pageTotal = pageRes.body?.totals?.cost_usd ?? null;
  if (pageTotal === null) {
    console.error(
      `\n${args.baseUrl}/api/code-sessions/stats returned no cost_usd (zero priced sessions in its window). ` +
        `Recomputed total: ${usd(result.totalCost)}.`,
    );
    process.exit(2);
    return;
  }

  const diff = Math.abs(result.totalCost - pageTotal);
  const denom = Math.max(Math.abs(pageTotal), 1e-9);
  const withinTolerance = diff / denom <= RECONCILE_TOLERANCE;

  console.log(`\n  page total (${args.baseUrl}/api/code-sessions/stats): ${usd(pageTotal)}`);
  console.log(`  recomputed total:                                    ${usd(result.totalCost)}`);
  console.log(`  difference: ${usd(diff)} (${((diff / denom) * 100).toFixed(3)}%)`);

  if (withinTolerance) {
    console.log("  RECONCILED (within 1%)");
    process.exit(0);
  } else {
    console.error("  MISMATCH (exceeds 1% tolerance)");
    process.exit(1);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === __filename;
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
}
