// Child for crash.mjs: opens dataDir, creates table t(i int primary key, pad text) if absent, then inserts rows one per
// transaction forever, printing "w <i>" AFTER each commit returns. Killed with SIGKILL by the parent.
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite({ dataDir: process.argv[2] }); await db.waitReady;
await db.exec('create table if not exists t(i int primary key, pad text)');
let i = (await db.query('select coalesce(max(i),0)::int m from t')).rows[0].m;
const pad = 'x'.repeat(2000);
for (;;) { i++; await db.query('insert into t values ($1,$2)', [i, pad]); process.stdout.write(`w ${i}\n`); }
