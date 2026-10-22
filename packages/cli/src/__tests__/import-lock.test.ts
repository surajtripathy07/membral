// ~/.membral/import.lock — every test uses a temp path, never the real ~/.membral.
import { execFile as execFileCb } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireImportLock, IMPORT_LOCK_STALE_MS } from "../import-lock.js";

describe("acquireImportLock", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "membral-lock-"));
    path = join(dir, "import.lock");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes pid + started_at, refuses a second holder, and releases", () => {
    const lock = acquireImportLock({ path });
    expect(lock).not.toBeNull();
    const body = JSON.parse(readFileSync(path, "utf8"));
    expect(body.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(body.started_at))).toBe(false);
    expect(acquireImportLock({ path })).toBeNull();
    lock?.release();
    expect(existsSync(path)).toBe(false);
  });

  it("takes over a lock whose pid is dead", () => {
    writeFileSync(path, JSON.stringify({ pid: 2 ** 22 + 12345, started_at: new Date().toISOString() }));
    const lock = acquireImportLock({ path });
    expect(lock).not.toBeNull();
    expect(JSON.parse(readFileSync(path, "utf8")).pid).toBe(process.pid);
    lock?.release();
  });

  it("takes over a lock older than 15 minutes even when its pid is alive", () => {
    const old = new Date(Date.now() - IMPORT_LOCK_STALE_MS - 1000).toISOString();
    writeFileSync(path, JSON.stringify({ pid: process.pid, started_at: old }));
    expect(acquireImportLock({ path })).not.toBeNull();
  });

  it("takes over a corrupt lock file", () => {
    writeFileSync(path, "not json");
    expect(acquireImportLock({ path })).not.toBeNull();
  });
});

describe("membral sessions with the import lock held (built CLI, temp HOME)", () => {
  const CLI_BIN = resolve(dirname(fileURLToPath(import.meta.url)), "../../dist/index.js");

  it("exits 0 with 'another import is running' and uploads nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "membral-lock-home-"));
    try {
      mkdirSync(join(home, ".membral"), { recursive: true });
      writeFileSync(
        join(home, ".membral", "import.lock"),
        JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }),
      );
      const env = { ...process.env, HOME: home, MEMBRAL_API_URL: "http://127.0.0.1:9" };
      delete env.MEMBRAL_API_KEY;
      const { stdout } = await promisify(execFileCb)(
        process.execPath,
        [CLI_BIN, "sessions", "--source", "claude-code", "--root", home],
        { env, timeout: 10_000 },
      );
      expect(stdout).toContain("another import is running");
      expect(stdout).not.toContain("Scanning");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
