// Chunk backfill runner (goal step 11) — zero-LLM: writes conversation_chunks
// rows only (FTS is a generated column; embeddings are a separate, cost-guarded
// pass, opt-in below via --embed). Loops the paginated chunkMissingConversations
// until the corpus is covered; idempotent and resumable (already-covered
// conversations are skipped by the coverage scan).
//
// usage: npx tsx scripts/chunks-backfill.ts --user-id <uuid>            (chunk only, default)
//        npx tsx scripts/chunks-backfill.ts --user-id <uuid> --embed    (chunk, then drain the chunk-embedding backlog)
//
// --embed (MAJOR-1 fix, round-2 adversarial re-verification, 2026-07-26):
// added alongside the /api/sync + /api/import fix that lets embedMissingChunks
// run regardless of chunk-processed count — this flag gives the same drain a
// one-shot CLI path, for a corpus whose backlog is too large to fully drain
// via the fire-and-forget per-request calls alone. Requires OPENAI_API_KEY
// (embedMissingChunks needs it) — checked once, up front, so a missing key
// fails fast instead of after a full chunking pass.
import { config } from "dotenv";

config({ path: ".env.local" });

async function main(): Promise<void> {
  const { createClient } = await import("@supabase/supabase-js");
  const { chunkMissingConversations, embedMissingChunks } = await import("../src/lib/conversation-chunks");

  const args = process.argv.slice(2);
  const idx = args.indexOf("--user-id");
  const userId = idx >= 0 ? args[idx + 1] : undefined;
  if (!userId) {
    console.error("usage: npx tsx scripts/chunks-backfill.ts --user-id <uuid> [--embed]");
    process.exit(1);
  }
  const shouldEmbed = args.includes("--embed");
  if (shouldEmbed && !process.env.OPENAI_API_KEY) {
    console.error("--embed requires OPENAI_API_KEY to be set (apps/cloud/.env.local)");
    process.exit(1);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  const supabase = createClient(url, key);

  let total = 0;
  for (let round = 0; round < 200; round++) {
    const res = await chunkMissingConversations(supabase, userId, 50);
    total += res.processed;
    if (res.errors.length) console.log(`[round ${round}] errors (first 3):`, res.errors.slice(0, 3));
    console.log(`[round ${round}] processed=${res.processed} total=${total}`);
    if (res.processed === 0) break;
  }
  const { count } = await supabase
    .from("conversation_chunks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  console.log(`DONE total_processed=${total} chunk_rows=${count}`);

  if (!shouldEmbed) return;

  // Mirrors the chunking loop's shape above: repeat embedMissingChunks (which
  // rechecks the monthly cost ceiling and the #90 permanent-failure retirement
  // pattern internally — see that function's own doc comment) until a round
  // embeds zero rows, meaning either the backlog is fully drained or the
  // ceiling/failure gates stopped it — embedMissingChunks' own console.warn
  // makes that distinction visible without this script needing to re-derive it.
  let totalEmbedded = 0;
  for (let round = 0; round < 200; round++) {
    const res = await embedMissingChunks(supabase, userId, 50);
    totalEmbedded += res.processed;
    if (res.errors.length) console.log(`[embed round ${round}] errors (first 3):`, res.errors.slice(0, 3));
    console.log(`[embed round ${round}] embedded=${res.processed} total_embedded=${totalEmbedded}`);
    if (res.processed === 0) break;
  }
  const { count: embeddedCount } = await supabase
    .from("conversation_chunks")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .not("embedding", "is", null);
  console.log(`DONE total_embedded=${totalEmbedded} chunk_rows_with_embedding=${embeddedCount}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
