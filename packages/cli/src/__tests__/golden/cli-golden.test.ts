// Step 0.5 of the behaviour lock (docs/design/architecture-refactor-programme.md
// row 0.5; docs/archive/goals/2026-09-27_g0-behaviour-lock_goal.md). Unlike
// ../help.test.ts (which spawns the built dist too, but asserts equality
// against src/help.ts's own exported constants — a change to those
// constants is invisible to it; behaviour-lock review finding F8), every
// case here compares against a COMMITTED TEXT FILE under golden/snapshots/,
// via vitest's toMatchFileSnapshot: under CI=true a missing or mismatched
// file fails the test and nothing is written; without CI, a missing file is
// written once (`git status --short` then shows it as a new file to review
// and commit) and an existing one is compared, never silently rewritten.
//
// `status` and `sessions` never make a network call in the scenarios below
// (statusCommand reads only local files; `sessions --dry-run` returns
// before resolveUploadConfig/uploadBatch run — see import-sessions.ts's
// "Dry run — no network calls made." branch), so no stub HTTP server is
// started; SCOPE's brief allows this ("if the command works offline, no
// server"). A later step (0.4/0e, per the behaviour-lock review) is where a
// real upload round trip against recorded route snapshots belongs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { HIDDEN_COMMANDS, PUBLIC_COMMANDS } from "../../help.js";
import { CLI_BIN, goldenEnv, normalize, runCli } from "./spawn.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const VERSION = (JSON.parse(readFileSync(resolve(__dirname, "../../../package.json"), "utf8")) as { version: string })
  .version;

const KNOWN_COMMANDS = [...PUBLIC_COMMANDS, ...HIDDEN_COMMANDS];

/** Fixed device.json — otherwise loadOrCreateDeviceIdentity() mints a random uuid + this machine's real hostname on first use, which would make `status` non-deterministic across machines and runs. */
const FIXED_DEVICE = { id: "00000000-0000-4000-8000-000000000000", name: "golden-test-device", platform: "linux" };

function seedDevice(home: string): void {
  const dir = join(home, ".membral");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "device.json"), JSON.stringify(FIXED_DEVICE));
}

beforeAll(() => {
  if (!existsSync(CLI_BIN)) {
    throw new Error("dist/index.js missing — run 'npx turbo build --filter=@membral/cli' first");
  }
});

/** Runs `args`, normalizes `home` and the CLI version out of the result, and compares against golden/snapshots/<name>.txt. */
async function golden(name: string, args: string[], home: string, envOverrides: NodeJS.ProcessEnv = {}) {
  const r = await runCli(args, goldenEnv(home, envOverrides));
  await expect(normalize(r, home, VERSION)).toMatchFileSnapshot(`snapshots/${name}.txt`);
}

describe("help surfaces", () => {
  const home = mkdtempSync(join(tmpdir(), "membral-golden-help-"));

  it("no args", async () => {
    await golden("help/no-args", [], home);
  });
  it("--help", async () => {
    await golden("help/help-flag", ["--help"], home);
  });
  it("-h", async () => {
    await golden("help/h-flag", ["-h"], home);
  });
  it("bare help", async () => {
    await golden("help/bare", ["help"], home);
  });
  it("help --all", async () => {
    await golden("help/all", ["help", "--all"], home);
  });
});

describe("version surfaces", () => {
  const home = mkdtempSync(join(tmpdir(), "membral-golden-version-"));

  it("--version", async () => {
    await golden("version/version-flag", ["--version"], home);
  });
  it("-v", async () => {
    await golden("version/v-flag", ["-v"], home);
  });
});

describe("unknown command", () => {
  const home = mkdtempSync(join(tmpdir(), "membral-golden-unknown-"));

  it("nonsense", async () => {
    await golden("unknown/nonsense", ["nonsense"], home);
  });
  it("nonsense --help (unknown-command error wins over the help guard)", async () => {
    await golden("unknown/nonsense-help", ["nonsense", "--help"], home);
  });
});

