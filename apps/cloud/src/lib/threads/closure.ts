// Closure detection for open threads (G2 step 2.5). `computeThreads` asks each
// detector in CLOSURE_DETECTORS, in order, and the first non-null answer is the
// thread's closure — strongest evidence first. Each detector is pure: it reads
// the context and never writes to it.

import { BUILD_RANK } from "@/lib/domain/ladder";
import type {
  FoldedRow,
  ObservedAction,
  Pos,
  ThreadBranchStateRow,
  ThreadClosure,
  ThreadSessionRow,
} from "@/lib/threads/open-threads";

export function rank(table: Record<string, number>, verb: string | null | undefined): number {
  return verb ? (table[verb] ?? 0) : 0;
}

function isClosureVerb(a: ObservedAction): boolean {
  return a.verb === "merged" || a.verb === "closed" || a.state === "merged" || a.state === "closed";
}

export function timeOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

export function cmpPos(a: Pos, b: Pos): number {
  if (a.t !== b.t) return a.t - b.t;
  if (a.sid !== b.sid) return a.sid < b.sid ? -1 : 1;
  return a.idx - b.idx;
}

/** The locals of one thread in `computeThreads` that the closure detectors read. */
export interface ClosureContext {
  actions: readonly { session_id: string; owner: string; idx: number; pos: Pos; a: ObservedAction }[];
  /** The last observed build action (committed/pushed/opened_mr) on the thread. */
  lastBuild: Pos | null;
  /** The latest observed reopen on the ref. */
  lastReopen: Pos | null;
  beforeReopen: (p: Pos) => boolean;
  sessions: ReadonlyMap<string, ThreadSessionRow>;
  namesThread: (x: { session_id: string; a: ObservedAction }) => boolean;
  buildSessions: ReadonlySet<string>;
  /** `${project}\n${branch}` keys the thread's sessions built on. */
  branchKeys: ReadonlySet<string>;
  keyFor: (s: ThreadSessionRow, branch: string) => string;
  /** Ascending by owner session start. */
  rows: readonly FoldedRow[];
  branchState: readonly ThreadBranchStateRow[];
  newestSha: ReadonlyMap<string, string>;
  namedShas: ReadonlyMap<string, string[]>;
  supersededShas: ReadonlyMap<string, Set<string>>;
}

export type ClosureDetector = (ctx: ClosureContext) => ThreadClosure | null;

// Closure, strongest first: an observed merged/closed on the ref itself
// (or on one of its own branches) at or after the last build action, by
// wall clock. An MR's merge never closes the issue it served (F7).
export function closureFromActions({
  actions,
  lastBuild,
  beforeReopen,
  sessions,
  namesThread,
  buildSessions,
  branchKeys,
  keyFor,
}: ClosureContext): ThreadClosure | null {
  for (const x of actions) {
    const a = x.a;
    if (!isClosureVerb(a)) continue;
    if (lastBuild && cmpPos(x.pos, lastBuild) < 0) continue;
    if (beforeReopen(x.pos)) continue;
    const s = sessions.get(x.session_id);
    const onRef = namesThread(x);
    // A child that did not act on this ref proves nothing about its branches.
    const branchWitness = x.session_id === x.owner || buildSessions.has(x.session_id);
    const onBranch =
      a.refKind === "branch" &&
      branchWitness &&
      !!s &&
      !!(a.branch ?? a.ref) &&
      branchKeys.has(keyFor(s, (a.branch ?? a.ref) as string));
    if (!onRef && !onBranch) continue;
    return {
      kind: "action",
      session_id: x.session_id,
      turn_idx: x.idx,
      verb: a.verb === "merged" || a.verb === "closed" ? a.verb : (a.state as string),
    };
  }
  return null;
}

// A row's own `merged`/`closed` rung (a session that saw closure but whose
// action turns are not in hand) closes the thread only when it is the
// LATEST build session's: a commit after a close reopens the question.
export function closureFromRowRung({ rows, sessions, lastReopen }: ClosureContext): ThreadClosure | null {
  const lastBuildRow = [...rows].reverse().find((r) => rank(BUILD_RANK, r.build_verb) >= BUILD_RANK.committed);
  // A reopen at or after that session's start voids its rung (the rung carries no position of its own).
  const rowStart = timeOf(sessions.get(lastBuildRow?.owner ?? "")?.started_at) ?? 0;
  const reopenedSince = !!lastReopen && lastReopen.t >= rowStart;
  if (
    lastBuildRow &&
    !reopenedSince &&
    (lastBuildRow.build_verb === "merged" || lastBuildRow.build_verb === "closed")
  ) {
    return {
      kind: "action",
      session_id: lastBuildRow.proof.session_id,
      turn_idx: lastBuildRow.proof.turn_idx,
      verb: lastBuildRow.build_verb,
    };
  }
  return null;
}

// Then the sweep's ref-keyed proof. It counts only when the row's
// `last_seen_sha` is a sha a session on THIS thread named on that branch
// (F10: a reused branch name with someone else's sha proves nothing):
// `merged_at` needs the newest such sha (an older one merged says nothing
// about the newest), `branch_gone_at` any non-superseded one.
export function closureFromBranchState({
  branchState,
  branchKeys,
  supersededShas,
  newestSha,
  namedShas,
  lastReopen,
}: ClosureContext): ThreadClosure | null {
  const sameSha = (a: string, b: string) => a.startsWith(b) || b.startsWith(a);
  for (const bs of branchState) {
    const k = `${bs.code_project_id}\n${bs.branch}`;
    if (!branchKeys.has(k)) continue;
    const rowSha = bs.last_seen_sha?.toLowerCase() ?? null;
    if (!rowSha) continue;
    const superseded = [...(supersededShas.get(k) ?? [])].some((sha) => sameSha(sha, rowSha));
    if (superseded) continue;
    const newest = newestSha.get(k);
    const named = (namedShas.get(k) ?? []).some((sha) => sameSha(sha, rowSha));
    const proof = (!!bs.merged_at && !!newest && sameSha(rowSha, newest)) || (!!bs.branch_gone_at && named);
    if (!proof) continue;
    // A reopen observed after the sweep's proof time voids it.
    const provedAt = timeOf(bs.merged_at) ?? timeOf(bs.branch_gone_at);
    if (lastReopen && (provedAt === null || provedAt < lastReopen.t)) continue;
    return {
      kind: "branch_state",
      code_project_id: bs.code_project_id,
      branch: bs.branch,
      merged_into: bs.merged_into,
      merged_at: bs.merged_at,
      branch_gone_at: bs.branch_gone_at,
    };
  }
  return null;
}

/** Strongest evidence first; `computeThreads` takes the first non-null. */
export const CLOSURE_DETECTORS: readonly ClosureDetector[] = [
  closureFromActions,
  closureFromRowRung,
  closureFromBranchState,
];
