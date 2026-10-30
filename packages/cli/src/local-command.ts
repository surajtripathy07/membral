// `membral local up|down|status|logs` (W7, docs/design/w7-one-command-local.md).
// `up` writes a compose stack under ~/.membral/local (Postgres, PostgREST and the
// membral-cloud image, which also serves sign-in), applies the auth prelude and the
// image's migrations, provisions the one
// local user and an API key through the app, writes the `local` profile,
// makes it active and runs the setup path for hooks/MCP. Every step is
// idempotent: a second `up` changes nothing and mints nothing.
//
// Docker is reached only through the injected DockerRunner (tests use a fake).
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  linkSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { connect, createServer } from "node:net";
import { hostname as osHostname } from "node:os";
import { basename, delimiter, join } from "node:path";
import {
  type ApiKeyValidation,
  defaultCredentialsPath,
  loadProfiles,
  saveProfiles,
  setActiveProfile,
  validateApiKey,
} from "./credentials.js";
import { createDockerRunner, DOCKER_NOT_FOUND, type DockerResult, type DockerRunner } from "./docker-runner.js";
import {
  createBucketState,
  decayBucketState,
  growBucketState,
  parseRetryAfterMs,
  RULE4_BACKOFF,
} from "./lib/backoff.js";
import {
  checkOllama,
  DEFAULT_EMBEDDING_MODEL,
  EMBEDDINGS_BASE_KEY,
  EMBEDDINGS_MODEL_KEY,
  embeddingsLine,
  parseEmbeddingsMode,
  removeEnvKeys,
} from "./local-embeddings.js";
import { prewarmExcerpts, readDockerMemTotal } from "./local-pg-tune.js";
import {
  appUrl,
  DEFAULT_APP_PORT,
  DEFAULT_EMAIL,
  DEFAULT_IMAGE,
  dbVolumeName,
  type EnvMap,
  ensureEnv,
  ensurePrivateDir,
  LLM_PASSTHROUGH,
  type LocalPaths,
  localDirFor,
  localPaths,
  PROJECT_NAME_RE,
  parseEnv,
  projectName,
  renderCompose,
  writeIfChanged,
} from "./local-stack.js";
import { createPrompter } from "./prompt.js";
import { setup } from "./setup.js";
import { SWEEP_LABEL } from "./sweep-command.js";
import { useCommand } from "./use-command.js";

export const LOCAL_PROFILE = "local";
export const PREVIOUS_PROFILE = "local-previous";
/** Marks a profile written by `membral local up`; any other "local" profile is moved aside, never overwritten. */
export const LOCAL_STACK_SOURCE = "local-stack";
export const SERVICES = ["db", "rest", "app"] as const;
export const EXTRACTION_OFF_LINE =
  "Extraction is off: no LLM provider is set. Put an API key in ~/.membral/local/.env, or set MEMBRAL_LLM_PROVIDER=claude-code " +
  '(see "Run it locally" in the README), then run `membral local up` again.';
const WAIT_TIMEOUT_S = "300";

export interface LocalDeps {
  runner?: DockerRunner;
  paths?: LocalPaths;
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  isPortFree?: (port: number) => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  hostname?: () => string;
  env?: NodeJS.ProcessEnv;
  validateKey?: (apiUrl: string, apiKey: string) => Promise<ApiKeyValidation>;
  /** `membral use local` — re-points MCP + hooks when the profile already existed. */
  activate?: (name: string) => Promise<void>;
  /** The `membral setup` path, run after a new key lands in the profile. */
  runSetup?: (opts: { apiUrl: string; yes: boolean; profile: string; noSweep?: boolean }) => Promise<void>;
  /** Is the backstop sweep scheduled? Checked after setup; null when this platform has no check. */
  sweepCheck?: () => Promise<string | null>;
  /** Is `claude` on PATH? Decides the default extractor. */
  claudeOnPath?: () => boolean;
  /** Is this pid alive? (stale-lock detection) */
  pidAlive?: (pid: number) => boolean;
  confirm?: (question: string) => Promise<boolean>;
  /** `local reembed`: wall clock for rate/ETA and the progress throttle. */
  now?: () => number;
  /** `local reembed`: aborted to stop cleanly after the current batch (default: the first Ctrl-C). */
  stopSignal?: AbortSignal;
}

export interface UpOptions {
  port?: string;
  /** Deprecated and ignored: there is no gateway any more (the app serves sign-in and reaches PostgREST itself). */
  gatewayPort?: string;
  image?: string;
  email?: string;
  yes?: boolean;
  /** "ollama": local embeddings through the host's Ollama; "none": remove them. Persists in .env. */
  embeddings?: string;
  /** Ollama model for --embeddings ollama (default nomic-embed-text). */
  embeddingModel?: string;
  /** Passed to setup: don't schedule the backstop sweep (CI, throwaway HOMEs). */
  noSweep?: boolean;
  /** Custom compose project name (also MEMBRAL_LOCAL_PROJECT). */
  project?: string;
}

interface Ctx {
  runner: DockerRunner;
  paths: LocalPaths;
  credsPath: string;
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
}

/** --project, else MEMBRAL_LOCAL_PROJECT; undefined = the default stack. */
function resolveProject(opt: string | undefined, env: NodeJS.ProcessEnv): { project?: string } | { error: string } {
  const name = opt || env.MEMBRAL_LOCAL_PROJECT || undefined;
  if (name !== undefined && !PROJECT_NAME_RE.test(name)) {
    return {
      error: `Invalid project name "${name}" (--project / MEMBRAL_LOCAL_PROJECT): use a-z, 0-9 and "-", up to 31 characters.`,
    };
  }
  return { project: name };
}

