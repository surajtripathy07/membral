#!/usr/bin/env node
// Latency evidence for migration 129 (i33-port design section 8, PR 1): loads synthetic raw units into a THROWAWAY
// database, builds the indexes after the load, then times memory_raw_pools and memory_raw_cover and the per-user
// document-frequency lookup, with pool row-count checks and explain (analyze, buffers) of each RPC.
//
//   node scripts/eval/i33/latency.mjs --url postgres://postgres@127.0.0.1:55871/i33pr1_throwaway --phase load
//   (restart the server for cold buffers, then)
//   node scripts/eval/i33/latency.mjs --url ... --phase bench --out latency-result.md
//
// Synthetic only: seeded RNG, no user data, no network, no LLM. Refuses any database whose name does not contain
// "throwaway", "i33" or "latency". Requires migrations 001..132 applied and the `psql` binary (for COPY).
//
// Options: --url, --phase load|bench|all (default all), --seed 1, --units 357000 (heavy user ~98%), --reps 6,
//          --zipf-offset 20 (1 = stress: head words in nearly every row), --psql psql, --out <file>, --queries 20, --allow-wipe (load: truncate session_raw_units first),
//          --unit-model <name> (load: embedding_model of the unit rows, default nomic-embed-text), --phase queries --out <json> (dump each user's synthetic queries and vectors).
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import os from "node:os";

const require = createRequire(import.meta.url);
const { Client } = require("pg");

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1] && !all[i + 1].startsWith("--") ? all[i + 1] : true]);
    return acc;
  }, []),
);
const URL_ = args.url;
const PHASE = args.phase ?? "all";
const SEED = Number(args.seed ?? 1);
const TOTAL_UNITS = Number(args.units ?? 357000);
const REPS = Number(args.reps ?? 6);
const NQ = Number(args.queries ?? 20);
const PSQL = args.psql ?? "psql";
const ZIPF_OFF = Number(args["zipf-offset"] ?? 20);
if (!URL_) { console.error("--url required"); process.exit(2); }
const dbName = new URL(URL_).pathname.slice(1);
if (!/throwaway|i33|latency/i.test(dbName)) { console.error(`refusing database "${dbName}": name must contain throwaway, i33 or latency`); process.exit(2); }

const DIM = 768, PAD = 1536 - 768, MODEL = "nomic-embed-text";
const UNIT_MODEL = args["unit-model"] ?? MODEL; // embedding_model of the unit rows (the product reads them under unitEmbeddingModel)
const HEAVY = "00000000-0000-4000-8000-00000000a133";
const MID = "00000000-0000-4000-8000-00000000b133";
const SMALL = "00000000-0000-4000-8000-00000000c133";
const USERS = [
  { id: HEAVY, name: "heavy", units: Math.round(TOTAL_UNITS * 0.98), records: 5000, topics: 200 },
  { id: MID, name: "mid", units: Math.round(TOTAL_UNITS * 0.018), records: 300, topics: 12 },
  { id: SMALL, name: "small", units: Math.round(TOTAL_UNITS * 0.0012), records: 25, topics: 3 },
];
const K = { r1: 60, r2: 160, r3: 60 };
const BUDGET = { pools: 400, cover: 100, df: 50, ts: 100 };

// ---------- seeded RNG and generators ----------
function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const rng = mulberry32(SEED);
const gauss = () => (rng() + rng() + rng() + rng() - 2) * 1.732; // ~N(0,1)
const NUM = Array.from({ length: 4001 }, (_, i) => ((i - 2000) / 1000).toString()); // lookup of quantised floats
const q3 = (x) => NUM[Math.max(0, Math.min(4000, Math.round(x * 1000) + 2000))];
const ZEROS = ",0".repeat(PAD);

