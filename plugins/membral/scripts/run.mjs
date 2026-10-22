#!/usr/bin/env node
// Membral plugin hook entry: `node run.mjs session-start|session-end`.
//
// Claude Code runs this in exec form (hooks/hooks.json) with the hook's JSON
// on stdin. It runs the bundled CLI (./membral.mjs) as a child process, with
// the plugin's api_key option (CLAUDE_PLUGIN_OPTION_API_KEY) passed as
// MEMBRAL_API_KEY and the server pinned to https://membral.me, so the plugin
// never depends on `membral login`, a profile, or a CLI on PATH. The CLI
// runs as its own process so its argv[1] is the bundle: session-end-hook
// re-spawns `node <argv[1]> session-end-hook --deferred-path …` detached.
// MEMBRAL_PLUGIN_API_URL may point at http://127.0.0.1:* or
// http://localhost:* for local testing; any other value is ignored.
//
// Every hook path exits 0.
//
// - Double install: if `membral setup` already wrote its own hook for this
//   event into <claude config dir>/settings.json, and the executable and
//   script that hook names still exist, this no-ops so the hook runs once.
// - Imports (session-start only, detached, never awaited): until a first
//   import has exited 0 (<data>/first-import.done), one is started (hourly,
//   daily after 3 failures in a row); after that, a catch-up import runs
//   at most once per 24 h. Both are `membral sessions` (last 30 days; the
//   known-sessions probe skips what is already uploaded). A lock file keeps
//   it to one at a time. Output goes to <data>/import.log.
import { spawn, spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const CLI = join(HERE, "membral.mjs");
const DEFAULT_API_URL = "https://membral.me";
const LOCAL_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d{1,5})?\/?$/;

const HOUR_MS = 60 * 60 * 1000;
const FIRST_RETRY_MS = HOUR_MS;
const MAX_FAST_RETRIES = 3;
const LOG_MAX_BYTES = 1024 * 1024;
const LOG_KEEP_BYTES = 256 * 1024;
const CATCH_UP_MS = 24 * HOUR_MS;
const LOCK_STALE_MS = 2 * HOUR_MS;
const IMPORT_TIMEOUT_MS = 90 * 60 * 1000;
const PREAMBLE_FETCH_MS = 4000;

const MODES = {
  "session-start": { event: "SessionStart", sub: ["preamble", "--hook"], timeoutMs: 4800 },
  "session-end": { event: "SessionEnd", sub: ["session-end-hook"], timeoutMs: 9500 },
  // Antigravity (hooks.json beside this scripts/ dir). `agy: true` modes are guarded against
  // `membral setup`'s ~/.gemini/config/hooks.json instead of Claude's settings.json, and fall back
  // to the CLI's own credentials when no MEMBRAL_API_KEY is set (Antigravity has no plugin options).
  "agy-session-start": {
    agy: true,
    event: "PreInvocation",
    sub: ["preamble", "--hook", "--format", "agy"],
    timeoutMs: 4800,
  },
  "agy-session-end": { agy: true, event: "Stop", sub: ["session-end-hook", "--source", "agy"], timeoutMs: 9500 },
};

// ---- double-install guard -------------------------------------------------

function configDir() {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/** Shell-style split for the commands setup writes: "a b" quoting, \-escapes, bare words. */
function splitCommand(cmd) {
  const out = [];
  let cur = "";
  let quote = null;
  let has = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (has || cur) out.push(cur);
  return out;
}

function onPath(name) {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (dir && existsSync(join(dir, name))) return true;
  }
  return false;
}

/** True when the argv before `sub` names an executable (and script) that exist. */
function commandRunnable(cmd, sub) {
  const argv = splitCommand(cmd);
  const at = argv.findIndex((a, i) => sub.every((s, j) => argv[i + j] === s));
  if (at < 1) return false;
  return argv.slice(0, at).every((a, i) => {
    if (isAbsolute(a)) return existsSync(a);
    if (i === 0) return onPath(a);
    return true;
  });
}

