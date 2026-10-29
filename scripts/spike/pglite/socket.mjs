import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fork } from 'node:child_process';
import pg from 'pg'; import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { open, migrate } from './db.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-sock-'));
const db = await open(dir); await migrate(db, { log: false });
await db.exec('create table scratch(v text)');
const server = new PGLiteSocketServer({ db, port: 54399, host: '127.0.0.1', maxConnections: 10 });
await server.start();
const mk = () => new pg.Client({ host: '127.0.0.1', port: 54399, user: 'postgres', database: 'postgres' });
const out = {};
const a = mk(), b = mk(); await a.connect(); await b.connect();
out.pgClientConnect = 'ok';
// concurrent queries from two connections
const t = Date.now(); const [r1, r2] = await Promise.all([a.query("select count(*)::int c from pg_tables where schemaname='public'"), b.query("select auth.uid() u")]);
out.concurrentTwoClients = { tables: r1.rows[0].c, uid: r2.rows[0].u, ms: Date.now() - t };
// transaction interleave: A in a txn, B writes meanwhile
await a.query('begin'); await a.query("insert into scratch values ('a')");
let bDone = false; const bp = b.query("insert into scratch values ('b')").then(() => { bDone = true; });
await new Promise(r => setTimeout(r, 500)); out.bBlockedWhileAInTxn = !bDone;
await a.query('commit'); await bp; out.bCompletedAfterCommit = bDone;
// rollback isolation: B's statement must not see A's uncommitted rows (multiplexer = one session)
await a.query('begin'); await a.query("insert into scratch values ('ghost')");
const seen = bDone && (await Promise.race([b.query("select count(*)::int c from scratch where v='ghost'"), new Promise(r => setTimeout(() => r('blocked'), 800))]));
out.bSeesAUncommitted = seen === 'blocked' ? 'blocked until A finishes' : seen.rows[0].c;
await a.query('rollback');
// session-state leak: set in A visible to B?
await a.query("set search_path = pg_catalog"); const sp = await b.query('show search_path'); out.searchPathLeaksAcrossConnections = sp.rows[0].search_path; await a.query('reset search_path');
await a.end(); await b.end(); await server.stop(); await db.close(); fs.rmSync(dir, { recursive: true });
console.log(JSON.stringify(out, null, 1));
