#!/usr/bin/env node
// Pure-move check, rules P1 and P9 of the architecture refactor programme
// (step 0.7, docs/design/architecture-refactor-programme.md).
//
// A programme PR moves code; it never changes behaviour. This script reads
// `git diff <base>...HEAD` and fails mechanically when a diff claims to be a
// move but is not:
//
//   golden     a data file (anything under __snapshots__/ or snapshots/, or a
//              .json/.txt under __golden__/ or golden/) is added (allowed only with label `lock-extend`), or modified,
//              renamed with edits, or deleted (never allowed);
//   test       an existing test's lines change: a removed line that does not
//              reappear elsewhere fails (allowed only when the whole test file
//              is deleted under `test-supersede`); an added test file or added
//              lines in an existing test need `test-add`;
//   move       in any other file, every removed line that is not blank, a
//              comment, or an import/export-from line must reappear as an
//              added line somewhere in the diff (compared with whitespace
//              collapsed, spaces beside punctuation and a trailing , or ;
//              dropped, a leading `export`/`export default` dropped, and
//              relative/`@/` path strings normalised). Lines removed from a
//              re-export shim (a file whose only code is `export ... from`)
//              are exempt.
//
// Paths under docs/ and *.md files are not checked.
//
// usage:  node scripts/check-pure-move.mjs <base-sha> [--labels a,b,c] [--explain]
//         node scripts/check-pure-move.mjs --self-test
//
// Exit 0 when clean; exit 1 printing path:line [rule] for each violation.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { exemptFlags, hashComments, parseDiff } from "./lib/diff-classify.mjs";

const LABELS = ["lock-extend", "test-add", "test-supersede"];
const RULES = {
  golden: "golden/snapshot files never change; `lock-extend` allows ADDING new ones only (P1, P9)",
  "test-assertion":
    "a removed test line (an `expect(` or setup) does not reappear; only `test-supersede` deleting a whole test file allows it (P9)",
  "test-add": "new test files or new test lines need the `test-add` label (P9)",
  move: "a removed code line does not reappear elsewhere in the diff, so this is not a pure move (P1)",
  binary: "a binary non-golden file changed; a move cannot be verified line by line (P1)",
};

// Golden/snapshot DATA only; *.golden.test.ts and other sources under golden/
// dirs are test code and go through the test rule.
const GOLDEN = /(^|\/)(__snapshots__|snapshots)\/|(^|\/)(__golden__|golden)\/(.*\/)?[^/]+\.(json|txt)$/;
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(\/__tests__\/)/;
const SKIPPED = (p) => p.startsWith("docs/") || p.endsWith(".md");

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
}

