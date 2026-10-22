// Local git-remote resolution for code-session repo identity (ADR 0021 Q4).
//
// Claude Code transcripts record `cwd` but never the git remote, so this
// module resolves the raw `origin` remote URL by reading the filesystem
// directly (no `git` shell-out — pure file reads only). The cloud route's
// `normalizeRepoIdentity()` (apps/cloud/src/lib/code-sessions/repo-identity.ts)
// owns turning this raw URL into the canonical `host/owner/repo` clustering
// key; this module deliberately returns the URL untouched.
//
// Handles worktrees: a worktree's `.git` is a FILE containing `gitdir: <path>`
// pointing at `<main-repo>/.git/worktrees/<name>`, which itself has a
// `commondir` file pointing back at the real `.git` (where `config`/remotes
// actually live).
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

const MAX_WALK_UP = 64;

/**
 * Per-run cache of resolved remote URLs, keyed by the input `cwd`. Callers
 * doing many lookups (e.g. the backfill command) should create one cache and
 * pass it to every `resolveGitRemote` call so repeated sessions in the same
 * repo only touch the filesystem once.
 */
export function createGitRemoteCache(): Map<string, string | null> {
  return new Map();
}

/**
 * Resolve the `origin` remote URL for the git repo enclosing `cwd`, walking
 * up to find `.git`. Returns `undefined` when there is no repo, no `.git`,
 * or no `origin` remote configured — the cloud falls back to path identity
 * in that case (ADR 0021 Q4, precedence step 2).
 */
export async function resolveGitRemote(
  cwd: string | undefined,
  cache: Map<string, string | null> = new Map(),
): Promise<string | undefined> {
  if (!cwd || !isAbsolute(cwd)) return undefined;

  const cached = cache.get(cwd);
  if (cached !== undefined) return cached ?? undefined;

  let remote: string | undefined;
  try {
    const configDir = await findGitConfigDir(cwd);
    remote = configDir ? await readOriginUrl(configDir) : undefined;
  } catch {
    remote = undefined;
  }

  cache.set(cwd, remote ?? null);
  return remote;
}

/** The repo enclosing a directory: its shared git dir (a worktree resolves to its main repo's), its `origin` URL, and how many remotes it has. */
export interface GitRepoInfo {
  commonDir: string;
  originUrl?: string;
  remoteCount: number;
}

/**
 * D-051 F1: resolve the git repo enclosing `cwd` by the same file reads as
 * resolveGitRemote (walk up to `.git`, follow a worktree's `commondir`), for
 * deciding which repo a command that ran in `cwd` acted on. Undefined when
 * `cwd` is not absolute or no repo encloses it. Does not check that `cwd`
 * itself exists — a caller that must not walk up from a deleted directory
 * checks that first.
 */
export async function resolveGitRepoInfo(cwd: string | undefined): Promise<GitRepoInfo | undefined> {
  if (!cwd || !isAbsolute(cwd)) return undefined;
  try {
    const commonDir = await findGitConfigDir(cwd);
    if (!commonDir) return undefined;
    const config = (await tryReadFile(join(commonDir, "config"))) ?? "";
    const remotes = new Set<string>();
    for (const line of config.split(/\r?\n/)) {
      const m = line.trim().match(/^\[remote\s+"([^"]*)"\]$/);
      if (m) remotes.add(m[1]);
    }
    return { commonDir: resolve(commonDir), originUrl: parseOriginUrl(config), remoteCount: remotes.size };
  } catch {
    return undefined;
  }
}

/**
 * Walk up from `startDir` looking for a `.git` entry, then resolve it to the
 * directory that actually contains `config` (handling the worktree
 * indirection). Returns undefined if no `.git` is found up to the filesystem
 * root.
 */
