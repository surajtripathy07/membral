// L1 write-time reconciliation, backfill tool (docs/design/current-truth-recall.md, gates/fable-l1-design.md).
//
// usage (from apps/cloud), bench store only:
//   MEMBRAL_BENCH_EXPECTED_SUPABASE_HOST=127.0.0.1:54521 NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54521 \
//   SUPABASE_SERVICE_ROLE_KEY=... MEMBRAL_LOCAL=1 MEMBRAL_LLM_PROVIDER=claude-code MEMBRAL_MODEL=sonnet \
//   CLAUDE_CODE_OAUTH_TOKEN=... npx tsx scripts/memory/reconcile.ts --user <uuid> [--dry-run] [--since 30d]
//     [--project <uuid>] [--limit-records N] [--max-calls 800] [--no-llm] [--bench <bench.json>] [--out <dir>]
//
// Dry-run is the default and the only mode that runs unless `--apply --dump <file>` is also given. A dry-run never
// touches session_memories (it asserts superseded_by/valid_to row counts are unchanged); it stores each judged pair in
// memory_links as a memo (hiding proposals with verified=false, abstentions as 'unrelated') through the rpc with an EMPTY
// projection list, so a rerun skips judged pairs. It is resumable: with a stable `--out <dir>` the dir keeps state.json
// (run id, cumulative calls) and links.jsonl (proposed links); --max-calls is cumulative over the dir. It writes
// <out>/{plan.json, undo.sql, apply.sql, verdicts.json, shortlist-recall.json, state.json, links.jsonl}. Guards, always on: the Supabase URL host:port must equal MEMBRAL_BENCH_EXPECTED_SUPABASE_HOST;
// the plan aborts when it hides more than 10% of the live records in scope or more than 400; the LLM is capped by
// --max-calls (default 800) and is the local claude-code provider only (never hosted, D-072). --apply additionally
// needs a fresh (under 2 h) plain or .gz pg_dump of this store that ends with `RESET ALL;` or pg_dump's `\\unrestrict <token>` line, the kicker stopped, and the
// bench stack's psql container (MEMBRAL_BENCH_DB_CONTAINER) seeing the same live-row count as the API.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { config } from "dotenv";

config({ path: ".env.local" });

type PlannedLinkT = import("../../src/lib/memory/reconcile/plan").PlannedLink;

interface Args {
  userId: string;
  apply: boolean;
  dump: string | undefined;
  sinceDays: number | undefined;
  project: string | null;
  limitRecords: number | undefined;
  maxCalls: number;
  noLlm: boolean;
  bench: string | undefined;
  out: string | undefined;
}

