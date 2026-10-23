#!/usr/bin/env node
// packages/cli/scripts/pack.mjs — goal P5 (docs/goals/2026-09-24_memory-on-prod-new-user_goal.md):
// packages @membral/cli as a standalone, monorepo-free npm tarball so
// `npm i -g https://membral.me/membral-cli.tgz` works on a clean machine
// with only Node + npm — no repo checkout, no postinstall that needs the
// workspace.
//
// Same shape as apps/cloud/scripts/package-extension.mjs: this script
// builds the CLI itself from current source (never assumes dist/ is
// already fresh) into a staging directory it fully controls, then runs
// `npm pack` there.
//
// Why bundle instead of `bundledDependencies`: @membral/core is a workspace
// package with no published npm version — `bundledDependencies` still
// needs npm to resolve/install it from *somewhere* at install time, which a
// clean machine (no workspace, no registry entry for @membral/core) can't
// do. Bundling with esbuild closes that edge: the CLI's only runtime import
// outside Node builtins is @membral/core (grep-verified below), so one
// esbuild pass produces a single self-contained ESM file with zero npm
// dependencies to resolve on install.
//
// Usage: node packages/cli/scripts/pack.mjs [--out <path-to.tgz>] [--force-build]
// Default --out: packages/cli/dist-pack/membral-cli.tgz (gitignored).
// --force-build: always run the nested turbo build in step 1, even if
// dist/ looks fresh (see distIsFresh below).

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(__dirname, "..");
const REPO_ROOT = resolve(CLI_DIR, "../..");

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const OUT = resolve(process.cwd(), argValue("--out", join(CLI_DIR, "dist-pack/membral-cli.tgz")));

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

// Newest mtime (ms) of any file under `dir`, recursing into subdirectories.
// 0 if `dir` doesn't exist. Plain readdirSync/statSync recursion (not the
// Node 20.12+ `recursive` readdirSync option) so this doesn't depend on a
// Dirent field that varies across the Node 20.x point releases this runs on
// in CI/Vercel.
function newestMtimeMs(dir) {
  let newest = 0;
  if (!existsSync(dir)) return newest;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      newest = Math.max(newest, newestMtimeMs(full));
    } else if (st.isFile() && st.mtimeMs > newest) {
      newest = st.mtimeMs;
    }
  }
  return newest;
}

// N4 (P10 re-review): once apps/cloud/package.json depends on "@membral/cli",
// turbo's own "^build" already builds @membral/cli (and transitively
// @membral/core, via THEIR OWN "^build") before the outer turbo task that
// runs this script (apps/cloud's `prebuild`) starts — so dist/ is already
// current every time this runs under turbo, and a second, independent
// `npx turbo build` here would just be redundant work racing that same
// dist/ directory (turbo-inside-turbo). Detect that case by mtime instead of
// assuming it: only treat dist/ as fresh when both packages' built entry
// files are newer than every file in both packages' src/.
function distIsFresh() {
  const coreDir = resolve(CLI_DIR, "../core");
  const cliEntry = join(CLI_DIR, "dist/index.js");
  const coreEntry = join(coreDir, "dist/index.js");
  if (!existsSync(cliEntry) || !existsSync(coreEntry)) return false;

  const distMtime = Math.min(statSync(cliEntry).mtimeMs, statSync(coreEntry).mtimeMs);
  const srcMtime = Math.max(newestMtimeMs(join(CLI_DIR, "src")), newestMtimeMs(join(coreDir, "src")));
  return distMtime >= srcMtime;
}

function main() {
  // 1. Build @membral/core and @membral/cli from current source — unless
  //    dist/ is already fresh (see distIsFresh above), which is the normal
  //    case when this script runs as apps/cloud's `prebuild` under the outer
  //    `npx turbo build --filter=@membral/cloud`: turbo's own dependency
  //    graph has already built both by the time that task starts. Falls
  //    back to building here (uses turbo, not a bare `tsc`, so a warm cache
  //    is still reused) when invoked standalone, e.g. a developer running
  //    this script directly without a prior turbo build, or `--force-build`.
  const forceBuild = process.argv.includes("--force-build");
  if (forceBuild || !distIsFresh()) {
    run("npx", ["turbo", "build", "--filter=@membral/core", "--filter=@membral/cli"], REPO_ROOT);
  } else {
    console.log("[pack-cli] @membral/cli and @membral/core dist/ already fresh — skipping nested turbo build");
  }

  // 2. Bundle the built CLI entry + @membral/core into one self-contained
  //    ESM file. `--target=node20` matches this tarball's `engines` floor
  //    (requirement: install on a clean machine with only Node >= 20).
  //    No `--banner:js` shebang: dist/index.js's own `#!/usr/bin/env node`
  //    is on line 1 of the entry file and esbuild already carries it
  //    through to the bundle's line 1 — adding a second one here produced
  //    an invalid second `#!` line (only line 1 is special-cased by Node)
  //    and a SyntaxError on every invocation, caught by the clean-install
  //    verification below.
  const stage = mkdtempSync(join(tmpdir(), "membral-cli-pack-"));
  const stageDist = join(stage, "dist");
  mkdirSync(stageDist, { recursive: true });

  run(
    "npx",
    [
      "esbuild",
      join(CLI_DIR, "dist/index.js"),
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node20",
      `--outfile=${join(stageDist, "index.js")}`,
    ],
    REPO_ROOT,
  );

  // 3. A clean package.json for the tarball: no workspace "*" dependency
  //    (bundled away), no devDependencies/build scripts that would need the
  //    monorepo, `private: true` kept so this can never be `npm publish`ed
  //    by accident (npm pack does not require dropping it).
  const pkgSrc = JSON.parse(readFileSync(join(CLI_DIR, "package.json"), "utf8"));
  const pkgOut = {
    name: pkgSrc.name,
    version: pkgSrc.version,
    description: pkgSrc.description,
    license: pkgSrc.license,
    private: true,
    type: "module",
    engines: { node: pkgSrc.engines?.node ?? ">=22.5.0" },
    bin: pkgSrc.bin,
    main: pkgSrc.main,
    files: ["dist"],
  };
  writeFileSync(join(stage, "package.json"), `${JSON.stringify(pkgOut, null, 2)}\n`);
  copyFileSync(join(REPO_ROOT, "LICENSE"), join(stage, "LICENSE"));

  // 4. `npm pack` the staging dir straight to OUT's directory, then rename
  //    npm's own `<name>-<version>.tgz` output to the requested path.
  const outDir = dirname(OUT);
  mkdirSync(outDir, { recursive: true });
  run("npm", ["pack", "--silent", "--pack-destination", outDir], stage);
  const producedName = `${pkgOut.name.replace(/^@/, "").replace("/", "-")}-${pkgOut.version}.tgz`;
  const produced = join(outDir, producedName);
  copyFileSync(produced, OUT);
  if (produced !== OUT) rmSync(produced);
  rmSync(stage, { recursive: true, force: true });

  console.log(`[pack-cli] wrote ${OUT}`);
}

main();
