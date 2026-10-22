#!/usr/bin/env node
// Product-vs-lab parity for the I33 read path on the lab's DEV sample (docs/design/i33-port.md section 9, goal D7), plus
// whole-memorySearch latency. No data lives in this file: every transcript, question and vector it touches is read from
// the lab checkout and written under --work (keep that outside the repository).
//
//   node scripts/eval/i33/parity-product.mjs export  --lab ~/dev/extract-search-lab --work W      (lab side: sample, turns, vectors, lab I33 output)
//   node scripts/eval/i33/parity-product.mjs load    --url postgres://.../x_throwaway --work W    (units via the product's buildRawUnits, vectors from the lab cache)
//   node scripts/eval/i33/parity-product.mjs run     --url ... --work W                           (product read path, writes W/product.json)
//   node scripts/eval/i33/parity-product.mjs compare --lab ... --work W --out result.md           (lab compareServed, tables)
//   node scripts/eval/i33/parity-product.mjs bench   --url ... --work W [--store dev|synth --queries q.json]
//
// `load`, `run` and `bench` run scripts/eval/i33/parity-product.runner.ts under vitest (alias @ -> apps/cloud/src, the
// embedder mocked with the lab's cached vectors). Dev sets only: a held-out set is refused by name and never opened.
// Refuses any database whose name does not contain "throwaway". Needs the PG17+pgvector build, migrations 001..132.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../../..");
const argv = process.argv.slice(2);
const cmd = argv[0];
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const WORK = arg("work");
const LAB = arg("lab", resolve(REPO, "../extract-search-lab"));
if (!cmd || !WORK) {
  console.error("usage: parity-product.mjs export|load|run|compare|bench --work <dir> [--lab <dir>] [--url <pg url>] [--out <file>]");
  process.exit(2);
}
const W = (f) => join(WORK, f);
const SEED = Number(arg("seed", 42));
const N = Number(arg("n", 20));
const BUDGET = 3000;
const VARIANT = arg("variant", "I33-native-fts");
const QUERY_PREFIX = "search_query: ";

function f32(arr) {
  return Buffer.from(new Float32Array(arr).buffer);
}

