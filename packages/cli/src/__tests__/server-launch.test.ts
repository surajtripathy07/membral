import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildServerEnv,
  dirSize,
  findMigrationsDir,
  findServerDir,
  readServerVersion,
  rotateServerLog,
  SERVER_DIR_HELP,
  SERVER_RELATIVE,
  tailFile,
  versionMismatchWarning,
} from "../server-launch.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "membral-launch-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function touch(path: string, body = "x"): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
}

/** A fake installed CLI at <root>/<name>/node_modules/@membral/cli/dist/index.js, plus its sibling server package. */
function fakeCli(root: string, withServer: boolean): { selfUrl: string; pkgDir: string } {
  const cliDir = join(root, "node_modules", "@membral", "cli", "dist");
  mkdirSync(cliDir, { recursive: true });
  touch(join(cliDir, "index.js"));
  touch(join(cliDir, "..", "package.json"), JSON.stringify({ name: "@membral/cli", version: "1.0.0" }));
  const pkgDir = join(root, "node_modules", "@membral", "server");
  if (withServer) {
    touch(join(pkgDir, SERVER_RELATIVE));
    touch(join(pkgDir, "package.json"), JSON.stringify({ name: "@membral/server", version: "1.0.0", main: "x.js" }));
  }
  return { selfUrl: pathToFileURL(join(cliDir, "index.js")).href, pkgDir };
}

