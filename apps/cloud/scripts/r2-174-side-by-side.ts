// R2 step 2.4 Step A (#174): side-by-side of the two newest-500 live-row scans in
// src/lib/memory/write/io.ts (dropCrossSessionDuplicates, supersedeRecords)
// against a full scan of the same rows. READ-ONLY: selects only, local DB only.
//
// usage (from apps/cloud):
//   npx tsx scripts/r2-174-side-by-side.ts [--env <path to .env.local>] [--pairs]
//
// --pairs: also prints each supersede miss as `new_id, old_id, cosine` (ids only, never text).
//
// Replay model: every live row R of a (user, project, kind) scope is treated
// as if it arrived again now. The real planners (planCrossSessionDedup via
// toLiveRows, planSupersede) run twice — once on the newest-500 window the
// production code reads, once on every live row of the scope — and the
// outcomes are compared. Scopes with <= 500 live rows are identical by
// construction and are only counted. Prints aggregate counts only.
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

const envIdx = process.argv.indexOf("--env");
config({ path: envIdx > 0 ? process.argv[envIdx + 1] : ".env.local" });

const WINDOW = 500;
const PAIRS = process.argv.includes("--pairs");

interface Row {
  id: string;
  user_id: string;
  code_project_id: string | null;
  code_session_id: string;
  kind: string;
  text: string;
  embedding: unknown;
  created_at: string;
  recurs_of: string | null;
}

interface KindStats {
  scopes: number;
  liveRows: number;
  scopesOver500: number;
  usersOver500: Set<string>;
  nullProjectRows: number;
  rowsReplayed: number;
  dedupMissed: number; // full scan dedups, window keeps
  recurrenceMissed: number; // full scan finds a recurrence root, window finds none
  recurrenceRootDiffers: number; // both find a root, different id
  supersedeMissed: number; // full scan links, window links nothing
  supersedeTargetDiffers: number; // both link, different target
  retireMissed: number; // full scan retires an exact duplicate the window cannot see
}

