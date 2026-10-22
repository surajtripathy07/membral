#!/usr/bin/env node
// scripts/check-ci-local-sync.mjs — D-060: keeps scripts/ci-local.sh in step
// with the `gate` job of .github/workflows/ci.yml.
//
// Extracts every `run:` command of the `gate` job (single-line and `run: |`
// blocks, one line at a time, trimmed) and asserts each appears verbatim on a
// non-comment line of scripts/ci-local.sh. Exits 1 naming each missing command.
//
// `npm ci` is exempt: ci-local runs against the existing node_modules rather
// than wiping and reinstalling them on every push. So is the runner's
// `npm install -g npm@<version>` (toolchain setup; locally your npm is yours).
//
// No YAML dependency: the workflow's shape (two-space job keys under `jobs:`,
// `run:` keys inside steps) is parsed line by line.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8").split("\n");
// Comment lines do not count: a commented-out command is a missing command.
const scriptLines = readFileSync(join(root, "scripts/ci-local.sh"), "utf8")
  .split("\n")
  .filter((l) => !l.trimStart().startsWith("#"));
// Verbatim, and not merely a prefix of a longer word (`check:x` vs `check:x-y`).
const present = (cmd) =>
  scriptLines.some((l) => {
    for (let at = l.indexOf(cmd); at !== -1; at = l.indexOf(cmd, at + 1)) {
      if (!/[\w:-]/.test(l[at + cmd.length] ?? "")) return true;
    }
    return false;
  });
// Only the npm that package.json's `packageManager` names: a ci.yml pin that
// drifts from it is reported as missing.
const npmPin = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).packageManager;
const exempt = (c) => c === "npm ci" || c === `npm install -g ${npmPin}`;

const indentOf = (line) => line.length - line.trimStart().length;

const start = workflow.findIndex((l) => /^ {2}gate:\s*$/.test(l));
if (start === -1) {
  console.error("check-ci-local-sync: no `gate:` job found in .github/workflows/ci.yml");
  process.exit(1);
}
let end = workflow.length;
for (let i = start + 1; i < workflow.length; i++) {
  if (/^ {2}\S/.test(workflow[i]) || /^\S/.test(workflow[i])) {
    end = i;
    break;
  }
}

const commands = [];
for (let i = start + 1; i < end; i++) {
  const m = workflow[i].match(/^(\s*)(?:- )?run:\s*(.*)$/);
  if (!m) continue;
  const value = m[2].trim();
  if (value === "|" || value === ">") {
    const keyIndent = indentOf(workflow[i]);
    for (let j = i + 1; j < end; j++) {
      const line = workflow[j];
      if (line.trim() === "") continue;
      if (indentOf(line) <= keyIndent) break;
      commands.push(line.trim());
      i = j;
    }
  } else if (value) {
    commands.push(value);
  }
}

if (commands.length === 0) {
  console.error("check-ci-local-sync: found no `run:` commands in the gate job");
  process.exit(1);
}

const missing = commands.filter((c) => !exempt(c) && !present(c));
if (missing.length > 0) {
  console.error("check-ci-local-sync: scripts/ci-local.sh is missing gate commands from ci.yml:");
  for (const c of missing) console.error(`  ${c}`);
  process.exit(1);
}
const checked = commands.filter((c) => !exempt(c)).length;
console.log(`check-ci-local-sync: ${checked} gate commands present in scripts/ci-local.sh`);