const SYL = ["ka", "lo", "mi", "ra", "te", "su", "no", "vi", "pe", "da", "ho", "ni", "ba", "ro", "li", "ge", "tu", "an", "er", "ol", "in", "ic", "ex", "or"];
const VOCAB_N = 9000;
const VOCAB = Array.from({ length: VOCAB_N }, () => {
  let w = ""; const n = 2 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) w += SYL[Math.floor(rng() * SYL.length)];
  return w + (rng() < 0.3 ? "s" : "");
});
// Zipf over word ranks ZIPF_OFF..VOCAB_N. The english text-search config drops stopwords, so rank 1 of the raw
// distribution (11% of tokens) is not what a tsvector sees; with offset 20 the commonest content word is ~0.9% of
// tokens, like prose. --zipf-offset 1 is the stress case (head words in nearly every row).
const zipf = () => VOCAB[Math.min(VOCAB_N - 1, Math.floor(ZIPF_OFF * Math.exp(rng() * Math.log(VOCAB_N / ZIPF_OFF))))];
const NTOPICS = 200;
const CENT = Array.from({ length: NTOPICS }, () => Float32Array.from({ length: DIM }, gauss));
const BAG = Array.from({ length: NTOPICS }, () => Array.from({ length: 60 }, () => VOCAB[60 + Math.floor(rng() * (VOCAB_N - 60))]));

function vec(topic) {
  const c = CENT[topic]; const parts = new Array(DIM);
  for (let i = 0; i < DIM; i++) parts[i] = q3(c[i] + gauss() * 0.8);
  return "[" + parts.join(",") + ZEROS + "]";
}
function words(n, topic) {
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = rng() < 0.35 ? BAG[topic][Math.floor(rng() * 60)] : zipf();
  return out.join(" ");
}
const text = (chars, topic) => { let s = words(Math.max(2, Math.round(chars / 6.2)), topic); return s.length > chars * 1.3 ? s.slice(0, Math.round(chars * 1.3)) : s; };
const logn = (mean, sigma) => Math.exp(Math.log(mean) - (sigma * sigma) / 2 + sigma * gauss());
const hex = (n, w) => n.toString(16).padStart(w, "0");
const sessId = (u, i) => `${hex(i + 1, 8)}-5e55-4000-8000-${u.id.slice(-12)}`;
const projId = (u) => `00000a5a-0b1c-4000-8000-${u.id.slice(-12)}`;

// ---------- helpers ----------
async function connect() { const c = new Client({ connectionString: URL_ }); await c.connect(); return c; }
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN; };
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : "n/a");
function copyIn(c, sql, gen) {
  return new Promise((resolve, reject) => {
    const p = spawn(PSQL, [URL_, "-v", "ON_ERROR_STOP=1", "-q", "-c", sql], { stdio: ["pipe", "inherit", "inherit"] });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`psql copy exit ${code}`))));
    (async () => {
      for (const chunk of gen()) { if (!p.stdin.write(chunk)) await new Promise((r) => p.stdin.once("drain", r)); }
      p.stdin.end();
    })().catch(reject);
  });
}

