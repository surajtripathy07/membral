// The sweep's ref-keyed git check (goal 2026-09-26 W6 / P4; B4, B6, B9, B14).
//
// After `membral sweep` has uploaded sessions and kicked extraction it asks
// the server which shas and branches the developer's own sessions named
// (GET /api/memory/branch-state — planned server-side from
// code_session_turns.props.action, see the cloud's lib/memory/branch-state.ts),
// answers those questions against the local checkouts, and POSTs the
// answers back. The dashboard's "open threads" then know whether a commit
// the harness made ever reached the default branch, or whether its branch
// went away — closure that never shows up inside a transcript.
//
// Contract, enforced by `assertRefKeyedGitArgs` on EVERY git invocation and
// by the tests that spy on execFile:
//   * read-only: the checkout's HEAD, index and worktree are never touched
//     (GIT_OPTIONAL_LOCKS=0 as well, so not even index refreshes);
//   * ref-keyed: every command names a sha or a branch the server sent;
//     no `--since/--after/--until/--before`, no reflog, no `@{...}` — two
//     sessions overlapping in the same cwd can never be confused by a time
//     window (B4);
//   * no network unless MEMBRAL_SWEEP_FETCH=1 (`git fetch --prune origin`
//     and `git ls-remote --heads origin <branch>` are then allowed);
//   * the sweep reports only what THIS checkout can prove; absent evidence is
//     `null` (unknown / "no merge seen"), never a guess. Several sessions
//     share one checkout and the same path can hold a different clone on
//     another machine, so:
//       - a planned sha missing from this checkout is unknown: last_seen_sha,
//         merged and superseded are all null — the local branch head is never
//         substituted (it may be a different machine's history), and a
//         branch key with no sha named never gets a merge answer at all;
//       - "branch gone" needs MEMBRAL_SWEEP_FETCH=1: `ls-remote` on origin
//         shows refs/heads/<b> absent AND it existed there — this clone
//         tracked origin/<b> before the fetch pruned it, or no local <b> is
//         left and the server's row or this clone holds its sha. Without
//         fetch it is never reported;
//       - only show-ref exit 1 means "ref absent"; any other failure is null;
//       - a checkout whose origin is not the project's repoIdentity (a
//         dotfiles repo enclosing a removed clone, another repo at the same
//         path) is skipped;
//   * a repo whose paths are not git checkouts, or whose git fails, is a
//     logged skip — never a failed sweep; nothing here throws to the caller.
//
// Worktrees share one object store and one ref namespace, so paths are
// grouped by `git rev-parse --git-common-dir` and one repo is checked once
// (B14). Separate clones of one project are each checked, and their rows
// merged: what any clone proves counts (B3).
//
// The exact git commands, per repo:
//   git rev-parse --git-common-dir                       (grouping)
//   git remote get-url origin                            (checkout is the project's repo)
//   git rev-parse --show-toplevel                        (same, for path-identity repos)
//   git symbolic-ref --quiet --short refs/remotes/origin/HEAD
//   git show-ref --verify --quiet refs/remotes/origin/<main|master>
//   git show-ref --verify --quiet refs/heads/<main|master>   (default branch)
//   git show-ref --verify --quiet refs/heads/<branch>     (branch present locally)
//   git show-ref --verify --quiet refs/remotes/origin/<branch>
//   git cat-file -e <sha>^{commit}                        (sha still exists)
//   git merge-base --is-ancestor <sha> <default ref>      (merged into default)
//   MEMBRAL_SWEEP_FETCH=1 only:
//   git show-ref --verify --quiet refs/remotes/origin/<branch>   (tracked before the fetch)
//   git fetch --quiet --prune origin
//   git ls-remote --heads origin refs/heads/<branch>      (branch gone on the remote)
import { execFile as nodeExecFile } from "node:child_process";
import { resolve } from "node:path";
import { createUploadClient, resolveUploadConfig, type UploadConfig, type UploadFlags } from "./code-session-upload.js";
import type { ApiClient, ApiResult } from "./lib/api-client.js";

export const BRANCH_STATE_PATH = "/api/memory/branch-state";
export const DETACHED_BRANCH_PREFIX = "commit:";
const GIT_TIMEOUT_MS = 20_000;
const MAX_RESULTS_PER_POST = 500;
const SHA_RE = /^[0-9a-f]{7,40}$/;

