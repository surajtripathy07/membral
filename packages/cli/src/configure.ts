import { execFile } from "node:child_process";
import { realpathSync as nodeRealpathSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { DEFAULT_API_URL } from "./code-session-upload.js";
import { resolveApiKey as resolveCredentialApiKey, resolveApiUrl as resolveCredentialApiUrl } from "./credentials.js";

export interface ConfigureResult {
  success: boolean;
  message: string;
  /** Claude Desktop/Cursor: an existing `membral` entry pointed at another server or key and was rewritten. */
  repointed?: boolean;
  /** Claude Desktop/Cursor with `onlyExisting`: the config has no `membral` entry, so nothing was written. */
  skipped?: boolean;
}

// --- SessionEnd hook (ADR 0021 Q1/P1b) -------------------------------------
//
// `install-session-hook` writes a Claude Code SessionEnd hook entry into
// ~/.claude/settings.json (or --settings <path>). This reuses the same
// read-JSON-fallback-to-empty / merge / write pattern as
// configureMCPServer above rather than forking it into a new file.
//
// SECURITY: the hook COMMAND STRING must never embed the API key —
// settings.json is a project file that often ends up committed to source
// control. The key is resolved at hook run time instead, through the same
// shared credentials.ts resolver every other command uses (issue #136):
// MEMBRAL_API_KEY env var if set, else falling back to
// ~/.membral/credentials.json (see session-end-hook.ts ->
// import-session.ts's resolveUploadConfig).
//
// Profiles (local <-> prod switch): the command no longer embeds --api-url
// either. The URL is resolved at hook run time the same way as the key
// (flag > env > the ACTIVE profile in credentials.json), so `membral use
// <profile>` re-points every hook without touching settings.json. An older
// entry that still carries `--api-url <url>` has the same marker, differs
// from the new command, and is rewritten by the "Updated" path below.
// P10 review M-fix: these used to be "@membral/cli session-end-hook" /
// "@membral/cli preamble --hook", matching only the old `npx -y @membral/cli
// ...` command shape. The marker is now just the subcommand tail, which is a
// substring of BOTH the old npx-based command and the new direct-invocation
// command built by buildSessionHookCommand/buildPreambleHookCommand below —
// so a pre-existing npx entry is found and migrated (see the
// existingGroupIdx/"Updated" path in configureCommandHook) instead of being
// left in place or duplicated.
const SESSION_HOOK_MARKER = "session-end-hook";
/**
 * `timeout` (seconds) on the SessionEnd entry (#334). Without it Claude Code
 * gives SessionEnd hooks a shared 1.5 s budget on exit and cancels the hook.
 * The hook itself hands the upload to a detached child and returns in well
 * under a second; this is headroom for a slow node start, not upload time.
 */
export const SESSION_END_HOOK_TIMEOUT_SEC = 10;
// P4 (memory-on-prod-new-user goal): the SessionStart counterpart, installed
// alongside SessionEnd by the same `installSessionHook` call in setup.ts —
// runs `preamble --hook` to inject the memory preamble as additionalContext
// at the start of every session.
const PREAMBLE_HOOK_MARKER = "preamble --hook";
// Prompt-time recall (docs/design/prompt-time-recall.md): the
// UserPromptSubmit entry, installed alongside the other two by the same
// `installSessionHook` call. `membral prompt-hook` answers in about 4 s or
// prints nothing; the timeout is headroom for a slow node start.
// Matched as the command's exact last word, never a substring: a user's own
// `~/.claude/hooks/user-prompt-hook.sh` is not ours to rewrite or remove.
const PROMPT_HOOK_MARKER = (command: string): boolean => /(?:^|\s)prompt-hook$/.test(command.trimEnd());
export const PROMPT_HOOK_TIMEOUT_SEC = 5;
// Stop hook (Lever 2): `session-end-hook --stop` uploads the still-open session's transcript so far.
// Own marker (exact tail) so it never matches, upgrades or removes the SessionEnd entry.
const STOP_HOOK_MARKER = (command: string): boolean => /(?:^|\s)session-end-hook --stop$/.test(command.trimEnd());
export const STOP_HOOK_TIMEOUT_SEC = 10;

interface HookEntry {
  type: string;
  command: string;
  [key: string]: unknown;
}

interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
  [key: string]: unknown;
}

export interface SessionHookOptions {
  remove?: boolean;
  /** Overrides the resolved node+entry invocation — tests only; see resolveCliInvocation. */
  cliInvocation?: CliInvocation;
}

// P10 review finding 2: `npx -y @membral/cli ...` re-resolves the package
// (a registry hit for an unversioned spec, plus npx/node startup) on EVERY
// session start. Resolve once, here, at setup/install time instead, and
// write the exact absolute command that will run at hook time.
export interface CliInvocation {
  /** argv[0]/argv[1..] to run, already absolute (or the bare `membral` PATH fallback). */
  argv: string[];
  /** Set when the npx-temp-cache fallback kicked in — surfaced to the user. */
  fallbackWarning?: string;
}

/**
 * Resolve the exact command this running CLI process should be invoked with
 * later, from a hook. `process.execPath` is node's own absolute path;
 * `process.argv[1]` is the absolute path to the script that was run (the
 * `bin` entry, `dist/index.js`, whether installed globally, via npx with a
 * pinned version, or run from a workspace checkout).
 *
 * npx run WITHOUT a persistent global install extracts the package into a
 * temp cache directory (path contains `_npx` on npm's npx) that npx may
 * later evict — writing that path into settings.json would eventually point
 * at nothing. Detect that shape and fall back to the bare `membral` name,
 * resolved from PATH at hook-run time instead, with a warning so setup can
 * tell the user to `npm install -g @membral/cli` (or otherwise get `membral`
 * on PATH) for hooks to keep working.
 */
