#!/usr/bin/env node
// scripts/plugin/bundle-cli.mjs — builds the membral CLI into ONE
// self-contained ESM file for the Claude Code plugin:
// plugins/membral/scripts/membral.mjs (gitignored here; produced at publish
// time by scripts/plugin/stage-public-repo.sh).
//
// Same esbuild pass as packages/cli/scripts/pack.mjs (the npm tarball), but
// bundled straight from src/index.ts with __MEMBRAL_CLI_VERSION__ defined,
// because the plugin has no package.json beside the bundle for index.ts to
// read its version from. @membral/core resolves to its built dist/, so core
// is built first (turbo, cached).
//
// After bundling it checks the output: no source map, no absolute local
// path, nothing shaped like a key or token, and that `--version` and
// `preamble --help` run. Any failure exits 1 and removes the bundle.
//
// Usage: node scripts/plugin/bundle-cli.mjs [--out <file>] [--skip-build]

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_DIR = join(REPO_ROOT, "packages/cli");

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = resolve(process.cwd(), argValue("--out", join(REPO_ROOT, "plugins/membral/scripts/membral.mjs")));

// Patterns that must never appear in the published bundle. `/Users/` and
// `/home/` catch absolute local paths; the rest catch key and token shapes
// (Membral keys, OpenAI/Anthropic keys, JWTs, a Supabase project URL).
const FORBIDDEN = [
  /\/Users\//,
  /\/home\/[a-z]/,
  /sk-[A-Za-z0-9_-]{16,}/,
  /mk_[A-Za-z0-9]{16,}/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
  /[a-z0-9]{20}\.supabase\.co/,
];

// The gitignored scrub list (.claude/scrub-list.txt; format in
// scripts/check-scrub.sh). A linked worktree has none of its own, so fall
// back to the main checkout's. Absent → no check (fresh clone, CI).
function scrubListPath() {
  const own = join(REPO_ROOT, ".claude/scrub-list.txt");
  if (existsSync(own)) return own;
  try {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const main = join(dirname(common), ".claude/scrub-list.txt");
    return existsSync(main) ? main : null;
  } catch {
    return null;
  }
}

// Known benign hits: these exact identifiers are removed from the text before
// any scrub term is searched for, so only they are excused. The one entry is
// the forge CLI's host environment variable name that the ref-link code
// reads; it matches scrub terms case-insensitively. Built from char codes so
// the term is not a literal here.
const SCRUB_ALLOW = [String.fromCharCode(71, 73, 84, 76, 65, 66, 95, 72, 79, 83, 84)];

/** Scrub-list line numbers whose term appears in `text` (case-insensitive). Never returns the terms. */
function scrubListHits(text) {
  const path = scrubListPath();
  if (!path) return [];
  let hay = text;
  for (const ident of SCRUB_ALLOW) hay = hay.split(ident).join("");
  hay = hay.toLowerCase();
  const hits = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, i) => {
      if (!line || line.startsWith("#") || line.startsWith("!")) return;
      if (hay.includes(line.toLowerCase())) hits.push(i + 1);
    });
  return hits;
}

function fail(msg) {
  console.error(`[bundle-cli] FAILED: ${msg}`);
  rmSync(OUT, { force: true });
  process.exit(1);
}

async function main() {
  if (!process.argv.includes("--skip-build")) {
    execFileSync("npx", ["turbo", "build", "--filter=@membral/core"], { cwd: REPO_ROOT, stdio: "inherit" });
  }
  const version = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8")).version;
  mkdirSync(dirname(OUT), { recursive: true });

  await build({
    entryPoints: [join(CLI_DIR, "src/index.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    outfile: OUT,
    sourcemap: false,
    // Whitespace-only minify drops every comment (internal file paths,
    // decision and goal refs) while keeping identifiers readable.
    minifyWhitespace: true,
    minifyIdentifiers: false,
    minifySyntax: false,
    legalComments: "none",
    // No env value is ever inlined: only this one literal is defined.
    define: { __MEMBRAL_CLI_VERSION__: JSON.stringify(version) },
    logLevel: "warning",
  });

  const text = readFileSync(OUT, "utf8");
  if (text.includes("sourceMappingURL")) fail("bundle carries a source map reference");
  if (text.includes(REPO_ROOT)) fail("bundle contains the local repo path");
  for (const re of FORBIDDEN) {
    const m = text.match(re);
    if (m) fail(`bundle matches forbidden pattern ${re}: ${m[0].slice(0, 12)}…`);
  }
  const scrubHits = scrubListHits(text);
  if (scrubHits.length > 0) fail(`bundle contains scrub-list term(s) at scrub-list line(s) ${scrubHits.join(", ")}`);

  const env = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" };
  const got = execFileSync(process.execPath, [OUT, "--version"], { encoding: "utf8", env }).trim();
  if (got !== version) fail(`--version printed "${got}", expected "${version}"`);
  const help = execFileSync(process.execPath, [OUT, "preamble", "--help"], { encoding: "utf8", env });
  if (!help.includes("membral preamble --hook")) fail("preamble --help did not print its usage");

  const kb = Math.round(statSync(OUT).size / 1024);
  console.log(`[bundle-cli] wrote ${OUT} (${kb} KB, v${version}); --version and preamble --help OK`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
