// opencode wiring written by `membral setup` and re-pointed by `membral use`:
//
//   1. MCP: `mcp.membral` in the global opencode config
//      (~/.config/opencode/opencode.json). Shape verified against
//      @opencode-ai/sdk's `McpRemoteConfig` type (types.gen.d.ts, sdk shipped
//      with @opencode-ai/plugin 1.4.0): `{ type: "remote", url, enabled?,
//      headers? }`.
//   2. Capture plugin: ~/.config/opencode/plugin/membral.js. opencode (1.18.x)
//      loads every `{plugin,plugins}/*.{ts,js}` file in its config dir, and
//      requires every export of such a file to be a plugin function
//      (`async (input) => Hooks`, with `Hooks.event({ event })`); the idle
//      event is `{ type: "session.idle", properties: { sessionID } }` (sdk
//      `EventSessionIdle`). On idle it spawns a detached, globally debounced
//      `membral sessions --source opencode --since <10 min ago>` — the same
//      node + CLI entry the Claude Code hooks run. The same plugin injects the
//      preamble: `session.created` prefetches `membral preamble --hook --format
//      text` per session, and `experimental.chat.system.transform` (every LLM
//      request; pushes onto `output.system`) adds the cached text, waiting at
//      most 2.5 s. Hook shape verified against @opencode-ai/plugin 1.15.13
//      types; `session.created` carries `properties.info` (id, directory,
//      parentID). Sub-agent sessions (a parentID) get no preamble, like Claude
//      Code's SessionStart; an empty or failed fetch is retried once after 60 s.
//
// Both writes are idempotent, back up what they replace to `.membral.bak`,
// write atomically, and write THROUGH a symlink (dotfiles-managed configs)
// instead of replacing it — same helpers as the Claude Code settings.json
// writer in configure.ts.
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  type CliInvocation,
  type ConfigureResult,
  isEnoent,
  isSymlink,
  resolveCliInvocation,
  writeFileAtomic,
} from "./configure.js";
import { LOG_MAX_BYTES } from "./log-rotate.js";

export function defaultOpencodeConfigDir(): string {
  return join(homedir(), ".config", "opencode");
}

/** True when opencode looks installed/used on this machine (config dir or its session store exists). */
export function detectOpencode(configDir: string = defaultOpencodeConfigDir()): boolean {
  return existsSync(configDir) || existsSync(join(homedir(), ".local", "share", "opencode"));
}

export interface OpencodeMcpEntry {
  type: "remote";
  url: string;
  headers: { Authorization: string };
  enabled: true;
}

export function buildOpencodeMcpEntry(apiUrl: string, apiKey: string): OpencodeMcpEntry {
  return {
    type: "remote",
    url: `${apiUrl.replace(/\/+$/, "")}/api/mcp`,
    headers: { Authorization: `Bearer ${apiKey}` },
    enabled: true,
  };
}

function snippetFor(entry: OpencodeMcpEntry): string {
  const body = JSON.stringify({ mcp: { membral: entry } }, null, 2)
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
  return body;
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if (isEnoent(err) && !(await isSymlink(path))) return undefined;
    throw err;
  }
}

/** Best-effort 0600 on the real file (through a symlink) — this entry carries a raw API key. */
async function restrictMode(path: string): Promise<void> {
  try {
    await chmod((await isSymlink(path)) ? await realpath(path) : path, 0o600);
  } catch {
    // best-effort
  }
}

export interface OpencodeMcpOptions {
  apiUrl: string;
  apiKey: string;
  configDir?: string;
}

/**
 * Merge `mcp.membral` into the global opencode config. Writes opencode.json
 * (or opencode.jsonc when that's the only file and it is plain JSON). A file
 * that doesn't parse as strict JSON (comments, trailing commas) is never
 * rewritten — the snippet to paste is returned instead.
 */
export async function configureOpencodeMcp(opts: OpencodeMcpOptions): Promise<ConfigureResult> {
  const dir = opts.configDir ?? defaultOpencodeConfigDir();
  const entry = buildOpencodeMcpEntry(opts.apiUrl, opts.apiKey);
  const jsonPath = join(dir, "opencode.json");
  const jsoncPath = join(dir, "opencode.jsonc");

  try {
    let path = jsonPath;
    let original = await readIfExists(jsonPath);
    if (original === undefined) {
      const jsonc = await readIfExists(jsoncPath);
      if (jsonc !== undefined) {
        path = jsoncPath;
        original = jsonc;
      }
    }

    let config: Record<string, unknown>;
    if (original === undefined) {
      config = { $schema: "https://opencode.ai/config.json" };
    } else {
      try {
        const parsed = JSON.parse(original);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not a JSON object");
        config = parsed as Record<string, unknown>;
      } catch {
        return {
          success: true,
          message:
            `${path} has comments or isn't strict JSON — left it untouched. Add this yourself:\n` +
            `${snippetFor(entry)}`,
        };
      }
    }

    const mcp =
      config.mcp && typeof config.mcp === "object" && !Array.isArray(config.mcp)
        ? { ...(config.mcp as Record<string, unknown>) }
        : {};
    if (JSON.stringify(mcp.membral) === JSON.stringify(entry)) {
      return { success: true, message: `opencode MCP already points at ${entry.url} (${path})` };
    }
    const verb = mcp.membral === undefined ? "Added" : "Updated";
    mcp.membral = entry;
    config.mcp = mcp;

    await mkdir(dir, { recursive: true });
    if (original !== undefined) {
      // The previous config may hold an earlier `Bearer <key>` — the backup gets the same 0600 as the live file.
      const bakPath = `${path}.membral.bak`;
      await writeFileAtomic(bakPath, original);
      await restrictMode(bakPath);
    }
    await writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
    await restrictMode(path);
    return { success: true, message: `${verb} opencode MCP entry (${entry.url}) in: ${path}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to configure opencode MCP: ${msg}` };
  }
}

