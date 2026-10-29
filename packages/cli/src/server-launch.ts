// Finding, launching and rotating the log of the embedded-store server (`membral up`).
// Everything with a side effect on the machine (spawn, filesystem) is injected so the tests run offline.
import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type EnvMap, LLM_PASSTHROUGH } from "./local-stack.js";

export const LOG_ROTATE_BYTES = 10 * 1024 * 1024;
export const LOG_KEEP = 3;
export const SERVER_RELATIVE = join("apps", "cloud", "server.js");

export interface SpawnedServer {
  pid: number | undefined;
  unref(): void;
  onExit(cb: (code: number | null) => void): void;
}

export interface SpawnOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** Detached: stdout and stderr go to this file (created 600). Foreground: stdio is inherited. */
  logPath?: string;
}

export type SpawnFn = (command: string, args: string[], opts: SpawnOptions) => SpawnedServer;

export const defaultSpawn: SpawnFn = (command, args, opts) => {
  const detached = opts.logPath !== undefined;
  const fd = opts.logPath ? openSync(opts.logPath, "a", 0o600) : undefined;
  const child = nodeSpawn(command, args, {
    env: opts.env,
    cwd: opts.cwd,
    detached,
    stdio: fd === undefined ? "inherit" : ["ignore", fd, fd],
  });
  if (fd !== undefined) closeSync(fd);
  return {
    pid: child.pid,
    unref: () => child.unref(),
    onExit: (cb) => {
      child.once("exit", (code) => cb(code));
      child.once("error", () => cb(null));
    },
  };
};

export interface FindServerArgs {
  flag?: string;
  env: NodeJS.ProcessEnv;
  /** Only resolves a relative --server-dir / MEMBRAL_SERVER_DIR. Never searched for a server or a checkout. */
  cwd: string;
  exists?: (path: string) => boolean;
  /** Resolve a module specifier as seen from a file path or URL; undefined when it does not resolve. Injected in tests. */
  resolveFrom?: (specifier: string, from: string) => string | undefined;
  /** Where the CLI itself lives; defaults to this module's URL. */
  selfUrl?: string;
}

export const SERVER_PACKAGE = "@membral/server";

/** How `up` found the server dir. */
export type ServerVia = "flag" | "env" | "checkout" | "package";

// No `npx @membral/server` hint: the package is not published and its npm scope is unclaimed, so anyone could
// register it. The npx form comes with the publish.
export const SERVER_DIR_HELP =
  "No server build found. Build it with `npm run build:local-server` in a Membral checkout and run the CLI from " +
  "that checkout (packages/cli/dist), or pass --server-dir <dir> / set MEMBRAL_SERVER_DIR to a directory that " +
  "holds apps/cloud/server.js. The `npx` install comes with the package publish.";

const defaultResolveFrom = (specifier: string, from: string): string | undefined => {
  try {
    return createRequire(from).resolve(specifier);
  } catch {
    return undefined;
  }
};

export const selfPathOf = (selfUrl: string): string => (selfUrl.startsWith("file:") ? fileURLToPath(selfUrl) : selfUrl);

/**
 * The directory that holds apps/cloud/server.js, in order: --server-dir, MEMBRAL_SERVER_DIR (both explicit), the
 * standalone build of the checkout the CLI itself runs from, then the @membral/server package installed next to the
 * CLI. The last two are found from the CLI's own module location only, never from cwd, so a global CLI started in
 * an untrusted repo does not execute that repo's server.
 */
export function findServerDir(a: FindServerArgs): { dir: string; via: ServerVia } | { error: string } {
  const exists = a.exists ?? existsSync;
  const has = (d: string) => exists(join(d, SERVER_RELATIVE));
  for (const [label, value, via] of [
    ["--server-dir", a.flag, "flag"],
    ["MEMBRAL_SERVER_DIR", a.env.MEMBRAL_SERVER_DIR, "env"],
  ] as const) {
    if (value) {
      const dir = resolve(a.cwd, value);
      return has(dir) ? { dir, via } : { error: `${label} ${dir} has no ${SERVER_RELATIVE}. ${SERVER_DIR_HELP}` };
    }
  }
  const selfUrl = a.selfUrl ?? import.meta.url;
  const root = findCheckoutRoot(dirname(selfPathOf(selfUrl)), exists);
  if (root) {
    const dir = join(root, "apps", "cloud", ".next", "standalone");
    if (has(dir)) return { dir, via: "checkout" };
  }
  const pkg = (a.resolveFrom ?? defaultResolveFrom)(`${SERVER_PACKAGE}/package.json`, selfUrl);
  if (pkg) {
    const dir = dirname(pkg);
    if (has(dir)) return { dir, via: "package" };
  }
  return { error: SERVER_DIR_HELP };
}

/** The version a server dir declares: its package.json, else membral-server.json. undefined when neither says. */
export function readServerVersion(dir: string): string | undefined {
  for (const f of ["package.json", "membral-server.json"]) {
    try {
      const v = (JSON.parse(readFileSync(join(dir, f), "utf8")) as { version?: unknown }).version;
      if (typeof v === "string" && v) return v;
    } catch {
      // missing or unreadable: try the next file
    }
  }
  return undefined;
}

