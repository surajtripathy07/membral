// Regenerates unit-fixtures.json by running the LAB's own unit builder (extract-search-lab
// variants/I24-ensemble-fusion/recordPostProcess.mjs) on the synthetic transcripts below. The transcripts are
// fictional (CodeHub); no user data. The TypeScript port (../../units.ts) must reproduce the outputs exactly.
//
//   node generate-lab-fixtures.mjs /path/to/extract-search-lab > unit-fixtures.json
//
// Expected rows are stored in the product's shape: the lab's `turn_text` (on the first window of a turn) is mapped to
// the turn row (migration 129 keeps it there), `ord` is the index within the unit type, and text_hash is the sha256
// of the embedded string for the default family (text) and for nomic (`search_document: ` + text).
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const lab = process.argv[2];
if (!lab) throw new Error("usage: node generate-lab-fixtures.mjs <path to extract-search-lab>");
const { default: recordPostProcess } = await import(pathToFileURL(`${lab}/variants/I24-ensemble-fusion/recordPostProcess.mjs`).href);
const sha = (s) => createHash("sha256").update(s).digest("hex");

const words = "the CodeHub importer reads each transcript, splits it at turn boundaries and writes one row per unit so that search can cite the exact turn".split(" ");
const prose = (n, seed = 0) => Array.from({ length: n }, (_, i) => words[(i * 7 + seed) % words.length]).join(" ");

const fixtures = [];
const add = (name, turns, opts = {}) => fixtures.push({ name, turns, ...opts });

add("short-mixed", [
  { idx: 0, role: "user", kind: "prose", text: "Please add a retry to the CodeHub sync client.\n\nIt should back off." },
  { idx: 1, role: "assistant", kind: "thinking", text: "Hidden reasoning that must never become a unit." },
  { idx: 2, role: "assistant", kind: "prose", text: "I will read the client first, then add the retry." },
  { idx: 3, role: "assistant", kind: "tool_use", text: "Read src/sync/client.ts" },
  { idx: 4, role: "user", kind: "tool_result", text: "export async function sync() {\n\tawait push();\n\treturn true;\n}\n" },
  { idx: 5, role: "assistant", kind: "prose", text: "   \n\t " },
  { idx: 6, role: "assistant", kind: "tool_use", text: null },
  { idx: 7, role: "assistant", kind: "prose", text: "Done: sync() now retries three times with doubling delay." },
]);

add("long-prose-windows", [
  { idx: 0, role: "user", kind: "prose", text: "Why does the nightly export drop rows?" },
  {
    idx: 1,
    role: "assistant",
    kind: "prose",
    text: `${prose(70, 1)}.\n\n${prose(60, 3)}: ${"/srv/codehub/exports/nightly/".repeat(15)}\n${prose(80, 5)}.`,
  },
  { idx: 2, role: "assistant", kind: "tool_result", text: `x${"y".repeat(1500)} tail words after the long run` },
  { idx: 3, role: "user", kind: "prose", text: `${prose(30, 2)}   ${prose(40, 6)}` },
]);

const emoji = ["rollback \u{1F680} plan", "日本語のログ été naïve café", "plain ascii words only"];
add(
  "unicode-chunk-boundaries",
  Array.from({ length: 24 }, (_, i) => ({
    idx: i * 2 + 1,
    role: i % 3 === 0 ? "user" : "assistant",
    kind: i % 4 === 1 ? "tool_result" : i % 4 === 2 ? "tool_use" : "prose",
    text: `${emoji[i % 3]} ${prose(18 + (i % 5) * 9, i)}${i % 2 ? "\nsecond line\n  indented" : ""}`,
  })),
);

add("big-turn-cap", [
  { idx: 0, role: "user", kind: "prose", text: "Summarise the attached log." },
  { idx: 1, role: "user", kind: "tool_result", text: `${prose(5200, 4)} END` },
  { idx: 2, role: "assistant", kind: "prose", text: "The log shows repeated reconnects." },
], { digestOnly: true });

add("no-units", [
  { idx: 0, role: "assistant", kind: "thinking", text: "only thinking" },
  { idx: 1, role: "user", kind: "prose", text: "  " },
  { idx: 2, role: "assistant", kind: "tool_use", text: "" },
]);

const out = [];
for (const f of fixtures) {
  const api = { turns: () => f.turns, meta: { id8: "fx000001" } };
  const recs = await recordPostProcess([], api);
  const c700 = recs.filter((r) => r.unit === "c700");
  const win = recs.filter((r) => r.unit === "win");
  const turn = recs.filter((r) => r.unit === "turn");
  const turnText = new Map(win.filter((w) => w.turn_text != null).map((w) => [w.turn_idx, w.turn_text]));
  const hashes = (text) => ({ text_hash: sha(text), text_hash_nomic: sha(`search_document: ${text}`) });
  const units = [
    ...c700.map((r, i) => ({ unit: "c700", ord: i, turn_idx: r.turn_idx, turn_from: r.chunk_turns[0], turn_to: r.chunk_turns[1], parts: r.parts, win: null, text: r.text, full_text: null, turn_text: null, ...hashes(r.text) })),
    ...win.map((r, i) => ({ unit: "win", ord: i, turn_idx: r.turn_idx, turn_from: r.chunk_turns[0], turn_to: r.chunk_turns[1], parts: null, win: r.win, text: r.text, full_text: null, turn_text: null, ...hashes(r.text) })),
    ...turn.map((r, i) => ({ unit: "turn", ord: i, turn_idx: r.turn_idx, turn_from: r.chunk_turns[0], turn_to: r.chunk_turns[1], parts: null, win: null, text: r.text, full_text: r.full_text, turn_text: turnText.get(r.turn_idx) ?? null, ...hashes(r.text) })),
  ];
  if (f.digestOnly) {
    out.push({ name: f.name, turns: f.turns, counts: { c700: c700.length, win: win.length, turn: turn.length }, units_digest: sha(JSON.stringify(units)) });
  } else out.push({ name: f.name, turns: f.turns, units });
}
console.log(JSON.stringify(out, null, 1));
