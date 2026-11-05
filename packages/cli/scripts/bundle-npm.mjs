#!/usr/bin/env node
// Runs from `prepublishOnly`. Builds @membral/core and the CLI with tsc, then
// bundles dist/index.js plus @membral/core into one self-contained ESM file
// in place, so the published `membral` package has no @membral/core dependency
// to resolve. Same esbuild flags as scripts/pack.mjs (the hosted tarball).
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(CLI_DIR, "../..");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

run("npm", ["run", "build", "--workspace=@membral/core"], REPO_ROOT);
run("npm", ["run", "build"], CLI_DIR);

const tmp = mkdtempSync(join(tmpdir(), "membral-npm-"));
const out = join(tmp, "index.js");
try {
  run(
    "npx",
    ["esbuild", join(CLI_DIR, "dist/index.js"), "--bundle", "--platform=node", "--format=esm", "--target=node22", `--outfile=${out}`],
    REPO_ROOT,
  );
  copyFileSync(out, join(CLI_DIR, "dist/index.js"));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log("[bundle-npm] dist/index.js is now self-contained");
