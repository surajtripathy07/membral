// Regenerates lab-fixtures.json by running the LAB's own I33 ranker (extract-search-lab
// variants/I33-i24-cue-off/ranker.mjs) and its formatter on small synthetic (fictional, CodeHub) sessions. The
// TypeScript port (../../*.ts) must reproduce every `expected` value.
//
//   node generate-i33-fixtures.mjs /path/to/extract-search-lab > lab-fixtures.json
//
// What is real lab output: every pure helper called directly (passesFloor, triggered, subtract, terms, pieces, snippet,
// expandWindow, coverChunk, packToBudget, chunkLine, fuse, idf) and, for the walks, the lab's `default` ranker run on a
// hand-built store (no cards: records stay out; with cards: two records of one item). What is composed here from the lab's
// exported primitives, copying ranker.mjs:612-629 line for line: the pools and their gating (the product gets its pools
// from SQL, so the TS tests start from the pre-gate pools and must reproduce the gated lists).
// Vectors are synthetic unit vectors [cos t, sin t, 0]; the query vector is [1, 0, 0], so a row's similarity is cos t.
import { pathToFileURL } from "node:url";

const lab = process.argv[2];
if (!lab) throw new Error("usage: node generate-i33-fixtures.mjs <path to extract-search-lab>");
const imp = (p) => import(pathToFileURL(`${lab}/${p}`).href);
const R = await imp("variants/I33-i24-cue-off/ranker.mjs");
const { default: ranker } = R;
const { default: formatter, chunkLine } = await imp("variants/I17-cards-over-chunks/formatter.mjs");
const { default: recordPostProcess } = await imp("variants/I24-ensemble-fusion/recordPostProcess.mjs");
const api0 = await imp("src/variant-api.mjs");
const { B0_CONFIG, cosine, extractQueryAnchors, scoredCandidates } = api0;
const { buildB0Store } = await imp("src/b0.mjs");
const { packToBudget } = await imp("src/search.mjs");
const { charsOver4 } = await imp("src/store.mjs");

const CUTS = { sem_floor: 0.66, mixed_sem_floor: 0.61, sql_cut: 0.51, lex_min_hits: 4 };
const RAW_CUTS = { ...CUTS, chunk_floor: R.CHUNK_FLOOR, chunk_abstain: R.CHUNK_ABSTAIN };
const words = "the CodeHub sync client retries each failed push with exponential backoff and jitter so the nightly export never floods the queue".split(" ");
const prose = (n, seed = 0) => Array.from({ length: n }, (_, i) => words[(i * 7 + seed) % words.length]).join(" ");
const vecAt = (t) => [Math.cos(t), Math.sin(t), 0];
const hash = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 9973, 7);
// Three angle clusters (similarity about 0.99, 0.80, 0.36 to the query) with a small spread, so some rows are within
// cosine 0.86 of each other (cover test) and some are not.
const thetaOf = (id) => [0.1, 0.7, 1.2][hash(id) % 3] + ((hash(id) >> 3) % 5) * 0.02;
const QVEC = [1, 0, 0];
const TIME = { aaaa1111: "2026-10-01T10:00:00.000Z", bbbb2222: "2026-10-03T09:30:00.000Z" };