// --- Capture plugin ----------------------------------------------------------

export const OPENCODE_PLUGIN_VERSION = 4;
const PLUGIN_MARKER = "membral-opencode-plugin";

export function defaultOpencodePluginPath(configDir: string = defaultOpencodeConfigDir()): string {
  return join(configDir, "plugin", "membral.js");
}

export function defaultOpencodePluginLogPath(): string {
  return join(homedir(), ".membral", "logs", "opencode-plugin.log");
}

export interface OpencodePluginSourceOptions {
  /** Debounce window — tests only; production is 60 s. */
  minIntervalMs?: number;
  /** Max wait for the preamble inside a request — tests only; production is 2.5 s. */
  preambleWaitMs?: number;
  /** Hard kill for the preamble child — tests only; production is 5 s. */
  preambleKillMs?: number;
  /** Wait before an empty or failed preamble is fetched once more — tests only; production is 60 s. */
  preambleRetryMs?: number;
}

/**
 * The plugin file's source. One export only — opencode treats every export
 * of a plugin file as a plugin function. Everything inside the handler is
 * wrapped so nothing ever throws into opencode.
 *
 * Debounce is GLOBAL, not per session: every spawn imports all opencode
 * sessions of the last 10 minutes, so N sub-agents going idle together must
 * cause one import, not N. The first idle runs now; any idle within the
 * next 60 s collapses into a single trailing run. The CLI's import lock
 * (~/.membral/import.lock) covers a run racing the sweep.
 */
