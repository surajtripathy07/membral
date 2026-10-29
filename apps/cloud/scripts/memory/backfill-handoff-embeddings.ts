// Backfill: embed live handoff notes (session_memories.kind = 'handoff') that have no vector (MEMBRAL_HANDOFF_SEARCH).
// Paged and idempotent: only rows with embedding IS NULL are read, and the write is conditional on that, so a re-run
// touches nothing already embedded. Local embeddings only: refuses unless the bundled model or a loopback base URL.
//
// usage (from apps/cloud):
//   npx tsx scripts/memory/backfill-handoff-embeddings.ts --user <uuid> [--dry-run] [--limit N]
// --dry-run reads and counts, embeds and writes nothing.

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { getServiceClient } from "../../src/lib/db/clients";
import type { Db } from "../../src/lib/db/types";
import { isBundledEmbeddingConfig, isLocalModelBaseURL, resolveEmbeddingConfig } from "../../src/lib/llm/embedding-client";
import { embedHandoffNote } from "../../src/lib/memory/session-handoff-embed";
import type { LlmClient } from "../../src/lib/llm/client";

export const PAGE = 100;

export interface Args {
  userId: string;
  dryRun: boolean;
  limit: number | undefined;
}

export function parseArgs(argv: string[]): Args {
  let userId = "";
  let dryRun = false;
  let limit: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--user") userId = argv[++i] ?? "";
    else if (a === "--dry-run") dryRun = true;
    else if (a === "--limit") limit = Number(argv[++i]);
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!userId) throw new Error("--user <uuid> is required");
  if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) throw new Error("--limit must be a positive number");
  return { userId, dryRun, limit };
}

export interface BackfillSummary {
  found: number;
  embedded: number;
  failed: number;
}

/** Walks the user's un-embedded live handoff notes, oldest first, a page at a time. `llm` is only needed when not a dry run. */
export async function backfillHandoffEmbeddings(db: Db, llm: LlmClient | null, args: Args): Promise<BackfillSummary> {
  const summary: BackfillSummary = { found: 0, embedded: 0, failed: 0 };
  const seen = new Set<string>();
  for (;;) {
    const remaining = args.limit === undefined ? PAGE : Math.min(PAGE, args.limit - summary.found);
    if (remaining <= 0) break;
    const { data, error } = await db
      .from("session_memories")
      .select("id, text, created_at")
      .eq("user_id", args.userId)
      .eq("kind", "handoff")
      .is("retired_at", null)
      .is("embedding", null)
      .order("created_at", { ascending: true })
      .limit(remaining + seen.size);
    if (error) throw new Error(`handoff backfill: read failed: ${error.message}`);
    const rows = ((data ?? []) as { id: string; text: string }[]).filter((r) => !seen.has(r.id)).slice(0, remaining);
    if (rows.length === 0) break;
    for (const row of rows) {
      seen.add(row.id);
      summary.found++;
      if (args.dryRun || !llm) continue;
      const res = await embedHandoffNote(db, llm, args.userId, row.id, row.text);
      if (res.status === "embedded") summary.embedded++;
      else summary.failed++;
    }
  }
  return summary;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  let llm: LlmClient | null = null;
  if (!args.dryRun) {
    const cfg = resolveEmbeddingConfig(process.env);
    if (!isBundledEmbeddingConfig(cfg) && !isLocalModelBaseURL(cfg.baseURL)) throw new Error("refusing: the embedding provider is neither the bundled model nor a local base URL");
    const { createCostGuardedLlm } = await import("../../src/lib/llm/spend-ledger");
    // Embeddings only (local, $0); the cap is a backstop, no chat call is made.
    const guarded = await createCostGuardedLlm(getServiceClient(), args.userId, {
      runId: randomUUID(),
      bypassFeatureGate: true,
      capUsdOverride: 0.01,
    });
    if (!guarded.ok) throw new Error(`cost guard refused: ${JSON.stringify(guarded)}`);
    llm = guarded.llm;
  }
  const summary = await backfillHandoffEmbeddings(getServiceClient(), llm, args);
  console.log(JSON.stringify({ dryRun: args.dryRun, ...summary }));
  if (summary.failed > 0) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