// ---------- sessions ----------
const sessionA = [
  { idx: 0, role: "user", kind: "prose", text: "Why does the CodeHub sync client retry without backoff? Look at src/sync/client.ts." },
  { idx: 1, role: "assistant", kind: "prose", text: `${prose(110, 1)}. Retry backoff with jitter is the fix.\n\n${prose(70, 3)}: backoff delay doubles up to thirty seconds.\n${prose(80, 5)}.` },
  { idx: 2, role: "assistant", kind: "tool_use", text: "Read src/sync/client.ts" },
  { idx: 3, role: "user", kind: "tool_result", text: `export async function pushWithRetry() {\n${"  await push(); // retry backoff jitter\n".repeat(30)}}` },
  { idx: 4, role: "assistant", kind: "prose", text: `The retry loop in pushWithRetry had no backoff. ${prose(70, 2)}. Jitter spreads the retries. ${prose(60, 4)}. The nightly export reuses the same client, so one fix covers both. ${prose(40, 6)}.` },
  { idx: 5, role: "user", kind: "prose", text: "Add exponential backoff with jitter to the retry loop." },
  { idx: 6, role: "assistant", kind: "prose", text: "Done: retry now doubles the delay up to 30 seconds and adds jitter." },
];
const sessionB = [
  { idx: 0, role: "user", kind: "prose", text: "The nightly export drops rows when the queue is full." },
  { idx: 1, role: "assistant", kind: "prose", text: `The export writes rows through the sync client. ${prose(45, 2)}. When the queue is full the push is retried without backoff.` },
  { idx: 2, role: "assistant", kind: "prose", text: "I will route the export through pushWithRetry so the backoff applies." },
  { idx: 3, role: "user", kind: "prose", text: "Good, also log each retry attempt." },
];

async function unitsOf(id8, turns) {
  const recs = await recordPostProcess([], { turns: () => turns, meta: { id8 } });
  return recs.map((r) => ({ ...r, session_time_iso: TIME[id8] }));
}
const rowsA = await unitsOf("aaaa1111", sessionA);
const rowsB = await unitsOf("bbbb2222", sessionB);
const chunkRows = [...rowsA, ...rowsB];
const isTurn = (r) => r.unit === "turn";

// ---------- store + pools (ranker.mjs:612-629, copied) ----------
const toCand = (r, scored) => ({
  id: r.id,
  id8: r.id8,
  unit: r.unit,
  turn_idx: r.turn_idx,
  turn_from: r.chunk_turns[0],
  turn_to: r.chunk_turns[1],
  parts: r.parts ?? null,
  win: r.win ?? null,
  text: r.text,
  full_text: r.full_text ?? null,
  similarity: scored.similarity,
  lex_hits: scored.lex_hits,
  query_lexemes: scored.query_lexemes,
  session_time_iso: r.session_time_iso ?? null,
});
const sv = (view, keep) => ({ ...view, records: view.records.filter(keep) });
const strongHit = (row, anchors) => {
  const t = String(row.text ?? "").toLowerCase();
  return anchors.some((a) => (a.kind === "path" || a.kind === "ref") && a.value && t.includes(String(a.value).toLowerCase()));
};

function makeRecord(id, id8, ref, text, created) {
  return { id, session_id: `${id8}-session`, id8, kind: "decision", text, quote: null, thread: null, session_title: "", ref, ref_kind: null, paths: [], turn_idx: 5, turn_role: "assistant", agent_id: null, source: "agent", verified: true, durable: false, confidence: 1, created_at: created, observed_at: created, session_time: created, session_time_iso: created, supersedes: null, retired_at: null, code_project_id: null, seen_in: 1 };
}

