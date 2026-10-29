// THROWAWAY probe route (copied to apps/cloud/src/app/api/probe/route.ts for the B0 build, then removed). Not product code.
import { execSync } from "node:child_process";
import { monitorEventLoopDelay } from "node:perf_hooks";
import fs from "node:fs";
import { NextResponse } from "next/server";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const g = globalThis as unknown as { __db?: Promise<PGlite>; __ort?: { run: () => Promise<void> } };
const U = "00000000-0000-0000-0000-000000000001";
const P = "11111111-1111-1111-1111-111111111111";
const mb = (n: number) => Math.round(n / 1e6);
function foot(): number | null {
  try {
    const m = execSync(`footprint ${process.pid} --noCategories 2>/dev/null`).toString().match(/Footprint:\s+([\d.]+)\s*(KB|MB|GB)/);
    return m ? Math.round(Number(m[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 } as Record<string, number>)[m[2]]) : null;
  } catch { return null; }
}
const mem = () => ({ rssMB: mb(process.memoryUsage().rss), footprintMB: foot(), heapUsedMB: mb(process.memoryUsage().heapUsed), externalMB: mb(process.memoryUsage().external), arrayBuffersMB: mb(process.memoryUsage().arrayBuffers) });
function getDb() {
  g.__db ??= (async () => { const db = new PGlite({ dataDir: process.env.PROBE_DIR, extensions: { vector, pg_trgm, unaccent } }); await db.waitReady; await db.exec("set search_path = public, extensions"); return db; })();
  return g.__db;
}
const qv = () => "[" + Array.from({ length: 1536 }, () => Math.random()).join(",") + "]";
async function timed(label: string, fn: () => Promise<unknown>, reps = 1) {
  // monitorEventLoopDelay does NOT see PGlite's blocking on Node 26 (see eld-check.mjs: 6 ms reported over a 228 ms stall),
  // so the loop delay is a 5 ms setInterval's lateness; the histogram is reported alongside for reference.
  const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
  const gaps: number[] = []; let last = performance.now();
  const iv = setInterval(() => { const n = performance.now(); gaps.push(n - last - 5); last = n; }, 5);
  const lat: number[] = []; const t0 = performance.now();
  for (let i = 0; i < reps; i++) { const s = performance.now(); await fn(); lat.push(performance.now() - s); await new Promise((r) => setTimeout(r, 20)); }
  clearInterval(iv); h.disable(); lat.sort((a, b) => a - b); gaps.sort((a, b) => a - b);
  const pct = (a: number[], p: number) => +(a[Math.min(a.length - 1, Math.floor((a.length * p) / 100))] ?? 0).toFixed(1);
  const wall = performance.now() - t0; const stalled = gaps.filter((x) => x > 50).reduce((a, b) => a + b, 0);
  return { label, reps, wallMs: Math.round(wall), queryMs: { p50: +lat[Math.floor(lat.length / 2)].toFixed(1), max: +lat[lat.length - 1].toFixed(1) },
    loopDelayMs: { p50: pct(gaps, 50), p99: pct(gaps, 99), max: pct(gaps, 100) }, stallOver50msPct: +((100 * stalled) / wall).toFixed(0),
    histogramMaxMs_unreliable: +(h.max / 1e6).toFixed(1) };
}
export async function GET(req: Request) {
  try { return await handle(req); } catch (e) { return NextResponse.json({ error: String((e as Error).message).slice(0, 400) }, { status: 500 }); }
}
async function handle(req: Request) {
  const op = new URL(req.url).searchParams.get("op") ?? "mem";
  if (op === "mem") return NextResponse.json({ pid: process.pid, ...mem() });
  if (op === "open") { const db = await getDb(); const c = (await db.query("select count(*)::int c from session_memories")).rows[0]; return NextResponse.json({ rows: c, ...mem() }); }
  if (op === "embed") {
    // The nomic model is not downloaded in this probe (no network): a synthetic ONNX Gather model with a ~137 MB initializer stands in for it.
    const ort = await import("onnxruntime-node");
    await import("@huggingface/transformers"); // module graph resident as in the real embedder
    if (!g.__ort) {
      const sess = await ort.InferenceSession.create(fs.readFileSync(process.env.PROBE_ONNX as string));
      g.__ort = { run: async () => { const ids = new ort.Tensor("int64", BigInt64Array.from([1, 2, 3, 4].map((x) => BigInt(x))), [4]); await sess.run({ ids }); } };
    }
    await g.__ort.run(); return NextResponse.json({ embedded: true, ...mem() });
  }
  const db = await getDb();
  if (op === "search") {
    const reps = Number(new URL(req.url).searchParams.get("n") ?? 40);
    const q = () => db.query(`select count(*) from memory_search_scored(p_user_id => '${U}', p_query => 'retry backoff', p_code_project_id => '${P}', p_limit => 30, p_query_embedding => '${qv()}'::vector)`);
    return NextResponse.json(await timed("memory_search_scored", q, reps));
  }
  if (op === "analyze") return NextResponse.json(await timed("analyze", () => db.exec("analyze")));
  if (op === "hnsw") return NextResponse.json(await timed("hnsw rebuild", () => db.exec("reindex index session_memories_embedding_hnsw_idx")));
  if (op === "timeout") {
    try { await db.exec("set statement_timeout = 100"); const s = performance.now(); await db.query("select pg_sleep(1)"); return NextResponse.json({ aborted: false, tookMs: Math.round(performance.now() - s) }); }
    catch (e) { return NextResponse.json({ aborted: true, error: String((e as Error).message) }); }
    finally { await db.exec("reset statement_timeout"); }
  }
  return NextResponse.json({ error: "unknown op" }, { status: 400 });
}