describe("per-command --help, every command in the switch (PUBLIC_COMMANDS + HIDDEN_COMMANDS)", () => {
  const home = mkdtempSync(join(tmpdir(), "membral-golden-cmd-help-"));

  it.each(KNOWN_COMMANDS)("%s --help", async (name) => {
    await golden(`cmd-help/${name}`, [name, "--help"], home);
  });
});

describe("status", () => {
  it("logged out — no credentials.json, no sync.json, no sweep-state.json", async () => {
    const home = mkdtempSync(join(tmpdir(), "membral-golden-status-out-"));
    seedDevice(home);
    await golden("status/logged-out", ["status"], home);
  });

  it("logged in — credentials.json, sync.json and sweep-state.json all seeded", async () => {
    const home = mkdtempSync(join(tmpdir(), "membral-golden-status-in-"));
    seedDevice(home);
    const membralDir = join(home, ".membral");
    // Pre-profiles (flat) credentials.json shape — see credentials.ts's
    // loadProfiles(): read as a single profile named from its URL
    // (profileNameForUrl("http://localhost:3000") === "local").
    writeFileSync(
      join(membralDir, "credentials.json"),
      JSON.stringify({
        apiUrl: "http://localhost:3000",
        apiKey: "lls_test_fixedkey000000",
        email: "dev@example.test",
        userId: "11111111-1111-4111-8111-111111111111",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    writeFileSync(
      join(membralDir, "sync.json"),
      JSON.stringify({
        version: 1,
        harnesses: { "claude-code": { projects: [{ path: "/home/dev/acme-widgets", enabled: true }] } },
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    writeFileSync(
      join(membralDir, "sweep-state.json"),
      JSON.stringify({ last_success_at: "2026-01-01T00:00:00Z", run_count: 3, runs_since_full_walk: 1 }),
    );
    await golden("status/logged-in", ["status"], home);
  });

  it("env key shadows a fresh login — MEMBRAL_API_KEY wins over credentials.json (precedence: flags > env > file)", async () => {
    const home = mkdtempSync(join(tmpdir(), "membral-golden-status-envshadow-"));
    seedDevice(home);
    writeFileSync(
      join(home, ".membral", "credentials.json"),
      JSON.stringify({
        apiUrl: "http://localhost:3000",
        apiKey: "lls_test_fixedkey000000",
        email: "dev@example.test",
        userId: "11111111-1111-4111-8111-111111111111",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    // goldenEnv() scrubs MEMBRAL_*/CLAUDE_CODE_* by default (the stale-env-
    // key gotcha) — this is the one golden case that deliberately puts one
    // back, via envOverrides (applied AFTER the scrub — see spawn.ts), to
    // pin the documented precedence and the past "stale env key shadows a
    // fresh login" incident (memory: stale-env-api-key-shadows-credentials).
    await golden("status/status-env-key-shadow", ["status"], home, { MEMBRAL_API_KEY: "lls_envshadow000" });
  });
});

describe("sessions", () => {
  it("--dry-run --source claude-code, one fixed fixture session", async () => {
    const home = mkdtempSync(join(tmpdir(), "membral-golden-sessions-"));
    seedDevice(home);
    // The fixture lives under `home` itself (not the repo checkout path) so
    // the ONLY path that ever appears in this command's output is `home`,
    // which normalize() replaces with <HOME> — a checkout-path-independent
    // golden. See fixtures/sessions/session-1.jsonl for the fixed content
    // (single line, fixed cwd/branch/timestamp — the same shape
    // import-sessions.test.ts's own `sessionLine()` helper produces).
    // claudeCodeParser.detect() (packages/core/src/sessions/claude-code.ts)
    // requires one level of project-directory nesting under root — a
    // *.jsonl directly in root is invisible to it — so the fixture goes in
    // root/acme-widgets/, not root itself.
    const root = join(home, "claude-projects");
    const projectDir = join(root, "acme-widgets");
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, "session-1.jsonl"),
      readFileSync(resolve(__dirname, "fixtures/sessions/session-1.jsonl"), "utf8"),
    );
    await golden("sessions/dry-run", ["sessions", "--source", "claude-code", "--root", root, "--dry-run"], home);
  });
});
