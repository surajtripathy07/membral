// Scans this machine for coding-harness session data (deliverable 2) — the
// "which harnesses/projects were found on your machine" step of `membral
// setup`'s onboarding wizard. Pure-ish: real filesystem reads, but no
// network calls and no writes (import-sessions.ts does the actual import,
// separately, honoring sync-allowlist.ts's chosen subset).
//
//   Claude Code (~/.claude/projects/*/): project = the real cwd, read out of
//     the transcript content itself (ground truth — see extractCwdFromJsonl
//     below), NOT decoded from the directory name. Claude Code's directory
//     naming replaces every "/" in the cwd with "-", which is lossy whenever
//     a real path segment itself contains a dash (e.g. a repo named
//     "example-app") — undoing that by blindly replacing "-" with "/"
//     produces a WRONG path in exactly that case. Reading `cwd` off an
//     actual event line is unambiguous; the naive dash-decode is only a
//     last-resort fallback for the rare transcript that has no cwd field at
//     all. sessions = *.jsonl file count; lastActiveAt = latest mtime among
//     them; remote = resolveGitRemote(cwd) when cwd exists on disk.
//   Codex (${CODEX_HOME:-~/.codex}/sessions/**) and opencode
//     (~/.local/share/opencode/**, pre-SQLite installs): walked recursively
//     and grouped by whatever cwd/workdir field can be sniffed out of each
//     file's JSON (top level, or a Codex line's `payload`); a file with no
//     such field becomes its own singleton "project". Codex is importable
//     (W9 parser); a generic-walked opencode store is not.
//   Copilot CLI (${COPILOT_HOME:-~/.copilot}/session-state/<id>/): one
//     directory per session; sessions = directory count, grouped by the cwd
//     in each events.jsonl's session.start (data.context.cwd).
import { access, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { createGitRemoteCache, resolveGitRemote } from "./git-remote.js";
import { defaultCodexHome, defaultCopilotHome } from "./import-sessions.js";

export type HarnessId = "claude-code" | "codex" | "opencode" | "copilot-cli";

export interface HarnessProject {
  harness: HarnessId;
  /** Real cwd when known (Claude Code, or a codex/opencode file that exposed one); a synthetic per-file label otherwise. */
  projectPath: string;
  displayName: string;
  remote?: string;
  sessions: number;
  lastActiveAt: string | null;
  /** Whether `membral sessions` has a parser for this harness today. */
  importable: boolean;
}

export interface HarnessScanOptions {
  claudeCodeRoot?: string;
  codexRoot?: string;
  opencodeRoot?: string;
  /** The Copilot home (the dir holding session-state/), not session-state itself. */
  copilotHome?: string;
  /** Surfaced diagnostics that don't change the result shape — e.g. "opencode.db exists but this Node has no node:sqlite" (2026-09-12 review, finding 1). */
  onWarn?: (message: string) => void;
}

export function defaultClaudeCodeRoot(): string {
  return join(homedir(), ".claude", "projects");
}
export function defaultCodexRoot(): string {
  return join(defaultCodexHome(), "sessions");
}
export function defaultOpencodeRoot(): string {
  return join(homedir(), ".local", "share", "opencode");
}

const CWD_SCAN_MAX_BYTES = 65536;
const GENERIC_SCAN_MAX_DEPTH = 6;
const GENERIC_CWD_FIELDS = ["cwd", "workdir", "working_directory", "cmd_cwd"] as const;
// Both codex and opencode store session data as JSON/JSONL — restricting to
// these extensions is what keeps the generic walk from vacuuming up a
// harness's OWN internal git-style object storage (observed in practice:
// opencode keeps a bare git repo per session under storage/snapshot/**,
// whose HEAD/config/refs/objects/*.pack files have no extension at all and
// would otherwise show up as hundreds of bogus "projects"). Also skips
// obvious VCS-internal directory names outright, as defense in depth.
const GENERIC_SESSION_EXTENSIONS = new Set([".json", ".jsonl"]);
const SKIP_DIR_NAMES = new Set(["node_modules", ".git", ".hg", ".svn", ".jj", "objects"]);
// Bounds worst-case pathological directories even after the extension
// filter and skip-list above — a scan step of the onboarding wizard must
// never hang or take minutes.
const GENERIC_SCAN_MAX_FILES = 2000;

async function readHeadBytes(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const buf = await readFile(path);
    return buf.subarray(0, maxBytes).toString("utf8");
  } catch {
    return undefined;
  }
}

/** Reads a bounded prefix of a `.jsonl` file looking for the first line that carries a non-empty `cwd` string. */
async function extractCwdFromJsonl(path: string): Promise<string | undefined> {
  const content = await readHeadBytes(path, CWD_SCAN_MAX_BYTES);
  if (!content) return undefined;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (event && typeof event === "object" && typeof (event as Record<string, unknown>).cwd === "string") {
        const cwd = (event as Record<string, unknown>).cwd as string;
        if (cwd) return cwd;
      }
    } catch {
      // Truncated last line (byte cap) or non-JSON — skip and keep scanning.
    }
  }
  return undefined;
}

