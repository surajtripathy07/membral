// Runner for parity-product.mjs (run under vitest by parity-product.vitest.config.mts; not part of the app's test suite).
// Modes (PARITY_MODE): load | run | bench. Reads/writes under PARITY_WORK; database PARITY_URL must be a throwaway one.
// The embedder is mocked with the lab's cached query vectors, so no network and no LLM is involved.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import { describe, it, vi } from "vitest";

const hoisted = vi.hoisted(() => {
  process.env.MEMBRAL_LOCAL = "1";
  // The lab's record vectors carry the search_document prefix, so the records query takes the search_query prefix too
  // (MEMBRAL_RECORD_QUERY_PREFIX=0 in the environment measures the product's default, unprefixed records query).
  process.env.MEMBRAL_RECORD_QUERY_PREFIX ??= "1";
  process.env.MEMBRAL_EMBEDDING_MODEL = "nomic-embed-text";
  process.env.MEMBRAL_EMBEDDINGS_BASE_URL = "http://127.0.0.1:11434/v1";
  return {
    embed: async (_t: string): Promise<number[]> => {
      throw new Error("embedder not set");
    },
    acc: { assembleMs: 0, rpcMs: 0 },
  };
});
vi.mock("@/lib/embeddings", () => ({
  generateEmbedding: (t: string) => hoisted.embed(t),
  EmbeddingCeilingExceededError: class extends Error {},
}));
vi.mock("@/lib/feature-flags", () => ({ FeatureDisabledError: class extends Error {} }));
vi.mock("@/lib/memory/raw-units/search/assemble", async (importOriginal) => {
  const m = await importOriginal<typeof import("@/lib/memory/raw-units/search/assemble")>();
  return {
    ...m,
    assembleRaw: (...a: Parameters<typeof m.assembleRaw>) => {
      const t = performance.now();
      try {
        return m.assembleRaw(...a);
      } finally {
        hoisted.acc.assembleMs += performance.now() - t;
      }
    },
  };
});

import type { Db } from "@/lib/db/types";
import { memorySearch } from "@/lib/memory/search";
import { extractQueryAnchors } from "@/lib/memory/query-anchors";
import { buildRawUnits, computeSourceHash, UNITS_VERSION } from "@/lib/memory/raw-units/units";
import { unitEmbeddingModel, unitTextHash } from "@/lib/memory/raw-units/embed";
import { fuseCardsRaw, packServed, searchRawUnits, type ServedLine } from "@/lib/memory/raw-units/search";

const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: pg ships no types here
const pg: any = require("pg");

const WORK = process.env.PARITY_WORK as string;
const URL_ = process.env.PARITY_URL as string;
const MODE = process.env.PARITY_MODE ?? "run";
const FAMILY = "nomic-embed-text";
const LIMIT = 20;
const OPTS = { raw: true, floor: true, dateHints: true, logEvent: false, collapseByMeaning: true };
const PAD = 1536 - 768;
const dbName = new URL(URL_).pathname.slice(1);
if (!/throwaway/i.test(dbName)) throw new Error(`refusing database "${dbName}": name must contain throwaway`);

const pad = (v: number[]) => (v.length === 1536 ? v : v.concat(new Array(PAD).fill(0)));
const vecText = (v: ArrayLike<number>) => `[${Array.from(v, (x) => Number(x.toPrecision(8))).join(",")}]`;
const readJson = (f: string) => JSON.parse(readFileSync(`${WORK}/${f}`, "utf8"));
const userOf = (i: number) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`;
const projOf = (i: number) => `00000000-0000-4000-8000-1${String(i + 1).padStart(11, "0")}`;
// A lab session can sit in several sets; each set is its own user, so the stored session id differs in its last two hex digits.
const sessOf = (id: string, i: number) => `${id.slice(0, 34)}${id.slice(34, 36).replace(/.{2}/, String(i).padStart(2, "0"))}`;
const hex16 = (id: string) => (/^[0-9a-f]{16}$/.test(id) ? id : createHash("sha256").update(id).digest("hex").slice(0, 16));
const recUuid = (id: string, i: number) => {
  const h = hex16(id);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(12, 15)}-8${h[15]}00-${String(i).padStart(12, "0")}`;
};
const labUnitId = (id8: string, unit: string, ord: number, turnIdx: number) =>
  unit === "c700" ? `chunk-${id8}-${ord}` : unit === "win" ? `win-${id8}-${ord}` : `turn-${id8}-${turnIdx}`;