function ctxOf(deps: LocalDeps, project?: string): Ctx {
  return {
    runner: deps.runner ?? createDockerRunner(),
    paths: deps.paths ? { ...deps.paths, ...(project ? { project } : {}) } : localPaths(localDirFor(project), project),
    credsPath: deps.credentialsPath ?? defaultCredentialsPath(),
    fetchImpl: deps.fetchImpl ?? fetch,
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

function lastLine(r: DockerResult): string {
  const lines = `${r.stderr}\n${r.stdout}`
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] ?? `exit ${r.code}`;
}

export function composeArgs(paths: LocalPaths, ...args: string[]): string[] {
  return ["compose", "-p", projectName(paths), "-f", paths.compose, "--env-file", paths.env, ...args];
}

/** Oldest Compose that takes the inline `configs:` content the stack file uses. */
export const MIN_COMPOSE_VERSION: readonly [number, number] = [2, 23];

/** "2.29.1", "v2.29.1-desktop.1" -> [2, 29]; undefined when there is no version in the text. */
export function parseComposeVersion(text: string): [number, number] | undefined {
  const m = /v?(\d+)\.(\d+)/.exec(text.trim());
  return m ? [Number(m[1]), Number(m[2])] : undefined;
}

/** The endpoint `docker` will use: DOCKER_HOST, else the active context's (a Colima profile has its own socket). */
async function dockerEndpoint(runner: DockerRunner, env: NodeJS.ProcessEnv): Promise<string | null> {
  if (env.DOCKER_HOST) return `DOCKER_HOST ${env.DOCKER_HOST}`;
  const c = await runner.run(["context", "inspect", "--format", "{{.Name}} {{.Endpoints.docker.Host}}"]);
  const line = c.code === 0 ? c.stdout.trim().split("\n")[0].replace(/\s+/g, " ") : "";
  return line ? `context ${line}` : null;
}

/**
 * One-line failure when docker / compose / the daemon is missing, the socket
 * refuses this user (Linux without the docker group), or Compose is older
 * than MIN_COMPOSE_VERSION; null when all answer.
 */
export async function dockerPreflight(
  runner: DockerRunner,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  const v = await runner.run(["version", "--format", "{{.Server.Version}}"]);
  if (v.code === DOCKER_NOT_FOUND) {
    return "Docker is not installed (no `docker` on PATH). Install Docker, then run this again.";
  }
  if (v.code !== 0 && /permission denied/i.test(`${v.stderr}\n${v.stdout}`)) {
    return (
      "Docker refused this user (permission denied on the Docker socket). Add yourself to the docker group:\n" +
      "  sudo usermod -aG docker $USER\n" +
      "then log out and back in (or run `newgrp docker`), and run this again."
    );
  }
  if (v.code !== 0) {
    const tried = await dockerEndpoint(runner, env);
    return (
      `Docker is installed but its daemon is not running${tried ? ` (tried ${tried})` : ""}. ` +
      "Start Docker, or point DOCKER_HOST at the right socket (`docker context ls` lists them), then run this again."
    );
  }
  const c = await runner.run(["compose", "version", "--short"]);
  if (c.code !== 0) return "`docker compose` is missing. Install the Docker Compose v2 plugin, then run this again.";
  const have = parseComposeVersion(c.stdout);
  const [minMajor, minMinor] = MIN_COMPOSE_VERSION;
  if (have && (have[0] < minMajor || (have[0] === minMajor && have[1] < minMinor))) {
    return (
      `Docker Compose ${c.stdout.trim()} is too old; Membral needs ${minMajor}.${minMinor} or newer. ` +
      "On Ubuntu, install Docker's apt repository and run `sudo apt-get install docker-compose-plugin` " +
      "(Ubuntu's own docker-compose-v2 package can lag); Docker Desktop: update it. Then run this again."
    );
  }
  return null;
}

export interface PsEntry {
  Service: string;
  State: string;
  Health?: string;
  Publishers?: { PublishedPort?: number }[];
}

/** `docker compose ps --format json` prints a JSON array on older Compose and one object per line on newer. */
export function parsePs(stdout: string): PsEntry[] {
  const text = stdout.trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const out: PsEntry[] = [];
    for (const line of text.split("\n")) {
      try {
        out.push(JSON.parse(line));
      } catch {
        // skip a non-JSON line
      }
    }
    return out;
  }
}

async function composePs(ctx: Ctx): Promise<PsEntry[]> {
  if (!existsSync(ctx.paths.compose) || !existsSync(ctx.paths.env)) return [];
  const r = await ctx.runner.run(composeArgs(ctx.paths, "ps", "--all", "--format", "json"));
  return r.code === 0 ? parsePs(r.stdout) : [];
}

/** One TCP connect attempt: true only when something accepted the connection. */
export type ConnectProbe = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

const connectProbe: ConnectProbe = (host, port, timeoutMs) =>
  new Promise<boolean>((resolve) => {
    const sock = connect({ host, port });
    const done = (served: boolean) => {
      sock.destroy();
      resolve(served);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.once("connect", () => done(true));
    // ECONNREFUSED / EADDRNOTAVAIL / EAFNOSUPPORT / ENETUNREACH: nothing serves on that address.
    sock.once("error", () => done(false));
  });

/** Binds 127.0.0.1:port and releases it: false when the bind fails (held, or EACCES). */
const bindProbe = (port: number): Promise<boolean> =>
  new Promise<boolean>((resolve) => {
    const srv = createServer();
    srv.once("error", () => resolve(false));
    srv.listen(port, "127.0.0.1", () => srv.close(() => resolve(true)));
  });

export interface PortProbes {
  connect?: ConnectProbe;
  bind?: (port: number) => Promise<boolean>;
  timeoutMs?: number;
}

/**
 * Free when nothing answers a TCP connect on 127.0.0.1 or ::1, and
 * 127.0.0.1 can still be bound. A bind probe alone missed a `next start` on
 * `*:3000` (IPv6 wildcard) or ::1: macOS lets a specific-address bind sit
 * beside a wildcard one, so Docker's 127.0.0.1 publish still succeeded and
 * every `localhost` request from Node (::1 first) reached the old server,
 * which 401ed the new key. Connecting finds any listener that would answer,
 * whatever it bound; the bind probe stays because it is one cheap syscall and
 * catches a port that is held on 127.0.0.1 without accepting yet (or that
 * this user may not bind). A host without IPv6 fails the ::1 connect, which
 * counts as free there.
 */
export async function defaultIsPortFree(port: number, probes: PortProbes = {}): Promise<boolean> {
  const tryConnect = probes.connect ?? connectProbe;
  const timeoutMs = probes.timeoutMs ?? 500;
  const [v4, v6] = await Promise.all([tryConnect("127.0.0.1", port, timeoutMs), tryConnect("::1", port, timeoutMs)]);
  if (v4 || v6) return false;
  return (probes.bind ?? bindProbe)(port);
}

export function parsePort(value: string | undefined, fallback: number, flag: string): number | string {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535)
    return `Invalid ${flag} "${value}" — pass a port from 1024 to 65535.`;
  return n;
}

export function readEnvFile(paths: LocalPaths): EnvMap {
  return existsSync(paths.env) ? parseEnv(readFileSync(paths.env, "utf8")) : {};
}

// --- psql inside the db container ---------------------------------------------

const PSQL_SCRIPT =
  'PGPASSWORD="$POSTGRES_PASSWORD" exec psql -h localhost -U postgres -d postgres -v ON_ERROR_STOP=1 -q -At "$@"';

function psql(ctx: Ctx, args: string[], input?: string, user = "postgres"): Promise<DockerResult> {
  const script = user === "postgres" ? PSQL_SCRIPT : PSQL_SCRIPT.replace("-U postgres", `-U ${user}`);
  return ctx.runner.run(composeArgs(ctx.paths, "exec", "-T", "db", "sh", "-c", script, "psql", ...args), {
    input,
  });
}