function normalize(l) {
  return (
    l
      .trim()
      .replace(/\s+/g, " ")
      // Formatter noise: spaces next to punctuation and a trailing , or ;
      .replace(/ ?([()[\]{},;:]) ?/g, "$1")
      .replace(/[,;]$/, "")
      .replace(/^export (default )?/, "")
      .replace(/(["'`])(\.{1,2}\/|@\/)[^"'`]*\1/g, '"<path>"')
  );
}

function isShim(content) {
  const lines = content.split("\n");
  const flags = exemptFlags(lines);
  const code = lines.filter((l, i) => !flags[i] || /^\s*import/.test(l));
  return code.length === 0 && lines.some((l) => /^\s*export\s.*\bfrom\s/.test(l) || /^\s*\}\s*from\s/.test(l));
}

function check({ base, labels = [], cwd = process.cwd() }) {
  const has = (l) => labels.includes(l);
  const status = new Map();
  for (const row of git(["diff", "--name-status", "-M", `${base}...HEAD`], cwd)
    .split("\n")
    .filter(Boolean)) {
    const [st, a, b] = row.split("\t");
    status.set(b ?? a, st);
  }
  const raw = git(["diff", "-U0", "-M", "--no-color", "--no-ext-diff", `${base}...HEAD`], cwd);
  const files = parseDiff(raw).map((f) => {
    const path = f.newPath ?? f.oldPath;
    const st = status.get(path) ?? (f.newPath ? "M" : "D");
    return { ...f, path, st: st[0], similarity: Number(st.slice(1) || 0) };
  });

  // Pools of every non-exempt added / removed line in the whole diff.
  const addedPool = new Map();
  const removedPool = new Map();
  const bump = (pool, key) => pool.set(key, (pool.get(key) ?? 0) + 1);
  for (const f of files) {
    const af = exemptFlags(
      f.added.map((a) => a.text),
      hashComments(f.newPath),
    );
    f.added.forEach((a, i) => !af[i] && bump(addedPool, normalize(a.text)));
    const rf = exemptFlags(
      f.removed.map((r) => r.text),
      hashComments(f.oldPath),
    );
    f.removed.forEach((r, i) => !rf[i] && bump(removedPool, normalize(r.text)));
  }
  const take = (pool, key) => {
    const n = pool.get(key) ?? 0;
    if (n === 0) return false;
    pool.set(key, n - 1);
    return true;
  };

  const violations = [];
  const push = (path, ln, rule, msg) => violations.push({ path, ln, rule, msg });
  const checked = [];

  for (const f of files) {
    const { path } = f;
    if (SKIPPED(path) && (!f.oldPath || SKIPPED(f.oldPath))) continue;
    const golden = GOLDEN.test(path) || (f.oldPath && GOLDEN.test(f.oldPath));
    const test = !golden && (TEST_FILE.test(path) || (f.oldPath && TEST_FILE.test(f.oldPath)));
    checked.push({ path, st: f.st, kind: golden ? "golden" : test ? "test" : "source" });

    if (golden) {
      if (f.st === "R" && f.similarity === 100) continue;
      if (f.st === "A") {
        if (!has("lock-extend")) push(path, 1, "golden", "golden/snapshot file added without label `lock-extend`");
      } else
        push(path, f.removed[0]?.ln ?? 1, "golden", `golden/snapshot file ${f.st === "D" ? "deleted" : "modified"}`);
      continue;
    }
    if (f.binary) {
      if (!(f.st === "R" && f.similarity === 100)) push(path, 1, "binary", "binary file changed");
      continue;
    }

    const rf = exemptFlags(
      f.removed.map((r) => r.text),
      hashComments(f.oldPath),
    );
    const shimBefore = f.oldPath && f.st !== "A" ? isShim(safeShow(`${base}:${f.oldPath}`, cwd)) : false;
    for (const [i, r] of f.removed.entries()) {
      if (rf[i] || shimBefore) continue;
      if (take(addedPool, normalize(r.text))) continue;
      if (test) {
        if (f.st === "D" && has("test-supersede")) continue;
        const what = /\bexpect\(/.test(r.text) ? "assertion" : "test line";
        push(f.oldPath ?? path, r.ln, "test-assertion", `${what} removed or changed: ${r.text.trim()}`);
      } else push(f.oldPath ?? path, r.ln, "move", `removed line does not reappear: ${r.text.trim()}`);
    }

    if (test && !has("test-add")) {
      if (f.st === "A" && f.added.length) {
        // A test file added by a move is fine; one with new lines is test-add.
        const af = exemptFlags(
          f.added.map((a) => a.text),
          hashComments(path),
        );
        const fresh = f.added.find((a, i) => !af[i] && !take(removedPool, normalize(a.text)));
        if (fresh) push(path, fresh.ln, "test-add", `new test file: ${fresh.text.trim()}`);
      } else {
        const af = exemptFlags(
          f.added.map((a) => a.text),
          hashComments(path),
        );
        for (const [i, a] of f.added.entries()) {
          if (af[i] || take(removedPool, normalize(a.text))) continue;
          push(path, a.ln, "test-add", `test line added: ${a.text.trim()}`);
        }
      }
    }
  }
  return { violations, checked };
}

function safeShow(spec, cwd) {
  try {
    return git(["show", spec], cwd);
  } catch {
    return "";
  }
}

function report({ violations, checked }, { explain, labels }) {
  if (explain) {
    console.log(`labels: ${labels.length ? labels.join(", ") : "(none)"}`);
    for (const c of checked) console.log(`  ${c.st} ${c.kind.padEnd(6)} ${c.path}`);
  }
  for (const v of violations) console.error(`FAIL ${v.path}:${v.ln} [${v.rule}] ${v.msg}`);
  if (explain && violations.length) {
    console.error("rules that fired:");
    for (const rule of new Set(violations.map((v) => v.rule))) console.error(`  ${rule}: ${RULES[rule]}`);
  }
  console.log(`check-pure-move: ${checked.length} file(s) checked, ${violations.length} violation(s)`);
}

function selfTest() {
  const dir = mkdtempSync(join(tmpdir(), "check-pure-move-"));
  const run = (args) => git(args, dir);
  const write = (p, s) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), s);
  };
  const results = [];
  try {
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.email", "self-test@example.invalid"]);
    run(["config", "user.name", "self-test"]);
    run(["config", "commit.gpgsign", "false"]);
    const logic = [
      'import { log } from "./log";',
      "",
      "export function score(n: number): number {",
      "  // clamp to the window",
      "  if (n > 10) return 10;",
      "  log(n);",
      "  return n * 2;",
      "}",
      "",
    ].join("\n");
    write("src/a.ts", logic);
    write("src/log.ts", "export function log(_n: number) {}\n");
    write("src/__golden__/score.json", '{ "score": 4 }\n');
    const goldenTest = [
      'import { expect, it } from "vitest";',
      'import { score } from "../a";',
      "",
      'it("scores", () => {',
      "  expect(score(2)).toBe(4);",
      "});",
      "",
    ].join("\n");
    write("src/golden/score.golden.test.ts", goldenTest);
    run(["add", "-A"]);
    run(["commit", "-qm", "base"]);
    const base = run(["rev-parse", "HEAD"]).trim();

    const cases = [
      {
        name: "pure move to a new module with a shim at the old path passes",
        expect: 0,
        apply: () => {
          write("src/lib/score.ts", logic.replace('"./log"', '"../log"'));
          write("src/a.ts", 'export { score } from "./lib/score";\n');
        },
      },
      {
        name: "move that edits one logic line fails [move]",
        expect: 1,
        apply: () => {
          write("src/lib/score.ts", logic.replace('"./log"', '"../log"').replace("n > 10", "n >= 10"));
          write("src/a.ts", 'export { score } from "./lib/score";\n');
        },
      },
      {
        name: "golden edit without a label fails [golden]",
        expect: 1,
        apply: () => write("src/__golden__/score.json", '{ "score": 5 }\n'),
      },
      {
        name: "reformatting a *.golden.test.ts passes",
        expect: 0,
        apply: () =>
          write(
            "src/golden/score.golden.test.ts",
            goldenTest
              .replace(
                'import { expect, it } from "vitest";\nimport { score } from "../a";',
                'import { score } from "../a";\nimport { expect, it } from "vitest";',
              )
              .replace("  expect(score(2)).toBe(4);", "    expect( score(2) ).toBe(4);"),
          ),
      },
      {
        name: "golden add with `lock-extend` passes",
        expect: 0,
        labels: ["lock-extend"],
        apply: () => write("src/__golden__/other.json", '{ "score": 6 }\n'),
      },
    ];
    for (const c of cases) {
      run(["checkout", "-q", "-B", "case", base]);
      c.apply();
      run(["add", "-A"]);
      run(["commit", "-qm", c.name]);
      const { violations } = check({ base, labels: c.labels ?? [], cwd: dir });
      const got = violations.length ? 1 : 0;
      results.push({ ...c, got, violations });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  let failed = 0;
  for (const r of results) {
    const ok = r.got === r.expect;
    if (!ok) failed++;
    console.log(`${ok ? "ok  " : "FAIL"} ${r.name} (exit ${r.got}, expected ${r.expect})`);
    for (const v of r.violations) console.log(`       ${v.path}:${v.ln} [${v.rule}] ${v.msg}`);
  }
  console.log(`check-pure-move self-test: ${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();
  const explain = argv.includes("--explain");
  const li = argv.indexOf("--labels");
  const labels =
    li >= 0 && argv[li + 1]
      ? argv[li + 1]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const base = argv.find((a, i) => !a.startsWith("--") && argv[i - 1] !== "--labels");
  if (!base) {
    console.error("usage: node scripts/check-pure-move.mjs <base-sha> [--labels a,b,c] [--explain] | --self-test");
    process.exit(2);
  }
  const unknown = labels.filter((l) => !LABELS.includes(l));
  if (explain && unknown.length) console.log(`ignoring non-P9 labels: ${unknown.join(", ")}`);
  const result = check({ base, labels });
  report(result, { explain, labels });
  process.exit(result.violations.length ? 1 : 0);
}

main(process.argv.slice(2));