// --- shapes shared with the server (kept structural; the CLI does not import the cloud) ---

export interface RefsToCheckSha {
  sha: string;
  branch: string;
  ref: string | null;
  sessionId: string;
}

export interface RefsToCheckKnownRow {
  branch: string;
  last_seen_sha: string | null;
  branch_gone_at: string | null;
}

export interface RepoRefsToCheck {
  codeProjectId: string;
  repoIdentity: string;
  paths: string[];
  shas: RefsToCheckSha[];
  branches: string[];
  openRefs: { ref: string; url: string | null; branch: string | null; sessionId: string }[];
  /** What the server already stores per branch key; older servers omit it. */
  known?: RefsToCheckKnownRow[];
}

export interface BranchCheckResult {
  code_project_id: string;
  branch: string;
  default_branch: string | null;
  last_seen_sha: string | null;
  merged_into_default: boolean | null;
  sha_superseded_by: string | null;
  branch_gone: boolean | null;
}

// --- git runner --------------------------------------------------------------

export interface GitResult {
  /** Process exit code; -1 when git could not be spawned or timed out. */
  code: number;
  stdout: string;
  stderr: string;
}
export type GitRunner = (dir: string, args: string[]) => Promise<GitResult>;

/** Minimal execFile shape the runner needs (node's own, or a test spy). */
export type ExecFileLike = (
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number },
  callback: (error: (Error & { code?: number | string }) | null, stdout: string, stderr: string) => void,
) => unknown;

/** Argument tokens that would make a git command time-keyed or history-walking instead of ref-keyed (B4). */
const FORBIDDEN_GIT_ARG = /^(--since|--after|--until|--before|--max-age|--min-age|--date)(=|$)|^reflog$|@\{/;

/** Throws when an argv would not be a read-only, ref-keyed git command. Every runner call goes through it. */
export function assertRefKeyedGitArgs(args: string[]): void {
  for (const a of args) {
    if (FORBIDDEN_GIT_ARG.test(a)) throw new Error(`sweep: refusing time-keyed git argument "${a}"`);
  }
  const sub = args[0];
  if (sub === "remote") {
    if (args.length === 3 && args[1] === "get-url" && args[2] === "origin") return;
    throw new Error(`sweep: refusing git remote argv "${args.join(" ")}"`);
  }
  const allowed = new Set(["rev-parse", "symbolic-ref", "show-ref", "cat-file", "merge-base", "fetch", "ls-remote"]);
  if (!sub || !allowed.has(sub)) throw new Error(`sweep: refusing git subcommand "${sub ?? ""}"`);
}

/**
 * Environment for every child git: no prompts (and ssh in batch mode, so a
 * fetch under launchd can never hang on a passphrase), no optional locks, and
 * no inherited GIT_DIR/GIT_WORK_TREE — `-C <dir>` does not override those.
 */
export function gitChildEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[k];
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_SSH_COMMAND = "ssh -o BatchMode=yes";
  return env;
}

