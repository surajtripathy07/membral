// Goal 2026-09-26 W5 / P3 (D-051): observed blocker retirement.
//
// Before the later-session resolution check spends an LLM call
// (`checkLaterBlockerResolutions`), an open blocker from an EARLIER session
// is retired as `resolved_observed` when THIS (later) session observed its
// CLOSURE (maintainer decision 2026-09-27: closure evidence only):
//   - an issue/MR ref: an action on the SAME ref whose verb is `merged` /
//     `closed`, or whose forge `state` is `merged` / `closed`;
//   - a branch ref: an action that merged/closed on that branch, or the
//     branch's `memory_branch_state` row says it was merged into the default
//     branch AND the branch is gone.
// `committed`, `pushed`, `opened_mr` and edits are never closure — a WIP
// commit "refs #42" leaves the blocker on #42 open. The earlier edit + commit
// path rule is gone (a bare filename matched any file of that name); a
// blocker with only `paths` goes to the LLM check.
// Same-ref means same repo: a bare `#42` / `!42` (blocker or action) is the
// session's OWN repo, and project-qualified refs compare host-stripped
// `owner/repo` (never across projects). B2: observed beats inferred, so this
// runs first and the model is never asked about a blocker the tool calls
// already closed. B6: the receipt is the closing action's turn.
//
// Pure: no fs, no network, no throwing. A malformed `props.action` (B12 —
// a string, an object without a verb, a verb of the wrong type) yields no
// action, never an error.

export { RESOLVED_OBSERVED_RETIRE_REASON } from "@/lib/domain/retire-reasons";

/** Verbs on the blocker's own ref that count as observed closure (closure evidence only). */
export const OBSERVED_REF_CLOSURE_VERBS: readonly string[] = ["merged", "closed"];

/** Forge states (an action's `state`, e.g. a `viewed` whose result showed the MR merged) that count as closure. */
export const OBSERVED_CLOSURE_STATES: readonly string[] = ["merged", "closed"];

