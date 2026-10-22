#!/usr/bin/env node
// Corpus differential run, step 0.10 of the architecture refactor programme
// (docs/design/architecture-refactor-programme.md).
//
// Runs the memory pipeline (import -> tail capture with LLM replay -> fake-DB writes ->
// preamble -> open threads) over the same corpus at two commits and byte-compares the
// serialised outputs. Each SHA gets a git worktree under os.tmpdir(); the runner
// apps/cloud/src/__golden__/diff-run/run-corpus.ts is copied from the live checkout into
// both, so an older SHA runs the same runner. It runs through vitest, because the pipeline
// harness relies on vi.mock and fake timers.
//
// node_modules: when the SHA's package-lock.json equals the checkout's, the worktree gets a
// node_modules of symlinks into the checkout's, except @membral/*, which point at the
// worktree's own packages. Otherwise `npm ci --ignore-scripts` runs in the worktree.
// @membral/core and @membral/test-kit are built in the worktree when dist/ is missing.
//
// usage:  node scripts/diff-run.mjs <old-sha> <new-sha> [--corpus <dir|builtin>]... [--limit N]
//         node scripts/diff-run.mjs --self-test
//
// Default corpus: builtin (the committed pipeline golden fixtures), then
// fixtures/sessions/harvest when present. Exit 0 when every bundle is identical, 1 on any
// difference, 2 on a usage or setup error (including an old SHA that predates the lock).
import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = join(tmpdir(), "membral-diff-run");
const HARNESS = "apps/cloud/src/__golden__/pipeline/harness.ts";
const RUNNER = "apps/cloud/src/__golden__/diff-run/run-corpus.ts";
const STORE = join(REPO, "apps/cloud/src/__golden__/diff-run/replay-store");
const LINK_MARKER = ".diff-run-linked";
const USAGE =
  "usage: node scripts/diff-run.mjs <old-sha> <new-sha> [--corpus <dir|builtin>]... [--limit N] | --self-test";

class SetupError extends Error {}

function git(args, cwd = REPO) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }).trim();
}

function resolveSha(ref) {
  try {
    return git(["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    throw new SetupError(`diff-run: cannot resolve ${ref} to a commit`);
  }
}

function hasPath(sha, p) {
  return spawnSync("git", ["cat-file", "-e", `${sha}:${p}`], { cwd: REPO }).status === 0;
}

function sh(cmd, args, cwd, what) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-20).join("\n");
    throw new SetupError(`diff-run: ${what} failed in ${cwd}\n${tail}`);
  }
}

/** node_modules for a worktree: symlinks into the checkout's, @membral/* re-pointed at the worktree. */
function linkNodeModules(wt) {
  const src = join(REPO, "node_modules");
  const dst = join(wt, "node_modules");
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    if (name === "@membral" || name === ".vite" || name === ".cache") continue;
    symlinkSync(join(src, name), join(dst, name));
  }
  // Workspace links are relative (../../packages/core), so recreating them resolves inside the worktree.
  mkdirSync(join(dst, "@membral"), { recursive: true });
  for (const name of readdirSync(join(src, "@membral"))) {
    const target = readlinkSync(join(src, "@membral", name));
    if (existsSync(resolve(join(dst, "@membral"), target))) symlinkSync(target, join(dst, "@membral", name));
  }
  // Per-workspace node_modules hold no @membral links, so they are shared whole.
  for (const ws of ["apps", "packages"]) {
    if (!existsSync(join(REPO, ws))) continue;
    for (const pkg of readdirSync(join(REPO, ws))) {
      const nm = join(REPO, ws, pkg, "node_modules");
      const to = join(wt, ws, pkg, "node_modules");
      if (existsSync(nm) && existsSync(join(wt, ws, pkg)) && !existsSync(to)) symlinkSync(nm, to);
    }
  }
  writeFileSync(join(dst, LINK_MARKER), "");
}