export function createGitRunner(execFileImpl: ExecFileLike = nodeExecFile as unknown as ExecFileLike): GitRunner {
  return (dir, args) =>
    new Promise((resolveResult) => {
      try {
        assertRefKeyedGitArgs(args);
      } catch (err) {
        resolveResult({ code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
        return;
      }
      try {
        execFileImpl(
          "git",
          ["-C", dir, ...args],
          {
            env: gitChildEnv(process.env),
            timeout: GIT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024,
          },
          (error, stdout, stderr) => {
            const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
            resolveResult({ code, stdout: stdout ?? "", stderr: (stderr ?? "") || (error?.message ?? "") });
          },
        );
      } catch (err) {
        resolveResult({ code: -1, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      }
    });
}

// --- HTTP --------------------------------------------------------------------

// Both calls go through the policy client (endpoints "refs" and
// "branchState": 20 s, no retry, env-key fallback on a 401). Every non-ok
// result becomes one Error that runBranchStateCheck logs as one line.

function clientFor(
  config: UploadConfig,
  fetchImpl: typeof fetch | undefined,
  client: ApiClient | undefined,
): ApiClient {
  return client ?? createUploadClient(config, fetchImpl ? { fetchImpl } : {});
}

function failure(result: Exclude<ApiResult<unknown>, { ok: true }>): Error {
  switch (result.kind) {
    case "network":
    case "timeout":
      return new Error(result.message);
    case "deferred":
      return new Error("deferred past its deadline");
    case "rate_limited":
      return new Error("server returned 429");
    case "bad_json":
      return new Error(`server returned ${result.status} but the response was not JSON`);
    default:
      return new Error(`server returned ${result.status}`);
  }
}

export async function fetchRefsToCheck(
  config: UploadConfig,
  fetchImpl?: typeof fetch,
  client?: ApiClient,
): Promise<RepoRefsToCheck[]> {
  const result = await clientFor(config, fetchImpl, client).call<{ repos?: unknown }>("refs");
  if (!result.ok) throw failure(result);
  const repos = result.data?.repos;
  return Array.isArray(repos) ? (repos as RepoRefsToCheck[]) : [];
}

export async function postBranchState(
  config: UploadConfig,
  results: BranchCheckResult[],
  checkedAt: string,
  fetchImpl?: typeof fetch,
  client?: ApiClient,
): Promise<{ upserted: number; rejected: number }> {
  const api = clientFor(config, fetchImpl, client);
  let upserted = 0;
  let rejected = 0;
  for (let i = 0; i < results.length; i += MAX_RESULTS_PER_POST) {
    const result = await api.call<{ upserted?: number; rejected?: number }>("branchState", {
      json: { checked_at: checkedAt, results: results.slice(i, i + MAX_RESULTS_PER_POST) },
    });
    if (!result.ok) throw failure(result);
    // Lenient: a body that is not JSON counts 0, as before.
    upserted += result.data?.upserted ?? 0;
    rejected += result.data?.rejected ?? 0;
  }
  return { upserted, rejected };
}

// --- grouping ----------------------------------------------------------------

export interface RepoGroup {
  /** Absolute `--git-common-dir`: the one object store/ref namespace every worktree of this repo shares. */
  commonDir: string;
  /** A checkout to run the commands from (the first path that resolved to this common dir). */
  dir: string;
  repos: RepoRefsToCheck[];
}

/**
 * One group per distinct `git rev-parse --git-common-dir`, so worktrees (and
 * two projects that turn out to be one checkout) are checked once. Every
 * clone of a project is a group of its own (B3): the sha may live in any of
 * them, and `mergeCloneResults` keeps what any one of them proves. A path
 * that is not a git checkout is logged and skipped; a repo with no usable
 * path is skipped whole.
 */
export async function groupReposByCommonDir(
  repos: RepoRefsToCheck[],
  git: GitRunner,
  log: (m: string) => void,
): Promise<{ groups: RepoGroup[]; skippedRepos: number }> {
  const groups = new Map<string, RepoGroup>();
  let skippedRepos = 0;
  for (const repo of repos) {
    let placed = false;
    for (const path of repo.paths) {
      const r = await git(path, ["rev-parse", "--git-common-dir"]);
      const out = r.stdout.trim();
      if (r.code !== 0 || !out) {
        log(`sweep: ${path} is not a git checkout — skipped (${r.stderr.trim().split("\n")[0] || "no output"})`);
        continue;
      }
      const commonDir = resolve(path, out);
      const mismatch = await checkoutIdentityMismatch(git, path, commonDir, repo.repoIdentity);
      if (mismatch) {
        log(`sweep: ${path} is not ${repo.repoIdentity} (${mismatch}) — skipped`);
        continue;
      }
      const group = groups.get(commonDir);
      if (!group) groups.set(commonDir, { commonDir, dir: path, repos: [repo] });
      else if (!group.repos.includes(repo)) group.repos.push(repo);
      placed = true;
    }
    if (!placed) {
      skippedRepos++;
      log(`sweep: no git checkout found for ${repo.repoIdentity} — ref checks skipped`);
    }
  }
  return { groups: [...groups.values()], skippedRepos };
}

// --- repo identity -----------------------------------------------------------

/**
 * `owner/repo` (lowercased, host dropped, `.git` stripped) from a remote URL
 * in any of the ssh (`git@host:owner/repo.git`, `ssh://git@host/owner/repo`)
 * or https forms. Mirrors the cloud's normalizeRepoIdentity minus the host,
 * so the same repo reached through an ssh alias still matches.
 */
export function repoPathFromRemote(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!trimmed) return null;
  let rawPath: string | null = null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const scp = trimmed.match(/^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/);
    if (scp) rawPath = scp[2];
  }
  if (rawPath === null) {
    try {
      const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
      rawPath = url.pathname;
    } catch {
      return null;
    }
  }
  const path = rawPath
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
  return path || null;
}

/** `owner/repo` of a `host/owner/repo` identity; null for a path identity or the unassigned bucket. */
function repoPathFromIdentity(identity: string): string | null {
  if (identity.startsWith("/")) return null;
  const slash = identity.indexOf("/");
  if (slash <= 0) return null;
  const rest = identity
    .slice(slash + 1)
    .replace(/\/+$/, "")
    .toLowerCase();
  return rest || null;
}

function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, "") || "/";
}