const MIGRATIONS_TABLE_SQL =
  "create schema if not exists supabase_migrations; " +
  "create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);";

function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export function migrationVersion(file: string): { version: string; name: string } {
  const base = file.replace(/\.sql$/, "");
  const idx = base.indexOf("_");
  return idx === -1 ? { version: base, name: "" } : { version: base.slice(0, idx), name: base.slice(idx + 1) };
}

export function migrationSql(file: string, body: string): string {
  const { version, name } = migrationVersion(file);
  return (
    "begin;\n" +
    `${body}\n;\n` +
    "insert into supabase_migrations.schema_migrations (version, name, statements) " +
    `values (${sqlString(version)}, ${sqlString(name)}, '{}');\n` +
    "commit;\n"
  );
}

async function applyMigrations(ctx: Ctx): Promise<{ applied: number; skipped: number } | string> {
  const files = existsSync(ctx.paths.migrations)
    ? readdirSync(ctx.paths.migrations)
        .filter((f) => f.endsWith(".sql"))
        .sort()
    : [];
  if (files.length === 0) return "The image carried no migrations at /app/migrations.";
  const t = await psql(ctx, ["-c", MIGRATIONS_TABLE_SQL]);
  if (t.code !== 0) return `Could not create the migrations table: ${lastLine(t)}`;
  const list = await psql(ctx, ["-c", "select version from supabase_migrations.schema_migrations"]);
  if (list.code !== 0) return `Could not read applied migrations: ${lastLine(list)}`;
  const done = new Set(
    list.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean),
  );
  let applied = 0;
  let skipped = 0;
  for (const file of files) {
    if (done.has(migrationVersion(file).version)) {
      skipped++;
      continue;
    }
    const body = readFileSync(`${ctx.paths.migrations}/${file}`, "utf8");
    const r = await psql(ctx, ["-f", "-"], migrationSql(file, body));
    if (r.code !== 0) return `Migration ${file} failed: ${lastLine(r)}`;
    applied++;
  }
  return { applied, skipped };
}

// --- health -------------------------------------------------------------------

export interface HealthLlm {
  configured?: boolean;
  provider?: string | null;
  model?: string | null;
  extraction?: "on" | "off";
  /** Why extraction is off, when the app knows (e.g. Claude Code could not be downloaded). */
  reason?: string;
  embeddings?: { configured?: boolean; model?: string | null };
}

async function getHealth(ctx: Ctx, url: string): Promise<{ ok: boolean; llm?: HealthLlm }> {
  try {
    const res = await ctx.fetchImpl(`${url}/api/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return { ok: false };
    let llm: HealthLlm | undefined;
    try {
      const body = (await res.json()) as { llm?: HealthLlm };
      llm = body?.llm;
    } catch {
      // health is ok even if the body is not JSON
    }
    return { ok: true, llm };
  } catch {
    return { ok: false };
  }
}

/** macOS only (launchd refuses a non-GUI session); returns why the agent is not loaded, else null. */
function defaultSweepCheck(): Promise<string | null> {
  if (process.platform !== "darwin") return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile("launchctl", ["print", `gui/${process.getuid?.() ?? 0}/${SWEEP_LABEL}`], (err, _out, stderr) => {
      resolve(
        err
          ? `launchctl: ${
              String(stderr || err.message)
                .trim()
                .split("\n")[0]
            }`
          : null,
      );
    });
  });
}

function extractionLine(llm: HealthLlm | undefined): string | null {
  if (!llm) return null;
  if (llm.extraction === "off") {
    // The app's reason, when it gives one (sanitised: one line, bounded), replaces the generic advice.
    const reason = typeof llm.reason === "string" ? llm.reason.replace(/\s+/g, " ").trim().slice(0, 300) : "";
    return reason ? `Extraction is off: ${reason}` : EXTRACTION_OFF_LINE;
  }
  const what = [llm.provider, llm.model].filter(Boolean).join(" ");
  return `Extraction: on${what ? ` (${what})` : ""}`;
}

// Registry/name[:tag][@digest]; no leading "-", whitespace or quotes (it lands in argv and YAML).
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/:@]*$/i;
const EMAIL_RE = /^[^\s@"'`\\]+@[^\s@"'`\\]+\.[^\s@"'`\\]+$/;

export function validImage(ref: string): boolean {
  return IMAGE_RE.test(ref) && ref.length <= 255;
}

export function validEmail(email: string): boolean {
  return EMAIL_RE.test(email) && email.length <= 254;
}

/** True when an executable named `claude` is in a PATH directory. */
export function defaultClaudeOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
  const exts = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      try {
        accessSync(join(dir, `claude${ext}`), constants.X_OK);
        return true;
      } catch {
        // not here
      }
    }
  }
  return false;
}

/**
 * Providers that make `claude-code` the wrong default: any key, a base URL, or an explicit provider
 * in .env. Computed on every `up` and never written to .env, so adding a key later switches cleanly.
 */
const EXPLICIT_LLM_KEYS = [
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "MEMBRAL_MODEL_BASE_URL",
  "MEMBRAL_LLM_PROVIDER",
] as const;

export function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock file with no readable pid is held, not stale, until it is this old (its writer may be mid-write). */
const EMPTY_LOCK_STALE_MS = 60_000;