/** True when ~/.gemini/config/hooks.json has setup's own, still-runnable `membral` hook for `event`. */
function agyHookPresent(event, sub) {
  let hooks;
  try {
    hooks = JSON.parse(readFileSync(join(homedir(), ".gemini", "config", "hooks.json"), "utf8"));
  } catch {
    return false;
  }
  const handlers = hooks?.membral?.[event];
  if (!Array.isArray(handlers)) return false;
  const marker = ` ${sub.join(" ")}`;
  return handlers.some((h) => typeof h?.command === "string" && h.command.includes(marker) && commandRunnable(h.command, sub));
}

/** True when settings.json has setup's own, still-runnable Membral hook for `event`. */
function setupHookPresent(event, sub) {
  let settings;
  try {
    settings = JSON.parse(readFileSync(join(configDir(), "settings.json"), "utf8"));
  } catch {
    return false;
  }
  const groups = settings?.hooks?.[event];
  if (!Array.isArray(groups)) return false;
  const marker = ` ${sub.join(" ")}`;
  return groups.some(
    (g) =>
      Array.isArray(g?.hooks) &&
      g.hooks.some(
        (h) => typeof h?.command === "string" && h.command.includes(marker) && commandRunnable(h.command, sub),
      ),
  );
}

// ---- imports --------------------------------------------------------------

function paths(dataDir) {
  return {
    done: join(dataDir, "first-import.done"),
    attempt: join(dataDir, "last-import.json"),
    lock: join(dataDir, "import.lock"),
    log: join(dataDir, "import.log"),
  };
}

/** last-import.json: when the last import started, its kind, and consecutive failed first imports. */
function readAttempt(file) {
  try {
    const rec = JSON.parse(readFileSync(file, "utf8"));
    const at = Date.parse(rec.at);
    const failures = Number.isInteger(rec.failures) && rec.failures > 0 ? rec.failures : 0;
    return { atMs: Number.isFinite(at) ? at : 0, kind: rec.kind, failures };
  } catch {
    return { atMs: 0, kind: undefined, failures: 0 };
  }
}

function writeAttempt(file, rec) {
  writeFileSync(file, `${JSON.stringify(rec)}\n`);
}

/** Keeps import.log bounded: past LOG_MAX_BYTES, keep only its last LOG_KEEP_BYTES. */
function trimLog(file) {
  try {
    const size = statSync(file).size;
    if (size <= LOG_MAX_BYTES) return;
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(LOG_KEEP_BYTES);
    try {
      readSync(fd, buf, 0, LOG_KEEP_BYTES, size - LOG_KEEP_BYTES);
    } finally {
      closeSync(fd);
    }
    writeFileSync(file, buf);
  } catch {
    // A log that cannot be trimmed is not worth failing an import over.
  }
}

