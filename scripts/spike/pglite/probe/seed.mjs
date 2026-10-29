// Seeds a migrated PGlite dataDir with 10,000 random 1536-d vectors (HNSW built, NOT analyzed).
// Usage: node probe/seed.mjs <dataDir>      (~2 min)  -> writes <dataDir>; copy it before running the probe server.
import { PGlite } from '@electric-sql/pglite'; import { vector } from '@electric-sql/pglite-pgvector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm'; import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { migrate } from '../db.mjs';
const dir = process.argv[2]; if (!dir) throw new Error('dataDir');
const db = new PGlite({ dataDir: dir, extensions: { vector, pg_trgm, unaccent } }); await db.waitReady;
const r = await migrate(db, { log: true }); console.log('migrated', r.ok, '/', r.total);
const U = '00000000-0000-0000-0000-000000000001', P = '11111111-1111-1111-1111-111111111111', S = '21111111-1111-1111-1111-111111111111';
await db.exec(`insert into profiles(id,email) values ('${U}','l@x') on conflict do nothing;
 insert into code_projects(id,user_id,repo_identity) values ('${P}','${U}','codehub/acme-api');
 insert into code_sessions(id,user_id,code_project_id,source,source_session_id,content_hash) values ('${S}','${U}','${P}','claude-code','s','h');`);
await db.exec('drop index session_memories_embedding_hnsw_idx');
for (let n = 0; n < 10000;) { const a = n + 1, b = Math.min(n + 500, 10000);
  await db.exec(`insert into session_memories(user_id,code_session_id,code_project_id,source,kind,text,turn_idx,turn_role,content_hash,embedding,embedding_model)
   select '${U}','${S}','${P}','extractor','decision','record '||g||' about retry backoff '||(g%37),g,'assistant','hash'||g,
   (select array_agg(random()::real) from generate_series(1,1536) where g>0)::vector,'nomic-embed-text-v1.5' from generate_series(${a},${b}) g`); n = b; }
await db.exec('create index session_memories_embedding_hnsw_idx on session_memories using hnsw (embedding vector_cosine_ops)');
console.log('rows', (await db.query('select count(*)::int c from session_memories')).rows[0].c);
await db.close();
