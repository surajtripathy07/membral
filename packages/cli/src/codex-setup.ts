// Plain `membral setup` (W9 D4/D5): configures Codex when it is installed.
// Three user-level files under ${CODEX_HOME:-~/.codex}, each merged so every
// byte Membral does not own survives:
//
//   config.toml  [mcp_servers.membral] — streamable HTTP to <api>/api/mcp.
//                No key in the file (people sync and commit it): Codex runs
//                `membral mcp-headers` as `http_headers_helper`, which prints
//                the Authorization header from ~/.membral/credentials.json
//                (mcp-headers.ts). Inline `bearer_token` is rejected by Codex
//                and `bearer_token_env_var` needs MEMBRAL_API_KEY in every
//                launcher's env, the stale-env-key failure of #136.
//                `default_tools_approval_mode = "approve"` lets the read-only
//                Membral tools run under `codex exec` (approval_policy never
//                denies tools that need approval).
//   hooks.json   one SessionStart handler: `membral preamble --hook`. Codex
//                parses Claude Code's `{"hookSpecificOutput":{"hookEventName":
//                "SessionStart","additionalContext":…}}` and sends `session_id`
//                and `cwd` on stdin (codex-rs/hooks/src/schema.rs,
//                events/session_start.rs), so the default format is used.
//                Codex skips user hooks until the user trusts them in the TUI;
//                setup never writes `[hooks.state] trusted_hash`.
//   AGENTS.md    a marked block telling Codex to call memory_search first.
//
// No SessionEnd hook: the sweep uploads Codex rollouts.

import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { RECALL_VS_STATE_FULL } from "@membral/core";
import { type CliInvocation, isEnoent, quoteInvocation, resolveCliInvocation, writeFileAtomic } from "./configure.js";
import { defaultCodexHome } from "./import-sessions.js";
import { PREAMBLE_HOOK_TIMEOUT_MS } from "./preamble-hook.js";

export type CodexFileOutcome = "created" | "updated" | "unchanged" | "would-write" | "skipped";

export interface CodexFileResult {
  path: string;
  outcome: CodexFileOutcome;
  /** Set when the file was left untouched because it could not be merged safely. */
  warning?: string;
}

export interface CodexSetupOptions {
  apiUrl: string;
  /** Defaults to ${CODEX_HOME:-~/.codex}. */
  codexHome?: string;
  /** Overrides the resolved node+entry invocation — tests only. */
  cliInvocation?: CliInvocation;
  dryRun?: boolean;
  /** `codex --version` output — tests only; null skips the check. Default: run it when codex is on PATH. */
  codexVersion?: string | null;
}

export interface CodexSetupResult {
  mcp: CodexFileResult;
  hooks: CodexFileResult;
  agents: CodexFileResult;
  /** The CLI fell back to `membral` on PATH, or pinned an nvm node. */
  invocationWarning?: string;
  /** The installed Codex is older than CODEX_MIN_VERSION. */
  versionWarning?: string;
}

// Codex's hook timeout is in seconds and kills the hook when it expires,
// reporting a failed hook (codex-rs/hooks/src/engine/command_runner.rs). The
// preamble caps only its fetch at PREAMBLE_HOOK_TIMEOUT_MS; node startup and
// the git reads come on top, so Codex waits 5 s longer, as Copilot's hook
// does (copilot-cli-hooks.ts).
export const CODEX_PREAMBLE_TIMEOUT_SEC = Math.ceil(PREAMBLE_HOOK_TIMEOUT_MS / 1000) + 5;
/**
 * The first Codex release whose `http_headers_helper` may set Authorization:
 * the helper arrived in rust-v0.148.0 (openai/codex#38245), and helpers could
 * supply Authorization from rust-v0.152.0 (#41400, "Allow helpers to supply
 * `Authorization`"). An older Codex connects without the key and gets a 401.
 */
export const CODEX_MIN_VERSION = "0.152.0";
export const AGENTS_BEGIN = "<!-- membral:begin -->";
export const AGENTS_END = "<!-- membral:end -->";

/** The one-line action after setup writes the hook. Names Codex's own UI (codex-rs/tui startup_hooks_review.rs, hooks_browser_view.rs). */
export const CODEX_APPROVE_HOOK_ACTION =
  'Start codex once and trust the Membral hook: at "Hooks need review" pick "Review hooks" (or run /hooks), select it and press t.';

