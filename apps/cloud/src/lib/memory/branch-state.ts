// Ref-keyed branch state (goal 2026-09-26 W6 / P4, B4, B6, B9, B14, D-051).
//
// The dashboard needs to know, for a ref a session delivered on, whether
// the harness's own commit ever reached the default branch or its branch
// went away — closure evidence Membral never sees inside a transcript (the
// merge happens on the forge, or in another terminal). The only thing that
// can prove it is a read-only, REF-KEYED question to the developer's own git
// checkout, so the split is:
//
//   server (this module)  -> "refs to check": per repo, the shas a session
//                            committed, the branches it pushed/checked out,
//                            the MRs it opened and never saw closed — taken
//                            ONLY from `code_session_turns.props.action(s)`
//                            (W3's observed forge actions), never from a
//                            model's reading and never from a time range
//   `membral sweep` (CLI)  -> runs `git cat-file -e`, `git merge-base
//                            --is-ancestor`, `git show-ref --verify`,
//                            `git ls-remote --heads` keyed by those shas and
//                            branches (no `--since`, no reflog by date: B4)
//   server (this module)  -> upserts the answers into `memory_branch_state`
//                            (migration 084) so `listOpenThreads` (W7) can
//                            read them without touching git.
//
// B6's superseded-sha rule: a `rewrote` action (rebase, amend, reset, force
// push) supersedes every sha a session earlier named on that branch; the
// closure check moves to the newest sha per branch, so superseded shas are
// dropped from the plan here. A sha that then fails `cat-file -e` while its
// branch still exists is "rewritten", never evidence — the CLI reports it
// as `sha_superseded_by: <branch head>` and `merged_into_default: null`.
//
// Storage mapping (migration 084 has one row per (user, project, branch);
// no new columns are added by this goal):
//   branch key      = the action's branch, else the session's git_branch,
//                     else `commit:<sha>` (a sha nothing tied to a branch)
//   last_seen_sha   = the newest sha that exists for that branch
//                     (`sha_superseded_by` moves it forward on a rewrite)
//   merged_into     = the default branch name once `merge-base
//                     --is-ancestor` says yes — never cleared by a later
//                     "no" (a merge is permanent; a "no" is just "not yet")
//   merged_at       = first check that proved the merge
//   branch_gone_at  = first check that proved the branch gone; cleared when
//                     a later check finds it again. Without MEMBRAL_SWEEP_FETCH
//                     the CLI can only say "gone" for a branch the stored row
//                     already carries a sha for (an earlier check saw its
//                     commits in that checkout); a branch never fetched there
//                     reports null, and null never sets this column.
//   last_seen_at    = the latest check
//
// The pure parts (planRefsToCheck, mergeBranchStateRow) take rows and
// return rows; the two thin query functions at the bottom are the only
// Supabase touch points and are tested with a minimal client double.

import { z } from "zod";
import type { Db } from "@/lib/db/types";
import { selectAllRows } from "@/lib/util/pagination";

export const BRANCH_STATE_TABLE = "memory_branch_state";
/** Sessions this many days back are scanned for actions (default); `days` is clamped to [1, MAX]. */
export const DEFAULT_BRANCH_STATE_DAYS = 30;
export const MAX_BRANCH_STATE_DAYS = 90;
/** Upper bound on one POST (a sweep reports one row per branch; 500 covers a very busy month). */
export const MAX_BRANCH_STATE_RESULTS = 500;
/** Branch key for a sha no action or session tied to a branch. */
export const DETACHED_BRANCH_PREFIX = "commit:";

const SHA_RE = /^[0-9a-f]{7,40}$/;
const IN_CHUNK = 100;

// --- rows in -----------------------------------------------------------------

export interface BranchStateProjectRow {
  id: string;
  repo_identity: string;
  repo_path: string | null;
}

export interface BranchStateSessionRow {
  id: string;
  code_project_id: string;
  cwd: string | null;
  git_branch: string | null;
  started_at: string | null;
}

export interface BranchStateTurnRow {
  session_id: string;
  idx: number;
  props: Record<string, unknown> | null;
}

/** The subset of @membral/core's ForgeAction this module reads (kept structural: no runtime import of core). */
interface ObservedAction {
  verb: string;
  ref?: string;
  sha?: string;
  url?: string;
  branch?: string;
  state?: string;
}