async function walk(name, { query, total, records = [], vectorOf = {}, unitTheta = {} }) {
  const all = [...records, ...chunkRows];
  const vectors = new Map(all.map((r) => [r.id, vecAt(vectorOf[r.id] ?? unitTheta[r.unit] ?? thetaOf(r.id))]));
  const store = await buildB0Store(all, { vectors });
  const view = { ...store, postStore: store };
  const api = { config: { ...B0_CONFIG, limit: total }, qvec: QVEC };
  const out = await ranker(view, query, api);

  // pools + gating, copied from ranker.mjs:603-629 (cards from the lab's own code path are read back from `out`)
  const cards = out.filter((r) => r.kind !== "chunk");
  const anchors = extractQueryAnchors(query);
  const pool1 = scoredCandidates(sv(view, (r) => r.kind === "chunk" && r.unit === "c700"), query, QVEC, { pMinSimilarity: CUTS.sql_cut, limit: 60, embeddingModel: B0_CONFIG.family });
  const r1 = R.chunksAbstain(cards, pool1, anchors) ? [] : pool1.filter((c) => R.passesChunkFloor(c, anchors));
  const recTop = scoredCandidates(sv(view, (r) => r.kind !== "chunk"), query, QVEC, { pMinSimilarity: CUTS.sql_cut, limit: 30, embeddingModel: B0_CONFIG.family });
  const trig = R.triggered(recTop.slice(0, total), query, CUTS);
  const pool2 = scoredCandidates(sv(view, (r) => r.kind === "chunk" && r.unit === "win"), query, QVEC, { pMinSimilarity: CUTS.sql_cut, limit: R.WIN_POOL, embeddingModel: B0_CONFIG.family });
  const r2 = trig ? pool2.filter((c) => R.passesFloor(c, CUTS) || strongHit(c, anchors)) : [];
  const turnRecs = store.records.filter(isTurn);
  const ix = R.bm25Index(turnRecs);
  const qterms = [...new Set(R.terms(query))];
  const pool3 = R.turnPool(scoredCandidates(sv(view, (r) => r.kind === "chunk" && r.unit === "turn"), query, QVEC, { pMinSimilarity: CUTS.sql_cut, limit: Number.MAX_SAFE_INTEGER, embeddingModel: B0_CONFIG.family }), ix, qterms, CUTS.sql_cut);
  const r3 = trig ? pool3.filter((c) => R.passesFloor(c, CUTS) || strongHit({ text: String(c.full_text ?? c.text) }, anchors)) : [];

  // The cards' state as the TS walk receives it
  const served = cards.map((c) => ({
    text: R.cardText(c),
    ref: c.ref ?? null,
    paths: c.paths ?? [],
    vec_ids: (c._members ?? [c.id]).filter((id) => vectors.has(id)),
  }));
  const recVecIds = [...new Set(served.flatMap((c) => c.vec_ids))];
  const units = [...new Set([...r1, ...r2, ...r3].map((c) => c.id))].sort();
  const coverRows = [];
  for (const a of units)
    for (const b of units) if (a < b) {
      const cs = cosine(vectors.get(a), vectors.get(b));
      if (cs >= R.COVER_COSINE) coverRows.push({ kind: "unit_unit", a_id: a, b_id: b, cosine: cs, turn_idx: null, turn_text: null });
    }
  for (const a of units)
    for (const b of recVecIds) {
      const cs = cosine(vectors.get(a), vectors.get(b));
      if (cs >= R.COVER_COSINE) coverRows.push({ kind: "unit_record", a_id: a, b_id: b, cosine: cs, turn_idx: null, turn_text: null });
    }

  const sessions = chunkRows
    .filter((r) => r.turn_text != null)
    .map((r) => ({ id8: r.id8, turn_idx: r.turn_idx, turn_text: r.turn_text, turn_len: r.turn_len ?? null }));
  const df = {};
  for (const t of qterms) df[t] = ix.df.get(t) ?? 0;
  const raw = out.filter((r) => r.kind === "chunk");
  return {
    name,
    query,
    total,
    anchors,
    cuts: RAW_CUTS,
    records: recTop.slice(0, total).map((r) => ({ similarity: r.similarity })),
    card_count: cards.length,
    cards: served,
    pools: { r1: pool1.map((c) => toCand(c, c)), r2: pool2.map((c) => toCand(c, c)), r3: pool3.map((c) => toCand(c, c)) },
    sessions,
    term_stats: { n: ix.N, df },
    qterms,
    cover_rows: coverRows,
    expected: {
      trigger: trig,
      gated: { r1: r1.map((c) => c.id), r2: r2.map((c) => c.id), r3: r3.map((c) => c.id) },
      raw: raw.map((r) => ({ id: r.id, text: r.text, shrunk: r._shrunk, chunk_turns: r.chunk_turns, line: chunkLine(r) })),
      final_order: out.map((r) => r.id),
      final_cards: cards.map((c) => c.id),
    },
  };
}