// ---------- export: the lab side ----------
async function exportLab() {
  process.env.LAB_OFFLINE = "1";
  const L = (p) => import(join(LAB, p));
  const { readSelection, loadQuestions, splitOfSet } = await L("src/splits.mjs");
  const { seededSample, compareServed, servedFromEntries } = await L("src/parity.mjs");
  const { loadVariant, variantDeps } = await L("src/variant-arm.mjs");
  const { loadManifest, loadHaystack } = await L("src/arms.mjs");
  const { charsOver4, createEmbedder } = await L("src/store.mjs");
  const va = await L("src/variant-api.mjs");
  const rk = await L(`variants/${VARIANT}/ranker.mjs`);
  const units = await import(join(REPO, "apps/cloud/src/lib/memory/raw-units/units.ts"));

  const sel = readSelection();
  const sets = [...sel.dev, "multi-dev"];
  for (const s of sets) if (splitOfSet(s, sel) !== "dev") throw new Error(`refusing non-dev set ${s}`);
  const qs = sets.flatMap((s) => loadQuestions(s).map((q) => ({ ...q, _set: s }))).sort((a, b) => (a.qid < b.qid ? -1 : 1));
  const sample = seededSample(qs, N, SEED);
  const usedSets = [...new Set(sample.map((q) => q._set))];

  const emb = createEmbedder();
  const resolved = await loadVariant(VARIANT);
  const cur = { pre: null, entries: null, pools: null };
  const orig = resolved.slots.ranker.default;
  const origFmt = resolved.slots.formatter.default;
  const wrapped = {
    ...resolved,
    slots: {
      ...resolved.slots,
      ranker: {
        ...resolved.slots.ranker,
        default: (sv, query, api) => {
          // The front part of the lab ranker (variants/I33-i24-cue-off/ranker.mjs default export), to capture its inputs to the raw side.
          const cfg = { ...api.config, limit: va.B0_CONFIG.limit };
          const cuts = va.FAMILY_CUTS[cfg.family];
          const notChunk = (r) => r.kind !== "chunk";
          const recView = { ...sv, records: sv.records.filter(notChunk) };
          const recPost = { ...sv.postStore, records: sv.postStore.records.filter(notChunk) };
          const candidates = va.scoredCandidates(recView, query, api.qvec, { pMinSimilarity: cuts ? cuts.sql_cut : null, limit: va.rpcLimit(query, cfg.limit), embeddingModel: cfg.family });
          const ranked = va.postProcess(recPost, query, candidates, { ...cfg, queryEmbedded: api.qvec != null }).ranked;
          const records = ranked.slice(0, cfg.limit);
          const cards = rk.newestFirst(rk.buildCards(ranked).slice(0, cfg.limit));
          const sim = new Map(candidates.map((c) => [c.id, typeof c.similarity === "number" ? c.similarity : null]));
          const byId = new Map(ranked.map((r) => [r.id, r]));
          const store = sv.postStore ?? sv;
          cur.pre = {
            records: records.map((r) => ({ id: r.id, similarity: sim.get(r.id) ?? null })),
            cards: cards.map((c) => {
              const members = c._members ?? [c.id];
              return { text: rk.cardText(c), ref: c.ref ?? null, paths: c.paths ?? [], members, vec_ids: members.filter((id) => byId.has(id) && store.vectors?.get(id)) };
            }),
          };
          try {
            // The lab's three pools and their gated lists (ids), for the stage-by-stage classification.
            const isU = (u) => (r) => r.kind === "chunk" && r.unit === u;
            const sub = (f) => ({ ...sv, records: sv.records.filter(f) });
            const pool1 = va.scoredCandidates(sub(isU("c700")), query, api.qvec, { pMinSimilarity: cuts.sql_cut, limit: 60, embeddingModel: cfg.family });
            const anchors = va.extractQueryAnchors(query);
            const g1 = rk.chunksAbstain(cards, pool1, anchors) ? [] : pool1.filter((c) => rk.passesChunkFloor(c, anchors));
            const trig = rk.triggered(records, query, cuts);
            const pool2 = va.scoredCandidates(sub(isU("win")), query, api.qvec, { pMinSimilarity: cuts.sql_cut, limit: 160, embeddingModel: cfg.family });
            const cands3 = va.scoredCandidates(sub(isU("turn")), query, api.qvec, { pMinSimilarity: cuts.sql_cut, limit: Number.MAX_SAFE_INTEGER, embeddingModel: cfg.family });
            const nat3 = rk.nativeScores(cands3, query);
            const ixT = rk.bm25Index((sv.postStore ?? sv).records.filter((r) => r.kind === "chunk" && r.unit === "turn"));
            const qts = [...new Set(rk.terms(query))];
            const dbgTerms = { n: ixT.N, qterms: qts, df: Object.fromEntries(qts.map((t) => [t, ixT.df.get(t) ?? 0])) };
            const dbg3 = { n: cands3.length, nat: cands3.filter((c) => (nat3.get(c.id) ?? 0) > 0).map((c) => [c.id, nat3.get(c.id), c.similarity ?? null]) };
            const pool3 = rk.turnPool(va.scoredCandidates(sub(isU("turn")), query, api.qvec, { pMinSimilarity: cuts.sql_cut, limit: Number.MAX_SAFE_INTEGER, embeddingModel: cfg.family }), null, [], cuts.sql_cut, rk.RRF_K, query);
            const ids = (l) => l.map((c) => c.id);
            const rowOf = (c) => ({ id: c.id, lex: c.lex_score ?? null, hits: c.lex_hits ?? null, sim: c.similarity ?? null });
            cur.pools = { trig, p1: ids(pool1), g1: ids(g1), p2: ids(pool2), p3: ids(pool3), dbg3, dbgTerms, rows: { p1: pool1.map(rowOf), p2: pool2.map(rowOf), p3: pool3.map(rowOf) } };
          } catch (e) {
            cur.pools = { error: String(e) };
          }
          return orig(sv, query, api);
        },
      },
      formatter: { ...resolved.slots.formatter, default: async (rows, api) => (cur.entries = await origFmt(rows, api)) },
    },
  };
  const deps = variantDeps(wrapped, { embedder: emb });
  const noLlm = Object.freeze({ run: async () => { throw new Error("parity-product: LLM disabled"); } });

  const labOut = [];
  const setInfo = {};
  let unitMismatch = 0;
  let unitVecMismatch = 0;
  let unitTotal = 0;
  const kindTotal = {};
  const kindDiff = {};
  const kindIds = {};
  const vecTotal = {};
  const vecMissing = {};
  const vecMissIds = {};
  for (const set of usedSets) {
    const manifest = loadManifest(set, "small");
    const sessions = loadHaystack(manifest);
    const ctx = { manifest, sessions, tokenizer: charsOver4, embedder: deps.embedder, runner: noLlm, dryRun: false, extractFn: deps.extractFn, promptText: deps.promptText, noTimes: true };
    const prep = await deps.prepareArm("B0", ctx, { ...deps.armConfig, tokenBudget: BUDGET });
    const store = prep.store;
    // Sessions and the product's units for them; vectors from the lab's embed cache, keyed by the product's own unit text.
    const sess = [];
    const unitTexts = [];
    const labRow = new Map(store.records.filter((r) => r.kind === "chunk").map((r) => [r.id, r]));
    for (const s of sessions.values()) {
      const turns = s.turns.map((t) => ({ idx: t.idx, role: t.role, kind: t.kind, text: t.text ?? null }));
      const us = units.buildRawUnits(turns);
      const id8 = s.id.slice(0, 8);
      for (const u of us) {
        unitTexts.push(`search_document: ${u.text}`); // the lab serves from the I1 alias vectors: document-prefixed text
        const lid = u.unit === "c700" ? `chunk-${id8}-${u.ord}` : u.unit === "win" ? `win-${id8}-${u.ord}` : `turn-${id8}-${u.turn_idx}`;
        const row = labRow.get(lid);
        unitTotal++;
        if (!row || String(row.text) !== u.text) unitMismatch++;
        // Every unit kind, and the turn rows' full_text (the lexical field of R3).
        const kind = u.unit;
        kindTotal[kind] = (kindTotal[kind] ?? 0) + 1;
        if (!row || String(row.text) !== u.text || (kind === "turn" && String(row.full_text ?? "") !== String(u.full_text ?? ""))) {
          kindDiff[kind] = (kindDiff[kind] ?? 0) + 1;
          (kindIds[kind] ??= []).push(lid);
        }
        u._lid = lid;
      }
      sess.push({ id: s.id, started_at: s.meta.started_at ?? null, ended_at: s.meta.ended_at ?? null, title: s.meta.short_title ?? s.meta.title ?? s.meta.session_title ?? null, git_branch: s.meta.git_branch ?? null, turns, n_units: us.length, lids: us.map((u) => u._lid) });
    }
    const vecs = await emb.embedMany(unitTexts);
    let vi = 0;
    for (const s of sess) {
      for (const lid of s.lids) {
        const lv = prep.aliasVectors?.get(lid)?.[0] ?? store.vectors.get(lid);
        const v = vecs[vi++];
        const kd = lid.split("-")[0];
        vecTotal[kd] = (vecTotal[kd] ?? 0) + 1;
        if (!lv) {
          vecMissing[kd] = (vecMissing[kd] ?? 0) + 1;
          (vecMissIds[kd] ??= []).push(lid);
        }
        if (lv) {
          let d = 0;
          for (let i = 0; i < v.length; i++) d += v[i] * lv[i];
          const n1 = Math.hypot(...v), n2 = Math.hypot(...lv);
          if (d / (n1 * n2) < 0.9999) unitVecMismatch++;
        }
      }
    }
    writeFileSync(W(`set-${set}.units.vec`), Buffer.concat(vecs.map(f32)));
    const recs = store.records.filter((r) => r.kind !== "chunk");
    writeFileSync(W(`set-${set}.rec.vec`), Buffer.concat(recs.map((r) => f32(prep.aliasVectors?.get(r.id)?.[0] ?? store.vectors.get(r.id) ?? new Array(768).fill(0)))));
    setInfo[set] = { sessions: sess.map(({ lids, ...r }) => ({ ...r, lid_count: lids.length })), records: recs.map(({ ...r }) => r), recordVecMissing: recs.filter((r) => !store.vectors.get(r.id)).length, lids: sess.map((s) => s.lids), dim: 768 };
    writeFileSync(W(`set-${set}.json`), JSON.stringify(setInfo[set]));
    for (const q of sample.filter((x) => x._set === set)) {
      cur.pre = null;
      cur.pools = null;
      cur.entries = null;
      const r = await deps.serveArm(prep, q, ctx);
      const entries = cur.entries ?? [];
      const served = servedFromEntries(entries, r.servedItems.length, charsOver4);
      const all = servedFromEntries(entries, entries.length, charsOver4);
      const qvec = await deps.embedder.embed(q.question);
      const qvecRaw = await emb.embed(q.question);
      labOut.push({ qid: q.qid, set, servedText: r.servedText, query: q.question, qvec, qvecRaw, pre: cur.pre, pools: cur.pools, lines: all.lines, packedCount: served.lines.length, packed: served });
    }
    console.error(`exported ${set}: ${sess.length} sessions, ${unitTexts.length} units, ${recs.length} records`);
  }
  writeFileSync(W("lab.json"), JSON.stringify({ sets: usedSets, seed: SEED, n: N, budget: BUDGET, unitTotal, unitMismatch, unitVecMismatch, questions: labOut }));
  writeFileSync(W("unit-kind-diff.json"), JSON.stringify({ kindTotal, kindDiff, kindIds, vecTotal, vecMissing, vecMissIds }));
  console.error(`unit text (turn: text and full_text) differences by kind: ${JSON.stringify(kindDiff)} of ${JSON.stringify(kindTotal)}`);
  console.error(`lab rows without a cached vector by kind (their lab similarity is null): ${JSON.stringify(vecMissing)} of ${JSON.stringify(vecTotal)}`);
  console.error(`exported ${labOut.length} questions; units ${unitTotal}, text differs from lab chunk rows ${unitMismatch}, vector differs ${unitVecMismatch}`);
}

