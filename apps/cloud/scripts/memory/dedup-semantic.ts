// One-off cleanup: retire LIVE session memories that a NEWER live memory
// restates (semantic duplicates stored before write-time dedup existed).
//
// Same rule as the write path (write.ts mergeSemanticDuplicates): Postgres
// finds the pairs (`memory_semantic_duplicates`, migration 101 — same user,
// kind, scope and, for 'project' scope, project; kind in SEMANTIC_DEDUP_KINDS,
// never 'outcome'; cosine >= --min-sim); pairs are grouped into clusters and
// only the NEWEST row of each survives (planSemanticMerges). Retired rows get
// retire_reason 'semantic_duplicate' and a memory_merges row (source
// 'cleanup'); the survivor's `supersedes` is set to its best match only when
// still null. Rows are retired, never deleted.
//
// usage (from apps/cloud):
//   npm run memory:dedup -- [--user <uuid>] [--min-sim 0.80] [--dry-run | --apply]
//
// --dry-run is the default: prints every planned merge (sorted by sim, both
// texts, kinds, dates) and per-kind counts, writes nothing. --apply retires,
// logs, and prints the undo SQL.
import { config } from "dotenv";

config({ path: ".env.local" });

interface Args {
  userId: string | undefined;
  minSim: number | undefined;
  apply: boolean;
}

function parseArgs(argv: string[]): Args {
  const apply = argv.includes("--apply");
  if (apply && argv.includes("--dry-run")) {
    console.error("usage: pass --dry-run or --apply, not both");
    process.exit(1);
  }
  const u = argv.indexOf("--user");
  const m = argv.indexOf("--min-sim");
  const minSim = m >= 0 ? Number.parseFloat(argv[m + 1] ?? "") : undefined;
  if (minSim !== undefined && !(minSim > 0 && minSim <= 1)) {
    console.error("usage: --min-sim takes a number in (0, 1]");
    process.exit(1);
  }
  return { userId: u >= 0 ? argv[u + 1] : undefined, minSim, apply };
}

interface MemoryRow {
  id: string;
  kind: string;
  scope: string;
  text: string;
  created_at: string;
}

const ID_CHUNK = 200;

function sqlIds(ids: string[]): string {
  return ids.map((id) => `'${id}'`).join(", ");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { getServiceClient: getServiceSupabase } = await import("../../src/lib/db/clients");
  const { selectAllRows } = await import("../../src/lib/util/pagination");
  const {
    applySemanticDuplicates,
    planSemanticMerges,
    SEMANTIC_DUPLICATE_RETIRE_REASON,
    semanticDedupKinds,
    semanticDedupMinSim,
  } = await import("../../src/lib/memory/write");
  type Pair = import("../../src/lib/memory/write").SemanticDuplicatePair;

  const supabase = getServiceSupabase();
  const minSim = args.minSim ?? semanticDedupMinSim();
  if (minSim === null) {
    console.error("[memory:dedup] the current embedding model has no calibrated semantic-dedup cut; nothing to do");
    process.exit(1);
  }
  const kinds = semanticDedupKinds();

  let userIds: string[];
  if (args.userId) {
    userIds = [args.userId];
  } else {
    const profiles = await selectAllRows<{ id: string }>((from, to) =>
      supabase.from("profiles").select("id").order("id").range(from, to),
    );
    userIds = profiles.map((p) => p.id);
  }

  const tag = `[memory:dedup] ${args.apply ? "apply" : "dry-run"} min_sim=${minSim} kinds=${kinds.join(",")}`;
  for (const userId of userIds) {
    const pairs = await selectAllRows<Pair>((from, to) =>
      supabase
        .rpc("memory_semantic_duplicates", { p_user: userId, p_record_ids: null, p_min_sim: minSim, p_kinds: kinds })
        .range(from, to),
    );
    if (pairs.length === 0) {
      console.log(`${tag} user=${userId}: 0 pairs`);
      continue;
    }

    const ids = [...new Set(pairs.flatMap((p) => [p.new_id, p.existing_id]))];
    const rows = new Map<string, MemoryRow>();
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const { data, error } = await supabase
        .from("session_memories")
        .select("id, kind, scope, text, created_at")
        .eq("user_id", userId)
        .in("id", ids.slice(i, i + ID_CHUNK));
      if (error) throw new Error(error.message);
      for (const r of (data ?? []) as MemoryRow[]) rows.set(r.id, r);
    }

    const { merges } = planSemanticMerges(pairs);
    const clusters = new Set(merges.map((m) => m.kept_id));
    const perKind = new Map<string, { clusters: Set<string>; retire: number }>();
    for (const m of merges) {
      const k = perKind.get(m.kind) ?? { clusters: new Set<string>(), retire: 0 };
      k.clusters.add(m.kept_id);
      k.retire += 1;
      perKind.set(m.kind, k);
    }
    console.log(
      `${tag} user=${userId}: ${pairs.length} pair(s), ${clusters.size} cluster(s), ${merges.length} row(s) to retire`,
    );
    for (const [kind, k] of [...perKind].sort()) {
      console.log(`  ${kind}: ${k.clusters.size} cluster(s), ${k.retire} to retire`);
    }
    for (const m of [...merges].sort((a, b) => b.sim - a.sim)) {
      const n = rows.get(m.kept_id);
      const e = rows.get(m.retired_id);
      console.log(`\n  sim=${m.sim.toFixed(3)} ${n?.kind ?? "?"}/${n?.scope ?? "?"}`);
      console.log(`    keep   ${m.kept_id} ${n?.created_at ?? "?"}  ${n?.text ?? "?"}`);
      console.log(`    retire ${m.retired_id} ${e?.created_at ?? "?"}  ${e?.text ?? "?"}`);
    }

    if (!args.apply) continue;
    const { retiredIds, linkedIds } = await applySemanticDuplicates(supabase, userId, pairs, "cleanup");
    console.log(`\n${tag} user=${userId}: retired ${retiredIds.length}, linked supersedes on ${linkedIds.length}`);
    console.log("-- undo:");
    if (retiredIds.length > 0) {
      console.log(
        `update public.session_memories set retired_at = null, retire_reason = null ` +
          `where user_id = '${userId}' and retire_reason = '${SEMANTIC_DUPLICATE_RETIRE_REASON}' ` +
          `and id in (${sqlIds(retiredIds)});`,
      );
      console.log(
        `delete from public.memory_merges where user_id = '${userId}' and source = 'cleanup' ` +
          `and retired_id in (${sqlIds(retiredIds)});`,
      );
    }
    if (linkedIds.length > 0) {
      console.log(
        `update public.session_memories set supersedes = null where user_id = '${userId}' and id in (${sqlIds(linkedIds)});`,
      );
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