const recs = [
  makeRecord("rec-old", "aaaa1111", "#12", "Retry in pushWithRetry has no backoff; keep it as is for now.", "2026-09-29T08:00:00.000Z"),
  makeRecord("rec-new", "aaaa1111", "#12", "Retry in pushWithRetry now uses exponential backoff with jitter.", "2026-10-01T11:00:00.000Z"),
];

const walks = [];
walks.push(await walk("no-cards-ensemble", { query: "retry backoff jitter in the sync client", total: 6 }));
walks.push(await walk("with-card-cover", { query: "retry backoff jitter in the sync client", total: 6, records: recs, vectorOf: { "rec-old": 0.2, "rec-new": 0.18 } }));
// chunks at similarity 0.65 (above the chunk floor 0.626, below the abstain gate 0.689) with no card: R1 abstains; windows and
// whole turns at 0.75 clear the records floor 0.66 and still serve.
walks.push(await walk("r1-abstains-r23-serve", { query: "retry backoff jitter in the sync client", total: 6, unitTheta: { c700: Math.acos(0.65), win: Math.acos(0.75), turn: Math.acos(0.75) } }));
// nothing clears any floor: no raw at all
walks.push(await walk("nothing-passes", { query: "quarterly invoice reconciliation for the billing team", total: 6, unitTheta: { c700: Math.acos(0.6), win: Math.acos(0.6), turn: Math.acos(0.6) } }));
walks.push(await walk("anchor-trigger-limit-3", { query: "what changed in src/sync/client.ts", total: 3 }));

// ---------- pure helpers, called directly ----------
const floorRows = [];
for (const similarity of [null, 0.7, 0.62, 0.5])
  for (const [hits, lex] of [[0, 0], [1, 4], [2, 4], [3, 5], [4, 6], [2, 2], [1, 1]])
    for (const cuts of [CUTS, { ...CUTS, lex_min_hits: 0 }]) {
      const row = { similarity, lex_hits: hits, query_lexemes: lex };
      floorRows.push({ row, cuts, expected: R.passesFloor(row, cuts) });
    }
const triggers = [];
for (const [recordsSims, anchorCount] of [[[0.9, 0.8, 0.7], 0], [[0.9, 0.8, 0.7], 1], [[0.9, 0.8], 0], [[0.5, 0.9, 0.9], 0], [[0.66, 0.1, 0.1], 0], [[null, 0.9, 0.9], 0]]) {
  const records = recordsSims.map((similarity) => ({ similarity }));
  const query = anchorCount ? "see src/lib/x.ts" : "plain words only";
  triggers.push({ records, anchor_count: anchorCount, expected: R.triggered(records, query, CUTS) });
}

const subtracts = [
  [[0, 10], []], [[0, 10], [[2, 4]]], [[0, 10], [[0, 10]]], [[0, 10], [[0, 3], [5, 12]]], [[5, 9], [[0, 6], [8, 20]]], [[0, 10], [[20, 30]]],
].map(([iv, served]) => ({ interval: iv, served, expected: R.subtract(iv, served) }));

const termCases = ["Retrying failed pushes: the QUEUES' jitter, as_is & #12 done.", "ss class bus is a Is", "I a go"].map((text) => ({ text, expected: R.terms(text) }));
const pieceTexts = ["One sentence. Two sentences here! Third?\nNew line without end", `${"word ".repeat(120)}end.`, "x".repeat(700), ""];
const pieceCases = pieceTexts.map((text) => ({ text, expected: R.pieces(text) }));

// snippets: df/N from a hand-built turn index
const snipTurns = sessionA.map((t) => ({ id: `t${t.idx}`, full_text: `${t.role}: ${t.text}` }));
const snipIx = R.bm25Index(snipTurns);
const snipQ = [...new Set(R.terms("retry backoff jitter in the sync client"))];
const snippetCases = [
  ...snipTurns.map((t) => t.full_text),
  `assistant: ${"alpha beta gamma. ".repeat(60)}the retry backoff needs jitter here. ${"delta epsilon zeta. ".repeat(60)}`,
  `${"no label and no sentence end ".repeat(40)}`,
].map((full) => ({ full, expected: R.snippet(full, snipIx, snipQ) }));
const snipStats = { n: snipIx.N, df: Object.fromEntries(snipQ.map((t) => [t, snipIx.df.get(t) ?? 0])), idf: Object.fromEntries(snipQ.map((t) => [t, R.idf(snipIx, t)])) };