export function buildOpencodePluginSource(
  invocation: CliInvocation,
  logPath: string,
  opts: OpencodePluginSourceOptions = {},
): string {
  return `// ${PLUGIN_MARKER} v${OPENCODE_PLUGIN_VERSION} — written by \`membral setup\`; re-run setup to upgrade.
// Uploads opencode sessions to Membral when a session goes idle, and adds the Membral
// memory preamble to the system prompt. Edits are overwritten.
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, renameSync, statSync } from "node:fs";
import { dirname } from "node:path";

const CLI = ${JSON.stringify(invocation.argv)};
const LOG = ${JSON.stringify(logPath)};
const LOG_MAX_BYTES = ${LOG_MAX_BYTES};
const MIN_INTERVAL_MS = ${opts.minIntervalMs ?? 60_000};
const SINCE_WINDOW_MS = 10 * 60_000;
const PREAMBLE_WAIT_MS = ${opts.preambleWaitMs ?? 2_500};
const PREAMBLE_KILL_MS = ${opts.preambleKillMs ?? 5_000};
const PREAMBLE_RETRY_MS = ${opts.preambleRetryMs ?? 60_000};
const MAX_CACHED_SESSIONS = 50;
let lastRun = 0;
let pending = null;

function rotateLog() {
  try {
    if (statSync(LOG).size > LOG_MAX_BYTES) renameSync(LOG, LOG + ".1");
  } catch {
    // no log yet, or rotation failed — keep appending
  }
}

function upload() {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    rotateLog();
    const fd = openSync(LOG, "a");
    try {
      const since = new Date(Date.now() - SINCE_WINDOW_MS).toISOString();
      const args = [...CLI.slice(1), "sessions", "--source", "opencode", "--since", since, "--yes"];
      const child = spawn(CLI[0], args, { detached: true, stdio: ["ignore", fd, fd] });
      child.on("error", () => {});
      child.unref();
    } finally {
      closeSync(fd);
    }
  } catch {
    // never throw into opencode
  }
}

function schedule() {
  if (pending) return; // a trailing run is already queued — it covers this idle too
  const wait = lastRun + MIN_INTERVAL_MS - Date.now();
  if (wait <= 0) {
    lastRun = Date.now();
    upload();
    return;
  }
  pending = setTimeout(() => {
    pending = null;
    lastRun = Date.now();
    upload();
  }, wait);
  pending.unref?.();
}

// sessionID -> { p: Promise<string> (the preamble text, "" when none or on
// failure), text, at, retried }. Insertion order = age, so the first key is
// the oldest.
const preambles = new Map();
// Sub-agent sessions (session.created with info.parentID): no preamble, so
// they neither get the text nor log a recall event of their own.
const children = new Set();

function remember(map, key, value) {
  if (map instanceof Set) map.add(key);
  else map.set(key, value);
  while (map.size > MAX_CACHED_SESSIONS) map.delete(map.keys().next().value);
}

function fetchPreamble(cwd, sessionID) {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let child;
    let killer;
    const finish = (text) => {
      if (done) return;
      done = true;
      clearTimeout(killer);
      resolve(text);
    };
    try {
      child = spawn(CLI[0], [...CLI.slice(1), "preamble", "--hook", "--format", "text"], {
        stdio: ["pipe", "pipe", "ignore"],
      });
      killer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
        finish("");
      }, PREAMBLE_KILL_MS);
      killer.unref?.();
      child.on("error", () => finish(""));
      child.stdin.on("error", () => {});
      child.stdout.on("data", (chunk) => {
        out += chunk;
      });
      child.on("close", () => finish(out.trim()));
      child.stdin.end(JSON.stringify({ cwd, session_id: sessionID }));
    } catch {
      finish("");
    }
  });
}

function preambleFor(sessionID, cwd) {
  const cached = preambles.get(sessionID);
  // An empty or failed fetch is tried once more, PREAMBLE_RETRY_MS later.
  const retry =
    cached && cached.text === "" && !cached.retried && Date.now() - cached.at >= PREAMBLE_RETRY_MS;
  if (cached && !retry) return cached.p;
  const entry = { p: null, text: undefined, at: 0, retried: Boolean(cached) };
  entry.p = fetchPreamble(cwd, sessionID)
    .catch(() => "")
    .then((text) => {
      entry.text = text;
      entry.at = Date.now();
      return text;
    });
  if (cached) preambles.delete(sessionID);
  remember(preambles, sessionID, entry);
  return entry.p;
}

export const MembralCapture = async (input) => ({
  event: async ({ event }) => {
    try {
      if (event?.type === "session.created") {
        // Prefetch so the first request usually finds the preamble ready.
        const info = event.properties?.info;
        const id = info?.id ?? event.properties?.sessionID;
        if (!id) return;
        if (info?.parentID) {
          remember(children, id);
          return;
        }
        preambleFor(id, info?.directory ?? input?.directory ?? process.cwd());
        return;
      }
      if (event?.type !== "session.idle") return;
      schedule();
    } catch {
      // never throw into opencode
    }
  },
  // Fires on every LLM request; the system prompt is rebuilt each time, so the
  // cached text is pushed each time. Never waits longer than PREAMBLE_WAIT_MS.
  "experimental.chat.system.transform": async (hookInput, output) => {
    try {
      const id = hookInput?.sessionID;
      // A session not seen in session.created (plugin loaded later) is fetched lazily.
      if (!id || children.has(id) || !Array.isArray(output?.system)) return;
      const text = await Promise.race([
        preambleFor(id, input?.directory ?? process.cwd()),
        new Promise((resolve) => {
          const t = setTimeout(() => resolve(""), PREAMBLE_WAIT_MS);
          t.unref?.();
        }),
      ]);
      if (text) output.system.push(text);
    } catch {
      // never throw into opencode
    }
  },
});
`;
}

export interface InstallOpencodePluginOptions {
  configDir?: string;
  logPath?: string;
  cliInvocation?: CliInvocation;
  dryRun?: boolean;
}

/** Idempotent install/upgrade of the capture plugin. A same-named file WITHOUT our marker is the user's own — never overwritten. */
export async function installOpencodePlugin(opts: InstallOpencodePluginOptions = {}): Promise<ConfigureResult> {
  const pluginPath = defaultOpencodePluginPath(opts.configDir);
  const invocation = opts.cliInvocation ?? resolveCliInvocation();
  const source = buildOpencodePluginSource(invocation, opts.logPath ?? defaultOpencodePluginLogPath());

  try {
    const existing = await readIfExists(pluginPath);
    if (existing === source) {
      return { success: true, message: `opencode capture plugin already installed: ${pluginPath}` };
    }
    if (existing !== undefined && !existing.includes(PLUGIN_MARKER)) {
      return {
        success: false,
        message: `${pluginPath} exists and wasn't written by Membral — left it untouched. Move it aside and re-run setup.`,
      };
    }
    if (opts.dryRun) {
      return { success: true, message: `[dry-run] would write the opencode capture plugin to ${pluginPath}` };
    }
    await mkdir(join(pluginPath, ".."), { recursive: true });
    await writeFileAtomic(pluginPath, source);
    const verb = existing === undefined ? "Installed" : "Upgraded";
    return { success: true, message: `${verb} opencode capture plugin: ${pluginPath}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to install the opencode capture plugin: ${msg}` };
  }
}