// ---------- Db shim over pg: rpc() as PostgREST returns it (to_jsonb rows), from() as an empty read ----------
function makeDb(client: { query: (q: string, p?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }) {
  const sigs = new Map<string, { name: string; type: string }[][]>();
  async function sigsOf(fn: string) {
    let s = sigs.get(fn);
    if (!s) {
      const r = await client.query(
        "select pg_get_function_identity_arguments(p.oid) a from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1",
        [fn],
      );
      s = r.rows.map((x) =>
        String(x.a)
          .split(", ")
          .filter(Boolean)
          .map((a) => {
            const [name, ...rest] = a.split(" ");
            return { name, type: rest.join(" ") };
          }),
      );
      sigs.set(fn, s);
    }
    return s;
  }
  const chain: unknown = new Proxy(() => undefined, {
    get: (_t, p) => (p === "then" ? (res: (v: unknown) => void) => res({ data: [], error: null, count: 0 }) : () => chain),
    apply: () => chain,
  });
  return {
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      const t0 = performance.now();
      try {
        // Experiment (PARITY_LAB_STATS=1): serve the snippet the lab's JS-token df/N instead of Postgres-lexeme df.
        const lt = (hoisted as { labTerms?: { n: number; df: Record<string, number> } }).labTerms;
        if (fn === "memory_raw_term_stats" && lt && process.env.PARITY_LAB_STATS) {
          const ts = (args.p_terms as string[]).map((t) => ({ term: t, df: lt.df[t] ?? 0, total: lt.n }));
          return { data: [{ term: null, df: null, total: lt.n }, ...ts], error: null };
        }
        const names = Object.keys(args);
        const sig = (await sigsOf(fn)).find((s) => names.every((n) => s.some((a) => a.name === n)));
        if (!sig) return { data: null, error: { message: `no signature for ${fn}(${names.join(",")})` } };
        const params: unknown[] = [];
        const parts = names.map((n, i) => {
          const a = sig.find((x) => x.name === n) as { name: string; type: string };
          const v = args[n];
          params.push(v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v === undefined ? null : v);
          return `${n} => $${i + 1}::${a.type}`;
        });
        const r = await client.query(`select to_jsonb(t) as j from public.${fn}(${parts.join(", ")}) t`, params);
        return { data: r.rows.map((x) => x.j), error: null };
      } catch (e) {
        return { data: null, error: { message: e instanceof Error ? e.message : String(e), code: (e as { code?: string }).code } };
      } finally {
        hoisted.acc.rpcMs += performance.now() - t0;
      }
    },
    from: () => chain,
  } as unknown as Db;
}

async function connect() {
  const c = new pg.Client({ connectionString: URL_ });
  await c.connect();
  c.on("error", () => undefined);
  pg.types.setTypeParser(20, (x: string) => Number(x));
  return c;
}