// B3 (P6 local rehearsal): a Homebrew-installed node's `process.execPath` is
// a VERSIONED Cellar path (/opt/homebrew/Cellar/node/26.8.1/bin/node) —
// `brew upgrade node` removes that exact directory, so a hook command
// pinning it breaks silently the next time it runs. Homebrew always keeps
// `bin/node` as a symlink into the current Cellar version, so these two
// well-known locations resolve to whatever the "current" node actually is;
// if either one's realpath matches the Cellar path we resolved, it's the
// stable alias to write into the hook command instead.
const HOMEBREW_STABLE_NODE_CANDIDATES = ["/opt/homebrew/bin/node", "/usr/local/bin/node"];
// Same idea for the CLI's own bin entry, in the rarer case it's ALSO
// resolved to a Cellar-versioned path — npm global installs under Homebrew
// normally live under /opt/homebrew/lib/node_modules (a plain, unversioned
// directory — verified stable across a `brew upgrade node`), so this
// candidate list is defense in depth, not the common case.
const HOMEBREW_STABLE_CLI_CANDIDATES = ["/opt/homebrew/bin/membral", "/usr/local/bin/membral"];

// nvm installs each node version under a version-numbered directory too
// (~/.nvm/versions/node/vX.Y.Z/bin/node), but unlike Homebrew there is no
// stable alias path to substitute — nvm's "current" symlink is a shell-PATH
// concept (nvm's own `alias default`/`.nvmrc`), not a fixed filesystem
// location every install shares. The absolute path stays as resolved
// (correct until the user switches versions); setup instead prints a note
// that a version switch means re-running `membral setup`.
const NVM_NODE_PATH_RE = /\/\.nvm\/versions\/node\//;

/** True when `candidatePath` exists and its realpath is exactly `actualPath` — i.e. it's a stable alias for it. */
function isStableAliasFor(
  actualPath: string,
  candidatePath: string,
  realpathSyncFn: (path: string) => string,
): boolean {
  try {
    return realpathSyncFn(candidatePath) === actualPath;
  } catch {
    return false; // candidate doesn't exist (or isn't resolvable) on this machine
  }
}

function findStableAlias(
  actualPath: string,
  candidates: string[],
  realpathSyncFn: (path: string) => string,
): string | undefined {
  return candidates.find((candidate) => isStableAliasFor(actualPath, candidate, realpathSyncFn));
}

export interface ResolveCliInvocationOptions {
  execPath?: string;
  entryPath?: string;
  /** Injectable for tests — defaults to node:fs's realpathSync (never called for a non-Cellar path). */
  realpathSync?: (path: string) => string;
}

export function resolveCliInvocation(opts: ResolveCliInvocationOptions = {}): CliInvocation {
  let execPath = opts.execPath ?? process.execPath;
  let entryPath = opts.entryPath ?? process.argv[1];
  const realpathSyncFn = opts.realpathSync ?? nodeRealpathSync;

  if (!entryPath || entryPath.includes("_npx")) {
    return {
      argv: ["membral"],
      fallbackWarning:
        "  NOTE: running via npx from a temporary cache — the hook command was written as\n" +
        '  "membral" (resolved from PATH each time the hook runs) instead of a path inside\n' +
        "  the npx cache, which npx may delete. Run `npm install -g @membral/cli` (or\n" +
        "  otherwise put `membral` on PATH) so the hook keeps working.",
    };
  }

  let versionSwitchNote: string | undefined;

  if (execPath.includes("/Cellar/")) {
    const stable = findStableAlias(execPath, HOMEBREW_STABLE_NODE_CANDIDATES, realpathSyncFn);
    if (stable) execPath = stable;
  } else if (NVM_NODE_PATH_RE.test(execPath)) {
    versionSwitchNote =
      "  NOTE: node was resolved via nvm — the hook command pins this exact Node version's\n" +
      "  path. Switching Node versions (`nvm use ...`) requires re-running `membral setup`\n" +
      "  (or `membral install-session-hook`) so the hook is rewritten to point at it.";
  }

  if (entryPath.includes("/Cellar/")) {
    const stable = findStableAlias(entryPath, HOMEBREW_STABLE_CLI_CANDIDATES, realpathSyncFn);
    if (stable) entryPath = stable;
  }

  return { argv: [execPath, entryPath], fallbackWarning: versionSwitchNote };
}

function quoteArgv(argv: string[]): string {
  return argv.map(shellQuote).join(" ");
}

/** Shell-quoted `<node> <entry>` prefix — shared with the opencode plugin and the sweep agent so all three run the same stable CLI. */
export function quoteInvocation(invocation: CliInvocation): string {
  return quoteArgv(invocation.argv);
}

function buildSessionHookCommand(invocation: CliInvocation): string {
  return `${quoteArgv(invocation.argv)} session-end-hook`;
}

function buildPreambleHookCommand(invocation: CliInvocation): string {
  return `${quoteArgv(invocation.argv)} preamble --hook`;
}

function buildStopHookCommand(invocation: CliInvocation): string {
  return `${quoteArgv(invocation.argv)} session-end-hook --stop`;
}

function buildPromptHookCommand(invocation: CliInvocation): string {
  return `${quoteArgv(invocation.argv)} prompt-hook`;
}