async function main(): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  })();
  if (host !== "127.0.0.1" && host !== "localhost") {
    console.error(`STOP: Supabase URL host is "${host}", not local. Refusing to run.`);
    process.exit(2);
  }
  if (!key) {
    console.error("STOP: SUPABASE_SERVICE_ROLE_KEY missing.");
    process.exit(2);
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  const { selectAllRows } = await import("../src/lib/util/pagination");
  const { planCrossSessionDedup, toLiveRows } = await import("../src/lib/memory/write/recurrence");
  const { planSupersede } = await import("../src/lib/memory/write/supersede");
  const { parseVector } = await import("../src/lib/llm/vector");
  const { cosineSimilarity } = await import("../src/lib/memory/embed");
  const pairs: Array<{ kind: string; newId: string; oldId: string; cosine: number | null }> = [];

  // Light pass: ids and scope keys of every live row, to size the scopes.
  const light = await selectAllRows<Pick<Row, "id" | "user_id" | "code_project_id" | "kind">>((from, to) =>
    supabase
      .from("session_memories")
      .select("id, user_id, code_project_id, kind")
      .is("retired_at", null)
      .order("id", { ascending: true })
      .range(from, to),
  );

  const stats = new Map<string, KindStats>();
  const statFor = (kind: string): KindStats => {
    let s = stats.get(kind);
    if (!s) {
      s = {
        scopes: 0,
        liveRows: 0,
        scopesOver500: 0,
        usersOver500: new Set(),
        nullProjectRows: 0,
        rowsReplayed: 0,
        dedupMissed: 0,
        recurrenceMissed: 0,
        recurrenceRootDiffers: 0,
        supersedeMissed: 0,
        supersedeTargetDiffers: 0,
        retireMissed: 0,
      };
      stats.set(kind, s);
    }
    return s;
  };

  const scopeSizes = new Map<string, { user: string; project: string; kind: string; n: number }>();
  for (const r of light) {
    const s = statFor(r.kind);
    s.liveRows++;
    if (r.code_project_id === null) {
      s.nullProjectRows++;
      continue;
    }
    const k = `${r.user_id}|${r.code_project_id}|${r.kind}`;
    const e = scopeSizes.get(k) ?? { user: r.user_id, project: r.code_project_id, kind: r.kind, n: 0 };
    e.n++;
    scopeSizes.set(k, e);
  }
  for (const e of scopeSizes.values()) {
    const s = statFor(e.kind);
    s.scopes++;
    if (e.n > WINDOW) {
      s.scopesOver500++;
      s.usersOver500.add(e.user);
    }
  }

  // Heavy pass: only scopes over the window can differ.
  for (const e of scopeSizes.values()) {
    if (e.n <= WINDOW) continue;
    const s = statFor(e.kind);
    // Same filters and order as both production scans, without the limit.
    const rows = await selectAllRows<Row>((from, to) =>
      supabase
        .from("session_memories")
        .select("id, user_id, code_project_id, code_session_id, kind, text, embedding, created_at, recurs_of")
        .eq("user_id", e.user)
        .eq("code_project_id", e.project)
        .eq("kind", e.kind)
        .is("retired_at", null)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, to),
    );
    const parsed = rows.map((r) => ({ ...r, vec: parseVector(r.embedding) }));

    for (let i = 0; i < parsed.length; i++) {
      const R = parsed[i];
      s.rowsReplayed++;
      const others = parsed.filter((_, j) => j !== i);
      const record = {
        kind: R.kind,
        text: R.text,
        embedding: R.vec.length > 0 ? R.vec : null,
        verified: true,
        retireReason: null,
        recursOfHint: null,
      } as unknown as Parameters<typeof planCrossSessionDedup>[0][number];

      // dropCrossSessionDuplicates: runs before insert, so R is not in the read.
      const dedup = (fetched: typeof others) => {
        const { rows: live, ids } = toLiveRows(
          fetched.map((o) => ({ ...o, embedding: o.vec })),
          R.code_session_id,
        );
        return planCrossSessionDedup([record], new Map([[R.kind, live]]), new Set(ids));
      };
      const dw = dedup(others.slice(0, WINDOW));
      const df = dedup(others);
      if (df.deduped > 0 && dw.deduped === 0) s.dedupMissed++;
      else if (df.deduped === 0 && dw.deduped === 0) {
        const rw = (dw.kept[0] as { recursOf?: string } | undefined)?.recursOf;
        const rf = (df.kept[0] as { recursOf?: string } | undefined)?.recursOf;
        if (rf && !rw) s.recurrenceMissed++;
        else if (rf && rw && rf !== rw) s.recurrenceRootDiffers++;
      }

      // supersedeRecords: runs after insert, so R is the newest row of the read.
      const newRec = [{ id: R.id, text: R.text, embedding: R.vec.length > 0 ? R.vec : null }];
      const toLive = (xs: typeof others) => xs.map((o) => ({ id: o.id, text: o.text, embedding: o.vec }));
      const sw = planSupersede(newRec, [{ id: R.id, text: R.text, embedding: R.vec }, ...toLive(others.slice(0, WINDOW - 1))]);
      const sf = planSupersede(newRec, toLive(others));
      const lw = sw.links[0]?.supersedes;
      const lf = sf.links[0]?.supersedes;
      if (lf && !lw) {
        s.supersedeMissed++;
        const old = parsed.find((o) => o.id === lf);
        const cosine = old && R.vec.length > 0 && old.vec.length > 0 ? cosineSimilarity(R.vec, old.vec) : null;
        pairs.push({ kind: R.kind, newId: R.id, oldId: lf, cosine });
      }
      else if (lf && lw && lf !== lw) s.supersedeTargetDiffers++;
      if (sf.retireIds.length > sw.retireIds.length) s.retireMissed++;
    }
  }

  const allUsers = new Set(light.map((r) => r.user_id));
  console.log(`live rows: ${light.length}  users: ${allUsers.size}  scopes (user,project,kind): ${scopeSizes.size}`);
  console.log(
    "kind        live  nullProj scopes >500scopes >500users replayed dedupMiss recurMiss recurDiff supMiss supDiff retireMiss",
  );
  for (const [kind, s] of [...stats.entries()].sort()) {
    console.log(
      [
        kind.padEnd(10),
        String(s.liveRows).padStart(5),
        String(s.nullProjectRows).padStart(9),
        String(s.scopes).padStart(6),
        String(s.scopesOver500).padStart(10),
        String(s.usersOver500.size).padStart(9),
        String(s.rowsReplayed).padStart(8),
        String(s.dedupMissed).padStart(9),
        String(s.recurrenceMissed).padStart(9),
        String(s.recurrenceRootDiffers).padStart(9),
        String(s.supersedeMissed).padStart(7),
        String(s.supersedeTargetDiffers).padStart(7),
        String(s.retireMissed).padStart(10),
      ].join(" "),
    );
  }
  if (PAIRS) {
    console.log("\nsupersede misses (kind, new_id, old_id, cosine):");
    for (const p of pairs) console.log(`${p.kind}, ${p.newId}, ${p.oldId}, ${p.cosine === null ? "text-dup" : p.cosine.toFixed(4)}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