/** The lock's pid (null when empty/unparseable) and mtime, or null when the file is gone. */
function readUpLock(path: string): { pid: number | null; mtimeMs: number } | null {
  try {
    const mtimeMs = statSync(path).mtimeMs;
    const n = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return { pid: Number.isInteger(n) && n > 0 ? n : null, mtimeMs };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function unlinkQuiet(path: string): void {
  try {
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Exclusive lock for `up`. The pid is written to a unique temp file in the same
 * dir and hard-linked to up.lock: link is atomic and fails with EEXIST when the
 * lock is held, so a reader never sees a half-written lock. A lock whose pid is
 * dead (or an empty one older than 60 s) is taken over with rename after
 * re-reading it and confirming it is unchanged. Residual race, accepted: two
 * takers can both pass that re-read and the later rename wins; the window is
 * microseconds and needs a crashed holder plus two simultaneous `up` runs.
 */
export function acquireUpLock(dir: string, pidAlive: (pid: number) => boolean): (() => void) | string {
  const path = `${dir}/up.lock`;
  const temp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, String(process.pid), { mode: 0o600, flag: "wx" });
  const release = () => {
    try {
      if (readUpLock(path)?.pid === process.pid) unlinkQuiet(path);
    } catch {
      // best effort
    }
  };
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(temp, path);
        return release;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const cur = readUpLock(path);
      if (!cur) continue; // released between link and read: try again
      if (cur.pid === null) {
        if (Date.now() - cur.mtimeMs <= EMPTY_LOCK_STALE_MS) {
          return `Another \`membral local up\` is starting (${path} is empty). Wait a minute, or delete it if it is not.`;
        }
      } else if (cur.pid !== process.pid && pidAlive(cur.pid)) {
        return `Another \`membral local up\` is running (pid ${cur.pid}). Wait for it, or delete ${path} if it is not.`;
      }
      const again = readUpLock(path);
      if (!again || again.pid !== cur.pid) continue; // changed under us: re-evaluate
      try {
        renameSync(temp, path);
        return release;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
    return `Could not take ${path}.`;
  } finally {
    unlinkQuiet(temp);
  }
}

function freePreviousName(profiles: Record<string, unknown>): string {
  if (!profiles[PREVIOUS_PROFILE]) return PREVIOUS_PROFILE;
  for (let i = 2; ; i++) if (!profiles[`${PREVIOUS_PROFILE}-${i}`]) return `${PREVIOUS_PROFILE}-${i}`;
}

// --- up -----------------------------------------------------------------------

interface ProvisionResponse {
  userId: string;
  email: string;
  created: boolean;
  apiKey: string | null;
}

export interface ProvisionSetupArgs {
  /** The server's base URL. */
  url: string;
  email: string;
  serviceRoleKey: string | undefined;
  provisionPassword: string;
  /** The user may already exist with a password we cannot know. */
  passwordUnknown: boolean;
  /** Where `.env` lives (the password is written back when the user turns out to be new). */
  envPaths: LocalPaths;
  credsPath: string;
  fetchImpl: typeof fetch;
  yes?: boolean;
  noSweep?: boolean;
  /** How the error messages tell the user to read the server's log. */
  logsHint: string;
}

/**
 * Steps shared by `membral local up` (Docker) and `membral up` (embedded store): provision the one local user and,
 * when needed, an API key; save and activate the "local" profile; run setup; check the sweep agent.
 * Reports its own failures and returns false; true when the server is provisioned and wired.
 */
export async function provisionAndSetup(a: ProvisionSetupArgs, deps: LocalDeps = {}): Promise<boolean> {
  const { url, email, provisionPassword, passwordUnknown } = a;
  // 6. provision the one local user (+ a key only when we lack a working one)
  const state = loadProfiles(a.credsPath);
  const existing = state?.profiles[LOCAL_PROFILE];
  const ownsLocal = existing?.source === LOCAL_STACK_SOURCE && existing.apiUrl.replace(/\/+$/, "") === url;
  let mintKey = true;
  if (ownsLocal && existing.apiKey) {
    const v = await (deps.validateKey ?? ((u, k) => validateApiKey(u, k, a.fetchImpl)))(url, existing.apiKey);
    mintKey = v.status === "invalid";
  }
  const provision = async (mint: boolean): Promise<ProvisionResponse | string> => {
    try {
      const res = await a.fetchImpl(`${url}/api/internal/local/provision`, {
        method: "POST",
        headers: { Authorization: `Bearer ${a.serviceRoleKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: a.email,
          password: provisionPassword,
          deviceName: `local-${(deps.hostname ?? osHostname)()}`,
          mintKey: mint,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return `Provisioning the local user failed (HTTP ${res.status}). See ${a.logsHint}.`;
      return (await res.json()) as ProvisionResponse;
    } catch (err) {
      return `Provisioning the local user failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
  let prov = await provision(mintKey);
  if (typeof prov === "string") {
    fail(prov);
    return false;
  }
  // A valid key for a different user (e.g. --email changed) is the wrong key.
  if (!mintKey && existing?.userId && prov.userId !== existing.userId) {
    mintKey = true;
    const again = await provision(true);
    if (typeof again === "string") {
      fail(again);
      return false;
    }
    prov = { ...again, created: prov.created || again.created };
  }
  if (mintKey && !prov.apiKey) {
    fail(`Provisioning returned no API key. See ${a.logsHint}.`);
    return false;
  }

  console.log(`  User: ${prov.email}${prov.created ? " (created)" : ""}`);
  if (prov.created && passwordUnknown) {
    // The user did not exist after all, so the password we just set is the real one: keep it.
    ensureEnv(a.envPaths, { MEMBRAL_LOCAL_PASSWORD: provisionPassword });
  }
  if (prov.created) {
    console.log(`  Password: ${provisionPassword}  (shown once; \`membral local status --show-password\`)`);
  }

  // 7. profile → active → hooks/MCP
  if (prov.apiKey) {
    const s = loadProfiles(a.credsPath) ?? { activeProfile: LOCAL_PROFILE, profiles: {} };
    const old = s.profiles[LOCAL_PROFILE];
    if (old && (old.source !== LOCAL_STACK_SOURCE || old.apiUrl.replace(/\/+$/, "") !== url)) {
      const aside = freePreviousName(s.profiles);
      s.profiles[aside] = old;
      if (s.activeProfile === LOCAL_PROFILE) s.activeProfile = aside;
      console.log(`  Kept your existing "local" profile (${old.apiUrl}) as "${aside}".`);
    }
    s.profiles[LOCAL_PROFILE] = {
      apiUrl: url,
      apiKey: prov.apiKey,
      email: prov.email,
      userId: prov.userId,
      createdAt: new Date().toISOString(),
      source: LOCAL_STACK_SOURCE,
    };
    saveProfiles(s, a.credsPath);
    setActiveProfile(LOCAL_PROFILE, a.credsPath);
    console.log(`  Profile: "local" saved and active`);
    console.log("");
    const runSetup =
      deps.runSetup ?? ((o: { apiUrl: string; yes: boolean; profile: string; noSweep?: boolean }) => setup(o));
    await runSetup({
      apiUrl: url,
      yes: a.yes ?? false,
      profile: LOCAL_PROFILE,
      ...(a.noSweep ? { noSweep: true } : {}),
    });
  } else if (loadProfiles(a.credsPath)?.activeProfile !== LOCAL_PROFILE) {
    const activate = deps.activate ?? ((name: string) => useCommand(name, { credentialsPath: a.credsPath }));
    await activate(LOCAL_PROFILE);
  } else {
    console.log(`  Profile: "local" is active`);
  }

  if (prov.apiKey && !a.noSweep) {
    const problem = await (deps.sweepCheck ?? defaultSweepCheck)();
    if (problem) {
      console.error(
        `Sweep agent not installed (${problem}): uploads will not be swept. Run \`membral setup\` again from a login shell, or pass --no-sweep to skip it.`,
      );
      process.exitCode = 1;
    }
  }
  return true;
}

export async function localUp(opts: UpOptions = {}, deps: LocalDeps = {}): Promise<void> {
  const proj = resolveProject(opts.project, deps.env ?? process.env);
  if ("error" in proj) return fail(proj.error);
  const ctx = ctxOf(deps, proj.project);
  const pre = await dockerPreflight(ctx.runner, deps.env);
  if (pre) return fail(pre);
  ensurePrivateDir(ctx.paths.dir);
  const lock = acquireUpLock(ctx.paths.dir, deps.pidAlive ?? defaultPidAlive);
  if (typeof lock === "string") return fail(lock);
  try {
    await localUpLocked(ctx, opts, deps);
  } finally {
    lock();
  }
}

async function localUpLocked(ctx: Ctx, opts: UpOptions, deps: LocalDeps): Promise<void> {
  const env = deps.env ?? process.env;

  const stored = readEnvFile(ctx.paths);
  const port = parsePort(opts.port ?? stored.MEMBRAL_APP_PORT, DEFAULT_APP_PORT, "--port");
  if (typeof port === "string") return fail(port);
  if (opts.gatewayPort !== undefined) {
    console.log("  Note: --gateway-port is ignored; the stack has no gateway now (one port: --port).");
  }
  const image = opts.image || env.MEMBRAL_IMAGE || stored.MEMBRAL_IMAGE || DEFAULT_IMAGE;
  const explicitImage = Boolean(opts.image || env.MEMBRAL_IMAGE);
  if (!validImage(image)) return fail(`Invalid image reference "${image}" (--image / MEMBRAL_IMAGE).`);
  const email = opts.email || stored.MEMBRAL_LOCAL_EMAIL || DEFAULT_EMAIL;
  if (!validEmail(email)) return fail(`Invalid email "${email}" (--email).`);

  // Embeddings first: a missing Ollama or model should fail before anything starts.
  const mode = parseEmbeddingsMode(opts.embeddings);
  if (mode !== undefined && mode !== "ollama" && mode !== "none") return fail(mode);
  if (opts.embeddingModel !== undefined && mode !== "ollama") {
    return fail("--embedding-model only applies with --embeddings ollama.");
  }
  const embeddingSettings: EnvMap = {};
  if (mode === "ollama") {
    const model = opts.embeddingModel?.trim() || DEFAULT_EMBEDDING_MODEL;
    if (!/^[A-Za-z0-9][A-Za-z0-9._\-/:]*$/.test(model)) return fail(`Invalid --embedding-model "${model}".`);
    const check = await checkOllama(model, ctx.fetchImpl, env.OLLAMA_HOST);
    if (!check.ok) return fail(check.message);
    embeddingSettings[EMBEDDINGS_BASE_KEY] = check.baseUrl;
    embeddingSettings[EMBEDDINGS_MODEL_KEY] = model;
  }

  // A port held by our own running stack is not "busy".
  const ours = new Set<number>();
  for (const e of await composePs(ctx)) {
    for (const p of e.Publishers ?? []) if (p.PublishedPort) ours.add(p.PublishedPort);
  }
  const isPortFree = deps.isPortFree ?? defaultIsPortFree;
  if (!ours.has(port) && !(await isPortFree(port))) {
    return fail(`Port ${port} is in use. Run \`membral local up --port <free port>\`.`);
  }

  // Secrets are generated once. If the database outlived them, new ones would lock us out of it.
  let passwordUnknown = false;
  if (!stored.POSTGRES_PASSWORD || !stored.JWT_SECRET || !stored.MEMBRAL_LOCAL_PASSWORD) {
    const vol = await ctx.runner.run(["volume", "inspect", dbVolumeName(ctx.paths.project)]);
    if (vol.code === 0) {
      if (!stored.POSTGRES_PASSWORD || !stored.JWT_SECRET) {
        return fail(
          `The database volume ${dbVolumeName(ctx.paths.project)} exists but ${ctx.paths.env} is missing its secrets. ` +
            `Restore that .env, or delete the data with \`docker volume rm ${dbVolumeName(ctx.paths.project)}\` and run this again.`,
        );
      }
      // Only the sign-in password is lost: the user already exists with a password we cannot know.
      // Never invent a new one that would not match; leave it absent (see `status --show-password`).
      passwordUnknown = true;
    }
  }

  // 1. files. An upgrade rewrites .env and the compose file before the image is known to carry the prelude, so the
  // old shapes are kept as .bak (once; removed when the image check below passes) for a failed `up` to roll back to.
  const backups = [ctx.paths.env, ctx.paths.compose].map((f) => `${f}.bak`);
  [ctx.paths.env, ctx.paths.compose].forEach((f, i) => {
    const bak = backups[i] as string;
    if (existsSync(f) && !existsSync(bak)) {
      copyFileSync(f, bak);
      chmodSync(bak, 0o600);
    }
  });
  const { env: localEnv } = ensureEnv(
    ctx.paths,
    {
      MEMBRAL_APP_PORT: String(port),
      MEMBRAL_IMAGE: image,
      MEMBRAL_LOCAL_EMAIL: email,
      ...embeddingSettings,
    },
    undefined,
    { keepPasswordAbsent: passwordUnknown },
  );
  if (mode === "none" && removeEnvKeys(ctx.paths, [EMBEDDINGS_BASE_KEY, EMBEDDINGS_MODEL_KEY])) {
    delete localEnv[EMBEDDINGS_BASE_KEY];
    delete localEnv[EMBEDDINGS_MODEL_KEY];
  }
  // Provisioning needs some password even for an existing user (it is ignored then).
  const provisionPassword = localEnv.MEMBRAL_LOCAL_PASSWORD ?? randomBytes(18).toString("base64url");
  const llmKeys = LLM_PASSTHROUGH.filter((k) => (localEnv[k] ?? "") !== "");
  // claude-code is the default extractor when `claude` is on PATH and nothing else is configured.
  const defaultClaudeCode =
    !EXPLICIT_LLM_KEYS.some((k) => (localEnv[k] ?? "") !== "") && (deps.claudeOnPath ?? defaultClaudeOnPath)();
  const dockerMemBytes = await readDockerMemTotal(ctx.runner);
  writeIfChanged(
    ctx.paths.compose,
    renderCompose({ appPort: port, image, llmKeys, project: ctx.paths.project, defaultClaudeCode, dockerMemBytes }),
  );
  const url = appUrl(port);
  console.log(`Membral local: ${url} (files in ${ctx.paths.dir})`);
  if (defaultClaudeCode)
    console.log("  Extractor: claude-code (found `claude` on PATH; needs CLAUDE_CODE_OAUTH_TOKEN in .env)");

  const failKept = (message: string): void =>
    fail(
      backups.some((f) => existsSync(f))
        ? `${message} The previous .env and compose file are kept as ${backups.map((f) => basename(f)).join(" and ")}.`
        : message,
    );

  // 2. image + fresh migrations
  const pull = await ctx.runner.run(["pull", image]);
  if (pull.code !== 0) {
    const have = await ctx.runner.run(["image", "inspect", image]);
    if (have.code !== 0) {
      if (/no matching manifest/i.test(`${pull.stderr}\n${pull.stdout}`)) {
        console.error(
          `${image} has no build for this platform. Build it here with \`docker build -f apps/cloud/Dockerfile -t membral-cloud:dev .\` from a clone, then run \`membral local up --image membral-cloud:dev\`.`,
        );
      }
      return failKept(`Could not pull ${image}: ${lastLine(pull)}`);
    }
    console.log(
      `  Image: ${image} (${explicitImage ? "local image, not pulled" : "pull failed, using the local copy"})`,
    );
  } else {
    console.log(`  Image: ${image}`);
  }
  const created = await ctx.runner.run(["create", image]);
  if (created.code !== 0) return failKept(`Could not read migrations from ${image}: ${lastLine(created)}`);
  const cid = created.stdout.trim();
  try {
    rmSync(ctx.paths.migrations, { recursive: true, force: true });
    const cp = await ctx.runner.run(["cp", `${cid}:/app/migrations`, ctx.paths.migrations]);
    if (cp.code !== 0) return failKept(`Could not copy migrations out of ${image}: ${lastLine(cp)}`);
    const pre = await ctx.runner.run(["cp", `${cid}:/app/local/auth-prelude.sql`, ctx.paths.prelude]);
    if (pre.code !== 0) {
      return failKept(
        `${image} carries no auth prelude (/app/local/auth-prelude.sql): ${lastLine(pre)}. Use an image built from this version.`,
      );
    }
  } finally {
    await ctx.runner.run(["rm", "-f", cid]);
  }
  for (const bak of backups) rmSync(bak, { force: true });

  // 3. db. --remove-orphans retires the auth, gateway and kicker containers of a stack made by an
  // older version (the database volume is untouched); on a fresh install it removes nothing.
  const base = await ctx.runner.run(
    composeArgs(ctx.paths, "up", "-d", "--wait", "--wait-timeout", WAIT_TIMEOUT_S, "--remove-orphans", "db"),
  );
  if (base.code !== 0) {
    return fail(
      `The database did not become healthy (${lastLine(base)}). See \`membral local logs db\`; also check free disk space.`,
    );
  }

  // 4. the auth prelude (the `auth` schema GoTrue used to migrate), then the app migrations
  // As supabase_admin: the image's `postgres` role cannot create objects in the image-owned `auth` schema.
  const prel = await psql(ctx, ["-f", "-"], readFileSync(ctx.paths.prelude, "utf8"), "supabase_admin");
  if (prel.code !== 0) return fail(`The auth prelude failed: ${lastLine(prel)}`);
  const mig = await applyMigrations(ctx);
  if (typeof mig === "string") return fail(mig);
  console.log(
    mig.applied > 0
      ? `  Migrations: ${mig.applied} applied, ${mig.skipped} already applied`
      : `  Migrations: up to date (${mig.skipped})`,
  );
  await psql(ctx, ["-c", "NOTIFY pgrst, 'reload schema'"]);

  // 5. the rest
  const rest = await ctx.runner.run(
    composeArgs(ctx.paths, "up", "-d", "--wait", "--wait-timeout", WAIT_TIMEOUT_S, "--remove-orphans", "rest", "app"),
  );
  if (rest.code !== 0) {
    return fail(`The app did not become healthy (${lastLine(rest)}). See \`membral local logs app\`.`);
  }
  let health = await getHealth(ctx, url);
  for (let i = 0; !health.ok && i < 30; i++) {
    await ctx.sleep(2000);
    health = await getHealth(ctx, url);
  }
  if (!health.ok) return fail(`${url}/api/health is not answering 200. See \`membral local logs app\`.`);
  console.log("  Stack: healthy");
  // Warm the excerpts table in the background so the first scoped search is not cold; never fails `up`.
  const prewarmWarning = await prewarmExcerpts(ctx.runner, (...a) => composeArgs(ctx.paths, ...a));
  if (prewarmWarning) console.log(prewarmWarning);

  const provisioned = await provisionAndSetup(
    {
      url,
      email,
      serviceRoleKey: localEnv.SERVICE_ROLE_KEY,
      provisionPassword,
      passwordUnknown,
      envPaths: ctx.paths,
      credsPath: ctx.credsPath,
      fetchImpl: ctx.fetchImpl,
      yes: opts.yes,
      noSweep: opts.noSweep,
      logsHint: "`membral local logs app`",
    },
    deps,
  );
  if (!provisioned) return;

  console.log(`  ${embeddingsLine(localEnv)}`);
  const line = extractionLine(health.llm);
  if (line?.startsWith("Extraction is off")) console.log(line);
}

// --- status -------------------------------------------------------------------

export async function localStatus(
  opts: { showPassword?: boolean; project?: string } = {},
  deps: LocalDeps = {},
): Promise<void> {
  const proj = resolveProject(opts.project, deps.env ?? process.env);
  if ("error" in proj) return fail(proj.error);
  const ctx = ctxOf(deps, proj.project);
  const pre = await dockerPreflight(ctx.runner, deps.env);
  if (pre) return fail(pre);
  if (!existsSync(ctx.paths.compose) || !existsSync(ctx.paths.env)) {
    return fail("No local stack yet. Run `membral local up`.");
  }
  const env = readEnvFile(ctx.paths);
  const port = Number(env.MEMBRAL_APP_PORT) || DEFAULT_APP_PORT;
  const url = appUrl(port);
  const ps = await composePs(ctx);
  let healthy = true;
  console.log(`Membral local: ${url}`);
  for (const svc of SERVICES) {
    const e = ps.find((x) => x.Service === svc);
    const state = e ? `${e.State}${e.Health ? ` (${e.Health})` : ""}` : "not created";
    if (!e || e.State !== "running" || (e.Health && e.Health !== "healthy")) healthy = false;
    console.log(`  ${svc.padEnd(8)} ${state}`);
  }
  const health = await getHealth(ctx, url);
  if (!health.ok) healthy = false;
  console.log(`  Health:  ${health.ok ? "ok" : "not answering"} (${url}/api/health)`);

  const state = loadProfiles(ctx.credsPath);
  const local = state?.profiles[LOCAL_PROFILE];
  if (!local) console.log('  Profile: no "local" profile. Run `membral local up`.');
  else if (state?.activeProfile === LOCAL_PROFILE) console.log(`  Profile: local (active) ${local.apiUrl}`);
  else console.log(`  Profile: local ${local.apiUrl}; active is "${state?.activeProfile}" (\`membral use local\`)`);

  const email = env.MEMBRAL_LOCAL_EMAIL || DEFAULT_EMAIL;
  if (opts.showPassword && !env.MEMBRAL_LOCAL_PASSWORD) {
    console.log(
      `  Sign in: ${email} / password unknown (not in ${ctx.paths.env}). Change it in the app, or reset everything with \`membral local down --wipe\` (deletes local data) and \`membral local up\`.`,
    );
  } else {
    console.log(
      opts.showPassword
        ? `  Sign in: ${email} / ${env.MEMBRAL_LOCAL_PASSWORD} (as set at creation; if you changed it in the app, use that)`
        : `  Sign in: ${email} (password: \`membral local status --show-password\`)`,
    );
  }
  console.log(`  ${embeddingsLine(env)}`);
  const line = extractionLine(health.llm);
  if (line) console.log(line.startsWith("Extraction is off") ? line : `  ${line}`);
  if (!healthy) process.exitCode = 1;
}

// --- reembed ------------------------------------------------------------------

const REEMBED_TABLES = ["session_memories", "conversations", "conversation_chunks", "session_raw_units"] as const;
type ReembedTableName = (typeof REEMBED_TABLES)[number];
const REEMBED_PROGRESS_EVERY_MS = 3000;
const REEMBED_MAX_BATCH = 256;
/** Consecutive 429 / 5xx / network failures tolerated before the run gives up (progress is kept; rerun resumes). */
const REEMBED_MAX_FAILURES = 8;

interface ReembedResponse {
  table: ReembedTableName | null;
  done: number;
  failed: number;
  /** Rows left selected after a transient embedder error (5xx, timeout); a rerun retries them. */
  deferred?: number;
  /** Only the first call, a dry run and the last call carry counts; later calls send null. */
  remaining_by_table: Record<ReembedTableName, number> | null;
  finished: boolean;
  next: { table: ReembedTableName; after: string | null } | null;
  family: string;
  counts?: Record<
    ReembedTableName,
    { remaining: number; missing: number; foreign_default: number; foreign_other: number }
  >;
}

function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

/**
 * `membral local reembed`: moves every stored vector to the embedding model the stack is configured with
 * (after `membral local up --embeddings ollama --embedding-model <name>`). Drives POST /api/internal/local/reembed,
 * one batch per request, until the server reports it is finished. Resumable: Ctrl-C (or any failure) keeps what is
 * done, and a rerun picks up the rest. 429s back off per CLAUDE.md rule 4. Only the app URL is used (no Docker).
 */
export async function localReembed(
  opts: { project?: string; batch?: string; dryRun?: boolean } = {},
  deps: LocalDeps = {},
): Promise<void> {
  const proj = resolveProject(opts.project, deps.env ?? process.env);
  if ("error" in proj) return fail(proj.error);
  let batch: number | undefined;
  if (opts.batch !== undefined) {
    batch = Number(opts.batch);
    if (!Number.isInteger(batch) || batch < 1 || batch > REEMBED_MAX_BATCH) {
      return fail(`Invalid --batch "${opts.batch}": pass a whole number from 1 to ${REEMBED_MAX_BATCH}.`);
    }
  }
  const ctx = ctxOf(deps, proj.project);
  if (!existsSync(ctx.paths.compose) || !existsSync(ctx.paths.env)) {
    return fail("No local stack yet. Run `membral local up`.");
  }
  const env = readEnvFile(ctx.paths);
  const key = env.SERVICE_ROLE_KEY;
  if (!key) return fail(`No SERVICE_ROLE_KEY in ${ctx.paths.env}; run \`membral local up\` to repair the stack files.`);
  const url = appUrl(Number(env.MEMBRAL_APP_PORT) || DEFAULT_APP_PORT);
  const now = deps.now ?? Date.now;

  // Ctrl-C: finish the batch in flight, then stop. A second Ctrl-C quits at once.
  let stopped = deps.stopSignal?.aborted ?? false;
  deps.stopSignal?.addEventListener("abort", () => {
    stopped = true;
  });
  let onSigint: (() => void) | undefined;
  if (!deps.stopSignal) {
    onSigint = () => {
      if (stopped) process.exit(130);
      stopped = true;
      console.error("\nStopping after this batch (Ctrl-C again to quit now). Run the command again to resume.");
    };
    process.on("SIGINT", onSigint);
  }

  const bucket = createBucketState();
  let failures = 0;
  /** null = failed (already reported); "stopped" = Ctrl-C arrived while waiting out a retry. */
  const call = async (query: URLSearchParams): Promise<ReembedResponse | "stopped" | null> => {
    for (;;) {
      const epoch = bucket.epoch;
      let res: Response;
      try {
        res = await ctx.fetchImpl(`${url}/api/internal/local/reembed?${query}`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(10 * 60_000),
        });
      } catch (err) {
        if (++failures >= REEMBED_MAX_FAILURES) {
          fail(`The app at ${url} is not answering: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }
        growBucketState(bucket, epoch, false);
        await ctx.sleep(RULE4_BACKOFF.retryWaitMs(bucket.delayMs));
        if (stopped) return "stopped";
        continue;
      }
      if (res.ok) {
        failures = 0;
        decayBucketState(bucket);
        return (await res.json()) as ReembedResponse;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (res.status === 429) {
        if (++failures >= REEMBED_MAX_FAILURES) {
          fail("The embedding provider keeps rate-limiting; progress is kept, run the command again later.");
          return null;
        }
        growBucketState(bucket, epoch, false);
        const wait = RULE4_BACKOFF.rateLimitWaitMs(parseRetryAfterMs(res.headers.get("retry-after")), bucket.delayMs);
        console.error(`  rate limited; waiting ${fmtDuration(wait)}`);
        await ctx.sleep(wait);
        if (stopped) return "stopped";
        continue;
      }
      if (res.status === 401) fail("The app rejected the stack's service key. Run `membral local up` to repair it.");
      else if (res.status === 404)
        fail("This app has no re-embed route (is it an older image? run `membral local up --image <newer>`).");
      else if (res.status === 409) fail(body.message ?? "No embedding provider is configured for this stack.");
      else if (res.status === 422 && body.error === "embedding_dimension") {
        fail(
          `${body.message ?? "The embedding model returns vectors wider than the store holds."} Nothing was written. Pick a model with 1536 or fewer dimensions (\`membral local up --embedding-model <name>\`).`,
        );
      } else if (res.status === 502) fail(body.message ?? "The embedding server did not answer; nothing was changed.");
      else
        fail(
          `Re-embed failed (HTTP ${res.status})${body.message ? `: ${body.message}` : ""}. See \`membral local logs app\`.`,
        );
      return null;
    }
  };

  try {
    if (opts.dryRun) {
      const r = await call(new URLSearchParams({ dry_run: "1" }));
      if (r === "stopped") {
        console.log("Stopped.");
        process.exitCode = 130;
        return;
      }
      if (!r?.counts) return;
      console.log(`Target embedding model: ${r.family}`);
      console.log(
        `${"table".padEnd(22)}${"to re-embed".padStart(12)}${"no vector".padStart(11)}${"default model".padStart(15)}${"other model".padStart(13)}`,
      );
      let total = 0;
      for (const t of REEMBED_TABLES) {
        const c = r.counts[t];
        total += c.remaining;
        console.log(
          `${t.padEnd(22)}${String(c.remaining).padStart(12)}${String(c.missing).padStart(11)}${String(c.foreign_default).padStart(15)}${String(c.foreign_other).padStart(13)}`,
        );
      }
      console.log(
        total === 0 ? "Nothing to re-embed." : `Dry run: ${total} vector(s) would be re-embedded. Nothing was written.`,
      );
      return;
    }

    const started = now();
    let cursor: ReembedResponse["next"] = null;
    const totals = {} as Record<ReembedTableName, number>;
    const processed = {} as Record<ReembedTableName, number>;
    let done = 0;
    let failed = 0;
    let deferred = 0;
    let finished = false;
    let lastPrint = 0;
    let first = true;
    while (!stopped) {
      const q = new URLSearchParams();
      if (batch !== undefined) q.set("batch", String(batch));
      if (cursor) {
        q.set("table", cursor.table);
        if (cursor.after) q.set("after", cursor.after);
      }
      const r = await call(q);
      if (r === "stopped") break;
      if (!r) return;
      const handled = r.done + r.failed + (r.deferred ?? 0);
      done += r.done;
      failed += r.failed;
      deferred += r.deferred ?? 0;
      if (first) {
        first = false;
        for (const t of REEMBED_TABLES) {
          // Deferred rows are still selected, so `remaining` already counts them.
          totals[t] = (r.remaining_by_table?.[t] ?? 0) + (t === r.table ? r.done + r.failed : 0);
          processed[t] = 0;
        }
        const all = REEMBED_TABLES.reduce((n, t) => n + totals[t], 0);
        if (all === 0) {
          console.log(`Nothing to re-embed: every vector is already ${r.family}.`);
          return;
        }
        console.log(`Re-embedding ${all} row(s) to ${r.family}. Ctrl-C stops cleanly; rerun resumes.`);
      }
      if (r.table) processed[r.table] += handled;
      if (r.finished) {
        finished = true;
        break;
      }
      cursor = r.next;
      if (r.table && now() - lastPrint >= REEMBED_PROGRESS_EVERY_MS) {
        lastPrint = now();
        const elapsed = Math.max(1, now() - started);
        const rate = ((done + failed + deferred) * 1000) / elapsed;
        const left = REEMBED_TABLES.reduce((n, t) => n + Math.max(0, totals[t] - processed[t]), 0);
        const eta = rate > 0 ? ` eta ${fmtDuration((left / rate) * 1000)}` : "";
        console.log(
          `  ${r.table.padEnd(20)} ${processed[r.table]}/${totals[r.table]}  ${rate.toFixed(1)} rows/s${eta}`,
        );
      }
    }
    const elapsed = fmtDuration(now() - started);
    if (!finished) {
      console.log(`Stopped after ${done} re-embedded in ${elapsed}. Run \`membral local reembed\` again to resume.`);
      process.exitCode = 130;
      return;
    }
    console.log(`Done: ${done} re-embedded in ${elapsed}.`);
    if (failed > 0) {
      console.log(`${failed} row(s) had text the model rejected; they stay keyword-searchable only.`);
    }
    if (deferred > 0) {
      console.log(
        `${deferred} row(s) were skipped after transient embedding-server errors and were left as they were; run \`membral local reembed\` again to retry them.`,
      );
    }
  } finally {
    if (onSigint) process.off("SIGINT", onSigint);
  }
}

// --- down / logs --------------------------------------------------------------

async function defaultConfirm(question: string): Promise<boolean> {
  const p = createPrompter();
  try {
    return /^y(es)?$/i.test((await p.ask(question)).trim());
  } finally {
    p.close();
  }
}

export async function localDown(
  opts: { wipe?: boolean; yes?: boolean; project?: string } = {},
  deps: LocalDeps = {},
): Promise<void> {
  const proj = resolveProject(opts.project, deps.env ?? process.env);
  if ("error" in proj) return fail(proj.error);
  const ctx = ctxOf(deps, proj.project);
  const pre = await dockerPreflight(ctx.runner, deps.env);
  if (pre) return fail(pre);
  if (!existsSync(ctx.paths.compose) || !existsSync(ctx.paths.env)) {
    console.log("No local stack to stop.");
    return;
  }
  let wipe = false;
  if (opts.wipe) {
    wipe =
      opts.yes ||
      (await (deps.confirm ?? defaultConfirm)("Delete the local database (every session and memory in it)? [y/N] "));
    if (!wipe) {
      console.log("Not wiping. Stopping the stack and keeping the data.");
    }
  }
  const r = await ctx.runner.run(composeArgs(ctx.paths, "down", "--remove-orphans", ...(wipe ? ["-v"] : [])));
  if (r.code !== 0) return fail(`docker compose down failed: ${lastLine(r)}`);
  console.log(
    wipe
      ? "Stopped and wiped the local database and the downloaded Claude Code and embedding-model volumes."
      : "Stopped. Data kept; `membral local up` resumes.",
  );
}

export async function localLogs(
  opts: { service?: string; follow?: boolean; project?: string } = {},
  deps: LocalDeps = {},
): Promise<void> {
  const proj = resolveProject(opts.project, deps.env ?? process.env);
  if ("error" in proj) return fail(proj.error);
  const ctx = ctxOf(deps, proj.project);
  const pre = await dockerPreflight(ctx.runner, deps.env);
  if (pre) return fail(pre);
  if (!existsSync(ctx.paths.compose) || !existsSync(ctx.paths.env)) {
    return fail("No local stack yet. Run `membral local up`.");
  }
  if (opts.service && !(SERVICES as readonly string[]).includes(opts.service)) {
    return fail(`Unknown service "${opts.service}" (one of: ${SERVICES.join(", ")}).`);
  }
  const args = composeArgs(
    ctx.paths,
    "logs",
    ...(opts.follow ? ["--follow"] : []),
    ...(opts.service ? [opts.service] : []),
  );
  const r = await ctx.runner.run(args, { inherit: true });
  if (r.code !== 0) process.exitCode = r.code;
}
