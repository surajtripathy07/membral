#!/usr/bin/env node
// Coverage-gated moves, step 0.9 of the architecture refactor programme
// (docs/design/architecture-refactor-programme.md).
//
// A move PR must not leave a branch of a touched module unexercised by any
// golden or unit test without saying so. This script reads
// `git diff <base>...HEAD`, finds the source files a move PR touched, runs
// each owning package's vitest suite under v8 branch coverage, and fails
// when any of those files has an uncovered branch that the PR body does not
// list as `accepted-uncovered: <path>:<line>`.
//
// usage:  node scripts/check-move-coverage.mjs <base-sha> [--accepted-file <path> | --pr-body-file <path>] [--reuse]
//         node scripts/check-move-coverage.mjs --self-test
//
// Exit 0 when every uncovered branch of every changed file is accepted (or
// there are none). Exit 1 printing path:line:col [branch-type] for each
// unaccepted uncovered branch, followed by the exact `accepted-uncovered:`
// lines to paste into the PR body.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { exemptFlags, hashComments, parseDiff } from "./lib/diff-classify.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Source files a move PR can touch. Everything else (docs, config, fixtures)
// is out of scope for this check.
const SRC = (p) => /^packages\/[^/]+\/src\/.*\.ts$/.test(p) || /^apps\/cloud\/src\/.*\.tsx?$/.test(p);
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(\/__tests__\/)/;
const EXCLUDED = (p) =>
  TEST_FILE.test(p) ||
  /(^|\/)__golden__\//.test(p) ||
  /(^|\/)(__snapshots__|snapshots)\//.test(p) ||
  p.endsWith(".d.ts") ||
  /\.generated\.tsx?$/.test(p);

