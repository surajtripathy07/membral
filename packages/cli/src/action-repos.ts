// D-051 F1: which repo each forge action acted on, resolved on the developer's
// machine by the same mechanism that names the session's project.
//
// The parser (@membral/core forge-actions.ts) records, per action, the
// absolute directory the command ran in (`dir`: the call's own cwd moved by
// literal `cd`/`pushd`/`git -C`). Here that directory is resolved to a repo
// exactly as the session's project is — the enclosing git repo's `origin`
// remote (git-remote.ts), host dropped — and compared with the project:
//
//   same repo as the project         → the action keeps its bare ref;
//   another repo, one remote only    → its item is qualified to that repo
//                                      (`host/owner/repo#N`, the remote's own
//                                      host kept), as `-R` would;
//   anything else (missing, not a    → unknown: the item's own result URL if
//   repo, no remote, several remotes)  it named one repo, else `repoUnknown`.
//
// A directory with several remotes is never named: gh and glab may pick a
// remote other than `origin` (an `upstream`, a set default), so naming it
// could be a wrong link. A sub-agent's actions are judged against BOTH its
// own project and its parent's — the parent folds them into its own profile —
// so a bare ref survives only when it is both sessions' project.
import { stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { type ActionDirVerdict, type ForgeAction, type RawCodeSession, settleActionDir } from "@membral/core";
import { repoPathFromRemote } from "./branch-state-check.js";
import { resolveGitRepoInfo } from "./git-remote.js";

/** A session's project anchor: the directory its identity came from and the remote resolved for it. */
export interface RepoAnchor {
  path?: string;
  remoteUrl?: string;
}

type RepoId =
  | { kind: "remote"; key: string; remoteCount: number; roots?: string[]; host?: string }
  | { kind: "git"; commonDir: string; roots?: string[] }
  | { kind: "plain"; path: string }
  | { kind: "missing" };

/** Per-run cache of directory → repo identity, so repeated sessions touch the filesystem once per directory. */
export type ActionRepoCache = Map<string, Promise<RepoId>>;

export function createActionRepoCache(): ActionRepoCache {
  return new Map();
}

/** A remote on this machine (`/srv/git/x.git`, `file://…`, `../x`, `C:\\…`) names no forge repo. */
const LOCAL_REMOTE = /^(?:file:|\/|\.{1,2}[\\/]|~|[A-Za-z]:[\\/])/;

/**
 * v3 item 6: the forge host a remote URL names (`git@github.com:o/r.git`, `https://github.com/o/r`),
 * lower-cased — kept so a cross-repo item is qualified as `host/owner/repo#N` (a link needs it).
 * An ssh alias with no dot (`git@work:o/r`) names no host.
 */
export function remoteHost(url: string): string | undefined {
  const u = url.trim();
  if (LOCAL_REMOTE.test(u)) return undefined;
  let host: string | undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) {
    try {
      host = new URL(u).hostname;
    } catch {
      return undefined;
    }
  } else host = /^(?:[^@/\s]+@)?([^:/\s]+):/.exec(u)?.[1];
  host = host?.toLowerCase();
  return host && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host) ? host : undefined;
}

function remoteKey(url: string): string {
  const u = url.trim();
  // R2-N2: a local remote gets no invented `owner/repo` — it stays unnameable (`raw:`).
  if (LOCAL_REMOTE.test(u)) return `raw:${u}`;
  return repoPathFromRemote(u) ?? `raw:${u}`;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** The repo identity of a directory an action ran in: it must exist (never walk up from a deleted directory). */
function dirIdentity(dir: string, cache: ActionRepoCache): Promise<RepoId> {
  const hit = cache.get(dir);
  if (hit) return hit;
  const run = (async (): Promise<RepoId> => {
    if (!isAbsolute(dir) || !(await isDirectory(dir))) return { kind: "missing" };
    const info = await resolveGitRepoInfo(dir);
    if (!info) return { kind: "plain", path: resolve(dir) };
    if (info.originUrl)
      return {
        kind: "remote",
        key: remoteKey(info.originUrl),
        remoteCount: info.remoteCount,
        host: remoteHost(info.originUrl),
      };
    return { kind: "git", commonDir: info.commonDir };
  })();
  cache.set(dir, run);
  return run;
}

/**
 * The identity of a session's project: its resolved remote, else its
 * directory's repo, else the directory itself. A project that resolved to a
 * repo also records its `roots` — the session's own cwd path (the string the
 * identity came from) and the repo's top level — for R2-S2 below.
 */
async function anchorIdentity(anchor: RepoAnchor): Promise<RepoId> {
  const path = anchor.path && isAbsolute(anchor.path) ? resolve(anchor.path) : undefined;
  const info = path ? await resolveGitRepoInfo(path) : undefined;
  const roots = path ? [path] : [];
  if (info && info.commonDir.endsWith("/.git")) roots.push(dirname(info.commonDir));
  if (anchor.remoteUrl) return { kind: "remote", key: remoteKey(anchor.remoteUrl), remoteCount: 1, roots };
  if (!path) return { kind: "missing" };
  if (info && !info.originUrl) return { kind: "git", commonDir: info.commonDir, roots };
  if (info?.originUrl) return { kind: "remote", key: remoteKey(info.originUrl), remoteCount: info.remoteCount, roots };
  return { kind: "plain", path };
}

function isInside(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root === "/" ? "/" : `${root}/`);
}