/** A warning (not a refusal) when the server and the CLI differ; null when equal or either is unknown. */
export function versionMismatchWarning(
  cliVersion: string | undefined,
  serverVersion: string | undefined,
): string | null {
  if (!cliVersion || !serverVersion || cliVersion === serverVersion) return null;
  return `Warning: the server is version ${serverVersion} but this CLI is version ${cliVersion}. They are built to match; continuing anyway.`;
}

/** Nearest ancestor of `from` that looks like this repo's checkout (has apps/cloud). */
export function findCheckoutRoot(from: string, exists: (p: string) => boolean = existsSync): string | null {
  let d = resolve(from);
  for (;;) {
    if (exists(join(d, "apps", "cloud", "package.json"))) return d;
    const up = dirname(d);
    if (up === d) return null;
    d = up;
  }
}

/** Bundled migrations next to the server, else those of the checkout the CLI itself lives in (never the cwd). */
export function findMigrationsDir(
  serverDir: string,
  cliDir: string,
  exists: (p: string) => boolean = existsSync,
): string | undefined {
  const candidates = [
    join(serverDir, "migrations"),
    join(serverDir, "apps", "cloud", "migrations"),
    join(serverDir, "apps", "cloud", "supabase", "migrations"),
  ];
  const root = findCheckoutRoot(cliDir, exists);
  if (root) candidates.push(join(root, "apps", "cloud", "supabase", "migrations"));
  return candidates.find((c) => exists(c));
}

export interface ServerEnvArgs {
  base: NodeJS.ProcessEnv;
  /** Contents of ~/.membral/local/.env. */
  stored: EnvMap;
  port: number;
  pgdata: string;
  migrationsDir?: string;
  claudeOnPath: boolean;
}

export function serverUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** The environment of the server process. Secrets come from .env; nothing here goes on a command line. */
export function buildServerEnv(a: ServerEnvArgs): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...a.base };
  // A hosted-looking shell must not switch local mode off.
  delete env.VERCEL;
  const url = serverUrl(a.port);
  const set = (k: string, v: string | undefined) => {
    if (v !== undefined && v !== "") env[k] = v;
  };
  for (const k of LLM_PASSTHROUGH) set(k, a.stored[k]);
  if (!a.stored.MEMBRAL_LLM_PROVIDER && a.claudeOnPath) env.MEMBRAL_LLM_PROVIDER = "claude-code";
  set("NEXT_PUBLIC_SUPABASE_ANON_KEY", a.stored.ANON_KEY);
  set("SUPABASE_SERVICE_ROLE_KEY", a.stored.SERVICE_ROLE_KEY);
  set("SUPABASE_JWT_SECRET", a.stored.JWT_SECRET);
  set("CRON_SECRET", a.stored.CRON_SECRET);
  env.MEMBRAL_LOCAL = "1";
  env.MEMBRAL_STORE = "pglite";
  env.MEMBRAL_PGDATA = a.pgdata;
  if (a.migrationsDir) env.MEMBRAL_MIGRATIONS_DIR = a.migrationsDir;
  env.PORT = String(a.port);
  env.HOSTNAME = "127.0.0.1";
  env.NEXT_PUBLIC_SUPABASE_URL = url;
  env.NEXT_PUBLIC_APP_URL = url;
  return env;
}

/** Past `maxBytes` the log becomes `.1`, `.1` becomes `.2`, and so on; the oldest of `keep` is dropped. Never throws. */
export function rotateServerLog(path: string, maxBytes = LOG_ROTATE_BYTES, keep = LOG_KEEP): boolean {
  try {
    if (statSync(path).size <= maxBytes) return false;
    rmSync(`${path}.${keep}`, { force: true });
    for (let i = keep - 1; i >= 1; i--) {
      if (existsSync(`${path}.${i}`)) renameSync(`${path}.${i}`, `${path}.${i + 1}`);
    }
    renameSync(path, `${path}.1`);
    return true;
  } catch {
    return false;
  }
}

/** The last `n` lines of a file ("" when it is missing). */
export function tailFile(path: string, n: number): string {
  try {
    const lines = readFileSync(path, "utf8").split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-n).join("\n");
  } catch {
    return "";
  }
}

/** Total bytes under a directory (0 when missing). */
export function dirSize(dir: string): number {
  let total = 0;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      total += e.isDirectory() ? dirSize(p) : statSync(p).size;
    }
  } catch {
    // vanished while counting
  }
  return total;
}

export function readPid(path: string): number | null {
  try {
    const n = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/** Result of the one-shot runtime-env step. */
export interface ExecResult {
  status: number | null;
  output: string;
}
export type ExecFn = (command: string, args: string[], opts: { env: NodeJS.ProcessEnv; cwd: string }) => ExecResult;

export const defaultExec: ExecFn = (command, args, opts) => {
  const r = spawnSync(command, args, { env: opts.env, cwd: opts.cwd, encoding: "utf8" });
  return { status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ? String(r.error) : ""}`.trim() };
};

/** A packaged server dir carries this step; a checkout's raw .next/standalone does not. */
export const SUBSTITUTE_ENV_RELATIVE = "docker/substitute-env.mjs";
