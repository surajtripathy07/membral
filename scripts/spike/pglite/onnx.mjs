// RSS of nomic-embed-text-v1.5 (q8 ONNX) alone in a fresh process: node onnx.mjs
import { execSync } from 'node:child_process';
const foot = () => { try { const m = execSync(`footprint ${process.pid} --noCategories 2>/dev/null`).toString().match(/Footprint:\s+([\d.]+)\s*(KB|MB|GB)/); return m ? Math.round(Number(m[1]) * ({ KB: 1 / 1024, MB: 1, GB: 1024 })[m[2]]) : null; } catch { return null; } };
const rss = () => `${Math.round(process.memoryUsage().rss / 1e6)} rss / ${foot()} footprint`;
const o = { boot: rss() };
const { pipeline } = await import('@huggingface/transformers');
let t = Date.now(); const ex = await pipeline('feature-extraction', 'nomic-ai/nomic-embed-text-v1.5', { dtype: 'q8' });
o.loadMs = Date.now() - t; o.after_load = rss();
const lat = []; let dim = 0;
for (let i = 0; i < 50; i++) { const s = performance.now(); const e = await ex(`search_document: Retry the import on a 504 with exponential backoff, case ${i}: the queue env accessors live in queue.ts.`, { pooling: 'mean', normalize: true }); lat.push(performance.now() - s); dim = e.dims[1]; }
o.dim = dim; o.msPerText_mean = +(lat.reduce((a, b) => a + b) / 50).toFixed(1); o.msPerText_first = +lat[0].toFixed(1); o.after_50 = rss();
console.log(JSON.stringify(o));