function lockHeld(lock) {
  try {
    return Date.now() - statSync(lock).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
}

/** From SessionStart: start the first import or the daily catch-up, detached, when due. */
function maybeStartImport(dataDir, env) {
  const p = paths(dataDir);
  if (lockHeld(p.lock)) return;
  const kind = existsSync(p.done) ? "catch-up" : "first";
  const last = readAttempt(p.attempt);
  // A first import that keeps failing (e.g. a revoked key) drops to the daily cadence.
  const wait = kind === "first" && last.failures < MAX_FAST_RETRIES ? FIRST_RETRY_MS : CATCH_UP_MS;
  if (Date.now() - last.atMs < wait) return;
  writeAttempt(p.attempt, { at: new Date().toISOString(), kind, failures: last.failures });
  trimLog(p.log);
  const log = openSync(p.log, "a");
  try {
    const child = spawn(process.execPath, [SELF, "import-worker", kind], {
      detached: true,
      stdio: ["ignore", log, log],
      env,
    });
    child.on("error", () => {});
    child.unref();
  } finally {
    closeSync(log);
  }
}

/** Detached worker: hold the lock, run `membral sessions`, mark the first import done only on exit 0. */
function importWorker(kind, dataDir, env) {
  const p = paths(dataDir);
  if (lockHeld(p.lock)) return;
  try {
    unlinkSync(p.lock);
  } catch {}
  let fd;
  try {
    fd = openSync(p.lock, "wx");
  } catch {
    return;
  }
  writeSync(fd, `${JSON.stringify({ pid: process.pid, kind, at: new Date().toISOString() })}\n`);
  closeSync(fd);
  try {
    console.log(`[${new Date().toISOString()}] ${kind} import starting`);
    const res = spawnSync(process.execPath, [CLI, "sessions"], {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: IMPORT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
    });
    const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
    trimLog(p.log);
    appendFileSync(p.log, out);
    // The CLI exits 0 when another import holds its own lock; that run imported nothing.
    const ok = res.status === 0 && !out.includes("another import is running");
    if (ok && kind === "first") writeFileSync(p.done, `${JSON.stringify({ at: new Date().toISOString() })}\n`);
    if (kind === "first") {
      const last = readAttempt(p.attempt);
      writeAttempt(p.attempt, {
        at: new Date(last.atMs || Date.now()).toISOString(),
        kind,
        failures: ok ? 0 : last.failures + 1,
      });
    }
    console.log(`[${new Date().toISOString()}] ${kind} import exited ${res.status}${ok ? "" : " (not done)"}`);
  } finally {
    try {
      unlinkSync(p.lock);
    } catch {}
  }
}

// ---- main -----------------------------------------------------------------

function cliEnv(apiKey) {
  const override = process.env.MEMBRAL_PLUGIN_API_URL;
  return {
    ...process.env,
    MEMBRAL_API_KEY: apiKey,
    MEMBRAL_API_URL: override && LOCAL_URL.test(override) ? override.replace(/\/$/, "") : DEFAULT_API_URL,
    MEMBRAL_PREAMBLE_TIMEOUT_MS: String(PREAMBLE_FETCH_MS),
  };
}

function main() {
  const name = process.argv[2];
  const apiKey = process.env.CLAUDE_PLUGIN_OPTION_API_KEY || (MODES[name]?.agy ? process.env.MEMBRAL_API_KEY : undefined);
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (dataDir) {
    try {
      mkdirSync(dataDir, { recursive: true });
    } catch {}
  }

  if (name === "import-worker") {
    if (apiKey && dataDir) importWorker(process.argv[3] === "first" ? "first" : "catch-up", dataDir, cliEnv(apiKey));
    process.exit(0);
  }

  const mode = MODES[name];
  if (!mode) process.exit(0);
  if (mode.agy ? agyHookPresent(mode.event, mode.sub) : setupHookPresent(mode.event, mode.sub)) process.exit(0);

  if (mode.agy && mode.event === "PreInvocation" && !process.env.MEMBRAL_AUTH_HEADER) {
    // mcp_config.json reads the bearer from MEMBRAL_AUTH_HEADER, which Antigravity's MCP file cannot
    // define for a plugin (no header or env substitution is documented). stderr only: stdout is the hook's reply.
    console.error(
      'membral plugin: MEMBRAL_AUTH_HEADER is not set, so the membral MCP server cannot authenticate. export MEMBRAL_AUTH_HEADER="Bearer <key>" or run `membral setup --agy`.',
    );
  }

  if (mode.agy && !apiKey) {
    // No key in the environment: the CLI resolves ~/.membral/credentials.json itself.
    spawnSync(process.execPath, [CLI, ...mode.sub], {
      stdio: "inherit",
      env: { ...process.env, MEMBRAL_API_URL: DEFAULT_API_URL, MEMBRAL_PREAMBLE_TIMEOUT_MS: String(PREAMBLE_FETCH_MS) },
      timeout: mode.timeoutMs,
    });
    process.exit(0);
  }

  if (!apiKey) {
    console.error("membral plugin: no API key set; run /plugin, open membral, and add your key from membral.me/settings");
    process.exit(0);
  }
  const env = cliEnv(apiKey);

  if (name === "session-start" && dataDir) {
    try {
      maybeStartImport(dataDir, env);
    } catch {
      // Best effort: SessionEnd still uploads each new session.
    }
  }

  // stdin is inherited, so the hook payload reaches the CLI unchanged.
  spawnSync(process.execPath, [CLI, ...mode.sub], { stdio: "inherit", env, timeout: mode.timeoutMs });
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0);
}