async function findGitConfigDir(startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir);

  for (let i = 0; i < MAX_WALK_UP; i++) {
    const gitPath = join(dir, ".git");
    const st = await safeStat(gitPath);

    if (st?.isDirectory()) {
      return gitPath;
    }

    if (st?.isFile()) {
      return await resolveWorktreeGitDir(gitPath, dir);
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return undefined;
}

/**
 * `.git` is a file (worktree). Read `gitdir: <path>` from it, then follow
 * that dir's `commondir` file (if present) back to the main repo's real
 * `.git` directory, which is where `config` lives.
 */
async function resolveWorktreeGitDir(gitFilePath: string, containingDir: string): Promise<string | undefined> {
  const content = await tryReadFile(gitFilePath);
  if (!content) return undefined;

  const match = content.match(/^\s*gitdir:\s*(.+?)\s*$/m);
  if (!match) return undefined;

  const gitdirRaw = match[1];
  const worktreeGitDir = isAbsolute(gitdirRaw) ? gitdirRaw : resolve(containingDir, gitdirRaw);

  const commondirContent = await tryReadFile(join(worktreeGitDir, "commondir"));
  if (commondirContent) {
    const commondirRaw = commondirContent.trim();
    return isAbsolute(commondirRaw) ? commondirRaw : resolve(worktreeGitDir, commondirRaw);
  }

  // No commondir file — fall back to the worktree gitdir itself (e.g. a
  // synthetic/minimal fixture, or an unusual git layout).
  return worktreeGitDir;
}

async function readOriginUrl(gitConfigDir: string): Promise<string | undefined> {
  const content = await tryReadFile(join(gitConfigDir, "config"));
  if (!content) return undefined;
  return parseOriginUrl(content);
}

/** Minimal INI-style parser: find `[remote "origin"]` and its `url` key. */
function parseOriginUrl(configText: string): string | undefined {
  let inOrigin = false;

  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) continue;

    const sectionMatch = line.match(/^\[([^\s\]]+)(?:\s+"([^"]*)")?\]$/);
    if (sectionMatch) {
      const [, section, subsection] = sectionMatch;
      inOrigin = section === "remote" && subsection === "origin";
      continue;
    }

    if (!inOrigin) continue;

    const kvMatch = line.match(/^url\s*=\s*(.+)$/);
    if (kvMatch) {
      return kvMatch[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  return undefined;
}

/**
 * Per-run cache of resolved branch names, keyed by the input `cwd` — same
 * shape as createGitRemoteCache above, kept separate since a caller may
 * want the remote but not the branch (or vice versa) and the two walk
 * different directories for a worktree (see resolveGitBranch's doc comment).
 */
export function createGitBranchCache(): Map<string, string | null> {
  return new Map();
}

/**
 * Resolve the current branch name for the git repo enclosing `cwd`, by
 * reading `HEAD` directly (no `git` shell-out — pure file reads only, same
 * approach as resolveGitRemote). Returns `undefined` when there is no repo,
 * no `HEAD`, or HEAD is detached (points at a raw commit sha, not a
 * `refs/heads/...` ref).
 *
 * Unlike resolveGitRemote, this does NOT follow a worktree's `commondir`
 * indirection: `HEAD` is per-worktree (each worktree can be on a different
 * branch), while `config`/remotes live in the shared commondir. So this
 * reads `HEAD` from the worktree's own gitdir (the file `.git/gitdir:
 * <path>` points at), not the resolved common `.git` directory.
 */
export async function resolveGitBranch(
  cwd: string | undefined,
  cache: Map<string, string | null> = new Map(),
): Promise<string | undefined> {
  if (!cwd || !isAbsolute(cwd)) return undefined;

  const cached = cache.get(cwd);
  if (cached !== undefined) return cached ?? undefined;

  let branch: string | undefined;
  try {
    const headDir = await findHeadDir(cwd);
    branch = headDir ? await readBranchFromHead(headDir) : undefined;
  } catch {
    branch = undefined;
  }

  cache.set(cwd, branch ?? null);
  return branch;
}

/**
 * Walk up from `startDir` looking for a `.git` entry and return the
 * directory whose `HEAD` file is the right one to read: the repo's own
 * `.git` directory, or — for a worktree, where `.git` is a file — the
 * worktree-specific gitdir the file points at (NOT the commondir; see
 * resolveGitBranch's doc comment).
 */
async function findHeadDir(startDir: string): Promise<string | undefined> {
  let dir = resolve(startDir);

  for (let i = 0; i < MAX_WALK_UP; i++) {
    const gitPath = join(dir, ".git");
    const st = await safeStat(gitPath);

    if (st?.isDirectory()) {
      return gitPath;
    }

    if (st?.isFile()) {
      const content = await tryReadFile(gitPath);
      const match = content?.match(/^\s*gitdir:\s*(.+?)\s*$/m);
      if (!match) return undefined;
      const gitdirRaw = match[1];
      return isAbsolute(gitdirRaw) ? gitdirRaw : resolve(dir, gitdirRaw);
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return undefined;
}

/** Parses `HEAD`'s `ref: refs/heads/<branch>` form; undefined for detached HEAD (a raw sha) or a missing/unreadable file. */
async function readBranchFromHead(headDir: string): Promise<string | undefined> {
  const content = await tryReadFile(join(headDir, "HEAD"));
  if (!content) return undefined;
  const match = content.trim().match(/^ref:\s*refs\/heads\/(.+)$/);
  return match?.[1];
}

async function safeStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

async function tryReadFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}