// ---------- runner dispatch ----------
function runner(mode, extra = {}) {
  const url = arg("url");
  if (!url) throw new Error("--url required");
  const r = spawnSync(
    "npx",
    ["vitest", "run", "--config", join(HERE, "parity-product.vitest.config.mts")],
    { cwd: REPO, stdio: "inherit", env: { ...process.env, PARITY_MODE: mode, PARITY_URL: url, PARITY_WORK: WORK, PARITY_HERE: HERE, ...extra } },
  );
  if (r.status !== 0) process.exit(r.status ?? 1);
}

// ---------- compare ----------
const pct = (a, p) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] : NaN;
};
const fmt = (x) => (Number.isFinite(x) ? x.toFixed(1) : "n/a");


// Served-turn agreement, independent of how each line is worded: the set of (session, turn) keys the packed raw lines
// cover, their overlap with the lab's (recall = share of the lab's keys the product also serves; jaccard), and the rank
// correlation (Spearman) of the shared keys' first-appearance order.
const turnKeys = (lines) => {
  const out = [];
  const seen = new Set();
  for (const l of lines) {
    if (l.type !== "raw") continue;
    const [a, b] = l.span;
    for (let t = a; t <= b && t - a < 200; t++) {
      const k = `${l.id8}:${t}`;
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
  }
  return out;
};
const spearman = (xs, ys) => {
  const n = xs.length;
  if (n < 2) return null;
  const rk = (v) => {
    const idx = v.map((x, i) => [x, i]).sort((p, q) => p[0] - q[0]);
    const r = new Array(n);
    idx.forEach(([, i], j) => (r[i] = j));
    return r;
  };
  const a = rk(xs), b = rk(ys);
  let d2 = 0;
  for (let i = 0; i < n; i++) d2 += (a[i] - b[i]) ** 2;
  return 1 - (6 * d2) / (n * (n * n - 1));
};
const keyAgreement = (labLines, prodLines) => {
  const lk = turnKeys(labLines), pk = turnKeys(prodLines);
  const ps = new Set(pk), ls = new Set(lk);
  const shared = lk.filter((k) => ps.has(k));
  const union = new Set([...lk, ...pk]).size;
  const rho = spearman(shared.map((k) => lk.indexOf(k)), shared.map((k) => pk.indexOf(k)));
  return { lab: lk.length, prod: pk.length, shared: shared.length, recall: lk.length ? shared.length / lk.length : 1, jaccard: union ? shared.length / union : 1, rho, onlyProd: pk.filter((k) => !ls.has(k)).length };
};
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };

