// Lists recent semantic-dedup merges (memory_merges, migration 101): which
// memory was kept, which was retired, their similarity, kind, and source
// ('write' = extraction time, 'cleanup' = scripts/memory/dedup-semantic.ts).
//
// usage (from apps/cloud):
//   npm run memory:merged -- [--user <email|uuid>] [--days 7] [--limit 50]
import type { SupabaseClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: ".env.local" });

const TEXT_MAX = 140;
const ID_CHUNK = 200;

interface Args {
  user: string | undefined;
  days: number;
  limit: number;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const days = Number(get("--days") ?? 7);
  const limit = Number(get("--limit") ?? 50);
  if (!Number.isInteger(days) || days < 1) {
    console.error("--days must be a whole number >= 1");
    process.exit(1);
  }
  if (!Number.isInteger(limit) || limit < 1) {
    console.error("--limit must be a whole number >= 1");
    process.exit(1);
  }
  return { user: get("--user"), days, limit };
}

async function resolveUserId(supabase: SupabaseClient, user: string): Promise<string> {
  if (!user.includes("@")) return user;
  const { data: profile } = await supabase.from("profiles").select("id").ilike("email", user).maybeSingle();
  if (profile?.id) return profile.id as string;
  for (let page = 1; page <= 20; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage: 200 });
    if (error) break;
    const match = data.users.find((u) => u.email?.toLowerCase() === user.toLowerCase());
    if (match) return match.id;
    if (data.users.length < 200) break;
  }
  console.error(`No user found for email ${user}`);
  process.exit(1);
}

function truncate(text: string | undefined): string {
  const t = (text ?? "?").replace(/\s+/g, " ").trim();
  return t.length > TEXT_MAX ? `${t.slice(0, TEXT_MAX - 1)}…` : t;
}

interface MergeRow {
  user_id: string;
  kept_id: string;
  retired_id: string;
  sim: number;
  kind: string;
  merged_at: string;
  source: string;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { getServiceClient: getServiceSupabase } = await import("../../src/lib/db/clients");
  const supabase = getServiceSupabase();
  const userId = args.user ? await resolveUserId(supabase, args.user) : undefined;
  const sinceIso = new Date(Date.now() - args.days * 86_400_000).toISOString();

  let q = supabase
    .from("memory_merges")
    .select("user_id, kept_id, retired_id, sim, kind, merged_at, source")
    .gte("merged_at", sinceIso)
    .order("merged_at", { ascending: false })
    .limit(args.limit);
  if (userId) q = q.eq("user_id", userId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const merges = (data ?? []) as MergeRow[];

  const ids = [...new Set(merges.flatMap((m) => [m.kept_id, m.retired_id]))];
  const texts = new Map<string, string>();
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const { data: rows, error: e } = await supabase
      .from("session_memories")
      .select("id, text")
      .in("id", ids.slice(i, i + ID_CHUNK));
    if (e) throw new Error(e.message);
    for (const r of (rows ?? []) as Array<{ id: string; text: string }>) texts.set(r.id, r.text);
  }

  console.log(
    `[memory:merged] ${merges.length} merge(s) in the last ${args.days} day(s)` +
      `${userId ? ` for user ${userId}` : ""} (limit ${args.limit})`,
  );
  for (const m of merges) {
    console.log(`\n  ${m.merged_at.slice(0, 19).replace("T", " ")}  sim=${Number(m.sim).toFixed(3)}  ${m.kind}  (${m.source})`);
    console.log(`    kept    ${truncate(texts.get(m.kept_id))}`);
    console.log(`    retired ${truncate(texts.get(m.retired_id))}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
