#!/usr/bin/env node
// Doc-path guard, architecture refactor programme step 4.3b.
//
// Docs (docs/ARCHITECTURE.md above all) name real repo paths as the map for a
// builder who has never opened the repo. A path that drifted out from under a
// move leaves the doc silently wrong. This extracts every backticked token
// from a Markdown doc, decides which look like repo paths, and fails when one
// does not resolve from the repo root.
//
// A token is a path candidate once a trailing `/**`, `/*`, `:<line>` or
// `:<line>-<line>` suffix is stripped, when it then contains `/` or ends in
// one of the recognised source/doc extensions. Prose fragments, bare
// identifiers, shell one-liners and URLs are filtered out before the
// existence check (see SKIP_PREFIXES / the char filters below) rather than
// reported as misses. A doc may allowlist a path that does not exist in a
// fresh checkout (e.g. gitignored/generated) with:
//   <!-- doc-paths-ignore: a/b, c/d -->
// anywhere in the file.
//
// usage:
//   node scripts/check-doc-paths.mjs [file.md ...]   # default: docs/ARCHITECTURE.md
//   node scripts/check-doc-paths.mjs --list [file.md ...]   # also print every checked path
//   node scripts/check-doc-paths.mjs --root <dir> [file.md ...]   # resolve paths under <dir> (tests)
//
// Exit 0 when every extracted path resolves; exit 1 printing
// `MISS <doc>:<line> <path>` for each that does not.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PATH_EXTS = [".ts", ".tsx", ".mjs", ".js", ".json", ".md", ".sh", ".yml", ".yaml", ".css"];
const SUFFIX_PATTERNS = [/\/\*\*$/, /\/\*$/, /:\d+-\d+$/, /:\d+$/];
const SKIP_PREFIXES = ["http", "@/", "@membral/", "--", "-", "npm ", "npx ", "node ", "bash ", "git "];

function parseArgs(argv) {
  const args = { list: false, root: null, files: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--list") args.list = true;
    else if (a === "--root") args.root = argv[++i];
    else args.files.push(a);
  }
  if (args.files.length === 0) args.files.push("docs/ARCHITECTURE.md");
  return args;
}

function stripSuffix(token) {
  for (const p of SUFFIX_PATTERNS) {
    const m = token.match(p);
    if (m) return token.slice(0, token.length - m[0].length);
  }
  return token;
}

function isCandidate(token) {
  return token.includes("/") || PATH_EXTS.some((ext) => token.endsWith(ext));
}

function shouldSkip(token) {
  if (/\s/.test(token)) return true;
  if (token.includes("<") || token.includes(">") || token.includes("*")) return true;
  if (token.includes("${") || token.includes("=")) return true;
  return SKIP_PREFIXES.some((p) => token.startsWith(p));
}

function loadIgnoreAllowlist(text) {
  const ignored = new Set();
  const re = /<!--\s*doc-paths-ignore:\s*([\s\S]*?)-->/g;
  for (const m of text.matchAll(re)) {
    for (const part of m[1].split(",")) {
      const trimmed = part.trim();
      if (trimmed) ignored.add(trimmed);
    }
  }
  return ignored;
}

// Backticked inline spans, one line at a time so a ``` fenced block's own
// delimiters never get mistaken for a paired inline span, and its (often
// ASCII-art) contents are never scanned.
function extractTokens(text) {
  const tokens = []; // { line, token }
  let inFence = false;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    for (const m of line.matchAll(/`([^`]+)`/g)) {
      tokens.push({ line: i + 1, token: m[1] });
    }
  }
  return tokens;
}

function checkFile(file, root, list) {
  const text = readFileSync(file, "utf8");
  const ignored = loadIgnoreAllowlist(text);
  const violations = [];
  const checked = [];
  for (const { line, token } of extractTokens(text)) {
    const stripped = stripSuffix(token);
    if (!isCandidate(stripped)) continue;
    if (shouldSkip(stripped)) continue;
    if (ignored.has(stripped)) continue;
    checked.push({ line, path: stripped });
    if (!existsSync(resolve(root, stripped))) violations.push({ line, path: stripped });
  }
  if (list) for (const c of checked) console.log(`${file}:${c.line} ${c.path}`);
  for (const v of violations) console.error(`MISS ${file}:${v.line} ${v.path}`);
  return { checkedCount: checked.length, violationCount: violations.length };
}

const args = parseArgs(process.argv.slice(2));
const root = args.root ? resolve(process.cwd(), args.root) : REPO_ROOT;

let totalChecked = 0;
let totalViolations = 0;
for (const file of args.files) {
  const { checkedCount, violationCount } = checkFile(file, root, args.list);
  totalChecked += checkedCount;
  totalViolations += violationCount;
}

console.log(
  `check-doc-paths: ${totalChecked} path(s) checked in ${args.files.length} file(s), ${totalViolations} violation(s)`,
);
process.exit(totalViolations ? 1 : 0);