async function compare() {
  process.env.LAB_OFFLINE = "1";
  const { compareServed } = await import(join(LAB, "src/parity.mjs"));
  const { charsOver4 } = await import(join(LAB, "src/store.mjs"));
  const lab = JSON.parse(readFileSync(W("lab.json"), "utf8"));
  const prod = JSON.parse(readFileSync(W("product.json"), "utf8"));
  const pack = (lines) => {
    const kept = [];
    let tokens = 0;
    for (const l of lines) {
      const t = charsOver4([...kept, l.text].join("\n"));
      if (t > BUDGET) break;
      kept.push(l);
      tokens = t;
    }
    return { lines: kept, packedTokens: tokens };
  };
  const raw = (ls) => ls.filter((l) => l.type === "raw");
  const rows = [];
  const diffNotes = [];
  for (const lq of lab.questions) {
    const pq = prod.questions.find((x) => x.qid === lq.qid);
    const labFused = lq.lines; // the lab's fused list before packing
    const A = compareServed(pack(raw(labFused)), pack(raw(pq.a.lines)));
    const B = compareServed(pack(labFused), pack(pq.b.lines));
    const BR = compareServed(pack(raw(labFused)), pack(raw(pq.b.lines)));
    const labKeys = (ls) => pack(ls).lines.map((l) => `${l.type}:${l.id8}:${l.span.join("-")}`);
    const cardDiff = JSON.stringify(labKeys(labFused).filter((k) => !k.startsWith("raw"))) !== JSON.stringify(pack(pq.b.lines).lines.map((l) => `${l.type}:${l.id8}:${l.span.join("-")}`).filter((k) => !k.startsWith("raw")));
    const kaA = keyAgreement(pack(raw(labFused)).lines, pack(raw(pq.a.lines)).lines);
    const kaBR = keyAgreement(pack(raw(labFused)).lines, pack(raw(pq.b.lines)).lines);
    rows.push({ qid: lq.qid, set: lq.set, kaA, kaBR, a: A, b: B, br: BR, labRaw: pack(raw(labFused)).lines.length, prodRaw: pack(raw(pq.a.lines)).lines.length, bRawProd: pack(raw(pq.b.lines)).lines.length, labLines: pack(labFused).lines.length, prodLines: pack(pq.b.lines).lines.length, cardDiff, unmapped: pq.unmapped });
    for (const [name, c] of [["a", A], ["b-raw", BR]]) if (!c.match) diffNotes.push({ qid: lq.qid, which: name, ...c });
  }
  const ok = (c) => (c.match ? "OK" : `DIFF ${c.field}${c.index != null ? `@${c.index}` : ""}`);
  const cnt = (k) => rows.filter((r) => r[k].match).length;
  const L = [];
  L.push("# PR 4 slice 4b-2b: product vs lab parity on the dev sample", "");
  L.push(`Dev sample: ${rows.length} questions, seed ${lab.seed}, sets ${lab.sets.join(", ")}. Budget ${BUDGET} tokens, chars/4, lines packed whole in order, stop at the first misfit (lab compareServed, imported from the lab checkout).`);
  L.push(`Unit generation: ${lab.unitTotal} product units built; ${lab.unitMismatch} differ in text from the lab's chunk row of the same id; ${lab.unitVecMismatch} cached lab vectors differ from the vector of the product's unit text.`, "");
  L.push("## Parity", "");
  L.push(`- (a) raw lines only, lab records and cards fed to the product raw path: ${cnt("a")} of ${rows.length}`);
  L.push(`- (b) full lines, real memorySearch end to end (compact-JSON record lines vs lab cards): ${cnt("b")} of ${rows.length}`);
  L.push(`- (b-raw) raw lines only, taken from the real memorySearch run: ${cnt("br")} of ${rows.length}`, "");
  const f2 = (x) => (x == null || !Number.isFinite(x) ? "n/a" : x.toFixed(2));
  const sum = (key, name) => {
    const rec = rows.map((r) => r[key].recall), jac = rows.map((r) => r[key].jaccard), rho = rows.map((r) => r[key].rho).filter((x) => x != null);
    return `- ${name}: served (session, turn) keys, lab keys also served by the product (recall) min ${f2(Math.min(...rec))} median ${f2(med(rec))}; jaccard min ${f2(Math.min(...jac))} median ${f2(med(jac))}; Spearman of shared keys min ${f2(Math.min(...rho))} median ${f2(med(rho))} (n=${rho.length})`;
  };
  L.push("## Served-key agreement (wording-independent)", "", sum("kaA", "(a)"), sum("kaBR", "(b-raw)"), "");
  L.push("| qid | set | (a) raw | (b) full | (b-raw) | lab raw / prod raw (a) | lab lines / prod lines (b) | card/record differ | (a) key recall | (a) jaccard | (a) rho |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|");
  for (const r of rows) L.push(`| ${r.qid} | ${r.set} | ${ok(r.a)} | ${ok(r.b)} | ${ok(r.br)} | ${r.labRaw} / ${r.prodRaw} | ${r.labLines} / ${r.prodLines} | ${r.cardDiff ? "yes" : "no"} | ${f2(r.kaA.recall)} | ${f2(r.kaA.jaccard)} | ${f2(r.kaA.rho)} |`);
  L.push("", "## First differing fields (keys only)", "");
  for (const d of diffNotes) L.push(`- ${d.qid} (${d.which}): ${d.field}${d.index != null ? ` at line ${d.index}` : ""}${d.a != null ? `, lab ${d.a} vs product ${d.b}` : ""}`);
  if (!diffNotes.length) L.push("- none");
  writeFileSync(arg("out", W("pr4-parity-result.md")), `${L.join("\n")}\n`);
  writeFileSync(W("compare.json"), JSON.stringify({ rows, diffNotes }));
  console.log(L.slice(0, 14).join("\n"));
}

