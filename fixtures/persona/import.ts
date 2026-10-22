// Persona corpus importer (bead membral-fwz).
//
// Creates (or finds) the demo auth user and upserts every corpus/*.json
// conversation for that user — the same rows and conflict target as
// apps/cloud/src/app/api/import/route.ts, minus the auth/extraction wiring
// (the KG bootstrap is run separately). Re-runnable: upsert is idempotent.
// Shared logic lives in lib.ts (also used by snapshot.ts and sweep.ts).
//
// Run from the repo root:
//   npx tsx fixtures/persona/import.ts
// Optional: DEMO_EMAIL overrides the default tusk-demo@membral.demo.

import { DEFAULT_DEMO_EMAIL, ensureUser, getServiceClient, importConversations, loadCorpus } from "./lib";

const DEMO_EMAIL = process.env.DEMO_EMAIL ?? DEFAULT_DEMO_EMAIL;

async function main(): Promise<void> {
  const supabase = getServiceClient();
  const userId = await ensureUser(supabase, DEMO_EMAIL);

  const valid = loadCorpus();
  const imported = await importConversations(supabase, userId, valid);

  const { count } = await supabase
    .from("conversations")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId);
  console.log(`\n[import] done: ${imported} upserted, ${count} total conversations for ${DEMO_EMAIL} (${userId})`);
  console.log(`[import] next: npm run kg:bootstrap --workspace=@membral/cloud -- --user-id ${userId}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