// expandWindow on session A with a growing served-span map
const storedA = rowsA.filter((r) => r.turn_text != null).map((r) => ({ id8: r.id8, turn_idx: r.turn_idx, turn_text: r.turn_text, turn_len: r.turn_len ?? null }));
const sessA = R.sessionTurns(rowsA).get("aaaa1111");
const wins = rowsA.filter((r) => r.unit === "win");
const spans = new Map();
const expandCases = [];
for (const w of [wins[0], wins[2], wins[5], wins[5], wins[wins.length - 1], { ...wins[1], win: [0, 5000] }]) {
  const before = JSON.stringify([...spans]);
  const x = R.expandWindow(w, sessA, spans);
  expandCases.push({ win: { id8: w.id8, turn_idx: w.turn_idx, win: w.win, text: w.text }, spans_before: JSON.parse(before), expected: x, spans_after: [...spans] });
}
// a window whose session is unknown
const loneSpans = new Map();
const lone = { id8: "zzzz9999", turn_idx: 4, win: [0, 30], text: "a window without stored turn text" };
const loneCase = { win: lone, spans_before: [], expected: R.expandWindow(lone, undefined, loneSpans), spans_after: [...loneSpans] };
// elision: a turn longer than the stored cap shows "..." on its last piece
const capped = { order: [3], text: new Map([[3, "assistant: " + "stored text ".repeat(30)]]), len: new Map([[3, 99999]]) };
const cappedSpans = new Map();
const cappedWin = { id8: "cccc3333", turn_idx: 3, win: [0, 100], text: "assistant: stored text stored text" };
const cappedCase = { sess: { id8: "cccc3333", turn_idx: 3, turn_text: capped.text.get(3), turn_len: 99999 }, win: cappedWin, expected: R.expandWindow(cappedWin, capped, cappedSpans), spans_after: [...cappedSpans] };

// coverChunk
const tokensOf = (t) => R.coverChunk; // placeholder to keep the import used
void tokensOf;
const servedOf = (texts, idents = []) => {
  const { tokenSet } = api0;
  const s = { tokens: new Set(), idents: new Set(), vecs: [] };
  for (const t of texts) {
    for (const x of tokenSet(t)) s.tokens.add(x);
    for (const x of R.identifiers(t)) s.idents.add(x);
  }
  for (const i of idents) s.idents.add(i);
  return s;
};
const coverInputs = [
  { name: "contained", chunk: "the retry loop doubles the delay up to thirty seconds", served: ["the retry loop doubles the delay up to thirty seconds and adds jitter to every attempt"], vec: false },
  { name: "vector-covered", chunk: "something worded quite differently about waiting between attempts", served: ["unrelated served text"], vec: true },
  { name: "vector-covered-but-new-identifier", chunk: "waiting between attempts is set by pushWithRetry now", served: ["unrelated served text"], vec: true },
  { name: "shrunk-to-novel-sentences", chunk: "The retry loop doubles the delay. The retry loop adds jitter. The export uses cron_nightly_job every night.", served: ["The retry loop doubles the delay. The retry loop adds jitter."], vec: false },
  { name: "all-sentences-covered", chunk: "The retry loop doubles the delay. The retry loop adds jitter.", served: ["The retry loop doubles the delay. The retry loop adds jitter. Extra words so containment holds."], vec: false, forceNoContain: true },
  { name: "kept-whole", chunk: "A completely fresh point about queue sizes and limits, nothing served yet.", served: ["nothing related"], vec: false },
  { name: "empty-served", chunk: "Anything at all.", served: [], vec: false },
].map((c) => {
  const served = servedOf(c.served);
  // the lab compares vectors: a served vector at cosine 0.9 (covered) or 0.2 (not) to the chunk's
  const chunkVec = c.vec ? [1, 0, 0] : [1, 0, 0];
  served.vecs = [c.vec ? [0.9, Math.sqrt(1 - 0.81), 0] : [0.2, Math.sqrt(1 - 0.04), 0]];
  const res = R.coverChunk({ text: c.chunk }, chunkVec, served);
  return { name: c.name, chunk: c.chunk, served_texts: c.served, vec_covered: c.vec, expected: res };
});