// ---------- load phase ----------
async function load() {
  const c = await connect();
  const have = Number((await c.query("select count(*) from public.session_raw_units")).rows[0].count);
  if (have > 0 && !args["allow-wipe"]) throw new Error("session_raw_units is not empty; pass --allow-wipe to truncate it");
  await c.query("truncate public.session_raw_units");
  const t0 = performance.now();
  // Drop the secondary indexes; they are rebuilt after the load from the migration's own definitions.
  const migration = readFileSync(new URL("../../../apps/cloud/supabase/migrations/129_session_raw_units.sql", import.meta.url), "utf8");
  const defs = [...migration.matchAll(/create index (?:if not exists )?(\w+)\s+on public\.session_raw_units[^;]*;/g)].map((m) => ({ indexname: m[1], indexdef: m[0].replace(/;$/, "") }));
  if (defs.length !== 4) throw new Error(`expected 4 secondary indexes in migration 129, found ${defs.length}`);
  for (const d of defs) await c.query(`drop index if exists public.${d.indexname}`);

  // users, projects, sessions, in SQL
  const plan = [];
  for (const u of USERS) {
    const sessions = []; let made = 0, i = 0;
    while (made < u.units) {
      const turns = Math.max(3, Math.round(logn(50, 0.9)));
      const wins = Math.round(turns * 1.81), c700 = Math.round(turns * 0.44);
      sessions.push({ i, turns, wins, c700, topic: Math.floor(rng() * u.topics) });
      made += turns + wins + c700; i++;
    }
    plan.push({ u, sessions });
    await c.query(`insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, [u.id, `latency-${u.name}@example.com`]);
    await c.query(`insert into public.code_projects (id, user_id, repo_identity) values ($1, $2, $3) on conflict do nothing`, [projId(u), u.id, `code-project:latency-${u.name}`]);
    const ids = sessions.map((s) => sessId(u, s.i)); // ids derived below in SQL-compatible form
    await c.query(
      `insert into public.code_sessions (id, user_id, code_project_id, source, source_session_id, content_hash)
       select x.id, $1, $2, 'claude-code', 'latency-' || x.id, '' from unnest($3::uuid[]) as x(id) on conflict do nothing`,
      [u.id, projId(u), ids],
    );
  }
  // unit rows
  const cols = "user_id, code_session_id, code_project_id, unit, ord, turn_idx, turn_from, turn_to, parts, win, text, full_text, turn_text, embedding, embedding_model, text_hash, units_version, source_hash";
  let rows = 0;
  for (const { u, sessions } of plan) {
    const proj = projId(u);
    function* gen() {
      let buf = [];
      const flush = () => { const s = buf.join(""); buf = []; return s; };
      for (const s of sessions) {
        const sid = sessId(u, s.i);
        const tp = () => (rng() < 0.15 ? Math.floor(rng() * u.topics) : s.topic);
        const sh = `sh-${s.i}`;
        for (let o = 0; o < s.c700; o++) {
          const t = tp(); const ti = Math.floor(rng() * s.turns);
          buf.push([u.id, sid, proj, "c700", o, ti, "\\N", "\\N", `[{"turn":${ti},"from":0,"to":700}]`, "\\N", text(700, t), "\\N", "\\N", vec(t), UNIT_MODEL, `th-${s.i}-c-${o}`, 1, sh].join("\t") + "\n");
        }
        for (let o = 0; o < s.wins; o++) {
          const t = tp(); const a = Math.floor(rng() * s.turns); const b = Math.min(s.turns - 1, a + 1 + Math.floor(rng() * 3));
          buf.push([u.id, sid, proj, "win", o, "\\N", a, b, "\\N", `[${a},${b}]`, text(300, t), "\\N", "\\N", vec(t), UNIT_MODEL, `th-${s.i}-w-${o}`, 1, sh].join("\t") + "\n");
        }
        for (let o = 0; o < s.turns; o++) {
          const t = tp(); const full = text(Math.min(60000, logn(240, 1.3)), t);
          buf.push([u.id, sid, proj, "turn", o, o, o, o, "\\N", "\\N", full.slice(0, 160), full, full.slice(0, 30000), vec(t), UNIT_MODEL, `th-${s.i}-t-${o}`, 1, sh].join("\t") + "\n");
        }
        if (buf.length >= 400) yield flush();
      }
      if (buf.length) yield flush();
    }
    await copyIn(c, `copy public.session_raw_units (${cols}) from stdin`, gen);
    const n = sessions.reduce((a, s) => a + s.turns + s.wins + s.c700, 0); rows += n;
    console.error(`loaded ${u.name}: ${sessions.length} sessions, ${n} units (${((performance.now() - t0) / 1000).toFixed(0)} s)`);
  }
  // records for the cover pairs: each takes the vector of another random unit
  for (const { u } of plan) {
    await c.query(
      `insert into public.session_memories (user_id, code_session_id, code_project_id, source, kind, text, turn_idx, turn_role, content_hash, embedding, embedding_model)
       select user_id, code_session_id, code_project_id, 'extractor', 'decision', left(text, 200), 0, 'assistant', 'rec-' || id::text,
              lead(embedding) over (order by id), $2
         from (select * from public.session_raw_units where user_id = $1 and unit = 'turn' order by random() limit $3) s`,
      [u.id, MODEL, u.records],
    );
  }
  await c.query("delete from public.session_memories where embedding is null and content_hash like 'rec-%'");
  const loadS = (performance.now() - t0) / 1000;
  // indexes after the load, timed
  const builds = [];
  await c.query("set maintenance_work_mem = '4GB'");
  for (const d of defs.sort((a, b) => a.indexname.localeCompare(b.indexname))) {
    const t = performance.now(); await c.query(d.indexdef); builds.push([d.indexname, (performance.now() - t) / 1000]);
    console.error(`built ${d.indexname} in ${builds.at(-1)[1].toFixed(1)} s`);
  }
  await c.query("analyze public.session_raw_units");
  await c.query("analyze public.session_memories");
  const size = (await c.query(`select pg_size_pretty(pg_total_relation_size('public.session_raw_units')) t, pg_size_pretty(pg_relation_size('public.session_raw_units')) h, (select string_agg(indexname || ' ' || pg_size_pretty(pg_relation_size(('public.'||indexname)::regclass)), '; ') from pg_indexes where tablename='session_raw_units') i`)).rows[0];
  console.error(`LOAD DONE rows=${rows} load_s=${loadS.toFixed(0)} builds=${JSON.stringify(builds)} size=${JSON.stringify(size)}`);
  await c.end();
  return { rows, loadS, builds, size };
}

// ---------- bench phase ----------
function queriesFor(u, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = Math.floor(rng() * u.topics);
    const w = []; const nw = 6 + Math.floor(rng() * 5);
    for (let j = 0; j < nw; j++) w.push(rng() < 0.8 ? BAG[t][Math.floor(rng() * 60)] : zipf());
    out.push({ topic: t, text: w.join(" "), emb: vec(t) });
  }
  return out;
}

// auto_explain notices carry the statement text first; keep the duration line and the plan.
const planOnly = (ns) => ns.filter((m) => /\(cost=/.test(m)).map((m) => m.split("\n")[0] + "\n" + m.slice(m.search(/^\S.*\(cost=/m))).join("\n---\n");

async function bench() {
  const c = await connect();
  await c.query("set role service_role");
  const notices = [];
  c.on("notice", (m) => notices.push(m.message));
  const info = {
    version: (await c.query("show server_version")).rows[0].server_version,
    pgvector: (await c.query("select extversion from pg_extension where extname='vector'")).rows[0].extversion,
    shared_buffers: (await c.query("show shared_buffers")).rows[0].shared_buffers,
    maintenance_work_mem: (await c.query("show maintenance_work_mem")).rows[0].maintenance_work_mem,
    work_mem: (await c.query("show work_mem")).rows[0].work_mem,
    cores: os.cpus().length, ram_gb: Math.round(os.totalmem() / 2 ** 30),
    hnsw: (await c.query(`select pg_get_indexdef(indexrelid) d from pg_index where indexrelid='public.idx_session_raw_units_embedding'::regclass`)).rows[0].d,
    rows: Number((await c.query("select count(*) from public.session_raw_units")).rows[0].count),
  };
  const result = { info, profiles: {}, fails: [] };
  const poolSql = "select * from public.memory_raw_pools($1::uuid, $2, $3::vector, $4, $5, null, true)";

  for (const u of USERS) {
    const qs = queriesFor(u, NQ);
    // exact expectation per query/pool (untimed): candidates are rows that match lexically or exceed the dense floor
    const expect = [];
    for (const q of qs) {
      const e = {};
      for (const [pool, unit] of [["r1", "c700"], ["r2", "win"], ["r3", "turn"]]) {
        const r = await c.query(
          `with qt as (select nullif(string_agg(quote_literal(l.lex), ' | '), '')::tsquery tsq from (select distinct lex from unnest(tsvector_to_array(to_tsvector('english', $3))) l(lex)) l)
           select count(*)::int n from public.session_raw_units x, qt where x.user_id = $1 and x.unit = $2
             and ((x.embedding is not null and 1 - (x.embedding <=> $4::vector) > 0.3) or (qt.tsq is not null and x.fts @@ qt.tsq))`,
          [u.id, unit, q.text, q.emb]);
        e[pool] = Math.min(K[pool], r.rows[0].n);
      }
      expect.push(e);
    }
    const prof = { pools: [], pools_first: [], cover: [], cover_first: [], df: [], df_first: [], ts: [], ts_first: [], under: [], short: 0 };
    const recIds = (await c.query("select id from public.session_memories where user_id = $1 order by id limit 100", [u.id])).rows.map((r) => r.id);
    for (let rep = 0; rep < REPS; rep++) {
      for (let qi = 0; qi < qs.length; qi++) {
        const q = qs[qi];
        let t = performance.now();
        const r = await c.query(poolSql, [u.id, q.text, q.emb, MODEL, 0.3]);
        const dt = performance.now() - t;
        (rep === 0 ? prof.pools_first : prof.pools).push(dt);
        const got = { r1: 0, r2: 0, r3: 0 }; for (const row of r.rows) got[row.pool]++;
        for (const p of ["r1", "r2", "r3"]) if (got[p] !== expect[qi][p]) { prof.short++; prof.under.push(`${u.name} q${qi} ${p} got ${got[p]} want ${expect[qi][p]}`); }
        const ids = r.rows.map((x) => x.id);
        t = performance.now();
        await c.query("select * from public.memory_raw_cover($1::uuid, $2::uuid[], $3::uuid[])", [u.id, ids, recIds]);
        (rep === 0 ? prof.cover_first : prof.cover).push(performance.now() - t);
        // R3 per-user document-frequency lookup (what an exact-BM25 R3 would add): count of the user's turns per query lexeme
        t = performance.now();
        await c.query(
          `select l.lex, (select count(*) from public.session_raw_units x where x.user_id = $1 and x.unit = 'turn' and x.fts @@ quote_literal(l.lex)::tsquery) df
             from (select distinct lex from unnest(tsvector_to_array(to_tsvector('english', $2))) l(lex)) l`, [u.id, q.text]);
        (rep === 0 ? prof.df_first : prof.df).push(performance.now() - t);
        // memory_raw_term_stats (migration 131): the same document frequencies through the RPC, one call per query
        t = performance.now();
        await c.query("select * from public.memory_raw_term_stats($1::uuid, $2::text[])", [u.id, [...new Set(q.text.split(" "))]]);
        (rep === 0 ? prof.ts_first : prof.ts).push(performance.now() - t);
      }
    }
    result.profiles[u.name] = prof;
    // explain (analyze, buffers) of the nested statements of one representative query, via auto_explain notices
    if (u.name === "heavy") {
      await c.query("reset role");
      await c.query("load 'auto_explain'");
      await c.query("set auto_explain.log_min_duration = 0; set auto_explain.log_analyze = on; set auto_explain.log_buffers = on; set auto_explain.log_nested_statements = on; set auto_explain.log_level = 'notice'; set auto_explain.log_format = 'text'");
      await c.query("set role service_role");
      notices.length = 0;
      await c.query(poolSql, [u.id, qs[0].text, qs[0].emb, MODEL, 0.3]);
      result.explainPools = planOnly(notices);
      notices.length = 0;
      const r = await c.query(poolSql, [u.id, qs[0].text, qs[0].emb, MODEL, 0.3]);
      notices.length = 0;
      await c.query("select * from public.memory_raw_cover($1::uuid, $2::uuid[], $3::uuid[])", [u.id, r.rows.map((x) => x.id), recIds]);
      result.explainCover = planOnly(notices);
      await c.query("reset role");
      await c.query("set auto_explain.log_min_duration = -1");
      await c.query("set role service_role");
    }
  }
  await c.end();
  return result;
}

function report(r) {
  const L = [];
  const i = r.info;
  L.push(`# memory_raw_pools / memory_raw_cover latency`);
  L.push(`## native macOS Postgres ${i.version} + pgvector ${i.pgvector}, Apple Silicon, NOT the Colima/Docker stack`);
  L.push(`${i.cores} cores, ${i.ram_gb} GB RAM; shared_buffers ${i.shared_buffers}, maintenance_work_mem ${i.maintenance_work_mem} (4GB for the index builds), work_mem ${i.work_mem}.`);
  L.push(`HNSW: \`${i.hnsw}\` (pgvector defaults m 16, ef_construction 64); function sets hnsw.ef_search 400, iterative_scan relaxed_order.`);
  L.push(`Rows: ${i.rows} synthetic units (seed ${SEED}, zipf offset ${ZIPF_OFF}); ${NQ} queries x ${REPS} reps per user, rep 0 (first execution per query after a server restart) counted as cold and included in the all-runs line.`);
  L.push(`These figures need re-confirmation on the Docker stack later.`);
  L.push("");
  L.push("| user | call | runs | p50 ms | p95 ms | cold p50/max ms | all-runs p95 | budget p95 | verdict |");
  L.push("|---|---|---|---|---|---|---|---|---|");
  for (const [name, p] of Object.entries(r.profiles)) {
    for (const [key, label, budget] of [["pools", "memory_raw_pools", BUDGET.pools], ["cover", "memory_raw_cover", BUDGET.cover], ["df", "R3 df lookup", BUDGET.df], ["ts", "memory_raw_term_stats", BUDGET.ts]]) {
      const warm = p[key], cold = p[key + "_first"], all = [...cold, ...warm];
      const p95all = pct(all, 95);
      L.push(`| ${name} | ${label} | ${all.length} (${cold.length} cold) | ${fmt(pct(warm, 50))} | ${fmt(pct(warm, 95))} | ${fmt(pct(cold, 50))} / ${fmt(Math.max(...cold))} | ${fmt(p95all)} | ${budget} | ${p95all <= budget ? "PASS" : "FAIL"} |`);
      if (name === "heavy" && p95all > budget) r.fails.push(`${label} p95 ${fmt(p95all)} > ${budget}`);
    }
  }
  L.push("");
  L.push(`Pool row-count check (requested K = r1 ${K.r1}, r2 ${K.r2}, r3 ${K.r3}; expected = min(K, exact candidate count)):`);
  for (const [name, p] of Object.entries(r.profiles)) L.push(`- ${name}: ${p.short} short pools of ${(p.pools.length + p.pools_first.length) * 3}${p.under.length ? " e.g. " + p.under.slice(0, 3).join("; ") : ""}`);
  L.push("");
  L.push("## explain (analyze, buffers), heavy user, query 0, warm");
  L.push("### memory_raw_pools\n```\n" + (r.explainPools ?? "") + "\n```");
  L.push("### memory_raw_cover\n```\n" + (r.explainCover ?? "") + "\n```");
  return L.join("\n");
}

const out = {};
if (PHASE === "queries") {
  // Fresh process, same seed: the vectors are the ones the load phase used for the same topics.
  const dump = Object.fromEntries(USERS.map((u) => [u.name, { id: u.id, queries: queriesFor(u, NQ) }]));
  writeFileSync(args.out, JSON.stringify(dump));
  console.error(`queries written to ${args.out}`);
}
if (PHASE === "load" || PHASE === "all") Object.assign(out, { load: await load() });
if (PHASE === "bench" || PHASE === "all") {
  const r = await bench();
  const md = report(r);
  if (args.out) writeFileSync(args.out, md + "\n");
  console.log(md);
  if (r.fails.length) { console.error("BUDGET FAIL: " + r.fails.join("; ")); process.exitCode = 1; }
}
