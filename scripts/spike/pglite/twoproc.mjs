import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawn } from 'node:child_process';
import { PGlite } from '@electric-sql/pglite';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pglite-2p-'));
const db = new PGlite(dir); await db.waitReady; await db.exec('create table t(v int); insert into t values (1)'); 
const child = spawn(process.execPath, ['-e', `import('@electric-sql/pglite').then(async ({PGlite})=>{try{const d=new PGlite(${JSON.stringify(dir)});await Promise.race([d.waitReady,new Promise((_,r)=>setTimeout(()=>r(new Error('timeout 20s')),20000))]);console.log('second process opened ok:',JSON.stringify((await d.query('select * from t')).rows));process.exit(0)}catch(e){console.log('second process error:',String(e.message).slice(0,200));process.exit(0)}})`], { cwd: new URL('.', import.meta.url).pathname, stdio: 'inherit' });
await new Promise(r => child.on('exit', r)); await db.close(); fs.rmSync(dir, { recursive: true });
