// Graph snapshot + census (bead membral-fwz).
//
// Queries the kg_* tables for the demo user and writes graph-snapshot.json
// (areas -> items -> conversations -> entities tree) plus a census to stdout.
// This is the eyeball-gate artifact while /map and /pulse still read the old
// spike schema (membral-859). The snapshot builder lives in lib.ts (also used
// by the multi-scale sweep, membral-b8w).
//
// Run from the repo root:
//   npx tsx fixtures/persona/snapshot.ts [--user-id <uuid>]
// Without --user-id it resolves the demo user by DEMO_EMAIL (tusk-demo@membral.demo).

import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import { buildSnapshot, countConvs, countItems, DEFAULT_DEMO_EMAIL, getServiceClient } from "./lib";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEMO_EMAIL = process.env.DEMO_EMAIL ?? DEFAULT_DEMO_EMAIL;
const OUT_FILE = resolve(HERE, "graph-snapshot.json");

async function resolveUserId(supabase: SupabaseClient): Promise<string> {
  const idx = process.argv.indexOf("--user-id");
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const { data, error } = await supabase.from("profiles").select("id").eq("email", DEMO_EMAIL).single();
  if (error || !data) throw new Error(`could not resolve ${DEMO_EMAIL}: ${error?.message}`);
  return (data as { id: string }).id;
}

async function main(): Promise<void> {
  const supabase = getServiceClient();
  const userId = await resolveUserId(supabase);

  const snapshot = await buildSnapshot(supabase, userId, DEMO_EMAIL);
  writeFileSync(OUT_FILE, `${JSON.stringify(snapshot, null, 2)}\n`);

  // ---- census to stdout ----
  console.log(`\n=== Census for ${DEMO_EMAIL} (${userId}) ===`);
  console.log(`nodes: ${JSON.stringify(snapshot.stats.nodesByType)}`);
  console.log(`edges: ${JSON.stringify(snapshot.stats.edgesByType)}`);
  console.log(`\nLifeAreas: ${snapshot.life_areas.length}`);
  for (const la of snapshot.life_areas) {
    console.log(`  - ${la.label}: ${countItems(la)} items, ${countConvs(la)} conversations`);
  }
  console.log(`\norphans: ${snapshot.orphans.length}`);
  console.log(`entities: ${snapshot.entities.length} (top 15 by mentions)`);
  for (const e of snapshot.entities.slice(0, 15)) console.log(`  - ${e.label} [${e.type}] x${e.mentions}`);
  console.log(`\nsnapshot written to ${OUT_FILE}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
