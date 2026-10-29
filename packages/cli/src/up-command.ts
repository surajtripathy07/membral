// `membral up|down|status|logs` — the single-process local server on the embedded store (PGlite).
// No Docker: `up` starts the standalone Next server detached with MEMBRAL_STORE=pglite, waits for its store to be
// ready, then provisions the one local user and runs setup (the same steps `membral local up` runs).
// Files live in ~/.membral/local: .env (secrets, mode 600), pgdata/, logs/server.log, server.pid.
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  statSync,
  unwatchFile,
  watchFile,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { defaultCredentialsPath } from "./credentials.js";
import {
  defaultClaudeOnPath,
  defaultIsPortFree,
  defaultPidAlive,
  type LocalDeps,
  parsePort,
  provisionAndSetup,
  readEnvFile,
} from "./local-command.js";
import {
  DEFAULT_APP_PORT,
  DEFAULT_EMAIL,
  ensureEnv,
  ensurePrivateDir,
  type LocalPaths,
  localPaths,
} from "./local-stack.js";
import { createPrompter } from "./prompt.js";
import {
  buildServerEnv,
  defaultExec,
  defaultSpawn,
  dirSize,
  type ExecFn,
  findMigrationsDir,
  findServerDir,
  readPid,
  readServerVersion,
  rotateServerLog,
  SERVER_RELATIVE,
  type ServerVia,
  type SpawnFn,
  SUBSTITUTE_ENV_RELATIVE,
  selfPathOf,
  serverUrl,
  tailFile,
  unlinkQuiet,
  versionMismatchWarning,
} from "./server-launch.js";

const VIA_LABEL: Record<ServerVia, string> = {
  flag: "from --server-dir",
  env: "from MEMBRAL_SERVER_DIR",
  checkout: "from the checkout this CLI runs from",
  package: "from the @membral/server package next to this CLI",
};

/** This CLI's version from its package.json; undefined in a bundle that has none. */
function readCliVersion(): string | undefined {
  try {
    return createRequire(import.meta.url)("../package.json").version as string;
  } catch {
    return undefined;
  }
}

export const HEALTH_TIMEOUT_MS = 120_000;
export const DOWN_TIMEOUT_MS = 30_000;
const POLL_MS = 1000;
const LOG_TAIL_LINES = 20;

export interface UpCommandDeps extends LocalDeps {
  spawn?: SpawnFn;
  /** Runs the packaged server's substitute-env step before the server starts. */
  exec?: ExecFn;
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  now?: () => number;
  cwd?: string;
  /** Where the CLI lives (module URL); tests only. */
  selfUrl?: string;
  /** The CLI's version; tests only. */
  cliVersion?: string;
  isTTY?: boolean;
  /** `logs -f`: stream appended bytes until interrupted. */
  follow?: (path: string) => Promise<void>;
}

export interface UpCommandOptions {
  port?: string;
  serverDir?: string;
  foreground?: boolean;
  yes?: boolean;
  noSweep?: boolean;
  email?: string;
}

interface Ctx {
  paths: LocalPaths;
  pgdata: string;
  logs: string;
  logFile: string;
  pidFile: string;
  lockFile: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  pidAlive: (pid: number) => boolean;
  env: NodeJS.ProcessEnv;
}

