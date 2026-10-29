import fs from 'node:fs'; import { open } from './db.mjs'; import { MIG } from './db.mjs'; import path from 'node:path';
const prelude = fs.readFileSync(new URL('./prelude.sql', import.meta.url), 'utf8').split('\n').filter(Boolean);
const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql')).sort();
const variants = { full: () => true, 'no roles': l => !/create role/.test(l), 'no grants': l => !/^grant/.test(l), 'no auth.uid': l => !/auth\.uid/.test(l), 'no auth.role/jwt': l => !/auth\.(role|jwt)/.test(l), 'no auth.users': l => !/auth\.users|insert into auth/.test(l), 'no pg_trgm/unaccent': l => !/pg_trgm|unaccent/.test(l), 'no search_path': l => !/search_path/.test(l), 'no extensions schema+vector in it': l => !/schema if not exists extensions|extension if not exists vector/.test(l) };
for (const [name, keep] of Object.entries(variants)) {
  const db = await open(); try { await db.exec(prelude.filter(keep).join('\n')); } catch (e) { console.log(name, 'PRELUDE ERR', e.message.slice(0, 80)); }
  let ok = 0; const first = [];
  for (const f of files) { try { await db.exec(fs.readFileSync(path.join(MIG, f), 'utf8')); ok++; } catch (e) { if (first.length < 2) first.push(f.slice(0, 3) + ': ' + e.message.slice(0, 90)); } }
  console.log(name.padEnd(36), `${ok}/${files.length}`, first.join(' | ')); await db.close();
}