const HEX_SHA = /^(?=.*[a-f])[0-9a-f]{7,40}$/i;
/** `host/group/sub/repo#12`, `owner/repo#12`, `#12`, `owner/repo!7`, `!7` — an issue or merge-request ref, project-qualified or bare. */
const FORGE_REF = /^(?:([\w.-]+(?:\/[\w.-]+)+))?([#!])(\d+)$/;

/** Branch closure from `memory_branch_state` (migration 084): merged into the default branch, then gone. */
export interface ObservedBranchState {
  branch: string;
  merged_at: string | null;
  branch_gone_at: string | null;
}

export interface ObservedRetirementOptions {
  /** The session's repo identity (`code_projects.repo_identity`, e.g. `github.com/acme/app`); a bare ref resolves to it. Null when unknown — then bare refs only match bare refs. */
  repoIdentity?: string | null;
  /** The project's branch-state rows; a blocker on a branch merged AND gone is closed. */
  branchStates?: ReadonlyArray<ObservedBranchState>;
}

export interface ObservedRetirementCandidate {
  id: string;
  /** The blocker's own ref (`session_memories.ref`): `#42`, `acme/billing!17`, a sha, a branch — or null. */
  ref: string | null;
  /** Repo-relative paths the blocker names (`session_memories.paths`); null/undefined when none. */
  paths: string[] | null | undefined;
}

export interface ObservedRetirementTurn {
  idx: number;
  tool_name: string | null;
  file_path: string | null;
  /** `code_session_turns.props` as stored — read defensively, never trusted for shape. */
  props: unknown;
}

export interface ObservedRetirement {
  memoryId: string;
  /** The turn of THIS session carrying the closing action — the receipt (`resolution_turn_idx`). */
  turnIdx: number;
  /** Short, fixed-shape receipt text for `resolution_quote`, e.g. `committed acme/billing!17` or `edited src/a.ts, committed`. Never transcript text. */
  evidence: string;
}

interface ObservedAction {
  turnIdx: number;
  verb: string;
  ref?: string;
  refKind?: string;
  sha?: string;
  branch?: string;
  state?: string;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function toAction(turnIdx: number, raw: unknown): ObservedAction | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const verb = asString(o.verb);
  if (!verb) return null;
  // D-051 F1: closure evidence from another directory whose repo nothing named retires nothing here.
  if (o.repoUnknown === true) return null;
  return {
    turnIdx,
    verb,
    ref: asString(o.ref),
    refKind: asString(o.refKind),
    sha: asString(o.sha),
    branch: asString(o.branch),
    state: asString(o.state),
  };
}

/** Every structured action on a turn's props (`action`, then `actions[]`), in turn order. Malformed props contribute nothing (B12). */
export function collectObservedActions(turns: ReadonlyArray<ObservedRetirementTurn>): ObservedAction[] {
  const out: ObservedAction[] = [];
  for (const t of turns) {
    try {
      if (!t.props || typeof t.props !== "object") continue;
      const props = t.props as Record<string, unknown>;
      const single = toAction(t.idx, props.action);
      if (single) out.push(single);
      if (Array.isArray(props.actions)) {
        for (const a of props.actions) {
          const parsed = toAction(t.idx, a);
          if (parsed && !(single && sameAction(single, parsed))) out.push(parsed);
        }
      }
    } catch {
      // B12: a turn whose props cannot be read yields no action.
    }
  }
  return out;
}

function sameAction(a: ObservedAction, b: ObservedAction): boolean {
  return a.verb === b.verb && a.ref === b.ref && a.sha === b.sha && a.branch === b.branch;
}

interface ParsedForgeRef {
  /** Host-stripped, lower-cased `owner/repo` (or `group/sub/repo`); null for a bare `#N`. */
  project: string | null;
  short: string;
}

/**
 * `github.com/Acme/App` -> `acme/app`; `acme/app` -> `acme/app`. A first
 * segment with a dot (a host) is dropped when at least owner/repo follow.
 */
export function stripRepoHost(identity: string): string {
  const segs = identity
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")
    .filter(Boolean);
  if (segs.length >= 3 && segs[0].includes(".")) segs.shift();
  return segs.join("/");
}

function parseForgeRef(ref: string): ParsedForgeRef | null {
  const m = FORGE_REF.exec(ref.trim());
  if (!m) return null;
  return { project: m[1] ? stripRepoHost(m[1]) : null, short: `${m[2]}${m[3]}` };
}

/** The session's own repo as `owner/repo`, or null when unknown (a synthetic `code-project:<id>` identity is not a repo). */
function ownRepoOf(repoIdentity: string | null | undefined): string | null {
  if (!repoIdentity || repoIdentity.startsWith("code-project:")) return null;
  const stripped = stripRepoHost(repoIdentity);
  return stripped.includes("/") ? stripped : null;
}

/**
 * Does `action` name the blocker's `ref`? Issue/MR refs match on the
 * `#N`/`!N` token AND the same repo: a bare side resolves to `repoIdentity`
 * (the session's own repo), a qualified side compares host-stripped
 * `owner/repo`. With no known repo, bare matches bare only. Shas match by
 * 7+ char prefix either way. Anything else (a branch name) must match
 * exactly against the action's `ref` or `branch`.
 */
export function actionNamesRef(
  action: { ref?: string; sha?: string; branch?: string },
  blockerRef: string,
  repoIdentity?: string | null,
): boolean {
  const target = blockerRef.trim();
  if (!target) return false;
  const forge = parseForgeRef(target);
  if (forge) {
    const theirs = action.ref ? parseForgeRef(action.ref) : null;
    if (!theirs || theirs.short !== forge.short) return false;
    const own = ownRepoOf(repoIdentity);
    const mine = forge.project ?? own;
    const other = theirs.project ?? own;
    if (mine === null && other === null) return forge.project === null && theirs.project === null;
    return mine !== null && mine === other;
  }
  if (HEX_SHA.test(target)) {
    const lower = target.toLowerCase();
    return [action.sha, action.ref].some((s) => {
      if (!s || !HEX_SHA.test(s)) return false;
      const other = s.toLowerCase();
      const n = Math.min(lower.length, other.length);
      return n >= 7 && lower.slice(0, n) === other.slice(0, n);
    });
  }
  return action.branch?.trim() === target || action.ref?.trim() === target;
}

/** An action that observed closure: a `merged`/`closed` verb, or a forge state that says so. */
function isClosure(a: ObservedAction): boolean {
  return (
    OBSERVED_REF_CLOSURE_VERBS.includes(a.verb) ||
    (a.state !== undefined && OBSERVED_CLOSURE_STATES.includes(a.state.toLowerCase()))
  );
}

/**
 * Which open blockers THIS session observed CLOSED. Per blocker, the first
 * hit is the receipt:
 *
 *  1. ref — a closure action (`isClosure`) whose ref/sha/branch names the
 *     blocker's `ref` in the same repo (`actionNamesRef`).
 *  2. branch — the blocker's `ref` is a branch whose branch-state row says
 *     merged AND gone; the receipt is this session's last turn.
 *
 * A blocker with no ref (paths only) is never retired here — it goes to the
 * LLM check. Never throws.
 */
export function findObservedRetirements(
  candidates: ReadonlyArray<ObservedRetirementCandidate>,
  turns: ReadonlyArray<ObservedRetirementTurn>,
  opts: ObservedRetirementOptions = {},
): ObservedRetirement[] {
  if (candidates.length === 0 || turns.length === 0) return [];
  const closures = collectObservedActions(turns).filter(isClosure);
  const closedBranches = new Map<string, ObservedBranchState>();
  for (const b of opts.branchStates ?? []) {
    if (b && typeof b.branch === "string" && b.branch && b.merged_at && b.branch_gone_at)
      closedBranches.set(b.branch, b);
  }
  if (closures.length === 0 && closedBranches.size === 0) return [];
  const lastIdx = turns.reduce((m, t) => Math.max(m, t.idx), Number.NEGATIVE_INFINITY);

  const out: ObservedRetirement[] = [];
  for (const c of candidates) {
    try {
      if (typeof c.ref !== "string" || !c.ref.trim()) continue;
      const ref = c.ref.trim();
      const byRef = closures.find((a) => actionNamesRef(a, ref, opts.repoIdentity));
      if (byRef) {
        const word = OBSERVED_REF_CLOSURE_VERBS.includes(byRef.verb)
          ? byRef.verb
          : (byRef.state ?? byRef.verb).toLowerCase();
        out.push({ memoryId: c.id, turnIdx: byRef.turnIdx, evidence: `${word} ${ref}` });
        continue;
      }
      if (!parseForgeRef(ref) && !HEX_SHA.test(ref) && closedBranches.has(ref) && Number.isFinite(lastIdx)) {
        out.push({ memoryId: c.id, turnIdx: lastIdx, evidence: `branch ${ref} merged, then deleted` });
      }
    } catch {
      // B12: a malformed candidate is left for the LLM check.
    }
  }
  return out;
}