// ---------- load ----------
async function load() {
  const lab = readJson("lab.json");
  const c = await connect();
  const users: Record<string, string> = {};
  for (const [i, set] of (lab.sets as string[]).entries()) {
    const info = readJson(`set-${set}.json`);
    const userId = userOf(i);
    users[set] = userId;
    await c.query("insert into auth.users (id, email) values ($1, $2) on conflict do nothing", [userId, `${set}@parity.invalid`]);
    await c.query("insert into public.profiles (id) values ($1) on conflict do nothing", [userId]);
    await c.query("insert into public.code_projects (id, user_id, repo_identity, display_name) values ($1, $2, $3, $3) on conflict do nothing", [projOf(i), userId, `parity/${set}`]);
    for (const s of info.sessions) {
      await c.query(
        `insert into public.code_sessions (id, user_id, code_project_id, source, source_session_id, content_hash, started_at, ended_at, title)
         values ($1::uuid, $2, $3, 'claude-code', $1::text, 'parity', $4, $5, $6) on conflict do nothing`,
        [sessOf(s.id, i), userId, projOf(i), s.started_at, s.ended_at, s.title],
      );
    }
    // units: the product's buildRawUnits, vectors from the lab cache (768 padded to 1536)
    const vbuf = readFileSync(`${WORK}/set-${set}.units.vec`);
    const all = new Float32Array(vbuf.buffer, vbuf.byteOffset, vbuf.byteLength / 4);
    let vi = 0;
    const model = unitEmbeddingModel(FAMILY);
    await c.query("delete from public.session_raw_units where user_id = $1", [userId]);
    for (const s of info.sessions) {
      const units = buildRawUnits(s.turns);
      const sh = computeSourceHash(s.turns, UNITS_VERSION);
      for (let b = 0; b < units.length; b += 100) {
        const slice = units.slice(b, b + 100);
        const params: unknown[] = [];
        const rows = slice.map((u, k) => {
          const v = all.subarray((vi + b + k) * 768, (vi + b + k + 1) * 768);
          const o = params.length;
          params.push(
            userId, sessOf(s.id, i), projOf(i), u.unit, u.ord, u.unit === "turn" ? u.turn_idx : u.turn_idx, u.turn_from, u.turn_to,
            JSON.stringify(u.unit === "turn" ? { turn_len: u.turn_len } : u.parts), u.win ? `[${u.win[0]},${u.win[1]})` : null,
            u.text, u.full_text, u.turn_text, vecText(Array.from(v).concat(new Array(PAD).fill(0))), model, unitTextHash(u.text, FAMILY), UNITS_VERSION, sh,
          );
          return `(${Array.from({ length: 18 }, (_, j) => `$${o + j + 1}`).join(",")})`;
        });
        const cast = ["", "", "", "", "", "", "", "", "::jsonb", "::int4range", "", "", "", "::vector", "", "", "", ""];
        const sql = rows
          .map((r) => r.replace(/\$(\d+)/g, (_m, n) => `$${n}${cast[(Number(n) - 1) % 18]}`))
          .join(",");
        await c.query(
          `insert into public.session_raw_units (user_id, code_session_id, code_project_id, unit, ord, turn_idx, turn_from, turn_to, parts, win, text, full_text, turn_text, embedding, embedding_model, text_hash, units_version, source_hash) values ${sql}`,
          params,
        );
      }
      vi += units.length;
    }
    // records
    const rbuf = readFileSync(`${WORK}/set-${set}.rec.vec`);
    const rall = new Float32Array(rbuf.buffer, rbuf.byteOffset, rbuf.byteLength / 4);
    const idset = new Set(info.records.map((r: { id: string }) => r.id));
    for (const [k, r] of (info.records as Record<string, unknown>[]).entries()) {
      const v = Array.from(rall.subarray(k * 768, (k + 1) * 768)).concat(new Array(PAD).fill(0));
      await c.query(
        `insert into public.session_memories (id, user_id, code_session_id, code_project_id, agent_id, source, kind, text, quote, turn_idx, turn_role, ref, ref_kind, branch, thread, paths, verified, durable, scope, confidence, supersedes, retired_at, content_hash, embedding, embedding_model, session_title, created_at)
         values ($1,$2,$3,$4,$5,'extractor',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23::vector,'nomic-embed-text',$24,$25)`,
        [
          recUuid(r.id as string, i), userId, sessOf(r.session_id as string, i), projOf(i), r.agent_id ?? null, r.kind, r.text, r.quote ?? null, r.turn_idx, r.turn_role, r.ref ?? null, r.ref_kind ?? null, r.branch ?? null,
          r.thread ?? null, r.paths ?? [], r.verified ?? false, r.durable ?? false, r.scope ?? "project", r.confidence ?? 0.5,
          typeof r.supersedes === "string" && idset.has(r.supersedes) ? recUuid(r.supersedes, i) : null, r.retired_at ?? null, r.id, vecText(v), r.session_title ?? null, r.created_at ?? null,
        ],
      );
    }
    console.log(`loaded ${set}: ${info.sessions.length} sessions, ${info.records.length} records`);
  }
  writeFileSync(`${WORK}/users.json`, JSON.stringify(users));
  await c.query("analyze public.session_raw_units");
  await c.query("analyze public.session_memories");
  await c.end();
}

