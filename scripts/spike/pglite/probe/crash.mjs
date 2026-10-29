// 20 rounds: spawn writer on a shared dataDir, SIGKILL it after a random 1.5-4 s, reopen the dir, check it opens, rows are
// a gapless 1..N prefix, N >= last acknowledged write, and a write works afterwards. Usage: node probe/crash.mjs <dataDir> [rounds]
import { spawn } from 'node:child_process'; import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const dir = process.argv[2], rounds = Number(process.argv[3] ?? 20); fs.rmSync(dir, { recursive: true, force: true });
const res = []; let opensOk = 0;
for (let r = 1; r <= rounds; r++) {
  const ch = spawn('node', [new URL('./crash-writer.mjs', import.meta.url).pathname, dir], { stdio: ['ignore', 'pipe', 'inherit'] });
  let lastAck = 0, buf = ''; ch.stdout.on('data', (d) => { buf += d; const m = buf.match(/w (\d+)\n/g); if (m) lastAck = Number(m[m.length - 1].slice(2)); buf = buf.slice(buf.lastIndexOf('\n') + 1); });
  await new Promise((r2) => setTimeout(r2, 1500 + Math.random() * 2500)); ch.kill('SIGKILL'); await new Promise((r2) => ch.on('exit', r2));
  const row = { round: r, lastAck };
  try {
    const db = new PGlite({ dataDir: dir }); await db.waitReady;
    const { rows } = await db.query('select count(*)::int n, coalesce(max(i),0)::int mx, coalesce(min(i),1)::int mn from t');
    const { n, mx, mn } = rows[0]; Object.assign(row, { opened: true, rows: n, max: mx, prefix: n === mx && mn === 1, ackedDurable: mx >= lastAck });
    await db.query('insert into t values ($1,$2)', [mx + 1000000, 'probe']); await db.query('delete from t where i=$1', [mx + 1000000]);
    await db.close(); opensOk++;
  } catch (e) { row.opened = false; row.error = String(e.message).slice(0, 200); }
  res.push(row);
}
console.log(JSON.stringify({ rounds, opensOk, allPrefix: res.every((x) => x.prefix), allAckedDurable: res.every((x) => x.ackedDurable), res }));