// --- detection ---------------------------------------------------------------

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function onPath(cmd: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<boolean> {
  const dirs = (env.PATH ?? env.Path ?? "").split(platform === "win32" ? ";" : delimiter).filter(Boolean);
  const names = platform === "win32" ? [`${cmd}.exe`, `${cmd}.cmd`, `${cmd}.bat`, cmd] : [cmd];
  for (const dir of dirs) {
    for (const name of names) {
      if (await exists(join(dir, name))) return true;
    }
  }
  return false;
}

export interface CodexDetectOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

/** `codex` on PATH, or ${CODEX_HOME:-~/.codex} exists. */
export async function detectCodex(opts: CodexDetectOptions = {}): Promise<boolean> {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  if (await onPath("codex", env, platform)) return true;
  try {
    return (await stat(defaultCodexHome(env))).isDirectory();
  } catch {
    return false;
  }
}

// --- config.toml -----------------------------------------------------------------

function tomlString(value: string): string {
  // A literal string needs no escaping; fall back to a basic string (JSON's
  // escapes are valid TOML) when the value itself holds a single quote.
  return value.includes("'") || /[\r\n]/.test(value) ? JSON.stringify(value) : `'${value}'`;
}

export function mcpHeadersHelperCommand(invocation: CliInvocation, apiUrl: string): string {
  const url = apiUrl.replace(/\/+$/, "");
  return `${quoteInvocation(invocation)} mcp-headers --api-url "${url.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** The exact `[mcp_servers.membral]` table, LF line endings, trailing newline. */
export function buildCodexMcpTable(invocation: CliInvocation, apiUrl: string): string {
  const url = `${apiUrl.replace(/\/+$/, "")}/api/mcp`;
  return [
    "[mcp_servers.membral]",
    "# Written by `membral setup`; re-run it to update. The key stays in ~/.membral.",
    `url = ${tomlString(url)}`,
    `http_headers_helper = ${tomlString(mcpHeadersHelperCommand(invocation, apiUrl))}`,
    'default_tools_approval_mode = "approve"',
    "",
  ].join("\n");
}

/** Splits a TOML dotted key (`a."b.c".d`) into its parts; null when it is not a plain key. */
export function parseTomlKey(raw: string): string[] | null {
  const parts: string[] = [];
  let i = 0;
  const s = raw.trim();
  if (!s) return null;
  while (i < s.length) {
    while (s[i] === " " || s[i] === "\t") i++;
    let part: string;
    if (s[i] === '"' || s[i] === "'") {
      const q = s[i];
      const end = s.indexOf(q, i + 1);
      if (end < 0) return null;
      part = s.slice(i + 1, end);
      if (q === '"' && part.includes("\\")) return null;
      i = end + 1;
    } else {
      const m = /^[A-Za-z0-9_-]+/.exec(s.slice(i));
      if (!m) return null;
      part = m[0];
      i += part.length;
    }
    parts.push(part);
    while (s[i] === " " || s[i] === "\t") i++;
    if (i >= s.length) break;
    if (s[i] !== ".") return null;
    i++;
  }
  return parts;
}

/** Net open `[`/`{` in a value, ignoring quoted strings and a trailing comment. */
function bracketDelta(value: string): number {
  const bare = value
    .replace(/"(?:[^"\\]|\\.)*"/g, "")
    .replace(/'[^']*'/g, "")
    .replace(/#.*$/, "");
  let d = 0;
  for (const c of bare) {
    if (c === "[" || c === "{") d++;
    else if (c === "]" || c === "}") d--;
  }
  return d;
}

type MergeResult = { ok: true; text: string } | { ok: false; reason: string };

const isMembral = (path: string[]) => path[0] === "mcp_servers" && path[1] === "membral";

/** Keys of `[mcp_servers.membral]` that Membral writes and replaces on every run. */
const OWNED_KEYS = new Set(["url", "http_headers_helper", "default_tools_approval_mode"]);
/**
 * Keys removed because they break the server Membral writes: Codex rejects
 * the stdio keys and inline `bearer_token` next to `url`
 * (config/src/mcp_types.rs, `TryFrom<RawMcpServerConfig>`), and an explicit
 * Authorization from `bearer_token_env_var` wins over the helper's
 * (rmcp-client/src/http_headers.rs `apply_headers`), which would send a stale
 * key. An `Authorization` entry under `http_headers` / `env_http_headers` is
 * removed for the same reason; their other headers stay.
 */
const CONFLICT_KEYS = new Set(["command", "args", "env", "env_vars", "cwd", "bearer_token", "bearer_token_env_var"]);
const HEADER_MAPS = new Set(["http_headers", "env_http_headers"]);

/** Returns the multi-line string delimiter still open at the end of `s` (null when none), skipping one-line strings and a trailing comment. */
function openMultilineAfter(s: string, open: string | null): string | null {
  const close = (from: number, q: string): number => {
    let at = -1;
    if (q === "'''") at = s.indexOf(q, from);
    else {
      for (let i = from; i <= s.length - 3; i++) {
        if (s[i] === "\\") i++;
        else if (s.startsWith(q, i)) {
          at = i;
          break;
        }
      }
    }
    if (at < 0) return -1;
    let end = at + 3;
    // Up to two quotes right before the closing delimiter belong to the content.
    for (let k = 0; k < 2 && s[end] === q[0]; k++) end++;
    return end;
  };
  let i = 0;
  if (open) {
    i = close(0, open);
    if (i < 0) return open;
  }
  while (i < s.length) {
    const c = s[i];
    if (c === "#") return null;
    if (s.startsWith('"""', i) || s.startsWith("'''", i)) {
      const q = s.slice(i, i + 3);
      const end = close(i + 3, q);
      if (end < 0) return q;
      i = end;
    } else if (c === '"') {
      i++;
      while (i < s.length && s[i] !== '"') i += s[i] === "\\" ? 2 : 1;
      i++;
    } else if (c === "'") {
      const e = s.indexOf("'", i + 1);
      i = e < 0 ? s.length : e + 1;
    } else i++;
  }
  return null;
}

/**
 * Writes Membral's keys into `[mcp_servers.membral]` (or appends the table),
 * leaving every other line as is. Inside the table Membral owns only its
 * comment line, `url`, `http_headers_helper` and
 * `default_tools_approval_mode`; it also drops the keys in CONFLICT_KEYS and
 * an Authorization header entry. Every other key and sub-table (`enabled`,
 * `tool_timeout_sec`, `[mcp_servers.membral.tools.*]`, …) is kept.
 * Refuses (ok: false) when membral or mcp_servers is defined in a form a
 * line-level edit cannot change safely: an inline table or dotted key, an
 * array of tables, a duplicate table, a header it cannot parse, or an inline
 * header map that sets Authorization.
 */
export function mergeCodexConfigToml(existing: string | undefined, table: string): MergeResult {
  if (existing === undefined || existing.trim() === "") return { ok: true, text: table };
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const raw = existing.split("\n");
  const lines = raw.map((l) => l.replace(/\r$/, ""));
  const tableLines = table.replace(/\n$/, "").split("\n");
  const ourComment = tableLines[1];

  // Scan: decide per line whether it is removed; flag unsafe forms.
  let current: string[] = [];
  let inMultiline: string | null = null;
  let valueDepth = 0; // open [ / { of a multi-line array or inline-table value
  let entry = -1; // the key line a continuation line belongs to
  const remove: boolean[] = [];
  const mainHeaders: number[] = [];
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const trimmed = line.trim();
    remove[n] = false;
    if (inMultiline || valueDepth > 0) {
      remove[n] = entry >= 0 && remove[entry];
      if (inMultiline) inMultiline = openMultilineAfter(line, inMultiline);
      else valueDepth = Math.max(0, valueDepth + bracketDelta(line));
      continue;
    }
    entry = -1;
    if (trimmed.startsWith("[")) {
      const m = /^\[(\[)?([^[\]]*)\](\])?\s*(#.*)?$/.exec(trimmed);
      if (!m) return { ok: false, reason: `line ${n + 1}: a table header it could not read` };
      const path = parseTomlKey(m[2]);
      if (!path) return { ok: false, reason: `line ${n + 1}: a table header it could not read` };
      const arrayOfTables = Boolean(m[1] && m[3]);
      if (arrayOfTables && path[0] === "mcp_servers") {
        return { ok: false, reason: `line ${n + 1}: mcp_servers is an array of tables` };
      }
      current = path;
      if (isMembral(path) && path.length === 2) {
        if (mainHeaders.length > 0)
          return { ok: false, reason: `line ${n + 1}: [mcp_servers.membral] is defined twice` };
        mainHeaders.push(n);
      }
      remove[n] = isMembral(path) && path.length > 2 && CONFLICT_KEYS.has(path[2]);
      continue;
    }
    const kv = /^\s*([^=#]+?)\s*=/.exec(line);
    if (!kv) {
      remove[n] = isMembral(current) && current.length === 2 && trimmed === ourComment;
      continue;
    }
    entry = n;
    const value = line.slice(kv[0].length);
    valueDepth = Math.max(0, bracketDelta(value));
    inMultiline = openMultilineAfter(value, null);
    const key = parseTomlKey(kv[1]);
    if (!key) continue;
    const full = [...current, ...key];
    if (!isMembral(current)) {
      if (full[0] === "mcp_servers" && (full.length === 1 || full[1] === "membral")) {
        return {
          ok: false,
          reason: `line ${n + 1}: ${full.length === 1 ? "mcp_servers" : "mcp_servers.membral"} is set as a key, not a table`,
        };
      }
      continue;
    }
    const rel = full.slice(2);
    if (rel.length === 1 && current.length === 2 && OWNED_KEYS.has(rel[0])) remove[n] = true;
    else if (CONFLICT_KEYS.has(rel[0])) remove[n] = true;
    else if (HEADER_MAPS.has(rel[0])) {
      if (rel.length >= 2) remove[n] = rel[1].toLowerCase() === "authorization";
      else if (/authorization/i.test(value) || valueDepth > 0) {
        // An inline map: one entry cannot be removed line by line.
        return {
          ok: false,
          reason: `line ${n + 1}: mcp_servers.membral.${rel[0]} is an inline table; remove its Authorization entry by hand`,
        };
      }
    }
  }
  if (inMultiline) return { ok: false, reason: "an unterminated multi-line string" };

  const withEol = (l: string) => (eol === "\r\n" ? `${l}\r` : l);
  // A file ending in "\n" splits with a final "" element; never treat it as content.
  const endsWithNewline = existing.endsWith("\n");
  const body = endsWithNewline ? raw.slice(0, -1) : raw;
  const out: string[] = [];
  let lastIsOurs = false;
  if (mainHeaders.length === 0) {
    for (let n = 0; n < body.length; n++) if (!remove[n]) out.push(body[n]);
    const lastBlank = out.length === 0 || out[out.length - 1].replace(/\r$/, "").trim() === "";
    if (!lastBlank) out.push(withEol(""));
    out.push(...tableLines.map(withEol));
    return { ok: true, text: `${out.join("\n")}\n` };
  }
  for (let n = 0; n < body.length; n++) {
    if (remove[n]) continue;
    const unterminated = n === body.length - 1 && !endsWithNewline;
    out.push(n === mainHeaders[0] && unterminated ? withEol(body[n]) : body[n]);
    lastIsOurs = false;
    if (n === mainHeaders[0]) {
      // The header stays as written (quoted, commented); our keys go right under it.
      out.push(...tableLines.slice(1).map(withEol));
      lastIsOurs = true;
    }
  }
  return { ok: true, text: out.join("\n") + (endsWithNewline || lastIsOurs ? "\n" : "") };
}

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf-8");
  } catch (err) {
    if (isEnoent(err)) return undefined;
    throw err;
  }
}

async function writeIfChanged(
  path: string,
  existing: string | undefined,
  next: string,
  dryRun: boolean | undefined,
): Promise<CodexFileResult> {
  if (existing === next) return { path, outcome: "unchanged" };
  if (dryRun) return { path, outcome: "would-write" };
  await mkdir(dirname(path), { recursive: true });
  // No forced mode: an existing file keeps its own (writeFileAtomic).
  await writeFileAtomic(path, next);
  return { path, outcome: existing === undefined ? "created" : "updated" };
}

export async function installCodexMcp(opts: CodexSetupOptions): Promise<CodexFileResult> {
  const path = join(opts.codexHome ?? defaultCodexHome(), "config.toml");
  const invocation = opts.cliInvocation ?? resolveCliInvocation();
  const existing = await readIfExists(path);
  const merged = mergeCodexConfigToml(existing, buildCodexMcpTable(invocation, opts.apiUrl));
  if (!merged.ok) {
    return {
      path,
      outcome: "skipped",
      warning: `${path} left untouched (${merged.reason}); add [mcp_servers.membral] by hand.`,
    };
  }
  if (existing !== undefined && merged.text !== existing && !opts.dryRun) {
    // One snapshot of the user's file before Membral first changes it; never overwritten.
    try {
      await writeFile(`${path}.membral.bak`, existing, { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
    }
  }
  return writeIfChanged(path, existing, merged.text, opts.dryRun);
}

// --- hooks.json ------------------------------------------------------------------

interface CodexHookHandler {
  type: string;
  command?: string;
  [k: string]: unknown;
}
interface CodexMatcherGroup {
  matcher?: string;
  hooks?: CodexHookHandler[];
  [k: string]: unknown;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function buildCodexHookGroup(invocation: CliInvocation): CodexMatcherGroup {
  return {
    hooks: [
      {
        type: "command",
        command: `${quoteInvocation(invocation)} preamble --hook`,
        timeout: CODEX_PREAMBLE_TIMEOUT_SEC,
      },
    ],
  };
}

/** Ours: a `preamble --hook` command run through the Membral CLI (any install path). */
export function isMembralPreambleHandler(h: unknown, invocation: CliInvocation): boolean {
  if (!isObject(h) || typeof h.command !== "string") return false;
  const cmd = h.command;
  return cmd.includes("preamble --hook") && (cmd.includes(quoteInvocation(invocation)) || /membral/i.test(cmd));
}

type HooksMerge = { ok: true; text: string | undefined; warning?: string } | { ok: false; reason: string };

/** Merges our SessionStart group into a hooks.json body; other hooks and events are kept. */
export function mergeCodexHooksJson(existing: string | undefined, invocation: CliInvocation): HooksMerge {
  const ours = buildCodexHookGroup(invocation);
  if (existing === undefined || existing.trim() === "") {
    return { ok: true, text: `${JSON.stringify({ hooks: { SessionStart: [ours] } }, null, 2)}\n` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch {
    return { ok: false, reason: "not valid JSON" };
  }
  if (!isObject(parsed)) return { ok: false, reason: "not a JSON object" };
  if (parsed.hooks !== undefined && !isObject(parsed.hooks)) return { ok: false, reason: '"hooks" is not an object' };
  const hooks = (parsed.hooks as Record<string, unknown> | undefined) ?? {};
  const start = hooks.SessionStart ?? [];
  if (!Array.isArray(start) || !start.every((g) => isObject(g) && (g.hooks === undefined || Array.isArray(g.hooks)))) {
    return { ok: false, reason: '"hooks.SessionStart" is not a list of matcher groups' };
  }
  const groups = start as CodexMatcherGroup[];
  const before = JSON.stringify(groups);

  // Codex's trust key for a hook is `<file>:session_start:<group>:<handler>`
  // (codex-rs/hooks/src/lib.rs), so no foreign handler may change position:
  // our first handler is updated in place, and an extra Membral handler is
  // removed only when no foreign handler follows it in its group. A group
  // emptied that way stays (as `hooks: []`) unless only emptied groups follow.
  const ourHandler = ours.hooks?.[0] as CodexHookHandler;
  const mine = groups.flatMap((g, gi) =>
    (g.hooks ?? []).map((h, hi) => ({ gi, hi, h })).filter((x) => isMembralPreambleHandler(x.h, invocation)),
  );
  let next: CodexMatcherGroup[];
  let warning: string | undefined;
  if (mine.length === 0) {
    next = [...groups, ours];
  } else {
    const first = mine[0];
    let keptExtras = 0;
    const emptied = new Set<number>();
    next = groups.map((g, gi) => {
      if (!g.hooks) return g;
      const hooks = g.hooks.slice();
      for (let hi = hooks.length - 1; hi >= 0; hi--) {
        if (!isMembralPreambleHandler(hooks[hi], invocation)) continue;
        if (gi === first.gi && hi === first.hi) hooks[hi] = ourHandler;
        else if (hooks.slice(hi + 1).every((h) => isMembralPreambleHandler(h, invocation))) hooks.splice(hi, 1);
        else {
          hooks[hi] = ourHandler;
          keptExtras++;
        }
      }
      if (hooks.length === 0 && g.hooks.length > 0) emptied.add(gi);
      return { ...g, hooks };
    });
    while (next.length > 0 && emptied.has(next.length - 1)) next.pop();
    if (keptExtras > 0) {
      warning = `${keptExtras} extra Membral SessionStart hook(s) left in place so your other hooks keep their trust; remove the duplicates by hand.`;
    }
  }
  if (JSON.stringify(next) === before) return { ok: true, text: undefined, warning };
  return {
    ok: true,
    text: `${JSON.stringify({ ...parsed, hooks: { ...hooks, SessionStart: next } }, null, 2)}\n`,
    warning,
  };
}

export async function installCodexHooks(opts: Omit<CodexSetupOptions, "apiUrl">): Promise<CodexFileResult> {
  const path = join(opts.codexHome ?? defaultCodexHome(), "hooks.json");
  const invocation = opts.cliInvocation ?? resolveCliInvocation();
  const existing = await readIfExists(path);
  const merged = mergeCodexHooksJson(existing, invocation);
  if (!merged.ok) {
    return { path, outcome: "skipped", warning: `${path} left untouched (${merged.reason}); add the hook by hand.` };
  }
  const warning = merged.warning ? { warning: merged.warning } : {};
  if (merged.text === undefined) return { path, outcome: "unchanged", ...warning };
  return { ...(await writeIfChanged(path, existing, merged.text, opts.dryRun)), ...warning };
}

// --- AGENTS.md -------------------------------------------------------------------

/** The one recall-vs-state rule every agent surface states (@membral/core agent-guidance.ts). */
export const AGENTS_BLOCK = `${AGENTS_BEGIN}
${RECALL_VS_STATE_FULL}
${AGENTS_END}`;

/** Inserts or replaces the marked block; the rest of the file is kept byte for byte. Null: a begin marker with no end. */
export function mergeAgentsMd(existing: string | undefined): string | null {
  if (existing === undefined || existing === "") return `${AGENTS_BLOCK}\n`;
  const eol = existing.includes("\r\n") ? "\r\n" : "\n";
  const block = AGENTS_BLOCK.split("\n").join(eol);
  const begin = existing.indexOf(AGENTS_BEGIN);
  const end = begin < 0 ? -1 : existing.indexOf(AGENTS_END, begin);
  if (begin >= 0 && end >= 0) {
    return existing.slice(0, begin) + block + existing.slice(end + AGENTS_END.length);
  }
  if (begin >= 0) return null;
  const sep = existing.endsWith(`${eol}${eol}`) ? "" : existing.endsWith(eol) ? eol : `${eol}${eol}`;
  return `${existing}${sep}${block}${eol}`;
}

export async function installCodexAgentsMd(opts: Omit<CodexSetupOptions, "apiUrl">): Promise<CodexFileResult> {
  const path = join(opts.codexHome ?? defaultCodexHome(), "AGENTS.md");
  const existing = await readIfExists(path);
  const next = mergeAgentsMd(existing);
  if (next === null) {
    return { path, outcome: "skipped", warning: `${path} left untouched (${AGENTS_BEGIN} has no ${AGENTS_END}).` };
  }
  return writeIfChanged(path, existing, next, opts.dryRun);
}

// --- all three -----------------------------------------------------------------

/** `codex --version`, or null when codex is not on PATH or the call fails (3 s cap). */
async function readCodexVersion(): Promise<string | null> {
  if (!(await onPath("codex", process.env, process.platform))) return null;
  return new Promise((resolve) => {
    try {
      execFile("codex", ["--version"], { timeout: 3000, shell: process.platform === "win32" }, (err, stdout) =>
        resolve(err ? null : String(stdout)),
      );
    } catch {
      resolve(null);
    }
  });
}

/** A one-line warning when `versionOutput` names a Codex older than CODEX_MIN_VERSION; undefined when newer or unreadable. */
export function codexVersionWarning(versionOutput: string | null | undefined): string | undefined {
  const m = versionOutput ? /(\d+)\.(\d+)\.(\d+)/.exec(versionOutput) : null;
  if (!m) return undefined;
  const have = m.slice(1, 4).map(Number);
  const need = CODEX_MIN_VERSION.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i] > need[i]) return undefined;
    if (have[i] < need[i]) {
      return `Codex ${m[0]} is older than ${CODEX_MIN_VERSION}, which Membral's MCP auth needs (http_headers_helper setting Authorization); upgrade Codex or memory_search fails with 401.`;
    }
  }
  return undefined;
}

export async function setupCodex(opts: CodexSetupOptions): Promise<CodexSetupResult> {
  const invocation = opts.cliInvocation ?? resolveCliInvocation();
  const o = { ...opts, cliInvocation: invocation };
  const version = opts.codexVersion !== undefined ? opts.codexVersion : await readCodexVersion().catch(() => null);
  return {
    mcp: await installCodexMcp(o),
    hooks: await installCodexHooks(o),
    agents: await installCodexAgentsMd(o),
    invocationWarning: invocation.fallbackWarning,
    versionWarning: codexVersionWarning(version),
  };
}