// --- plan out ----------------------------------------------------------------

export interface RefsToCheckSha {
  sha: string;
  /** Branch key the CLI reports this sha under (see the header's storage mapping). */
  branch: string;
  ref: string | null;
  sessionId: string;
}

export interface RefsToCheckOpenRef {
  ref: string;
  url: string | null;
  branch: string | null;
  sessionId: string;
}

/** What `memory_branch_state` already holds for a branch key: lets the CLI tell "vanished" from "never fetched here". */
export interface RefsToCheckKnownRow {
  branch: string;
  last_seen_sha: string | null;
  branch_gone_at: string | null;
}

export interface RepoRefsToCheck {
  codeProjectId: string;
  repoIdentity: string;
  /** Distinct local checkouts sessions ran in (code_sessions.cwd, plus code_projects.repo_path); worktrees included. */
  paths: string[];
  /** Non-superseded shas in observed order (oldest first), so the last entry per branch is the newest. */
  shas: RefsToCheckSha[];
  /** Branches a session committed on, pushed, or checked out. */
  branches: string[];
  /** `opened_mr` refs with no `merged`/`closed` action seen in any session. */
  openRefs: RefsToCheckOpenRef[];
  /** Existing rows for this project's branch keys (filled by loadRefsToCheck; the planner leaves it empty). */
  known: RefsToCheckKnownRow[];
}

function readActions(props: Record<string, unknown> | null): ObservedAction[] {
  if (!props) return [];
  const list = Array.isArray(props.actions) ? props.actions : props.action ? [props.action] : [];
  const out: ObservedAction[] = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    if (typeof r.verb !== "string") continue;
    // D-051 F1: a commit/push in another directory is not this project's branch.
    if (r.repoUnknown === true) continue;
    out.push({
      verb: r.verb,
      ref: typeof r.ref === "string" ? r.ref : undefined,
      sha: typeof r.sha === "string" ? r.sha.toLowerCase() : undefined,
      url: typeof r.url === "string" ? r.url : undefined,
      branch: typeof r.branch === "string" ? r.branch : undefined,
      state: typeof r.state === "string" ? r.state : undefined,
    });
  }
  return out;
}

function branchKeyFor(action: ObservedAction, session: BranchStateSessionRow, sha: string): string {
  return action.branch ?? session.git_branch ?? `${DETACHED_BRANCH_PREFIX}${sha}`;
}

/**
 * Pure: turn the caller's sessions + their action-bearing turns into one
 * "refs to check" entry per project. Takes only rows, never the clock, and
 * orders turns by (session start, idx) purely to apply the superseded-sha
 * rule within a branch — two sessions overlapping in the same cwd never mix
 * refs, because every sha/branch keeps the ref its own turn named (B4).
 */