/** Last-resort fallback when a Claude Code project directory has no readable cwd in any session — lossy (see module doc comment), only used when extraction fails entirely. */
function decodeClaudeProjectDirNameLossy(dirName: string): string {
  return dirName.startsWith("-") ? dirName.replace(/-/g, "/") : dirName;
}

async function scanClaudeCode(root: string, gitCache: Map<string, string | null>): Promise<HarnessProject[]> {
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const projects: HarnessProject[] = [];

  for (const dirName of entries) {
    const dirPath = join(root, dirName);
    let files: string[];
    try {
      files = (await readdir(dirPath, { withFileTypes: true }))
        .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
        .map((e) => e.name);
    } catch {
      continue;
    }
    if (files.length === 0) continue;

    let latestMtimeMs = 0;
    let newestFile: string | undefined;
    for (const name of files) {
      try {
        const st = await stat(join(dirPath, name));
        if (st.mtimeMs >= latestMtimeMs) {
          latestMtimeMs = st.mtimeMs;
          newestFile = name;
        }
      } catch {
        // one unreadable file's mtime shouldn't drop it from the session count
      }
    }

    const cwd = newestFile ? await extractCwdFromJsonl(join(dirPath, newestFile)) : undefined;
    const projectPath = cwd ?? decodeClaudeProjectDirNameLossy(dirName);
    const remote = cwd ? await resolveGitRemote(cwd, gitCache) : undefined;

    projects.push({
      harness: "claude-code",
      projectPath,
      displayName: basename(projectPath) || projectPath,
      remote,
      sessions: files.length,
      lastActiveAt: latestMtimeMs > 0 ? new Date(latestMtimeMs).toISOString() : null,
      importable: true,
    });
  }

  return projects;
}

function hasSessionExtension(name: string): boolean {
  const lower = name.toLowerCase();
  for (const ext of GENERIC_SESSION_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

async function listFilesRecursive(root: string, maxDepth: number, maxFiles: number): Promise<string[]> {
  const out: string[] = [];

  async function walk(dir: string, remaining: number): Promise<void> {
    if (out.length >= maxFiles) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (entry.isDirectory()) {
        if (SKIP_DIR_NAMES.has(entry.name)) continue;
        if (remaining > 0) await walk(join(dir, entry.name), remaining - 1);
      } else if (entry.isFile() && hasSessionExtension(entry.name)) {
        out.push(join(dir, entry.name));
      }
    }
  }

  await walk(root, maxDepth);
  return out;
}

function findCwdField(obj: unknown): string | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const r = obj as Record<string, unknown>;
  for (const field of GENERIC_CWD_FIELDS) {
    const v = r[field];
    if (typeof v === "string" && v) return v;
  }
  // A Codex rollout line nests it one level down: `{type: "session_meta", payload: {cwd}}`.
  const payload = r.payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const field of GENERIC_CWD_FIELDS) {
      const v = (payload as Record<string, unknown>)[field];
      if (typeof v === "string" && v) return v;
    }
  }
  return undefined;
}

/** Best-effort cwd sniff for an unknown-shape harness file: try it as one whole JSON document first (opencode-style), then as JSONL. */
async function extractCwdGeneric(path: string): Promise<string | undefined> {
  const content = await readHeadBytes(path, CWD_SCAN_MAX_BYTES);
  if (!content) return undefined;

  try {
    const whole = JSON.parse(content);
    const found = findCwdField(whole);
    if (found) return found;
  } catch {
    // not a single complete JSON document (or truncated by the byte cap) — fall through
  }

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const found = findCwdField(JSON.parse(trimmed));
      if (found) return found;
    } catch {}
  }
  return undefined;
}