function ctxOf(deps: UpCommandDeps): Ctx {
  const paths = deps.paths ?? localPaths();
  const logs = join(paths.dir, "logs");
  const pgdata = join(paths.dir, "pgdata");
  return {
    paths,
    pgdata,
    logs,
    logFile: join(logs, "server.log"),
    pidFile: join(paths.dir, "server.pid"),
    lockFile: join(pgdata, ".membral.lock"),
    fetchImpl: deps.fetchImpl ?? fetch,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    now: deps.now ?? Date.now,
    pidAlive: deps.pidAlive ?? defaultPidAlive,
    env: deps.env ?? process.env,
  };
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

interface HealthInfo {
  ok: boolean;
  store?: string;
}

async function getHealth(ctx: Ctx, port: number): Promise<HealthInfo> {
  try {
    const res = await ctx.fetchImpl(`${serverUrl(port)}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false };
    let store: string | undefined;
    try {
      const body = (await res.json()) as { store?: unknown };
      if (typeof body.store === "string") store = body.store;
    } catch {
      // a 200 without a JSON body: reachable, store unknown
    }
    return { ok: true, store };
  } catch {
    return { ok: false };
  }
}

/** The pid in server.pid when that process is alive; a stale pid file is removed. */
function livePid(ctx: Ctx): number | null {
  const pid = readPid(ctx.pidFile);
  if (pid === null) return null;
  if (ctx.pidAlive(pid)) return pid;
  unlinkQuiet(ctx.pidFile);
  return null;
}

function storedPort(ctx: Ctx): number {
  const p = Number(readEnvFile(ctx.paths).MEMBRAL_APP_PORT);
  return Number.isInteger(p) && p > 0 ? p : DEFAULT_APP_PORT;
}

async function defaultConfirm(question: string): Promise<boolean> {
  const p = createPrompter();
  try {
    return /^y(es)?$/i.test((await p.ask(question)).trim());
  } finally {
    p.close();
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

// --- up -----------------------------------------------------------------------

export async function upCommand(opts: UpCommandOptions = {}, deps: UpCommandDeps = {}): Promise<void> {
  const ctx = ctxOf(deps);

  const running = livePid(ctx);
  if (running !== null) {
    console.log("Membral is already running.");
    await statusCommand({}, deps);
    return;
  }

  const stored = readEnvFile(ctx.paths);
  const port = parsePort(opts.port ?? stored.MEMBRAL_APP_PORT, DEFAULT_APP_PORT, "--port");
  if (typeof port === "string") return fail(port);
  const isPortFree = deps.isPortFree ?? defaultIsPortFree;

  // The Docker stack (`membral local up`) keeps its compose file in this directory. If its port still answers, it runs.
  if (existsSync(ctx.paths.compose)) {
    const other = storedPort(ctx);
    if (!(await isPortFree(other))) {
      return fail(
        `The Docker stack from \`membral local up\` looks like it is running on port ${other}. Stop it with \`membral local down\` first.`,
      );
    }
  }
  if (!(await isPortFree(port))) {
    return fail(`Port ${port} is in use. Run \`membral up --port <free port>\`.`);
  }

  const cwd = deps.cwd ?? process.cwd();
  const selfUrl = deps.selfUrl ?? import.meta.url;
  const server = findServerDir({ flag: opts.serverDir, env: ctx.env, cwd, selfUrl });
  if ("error" in server) return fail(server.error);
  console.log(`Server dir: ${server.dir} (${VIA_LABEL[server.via]})`);
  const mismatch = versionMismatchWarning(deps.cliVersion ?? readCliVersion(), readServerVersion(server.dir));
  if (mismatch) console.error(mismatch);

  // Files: .env with the same secrets as rung one, pgdata/, logs/
  ensurePrivateDir(ctx.paths.dir);
  const { env: localEnv } = ensureEnv(ctx.paths, { MEMBRAL_APP_PORT: String(port) });
  mkdirSync(ctx.pgdata, { recursive: true, mode: 0o700 });
  mkdirSync(ctx.logs, { recursive: true, mode: 0o700 });

  const serverEnv = buildServerEnv({
    base: ctx.env,
    stored: localEnv,
    port,
    pgdata: ctx.pgdata,
    migrationsDir: findMigrationsDir(server.dir, dirname(selfPathOf(selfUrl))),
    claudeOnPath: (deps.claudeOnPath ?? (() => defaultClaudeOnPath(ctx.env)))(),
  });
  const url = serverUrl(port);
  console.log(`Membral: ${url} (files in ${ctx.paths.dir})`);

  // A packaged server dir bakes the NEXT_PUBLIC values in once; the marker it writes makes a later run with
  // different values (another --port) fail. Simplest handling: surface that error with a hint, keep no extra state.
  if (existsSync(join(server.dir, SUBSTITUTE_ENV_RELATIVE))) {
    const r = (deps.exec ?? defaultExec)(process.execPath, [join(server.dir, SUBSTITUTE_ENV_RELATIVE)], {
      env: { ...serverEnv, MEMBRAL_NEXT_DIR: join(server.dir, "apps", "cloud", ".next") },
      cwd: server.dir,
    });
    if (r.status !== 0) {
      return fail(
        `Preparing the server failed (substitute-env exit ${r.status ?? "none"}):\n${r.output}\n` +
          `If this run uses a different --port than the first one, rebuild or re-copy the server dir ${server.dir}, or run with the original port.`,
      );
    }
  }

  const spawn = deps.spawn ?? defaultSpawn;
  const foreground = opts.foreground === true;
  if (!foreground) rotateServerLog(ctx.logFile);
  let exited: number | null | undefined;
  const child = spawn(process.execPath, [join(server.dir, SERVER_RELATIVE)], {
    env: serverEnv,
    cwd: join(server.dir, "apps", "cloud"),
    ...(foreground ? {} : { logPath: ctx.logFile }),
  });
  child.onExit((code) => {
    exited = code;
  });
  if (child.pid === undefined) return fail("Could not start the server (spawn returned no pid).");
  writeFileSync(ctx.pidFile, `${child.pid}\n`, { mode: 0o600 });
  if (!foreground) child.unref();

  // Wait for the store to be ready.
  const deadline = ctx.now() + HEALTH_TIMEOUT_MS;
  let health = await getHealth(ctx, port);
  while (!(health.ok && health.store === "ready") && exited === undefined && ctx.now() < deadline) {
    await ctx.sleep(POLL_MS);
    health = await getHealth(ctx, port);
  }
  if (!(health.ok && health.store === "ready")) {
    const why =
      exited !== undefined
        ? `The server exited (code ${exited}) before it was ready.`
        : `The server did not report a ready store within ${HEALTH_TIMEOUT_MS / 1000} s${
            health.ok ? ` (store: ${health.store ?? "unknown"})` : ""
          }.`;
    if (exited !== undefined) unlinkQuiet(ctx.pidFile);
    const tail = foreground ? "" : tailFile(ctx.logFile, LOG_TAIL_LINES);
    return fail(
      `${why}${tail ? ` Last ${LOG_TAIL_LINES} log lines:\n${tail}` : ""}${
        exited === undefined && !foreground
          ? "\nIt is still starting; see `membral logs`, or stop it with `membral down`."
          : ""
      }`,
    );
  }
  console.log("  Server: ready");

  const interactive = deps.isTTY ?? Boolean(process.stdin.isTTY);
  const provisioned = await provisionAndSetup(
    {
      url,
      email: opts.email || localEnv.MEMBRAL_LOCAL_EMAIL || DEFAULT_EMAIL,
      serviceRoleKey: localEnv.SERVICE_ROLE_KEY,
      provisionPassword: localEnv.MEMBRAL_LOCAL_PASSWORD ?? "",
      passwordUnknown: false,
      envPaths: ctx.paths,
      credsPath: deps.credentialsPath ?? defaultCredentialsPath(),
      fetchImpl: ctx.fetchImpl,
      // A script or pipe has nobody to answer setup's questions: take the defaults.
      yes: opts.yes === true || !interactive,
      noSweep: opts.noSweep,
      logsHint: "`membral logs`",
    },
    deps,
  );
  if (!provisioned) return;

  if (!foreground) return;
  console.log("Running in the foreground. Ctrl-C stops the server.");
  if (exited === undefined) await new Promise<void>((resolve) => child.onExit(() => resolve()));
  unlinkQuiet(ctx.pidFile);
}