// ---------- run ----------
async function run() {
  const lab = readJson("lab.json");
  const users = readJson("users.json") as Record<string, string>;
  const c = await connect();
  const db = makeDb(c);
  const unitMap = new Map<string, string>();
  const recMap = new Map<string, string>();
  for (const set of lab.sets as string[]) {
    const r = await c.query(
      "select id, code_session_id::text sid, unit, ord, turn_idx from public.session_raw_units where user_id = $1",
      [users[set]],
    );
    for (const x of r.rows) unitMap.set(x.id as string, labUnitId((x.sid as string).slice(0, 8), x.unit as string, x.ord as number, x.turn_idx as number));
    for (const rec of readJson(`set-${set}.json`).records) recMap.set(recUuid(rec.id, lab.sets.indexOf(set)), rec.id);
  }
  const out: unknown[] = [];
  for (const q of lab.questions) {
    const userId = users[q.set];
    const si = lab.sets.indexOf(q.set);
    let unmapped = 0;
    const toLab = (l: ServedLine): ServedLine => ({
      ...l,
      members: l.members.map((m) => {
        const x = unitMap.get(m) ?? recMap.get(m);
        if (!x) unmapped++;
        return x ?? m;
      }),
    });
    (hoisted as { labTerms?: unknown }).labTerms = q.pools?.dbgTerms;
    hoisted.embed = async (t) => pad(t.startsWith("search_query: ") ? q.qvec : q.qvecRaw);
    const cardLines: ServedLine[] = q.pre.cards.map((cd: { members: string[]; text: string }) => ({ type: cd.members.length > 1 ? "card" : "record", id8: "", span: [0, 0], members: cd.members, text: cd.text }));
    const rawOut = await searchRawUnits(db, userId, {
      query: q.query,
      family: FAMILY,
      limit: LIMIT,
      projectId: null,
      anchors: extractQueryAnchors(q.query),
      records: q.pre.records.map((r: { id: string; similarity: number | null }) => ({ id: recUuid(r.id, si), similarity: r.similarity })),
      cards: q.pre.cards.map((cd: { text: string; ref: string | null; paths: string[]; vec_ids: string[] }) => ({ text: cd.text, ref: cd.ref, paths: cd.paths, vec_ids: cd.vec_ids.map((x: string) => recUuid(x, si)) })),
      embed: async (t) => hoisted.embed(t),
    });
    const aLines = fuseCardsRaw(cardLines, rawOut.lines).slice(0, LIMIT).map((l) => (l.type === "raw" ? toLab(l) : l));
    const res = await memorySearch(db, userId, null, { query: q.query, limit: LIMIT }, OPTS);
    const bLines = (res.served ?? []).map(toLab);
    const packed = packServed(bLines, 3000);
    out.push({ qid: q.qid, a: { lines: aLines, reason: rawOut.reason ?? null }, b: { lines: bLines, servedText: packed.lines.length ? packed.lines.map((l) => l.text).join("\n") : "(none)", packedTokens: packed.tokens, packed: packed.lines.length, reason: res.raw_reason ?? null, records: res.records.length }, unmapped });
  }
  writeFileSync(`${WORK}/product.json`, JSON.stringify({ questions: out }));
  await c.end();
}

// ---------- bench ----------
const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : Number.NaN;
};