export function planRefsToCheck(input: {
  projects: BranchStateProjectRow[];
  sessions: BranchStateSessionRow[];
  turns: BranchStateTurnRow[];
}): RepoRefsToCheck[] {
  const projects = new Map(input.projects.map((p) => [p.id, p]));
  const sessions = new Map(input.sessions.map((s) => [s.id, s]));
  const sessionOrder = new Map<string, number>();
  [...input.sessions]
    .sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? "") || a.id.localeCompare(b.id))
    .forEach((s, i) => sessionOrder.set(s.id, i));

  const turns = input.turns
    .filter((t) => sessions.has(t.session_id))
    .sort((a, b) => (sessionOrder.get(a.session_id) ?? 0) - (sessionOrder.get(b.session_id) ?? 0) || a.idx - b.idx);

  // Closure seen anywhere (any project) closes the ref everywhere: refs are
  // forge-qualified strings (`owner/repo!17`), so this needs no project key.
  const closedRefs = new Set<string>();
  for (const t of turns) {
    for (const a of readActions(t.props)) {
      if (!a.ref) continue;
      if (a.verb === "merged" || a.verb === "closed" || a.state === "merged" || a.state === "closed") {
        closedRefs.add(a.ref);
      }
    }
  }

  const byProject = new Map<
    string,
    {
      paths: Set<string>;
      shas: RefsToCheckSha[];
      branches: Set<string>;
      openRefs: Map<string, RefsToCheckOpenRef>;
    }
  >();
  const entry = (projectId: string) => {
    let e = byProject.get(projectId);
    if (!e) {
      e = { paths: new Set(), shas: [], branches: new Set(), openRefs: new Map() };
      byProject.set(projectId, e);
    }
    return e;
  };

  for (const s of input.sessions) {
    const e = entry(s.code_project_id);
    if (s.cwd) e.paths.add(s.cwd.replace(/\/+$/, "") || s.cwd);
  }

  for (const t of turns) {
    const session = sessions.get(t.session_id);
    if (!session) continue;
    const e = entry(session.code_project_id);
    for (const a of readActions(t.props)) {
      switch (a.verb) {
        case "committed": {
          if (!a.sha || !SHA_RE.test(a.sha)) break;
          const branch = branchKeyFor(a, session, a.sha);
          e.shas.push({ sha: a.sha, branch, ref: a.ref ?? null, sessionId: session.id });
          if (!branch.startsWith(DETACHED_BRANCH_PREFIX)) e.branches.add(branch);
          break;
        }
        case "rewrote": {
          // B6/B14: every sha earlier named on this branch is superseded; the
          // check moves to whatever is committed next (or the branch head).
          const branch = a.branch ?? session.git_branch;
          if (!branch) break;
          e.shas = e.shas.filter((x) => x.branch !== branch);
          e.branches.add(branch);
          if (a.sha && SHA_RE.test(a.sha)) {
            e.shas.push({ sha: a.sha, branch, ref: a.ref ?? null, sessionId: session.id });
          }
          break;
        }
        case "pushed":
        case "checked_out": {
          const branch = a.branch ?? (a.verb === "pushed" ? session.git_branch : undefined);
          if (branch) e.branches.add(branch);
          break;
        }
        case "opened_mr": {
          if (!a.ref || closedRefs.has(a.ref) || e.openRefs.has(a.ref)) break;
          e.openRefs.set(a.ref, {
            ref: a.ref,
            url: a.url ?? null,
            branch: a.branch ?? session.git_branch ?? null,
            sessionId: session.id,
          });
          break;
        }
        default:
          break;
      }
    }
  }

  const out: RepoRefsToCheck[] = [];
  for (const [projectId, e] of byProject) {
    const project = projects.get(projectId);
    if (!project) continue;
    if (project.repo_path) e.paths.add(project.repo_path.replace(/\/+$/, "") || project.repo_path);
    if (e.shas.length === 0 && e.branches.size === 0 && e.openRefs.size === 0) continue;
    out.push({
      codeProjectId: projectId,
      repoIdentity: project.repo_identity,
      paths: [...e.paths].sort(),
      shas: e.shas,
      branches: [...e.branches].sort(),
      openRefs: [...e.openRefs.values()],
      known: [],
    });
  }
  return out.sort((a, b) => a.repoIdentity.localeCompare(b.repoIdentity));
}

/** `?repo=` filter: a repo identity or one of its local paths (trailing slashes ignored). */
export function filterReposToCheck(repos: RepoRefsToCheck[], repo: string | null | undefined): RepoRefsToCheck[] {
  if (!repo) return repos;
  const wanted = repo.replace(/\/+$/, "") || repo;
  return repos.filter((r) => r.repoIdentity === wanted || r.paths.includes(wanted));
}

// --- results in --------------------------------------------------------------

export const BranchCheckResultSchema = z.object({
  code_project_id: z.string().uuid(),
  /** Branch key (see header); `commit:<sha>` for a sha tied to no branch. */
  branch: z.string().min(1).max(300),
  default_branch: z.string().min(1).max(300).nullable(),
  /** Newest sha of this branch that still exists in the checkout, when known. */
  last_seen_sha: z.string().regex(SHA_RE).nullable(),
  /** `git merge-base --is-ancestor <last_seen_sha> <default>`: true/false, or null when it could not be run. */
  merged_into_default: z.boolean().nullable(),
  /** Set when the planned sha failed `cat-file -e` while the branch still exists: the branch's current head. */
  sha_superseded_by: z.string().regex(SHA_RE).nullable(),
  /** `show-ref --verify refs/heads/<branch>` (and remote checks): true = gone, false = present, null = unknown. */
  branch_gone: z.boolean().nullable(),
});
export type BranchCheckResult = z.infer<typeof BranchCheckResultSchema>;

