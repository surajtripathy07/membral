// Short-title backfill (migration 110): a 3-8 word title for every
// top-level code session of one user that has none yet. ONE small
// gpt-4o-mini call per session — see lib/code-sessions/short-title.ts.
//
// usage (from apps/cloud):
//   npx tsx scripts/code-sessions/short-titles.ts --user <uuid> [--limit N]
//     [--dry-run] [--max-usd 0.50] [--sessions <id,id,...>] [--out <file.json>]
//     [--pace-ms 0] [--route openai|openrouter]
//
// --dry-run: reads + model calls only. Never writes to the database — not
//   short_title, not the spend ledger. Prints one JSON object per session and
//   a final JSON summary; --out also writes the full result list as JSON.
//   Works before migration 110 is applied (reads every session instead).
// --max-usd: hard cost cap for the run (default $0.50). The client refuses the
//   next call once spend reaches it; the run stops, and a real run resumes
//   from the sessions still NULL.
// --limit: sessions per run (default 200). Resumable: re-run to continue.
// --pace-ms: minimum ms between calls; a 429 grows the pace proportionally
//   and a success decays it 0.9x toward this floor.
//
// Model: gpt-4o-mini, whatever MEMBRAL_MODEL says. --route openai (default):
// direct to OpenAI with OPENAI_API_KEY_DIRECT when set, else OPENAI_API_KEY
// with no MEMBRAL_MODEL_BASE_URL. --route openrouter: `openai/gpt-4o-mini`
// through MEMBRAL_MODEL_BASE_URL + OPENAI_API_KEY (same list price).
// An out-of-credits 429 stops the run. Keys are never printed.
// MEMBRAL_LLM_PROVIDER=claude-code: skips the key check and runs the local
// `claude` CLI through resolveModelConfig (model from MEMBRAL_MODEL); $0 spend.
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

const TITLE_MODEL = "gpt-4o-mini";
const OPENROUTER_TITLE_MODEL = "openai/gpt-4o-mini";

interface Args {
  userId: string;
  limit: number;
  dryRun: boolean;
  maxUsd: number;
  sessionIds?: string[];
  out?: string;
  paceMs: number;
  route: "openai" | "openrouter";
}

function parseArgs(argv: string[]): Args {
  const val = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const userId = val("--user");
  if (!userId) {
    console.error("usage: npx tsx scripts/code-sessions/short-titles.ts --user <uuid> [--limit N] [--dry-run] [--max-usd 0.50] [--sessions a,b] [--out file.json] [--pace-ms 0]");
    process.exit(1);
  }
  const num = (flag: string, dflt: number): number => {
    const raw = val(flag);
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      console.error(`${flag} must be a non-negative number`);
      process.exit(1);
    }
    return n;
  };
  const sessions = val("--sessions");
  return {
    userId,
    limit: Math.floor(num("--limit", 200)),
    dryRun: argv.includes("--dry-run"),
    maxUsd: num("--max-usd", 0.5),
    sessionIds: sessions ? sessions.split(",").map((s) => s.trim()).filter(Boolean) : undefined,
    out: val("--out"),
    paceMs: num("--pace-ms", 0),
    route: val("--route") === "openrouter" ? "openrouter" : "openai",
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { LlmClient } = await import("../../src/lib/llm/client");
  const { resolveModelConfig } = await import("../../src/lib/llm/config");
  const { getServiceClient: getServiceSupabase } = await import("../../src/lib/db/clients");
  const { createSpendLedger } = await import("../../src/lib/llm/spend-ledger");
  const { backfillShortTitles } = await import("../../src/lib/code-sessions/short-title");

  const useClaudeCode = process.env.MEMBRAL_LLM_PROVIDER?.trim() === "claude-code";
  const baseUrl = process.env.MEMBRAL_MODEL_BASE_URL?.trim() || "";
  let apiKey: string | undefined;
  let model = TITLE_MODEL;
  if (useClaudeCode) {
    // Provider config carries its own model label and a dummy key.
  } else if (args.route === "openrouter") {
    if (!/openrouter\.ai/.test(baseUrl)) {
      console.error("[short-titles] --route openrouter needs MEMBRAL_MODEL_BASE_URL pointing at openrouter.ai");
      process.exit(1);
    }
    apiKey = process.env.OPENAI_API_KEY?.trim();
    model = OPENROUTER_TITLE_MODEL;
  } else {
    apiKey = process.env.OPENAI_API_KEY_DIRECT?.trim() || (baseUrl ? undefined : process.env.OPENAI_API_KEY?.trim());
  }
  if (!apiKey && !useClaudeCode) {
    console.error("[short-titles] no API key for this route (see the header comment)");
    process.exit(1);
  }
  const modelConfig = useClaudeCode
    ? resolveModelConfig(process.env)
    : resolveModelConfig({
        ...process.env,
        MEMBRAL_MODEL: model,
        MEMBRAL_MODEL_BASE_URL: args.route === "openrouter" ? baseUrl : "",
        OPENAI_API_KEY: apiKey,
      });
  if (useClaudeCode) model = modelConfig.model;

  const supabase = getServiceSupabase();
  // Dry run: no spend ledger — the ledger is a database write.
  const ledger = args.dryRun ? null : createSpendLedger(supabase, args.userId, { runId: randomUUID(), flushEvery: 1 });
  const llm = new LlmClient(modelConfig, {
    capUsd: args.maxUsd,
    onSpend: ledger?.onSpend,
    // Our own proportional back-off handles 429s (CLAUDE.md) — no SDK retry storm.
    maxRetries: 0,
    timeoutMs: 30_000,
  });

  console.error(
    `[short-titles] user=${args.userId} dry_run=${args.dryRun} limit=${args.limit} max_usd=$${args.maxUsd.toFixed(2)} model=${model}`,
  );
  const result = await backfillShortTitles({
    supabase,
    llm,
    userId: args.userId,
    limit: args.limit,
    dryRun: args.dryRun,
    sessionIds: args.sessionIds,
    model,
    minPaceMs: args.paceMs,
    onResult: (r) =>
      console.log(
        JSON.stringify({
          session_id: r.sessionId,
          started_at: r.startedAt,
          short_title: r.title,
          rejected: r.rejected,
          skipped: r.skipped,
          cost_usd: Number(r.costUsd.toFixed(6)),
        }),
      ),
  });
  await ledger?.flush();

  const { results, ...totals } = result;
  if (args.out) writeFileSync(args.out, JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ summary: { ...totals, costUsd: Number(totals.costUsd.toFixed(6)) } }));
  if (result.columnMissing) console.error("[short-titles] note: code_sessions.short_title missing (migration 110 not applied) — read every session.");
  if (result.capped) console.error(`[short-titles] STOP: cost cap $${args.maxUsd.toFixed(2)} reached — re-run to continue.`);
}

main().catch((err) => {
  console.error(`[short-titles] failed: ${(err as Error).message}`);
  process.exit(1);
});