async function bench() {
  const store = process.env.PARITY_STORE ?? "dev";
  const c = await connect();
  const db = makeDb(c);
  type Job = { label: string; userId: string; query: string; vec: number[] };
  const jobs: Job[] = [];
  if (store === "dev") {
    const lab = readJson("lab.json");
    const users = readJson("users.json") as Record<string, string>;
    for (const q of lab.questions) jobs.push({ label: q.qid, userId: users[q.set], query: q.query, vec: pad(q.qvec) });
  } else {
    const qs = JSON.parse(readFileSync(process.env.PARITY_QUERIES as string, "utf8")) as Record<string, { id: string; queries: { text: string; emb: string }[] }>;
    for (const [name, u] of Object.entries(qs)) for (const [i, q] of u.queries.entries()) jobs.push({ label: `${name}-${i}`, userId: u.id, query: q.text, vec: JSON.parse(q.emb) });
  }
  const one = async (j: Job) => {
    hoisted.embed = async () => j.vec;
    hoisted.acc.assembleMs = 0;
    hoisted.acc.rpcMs = 0;
    const t = performance.now();
    const r = await memorySearch(db, j.userId, null, { query: j.query, limit: LIMIT }, OPTS);
    const total = performance.now() - t;
    return { total, rpc: hoisted.acc.rpcMs, assemble: hoisted.acc.assembleMs, raw: (r.served ?? []).filter((l) => l.type === "raw").length, reason: r.raw_reason ?? null };
  };
  for (const j of jobs) await one(j); // warm-up pass
  const REPS = 6;
  const per: Record<string, { total: number[]; ts: number[]; assemble: number[]; rpc: number[]; raw: number[]; reasons: Set<string> }> = {};
  for (let rep = 0; rep < REPS; rep++) {
    for (const j of jobs) {
      const group = store === "dev" ? "dev" : j.label.split("-")[0];
      const g = (per[group] ??= { total: [], ts: [], assemble: [], rpc: [], raw: [], reasons: new Set() });
      const r = await one(j);
      g.total.push(r.total);
      g.ts.push(r.total - r.rpc);
      g.assemble.push(r.assemble);
      g.rpc.push(r.rpc);
      if (rep === 0) g.raw.push(r.raw);
      if (r.reason) g.reasons.add(r.reason.slice(0, 80));
    }
  }
  const res = Object.fromEntries(
    Object.entries(per).map(([k, g]) => [k, { n: g.total.length, jobs: jobs.length, total: { p50: pct(g.total, 50), p95: pct(g.total, 95) }, nonDb: { p50: pct(g.ts, 50), p95: pct(g.ts, 95) }, assemble: { p50: pct(g.assemble, 50), p95: pct(g.assemble, 95) }, rpc: { p50: pct(g.rpc, 50), p95: pct(g.rpc, 95) }, rawLines: g.raw.reduce((a, b) => a + b, 0) / Math.max(1, g.raw.length), reasons: [...g.reasons] }]),
  );
  writeFileSync(process.env.PARITY_BENCH_OUT as string, JSON.stringify({ store, res }, null, 1));
  console.log(JSON.stringify(res));
  await c.end();
}

// Debug aid: the product's raw pools for one question (PARITY_Q), with lab ids.
async function debugPools() {
  const lab = readJson("lab.json");
  const users = readJson("users.json") as Record<string, string>;
  const q = lab.questions.find((x: { qid: string }) => x.qid === process.env.PARITY_Q);
  const c = await connect();
  const um = new Map<string, string>();
  const r0 = await c.query("select id, code_session_id::text sid, unit, ord, turn_idx from public.session_raw_units where user_id = $1", [users[q.set]]);
  for (const x of r0.rows) um.set(x.id as string, labUnitId((x.sid as string).slice(0, 8), x.unit as string, x.ord as number, x.turn_idx as number));
  const r = await c.query("select to_jsonb(t) j from public.memory_raw_pools($1::uuid, $2, $3::vector, $4, $5, null, true) t", [users[q.set], q.query, vecText(pad(q.qvec)), unitEmbeddingModel(FAMILY), 0.3]);
  const rows = r.rows.map((x) => x.j);
  for (const pool of ["r1", "r2", "r3"]) console.log(pool, rows.filter((x: { pool: string }) => x.pool === pool).sort((a: { rrf: number }, b: { rrf: number }) => b.rrf - a.rrf).slice(0, 25).map((x: { id: string; similarity: number; rrf: number; lex_rank: number | null; sem_rank: number | null }) => `${um.get(x.id)}@${Number(x.similarity).toFixed(3)}L${x.lex_rank}:${Number((x as unknown as {lex_score:number}).lex_score).toFixed(2)}S${x.sem_rank}H${(x as unknown as {lex_hits:number}).lex_hits}/${(x as unknown as {query_lexemes:number}).query_lexemes}`).join(" "));
  await c.end();
}

describe("parity-product", () => {
  it(MODE, async () => {
    if (MODE === "debug") await debugPools();
    else if (MODE === "load") await load();
    else if (MODE === "run") await run();
    else await bench();
  });
});
