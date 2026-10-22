// Backfill the Stage-1 code-session knowledge graph (ADR 0023 P2a) for one
// user, over whatever code_projects/code_sessions/code_session_turns are
// ALREADY in local Postgres. Zero LLM calls — see
// lib/code-sessions/code-graph.ts. Does NOT import sessions from disk (that's
// `membral sessions`); this only reads what's already imported and
// (re)builds code_kg_nodes/code_kg_edges from it.
import { config } from "dotenv";

config({ path: ".env.local" });

async function main(): Promise<void> {
  const { createClient } = await import("@supabase/supabase-js");
  const { buildCodeGraphForUser } = await import("../../src/lib/code-sessions/code-graph");

  const args = process.argv.slice(2);
  const idx = args.indexOf("--user-id");
  const userId = idx >= 0 ? args[idx + 1] : undefined;
  if (!userId) {
    console.error("usage: npm run code-kg:backfill --workspace=@membral/cloud -- --user-id <uuid>");
    process.exit(1);
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in apps/cloud/.env.local");
    process.exit(1);
  }
  const supabase = createClient(url, key);

  console.log(`[code-kg:backfill] building Stage-1 graph for ${userId}`);
  const results = await buildCodeGraphForUser(supabase, userId);

  const totals = results.reduce(
    (acc, r) => {
      acc.nodes += r.nodesWritten;
      acc.edges += r.edgesWritten;
      for (const [k, v] of Object.entries(r.nodeCountsByType)) acc.nodesByType[k] = (acc.nodesByType[k] ?? 0) + (v ?? 0);
      for (const [k, v] of Object.entries(r.edgeCountsByType)) acc.edgesByType[k] = (acc.edgesByType[k] ?? 0) + (v ?? 0);
      return acc;
    },
    { nodes: 0, edges: 0, nodesByType: {} as Record<string, number>, edgesByType: {} as Record<string, number> },
  );

  console.log(`\n=== Backfill complete: ${results.length} project(s) ===`);
  console.log(`nodes: ${totals.nodes}  edges: ${totals.edges}`);
  console.log("nodes by type:", JSON.stringify(totals.nodesByType, null, 2));
  console.log("edges by type:", JSON.stringify(totals.edgesByType, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
