import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite-pgvector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import fs from 'node:fs'; import path from 'node:path';
export const MIG = new URL('../../../apps/cloud/supabase/migrations/', import.meta.url).pathname;
export async function open(dataDir) {
  const db = new PGlite({ ...(dataDir ? { dataDir } : {}), extensions: { vector, pg_trgm, unaccent } });
  await db.waitReady; return db;
}
export async function migrate(db, { log = true } = {}) {
  await db.exec(fs.readFileSync(new URL('./prelude.sql', import.meta.url), 'utf8'));
  const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort();
  const fails = []; let ok = 0;
  for (const f of files) {
    try { await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8')); ok++; }
    catch (e) { fails.push({ f, msg: e.message }); if (log) console.log('FAIL', f, e.message.slice(0, 200)); }
  }
  return { ok, total: files.length, fails };
}