/** A ready worktree for `sha` (created or reused), with deps, built packages and the HEAD runner. */
function prepare(sha) {
  if (!hasPath(sha, HARNESS)) {
    throw new SetupError(
      `diff-run: ${sha.slice(0, 12)}: old sha predates the behaviour lock; differential runs start at G0`,
    );
  }
  const wt = join(BASE, "wt", sha.slice(0, 12));
  const reusable =
    existsSync(join(wt, ".git")) &&
    spawnSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).stdout?.trim() === sha;
  if (!reusable) {
    rmSync(wt, { recursive: true, force: true });
    git(["worktree", "prune"]);
    mkdirSync(dirname(wt), { recursive: true });
    git(["worktree", "add", "--detach", "--force", wt, sha]);
  }
  if (!existsSync(join(wt, "node_modules"))) {
    const lock = readFileSync(join(REPO, "package-lock.json"), "utf8");
    const sameLock = hasPath(sha, "package-lock.json") && git(["show", `${sha}:package-lock.json`]) === lock.trim();
    if (sameLock) linkNodeModules(wt);
    else sh("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], wt, "npm ci");
  }
  for (const pkg of ["core", "test-kit"]) {
    const dir = join(wt, "packages", pkg);
    if (existsSync(join(dir, "package.json")) && !existsSync(join(dir, "dist", "index.js"))) {
      sh("npm", ["run", "build", "--workspace", `@membral/${pkg}`], wt, `build @membral/${pkg}`);
    }
  }
  mkdirSync(dirname(join(wt, RUNNER)), { recursive: true });
  copyFileSync(join(REPO, RUNNER), join(wt, RUNNER));
  return wt;
}