export const BranchStatePostSchema = z.object({
  checked_at: z.string().datetime(),
  results: z.array(BranchCheckResultSchema).max(MAX_BRANCH_STATE_RESULTS),
});
export type BranchStatePostBody = z.infer<typeof BranchStatePostSchema>;

export interface BranchStateRow {
  user_id: string;
  code_project_id: string;
  branch: string;
  last_seen_sha: string | null;
  merged_into: string | null;
  merged_at: string | null;
  branch_gone_at: string | null;
  last_seen_at: string;
}

/**
 * Pure: fold one check result into the stored row (or a fresh one). Evidence
 * only ever strengthens: `merged_into` is set on the first "yes" and never
 * cleared by a later "no" or "unknown"; `branch_gone_at` is set on the first
 * proof and cleared only by a positive "the branch is back".
 */
export function mergeBranchStateRow(
  existing: BranchStateRow | null,
  result: BranchCheckResult,
  userId: string,
  checkedAt: string,
): BranchStateRow {
  const row: BranchStateRow = existing
    ? { ...existing, last_seen_at: checkedAt }
    : {
        user_id: userId,
        code_project_id: result.code_project_id,
        branch: result.branch,
        last_seen_sha: null,
        merged_into: null,
        merged_at: null,
        branch_gone_at: null,
        last_seen_at: checkedAt,
      };
  // The superseded-sha rule: the checked sha moves forward, never back.
  const newest = result.sha_superseded_by ?? result.last_seen_sha;
  if (newest) row.last_seen_sha = newest;
  if (result.merged_into_default === true) {
    row.merged_into = result.default_branch ?? row.merged_into ?? "default";
    row.merged_at = row.merged_at ?? checkedAt;
  }
  // `null` ("this checkout cannot tell") neither sets nor clears the proof.
  if (result.branch_gone === true) {
    row.branch_gone_at = row.branch_gone_at ?? checkedAt;
  } else if (result.branch_gone === false) {
    row.branch_gone_at = null;
  }
  return row;
}

// --- queries -----------------------------------------------------------------

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function resolveBranchStateDays(raw: string | null | undefined): number {
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n)) return DEFAULT_BRANCH_STATE_DAYS;
  return Math.min(MAX_BRANCH_STATE_DAYS, Math.max(1, n));
}

/**
 * Load the caller's sessions started in the window, their projects and their
 * action-bearing turns, then plan. The window bounds WHICH SESSIONS are read
 * (a database predicate on `code_sessions.started_at`); no git command ever
 * sees it (B4).
 */
