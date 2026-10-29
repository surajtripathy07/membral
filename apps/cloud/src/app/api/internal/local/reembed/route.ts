// POST /api/internal/local/reembed — local stack only. `membral local reembed` calls this in a loop.
//
// Moves ONE batch of stored vectors to the embedding model this stack is configured with (see lib/local/reembed.ts for
// what is selected, which text is embedded per table, and how failures are handled).
//
// VISIBILITY: 404 unless local mode (MEMBRAL_LOCAL=1 and VERCEL unset). AUTH: same service-role bearer as provision.
// Query: batch (1-256, default 64), dry_run=1 (counts only, writes nothing), table + after (the cursor returned as
// `next` by the previous call; omit both to start from the top).
// 200: { table, done, failed, deferred, remaining_by_table, finished, next, family, dry_run, counts? }
//   `failed` rows were retired (their own text cannot be embedded); `deferred` rows hit a transient error and were left
//   untouched (a re-run picks them up). `remaining_by_table` is null except on the first call, a dry run and the last.
//   One call stops embedding after a time budget (4 minutes) and returns the cursor past what it tried.
// 409 { error: "no_embedder" } when no embedding provider is configured (not for dry_run).
// 429 { error: "rate_limited", retry_after_ms } + Retry-After when the provider rate-limits (nothing was written).
// 502 { error: "embedder_unavailable" } when nothing in the batch embedded (nothing was changed).
// 422 { error: "embedding_dimension", message } when the model's vectors are wider than the store's 1536 (nothing was written).
import { NextResponse } from "next/server";
import { withRoute } from "@/lib/api/route";
import { getServiceClient } from "@/lib/db/clients";
import { currentEmbeddingFamily } from "@/lib/llm/embedding-client";
import { isLocalMode } from "@/lib/local/mode";
import { REEMBED_TABLES, type ReembedCursor, type ReembedTable, reembedBatch } from "@/lib/local/reembed";
import { bearerMatches, serviceKey } from "@/lib/local/service-auth";
import { log } from "@/lib/log";
import { createDefaultUnitEmbedder } from "@/lib/memory/raw-units/embed";

export const dynamic = "force-dynamic";
// A batch of 256 through a CPU embedder can take a while.
export const maxDuration = 300;

export const POST = withRoute({ auth: { kind: "none" } }, async ({ req }) => {
  if (!isLocalMode()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const secret = serviceKey();
  if (!secret) return NextResponse.json({ error: "Not configured" }, { status: 503 });
  if (!bearerMatches(req.headers.get("authorization"), secret)) {
    log.warn("local_reembed: rejected — bad or missing bearer");
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = new URL(req.url).searchParams;
  const batchRaw = params.get("batch");
  const batch = batchRaw === null ? undefined : Number(batchRaw);
  if (batch !== undefined && (!Number.isInteger(batch) || batch < 1)) {
    return NextResponse.json({ error: "Invalid batch" }, { status: 400 });
  }
  const dryRun = params.get("dry_run") === "1";

  let cursor: ReembedCursor | null = null;
  const table = params.get("table");
  if (table !== null) {
    if (!(REEMBED_TABLES as readonly string[]).includes(table)) {
      return NextResponse.json({ error: "Invalid table" }, { status: 400 });
    }
    cursor = { table: table as ReembedTable, after: params.get("after") || null };
  }

  const embedder = createDefaultUnitEmbedder();
  const family = embedder?.family ?? currentEmbeddingFamily();
  const result = await reembedBatch(getServiceClient(), { family, embedder, batch, dryRun, cursor });

  if (result.ok) {
    if (!dryRun)
      log.info("local_reembed", {
        table: result.table,
        done: result.done,
        failed: result.failed,
        deferred: result.deferred,
      });
    return NextResponse.json(result);
  }
  switch (result.code) {
    case "no_embedder":
      return NextResponse.json({ error: "no_embedder", message: result.message }, { status: 409 });
    case "rate_limited": {
      const headers: Record<string, string> = {};
      if (result.retryAfterMs !== null) headers["Retry-After"] = String(Math.ceil(result.retryAfterMs / 1000));
      return NextResponse.json(
        { error: "rate_limited", message: result.message, retry_after_ms: result.retryAfterMs },
        { status: 429, headers },
      );
    }
    case "embedder_unavailable":
      return NextResponse.json({ error: "embedder_unavailable", message: result.message }, { status: 502 });
    case "embedding_dimension":
      return NextResponse.json({ error: "embedding_dimension", message: result.message }, { status: 422 });
    default:
      log.error("local_reembed: failed", { err: result.message });
      return NextResponse.json({ error: "Re-embed failed", message: result.message }, { status: 500 });
  }
});
