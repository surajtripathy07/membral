// The Claude Code plugin's hook entry (plugins/membral/scripts/run.mjs):
// double-install guard, key/URL hand-off, and the first/catch-up imports.
// run.mjs is copied next to a fake membral.mjs that records how it was
// called, so no network and no real CLI are involved.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const RUN = join(dirname(fileURLToPath(import.meta.url)), "../../../../plugins/membral/scripts/run.mjs");

const FAKE_CLI = `
import { appendFileSync } from "node:fs";
import { join } from "node:path";
const call = { argv: process.argv.slice(2), key: process.env.MEMBRAL_API_KEY, url: process.env.MEMBRAL_API_URL, timeout: process.env.MEMBRAL_PREAMBLE_TIMEOUT_MS };
if (call.argv[0] === "sessions") {
  appendFileSync(join(process.env.CLAUDE_PLUGIN_DATA, "sessions-ran.jsonl"), JSON.stringify(call) + "\\n");
  process.exit(Number(process.env.FAKE_SESSIONS_EXIT || 0));
}
console.log(JSON.stringify(call));
process.exit(0);
`;

describe("plugin run.mjs", () => {
  let dir: string;
  let root: string;
  let data: string;
  let config: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-plugin-run-"));
    root = join(dir, "plugin", "scripts");
    data = join(dir, "data", "nested"); // run.mjs must create it
    config = join(dir, "claude");
    for (const d of [root, config]) mkdirSync(d, { recursive: true });
    copyFileSync(RUN, join(root, "run.mjs"));
    writeFileSync(join(root, "membral.mjs"), FAKE_CLI);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function run(mode: string, env: Record<string, string> = {}) {
    return spawnSync(process.execPath, [join(root, "run.mjs"), mode], {
      input: "{}",
      encoding: "utf8",
      timeout: 20_000,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        CLAUDE_CONFIG_DIR: config,
        CLAUDE_PLUGIN_DATA: data,
        CLAUDE_PLUGIN_OPTION_API_KEY: "test-key",
        ...env,
      },
    });
  }

  const sessionsRuns = () =>
    existsSync(join(data, "sessions-ran.jsonl"))
      ? readFileSync(join(data, "sessions-ran.jsonl"), "utf8").trim().split("\n").length
      : 0;

  async function settle(): Promise<void> {
    // The detached worker holds import.lock while it runs.
    for (let i = 0; i < 100; i++) {
      await new Promise((r) => setTimeout(r, 50));
      if (sessionsRuns() > 0 && !existsSync(join(data, "import.lock"))) return;
    }
  }

  function setupHook(event: string, command: string) {
    writeFileSync(
      join(config, "settings.json"),
      JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: "command", command }] }] } }),
    );
  }

  it("Antigravity modes use MEMBRAL_API_KEY or the CLI's own credentials, and stand down for setup's hooks.json", () => {
    const noKey = { CLAUDE_PLUGIN_OPTION_API_KEY: "" };
    const withEnvKey = run("agy-session-start", { ...noKey, MEMBRAL_API_KEY: "env-key" });
    expect(JSON.parse(withEnvKey.stdout)).toMatchObject({
      argv: ["preamble", "--hook", "--format", "agy"],
      key: "env-key",
    });
    const noEnvKey = run("agy-session-end", noKey);
    expect(JSON.parse(noEnvKey.stdout).argv).toEqual(["session-end-hook", "--source", "agy"]);

    mkdirSync(join(dir, ".gemini", "config"), { recursive: true });
    const cli = process.execPath;
    writeFileSync(
      join(dir, ".gemini", "config", "hooks.json"),
      JSON.stringify({
        membral: { Stop: [{ type: "command", command: `"${cli}" session-end-hook --source agy` }] },
      }),
    );
    expect(run("agy-session-end", noKey).stdout).toBe("");
    // Only the matching event is guarded.
    expect(run("agy-session-start", noKey).stdout).not.toBe("");
  });

  it("runs the preamble with the plugin key, membral.me and a 4 s fetch budget, and imports once", async () => {
    const first = run("session-start");
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      argv: ["preamble", "--hook"],
      key: "test-key",
      url: "https://membral.me",
      timeout: "4000",
    });
    await settle();
    expect(sessionsRuns()).toBe(1);
    expect(existsSync(join(data, "first-import.done"))).toBe(true);

    // Done, and the catch-up ran less than 24 h ago: no second import.
    expect(run("session-start").status).toBe(0);
    await new Promise((r) => setTimeout(r, 400));
    expect(sessionsRuns()).toBe(1);
  });

  it("leaves the first import not done when the CLI fails, and retries only after an hour", async () => {
    run("session-start", { FAKE_SESSIONS_EXIT: "1" });
    await settle();
    expect(sessionsRuns()).toBe(1);
    expect(existsSync(join(data, "first-import.done"))).toBe(false);

    run("session-start");
    await new Promise((r) => setTimeout(r, 400));
    expect(sessionsRuns()).toBe(1);

    writeFileSync(join(data, "last-import.json"), JSON.stringify({ at: new Date(Date.now() - 61 * 60_000) }));
    run("session-start");
    for (let i = 0; i < 100 && !existsSync(join(data, "first-import.done")); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(sessionsRuns()).toBe(2);
    expect(existsSync(join(data, "first-import.done"))).toBe(true);
  });

  it("counts failed first imports and drops to the 24 h cadence after 3", async () => {
    const attempt = join(data, "last-import.json");
    const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();
    for (let n = 1; n <= 3; n++) {
      if (n > 1) {
        const rec = JSON.parse(readFileSync(attempt, "utf8"));
        writeFileSync(attempt, JSON.stringify({ ...rec, at: hoursAgo(2) }));
      }
      run("session-start", { FAKE_SESSIONS_EXIT: "1" });
      for (let i = 0; i < 100 && JSON.parse(readFileSync(attempt, "utf8")).failures !== n; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(JSON.parse(readFileSync(attempt, "utf8")).failures).toBe(n);
    }
    expect(existsSync(join(data, "first-import.done"))).toBe(false);

    // 3 failures: 2 h later is no longer enough, 25 h later is.
    writeFileSync(attempt, JSON.stringify({ at: hoursAgo(2), kind: "first", failures: 3 }));
    run("session-start");
    await new Promise((r) => setTimeout(r, 400));
    expect(sessionsRuns()).toBe(3);
    writeFileSync(attempt, JSON.stringify({ at: hoursAgo(25), kind: "first", failures: 3 }));
    run("session-start");
    for (let i = 0; i < 100 && !existsSync(join(data, "first-import.done")); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(sessionsRuns()).toBe(4);
    expect(existsSync(join(data, "first-import.done"))).toBe(true);
  });

  it("trims import.log to its last 256 KB once it passes 1 MB", async () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "import.log"), `${"x".repeat(1024 * 1024)}TAIL-MARKER\n`);
    run("session-start");
    await settle();
    const log = readFileSync(join(data, "import.log"), "utf8");
    expect(log.length).toBeLessThan(300 * 1024);
    expect(log).toContain("TAIL-MARKER");
  });

  it("runs a catch-up import once the last one is more than 24 h old", async () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "first-import.done"), "{}");
    writeFileSync(join(data, "last-import.json"), JSON.stringify({ at: new Date(Date.now() - 23 * 3600_000) }));
    run("session-start");
    await new Promise((r) => setTimeout(r, 400));
    expect(sessionsRuns()).toBe(0);

    writeFileSync(join(data, "last-import.json"), JSON.stringify({ at: new Date(Date.now() - 25 * 3600_000) }));
    run("session-start");
    await settle();
    expect(sessionsRuns()).toBe(1);
    expect(JSON.parse(readFileSync(join(data, "last-import.json"), "utf8")).kind).toBe("catch-up");
  });

  it("starts no import while a fresh lock is held, but ignores a stale one", async () => {
    mkdirSync(data, { recursive: true });
    writeFileSync(join(data, "import.lock"), "{}");
    run("session-start");
    await new Promise((r) => setTimeout(r, 400));
    expect(sessionsRuns()).toBe(0);

    const old = new Date(Date.now() - 3 * 3600_000);
    utimesSync(join(data, "import.lock"), old, old);
    run("session-start");
    await settle();
    expect(sessionsRuns()).toBe(1);
  });

  it("session-end runs session-end-hook and never starts an import", () => {
    const res = run("session-end", { MEMBRAL_PLUGIN_API_URL: "http://127.0.0.1:9" });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toMatchObject({
      argv: ["session-end-hook"],
      key: "test-key",
      url: "http://127.0.0.1:9",
    });
    expect(existsSync(join(data, "last-import.json"))).toBe(false);
  });

  it("ignores a MEMBRAL_PLUGIN_API_URL that is not a loopback http URL", () => {
    for (const url of ["https://evil.example", "http://127.0.0.1.evil.example", "http://localhost.evil:1"]) {
      const res = run("session-end", { MEMBRAL_PLUGIN_API_URL: url });
      expect(JSON.parse(res.stdout).url).toBe("https://membral.me");
    }
    expect(JSON.parse(run("session-end", { MEMBRAL_PLUGIN_API_URL: "http://localhost:3000" }).stdout).url).toBe(
      "http://localhost:3000",
    );
  });

  it("no-ops for each event whose runnable setup hook is in settings.json", () => {
    setupHook("SessionStart", `"${process.execPath}" "${join(root, "membral.mjs")}" preamble --hook`);
    const start = run("session-start");
    expect(start.status).toBe(0);
    expect(start.stdout).toBe("");
    expect(existsSync(join(data, "last-import.json"))).toBe(false);

    // SessionEnd has no setup hook, so the plugin's still runs.
    expect(JSON.parse(run("session-end").stdout).argv).toEqual(["session-end-hook"]);
  });

  it("runs anyway when the setup hook names an executable or script that no longer exists", () => {
    setupHook("SessionEnd", `"${process.execPath}" "${join(dir, "gone", "index.js")}" session-end-hook`);
    expect(JSON.parse(run("session-end").stdout).argv).toEqual(["session-end-hook"]);
    setupHook("SessionEnd", `"/nonexistent/bin/node" "${join(root, "membral.mjs")}" session-end-hook`);
    expect(JSON.parse(run("session-end").stdout).argv).toEqual(["session-end-hook"]);
    setupHook("SessionEnd", "membral-not-on-path-xyz session-end-hook");
    expect(JSON.parse(run("session-end").stdout).argv).toEqual(["session-end-hook"]);
  });

  it("exits 0 with one stderr line when no key is configured", () => {
    const res = run("session-start", { CLAUDE_PLUGIN_OPTION_API_KEY: "" });
    expect(res.status).toBe(0);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no API key set");
  });
});