/**
 * R2-S2: a directory that no longer exists (a worktree removed before import)
 * still belongs to a project whose own cwd path — or resolved top level — it
 * equals or lies inside: that is the same string the project's identity was
 * resolved from. Only for an anchor that DID resolve to a repo; a directory
 * that exists is always judged by its own repo (a nested clone is its own).
 */
function missingInsideAnchor(dir: string, anchor: RepoId): boolean {
  if (anchor.kind !== "remote" && anchor.kind !== "git") return false;
  const d = resolve(dir);
  return (anchor.roots ?? []).some((r) => isInside(d, r));
}

function sameRepo(a: RepoId, b: RepoId): boolean {
  if (a.kind === "remote" && b.kind === "remote") return a.key === b.key;
  if (a.kind === "git" && b.kind === "git") return a.commonDir === b.commonDir;
  if (a.kind === "plain" && b.kind === "plain") return a.path === b.path;
  return false;
}

function verdictFor(dir: string, id: RepoId, anchors: readonly RepoId[]): ActionDirVerdict {
  if (id.kind === "missing") {
    if (anchors.length > 0 && anchors.every((a) => missingInsideAnchor(dir, a))) return { kind: "project" };
    return { kind: "unknown" };
  }
  if (anchors.length > 0 && anchors.every((a) => sameRepo(id, a))) return { kind: "project" };
  // v3 item 6: the remote's host is kept (`github.com/owner/repo`), never re-derived later.
  if (id.kind === "remote" && id.remoteCount === 1 && !id.key.startsWith("raw:"))
    return { kind: "repo", repo: id.host ? `${id.host}/${id.key}` : id.key };
  return { kind: "unknown" };
}

function hasDir(a: ForgeAction | undefined): boolean {
  return !!a && (a.dir !== undefined || a.shownRepo !== undefined);
}

/**
 * Settle every action's local `dir` in `session` against its project
 * `anchors` (the session's own repo; a sub-agent adds its parent's). Mutates
 * the session's turns; the uploader then drops `repoUnknown` actions.
 */
export async function settleSessionActionRepos(
  session: RawCodeSession,
  anchors: readonly RepoAnchor[],
  cache: ActionRepoCache = createActionRepoCache(),
): Promise<void> {
  if (!session.turns.some((t) => hasDir(t.action) || (t.actions ?? []).some(hasDir))) return;
  const anchorIds = await Promise.all(anchors.map(anchorIdentity));
  const settle = async (a: ForgeAction): Promise<ForgeAction> => {
    if (a.dir === undefined) return hasDir(a) ? settleActionDir(a, { kind: "project" }) : a;
    return settleActionDir(a, verdictFor(a.dir, await dirIdentity(a.dir, cache), anchorIds));
  };
  for (const t of session.turns) {
    if (t.actions && t.actions.length > 0) {
      const settled = await Promise.all(t.actions.map(settle));
      // `action` is the same object as one of `actions` (the primary): keep them paired.
      const at = t.action ? t.actions.indexOf(t.action) : -1;
      t.actions = settled;
      if (at >= 0) t.action = settled[at];
      else if (t.action) t.action = await settle(t.action);
    } else if (t.action) {
      t.action = await settle(t.action);
    }
  }
}