function git(args, cwd = REPO_ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

function filterChangedFiles(paths) {
  return paths.filter((p) => SRC(p) && !EXCLUDED(p));
}

// True when every changed line of `file` (added lines by new-file number,
// removed lines by old-file number) is blank, a comment, or part of an
// import / export-from statement. Such a file has no moved code to cover.
function isImportOnlyChange(base, file, cwd = REPO_ROOT) {
  const diff = git(["diff", "-U0", "-M", `${base}...HEAD`, "--", file], cwd);
  const [d] = parseDiff(diff);
  if (!d || d.binary) return false;
  const show = (spec) => {
    try {
      return git(["show", spec], cwd).split("\n");
    } catch {
      return [];
    }
  };
  const mergeBase = git(["merge-base", base, "HEAD"], cwd).trim();
  const newFlags = exemptFlags(show(`HEAD:${file}`), hashComments(file));
  const oldFlags = exemptFlags(show(`${mergeBase}:${d.oldPath ?? file}`), hashComments(file));
  return d.added.every((l) => newFlags[l.ln - 1]) && d.removed.every((l) => oldFlags[l.ln - 1]);
}

// packages/<name>/src/... -> packages/<name>; apps/cloud/src/... -> apps/cloud.
function packageDirFor(path) {
  if (path.startsWith("apps/cloud/")) return "apps/cloud";
  const m = /^packages\/([^/]+)\//.exec(path);
  return m ? `packages/${m[1]}` : null;
}

function groupByPackage(files) {
  const groups = new Map();
  for (const f of files) {
    const dir = packageDirFor(f);
    if (!dir) continue;
    if (!groups.has(dir)) groups.set(dir, []);
    groups.get(dir).push(f);
  }
  return groups;
}

function coveragePathFor(pkgDir) {
  return join(REPO_ROOT, pkgDir, "coverage", "coverage-final.json");
}

function headCommitTimeMs() {
  return Number(git(["log", "-1", "--format=%ct", "HEAD"]).trim()) * 1000;
}

function ensureCoverage(pkgDir, { reuse }) {
  const covPath = coveragePathFor(pkgDir);
  if (reuse) {
    try {
      const mtime = statSync(covPath).mtimeMs;
      if (mtime >= headCommitTimeMs()) return covPath;
    } catch {
      // no existing coverage file; fall through to running it.
    }
  }
  execFileSync("npx", ["vitest", "run", "--coverage", "--coverage.reporter=json"], {
    cwd: join(REPO_ROOT, pkgDir),
    stdio: "inherit",
  });
  return covPath;
}

// Extract every uncovered branch of `changedFiles` (repo-relative paths) from
// one package's istanbul coverage-final.json, keyed by absolute file path.
function computeUncoveredBranches(coverageJson, changedFiles) {
  const out = [];
  for (const relPath of changedFiles) {
    const abs = join(REPO_ROOT, relPath);
    const entry = coverageJson[abs];
    if (!entry) continue; // file has no coverage entry at all (not built/instrumented)
    for (const [branchId, branch] of Object.entries(entry.branchMap ?? {})) {
      const counts = entry.b?.[branchId] ?? [];
      branch.locations.forEach((loc, idx) => {
        if ((counts[idx] ?? 0) === 0) {
          out.push({
            path: relPath,
            line: loc.start.line,
            col: loc.start.column,
            type: branch.type,
          });
        }
      });
    }
  }
  return out;
}

// Lines of shape `accepted-uncovered: path:line` (optionally with trailing
// `:col [type]` commentary, which is ignored for matching) become the set of
// accepted "path:line" keys.
function parseAccepted(text) {
  const accepted = new Set();
  for (const line of text.split("\n")) {
    const m = /^\s*accepted-uncovered:\s*(\S+)/.exec(line);
    if (!m) continue;
    const parts = m[1].split(":");
    if (parts.length >= 2) accepted.add(`${parts[0]}:${parts[1]}`);
  }
  return accepted;
}

function decide(uncovered, accepted) {
  const unaccepted = uncovered.filter((b) => !accepted.has(`${b.path}:${b.line}`));
  return { unaccepted, exitCode: unaccepted.length ? 1 : 0 };
}

function report(uncovered, unaccepted) {
  if (unaccepted.length) {
    for (const b of unaccepted) console.error(`FAIL ${b.path}:${b.line}:${b.col} [${b.type}]`);
    console.error("");
    console.error("Paste into the PR body to accept (one per uncovered line):");
    const keys = [...new Set(unaccepted.map((b) => `${b.path}:${b.line}`))].sort();
    for (const k of keys) console.error(`accepted-uncovered: ${k}`);
  }
  console.log(`check-move-coverage: ${uncovered.length} uncovered branch(es), ${unaccepted.length} not accepted`);
}

function readAccepted(argv) {
  const idxA = argv.indexOf("--accepted-file");
  const idxB = argv.indexOf("--pr-body-file");
  const path = idxA >= 0 ? argv[idxA + 1] : idxB >= 0 ? argv[idxB + 1] : null;
  if (!path) return new Set();
  if (!existsSync(path)) return new Set();
  return parseAccepted(readFileSync(path, "utf8"));
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();

  const base = argv.find(
    (a, i) => !a.startsWith("--") && argv[i - 1] !== "--accepted-file" && argv[i - 1] !== "--pr-body-file",
  );
  if (!base) {
    console.error(
      "usage: node scripts/check-move-coverage.mjs <base-sha> [--accepted-file <path>|--pr-body-file <path>] [--reuse] | --self-test",
    );
    process.exit(2);
  }
  const reuse = argv.includes("--reuse");

  const changedRaw = git(["diff", "--name-only", "-M", `${base}...HEAD`])
    .split("\n")
    .filter(Boolean);
  const changed = filterChangedFiles(changedRaw).filter((f) => !isImportOnlyChange(base, f));
  if (!changed.length) {
    console.log("check-move-coverage: 0 changed source file(s) in scope, nothing to check");
    process.exit(0);
  }

  const accepted = readAccepted(argv);
  const groups = groupByPackage(changed);
  const uncovered = [];
  for (const [pkgDir, files] of groups) {
    const covPath = ensureCoverage(pkgDir, { reuse });
    const coverageJson = JSON.parse(readFileSync(covPath, "utf8"));
    uncovered.push(...computeUncoveredBranches(coverageJson, files));
  }

  const { unaccepted, exitCode } = decide(uncovered, accepted);
  report(uncovered, unaccepted);
  process.exit(exitCode);
}

function selfTest() {
  const results = [];
  const check = (name, fn) => {
    try {
      fn();
      results.push({ name, ok: true });
    } catch (e) {
      results.push({ name, ok: false, err: e.message });
    }
  };
  const assertEqual = (a, b, msg) => {
    const sa = JSON.stringify(a);
    const sb = JSON.stringify(b);
    if (sa !== sb) throw new Error(`${msg ?? "mismatch"}: got ${sa}, expected ${sb}`);
  };

  check("filterChangedFiles keeps in-scope source, drops tests/golden/d.ts/generated", () => {
    const input = [
      "packages/core/src/graph.ts",
      "apps/cloud/src/lib/memory/write.ts",
      "apps/cloud/src/lib/memory/write.test.ts",
      "apps/cloud/src/lib/memory/__tests__/write.ts",
      "apps/cloud/src/__golden__/routes/x.json",
      "packages/core/src/index.d.ts",
      "apps/cloud/src/lib/database.generated.ts",
      "docs/design/foo.md",
    ];
    assertEqual(filterChangedFiles(input), ["packages/core/src/graph.ts", "apps/cloud/src/lib/memory/write.ts"]);
  });

  check("computeUncoveredBranches reports only zero-count branch locations", () => {
    const abs = join(REPO_ROOT, "packages/core/src/graph.ts");
    const coverageJson = {
      [abs]: {
        branchMap: {
          0: { type: "if", locations: [{ start: { line: 10, column: 2 } }, { start: { line: 12, column: 2 } }] },
          1: {
            type: "binary-expr",
            locations: [{ start: { line: 20, column: 8 } }, { start: { line: 20, column: 20 } }],
          },
        },
        b: { 0: [3, 0], 1: [5, 5] },
      },
    };
    const out = computeUncoveredBranches(coverageJson, ["packages/core/src/graph.ts"], "packages/core");
    assertEqual(out, [{ path: "packages/core/src/graph.ts", line: 12, col: 2, type: "if" }]);
  });

  check("parseAccepted extracts path:line, ignoring trailing col/type commentary", () => {
    const text = [
      "Some PR description.",
      "accepted-uncovered: packages/core/src/graph.ts:12",
      "accepted-uncovered: apps/cloud/src/lib/x.ts:5:2 [if]",
      "not-a-match: apps/cloud/src/lib/y.ts:9",
      "",
    ].join("\n");
    const accepted = parseAccepted(text);
    assertEqual([...accepted].sort(), ["apps/cloud/src/lib/x.ts:5", "packages/core/src/graph.ts:12"]);
  });

  check("decide fails on any unaccepted uncovered branch, passes once all are accepted", () => {
    const uncovered = [
      { path: "a.ts", line: 1, col: 0, type: "if" },
      { path: "a.ts", line: 2, col: 0, type: "if" },
    ];
    const none = decide(uncovered, new Set());
    assertEqual(none.exitCode, 1);
    assertEqual(none.unaccepted.length, 2);

    const partial = decide(uncovered, new Set(["a.ts:1"]));
    assertEqual(partial.exitCode, 1);
    assertEqual(partial.unaccepted, [{ path: "a.ts", line: 2, col: 0, type: "if" }]);

    const all = decide(uncovered, new Set(["a.ts:1", "a.ts:2"]));
    assertEqual(all.exitCode, 0);
    assertEqual(all.unaccepted.length, 0);
  });

  check("decide passes trivially when there are no uncovered branches", () => {
    assertEqual(decide([], new Set()).exitCode, 0);
  });

  check("isImportOnlyChange: import-only diff skipped, real change kept", () => {
    const dir = mkdtempSync(join(tmpdir(), "check-move-coverage-"));
    const g = (...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
    const put = (p, t) => {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), t);
    };
    try {
      g("init", "-q", "-b", "main");
      g("config", "user.email", "t@example.invalid");
      g("config", "user.name", "t");
      g("config", "commit.gpgsign", "false");
      const body = "export function f(a: number) {\n  return a > 1 ? 1 : 2;\n}\n";
      put("packages/core/src/a.ts", `import { x } from "./x";\nimport {\n  y,\n} from "./y";\n${body}`);
      put("packages/core/src/b.ts", `import { x } from "./x";\n${body}`);
      g("add", "-A");
      g("commit", "-qm", "base");
      const base = g("rev-parse", "HEAD").trim();
      put("packages/core/src/a.ts", `import { x } from "./x";\nimport {\n  y,\n  z,\n} from "./y";\nimport { w } from "./w";\n${body}`);
      put("packages/core/src/b.ts", `import { x } from "./x";\n${body.replace("a > 1", "a > 2")}`);
      g("commit", "-qam", "change");
      assertEqual(isImportOnlyChange(base, "packages/core/src/a.ts", dir), true, "import-only a.ts");
      assertEqual(isImportOnlyChange(base, "packages/core/src/b.ts", dir), false, "code change b.ts");
      // Import-only diff => nothing left in scope => 0 branches reported.
      const inScope = filterChangedFiles(["packages/core/src/a.ts"]).filter((f) => !isImportOnlyChange(base, f, dir));
      assertEqual(computeUncoveredBranches({}, inScope), [], "0 branches on import-only diff");
      assertEqual(inScope.length, 0, "no files in scope");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed++;
    console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : ` — ${r.err}`}`);
  }
  console.log(`check-move-coverage self-test: ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

main(process.argv.slice(2));