// ---------- query embedding timing (local Ollama, reported separately) ----------
async function embedTiming() {
  const lab = JSON.parse(readFileSync(W("lab.json"), "utf8"));
  const url = process.env.LAB_OLLAMA_URL ?? "http://localhost:11434";
  const times = [];
  for (let rep = 0; rep < 2; rep++) {
    for (const q of lab.questions) {
      const t = performance.now();
      const res = await fetch(`${url}/api/embed`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "nomic-embed-text", input: [QUERY_PREFIX + q.query] }) });
      await res.json();
      if (rep > 0) times.push(performance.now() - t);
    }
  }
  writeFileSync(W("embed-timing.json"), JSON.stringify({ n: times.length, p50: pct(times, 50), p95: pct(times, 95) }));
  console.log(`query embedding (local Ollama nomic, warm): n=${times.length} p50 ${fmt(pct(times, 50))} ms p95 ${fmt(pct(times, 95))} ms`);
}

switch (cmd) {
  case "export":
    await exportLab();
    break;
  case "load":
    runner("load");
    break;
  case "run":
    runner("run");
    break;
  case "bench":
    runner("bench", { PARITY_STORE: arg("store", "dev"), PARITY_QUERIES: arg("queries", ""), PARITY_BENCH_OUT: arg("out", W("bench.json")) });
    break;
  case "compare":
    await compare();
    break;
  case "embed-timing":
    await embedTiming();
    break;
  default:
    console.error(`unknown command ${cmd}`);
    process.exit(2);
}