// --- down ---------------------------------------------------------------------

export async function downCommand(
  opts: { wipe?: boolean; yes?: boolean } = {},
  deps: UpCommandDeps = {},
): Promise<void> {
  const ctx = ctxOf(deps);
  const interactive = deps.isTTY ?? Boolean(process.stdin.isTTY);

  // Ask before stopping anything, so a refusal leaves the server running.
  let wipe = false;
  if (opts.wipe) {
    if (opts.yes) wipe = true;
    else if (!interactive) {
      return fail("--wipe deletes the local database and needs a yes: run it in a terminal, or pass --yes.");
    } else {
      wipe = await (deps.confirm ?? defaultConfirm)(
        "Delete the local database (every session and memory in it)? [y/N] ",
      );
      if (!wipe) console.log("Not wiping. Stopping the server and keeping the data.");
    }
  }

  const pid = livePid(ctx);
  if (pid === null) {
    console.log("Membral is not running.");
  } else {
    const kill = deps.kill ?? ((p, s) => process.kill(p, s));
    try {
      kill(pid, "SIGTERM");
    } catch (err) {
      return fail(`Could not signal process ${pid}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const deadline = ctx.now() + DOWN_TIMEOUT_MS;
    while (ctx.pidAlive(pid) && ctx.now() < deadline) {
      await ctx.sleep(250);
    }
    if (ctx.pidAlive(pid)) {
      return fail(
        `The server (pid ${pid}) did not stop within ${DOWN_TIMEOUT_MS / 1000} s. Data is safe to keep; check \`membral logs\`.`,
      );
    }
    unlinkQuiet(ctx.pidFile);
    console.log("Stopped. Data kept; `membral up` resumes.");
  }

  if (wipe) {
    rmSync(ctx.pgdata, { recursive: true, force: true });
    console.log("Wiped the local database.");
  }
}

