// Starts the standalone Next server (built natively with the throwaway probe route), runs the probe ops against it in one
// process, prints one JSON object. Usage: node probe/drive.mjs <standalone-dir> <seed-dataDir> <stand-in.onnx> [port]
import { spawn, execSync } from 'node:child_process'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const [sdir, seed, onnx, port = '3917'] = process.argv.slice(2);
const dir = fs.mkdtempSync(path.join(path.dirname(seed), 'run-')); fs.cpSync(seed, dir, { recursive: true });
const env = { ...process.env, PORT: port, HOSTNAME: '127.0.0.1', NODE_ENV: 'production', PROBE_DIR: dir, PROBE_ONNX: onnx,
  NEXT_PUBLIC_SUPABASE_URL: 'http://x.invalid', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'x', SUPABASE_SERVICE_ROLE_KEY: 'x', NEXT_PUBLIC_APP_URL: 'http://x.invalid' };
const srv = spawn('node', ['server.js'], { cwd: path.join(sdir, 'apps/cloud'), env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; srv.stdout.on('data', (d) => (log += d)); srv.stderr.on('data', (d) => (log += d));
import http from 'node:http';
const get = (op, q = '') => new Promise((res, rej) => http.get(`http://127.0.0.1:${port}/api/probe?op=${op}${q}`, { timeout: 0 }, (r) => { let t = ''; r.on('data', (d) => (t += d)); r.on('end', () => { try { res(JSON.parse(t)); } catch { res({ status: r.statusCode, body: t.slice(0, 300), log: log.slice(-400) }); } }); }).on('error', rej));
for (let i = 0; i < 50; i++) { try { await get('mem'); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }
const out = {}; const step = async (k, op, q) => { out[k] = await get(op, q); };
const vmmap = () => { try { return execSync(`vmmap --summary ${srv.pid} 2>/dev/null | grep -E "Physical footprint|^TOTAL|WebAssembly|MALLOC_LARGE |mapped file" | head -8`).toString().trim().split('\n').map((s) => s.replace(/\s+/g, ' ')); } catch (e) { return String(e).slice(0, 100); } };
await step('mem_boot', 'mem'); await step('after_open', 'open'); await step('after_embed', 'embed');
out.vmmap_after_embed = vmmap();
await step('search_before_analyze', 'search', '&n=5'); await step('analyze', 'analyze'); await step('search_after_analyze', 'search', '&n=40');
await step('hnsw_rebuild', 'hnsw'); await step('search_after_hnsw', 'search', '&n=20');
await step('mem_final', 'mem'); out.vmmap_final = vmmap();
await step('statement_timeout', 'timeout');
srv.kill('SIGTERM'); await new Promise((r) => setTimeout(r, 500)); fs.rmSync(dir, { recursive: true, force: true });
console.log(JSON.stringify(out, null, 1));