describe("findServerDir", () => {
  it("prefers the flag, then the env var, then the checkout the CLI runs from, and says how it found it", () => {
    const flagDir = join(dir, "flag");
    const envDir = join(dir, "env");
    touch(join(flagDir, SERVER_RELATIVE));
    touch(join(envDir, SERVER_RELATIVE));
    touch(join(dir, "repo", "apps", "cloud", "package.json"));
    touch(join(dir, "repo", "apps", "cloud", ".next", "standalone", SERVER_RELATIVE));
    const selfUrl = pathToFileURL(join(dir, "repo", "packages", "cli", "dist", "index.js")).href;
    const cwd = join(dir, "elsewhere");
    mkdirSync(cwd, { recursive: true });
    const env = { MEMBRAL_SERVER_DIR: envDir };
    expect(findServerDir({ flag: flagDir, env, cwd, selfUrl })).toEqual({ dir: flagDir, via: "flag" });
    expect(findServerDir({ env, cwd, selfUrl })).toEqual({ dir: envDir, via: "env" });
    expect(findServerDir({ env: {}, cwd, selfUrl })).toEqual({
      dir: join(dir, "repo", "apps", "cloud", ".next", "standalone"),
      via: "checkout",
    });
  });

  it("the missing-server help never tells anyone to npx the unpublished @membral/server", () => {
    const r = findServerDir({
      env: {},
      cwd: dir,
      selfUrl: pathToFileURL(join(dir, "x", "index.js")).href,
      resolveFrom: () => undefined,
    });
    expect("error" in r && r.error).toMatch(/--server-dir.*MEMBRAL_SERVER_DIR/s);
    expect("error" in r && r.error).toContain("npm run build:local-server");
    expect("error" in r && r.error).not.toMatch(/npx\s+(-p\s+)?@membral\/server/);
    expect(SERVER_DIR_HELP).not.toContain("npx -p");
    const bad = findServerDir({ flag: join(dir, "nope"), env: {}, cwd: dir });
    expect("error" in bad && bad.error).toMatch(/^--server-dir /);
  });

  it("skips a checkout whose standalone build has no server.js and falls to the installed package", () => {
    touch(join(dir, "repo", "apps", "cloud", "package.json"));
    mkdirSync(join(dir, "repo", "apps", "cloud", ".next", "standalone"), { recursive: true });
    const pkgDir = join(dir, "nm", "@membral", "server");
    touch(join(pkgDir, SERVER_RELATIVE));
    const selfUrl = pathToFileURL(join(dir, "repo", "packages", "cli", "dist", "index.js")).href;
    const resolveFrom = () => join(pkgDir, "package.json");
    expect(findServerDir({ env: {}, cwd: dir, selfUrl, resolveFrom })).toEqual({ dir: pkgDir, via: "package" });
  });

  it("resolves the installed package only from the CLI's own location, and needs a server.js", () => {
    const via = join(dir, "cli-nm", "@membral", "server");
    touch(join(via, SERVER_RELATIVE));
    const calls: string[] = [];
    const resolveFrom = (_s: string, from: string) => {
      calls.push(from);
      return join(via, "package.json");
    };
    const selfUrl = "file:///cli/index.js";
    expect(findServerDir({ env: {}, cwd: dir, resolveFrom, selfUrl })).toEqual({ dir: via, via: "package" });
    expect(calls).toEqual([selfUrl]);
    const none = (_s: string, from: string) => (from === selfUrl ? undefined : join(via, "package.json"));
    expect("error" in findServerDir({ env: {}, cwd: dir, resolveFrom: none, selfUrl })).toBe(true);
    const empty = join(dir, "empty-pkg");
    mkdirSync(empty, { recursive: true });
    const r = findServerDir({ env: {}, cwd: dir, selfUrl, resolveFrom: () => join(empty, "package.json") });
    expect("error" in r).toBe(true);
  });

  it("finds a real node_modules/@membral/server layout next to a fake CLI module (real resolver)", () => {
    const { selfUrl, pkgDir } = fakeCli(join(dir, "install"), true);
    expect(findServerDir({ env: {}, cwd: dir, selfUrl })).toEqual({ dir: realpathSync(pkgDir), via: "package" });
  });

  it("hostile cwd: a cwd with node_modules/@membral/server and a fake checkout is NOT used", () => {
    const { selfUrl } = fakeCli(join(dir, "install"), false);
    const hostile = join(dir, "hostile");
    fakeCli(hostile, true);
    touch(join(hostile, "apps", "cloud", "package.json"));
    touch(join(hostile, "apps", "cloud", ".next", "standalone", SERVER_RELATIVE));
    const r = findServerDir({ env: {}, cwd: hostile, selfUrl });
    expect("error" in r).toBe(true);
  });

  it("flag and env beat an installed package", () => {
    const flagDir = join(dir, "flag");
    touch(join(flagDir, SERVER_RELATIVE));
    const pkgDir = join(dir, "pkg");
    touch(join(pkgDir, SERVER_RELATIVE));
    const resolveFrom = () => join(pkgDir, "package.json");
    expect(findServerDir({ flag: flagDir, env: {}, cwd: dir, resolveFrom })).toEqual({ dir: flagDir, via: "flag" });
    expect(findServerDir({ env: { MEMBRAL_SERVER_DIR: flagDir }, cwd: dir, resolveFrom })).toEqual({
      dir: flagDir,
      via: "env",
    });
  });
});

describe("server version", () => {
  it("reads package.json, then membral-server.json, else undefined", () => {
    const a = join(dir, "a");
    touch(join(a, "package.json"), JSON.stringify({ version: "1.2.3" }));
    expect(readServerVersion(a)).toBe("1.2.3");
    const b = join(dir, "b");
    touch(join(b, "membral-server.json"), JSON.stringify({ version: "4.5.6" }));
    expect(readServerVersion(b)).toBe("4.5.6");
    expect(readServerVersion(join(dir, "none"))).toBeUndefined();
  });

  it("warns naming both versions when they differ, and stays quiet otherwise", () => {
    const w = versionMismatchWarning("0.2.1", "0.3.0");
    expect(w).toContain("0.2.1");
    expect(w).toContain("0.3.0");
    expect(versionMismatchWarning("0.2.1", "0.2.1")).toBeNull();
    expect(versionMismatchWarning(undefined, "0.2.1")).toBeNull();
    expect(versionMismatchWarning("0.2.1", undefined)).toBeNull();
  });
});

