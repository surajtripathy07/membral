// One-off cleanup: retire preference/blocker memories that were extracted
// from a SUB-AGENT session's parent brief.
//
// A sub-agent session (code_sessions.parent_source_session_id set) stores the
// parent agent's brief as a role-"user" turn. Before tail-capture.ts learned
// this, extraction read that brief as the owner's voice and stored bogus
// preferences and open blockers from it. New extractions drop them; this
// script retires the ones already stored: every LIVE session_memories row of
// kind preference or blocker, turn_role 'user', whose code session is a
// sub-agent session. Rows are retired (retired_at = now, retire_reason =
// 'subagent_brief'), never deleted.
//
// usage (from apps/cloud):
//   npx tsx scripts/memory/retire-subagent-brief.ts [--user <uuid>] [--dry-run | --apply]
//
// --dry-run is the default: prints counts, writes nothing. --apply retires.
import { config } from "dotenv";

config({ path: ".env.local" });

interface Args {
  userId: string | undefined;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const i = argv.indexOf("--user");
  const apply = argv.includes("--apply");
  if (apply && argv.includes("--dry-run")) {
    console.error("usage: pass --dry-run or --apply, not both");
    process.exit(1);
  }
  return { userId: i >= 0 ? argv[i + 1] : undefined, apply };
}

/** Rows per retire update — keeps the `.in("id", …)` URL short. */
const RETIRE_CHUNK = 200;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { getServiceClient: getServiceSupabase } = await import("../../src/lib/db/clients");
  const { findSubagentBriefRows, retireRowsByIds, SUBAGENT_BRIEF_RETIRE_REASON } = await import(
    "../../src/lib/memory/write"
  );

  const supabase = getServiceSupabase();
  const rows = await findSubagentBriefRows(supabase, args.userId);
  const byKind = new Map<string, number>();
  const byUser = new Map<string, string[]>();
  for (const r of rows) {
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
    byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r.id]);
  }
  console.log(
    `[memory:retire-subagent-brief] ${args.apply ? "apply" : "dry-run"} user=${args.userId ?? "(all)"}: ` +
      `${rows.length} live row(s) to retire — preference=${byKind.get("preference") ?? 0} ` +
      `blocker=${byKind.get("blocker") ?? 0} across ${byUser.size} user(s)`,
  );
  if (!args.apply) return;

  let retired = 0;
  for (const [userId, ids] of byUser) {
    for (let i = 0; i < ids.length; i += RETIRE_CHUNK) {
      const { retiredIds } = await retireRowsByIds(
        supabase,
        userId,
        ids.slice(i, i + RETIRE_CHUNK),
        SUBAGENT_BRIEF_RETIRE_REASON,
      );
      retired += retiredIds.length;
    }
  }
  console.log(`[memory:retire-subagent-brief] retired ${retired} row(s) (retire_reason=${SUBAGENT_BRIEF_RETIRE_REASON})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
