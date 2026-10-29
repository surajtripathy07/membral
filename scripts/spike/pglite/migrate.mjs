import { open, migrate } from './db.mjs';
const t0 = Date.now(); const db = await open(process.argv[2]);
const t1 = Date.now(); const r = await migrate(db);
console.log(JSON.stringify({ coldStartMs: t1 - t0, migrateMs: Date.now() - t1, ok: r.ok, total: r.total, failed: r.fails.length, rssMB: Math.round(process.memoryUsage().rss/1e6) }));
