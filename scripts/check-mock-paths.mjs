#!/usr/bin/env node
// Mock-path guard, gate G6 of the architecture refactor programme (step 0.7,
// rule P3 in docs/design/architecture-refactor-programme.md).
//
// A `vi.mock("<spec>")` only intercepts imports that resolve to the SAME file.
// When a module moves and a re-export shim is left at the old path, a test that
// still mocks the old path mocks the shim, and every caller already importing the
// new path runs the real module: the test goes green while testing nothing. So:
//
//   1. every vi.mock / vi.doMock target must resolve to an existing file
//      (`@/` via apps/cloud/tsconfig.json paths, relative paths, `@membral/*`
//      workspace packages, bare npm packages / node builtins);
//   2. no resolved target may be listed in shims.txt (repo root, one
//      repo-relative path per line, `#` comments allowed).
//
// usage:  npm run check:mock-paths
//
// Exit 0 when clean; exit 1 printing path:line for each violation.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["packages", "apps", "scripts", "smoke"];
const SKIP_DIRS = new Set(["node_modules", ".next", ".turbo", "dist", ".git", "coverage"]);
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(\/__tests__\/.*\.[cm]?[jt]sx?$)/;
const MOCK_CALL = /\bvi\.(?:mock|doMock)\(\s*(["'`])([^"'`]+)\1/g;
const EXTS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];

const rel = (p) => relative(REPO_ROOT, p).split("\\").join("/");

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

function stripJsonComments(text) {
  return text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (_m, str) => str ?? "");
}

// `@/*` -> apps/cloud/src/* from apps/cloud/tsconfig.json compilerOptions.paths.
function cloudAliases() {
  const dir = resolve(REPO_ROOT, "apps/cloud");
  const cfg = JSON.parse(stripJsonComments(readFileSync(resolve(dir, "tsconfig.json"), "utf8")));
  const paths = cfg.compilerOptions?.paths ?? {};
  return Object.entries(paths).map(([key, targets]) => ({
    scope: `${dir}/`,
    prefix: key.replace(/\*$/, ""),
    target: resolve(dir, cfg.compilerOptions?.baseUrl ?? ".", targets[0].replace(/\*$/, "")),
  }));
}

function workspacePackages() {
  const map = new Map();
  for (const group of ["packages", "apps"]) {
    const base = resolve(REPO_ROOT, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const pj = resolve(base, name, "package.json");
      if (existsSync(pj)) map.set(JSON.parse(readFileSync(pj, "utf8")).name, resolve(base, name));
    }
  }
  return map;
}

// Resolve a path-like target: exact file, `.js` written for a `.ts` source
// (NodeNext style), added extension, or directory index.
function resolveFile(base) {
  const isFile = (p) => existsSync(p) && statSync(p).isFile();
  if (isFile(base)) return base;
  const noJs = base.replace(/\.[cm]?jsx?$/, "");
  for (const stem of noJs === base ? [base] : [noJs, base]) {
    for (const ext of EXTS) if (isFile(stem + ext)) return stem + ext;
    for (const ext of EXTS) if (isFile(resolve(stem, `index${ext}`))) return resolve(stem, `index${ext}`);
  }
  return null;
}

function resolveWorkspace(spec, pkgs) {
  const parts = spec.split("/");
  const name = parts.slice(0, 2).join("/");
  const dir = pkgs.get(name);
  if (!dir) return undefined; // not a workspace package
  const sub = parts.slice(2).join("/");
  const pj = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
  if (!sub) {
    // Tests run against source; prefer src/index over the built entry.
    return resolveFile(resolve(dir, "src/index")) ?? resolveFile(resolve(dir, pj.main ?? "index"));
  }
  return resolveFile(resolve(dir, "src", sub)) ?? resolveFile(resolve(dir, sub));
}

function resolveBare(spec, fromFile) {
  if (isBuiltin(spec)) return "builtin";
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  for (let dir = dirname(fromFile); ; dir = dirname(dir)) {
    if (existsSync(resolve(dir, "node_modules", name, "package.json"))) return "package";
    if (dir === dirname(dir)) return null;
  }
}

function loadShims() {
  const file = resolve(REPO_ROOT, "shims.txt");
  if (!existsSync(file)) return new Set();
  return new Set(
    readFileSync(file, "utf8")
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim())
      .filter(Boolean),
  );
}

const aliases = cloudAliases();
const pkgs = workspacePackages();
const shims = loadShims();
const violations = [];
let scanned = 0;
let files = 0;

for (const root of SCAN_ROOTS) {
  for (const file of listFiles(resolve(REPO_ROOT, root))) {
    if (!TEST_FILE.test(file)) continue;
    files++;
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(MOCK_CALL)) {
        const spec = m[2];
        scanned++;
        const where = `${rel(file)}:${i + 1}`;
        let target;
        const alias = aliases.find((a) => file.startsWith(a.scope) && spec.startsWith(a.prefix));
        if (alias) target = resolveFile(resolve(alias.target, spec.slice(alias.prefix.length)));
        else if (spec.startsWith(".")) target = resolveFile(resolve(dirname(file), spec));
        else {
          const ws = resolveWorkspace(spec, pkgs);
          if (ws !== undefined) target = ws;
          else {
            if (!resolveBare(spec, file)) violations.push(`${where} vi.mock("${spec}") does not resolve to a package`);
            continue;
          }
        }
        if (!target) violations.push(`${where} vi.mock("${spec}") does not resolve to a file`);
        else if (shims.has(rel(target)))
          violations.push(
            `${where} vi.mock("${spec}") mocks shim ${rel(target)} (listed in shims.txt); mock the new path instead`,
          );
      }
    });
  }
}

for (const v of violations) console.error(`FAIL ${v}`);
console.log(
  `check-mock-paths: ${scanned} mock(s) in ${files} test file(s), ${shims.size} shim(s) listed, ${violations.length} violation(s)`,
);
process.exit(violations.length ? 1 : 0);