// fuse (cards, raw) and packing
const fuseCase = { cards: ["c0", "c1", "c2"].map((id) => ({ id })), raw: ["r0", "r1", "r2", "r3"].map((id) => ({ id })) };
fuseCase.expected = R.fuse(fuseCase.cards, fuseCase.raw).map((x) => x.id);
const packLines = ["a".repeat(40), "b".repeat(40), "c".repeat(40), "d".repeat(8), "e".repeat(4)];
const packCases = [0, 10, 11, 20, 21, 31, 32, 100].map((budget) => {
  const p = packToBudget(packLines, budget, charsOver4);
  return { budget, expected: { lines: p.lines, tokens: p.tokens } };
});
const joinCase = { lines: ["x".repeat(7), "y".repeat(7)], budget: 4, expected: packToBudget(["x".repeat(7), "y".repeat(7)], 4, charsOver4) };
const rawRows = [
  { id8: "aaaa1111", chunk_turns: [2, 2], text: "one", _shrunk: false, session_time_iso: "2026-10-01T10:00:00.000Z" },
  { id8: "aaaa1111", chunk_turns: [2, 4], text: 'quote "x" and\nnewline', _shrunk: true, session_time_iso: null },
];
const lineCases = rawRows.map((r) => ({ row: { id8: r.id8, chunk_turns: r.chunk_turns, text: r.text, shrunk: r._shrunk, session_time_iso: r.session_time_iso }, expected: chunkLine({ ...r, kind: "chunk" }) }));

// fuseRaw / turnsOf direct
const fuseRawCase = {
  lists: [
    [{ id: "a", id8: "s1", parts: [[1, 0, 10], [2, 0, 5]], turn_from: 1, turn_to: 2 }, { id: "b", id8: "s1", parts: null, turn_from: 5, turn_to: 5 }],
    [{ id: "c", id8: "s1", parts: null, turn_from: 2, turn_to: 2 }, { id: "d", id8: "s2", parts: null, turn_from: 1, turn_to: 3 }],
    [{ id: "e", id8: "s1", parts: null, turn_from: 5, turn_to: 5 }, { id: "f", id8: "s1", parts: null, turn_from: 1, turn_to: 1 }],
  ],
};
fuseRawCase.expected = R.fuseRaw(fuseRawCase.lists.map((l) => l.map((x) => ({ ...x, chunk_turns: [x.turn_from, x.turn_to], turn_idx: x.turn_from })))).map(({ row, li }) => ({ id: row.id, li }));
fuseRawCase.turnsOf = fuseRawCase.lists.flat().map((x) => ({ id: x.id, expected: R.turnsOf({ ...x, chunk_turns: [x.turn_from, x.turn_to], turn_idx: x.turn_from }) }));

const fixtures = {
  generated_from: "extract-search-lab variants/I33-i24-cue-off/ranker.mjs, variants/I17-cards-over-chunks/formatter.mjs, src/search.mjs",
  cuts: RAW_CUTS,
  floors: floorRows,
  triggers,
  subtract: subtracts,
  terms: termCases,
  pieces: pieceCases,
  snippets: { stats: snipStats, qterms: snipQ, cases: snippetCases },
  expand: { stored: storedA, cases: expandCases, lone: loneCase, capped: cappedCase },
  cover: coverInputs,
  fuse: fuseCase,
  pack: { lines: packLines, cases: packCases, join: joinCase },
  raw_lines: lineCases,
  fuse_raw: fuseRawCase,
  walks,
};
console.log(JSON.stringify(fixtures));