// opencode's real, current storage is a SQLite database at
// `<opencodeRoot>/opencode.db` (verified against a live install — see
// packages/core/src/sessions/opencode.ts's module doc comment for the full
// schema notes), NOT one-JSON-file-per-session the way the generic walk
// below assumes. `packages/cli/src/opencode-export.ts` has a parser for it
// (goal 2026-09-12 W6/D5), so a session found this way is importable.
// Returns `undefined` (not `[]`) when there's no database to read, so the
// caller can fall back to `scanGenericHarness`'s file-sniffing heuristic —
// still useful for an opencode install old enough to predate the SQLite
// migration, or one that just wrote a storage/ JSON export by hand.
async function scanOpencodeSqlite(
  root: string,
  gitCache: Map<string, string | null>,
  onWarn?: (message: string) => void,
): Promise<HarnessProject[] | undefined> {
  const dbPath = join(root, "opencode.db");
  try {
    await stat(dbPath);
  } catch {
    return undefined;
  }

  // Dynamic import (2026-09-12 review, finding 1): `node:sqlite` doesn't
  // exist before Node 22.5. A top-level static import would crash module
  // evaluation for this whole file — and everything that imports it,
  // including `setup.ts` — the instant it loaded on an older Node, long
  // before this function even runs. Falling back to the generic scan here
  // degrades opencode to `importable: false` with a printed reason instead.
  type SqliteModule = typeof import("node:sqlite");
  let DatabaseSync: SqliteModule["DatabaseSync"];
  try {
    ({ DatabaseSync } = await import("node:sqlite"));
  } catch {
    onWarn?.(
      "opencode import needs Node >= 22.5 (node:sqlite unavailable) — treating opencode as detected-but-not-importable.",
    );
    return undefined;
  }

  let rows: { directory: string; time_updated: number }[];
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      rows = db.prepare("SELECT directory, time_updated FROM session WHERE parent_id IS NULL").all() as unknown as {
        directory: string;
        time_updated: number;
      }[];
    } finally {
      db.close();
    }
  } catch {
    // Present but unreadable/corrupt — fall back to the generic scan rather
    // than silently reporting zero opencode projects.
    return undefined;
  }

  const groups = new Map<string, { count: number; mtimeMs: number }>();
  for (const row of rows) {
    if (!row.directory) continue;
    const group = groups.get(row.directory) ?? { count: 0, mtimeMs: 0 };
    group.count++;
    group.mtimeMs = Math.max(group.mtimeMs, row.time_updated || 0);
    groups.set(row.directory, group);
  }

  const projects: HarnessProject[] = [];
  for (const [directory, group] of groups) {
    const remote = await resolveGitRemote(directory, gitCache);
    projects.push({
      harness: "opencode",
      projectPath: directory,
      displayName: basename(directory) || directory,
      remote,
      sessions: group.count,
      lastActiveAt: group.mtimeMs > 0 ? new Date(group.mtimeMs).toISOString() : null,
      importable: true,
    });
  }
  return projects;
}

/** Copilot CLI's cwd lives at session.start's data.context.cwd, which extractCwdFromJsonl (top-level only) misses. */
async function extractCopilotCwd(eventsPath: string): Promise<string | undefined> {
  const content = await readHeadBytes(eventsPath, CWD_SCAN_MAX_BYTES);
  if (!content) return undefined;
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed) as { type?: unknown; data?: { context?: { cwd?: unknown } } };
      if (event?.type !== "session.start") continue;
      const cwd = event.data?.context?.cwd;
      return typeof cwd === "string" && cwd ? cwd : undefined;
    } catch {
      // truncated or non-JSON line — keep scanning
    }
  }
  return undefined;
}

