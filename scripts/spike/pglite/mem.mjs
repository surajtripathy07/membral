// RSS of a PGlite process: empty after migrations, then 1,000 and 10,000 seeded 1536-dim vectors.
// Usage: node mem.mjs '<json PGlite options>' [--onnx]   (one config per process; RSS never shrinks, so do not reuse a process)
import { execSync } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { PGlite } from '@electric-sql/pglite'; import { vector } from '@electric-sql/pglite-pgvector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'; import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { migrate } from './db.mjs';
const opts = JSON.parse(process.argv[2] || '{}'); const withOnnx = process.argv.includes('--onnx');
const mb = (n) => Math.round(n / 1e6);
// macOS compresses idle pages, so RSS alone under-reports; physical footprint (compressed included) is the honest number.
const foot = () => { try { const m = execSync(`footprint ${process.pid} --noCategories 2>/dev/null`).toString().match(/Footprint:\s+([\d.]+)\s*(KB|MB|GB)/); return m ? Math.round(Number(m[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 })[m[2]]) : null; } catch { return null; } };
const rss = () => `${mb(process.memoryUsage().rss)} rss / ${foot()} footprint`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-mem-'));
const out = { opts, rss: {} };
out.rss.node_boot = rss();
const t0 = Date.now();
const db = new PGlite({ dataDir: dir, extensions: { vector, pg_trgm, unaccent }, ...opts }); await db.waitReady;
out.rss.after_open = rss();
const r = await migrate(db, { log: false }); out.migrated = `${r.ok}/${r.total}`; out.rss.after_migrations = rss(); out.startAndMigrateMs = Date.now() - t0;
const U = '00000000-0000-0000-0000-000000000001', P = '11111111-1111-1111-1111-111111111111', S = '21111111-1111-1111-1111-111111111111';
await db.exec(`insert into profiles(id,email) values ('${U}','l@x') on conflict do nothing;
 insert into code_projects(id,user_id,repo_identity) values ('${P}','${U}','codehub/acme-api');
 insert into code_sessions(id,user_id,code_project_id,source,source_session_id,content_hash) values ('${S}','${U}','${P}','claude-code','s','h');`);
let n = 0;
// Bulk-load pattern: drop the HNSW index, load, rebuild (inserting 10k vectors into 1 HNSW index row by row took ~100 s+).
const IDX = 'create index session_memories_embedding_hnsw_idx on session_memories using hnsw (embedding vector_cosine_ops)';
await db.exec('drop index session_memories_embedding_hnsw_idx');
const seed = async (upto) => { while (n < upto) { const a = n + 1, b = Math.min(n + 500, upto); // correlated subselect so each row gets its own random vector
  await db.exec(`insert into session_memories(user_id,code_session_id,code_project_id,source,kind,text,turn_idx,turn_role,content_hash,embedding,embedding_model)
   select '${U}','${S}','${P}','extractor','decision','record '||g||' about retry backoff '||(g%37),g,'assistant','hash'||g,
   (select array_agg(random()::real) from generate_series(1,1536) where g>0)::vector,'nomic-embed-text-v1.5' from generate_series(${a},${b}) g`); n = b; } };
let t = Date.now(); await seed(1000); out.seed1000Ms = Date.now() - t; t = Date.now(); await db.exec(IDX); out.hnswBuild1000Ms = Date.now() - t; await db.exec('analyze'); out.rss.after_1000_vectors = rss();
t = Date.now(); await db.exec('drop index session_memories_embedding_hnsw_idx'); await seed(10000); out.seed10000Ms = Date.now() - t; t = Date.now(); await db.exec(IDX); out.hnswBuild10000Ms = Date.now() - t; await db.exec('analyze'); out.rss.after_10000_vectors = rss();
const qv = '[' + Array.from({ length: 1536 }, () => Math.random()).join(',') + ']';
const q = `select count(*) from memory_search_scored(p_user_id => '${U}', p_query => 'retry backoff', p_code_project_id => '${P}', p_limit => 30, p_query_embedding => '${qv}'::vector)`;
t = performance.now(); await db.query(q); out.hybridSearchAt10kMs = Math.round(performance.now() - t);
out.rss.after_search = rss();
if (withOnnx) {
  const { pipeline, env } = await import('@huggingface/transformers');
  const ev = process.env.SPIKE_ONNX_DTYPE || 'q8';
  t = Date.now(); const ex = await pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1.5', { dtype: ev });
  out.onnxLoadMs = Date.now() - t; out.rss.after_onnx_load = rss();
  const texts = Array.from({ length: 50 }, (_, i) => `search_document: Retry the import on a 504 with exponential backoff, case ${i}: the queue env accessors live in queue.ts and must not be converted.`);
  const lat = []; let dim = 0;
  for (const tx of texts) { const s = performance.now(); const e = await ex(tx, { pooling: 'mean', normalize: true }); lat.push(performance.now() - s); dim = e.dims[1]; }
  lat.sort((a, b) => a - b); out.onnx = { dtype: ev, dim, msPerText_mean: +(lat.reduce((a, b) => a + b) / lat.length).toFixed(1), msPerText_p50: +lat[25].toFixed(1), msPerText_max: +lat[49].toFixed(1) };
  out.rss.after_onnx_embed50 = rss();
  // PGlite still usable with ONNX resident
  t = performance.now(); await db.query(q); out.hybridSearchWithOnnxMs = Math.round(performance.now() - t); out.rss.final = rss();
}
console.log(JSON.stringify(out));
await db.close(); fs.rmSync(dir, { recursive: true, force: true });
