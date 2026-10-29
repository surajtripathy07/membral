// Writes a minimal ONNX model by hand-encoding the protobuf: Gather(W[44000,768] float, ids int64[4]) -> out. W is ~135 MB,
// a stand-in for nomic q8 (137 MB) in resident-memory terms only. Usage: node probe/make-onnx.mjs <out.onnx>
import fs from 'node:fs';
const varint = (n) => { const o = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return Buffer.from(o); };
const tag = (f, w) => varint((f << 3) | w);
const ld = (f, b) => Buffer.concat([tag(f, 2), varint(b.length), b]);
const str = (f, s) => ld(f, Buffer.from(s));
const vi = (f, n) => Buffer.concat([tag(f, 0), varint(n)]);
const ROWS = 44000, COLS = 768;
const dim = (n) => ld(1, vi(1, n));                       // TensorShapeProto.Dimension{dim_value}
const tType = (elem, dims) => ld(1, Buffer.concat([vi(1, elem), ld(2, Buffer.concat(dims.map(dim)))])); // TypeProto{tensor_type}
const vinfo = (name, elem, dims) => Buffer.concat([str(1, name), ld(2, tType(elem, dims))]);
const W = Buffer.alloc(ROWS * COLS * 4); for (let i = 0; i < W.length; i += 4097) W[i] = 1; // non-zero pages so nothing is sparse
const init = Buffer.concat([vi(1, ROWS), vi(1, COLS), vi(2, 1), str(8, 'W'), ld(9, W)]);   // TensorProto dims,dims,data_type=FLOAT,name,raw_data
const node = Buffer.concat([str(1, 'W'), str(1, 'ids'), str(2, 'out'), str(3, 'g'), str(4, 'Gather')]);
const graph = Buffer.concat([ld(1, node), str(2, 'g'), ld(5, init), ld(11, vinfo('ids', 7, [4])), ld(12, vinfo('out', 1, [4, COLS]))]);
const model = Buffer.concat([vi(1, 8), ld(8, vi(2, 17)), ld(7, graph)]);
fs.writeFileSync(process.argv[2], model); console.log('wrote', model.length);
