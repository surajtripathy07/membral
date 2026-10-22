#!/usr/bin/env node
// Ratchet checker, architecture refactor programme step 4.1a
// (docs/archive/goals/2026-09-28_g4-guards_goal.md D1).
//
// docs/design/architecture-refactor-programme.md:141-158 defines five gates
// (G1-G5) as shell `grep` pipelines that never ran in CI. This re-implements
// each pipeline's exact selection (same roots, extensions, path exclusions,
// content regex) in Node, driven by scripts/ratchets.json, so a regression
// fails a PR instead of waiting for the next manual re-count. G1's baseline
// additionally excludes `__golden__` (not just `__tests__`, unlike the
// original grep), per the goal's 2026-09-28 fix.
//
// Two ratchet modes:
//   "max" - the matching file COUNT must not exceed the committed baseline
//           (G1, G2, G4, G5).
//   "set" - the matching file SET must equal the committed baseline list,
//           exactly (G3): no growth, and no silent shrink going unnoticed
//           either, since a shrink is a deliberate --update.
//
// usage:
//   node scripts/check-ratchets.mjs                 # check against ratchets.json
//   node scripts/check-ratchets.mjs --update         # rewrite baselines, print diff
//   node scripts/check-ratchets.mjs --json           # machine-readable result
//   node scripts/check-ratchets.mjs --config <path> --root <dir>   # for tests
//
// Exit 0 when every ratchet holds (or after a successful --update); exit 1
// on any violation.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo", "dist", ".git", "coverage"]);

function parseArgs(argv) {
  const args = { update: false, json: false, config: null, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--update") args.update = true;
    else if (a === "--json") args.json = true;
    else if (a === "--explain") continue; // offending files already print on any violation
    else if (a === "--config") args.config = argv[++i];
    else if (a === "--root") args.root = argv[++i];
    else {
      console.error(`check-ratchets: unknown argument ${a}`);
      process.exit(1);
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const CONFIG_PATH = resolve(args.config ?? resolve(SCRIPT_DIR, "ratchets.json"));
const ROOT = resolve(args.root ?? resolve(SCRIPT_DIR, ".."));

function listFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) out.push(...listFiles(full));
    } else out.push(full);
  }
  return out;
}

const rel = (p) => relative(ROOT, p).split("\\").join("/");

// Reproduces `grep -rl` (or `-rlE`) selection: a file is selected when at
// least one line has a match of `match` that survives `matchExclude`
// (mirrors a trailing `grep -v`/`grep -vE` applied to the matched token
// itself, as G4's pipeline does with `-o` before excluding NEXT_PUBLIC_*).
function selectFiles(ratchet) {
  const { root, extensions, match, matchExclude, pathExcludes } = ratchet;
  const matchRe = new RegExp(match, "g");
  const matchExcludeRe = matchExclude ? new RegExp(matchExclude) : null;
  const pathExcludeRes = (pathExcludes ?? []).map((p) => new RegExp(p));
  const files = listFiles(resolve(ROOT, root))
    .map(rel)
    .filter((f) => !extensions || extensions.some((ext) => f.endsWith(ext)))
    .filter((f) => !pathExcludeRes.some((re) => re.test(f)));

  const selected = [];
  for (const f of files) {
    let text;
    try {
      text = readFileSync(resolve(ROOT, f), "utf8");
    } catch {
      continue; // unreadable (e.g. binary/permissions) - grep would skip or warn, never crash
    }
    let hit = false;
    for (const line of text.split("\n")) {
      for (const m of line.matchAll(matchRe)) {
        if (matchExcludeRe?.test(m[0])) continue;
        hit = true;
        break;
      }
      if (hit) break;
    }
    if (hit) selected.push(f);
  }
  return selected.sort();
}

function evaluate(ratchet) {
  const files = selectFiles(ratchet);
  if (ratchet.mode === "set") {
    const baseline = [...ratchet.baseline].sort();
    const added = files.filter((f) => !baseline.includes(f));
    const removed = baseline.filter((f) => !files.includes(f));
    return { files, ok: added.length === 0 && removed.length === 0, added, removed, baselineCount: baseline.length };
  }
  // "max"
  return { files, ok: files.length <= ratchet.baseline, added: [], removed: [], baselineCount: ratchet.baseline };
}

const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const results = [];
let anyViolation = false;

for (const ratchet of config.ratchets) {
  const result = evaluate(ratchet);
  if (!result.ok) anyViolation = true;
  results.push({ ratchet, result });
}

if (args.update) {
  for (const { ratchet, result } of results) {
    const prev = ratchet.mode === "set" ? [...ratchet.baseline].sort() : ratchet.baseline;
    const next = ratchet.mode === "set" ? result.files : result.files.length;
    const changed = ratchet.mode === "set" ? JSON.stringify(prev) !== JSON.stringify(next) : prev !== next;
    if (changed) {
      console.log(
        `${ratchet.id} baseline ${JSON.stringify(prev)} -> ${JSON.stringify(next)}`,
      );
      ratchet.baseline = next;
    }
  }
  writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
  process.exit(0);
}

if (args.json) {
  console.log(
    JSON.stringify(
      results.map(({ ratchet, result }) => ({
        id: ratchet.id,
        mode: ratchet.mode,
        count: result.files.length,
        baselineCount: result.baselineCount,
        ok: result.ok,
        added: result.added,
        removed: result.removed,
      })),
      null,
      2,
    ),
  );
  process.exit(anyViolation ? 1 : 0);
}

for (const { ratchet, result } of results) {
  const status = result.ok ? "ok" : "VIOLATION";
  if (ratchet.mode === "set") {
    console.log(`${ratchet.id} ${result.files.length}/${result.baselineCount} ${status}`);
  } else {
    console.log(`${ratchet.id} ${result.files.length}/${ratchet.baseline} ${status}`);
  }
  if (!result.ok) {
    for (const f of result.added) console.error(`  + ${f}`);
    for (const f of result.removed) console.error(`  - ${f}`);
    if (ratchet.mode === "max") {
      for (const f of result.files) console.error(`  ${f}`);
    }
  }
}

process.exit(anyViolation ? 1 : 0);
