// W3 D9 backfill (docs/design/observed-forge-refs.md §5): fill
// code_session_forge_refs for sessions whose props.forge_refs_version is
// missing or older than FORGE_REFS_VERSION. Deterministic, no LLM, no spend.
//
// usage (from apps/cloud):
//   npx tsx scripts/backfill-forge-refs.ts [--user <uuid>] [--since <iso>]
//     [--limit N] [--after <session uuid>] [--dry-run] [--force]
//
// RUNBOOK
//   1. Apply migration 115 before deploying the importer that calls its
//      5-argument import_code_session_turns overload.
//   2. After deploy: run this script (no --force) to fill older sessions.
//   3. After a rollback and re-deploy (sessions imported meanwhile by the old
//      importer carry stale rows or a stale version stamp): run it with
//      --force over the affected window (--since) to re-fill every session.
//
// Sessions newest first (started_at desc, id desc). --after resumes after the
// session id a previous run printed. --force re-fills sessions that already
// carry the current version. Each session's turns are read in pages of 1000
// (PostgREST's row cap) with an explicit user_id filter; its rows are written
// by replace_code_session_forge_refs (migration 115) under the session-row
// lock, and only if the session's content_hash and turn ids are what this
// script read (otherwise "skipped": a concurrent import won). Re-run safe.
// SIGINT stops after the current session and prints its id for --after.
import { config } from "dotenv";

config({ path: ".env.local", quiet: true });

interface Args {
  userId?: string;
  since?: string;
  limit: number;
  after?: string;
  dryRun: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { limit: 200, dryRun: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === "--user") args.userId = next();
    else if (a === "--since") args.since = new Date(next()).toISOString();
    else if (a === "--limit") args.limit = Math.max(1, Number.parseInt(next(), 10));
    else if (a === "--after") args.after = next();
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--force") args.force = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

interface SessionRow {
  id: string;
  user_id: string;
  started_at: string;
  content_hash: string;
  props: Record<string, unknown> | null;
  code_projects: { repo_identity: string | null } | null;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { getServiceClient: getServiceSupabase } = await import("../src/lib/db/clients");
  const { FORGE_REFS_VERSION, refillSessionForgeRefs, userProjectIdentities } = await import(
    "../src/lib/code-sessions/forge-refs"
  );
  const supabase = getServiceSupabase();

  let stop = false;
  process.on("SIGINT", () => {
    stop = true;
  });

  // Skip forward past --after in the newest-first order.
  let cursor: { started_at: string; id: string } | null = null;
  if (args.after) {
    const res = await supabase.from("code_sessions").select("id, started_at").eq("id", args.after).maybeSingle();
    if (res.error || !res.data) throw new Error(`--after session ${args.after} not found`);
    cursor = res.data as { started_at: string; id: string };
  }

  const identitiesByUser = new Map<string, string[]>();
  let scanned = 0;
  let changed = 0;
  let rowsWritten = 0;
  let skipped = 0;
  let last: string | null = null;
  const PAGE = 200;

  while (!stop && changed < args.limit) {
    let q = supabase
      .from("code_sessions")
      .select("id, user_id, started_at, content_hash, props, code_projects(repo_identity)")
      .order("started_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(PAGE);
    if (args.userId) q = q.eq("user_id", args.userId);
    if (args.since) q = q.gte("started_at", args.since);
    if (cursor)
      q = q.or(`started_at.lt.${cursor.started_at},and(started_at.eq.${cursor.started_at},id.lt.${cursor.id})`);
    const page = await q;
    if (page.error) throw new Error(`session page failed: ${page.error.message}`);
    const sessions = (page.data ?? []) as unknown as SessionRow[];
    if (sessions.length === 0) break;

    for (const s of sessions) {
      cursor = { started_at: s.started_at, id: s.id };
      scanned++;
      const version = Number(s.props?.forge_refs_version ?? 0);
      if (!args.force && Number.isFinite(version) && version >= FORGE_REFS_VERSION) continue;

      let identities = identitiesByUser.get(s.user_id);
      if (!identities) {
        identities = await userProjectIdentities(supabase, s.user_id);
        identitiesByUser.set(s.user_id, identities);
      }
      const result = await refillSessionForgeRefs(
        supabase,
        {
          id: s.id,
          user_id: s.user_id,
          started_at: s.started_at,
          content_hash: s.content_hash,
          projectIdentity: s.code_projects?.repo_identity ?? null,
        },
        identities,
        { dryRun: args.dryRun },
      );
      if (result.status === "skipped") {
        skipped++;
        console.log(JSON.stringify({ session_id: s.id, skipped: true }));
        continue;
      }
      changed++;
      rowsWritten += result.rows;
      last = s.id;
      console.log(JSON.stringify({ session_id: s.id, rows: result.rows, dry_run: args.dryRun }));
      if (stop || changed >= args.limit) break;
    }
    if (sessions.length < PAGE) break;
  }

  console.log(
    JSON.stringify({
      summary: true,
      dry_run: args.dryRun,
      scanned,
      force: args.force,
      sessions_changed: changed,
      sessions_skipped: skipped,
      rows: rowsWritten,
      stopped: stop,
      resume_after: stop ? last : null,
    }),
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