// Hook commands run through a shell (we don't use the "args" exec-form
// field), so the value must be shell-safe. Double-quote wrapping with
// escaping of the characters a double-quoted shell string treats specially
// is sufficient for URLs.
function shellQuote(value: string): string {
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** A substring of our command (the two older hooks), or an exact matcher (the prompt hook). */
type HookMarker = string | ((command: string) => boolean);

function hasMarker(hook: HookEntry, marker: HookMarker): boolean {
  if (typeof hook.command !== "string") return false;
  return typeof marker === "string" ? hook.command.includes(marker) : marker(hook.command);
}

// N-m3 (P10 re-review): distinguishes "file doesn't exist" from any other
// read failure (permission denied, a symlink to a missing target, an I/O
// error, ...). Only ENOENT means "nothing to back up, start fresh" — every
// other error must abort the same way a parse error does (see the readFile
// catch in configureCommandHook below), never be silently treated as missing.
export function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

/** True when `path` itself is a symlink (lstat, so a broken link counts). False when nothing is there. */
export async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Shared read-merge-write for a single Claude Code hook event array in
 * settings.json — SessionEnd (session-end-hook) and SessionStart
 * (preamble --hook) are both a single "always run this command" entry, so
 * they share this exact idempotency/removal logic; only the event name,
 * the marker that identifies "our" entry, the command to write, and the
 * label used in messages differ.
 */
async function configureCommandHook(
  settingsPath: string,
  eventName: "SessionEnd" | "SessionStart" | "UserPromptSubmit" | "Stop",
  marker: HookMarker,
  label: string,
  opts: SessionHookOptions,
  buildCommand: (invocation: CliInvocation) => string,
  /** Extra fields every Membral entry for this event must carry (e.g. `timeout`); an old entry without them is upgraded. */
  entryExtras: Record<string, unknown> = {},
): Promise<ConfigureResult> {
  try {
    let settings: Record<string, unknown> = {};
    // P10 review M5: distinct from a missing file (start from {}) — an
    // EXISTING file that fails to parse must be left untouched, not
    // silently replaced (that used to drop the user's permissions/env/other
    // hooks). `originalContent` is also this write's backup source below.
    let originalContent: string | undefined;

    try {
      originalContent = await readFile(settingsPath, "utf-8");
    } catch (readErr) {
      if (!isEnoent(readErr)) {
        // N-m3: a non-ENOENT failure (permission denied, a symlink to a
        // missing/unreadable target, ...) is NOT "missing" — treating it as
        // missing would overwrite whatever is actually there once we write.
        // Abort the same way the parse-error branch below does.
        const msg = readErr instanceof Error ? readErr.message : String(readErr);
        return {
          success: false,
          message:
            `Could not read ${settingsPath} (${msg}) — left it untouched.\n` +
            `  The Membral ${label} hook was NOT installed. Fix the underlying issue (e.g.\n` +
            "  file permissions, or a broken symlink), then re-run `membral install-session-hook`\n" +
            "  (or `membral setup`).",
        };
      }
      // P10 round 3 R3-m3: a symlink whose target is missing also reads as
      // ENOENT. It is not "missing": writing would replace the link with a
      // plain file and cut the user's dotfiles link. Abort like the other
      // unreadable cases.
      if (await isSymlink(settingsPath)) {
        return {
          success: false,
          message:
            `${settingsPath} is a symlink to a missing file — left it untouched.\n` +
            `  The Membral ${label} hook was NOT installed. Restore the link's target (or\n` +
            "  remove the broken link), then re-run `membral install-session-hook`\n" +
            "  (or `membral setup`).",
        };
      }
      // Missing file — start fresh, nothing to back up.
      originalContent = undefined;
    }

    if (originalContent !== undefined) {
      try {
        settings = JSON.parse(originalContent);
      } catch (parseErr) {
        const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
        return {
          success: false,
          message:
            `Could not parse ${settingsPath} as JSON (${msg}) — left it untouched.\n` +
            `  The Membral ${label} hook was NOT installed. Fix the file's JSON (e.g. a\n` +
            "  trailing comma or a comment — settings.json must be strict JSON), then re-run\n" +
            "  `membral install-session-hook` (or `membral setup`).",
        };
      }
    }

    const hooks = { ...(settings.hooks as Record<string, unknown> | undefined) };
    const groups: HookGroup[] = Array.isArray(hooks[eventName]) ? (hooks[eventName] as HookGroup[]) : [];

    if (opts.remove) {
      let removedAny = false;
      const remaining: HookGroup[] = [];
      for (const group of groups) {
        const filteredHooks = (group.hooks ?? []).filter((h) => {
          const isOurs = hasMarker(h, marker);
          if (isOurs) removedAny = true;
          return !isOurs;
        });
        if (filteredHooks.length > 0) remaining.push({ ...group, hooks: filteredHooks });
      }

      if (!removedAny) {
        return { success: true, message: `No Membral ${label} hook found in ${settingsPath} — nothing to remove` };
      }

      if (remaining.length > 0) {
        hooks[eventName] = remaining;
      } else {
        delete hooks[eventName];
      }

      if (Object.keys(hooks).length > 0) {
        settings.hooks = hooks;
      } else {
        delete settings.hooks;
      }

      await writeSettingsFile(settingsPath, settings, originalContent);
      return { success: true, message: `Removed Membral ${label} hook from: ${settingsPath}` };
    }

    const invocation = opts.cliInvocation ?? resolveCliInvocation();
    const command = buildCommand(invocation);
    const fallbackNote = invocation.fallbackWarning ? `\n${invocation.fallbackWarning}` : "";

    let existingGroupIdx = -1;
    let existingHookIdx = -1;
    for (let gi = 0; gi < groups.length && existingGroupIdx < 0; gi++) {
      const hs = groups[gi].hooks ?? [];
      const hi = hs.findIndex((h) => hasMarker(h, marker));
      if (hi >= 0) {
        existingGroupIdx = gi;
        existingHookIdx = hi;
      }
    }

    if (existingGroupIdx >= 0) {
      const existing = groups[existingGroupIdx].hooks[existingHookIdx];
      // A numeric extra is a floor: a user's own larger value (e.g. `timeout: 30`) is kept.
      const extras: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(entryExtras)) {
        const mine = existing[k];
        extras[k] = typeof v === "number" && typeof mine === "number" && mine >= v ? mine : v;
      }
      const extrasMatch = Object.entries(extras).every(([k, v]) => existing[k] === v);
      if (existing.command === command && extrasMatch) {
        return { success: true, message: `Membral ${label} hook already installed in: ${settingsPath}` };
      }
      groups[existingGroupIdx].hooks[existingHookIdx] = { ...existing, command, ...extras };
      hooks[eventName] = groups;
      settings.hooks = hooks;
      await writeSettingsFile(settingsPath, settings, originalContent);
      return {
        success: true,
        message: `Updated Membral ${label} hook in: ${settingsPath}\n  Command: ${command}${fallbackNote}`,
      };
    }

    groups.push({ hooks: [{ type: "command", command, ...entryExtras }] });
    hooks[eventName] = groups;
    settings.hooks = hooks;

    await writeSettingsFile(settingsPath, settings, originalContent);

    return {
      success: true,
      message:
        `Installed ${eventName} hook in: ${settingsPath}\n` +
        `  Command: ${command}\n\n` +
        "  NOTE: MEMBRAL_API_KEY is deliberately NOT written into settings.json (that file is\n" +
        "  often committed to source control). The hook authenticates via\n" +
        "  ~/.membral/credentials.json instead, written by `membral login` or\n" +
        `  \`membral setup --api-key <key>\` — no shell setup needed. Exporting\n` +
        `  MEMBRAL_API_KEY in your shell environment only overrides that at ${eventName.toLowerCase()} time.` +
        fallbackNote,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to configure ${label} hook: ${msg}` };
  }
}

/**
 * Install or remove the Membral SessionEnd hook in a Claude Code
 * settings.json. Idempotent: running install twice updates/no-ops rather
 * than duplicating the entry; remove is a no-op (success) when nothing is
 * installed.
 */
export async function configureSessionEndHook(
  settingsPath: string,
  opts: SessionHookOptions = {},
): Promise<ConfigureResult> {
  return configureCommandHook(
    settingsPath,
    "SessionEnd",
    SESSION_HOOK_MARKER,
    "session-end",
    opts,
    buildSessionHookCommand,
    { timeout: SESSION_END_HOOK_TIMEOUT_SEC },
  );
}

/**
 * Install or remove the Membral SessionStart hook (P4, memory-on-prod-new-
 * user goal) in a Claude Code settings.json. Same idempotency/removal
 * behavior as configureSessionEndHook above, kept as a distinct exported
 * function (own event name/marker) so `install-session-hook.ts` can call it
 * independently of the SessionEnd hook.
 */
export async function configureSessionStartHook(
  settingsPath: string,
  opts: SessionHookOptions = {},
): Promise<ConfigureResult> {
  return configureCommandHook(
    settingsPath,
    "SessionStart",
    PREAMBLE_HOOK_MARKER,
    "session-start (preamble)",
    opts,
    buildPreambleHookCommand,
  );
}

/**
 * Install or remove the Membral UserPromptSubmit hook (prompt-time recall) in
 * a Claude Code settings.json. Same idempotency, upgrade and removal behaviour
 * as the two above; an older entry without the `timeout` floor is upgraded.
 */
export async function configureUserPromptSubmitHook(
  settingsPath: string,
  opts: SessionHookOptions = {},
): Promise<ConfigureResult> {
  return configureCommandHook(
    settingsPath,
    "UserPromptSubmit",
    PROMPT_HOOK_MARKER,
    "user-prompt-submit (prompt recall)",
    opts,
    buildPromptHookCommand,
    { timeout: PROMPT_HOOK_TIMEOUT_SEC },
  );
}

/**
 * Install or remove the Membral Stop hook (mid-session upload of the transcript so far) in a Claude
 * Code settings.json. Same idempotency, upgrade and removal behaviour as the hooks above. Its
 * marker is distinct from SessionEnd's, so the two never touch each other's entry.
 */
export async function configureStopHook(settingsPath: string, opts: SessionHookOptions = {}): Promise<ConfigureResult> {
  return configureCommandHook(
    settingsPath,
    "Stop",
    STOP_HOOK_MARKER,
    "stop (open-session upload)",
    opts,
    buildStopHookCommand,
    {
      timeout: STOP_HOOK_TIMEOUT_SEC,
    },
  );
}

export type McpClientId = "claude-desktop" | "claude-code" | "cursor" | "agy";

export interface ConfigureMCPOptions {
  apiUrl?: string;
  apiKey?: string;
  /** Overrides ~/.membral/credentials.json's default path — tests only. */
  credentialsPath?: string;
  /** Claude Code only: remove any existing `membral` entry first, then add (`membral use` re-points to another server). */
  replaceExisting?: boolean;
  /** Claude Desktop/Cursor only: rewrite an existing `membral` entry but never add one (`membral use`). */
  onlyExisting?: boolean;
}

const PLACEHOLDER_KEY = "YOUR_API_KEY";

// Issue #136: this used to be a PRIVATE resolver (`opts.apiUrl ??
// process.env.MEMBRAL_API_URL ?? DEFAULT_API_URL`, same shape for the key)
// that never looked at ~/.membral/credentials.json at all — so a machine
// that had only ever run `membral setup` (never manually exported
// MEMBRAL_API_KEY) got a placeholder key written into its MCP config even
// though a perfectly good key was sitting in credentials.json. Delegating
// to credentials.ts's shared resolveApiUrl/resolveApiKey (flag > env >
// credentials.json > default) fixes that and makes this the same resolver
// every other command uses.
function resolveApiUrl(opts: ConfigureMCPOptions): string {
  return resolveCredentialApiUrl(opts.apiUrl, process.env.MEMBRAL_API_URL, DEFAULT_API_URL, opts.credentialsPath);
}

function resolveApiKey(opts: ConfigureMCPOptions): { key: string; isPlaceholder: boolean } {
  const key = resolveCredentialApiKey(opts.apiKey, process.env.MEMBRAL_API_KEY, opts.credentialsPath);
  return key ? { key, isPlaceholder: false } : { key: PLACEHOLDER_KEY, isPlaceholder: true };
}

const NO_KEY_WARNING =
  "  NOTE: no API key was found (MEMBRAL_API_KEY unset, no --api-key passed) — the\n" +
  `  placeholder "${PLACEHOLDER_KEY}" was written instead of a real key. Generate one\n` +
  "  from the cloud dashboard (Settings → API Key → Generate API Key), then re-run\n" +
  "  setup with --api-key <key> (or export MEMBRAL_API_KEY) to replace it.\n";

// Recognizes the pre-#40 `{ command: "npx", args: [..., "@membral/mcp", ...] }`
// stdio entry this function used to write, so upgrades can rewrite it instead
// of treating it as "already configured" and leaving a dead reference to a
// binary that no longer exists.
function isLegacyMembralEntry(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return (
    e.command === "npx" &&
    Array.isArray(e.args) &&
    e.args.some((a) => typeof a === "string" && a.includes("@membral/mcp"))
  );
}

// A previous run wrote this with no API key available (MEMBRAL_API_KEY
// unset, no --api-key) and left the PLACEHOLDER_KEY baked in — that's a dead
// end otherwise (the entry looks "configured" so a later re-run with a real
// key would silently no-op forever). Any membral entry whose serialized form
// still contains the placeholder is replaceable.
function hasPlaceholderKey(entry: unknown): boolean {
  try {
    return JSON.stringify(entry).includes(PLACEHOLDER_KEY);
  } catch {
    return false;
  }
}

// Claude-desktop-only: the destructive bare `{ url, headers }` shape this
// whole fix eliminates (see buildMcpRemoteEntry) — anything pasted from the
// pre-fix README/dashboard has no "command" key and must be replaced, since
// Claude Desktop can't understand it at all.
function lacksCommandKey(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  return !("command" in (entry as Record<string, unknown>));
}

type WriteReason = "added" | "legacy" | "placeholder" | "old-shape" | "repointed";

function classifyExisting(existing: unknown, isOldShape: boolean, isStale: boolean): WriteReason {
  if (existing === undefined) return "added";
  if (hasPlaceholderKey(existing)) return "placeholder";
  if (isLegacyMembralEntry(existing)) return "legacy";
  if (isOldShape) return "old-shape";
  if (isStale) return "repointed";
  return "added";
}

interface EntryTarget {
  url?: string;
  authorization?: string;
}

/**
 * The server URL + Authorization value an entry points at, for both shapes
 * this file writes: Cursor's `{ url, headers.Authorization }` and Claude
 * Desktop's mcp-remote bridge (URL = the arg after "mcp-remote", auth = the
 * `env.MEMBRAL_AUTH_HEADER` value, or a literal `--header Authorization:…`).
 */
function entryTarget(entry: unknown): EntryTarget {
  if (!entry || typeof entry !== "object") return {};
  const e = entry as Record<string, unknown>;
  const target: EntryTarget = {};
  if (typeof e.url === "string") target.url = e.url;
  const headers = e.headers as Record<string, unknown> | undefined;
  if (headers && typeof headers.Authorization === "string") target.authorization = headers.Authorization;
  if (Array.isArray(e.args)) {
    const args = e.args;
    const i = args.indexOf("mcp-remote");
    if (i >= 0 && typeof args[i + 1] === "string") target.url = args[i + 1] as string;
    const h = args.indexOf("--header");
    const header = h >= 0 ? args[h + 1] : undefined;
    if (typeof header === "string" && header.startsWith("Authorization:") && !header.includes("${")) {
      target.authorization = header.slice("Authorization:".length).trim();
    }
  }
  const env = e.env as Record<string, unknown> | undefined;
  if (env && typeof env.MEMBRAL_AUTH_HEADER === "string") target.authorization = env.MEMBRAL_AUTH_HEADER;
  return target;
}

function normalizeUrl(url: string | undefined): string | undefined {
  return url?.trim().replace(/\/+$/, "");
}

/**
 * An entry is stale when the URL or Authorization it carries differs from
 * what this run would write (e.g. still on another server while the
 * active profile is http://localhost:3000). An entry we can't read either
 * field from is a hand-written custom shape — left alone.
 */
function isStaleEntry(existing: unknown, wanted: Record<string, unknown>): boolean {
  const have = entryTarget(existing);
  if (have.url === undefined && have.authorization === undefined) return false;
  const want = entryTarget(wanted);
  return normalizeUrl(have.url) !== normalizeUrl(want.url) || have.authorization !== want.authorization;
}

/**
 * Read-merge-write a `mcpServers.membral` entry into a client's JSON config
 * file. Shared by Claude Desktop and Cursor (Claude Code doesn't use a file
 * — see `configureClaudeCodeCli` below). Early-returns "already configured"
 * for a genuine current-shape entry with a real key; a legacy pre-#40 stdio
 * entry, a previously-written placeholder-key entry, or (via `extraReplaceable`)
 * a client-specific stale shape is rewritten instead.
 */
async function writeJsonMcpEntry(
  configPath: string,
  entry: Record<string, unknown>,
  successMessage: (reason: WriteReason) => string,
  extraReplaceable?: (existing: unknown) => boolean,
  onlyExisting = false,
): Promise<ConfigureResult> {
  try {
    let config: Record<string, unknown> = {};
    let originalContent: string | undefined;

    try {
      originalContent = await readFile(configPath, "utf-8");
      config = JSON.parse(originalContent);
    } catch {
      // File doesn't exist or isn't valid JSON — start fresh (an unreadable
      // file's raw content is still backed up below before it's replaced)
    }

    const mcpServers = (config.mcpServers ?? {}) as Record<string, unknown>;
    const existing = mcpServers.membral;

    if (existing === undefined && onlyExisting) {
      return {
        success: true,
        skipped: true,
        message: "no Membral MCP entry — skipped (run `membral setup` to add one)",
      };
    }

    const isOldShape = existing !== undefined && (extraReplaceable?.(existing) ?? false);
    // No real key resolvable → never swap a working entry for a placeholder one.
    const isStale = existing !== undefined && !hasPlaceholderKey(entry) && isStaleEntry(existing, entry);
    const replaceable =
      existing === undefined || hasPlaceholderKey(existing) || isLegacyMembralEntry(existing) || isOldShape || isStale;

    if (!replaceable) {
      return { success: true, message: "MCP server already configured" };
    }

    mcpServers.membral = entry;
    config.mcpServers = mcpServers;

    await ensureParentDir(configPath);
    // M3 (adversarial round 1 on #136): this file carries a raw API key —
    // buildMcpRemoteEntry's/buildUrlHeadersEntry's own doc comments already
    // call that out as the reason the key is inlined here at all — so it
    // gets the same 0600 treatment as ~/.membral/credentials.json (which
    // already writes 0600) instead of the platform-default (often world-
    // readable) mode — also when a PRE-#136 run left it at the default mode
    // and this run only rewrites it. The backup holds the previous key, so it
    // gets 0600 too; both writes are atomic (tmp + rename).
    if (originalContent !== undefined) {
      await writeFileAtomic(`${configPath}.membral.bak`, originalContent, 0o600);
    }
    await writeFileAtomic(configPath, JSON.stringify(config, null, 2) + "\n", 0o600);

    const reason = classifyExisting(existing, isOldShape, isStale);
    const previousUrl = reason === "repointed" ? entryTarget(existing).url : undefined;
    return {
      success: true,
      message: successMessage(reason) + (previousUrl ? `\n  (was ${previousUrl})` : ""),
      ...(reason === "repointed" ? { repointed: true } : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, message: `Failed to configure MCP server: ${msg}` };
  }
}

function describeReason(reason: WriteReason): string {
  switch (reason) {
    case "legacy":
      return "Migrated (was the old stdio @membral/mcp entry)";
    case "placeholder":
      return "Replaced placeholder-key entry with";
    case "old-shape":
      return "Replaced (was the old bare url-shape entry — the exact destructive shape this fix eliminates)";
    case "repointed":
      return "Re-pointed to the active server";
    default:
      return "Added";
  }
}

/**
 * Claude Desktop's config schema is the stdio command+args shape — it does
 * NOT recognize a bare `{ url, headers }` entry, and silently drops the
 * entire `mcpServers` key when it hits one it doesn't understand (verified
 * destructive-shape regression; see #40 adversarial review). Bridge via
 * `mcp-remote` instead, using its documented env-var-expansion convention:
 * the header ARG is the literal string `Authorization:${MEMBRAL_AUTH_HEADER}`
 * (mcp-remote expands that itself, at connect time, from its OWN env — not
 * the shell's), and the actual `Bearer <key>` value goes in this entry's
 * `env` block, which Claude Desktop passes to the child process it spawns.
 *
 * The key is inlined here (unlike configureSessionEndHook's settings.json,
 * which often IS committed to source control and must never carry one):
 * claude_desktop_config.json is user-local, never committed, and Claude
 * Desktop is a GUI app that does not inherit the shell's exported env vars —
 * a var-reference alone can't resolve to anything for it.
 */
function buildMcpRemoteEntry(mcpUrl: string, apiKey: string): Record<string, unknown> {
  return {
    command: "npx",
    args: ["-y", "mcp-remote", mcpUrl, "--header", `Authorization:\${MEMBRAL_AUTH_HEADER}`],
    env: { MEMBRAL_AUTH_HEADER: `Bearer ${apiKey}` },
  };
}

async function configureClaudeDesktop(configPath: string, opts: ConfigureMCPOptions): Promise<ConfigureResult> {
  const mcpUrl = `${resolveApiUrl(opts)}/api/mcp`;
  const { key, isPlaceholder } = resolveApiKey(opts);
  const entry = buildMcpRemoteEntry(mcpUrl, key);

  return writeJsonMcpEntry(
    configPath,
    entry,
    (reason) =>
      `${describeReason(reason)} in: ${configPath}\n` +
      "  Bridged via mcp-remote (Claude Desktop doesn't speak Streamable HTTP\n" +
      '  natively) — the key is inlined in this entry\'s "env" block, see the code\n' +
      "  comment on buildMcpRemoteEntry for why that's the right call here.\n" +
      (isPlaceholder ? NO_KEY_WARNING : "") +
      "  Restart Claude Desktop to pick up the change.",
    lacksCommandKey,
    opts.onlyExisting,
  );
}

/**
 * Cursor's `~/.cursor/mcp.json` (NOT `settings.json` — that was a bug fixed
 * alongside this one) reads the `{ url, headers }` shape natively, no bridge
 * needed. The key is inlined for the same reason as Claude Desktop: this
 * file is user-local and not committed, and Cursor does not expand a bare
 * `${VAR}` reference here (its `${env:VAR}` support is inconsistent across
 * versions) — a literal value is the only shape that reliably works.
 */
function buildUrlHeadersEntry(mcpUrl: string, apiKey: string): Record<string, unknown> {
  return {
    url: mcpUrl,
    headers: { Authorization: `Bearer ${apiKey}` },
  };
}

async function configureCursor(configPath: string, opts: ConfigureMCPOptions): Promise<ConfigureResult> {
  const mcpUrl = `${resolveApiUrl(opts)}/api/mcp`;
  const { key, isPlaceholder } = resolveApiKey(opts);
  const entry = buildUrlHeadersEntry(mcpUrl, key);

  return writeJsonMcpEntry(
    configPath,
    entry,
    (reason) =>
      `${describeReason(reason)} in: ${configPath}\n` +
      (isPlaceholder ? NO_KEY_WARNING : "") +
      "  Restart Cursor (or reload the window) to pick up the change.",
    undefined,
    opts.onlyExisting,
  );
}

function isCommandNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT";
}

function execFileP(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Claude Code has no `mcpServers` key in `~/.claude/settings.json` — that
 * file is for hooks/permissions, not MCP servers (writing one there was a
 * dead no-op that also risked clobbering real settings; see #40 adversarial
 * review). Its actual MCP config is owned by the `claude` CLI itself via
 * `claude mcp add`, so we shell out to that instead of writing any file —
 * or print the exact command for the user to run if `claude` isn't on PATH.
 *
 * `--scope user` is required: `claude mcp add` defaults to project-local
 * scope, which would silently wire Membral into whatever directory `setup`
 * happened to run from instead of the user's Claude Code config everywhere.
 *
 * `claude mcp add-json` exits non-zero if an entry named "membral" already
 * exists (e.g. a prior run with a placeholder key, or a stale URL) — that
 * would otherwise make a re-run with a real key report failure forever, so
 * on any non-ENOENT failure we retry once via `claude mcp remove` + re-add.
 */
async function configureClaudeCodeCli(opts: ConfigureMCPOptions): Promise<ConfigureResult> {
  const mcpUrl = `${resolveApiUrl(opts)}/api/mcp`;
  const { key, isPlaceholder } = resolveApiKey(opts);
  // add-json (not `add`): only it can set `alwaysLoad`, which keeps Claude
  // Code from deferring Membral's tools behind ToolSearch (deferred, agents
  // made 0 Membral calls in testing; always-loaded, they searched first).
  const entryJson = JSON.stringify({
    type: "http",
    url: mcpUrl,
    headers: { Authorization: `Bearer ${key}` },
    alwaysLoad: true,
  });
  const addArgs = ["mcp", "add-json", "membral", entryJson, "--scope", "user"];
  const removeArgs = ["mcp", "remove", "membral", "--scope", "user"];
  // Older `claude` binaries have no `add-json`; `add` works everywhere but cannot set alwaysLoad.
  const legacyAddArgs = [
    "mcp",
    "add",
    "--transport",
    "http",
    "membral",
    mcpUrl,
    "--header",
    `Authorization: Bearer ${key}`,
    "--scope",
    "user",
  ];
  const commandLine = `claude mcp add-json membral '${entryJson}' --scope user`;
  // Success messages land in terminals and logs: show only the key prefix there.
  const maskedLine = isPlaceholder ? commandLine : commandLine.replace(key, `${key.slice(0, 8)}…`);

  const placeholderNote = isPlaceholder
    ? "  NOTE: no API key was found — the command above used a placeholder. Generate a\n" +
      "  key from the cloud dashboard, then re-run with --api-key <key> (or export\n" +
      "  MEMBRAL_API_KEY) so the real key gets passed to `claude mcp add`.\n"
    : "";

  if (opts.replaceExisting) {
    try {
      await execFileP("claude", removeArgs);
    } catch (err) {
      if (isCommandNotFound(err)) {
        return {
          success: true,
          message: `Claude Code CLI ("claude") not found on PATH — run this yourself:\n  ${commandLine}\n${placeholderNote}`,
        };
      }
      // Nothing to remove — fine, the add below creates it.
    }
  }

  try {
    await execFileP("claude", addArgs);
    return { success: true, message: `Configured Claude Code via: ${maskedLine}\n${placeholderNote}` };
  } catch (err) {
    if (isCommandNotFound(err)) {
      return {
        success: true,
        message: `Claude Code CLI ("claude") not found on PATH — run this yourself:\n  ${commandLine}\n${placeholderNote}`,
      };
    }

    // Most likely cause: an entry named "membral" already exists (a prior
    // run, possibly with a placeholder key). Replace it rather than leaving
    // the user stuck re-running the same failing command forever.
    try {
      await execFileP("claude", removeArgs);
      await execFileP("claude", addArgs);
      return {
        success: true,
        message:
          "Replaced existing Claude Code MCP entry via: claude mcp remove membral --scope user, then " +
          `${maskedLine}\n${placeholderNote}`,
      };
    } catch (retryErr) {
      // Likely a `claude` too old for add-json, and the entry may already be removed: restore a working
      // entry with the older `add` form rather than leaving the user with none.
      try {
        await execFileP("claude", legacyAddArgs);
        return {
          success: true,
          message:
            "Configured Claude Code via: claude mcp add --transport http membral (this `claude` has no " +
            "`mcp add-json`, so alwaysLoad could not be set; update Claude Code and re-run setup so Membral's " +
            `tools are not deferred behind ToolSearch).\n${placeholderNote}`,
        };
      } catch (legacyErr) {
        const originalMsg = err instanceof Error ? err.message : String(err);
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        const legacyMsg = legacyErr instanceof Error ? legacyErr.message : String(legacyErr);
        return {
          success: false,
          message:
            `claude mcp add failed (${originalMsg}); retried via remove + re-add, which also failed: ${retryMsg}; ` +
            `the older \`claude mcp add\` form failed too: ${legacyMsg}\n` +
            `  Run manually: ${commandLine}\n${placeholderNote}`,
        };
      }
    }
  }
}

/**
 * Add the Membral MCP server to a Claude Desktop, Claude Code, or Cursor
 * client, using whatever shape that client actually understands (#40 +
 * adversarial-review fix: an earlier version of this emitted one generic
 * `{ url, headers }` shape for all three, which is destructive on Claude
 * Desktop — see buildMcpRemoteEntry's comment).
 */
export async function configureMCPServer(
  clientId: McpClientId,
  configPath: string,
  opts: ConfigureMCPOptions = {},
): Promise<ConfigureResult> {
  switch (clientId) {
    case "claude-desktop":
      return configureClaudeDesktop(configPath, opts);
    case "cursor":
      return configureCursor(configPath, opts);
    case "claude-code":
      return configureClaudeCodeCli(opts);
    case "agy":
      return configureAgyMcp(configPath, opts);
    default:
      return { success: false, message: `Unknown MCP client: ${clientId}` };
  }
}

async function ensureParentDir(filePath: string): Promise<void> {
  const { dirname } = await import("node:path");
  await mkdir(dirname(filePath), { recursive: true });
}

// N-m3 (P10 re-review): if `path` is a symlink (e.g. a dotfiles-managed
// ~/.claude/settings.json), a plain `rename(tmp, path)` replaces the SYMLINK
// itself with a plain file — silently cutting the link — and the tmp file's
// fresh default mode replaces whatever mode the real target had. Resolve
// through the link first so the write lands on the real target (the symlink
// stays intact) and the target's existing mode carries over. A path that
// doesn't exist yet has nothing to resolve/preserve, so the write proceeds
// as before. A broken link (realpath fails) throws rather than being
// replaced by a plain file (P10 round 3 R3-m3).
async function resolveAtomicTarget(path: string): Promise<{ target: string; mode?: number }> {
  let target = path;
  if (await isSymlink(path)) {
    target = await realpath(path);
  }

  try {
    const st = await stat(target);
    return { target, mode: st.mode & 0o777 };
  } catch {
    return { target };
  }
}

// Atomic write (tmp file + rename), same convention as sweep.ts's
// writeSweepState. Used for both the backup file and the real write below so
// neither can land as a partial/torn file on a crash mid-write.
// `forceMode` (e.g. 0o600 for a file holding an API key) wins over the
// target's existing mode, and the tmp file is CREATED at it so the content is
// never briefly readable at a looser mode.
export async function writeFileAtomic(path: string, content: string, forceMode?: number): Promise<void> {
  const { target, mode: existingMode } = await resolveAtomicTarget(path);
  const mode = forceMode ?? existingMode;
  const tmpPath = `${target}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmpPath, content, mode === undefined ? "utf-8" : { encoding: "utf-8", mode });
  if (mode !== undefined) {
    await chmod(tmpPath, mode);
  }
  await rename(tmpPath, target);
}

/**
 * P10 review M5: before overwriting an EXISTING settings.json, snapshot its
 * prior raw content to `<file>.membral.bak` (overwriting any earlier bak —
 * this is a "before my last write" snapshot, not a history). Missing file ->
 * no prior content -> nothing to back up. Both the backup and the real write
 * are atomic (writeFileAtomic).
 */
async function writeSettingsFile(
  settingsPath: string,
  settings: Record<string, unknown>,
  originalContent: string | undefined,
): Promise<void> {
  await ensureParentDir(settingsPath);
  if (originalContent !== undefined) {
    await writeFileAtomic(`${settingsPath}.membral.bak`, originalContent);
  }
  await writeFileAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * Antigravity's global MCP file is `~/.gemini/config/mcp_config.json`. Its documented
 * server shapes are stdio (`command`/`args`/`env`) and a bare `url`; no `headers` key is
 * documented, so the HTTP bearer cannot ride on a `url` entry. Bridge through mcp-remote
 * exactly like Claude Desktop does (same entry, same env-var convention).
 */
async function configureAgyMcp(configPath: string, opts: ConfigureMCPOptions): Promise<ConfigureResult> {
  const mcpUrl = `${resolveApiUrl(opts)}/api/mcp`;
  const { key, isPlaceholder } = resolveApiKey(opts);
  const entry = buildMcpRemoteEntry(mcpUrl, key);

  return writeJsonMcpEntry(
    configPath,
    entry,
    (reason) =>
      `${describeReason(reason)} in: ${configPath}\n` +
      "  Bridged via mcp-remote (Antigravity documents stdio and bare-url servers only);\n" +
      '  the key is inlined in this entry\'s "env" block, file mode 0600.\n' +
      (isPlaceholder ? NO_KEY_WARNING : "") +
      "  Restart Antigravity to pick up the change.",
    lacksCommandKey,
    opts.onlyExisting,
  );
}

/** The name Membral's hooks live under in Antigravity's `hooks.json` (top-level key = hook name). */
export const AGY_HOOK_NAME = "membral";

/**
 * Antigravity's `~/.gemini/config/hooks.json` maps a HOOK NAME to its events:
 * `{ "<name>": { "PreInvocation": [ {type, command, timeout} ], "Stop": [ ... ] } }`
 * (flat handler lists for these two events). Membral owns exactly the `membral` key, so
 * install replaces that key (a stale path is corrected, a second run changes nothing) and
 * remove deletes only that key. A file that does not parse, or is not an object, is left
 * untouched and reported as a failure. Writes are atomic, 0600, with a `.membral.bak` of
 * the previous content.
 */
export async function configureAgyHooks(hooksPath: string, opts: SessionHookOptions = {}): Promise<ConfigureResult> {
  let original: string | undefined;
  try {
    original = await readFile(hooksPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return { success: false, message: `Could not read ${hooksPath}: ${(err as Error).message}` };
    }
  }

  let current: Record<string, unknown> = {};
  if (original !== undefined && original.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(original);
    } catch (err) {
      if (opts.remove) {
        // Membral cannot have installed into a file it cannot parse (install refuses it), so
        // there is nothing of ours to remove; do not fail an uninstall over someone else's file.
        return {
          success: true,
          message: `Antigravity hooks: left ${hooksPath} untouched (not valid JSON); nothing to remove`,
        };
      }
      return {
        success: false,
        message: `Left ${hooksPath} untouched: it is not valid JSON (${(err as Error).message}). Fix it, then re-run.`,
      };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      if (opts.remove) {
        return {
          success: true,
          message: `Antigravity hooks: left ${hooksPath} untouched (not a JSON object); nothing to remove`,
        };
      }
      return { success: false, message: `Left ${hooksPath} untouched: expected a JSON object at the top level.` };
    }
    current = parsed as Record<string, unknown>;
  }

  if (opts.remove) {
    if (!(AGY_HOOK_NAME in current)) return { success: true, message: "Antigravity hooks: nothing to remove" };
    delete current[AGY_HOOK_NAME];
  } else {
    const invocation = opts.cliInvocation ?? resolveCliInvocation();
    const prefix = quoteArgv(invocation.argv);
    current[AGY_HOOK_NAME] = {
      PreInvocation: [{ type: "command", command: `${prefix} preamble --hook --format agy`, timeout: 5 }],
      Stop: [{ type: "command", command: `${prefix} session-end-hook --source agy`, timeout: 10 }],
    };
  }

  const next = `${JSON.stringify(current, null, 2)}\n`;
  if (next === original) return { success: true, message: "Antigravity hooks already configured" };
  try {
    await ensureParentDir(hooksPath);
    if (original !== undefined) await writeFileAtomic(`${hooksPath}.membral.bak`, original, 0o600);
    await writeFileAtomic(hooksPath, next, 0o600);
  } catch (err) {
    return { success: false, message: `Failed to update ${hooksPath}: ${(err as Error).message}` };
  }
  return { success: true, message: opts.remove ? "Antigravity hooks removed" : "Antigravity hooks configured" };
}