/**
 * Null when the checkout at `path` is provably the project's repo, else the
 * reason it is not. A `host/owner/repo` identity must match
 * `git remote get-url origin` (host-stripped); a path identity (no remote)
 * must be this checkout's top level or common dir. Anything unprovable is a
 * mismatch: skipping a repo reports nothing, checking the wrong one reports
 * lies.
 */
async function checkoutIdentityMismatch(
  git: GitRunner,
  path: string,
  commonDir: string,
  identity: string,
): Promise<string | null> {
  if (identity.startsWith("/")) {
    const want = stripTrailingSlash(identity);
    const top = await git(path, ["rev-parse", "--show-toplevel"]);
    const topDir = top.code === 0 ? stripTrailingSlash(top.stdout.trim()) : "";
    if (topDir === want || stripTrailingSlash(commonDir) === `${want}/.git`) return null;
    return `top level ${topDir || "unknown"}`;
  }
  const want = repoPathFromIdentity(identity);
  if (!want) return "identity has no owner/repo";
  const r = await git(path, ["remote", "get-url", "origin"]);
  if (r.code !== 0) return "no origin remote";
  const got = repoPathFromRemote(r.stdout);
  return got === want ? null : `origin is ${got ?? "unparseable"}`;
}

// --- checks ------------------------------------------------------------------

/**
 * One row per (project, branch key) from the rows every clone reported (B3).
 * Each clone reports only what it proves, so the merge keeps proof over
 * silence: a sha any clone has, its merge answer from the clones that have it
 * (merged in any wins over not-merged in a clone that has not pulled), and
 * "branch gone" when any clone proved it, else "present" when any saw it.
 */
export function mergeCloneResults(results: BranchCheckResult[]): BranchCheckResult[] {
  const byKey = new Map<string, BranchCheckResult[]>();
  for (const r of results) {
    const k = `${r.code_project_id}\n${r.branch}`;
    byKey.set(k, [...(byKey.get(k) ?? []), r]);
  }
  const tri = (vals: Array<boolean | null>): boolean | null =>
    vals.includes(true) ? true : vals.includes(false) ? false : null;
  return [...byKey.values()].map((rows) => {
    if (rows.length === 1) return rows[0];
    const withSha = rows.filter((r) => r.last_seen_sha !== null);
    const merged = tri(withSha.map((r) => r.merged_into_default));
    const decider = withSha.find((r) => r.merged_into_default === merged) ?? withSha[0] ?? rows[0];
    return {
      ...decider,
      default_branch: decider.default_branch ?? rows.find((r) => r.default_branch)?.default_branch ?? null,
      last_seen_sha: withSha[0]?.last_seen_sha ?? null,
      merged_into_default: withSha.length > 0 ? merged : null,
      sha_superseded_by: rows.find((r) => r.sha_superseded_by)?.sha_superseded_by ?? null,
      branch_gone: tri(rows.map((r) => r.branch_gone)),
    };
  });
}

export interface DefaultBranch {
  name: string;
  /** Full ref the ancestor check compares against (remote-tracking when it exists, else local). */
  ref: string;
}