export async function loadRefsToCheck(
  supabase: Db,
  userId: string,
  opts: { days?: number; now?: Date; repo?: string | null } = {},
): Promise<RepoRefsToCheck[]> {
  const days = opts.days ?? DEFAULT_BRANCH_STATE_DAYS;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();

  const sessions = await selectAllRows<BranchStateSessionRow>((from, to) =>
    supabase
      .from("code_sessions")
      .select("id, code_project_id, cwd, git_branch, started_at")
      .eq("user_id", userId)
      .gte("started_at", since)
      .order("started_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to),
  );
  if (sessions.length === 0) return [];

  const projectIds = [...new Set(sessions.map((s) => s.code_project_id))];
  const projects: BranchStateProjectRow[] = [];
  for (const ids of chunk(projectIds, IN_CHUNK)) {
    const res = await supabase
      .from("code_projects")
      .select("id, repo_identity, repo_path")
      .eq("user_id", userId)
      .in("id", ids);
    if (res.error) throw new Error(`branch-state: code_projects read failed: ${res.error.message}`);
    projects.push(...((res.data ?? []) as BranchStateProjectRow[]));
  }

  const turns: BranchStateTurnRow[] = [];
  for (const ids of chunk(
    sessions.map((s) => s.id),
    IN_CHUNK,
  )) {
    const page = await selectAllRows<BranchStateTurnRow>((from, to) =>
      supabase
        .from("code_session_turns")
        .select("session_id, idx, props")
        .eq("user_id", userId)
        .in("session_id", ids)
        .not("props->action", "is", null)
        .order("session_id", { ascending: true })
        .order("idx", { ascending: true })
        .range(from, to),
    );
    turns.push(...page);
  }

  const repos = filterReposToCheck(planRefsToCheck({ projects, sessions, turns }), opts.repo);
  if (repos.length === 0) return repos;

  // What the store already holds for the planned branch keys, so the CLI can
  // tell a branch that vanished from one it never fetched (see the header).
  const known = new Map<string, RefsToCheckKnownRow[]>();
  for (const ids of chunk(
    repos.map((r) => r.codeProjectId),
    IN_CHUNK,
  )) {
    const res = await supabase
      .from(BRANCH_STATE_TABLE)
      .select("code_project_id, branch, last_seen_sha, branch_gone_at")
      .eq("user_id", userId)
      .in("code_project_id", ids);
    if (res.error) throw new Error(`branch-state: read failed: ${res.error.message}`);
    for (const row of (res.data ?? []) as (RefsToCheckKnownRow & { code_project_id: string })[]) {
      const list = known.get(row.code_project_id) ?? [];
      list.push({ branch: row.branch, last_seen_sha: row.last_seen_sha, branch_gone_at: row.branch_gone_at });
      known.set(row.code_project_id, list);
    }
  }
  for (const repo of repos) {
    const keys = new Set<string>([...repo.branches, ...repo.shas.map((s) => s.branch)]);
    repo.known = (known.get(repo.codeProjectId) ?? [])
      .filter((k) => keys.has(k.branch))
      .sort((a, b) => a.branch.localeCompare(b.branch));
  }
  return repos;
}

export interface UpsertBranchStateOutcome {
  upserted: number;
  /** Results dropped because their project is not the caller's (never written). */
  rejected: number;
}

/** Fold the sweep's results into `memory_branch_state` for the caller's own projects only. */
export async function upsertBranchState(
  supabase: Db,
  userId: string,
  body: BranchStatePostBody,
): Promise<UpsertBranchStateOutcome> {
  if (body.results.length === 0) return { upserted: 0, rejected: 0 };

  const projectIds = [...new Set(body.results.map((r) => r.code_project_id))];
  const owned = new Set<string>();
  for (const ids of chunk(projectIds, IN_CHUNK)) {
    const res = await supabase.from("code_projects").select("id").eq("user_id", userId).in("id", ids);
    if (res.error) throw new Error(`branch-state: code_projects ownership read failed: ${res.error.message}`);
    for (const row of (res.data ?? []) as { id: string }[]) owned.add(row.id);
  }
  const accepted = body.results.filter((r) => owned.has(r.code_project_id));
  const rejected = body.results.length - accepted.length;
  if (accepted.length === 0) return { upserted: 0, rejected };

  const existing = new Map<string, BranchStateRow>();
  for (const ids of chunk([...owned], IN_CHUNK)) {
    const res = await supabase
      .from(BRANCH_STATE_TABLE)
      .select("user_id, code_project_id, branch, last_seen_sha, merged_into, merged_at, branch_gone_at, last_seen_at")
      .eq("user_id", userId)
      .in("code_project_id", ids);
    if (res.error) throw new Error(`branch-state: read failed: ${res.error.message}`);
    for (const row of (res.data ?? []) as BranchStateRow[]) existing.set(`${row.code_project_id}\n${row.branch}`, row);
  }

  // Two results for one (project, branch) in a single POST fold in order.
  const merged = new Map<string, BranchStateRow>();
  for (const result of accepted) {
    const key = `${result.code_project_id}\n${result.branch}`;
    const base = merged.get(key) ?? existing.get(key) ?? null;
    merged.set(key, mergeBranchStateRow(base, result, userId, body.checked_at));
  }

  const rows = [...merged.values()];
  for (const batch of chunk(rows, IN_CHUNK)) {
    const res = await supabase.from(BRANCH_STATE_TABLE).upsert(batch, { onConflict: "user_id,code_project_id,branch" });
    if (res.error) throw new Error(`branch-state: upsert failed: ${res.error.message}`);
  }
  return { upserted: rows.length, rejected };
}
