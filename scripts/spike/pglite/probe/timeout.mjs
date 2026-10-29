// Does statement_timeout abort on PGlite? Usage: node probe/timeout.mjs
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite(); await db.waitReady; const o = {};
for (const sql of ['select pg_sleep(1)']) {
  await db.exec('set statement_timeout = 100'); const t = performance.now();
  try { await db.query(sql); o.aborted = false; o.tookMs = Math.round(performance.now() - t); } catch (e) { o.aborted = true; o.error = e.message; o.tookMs = Math.round(performance.now() - t); }
}
o.show = (await db.query('show statement_timeout')).rows[0];
// a CPU-bound query (no sleep) under the same timeout
const t2 = performance.now(); try { await db.query('select count(*) from generate_series(1,3000000) a, generate_series(1,3) b'); o.cpuBound = { aborted: false, tookMs: Math.round(performance.now() - t2) }; } catch (e) { o.cpuBound = { aborted: true, error: e.message, tookMs: Math.round(performance.now() - t2) }; }
console.log(JSON.stringify(o)); await db.close();