/** Runs the corpus runner in `wt` into `out`; the vitest config lives outside the worktree. */
function runCorpus(wt, out, { corpus, limit, perturb }) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const cloud = join(wt, "apps/cloud");
  const cfg = join(BASE, `vitest.${relative(join(BASE, "wt"), wt).replace(/\W/g, "_")}.config.mjs`);
  writeFileSync(
    cfg,
    [
      `import base from ${JSON.stringify(join(cloud, "vitest.config.ts"))};`,
      "export default {",
      "  ...base,",
      `  root: ${JSON.stringify(cloud)},`,
      "  test: {",
      "    ...base.test,",
      `    include: [${JSON.stringify(RUNNER.replace("apps/cloud/", ""))}],`,
      "    coverage: { ...(base.test?.coverage ?? {}), enabled: false },",
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  const env = { ...process.env, CI: "true", MEMBRAL_DIFFRUN_OUT: out };
  for (const k of Object.keys(env))
    if (k.startsWith("MEMBRAL_GOLDEN_") || k.startsWith("MEMBRAL_DIFFRUN_")) delete env[k];
  Object.assign(env, {
    MEMBRAL_DIFFRUN_OUT: out,
    MEMBRAL_DIFFRUN_CORPUS: JSON.stringify(corpus),
    MEMBRAL_DIFFRUN_STORE: STORE,
    MEMBRAL_DIFFRUN_LIMIT: String(limit ?? 0),
  });
  if (perturb) env.MEMBRAL_DIFFRUN_SELFTEST_PERTURB = "1";
  const vitest = join(wt, "node_modules", ".bin", "vitest");
  const r = spawnSync(vitest, ["run", "--config", cfg, "--reporter=dot"], {
    cwd: cloud,
    env,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (r.status !== 0) {
    const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n").slice(-25).join("\n");
    throw new SetupError(`diff-run: the corpus runner failed in ${wt}\n${tail}`);
  }
}

/** Every bundle (a dir holding files) under `root`, mapped to its sorted file names. */
function bundles(root) {
  const out = new Map();
  const walk = (dir) => {
    const files = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else files.push(e.name);
    }
    if (files.length) out.set(relative(root, dir), files.sort());
  };
  if (existsSync(root)) walk(root);
  return out;
}

/** Compares two output trees; prints one line per session and returns the number that differ. */
function compare(oldOut, newOut) {
  const a = bundles(oldOut);
  const b = bundles(newOut);
  const ids = [...new Set([...a.keys(), ...b.keys()])].sort();
  let differing = 0;
  for (const id of ids) {
    if (!a.has(id) || !b.has(id)) {
      differing++;
      console.log(`${id}: differs (only in ${a.has(id) ? "old" : "new"})`);
      continue;
    }
    const names = [...new Set([...a.get(id), ...b.get(id)])].sort();
    const changed = names.filter((n) => {
      const pa = join(oldOut, id, n);
      const pb = join(newOut, id, n);
      return !existsSync(pa) || !existsSync(pb) || !readFileSync(pa).equals(readFileSync(pb));
    });
    if (changed.length === 0) {
      console.log(`${id}: identical`);
      continue;
    }
    differing++;
    console.log(`${id}: differs (${changed.join(", ")})`);
    const first = changed.find((n) => existsSync(join(oldOut, id, n)) && existsSync(join(newOut, id, n)));
    if (first) {
      const d = spawnSync("diff", ["-u", join(oldOut, id, first), join(newOut, id, first)], { encoding: "utf8" });
      console.log(
        (d.stdout ?? "")
          .split("\n")
          .slice(0, 30)
          .map((l) => `    ${l}`)
          .join("\n"),
      );
    }
  }
  console.log(`diff-run: ${ids.length - differing}/${ids.length} sessions identical`);
  return differing;
}

function diffRun(oldRef, newRef, opts) {
  const oldSha = resolveSha(oldRef);
  const newSha = resolveSha(newRef);
  const oldWt = prepare(oldSha);
  const newWt = newSha === oldSha ? oldWt : prepare(newSha);
  const oldOut = join(BASE, "out", `old-${oldSha.slice(0, 12)}`);
  const newOut = join(BASE, "out", `new-${newSha.slice(0, 12)}`);
  console.log(
    `diff-run: old ${oldSha.slice(0, 12)}  new ${newSha.slice(0, 12)}  corpus ${JSON.stringify(opts.corpus)}${opts.limit ? `  limit ${opts.limit}` : ""}`,
  );
  runCorpus(oldWt, oldOut, { ...opts, perturb: false });
  runCorpus(newWt, newOut, { ...opts, perturb: opts.perturbNew });
  console.log(`diff-run: outputs in ${oldOut} and ${newOut}`);
  return compare(oldOut, newOut) === 0 ? 0 : 1;
}

function selfTest() {
  const self = fileURLToPath(import.meta.url);
  const cases = [
    { name: "HEAD vs HEAD, committed fixtures", args: [], want: 0 },
    { name: "HEAD vs HEAD, new side perturbed", args: ["--perturb-new"], want: 1 },
  ];
  let failed = 0;
  for (const c of cases) {
    const r = spawnSync(process.execPath, [self, "HEAD", "HEAD", "--corpus", "builtin", ...c.args], {
      cwd: REPO,
      encoding: "utf8",
    });
    const ok = r.status === c.want;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${c.name}: exit ${r.status} (want ${c.want})`);
    const tail = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split("\n");
    console.log(
      tail
        .filter((l) => /: (identical|differs)|sessions identical|predates|failed/.test(l))
        .map((l) => `       ${l}`)
        .join("\n"),
    );
  }
  console.log(`diff-run self-test: ${cases.length - failed}/${cases.length} passed`);
  return failed ? 1 : 0;
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();
  const corpus = [];
  let limit = 0;
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--corpus") {
      const v = argv[++i];
      if (!v) throw new SetupError(USAGE);
      corpus.push(v === "builtin" ? v : resolve(v));
    } else if (a === "--limit") {
      limit = Number(argv[++i]);
      if (!Number.isInteger(limit) || limit < 1) throw new SetupError(`${USAGE}\n--limit takes a positive integer`);
    } else if (a === "--perturb-new") {
      // Self-test only: the new side's runner appends a marker to every preamble.
    } else if (a.startsWith("--")) {
      throw new SetupError(`${USAGE}\nunknown flag ${a}`);
    } else pos.push(a);
  }
  if (pos.length !== 2) throw new SetupError(USAGE);
  if (corpus.length === 0) {
    corpus.push("builtin");
    const harvest = join(REPO, "fixtures/sessions/harvest");
    if (existsSync(harvest) && statSync(harvest).isDirectory()) corpus.push(harvest);
  }
  for (const c of corpus) {
    if (c !== "builtin" && !existsSync(c)) throw new SetupError(`diff-run: corpus dir ${c} does not exist`);
  }
  return diffRun(pos[0], pos[1], { corpus, limit, perturbNew: argv.includes("--perturb-new") });
}

try {
  process.exit(main(process.argv.slice(2)));
} catch (e) {
  if (!(e instanceof SetupError)) throw e;
  console.error(e.message);
  process.exit(2);
}