function fail(msg: string): never {
  console.error(`[reconcile] ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]): Args {
  const val = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const userId = val("--user");
  if (!userId) fail("usage: --user <uuid> is required");
  const apply = argv.includes("--apply");
  if (apply && argv.includes("--dry-run")) fail("pass --dry-run or --apply, not both");
  const since = val("--since");
  let sinceDays: number | undefined;
  if (since) {
    const m = /^(\d+)d$/.exec(since);
    if (!m) fail("--since takes Nd, e.g. 30d");
    sinceDays = Number(m[1]);
  }
  const maxCalls = Number(val("--max-calls") ?? 800);
  if (!Number.isFinite(maxCalls) || maxCalls < 0) fail("--max-calls takes a non-negative number");
  const limit = val("--limit-records");
  return {
    userId,
    apply,
    dump: val("--dump"),
    sinceDays,
    project: val("--project") ?? null,
    limitRecords: limit ? Number(limit) : undefined,
    maxCalls,
    noLlm: argv.includes("--no-llm"),
    bench: val("--bench"),
    out: val("--out"),
  };
}

function hostPort(u: string | undefined): string | null {
  try {
    return u ? new URL(u).host : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { providerProblem, storeProblem } = await import("../../src/lib/memory/reconcile/guards");
  const envHost = hostPort(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const refusal =
    storeProblem(envHost, process.env.MEMBRAL_BENCH_EXPECTED_SUPABASE_HOST) ?? providerProblem(process.env, args.noLlm);
  if (refusal) fail(`refusing: ${refusal}`);
  process.env.MEMBRAL_MODEL = process.env.MEMBRAL_MODEL?.trim() || "sonnet";

  const { RECONCILE_PROMPT_VERSION } = await import("../../src/lib/memory/reconcile/verdict");
  const { getServiceClient: getServiceSupabase } = await import("../../src/lib/db/clients");
  const { LlmClient } = await import("../../src/lib/llm/client");
  const { resolveModelConfig } = await import("../../src/lib/llm/config");
  const { propose } = await import("../../src/lib/memory/reconcile/engine");
  const { supabaseSource, readMemo, hybridFailures, writeDryRunMemo } = await import(
    "../../src/lib/memory/reconcile/io"
  );
  const { applySql, capCheckScoped, projectionFor, undoSql } = await import("../../src/lib/memory/reconcile/plan");
  const supabase = getServiceSupabase();
  const freshRunId = `l1-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12)}-${randomUUID().slice(0, 6)}`;
  const outDir = resolve(args.out ?? join("..", "..", "scripts", "eval", "recall-precision", "runs", freshRunId));
  mkdirSync(outDir, { recursive: true });
  // Resume state of a stable --out dir: the run id, calls already spent, and links already proposed (this prompt version).
  const statePath = join(outDir, "state.json");
  const linksPath = join(outDir, "links.jsonl");
  const state: { run_id: string; calls: number; cost_usd: number; retries: number; prompt_version: string } = existsSync(statePath)
    ? JSON.parse(readFileSync(statePath, "utf8"))
    : { run_id: freshRunId, calls: 0, cost_usd: 0, retries: 0, prompt_version: RECONCILE_PROMPT_VERSION };
  if (!Number.isFinite(state.calls) || state.calls < 0) fail(`${statePath} has no valid calls count; fix or remove it`);
  if (state.prompt_version !== RECONCILE_PROMPT_VERSION) fail(`${outDir} holds a ${state.prompt_version} run; use a new --out`);
  const runId = state.run_id;
  const priorLinks: PlannedLinkT[] = existsSync(linksPath)
    ? readFileSync(linksPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as PlannedLinkT)
    : [];
  const priorKeys = new Set(priorLinks.map((l) => `${l.from_id}|${l.to_id}`));
  const projectionRowCount = async (): Promise<number> => {
    const { count, error } = await supabase
      .from("session_memories")
      .select("id", { count: "exact", head: true })
      .eq("user_id", args.userId)
      .or("superseded_by.not.is.null,valid_to.not.is.null");
    if (error) fail(`projection count failed: ${error.message}`);
    return count ?? 0;
  };
  const projectionBefore = args.apply ? null : await projectionRowCount();

  const src = supabaseSource(supabase, args.userId, args.project);
  const seen = await readMemo(supabase, args.userId);
  const llm = args.noLlm ? null : new LlmClient(resolveModelConfig(), { capUsd: 1 });
  const sinceMs = args.sinceDays ? Date.now() - args.sinceDays * 86_400_000 : undefined;

  // 1. Shortlist recall on the labelled paraphrase groups (no LLM, no writes).
  let recall: Record<string, unknown> | null = null;
  if (args.bench) {
    const bench = JSON.parse(readFileSync(args.bench, "utf8")) as {
      queries: Array<{ split: string; paraphrase_groups?: string[][] }>;
    };
    const pairs = new Map<string, { a: string; b: string; split: string }>();
    for (const q of bench.queries) {
      for (const g of q.paraphrase_groups ?? []) {
        for (let i = 0; i < g.length; i++)
          for (let j = i + 1; j < g.length; j++) {
            const [a, b] = g[i] < g[j] ? [g[i], g[j]] : [g[j], g[i]];
            if (!pairs.has(`${a}|${b}`)) pairs.set(`${a}|${b}`, { a, b, split: q.split });
          }
      }
    }
    const { orientPair } = await import("../../src/lib/memory/reconcile/verdict");
    const rows = await src.scope();
    const starts = await src.sessionStarts([...new Set(rows.map((r) => r.code_session_id))]);
    const byId = new Map(rows.map((r) => [r.id, { ...r, sessionStart: starts.get(r.code_session_id) }] as const));
    const newerIds = new Set<string>();
    const oriented: Array<{ from: string; to: string; split: string }> = [];
    const tally = { total: pairs.size, not_live: 0, unorderable: 0, cross_kind: 0, linkable: 0, hit: 0 };
    const missed: Array<{ from: string; to: string }> = [];
    for (const p of pairs.values()) {
      const a = byId.get(p.a);
      const b = byId.get(p.b);
      if (!a || !b) {
        tally.not_live++;
        continue;
      }
      const o = orientPair(a, b);
      if (!o) {
        tally.unorderable++;
        continue;
      }
      if (o.from.kind !== o.to.kind) {
        tally.cross_kind++;
        continue;
      }
      tally.linkable++;
      newerIds.add(o.from.id);
      oriented.push({ from: o.from.id, to: o.to.id, split: p.split });
    }
    const res = await propose(src, null, { maxCalls: 0, conversationId: runId, onlyIds: newerIds });
    const bySplit: Record<string, { n: number; hit: number }> = {};
    for (const o of oriented) {
      const hit = res.shortlists.get(o.from)?.some((c) => c.id === o.to) ?? false;
      bySplit[o.split] ??= { n: 0, hit: 0 };
      bySplit[o.split].n++;
      if (hit) {
        tally.hit++;
        bySplit[o.split].hit++;
      } else missed.push({ from: o.from, to: o.to });
    }
    recall = { ...tally, recall: tally.linkable ? tally.hit / tally.linkable : null, by_split: bySplit, missed: missed.slice(0, 50) };
    writeFileSync(join(outDir, "shortlist-recall.json"), `${JSON.stringify(recall, null, 1)}\n`);
    console.log(JSON.stringify({ shortlist_recall: recall && { ...recall, missed: undefined } }));
  }

  // 2. The plan.
  const baseCalls = state.calls;
  const baseCost = state.cost_usd;
  const baseRetries = state.retries;
  const model0 = llm ? `claude-code/${process.env.MEMBRAL_MODEL ?? "default"}` : "none";
  const res = await propose(src, llm, {
    sinceMs,
    limitRecords: args.limitRecords,
    maxCalls: Math.max(0, args.maxCalls - baseCalls),
    conversationId: runId,
    seen,
    onJudged: async (batch, totals) => {
      const fresh = batch.flatMap((b) => (b.link && !priorKeys.has(`${b.from_id}|${b.to_id}`) ? [b.link] : []));
      if (fresh.length > 0) appendFileSync(linksPath, `${fresh.map((l) => JSON.stringify(l)).join("\n")}\n`);
      // Spend so far survives a crash: --max-calls is cumulative over the out dir.
      writeFileSync(statePath, `${JSON.stringify({ ...state, calls: baseCalls + totals.calls, cost_usd: baseCost + totals.costUsd, retries: baseRetries + totals.retries })}\n`);
      // Dry-run memo (DB): resumable. Never a projection. Apply plans its own memo inside apply.sql.
      if (!args.apply)
        await writeDryRunMemo(
          supabase,
          args.userId,
          { runId, model: model0, promptVersion: RECONCILE_PROMPT_VERSION },
          batch.map((b) => ({ ...b, link: b.link && { quote: b.link.quote, turn_idx: b.link.turn_idx } })),
        );
    },
  });
  state.calls = baseCalls + res.calls;
  state.cost_usd = baseCost + res.costUsd;
  state.retries = baseRetries + res.retries;
  writeFileSync(statePath, `${JSON.stringify(state)}\n`);
  // Links from earlier invocations of this out dir join this invocation's (same pair never twice).
  const thisKeys = new Set(res.links.map((l) => `${l.from_id}|${l.to_id}`));
  const links = [...priorLinks.filter((l) => !thisKeys.has(`${l.from_id}|${l.to_id}`)), ...res.links];
  const projectionAfter = args.apply ? null : await projectionRowCount();
  if (projectionBefore !== projectionAfter) fail(`a dry-run changed projection rows (${projectionBefore} -> ${projectionAfter})`);
  const projections = projectionFor(links);
  const cap = capCheckScoped(projections, res.liveByProject, args.sinceDays ? res.recordsConsidered : undefined);
  const model = model0;
  const byRelation: Record<string, number> = {};
  for (const l of links) byRelation[l.relation] = (byRelation[l.relation] ?? 0) + 1;
  const hiddenByKind: Record<string, number> = {};
  for (const p of projections) hiddenByKind[p.supersede_kind] = (hiddenByKind[p.supersede_kind] ?? 0) + 1;
  const plan = {
    run_id: runId,
    user_id: args.userId,
    prompt_version: RECONCILE_PROMPT_VERSION,
    model,
    mode: args.apply ? "apply" : "dry-run",
    records_considered: res.recordsConsidered,
    live_in_scope: res.liveInScope,
    pairs_judged: res.pairsJudged,
    llm_calls: state.calls,
    llm_calls_this_invocation: res.calls,
    judge_retries: state.retries,
    turn_time_fallbacks: res.turnTimeFallbacks,
    projection_rows_before: projectionBefore,
    projection_rows_after: projectionAfter,
    max_calls: args.maxCalls,
    capped: res.capped,
    provider_failed: res.providerFailed,
    hybrid_failures: hybridFailures.count,
    cost_usd: state.cost_usd,
    links_by_relation: byRelation,
    hidden_by_kind: hiddenByKind,
    hides: projections.length,
    cap,
    links,
    projections,
  };
  writeFileSync(join(outDir, "plan.json"), `${JSON.stringify(plan, null, 1)}\n`);
  writeFileSync(join(outDir, "undo.sql"), undoSql(runId, args.userId, projections));
  writeFileSync(join(outDir, "apply.sql"), applySql(runId, args.userId, model, RECONCILE_PROMPT_VERSION, links, projections, res.judgedPairs));
  writeFileSync(join(outDir, "verdicts.json"), `${JSON.stringify(res.judgedPairs)}\n`);
  console.log(
    JSON.stringify({
      run_id: runId,
      out: outDir,
      records_considered: plan.records_considered,
      live_in_scope: plan.live_in_scope,
      pairs_judged: plan.pairs_judged,
      llm_calls: plan.llm_calls,
      judge_retries: state.retries,
      projection_rows_before: projectionBefore,
      projection_rows_after: projectionAfter,
      capped: plan.capped,
      provider_failed: plan.provider_failed,
      hybrid_failures: hybridFailures.count,
      links_by_relation: byRelation,
      hides: plan.hides,
      hidden_by_kind: hiddenByKind,
      cap_ok: cap.ok,
      cap_reason: cap.reason,
    }),
  );
  if (!cap.ok) fail(`aborting: ${cap.reason}`);
  if (!args.apply) return;

  // 3. Apply (never reached in a dry-run). The undo and apply SQL are already on disk.
  const { dumpProblem, kickerProblem, sameStoreProblem } = await import("../../src/lib/memory/reconcile/guards");
  const container = process.env.MEMBRAL_BENCH_DB_CONTAINER;
  if (!container) fail("--apply needs MEMBRAL_BENCH_DB_CONTAINER (the bench stack's own db)");
  if (!args.dump || !existsSync(args.dump)) fail("--apply needs --dump <pg_dump file taken now>");
  const psql = (input: string) =>
    execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-At", "-q", "-v", "ON_ERROR_STOP=1"], {
      input,
      encoding: "utf8",
    }).trim();
  const running = execFileSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const storeMismatch = await (async () => {
    const { count, error } = await supabase
      .from("session_memories")
      .select("id", { count: "exact", head: true })
      .eq("user_id", args.userId)
      .is("retired_at", null);
    return sameStoreProblem(error ? null : count, Number(psql(`select count(*) from session_memories where user_id='${args.userId}' and retired_at is null;`)));
  })();
  const dumpFacts = await readDumpFacts(args.dump, args.userId);
  const problem = kickerProblem(running, container) ?? storeMismatch ?? dumpProblem(dumpFacts);
  if (problem) fail(`refusing to apply: ${problem}`);
  execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-q"], {
    input: readFileSync(join(outDir, "apply.sql"), "utf8"),
    stdio: ["pipe", "inherit", "inherit"],
  });
  console.log(`[reconcile] applied ${projections.length} projections; undo: ${join(outDir, "undo.sql")}`);
}

/** Last bytes and user-id presence of a plain or .gz dump, streamed (never loaded whole). */
async function readDumpFacts(path: string, userId: string): Promise<import("../../src/lib/memory/reconcile/guards").DumpFacts> {
  const { createReadStream, statSync } = await import("node:fs");
  const { createGunzip } = await import("node:zlib");
  const src = createReadStream(path);
  const stream = path.endsWith(".gz") ? src.pipe(createGunzip()) : src;
  let tail = "";
  let containsUser = false;
  for await (const chunk of stream) {
    const text = (tail.slice(-64) + String(chunk)).toString();
    if (!containsUser && text.includes(userId)) containsUser = true;
    tail = (tail + String(chunk)).slice(-1024);
  }
  return { mtimeMs: statSync(path).mtimeMs, nowMs: Date.now(), tail, containsUser };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