describe("findMigrationsDir", () => {
  it("uses the bundled migrations, else the checkout's", () => {
    const server = join(dir, "srv");
    mkdirSync(join(server, "migrations"), { recursive: true });
    expect(findMigrationsDir(server, dir)).toBe(join(server, "migrations"));
    const repo = join(dir, "repo");
    touch(join(repo, "apps", "cloud", "package.json"));
    mkdirSync(join(repo, "apps", "cloud", "supabase", "migrations"), { recursive: true });
    expect(findMigrationsDir(join(dir, "empty"), repo)).toBe(join(repo, "apps", "cloud", "supabase", "migrations"));
    expect(findMigrationsDir(join(dir, "empty"), dir)).toBeUndefined();
  });
});

describe("buildServerEnv", () => {
  const stored = { ANON_KEY: "a", SERVICE_ROLE_KEY: "s", JWT_SECRET: "j", CRON_SECRET: "c", OPENAI_API_KEY: "k" };

  it("sets local pglite mode, secrets and the loopback URL; drops VERCEL", () => {
    const env = buildServerEnv({
      base: { PATH: "/bin", VERCEL: "1" },
      stored,
      port: 3123,
      pgdata: "/d/pgdata",
      migrationsDir: "/m",
      claudeOnPath: true,
    });
    expect(env).toMatchObject({
      MEMBRAL_LOCAL: "1",
      MEMBRAL_STORE: "pglite",
      MEMBRAL_PGDATA: "/d/pgdata",
      MEMBRAL_MIGRATIONS_DIR: "/m",
      PORT: "3123",
      HOSTNAME: "127.0.0.1",
      NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:3123",
      NEXT_PUBLIC_APP_URL: "http://127.0.0.1:3123",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "a",
      SUPABASE_SERVICE_ROLE_KEY: "s",
      SUPABASE_JWT_SECRET: "j",
      OPENAI_API_KEY: "k",
      MEMBRAL_LLM_PROVIDER: "claude-code",
      PATH: "/bin",
    });
    expect(env.VERCEL).toBeUndefined();
  });

  it("leaves the provider alone when claude is absent or one is configured", () => {
    const none = buildServerEnv({ base: {}, stored, port: 1, pgdata: "p", claudeOnPath: false });
    expect(none.MEMBRAL_LLM_PROVIDER).toBeUndefined();
    expect(none.MEMBRAL_MIGRATIONS_DIR).toBeUndefined();
    const set = buildServerEnv({
      base: {},
      stored: { ...stored, MEMBRAL_LLM_PROVIDER: "openai" },
      port: 1,
      pgdata: "p",
      claudeOnPath: true,
    });
    expect(set.MEMBRAL_LLM_PROVIDER).toBe("openai");
  });
});

describe("rotateServerLog", () => {
  it("rotates past the limit and keeps at most 3", () => {
    const log = join(dir, "server.log");
    writeFileSync(log, "1".repeat(20));
    expect(rotateServerLog(log, 10, 3)).toBe(true);
    writeFileSync(log, "2".repeat(20));
    rotateServerLog(log, 10, 3);
    writeFileSync(log, "3".repeat(20));
    rotateServerLog(log, 10, 3);
    writeFileSync(log, "4".repeat(20));
    rotateServerLog(log, 10, 3);
    expect(readdirSync(dir).sort()).toEqual(["server.log.1", "server.log.2", "server.log.3"]);
  });

  it("leaves a small or missing log alone", () => {
    const log = join(dir, "server.log");
    expect(rotateServerLog(log, 10, 3)).toBe(false);
    writeFileSync(log, "tiny");
    expect(rotateServerLog(log, 10, 3)).toBe(false);
  });
});

describe("tailFile and dirSize", () => {
  it("returns the last n lines and the byte total", () => {
    const f = join(dir, "a.log");
    writeFileSync(f, "a\nb\nc\nd\n");
    expect(tailFile(f, 2)).toBe("c\nd");
    expect(tailFile(join(dir, "missing"), 2)).toBe("");
    touch(join(dir, "sub", "x"), "12345");
    expect(dirSize(dir)).toBe(8 + 5);
  });
});