export async function scanCopilotCli(
  copilotHome: string,
  gitCache: Map<string, string | null>,
): Promise<HarnessProject[]> {
  const stateDir = join(copilotHome, "session-state");
  let dirs: string[];
  try {
    dirs = (await readdir(stateDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  const groups = new Map<string, { isCwd: boolean; count: number; mtimeMs: number }>();
  for (const dir of dirs) {
    const eventsPath = join(stateDir, dir, "events.jsonl");
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(eventsPath)).mtimeMs;
    } catch {
      continue; // a session dir with no transcript has nothing to import
    }
    const cwd = await extractCopilotCwd(eventsPath);
    const key = cwd ?? join(stateDir, dir);
    const group = groups.get(key) ?? { isCwd: Boolean(cwd), count: 0, mtimeMs: 0 };
    group.count++;
    group.mtimeMs = Math.max(group.mtimeMs, mtimeMs);
    groups.set(key, group);
  }

  const projects: HarnessProject[] = [];
  for (const [projectPath, group] of groups) {
    projects.push({
      harness: "copilot-cli",
      projectPath,
      displayName: basename(projectPath) || projectPath,
      remote: group.isCwd ? await resolveGitRemote(projectPath, gitCache) : undefined,
      sessions: group.count,
      lastActiveAt: group.mtimeMs > 0 ? new Date(group.mtimeMs).toISOString() : null,
      importable: true,
    });
  }
  return projects;
}

async function scanGenericHarness(
  harness: Exclude<HarnessId, "claude-code" | "copilot-cli">,
  root: string,
): Promise<HarnessProject[]> {
  let files: string[];
  try {
    files = await listFilesRecursive(root, GENERIC_SCAN_MAX_DEPTH, GENERIC_SCAN_MAX_FILES);
  } catch {
    return [];
  }
  if (files.length === 0) return [];

  const groups = new Map<string, { isCwd: boolean; files: string[]; mtimeMs: number }>();

  for (const file of files) {
    let mtimeMs = 0;
    try {
      mtimeMs = (await stat(file)).mtimeMs;
    } catch {
      // still counted below with mtimeMs 0
    }
    const cwd = await extractCwdGeneric(file);
    const key = cwd ?? `file:${file}`;
    const group = groups.get(key) ?? { isCwd: Boolean(cwd), files: [], mtimeMs: 0 };
    group.files.push(file);
    group.mtimeMs = Math.max(group.mtimeMs, mtimeMs);
    groups.set(key, group);
  }

  const projects: HarnessProject[] = [];
  for (const [key, group] of groups) {
    const projectPath = group.isCwd ? key : group.files[0];
    projects.push({
      harness,
      projectPath,
      displayName: basename(projectPath) || projectPath,
      sessions: group.files.length,
      lastActiveAt: group.mtimeMs > 0 ? new Date(group.mtimeMs).toISOString() : null,
      // Codex has a parser (W9); a generic-walked opencode store does not.
      importable: harness === "codex",
    });
  }
  return projects;
}

export async function scanHarnesses(opts: HarnessScanOptions = {}): Promise<HarnessProject[]> {
  const gitCache = createGitRemoteCache();
  const opencodeRoot = opts.opencodeRoot ?? defaultOpencodeRoot();
  const [claudeCode, codex, opencode, copilotCli] = await Promise.all([
    scanClaudeCode(opts.claudeCodeRoot ?? defaultClaudeCodeRoot(), gitCache),
    scanGenericHarness("codex", opts.codexRoot ?? defaultCodexRoot()),
    scanOpencodeSqlite(opencodeRoot, gitCache, opts.onWarn).then(
      (found) => found ?? scanGenericHarness("opencode", opencodeRoot),
    ),
    scanCopilotCli(opts.copilotHome ?? defaultCopilotHome(), gitCache),
  ]);
  return [...claudeCode, ...codex, ...opencode, ...copilotCli];
}

// --- Copilot presence ---------------------------------------------------------
// Copilot needs no session on disk to be worth wiring: VS Code's Copilot Chat
// runs on the Copilot CLI engine and fires the ~/.copilot hooks too, so setup
// installs the hooks + MCP whenever either is installed, not only after the
// first Copilot CLI session (the session scan above still feeds the import).

export interface CopilotDetectOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
}

export interface CopilotPresence {
  /** `copilot` resolves on PATH. */
  cliOnPath: boolean;
  /** ${COPILOT_HOME:-~/.copilot} exists. */
  copilotHome: boolean;
  /** VS Code User dirs (Code, Code - Insiders) that exist; recent VS Code ships Copilot Chat built in. */
  vscodeUserDirs: string[];
  /** A github.copilot-chat-* extension under ~/.vscode{,-insiders}/extensions. */
  vscodeExtension: boolean;
  present: boolean;
}

const VSCODE_VARIANTS = [
  { app: "Code", ext: ".vscode" },
  { app: "Code - Insiders", ext: ".vscode-insiders" },
] as const;

/** Candidate VS Code User dirs (profile-default User folder), existing or not. */
export function vscodeUserDirCandidates(opts: CopilotDetectOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  let base: string;
  if (platform === "darwin") base = join(home, "Library", "Application Support");
  else if (platform === "win32") base = env.APPDATA || join(home, "AppData", "Roaming");
  else base = env.XDG_CONFIG_HOME || join(home, ".config");
  return VSCODE_VARIANTS.map((v) => join(base, v.app, "User"));
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
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

async function hasCopilotChatExtension(home: string): Promise<boolean> {
  for (const v of VSCODE_VARIANTS) {
    let entries: string[];
    try {
      entries = await readdir(join(home, v.ext, "extensions"));
    } catch {
      continue;
    }
    if (entries.some((e) => e.toLowerCase().startsWith("github.copilot-chat-"))) return true;
  }
  return false;
}

export async function detectCopilot(opts: CopilotDetectOptions = {}): Promise<CopilotPresence> {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const platform = opts.platform ?? process.platform;
  const copilotHomeDir = env.COPILOT_HOME || join(home, ".copilot");
  const candidates = vscodeUserDirCandidates({ env, home, platform });
  const [cliOnPath, copilotHome, userDirFlags, vscodeExtension] = await Promise.all([
    onPath("copilot", env, platform),
    exists(copilotHomeDir),
    Promise.all(candidates.map(exists)),
    hasCopilotChatExtension(home),
  ]);
  const vscodeUserDirs = candidates.filter((_, i) => userDirFlags[i]);
  return {
    cliOnPath,
    copilotHome,
    vscodeUserDirs,
    vscodeExtension,
    present: cliOnPath || copilotHome || vscodeUserDirs.length > 0 || vscodeExtension,
  };
}