export async function resolveDefaultBranch(git: GitRunner, dir: string): Promise<DefaultBranch | null> {
  const head = await git(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0) {
    const short = head.stdout.trim(); // "origin/main"
    const name = short.replace(/^origin\//, "");
    if (name) return { name, ref: `refs/remotes/origin/${name}` };
  }
  for (const name of ["main", "master"]) {
    for (const ref of [`refs/remotes/origin/${name}`, `refs/heads/${name}`]) {
      const r = await git(dir, ["show-ref", "--verify", "--quiet", ref]);
      if (r.code === 0) return { name, ref };
    }
  }
  return null;
}

/**
 * Check every branch key of every repo in one group. Results are keyed by
 * (project, branch key); the newest planned sha per branch is what gets the
 * ancestor check (B6's superseded-sha rule). A newest planned sha this
 * checkout does not have is unknown — every sha field is null — because it
 * may simply live in another clone; the rewrite case is already known on the
 * server from the session's own `rewrote` action.
 */
export async function checkRepoGroup(
  group: RepoGroup,
  git: GitRunner,
  env: NodeJS.ProcessEnv,
  log: (m: string) => void,
): Promise<BranchCheckResult[]> {
  const { dir } = group;
  const fetchAllowed = env.MEMBRAL_SWEEP_FETCH === "1";
  /** true = ref present, false = absent (show-ref exit 1 only), null = git failed / timed out. */
  const refPresent = async (ref: string): Promise<boolean | null> => {
    const r = await git(dir, ["show-ref", "--verify", "--quiet", ref]);
    return r.code === 0 ? true : r.code === 1 ? false : null;
  };
  // Branch keys whose remote-tracking ref this clone had before the fetch:
  // origin had them, so absent on origin after `fetch --prune` is "deleted" (B6).
  const trackedBeforeFetch = new Set<string>();
  if (fetchAllowed) {
    for (const repo of group.repos) {
      for (const key of new Set([...repo.branches, ...repo.shas.map((s) => s.branch)])) {
        if (key.startsWith(DETACHED_BRANCH_PREFIX) || trackedBeforeFetch.has(key)) continue;
        if ((await refPresent(`refs/remotes/origin/${key}`)) === true) trackedBeforeFetch.add(key);
      }
    }
    const f = await git(dir, ["fetch", "--quiet", "--prune", "origin"]);
    if (f.code !== 0) {
      log(`sweep: git fetch failed in ${dir} — checking against the last fetched state`);
      trackedBeforeFetch.clear();
    }
  }
  const def = await resolveDefaultBranch(git, dir);
  if (!def) log(`sweep: ${dir} has no main/master or origin/HEAD — merge checks report unknown`);

  const existsCache = new Map<string, boolean>();
  const shaExists = async (sha: string): Promise<boolean> => {
    const cached = existsCache.get(sha);
    if (cached !== undefined) return cached;
    const r = await git(dir, ["cat-file", "-e", `${sha}^{commit}`]);
    const ok = r.code === 0;
    existsCache.set(sha, ok);
    return ok;
  };
  const ancestorCache = new Map<string, boolean | null>();
  const mergedIntoDefault = async (sha: string): Promise<boolean | null> => {
    if (!def) return null;
    const cached = ancestorCache.get(sha);
    if (cached !== undefined) return cached;
    const r = await git(dir, ["merge-base", "--is-ancestor", sha, def.ref]);
    const v = r.code === 0 ? true : r.code === 1 ? false : null;
    ancestorCache.set(sha, v);
    return v;
  };
  const results: BranchCheckResult[] = [];
  for (const repo of group.repos) {
    const shasByBranch = new Map<string, string[]>();
    for (const s of repo.shas) {
      const sha = s.sha.toLowerCase();
      if (!SHA_RE.test(sha)) continue;
      const list = shasByBranch.get(s.branch) ?? [];
      list.push(sha);
      shasByBranch.set(s.branch, list);
    }
    const keys = new Set<string>([...repo.branches, ...shasByBranch.keys()]);
    const known = new Map((repo.known ?? []).map((k) => [k.branch, k]));

    for (const key of keys) {
      const planned = shasByBranch.get(key) ?? [];
      const detached = key.startsWith(DETACHED_BRANCH_PREFIX);

      // Only the newest planned sha decides. Present here → its own ancestor
      // check. Missing here → unknown; never the branch head's answer.
      const newestPlanned = planned.length > 0 ? planned[planned.length - 1] : null;
      let candidate: string | null = null;
      // A branch-only key (no sha named) never gets a merge answer: the local
      // head may be another machine's same-named branch, or one freshly cut
      // from main that is trivially "merged". Only a named sha can close.
      if (newestPlanned !== null && (await shaExists(newestPlanned))) candidate = newestPlanned;

      let branchGone: boolean | null = null;
      if (!detached) {
        const local = await refPresent(`refs/heads/${key}`);
        const tracking = await refPresent(`refs/remotes/origin/${key}`);
        if (tracking === true) {
          branchGone = false;
        } else if (tracking === false && fetchAllowed) {
          // "Gone" only on positive evidence: origin itself has no
          // refs/heads/<key> AND it once existed — this clone tracked it
          // before the fetch pruned it, or (no local branch left) the
          // server's row or this clone holds the session's sha for it. A
          // local branch alone may never have been pushed, so it is "present".
          // Without fetch, a branch this checkout never fetched (pushed from
          // another machine) looks identical to a deleted one — so null.
          const remote = await git(dir, ["ls-remote", "--heads", "origin", `refs/heads/${key}`]);
          if (remote.code === 0 && remote.stdout.trim() !== "") branchGone = false;
          else if (remote.code === 0 && trackedBeforeFetch.has(key)) branchGone = true;
          else if (local === true) branchGone = false;
          else if (remote.code === 0 && local === false && (known.get(key)?.last_seen_sha || candidate))
            branchGone = true;
        } else if (local === true) {
          branchGone = false;
        }
      }

      results.push({
        code_project_id: repo.codeProjectId,
        branch: key,
        default_branch: def?.name ?? null,
        last_seen_sha: candidate,
        merged_into_default: candidate ? await mergedIntoDefault(candidate) : null,
        sha_superseded_by: null,
        branch_gone: branchGone,
      });
    }
  }
  return results;
}

// --- entry point -------------------------------------------------------------

export interface BranchStateCheckOutcome {
  /** False only when the server could not be reached or refused; the sweep never fails on it. */
  ok: boolean;
  /** True when the server was asked (a missing API key means nothing ran). */
  ran: boolean;
  /** Branch rows reported to the server this run. */
  checked: number;
  repos: number;
  skippedRepos: number;
}

export interface BranchStateCheckOptions {
  flags?: UploadFlags;
  fetchImpl?: typeof fetch;
  /** One policy client for both calls; default: built from the resolved flags, logging through logLine. */
  client?: ApiClient;
  git?: GitRunner;
  execFileImpl?: ExecFileLike;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

/** Runs the whole check. Never throws: every failure is one logged line and an outcome. */
export async function runBranchStateCheck(
  opts: BranchStateCheckOptions = {},
  logLine: (message: string) => void = console.log,
): Promise<BranchStateCheckOutcome> {
  const none: BranchStateCheckOutcome = { ok: true, ran: false, checked: 0, repos: 0, skippedRepos: 0 };
  const config = resolveUploadConfig(opts.flags ?? {});
  if (!config.apiKey) return none;
  const client =
    opts.client ??
    createUploadClient(config, { log: logLine, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
  const git = opts.git ?? createGitRunner(opts.execFileImpl);
  const env = opts.env ?? process.env;

  let repos: RepoRefsToCheck[];
  try {
    repos = await fetchRefsToCheck(config, undefined, client);
  } catch (err) {
    logLine(`sweep: refs-to-check request failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ...none, ok: false };
  }
  if (repos.length === 0) return { ...none, ran: true };

  const { groups, skippedRepos } = await groupReposByCommonDir(repos, git, logLine);
  const perClone: BranchCheckResult[] = [];
  for (const group of groups) {
    try {
      perClone.push(...(await checkRepoGroup(group, git, env, logLine)));
    } catch (err) {
      logLine(
        `sweep: ref checks failed in ${group.dir} — skipped (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  }
  const results = mergeCloneResults(perClone);

  const outcome: BranchStateCheckOutcome = {
    ok: true,
    ran: true,
    checked: results.length,
    repos: groups.length,
    skippedRepos,
  };
  if (results.length === 0) return outcome;
  try {
    const posted = await postBranchState(
      config,
      results,
      (opts.now ?? (() => new Date()))().toISOString(),
      undefined,
      client,
    );
    logLine(
      `sweep: ref checks — ${results.length} branch(es) in ${groups.length} repo(s) reported (${posted.upserted} stored${posted.rejected ? `, ${posted.rejected} rejected` : ""})`,
    );
  } catch (err) {
    logLine(`sweep: branch-state upload failed: ${err instanceof Error ? err.message : String(err)}`);
    return { ...outcome, ok: false };
  }
  return outcome;
}
