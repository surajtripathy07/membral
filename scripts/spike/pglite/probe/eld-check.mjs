// Sanity: does monitorEventLoopDelay see PGlite's blocking? Usage: node probe/eld-check.mjs <dataDir copy>
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite'; import { vector } from '@electric-sql/pglite-pgvector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'; import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
const db = new PGlite({ dataDir: process.argv[2], extensions: { vector, pg_trgm, unaccent } }); await db.waitReady;
let ticks = 0, maxGap = 0, last = performance.now(); const iv = setInterval(() => { const n = performance.now(); maxGap = Math.max(maxGap, n - last); last = n; ticks++; }, 5);
const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
const t = performance.now(); await db.exec('analyze'); const dur = performance.now() - t;
await new Promise((r) => setTimeout(r, 30)); h.disable(); clearInterval(iv);
console.log(JSON.stringify({ analyzeMs: Math.round(dur), eldMaxMs: +(h.max / 1e6).toFixed(1), setIntervalMaxGapMs: Math.round(maxGap), ticksDuring: ticks }));
await db.close();
