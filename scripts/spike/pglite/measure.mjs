import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execSync } from 'node:child_process';
import { open, migrate } from './db.mjs'; import { createShim, signJwt } from './shim.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-spike-'));
const rss = () => Math.round(process.memoryUsage().rss / 1e6);
let t = Date.now(); const db = await open(dir); const cold = Date.now() - t;
t = Date.now(); const r = await migrate(db, { log: false }); const mig = Date.now() - t;
await db.exec('checkpoint');
const sizeMB = () => Math.round(Number(execSync(`du -sk ${dir}`).toString().split('\t')[0]) / 1024);
console.log(JSON.stringify({ coldStartMs: cold, migrateMs: mig, applied: `${r.ok}/${r.total}`, failed: r.fails.length, dbDiskMB_afterMigrations: sizeMB(), rssMB: rss() }));
const U = '00000000-0000-0000-0000-000000000001', P = '11111111-1111-1111-1111-111111111111', S = '21111111-1111-1111-1111-111111111111';
await db.exec(`insert into profiles(id,email) values ('${U}','l@x') on conflict do nothing;
 insert into code_projects(id,user_id,repo_identity) values ('${P}','${U}','codehub/acme-api');
 insert into code_sessions(id,user_id,code_project_id,source,source_session_id,content_hash) values ('${S}','${U}','${P}','claude-code','s','h');`);
t = Date.now();
await db.exec(`insert into session_memories(user_id,code_session_id,code_project_id,source,kind,text,turn_idx,turn_role,content_hash,embedding,embedding_model)
 select '${U}','${S}','${P}','extractor','decision','record '||g||' about retry backoff and queue accessors in the acme api '||(g%37),g,'assistant','hash'||g,
 (select array_agg(random()::real) from generate_series(1,1536))::vector, 'text-embedding-3-small' from generate_series(1,1000) g`);
console.log(JSON.stringify({ seed1000x1536Ms: Date.now() - t, dbDiskMB_after1000vec: (await db.exec('checkpoint'), sizeMB()), rssMB: rss() }));
const shim = createShim(db, { jwtSecret: 'spike-test-secret-0123456789-abcdefghij' });
const qvec = '[' + Array.from({ length: 1536 }, () => Math.random()).join(',') + ']';
const call = async (embedding) => { const t0 = performance.now(); const res = await shim(new Request('http://pglite.local/rest/v1/rpc/memory_search_scored', { method: 'POST', headers: { authorization: 'Bearer ' + signJwt({ role: 'service_role' }, 'spike-test-secret-0123456789-abcdefghij') }, body: JSON.stringify({ p_user_id: U, p_query: 'retry backoff queue', p_code_project_id: P, p_kinds: null, p_scope: null, p_path: null, p_include_retired: false, p_limit: 30, p_query_embedding: embedding, p_since: null }) })); const j = await res.json(); return { ms: +(performance.now() - t0).toFixed(1), status: res.status, n: Array.isArray(j) ? j.length : j }; };
const run = async (label) => { const o = { keyword: [], hybrid: [] }; for (let i = 0; i < 5; i++) { o.keyword.push((await call(null)).ms); o.hybrid.push((await call(qvec)).ms); } console.log(label, JSON.stringify(o)); };
await run('rpc_ms_no_analyze');
t = Date.now(); await db.exec('analyze'); console.log('analyze_ms', Date.now() - t);
await run('rpc_ms_after_analyze');
console.log(JSON.stringify({ rssMB_end: rss() }));
await db.close(); fs.rmSync(dir, { recursive: true });