// --- status -------------------------------------------------------------------

export async function statusCommand(_opts: Record<string, never> = {}, deps: UpCommandDeps = {}): Promise<void> {
  const ctx = ctxOf(deps);
  const pid = livePid(ctx);
  const port = storedPort(ctx);
  console.log(`Membral: ${serverUrl(port)}`);
  console.log(`  Process: ${pid === null ? "not running" : `pid ${pid}`}`);
  let healthy = false;
  if (pid !== null) {
    const h = await getHealth(ctx, port);
    healthy = h.ok && h.store === "ready";
    console.log(`  Health:  ${h.ok ? "ok" : "not answering"} (${serverUrl(port)}/api/health)`);
    console.log(`  Store:   ${h.store ?? "unknown"}`);
  }
  console.log(`  Data:    ${ctx.pgdata} (${formatBytes(dirSize(ctx.pgdata))})`);
  if (pid === null || !healthy) process.exitCode = 1;
}

// --- logs ---------------------------------------------------------------------

const LOG_LINES = 50;

async function defaultFollow(path: string): Promise<void> {
  let pos = existsSync(path) ? statSync(path).size : 0;
  const drain = () => {
    try {
      const size = statSync(path).size;
      if (size < pos) pos = 0;
      if (size === pos) return;
      const fd = openSync(path, "r");
      try {
        const buf = Buffer.alloc(size - pos);
        readSync(fd, buf, 0, buf.length, pos);
        process.stdout.write(buf);
      } finally {
        closeSync(fd);
      }
      pos = size;
    } catch {
      // rotated or missing: try again on the next tick
    }
  };
  watchFile(path, { interval: 500 }, drain);
  await new Promise<void>((resolve) => process.once("SIGINT", resolve));
  unwatchFile(path);
}

export async function logsCommand(opts: { follow?: boolean } = {}, deps: UpCommandDeps = {}): Promise<void> {
  const ctx = ctxOf(deps);
  if (!existsSync(ctx.logFile)) return fail("No server log yet. Run `membral up`.");
  const tail = tailFile(ctx.logFile, LOG_LINES);
  if (tail) console.log(tail);
  if (opts.follow) await (deps.follow ?? defaultFollow)(ctx.logFile);
}

/** True when a `membral up` server's pid file exists (live or stale), so `membral status` can lead with it. */
export function serverPidFileExists(deps: UpCommandDeps = {}): boolean {
  return existsSync(ctxOf(deps).pidFile);
}
