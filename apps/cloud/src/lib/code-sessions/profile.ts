// Session profile — goal 2026-09-26 W4 / P2 (D-051).
//
// Pure: `buildProfile(turns)` folds a session's turns (as `code_session_turns`
// rows, or the parser's RawTurns mapped to that shape) into per-ref facts that
// come ONLY from what observably happened — the structured `props.action(s)`
// W3 attached to tool_use turns, edit/read tool rows and their positions —
// never from a model's reading of the transcript. Nothing here throws (B12):
// a malformed action is skipped, a session with no refs yields `refs: []`.
//
// Behaviour contract (docs/goals/2026-09-26_open-threads-from-observed-actions_goal.md):
//   B3   two ladders per ref, highest rung of each counts; `triaged` and
//        `discussed` stand alone
//   B4   takes only turns — no time, no cwd, no git
//   B5   a ref only referenced/viewed, with no edits and no action beyond
//        navigation, is `discussed`
//   B14  `reviewed` is the one rung derived from several calls: the ref was put
//        in front of the agent (viewed, checked out, or named by the developer
//        via a slash line / paste) and then reads or tests happened on it, with
//        no build action on it
//   B15  focus: the ref the session is on. It switches only on a slash line or
//        pasted URL (source command/paste), a `checked_out`, or a build/closure
//        action naming another ref. `viewed` never switches focus: the view is
//        recorded on its own ref with `related_to` the focus and turn share 0.
//        An action's own turn belongs to the action's own ref; focus decides
//        where prose and tool-less turns go.
//   B16  a child session folds into the parent's focus at its spawn turn.
//        Its actions raise the parent's rungs, but its turns are not the
//        parent's: turn_share counts the main session's turns only (the
//        child's cost is priced by the child's own rows, never by a share of
//        the parent's whole cost).
//   e2e  a focus a VIEW set (the first item the session looked at, in any
//        repo) is never build focus: ref-less commits/pushes/MR creates and
//        edits do not land on it. Only the developer naming a ref, an action
//        naming its ref, a checkout, or observed branch lineage set build focus.
//
// Judgement calls, recorded so P6 can overturn a rule row rather than the page:
//   - turns before the first focus belong to the first focus (the developer's
//     opening turns were about what they then named);
//   - `edited` counts on a ref's build ladder only when the ref is not being
//     reviewed (review rung >= checked_out with no committed+ build rung):
//     writing `review-17049.md` is not delivering on the MR (B3);
//   - a tool_result turn belongs wherever its tool_use turn went;
//   - a bare `!N`/`#N` from a CLI positional joins the one qualified ref with
//     the same marker and number seen in the session, so `glab mr checkout 17`
//     and the slash line's `acme/billing!17` are one row;
//   - `merged`/`closed` (B14 closure class) sit above `opened_mr` on the build
//     ladder: they are the strongest thing a session can observably do to a ref;
//   - D-053: a build action naming no issue/MR attaches to the ref the developer
//     last named in their own prose before it (`opts.userRefs`), unless an
//     explicit focus switch came after that mention (a developer slash line or
//     paste, a checkout, an action naming its own ref — never a mere view of
//     another item); the row's tier is then `inferred_ref`. The mention becomes
//     the focus, so turn share (and cost) follows. A turn naming two refs
//     attaches nothing, and ends the focus an earlier naming set;
//   - A-B7: on a ref with any review rung, `edited` needs a `committed` action
//     later in the session — review notes never committed are no build rung.
//     A ref with no review rung keeps D-051's `edited` for uncommitted edits.
//     Whether the file is in the repo's tracked tree is not observable here;
//     the commit that follows is the narrowest observable stand-in;
//   - S22: `git checkout <branch>` is `checked_out` on an MR only when an
//     earlier action in the session showed that MR's source branch.
//   - D-055 lineage (observed before inferred): a build action (edited,
//     committed, pushed, opened_mr) whose branch-at-the-time is observed to be
//     a PR/MR's source branch — in this session (opened_mr's head, a view's or
//     checkout's source branch) or in an earlier session of the same project
//     (`opts.knownBranches`, open MRs only) — attaches to that MR, tier
//     `observed`, and never to a prose-named issue. The branch at the time is
//     the commit's own `[branch sha]` line, else the last `git checkout/switch`
//     or MR checkout, else the session's start branch. Lineage outranks a
//     focus set by prose or a view; an explicit developer/action focus (slash
//     line, paste, checkout, an action naming its ref) keeps D-051's rule.
//   - D-055 checkout: `gh pr checkout N` / `glab mr checkout N`, or `git
//     checkout/switch <b>` where <b> is an observed source branch, moves build
//     focus to that MR; a plain view still does not.
//   - D-055 D-053 is the last fallback, and OFF unless MEMBRAL_INFER_REF is
//     "1"/"true" (`inferRefEnabled`, read in `buildProfile`): an inferred link
//     needs the action inside the extractor's `worked_span` for that ref when
//     one was given (no span → until another ref is named or an explicit-ref
//     action occurs). On a pre-existing non-default start branch with no known
//     mapping, the naming must also be the LAST user prose turn before the
//     action. Accepted false negative: "For #41 …" / "also make it bold" /
//     commit on such a branch stays unattributed.

import { BUILD_RANK, type BuildRung, REVIEW_RANK, type ReviewRung, type Role } from "@/lib/domain/ladder";
import { githubItemKey } from "@/lib/domain/ref-identity";
import { inferRefRaw } from "@/lib/env";

export type { BuildRung, ReviewRung } from "@/lib/domain/ladder";
export type ProfileRefKind = "issue" | "merge_request";
/** `inferred_ref` (D-053): the action was observed, but its ref came from the developer's own prose, not from the action. */
export type ProfileTier = "observed" | "discussed" | "inferred_ref";

const REVIEW_LADDER: ReviewRung[] = ["viewed", "checked_out", "reviewed", "commented", "approved"];
const BUILD_LADDER: BuildRung[] = ["edited", "committed", "pushed", "opened_mr", "merged", "closed"];

/** Actions from the developer's own hand (B13): a slash line or a pasted URL. */
const DEVELOPER_SOURCES = new Set(["command", "paste"]);

const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);
const READ_TOOLS = new Set(["read", "grep", "glob"]);
const SPAWN_TOOLS = new Set(["agent", "task"]);

/** The subset of a `code_session_turns` row the profile reads. `props` is jsonb, unvalidated at the DB boundary. */
export interface ProfileTurnInput {
  idx: number;
  role: string;
  kind: string;
  tool_name?: string | null;
  file_path?: string | null;
  props?: { action?: unknown; actions?: unknown; toolUseId?: unknown; inputDigest?: unknown } | null;
}

/** A sub-agent session folded into its parent (B16): its turns and the parent's spawn row (`Agent`/`Task` toolUseId). */
export interface ProfileChildSession {
  /** The child's own id (code_sessions.id or sourceSessionId) — only echoed in evidence. */
  id: string;
  /** `subAgent.toolUseId`: the parent's Agent/Task tool_use row this child was spawned from. */
  spawnToolUseId?: string | null;
  turns: ProfileTurnInput[];
}

/**
 * D-053: a ref the developer named in their own prose — a user prose turn of
 * the MAIN session (never an assistant line, tool output, branch name or
 * commit message), proposed by the extractor with a verbatim quote from that
 * turn (lib/memory/extract.ts collectUserNamedRefs). `ref` in any qualified
 * spelling (`host/owner/repo#N`), `refKind` says issue or MR.
 */
export interface UserNamedRef {
  ref: string;
  refKind: ProfileRefKind;
  /** The user prose turn's idx. */
  idx: number;
  /**
   * D-055: last turn idx of the extractor's validated `worked_span` that
   * starts at this mention. Any span on a ref makes inference for that ref
   * require the action's turn to lie inside one of its spans.
   */
  spanTo?: number;
}

/** D-055: a branch observed (in an earlier session of the same project) as an open PR/MR's source branch. */
export interface KnownBranchMr {
  branch: string;
  ref: string;
  refKind: ProfileRefKind;
}

export interface BuildProfileOptions {
  childSessions?: ProfileChildSession[];
  userRefs?: readonly UserNamedRef[];
  /** D-055 kill switch override; default `inferRefEnabled()` (MEMBRAL_INFER_REF, OFF unless "1"/"true"). */
  inferRef?: boolean;
  /** D-055: branch → open MR mappings seen in earlier sessions of the same user + project. */
  knownBranches?: readonly KnownBranchMr[];
  /** The session's recorded branch (`code_sessions.git_branch`); used as the start branch only when the session never switched. */
  startBranch?: string | null;
  /** The project's default branch when known; else `main`/`master` count as default. */
  defaultBranch?: string | null;
  /**
   * D-051 F1: the session project's host-stripped `owner/repo`. When given, a bare ref joins a
   * qualified spelling only of THIS repo — never another repo's item with the same number.
   */
  projectRepo?: string | null;
  /**
   * v3: the session's project is a forge repo (`repo_identity` is host/owner/repo), so a bare
   * `#N` in the subject of a commit made in it names that repo's item. Off (the default), only
   * an `owner/repo#N` written in a subject counts.
   */
  projectIsForgeRepo?: boolean;
  /** Review S1: the project's forge host (`github.com`), when its identity names one. */
  projectHost?: string | null;
}

/**
 * D-055 kill switch for D-053 inference. The ONE place MEMBRAL_INFER_REF is
 * read: OFF unless the value is "1" or "true". Branch lineage and checkout
 * focus are observed and apply either way.
 */
export function inferRefEnabled(raw: string | undefined = inferRefRaw()): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

const LINEAGE_VERBS = new Set(["opened_mr", "viewed", "checked_out"]);
const CLOSED_STATES = new Set(["merged", "closed"]);

/**
 * L1: a default branch is never an MR's source branch for lineage — a fork PR
 * whose head is `main` would otherwise claim every commit on the repo's own
 * main. `main`/`master` always count, plus the project's default when known.
 */
export function isDefaultBranch(branch: string, defaultBranch?: string | null): boolean {
  return branch === "main" || branch === "master" || (!!defaultBranch && branch === defaultBranch);
}

/** An earlier session's turn, for `knownBranchesFromTurns`. */
export type KnownBranchTurn = Pick<ProfileTurnInput, "props"> & {
  /**
   * L3: false when the turn's session is older than the mapping window — it can
   * still close or contradict a mapping, never create one. Absent = fresh.
   */
  fresh?: boolean;
};

export interface KnownBranchesOptions {
  /** The project's default branch when known (never mapped; `main`/`master` never are either). */
  defaultBranch?: string | null;
  /** L3: branches a sweep saw merged into another or gone (`memory_branch_state`) — never mapped. */
  deadBranches?: Iterable<string>;
}

/**
 * D-055: open-MR source branches from earlier sessions' action turns (in
 * session order). A branch mapped to two different MRs — by any turn, fresh
 * or not — is dropped; an MR any turn showed merged/closed is dropped; a
 * mapping needs a fresh turn (L3); default and dead branches never map (L1,
 * L3). Pure; never throws.
 */
export function knownBranchesFromTurns(
  turns: ReadonlyArray<KnownBranchTurn>,
  opts: KnownBranchesOptions = {},
): KnownBranchMr[] {
  const byBranch = new Map<string, { ref: string; refKind: ProfileRefKind } | null>();
  const freshBranch = new Set<string>();
  const closed = new Set<string>();
  const dead = new Set(opts.deadBranches ?? []);
  for (const t of turns) {
    for (const a of turnActions(t as ProfileTurnInput)) {
      if (!isItemRef(a) || a.refKind !== "merge_request") continue;
      if (a.verb === "merged" || a.verb === "closed" || (a.state && CLOSED_STATES.has(a.state.toLowerCase())))
        closed.add(a.ref);
      if (!a.branch || !LINEAGE_VERBS.has(a.verb)) continue;
      if (t.fresh !== false) freshBranch.add(a.branch);
      const prev = byBranch.get(a.branch);
      if (prev === undefined) byBranch.set(a.branch, { ref: a.ref, refKind: a.refKind });
      else if (prev && prev.ref !== a.ref) byBranch.set(a.branch, null);
    }
  }
  const out: KnownBranchMr[] = [];
  for (const [branch, m] of byBranch) {
    if (!m || closed.has(m.ref) || !freshBranch.has(branch) || dead.has(branch)) continue;
    if (isDefaultBranch(branch, opts.defaultBranch)) continue;
    out.push({ branch, ...m });
  }
  return out;
}

/** Where a rung was proved: a turn of the session, or of a folded child session. */
export interface EvidenceTurn {
  idx: number;
  /** Set when the turn belongs to a folded child session (B16). */
  child?: string;
}

export interface RefProfile {
  ref: string;
  refKind: ProfileRefKind;
  /** Highest review rung (B3), or null when the ref never climbed that ladder. */
  review_verb: ReviewRung | null;
  /** Highest build rung (B3), or null. */
  build_verb: BuildRung | null;
  triaged: boolean;
  /** B5: referenced/viewed only — no action beyond navigation, no edits. */
  discussed: boolean;
  tier: ProfileTier;
  /** This ref's share of the session's turns under the focus rule (0..1). */
  turn_share: number;
  /** Turns attributed to this ref by the focus rule. */
  turns: number;
  /** Refs this one was focused together with (a `viewed` while focused elsewhere links to that focus). */
  related_to: string[];
  first_turn_idx: number;
  last_turn_idx: number;
  /** One proving turn per rung climbed (plus `triaged`). */
  evidence: Partial<Record<ReviewRung | BuildRung | "triaged" | "referenced" | "opened", EvidenceTurn>>;
  /** Commit shas this session named on the ref (build ladder), in order. */
  shas: string[];
  /** The forge's word for the ref's state when a result showed it (`opened`, `merged`, `closed`). */
  state?: string;
  /** URL of the item when any action carried one. */
  url?: string;
  /** Slash-command skill label, display only (B13). */
  skill?: string;
}

export interface SessionProfile {
  version: 1;
  /** Turns counted (the session's own plus folded children). */
  turns: number;
  edits: number;
  files: number;
  reads: number;
  tests: number;
  commits: number;
  pushes: number;
  forgeActions: number;
  userProse: number;
  refs: RefProfile[];
}

// --- action reading ----------------------------------------------------------

interface ActionLike {
  verb: string;
  ref?: string;
  refKind?: string;
  sha?: string;
  url?: string;
  state?: string;
  skill?: string;
  /** A merge request's source branch (opened_mr's head branch, or a view result's) — S22's checkout mapping. */
  branch?: string;
  /** A commit's own subject line (from its `[branch sha] subject` result, or its HEAD query). */
  subject?: string;
  source: string;
  /**
   * v3: a `committed` expanded from a commit subject's `#N` — its commit is already counted, and
   * it records the rung only: it never sets focus nor takes a turn (driver decision: the link is
   * literally true, but a subject naming an item is no evidence of where the session's time went).
   */
  fromSubject?: true;
  /** v3: the items this ref-less commit's own subject names (raw spellings). */
  subjectItems?: string[];
}

function asAction(v: unknown): ActionLike | null {
  if (!v || typeof v !== "object") return null;
  const a = v as Record<string, unknown>;
  if (typeof a.verb !== "string" || typeof a.source !== "string") return null;
  // D-051 F1: a command in another directory whose repo nothing named is not this session's project's.
  if (a.repoUnknown === true) return null;
  const out: ActionLike = { verb: a.verb, source: a.source };
  if (typeof a.ref === "string" && a.ref) out.ref = a.ref;
  if (typeof a.refKind === "string") out.refKind = a.refKind;
  if (typeof a.sha === "string" && a.sha) out.sha = a.sha;
  if (typeof a.url === "string" && a.url) out.url = a.url;
  if (typeof a.state === "string" && a.state) out.state = a.state;
  if (typeof a.skill === "string" && a.skill) out.skill = a.skill;
  if (typeof a.branch === "string" && a.branch) out.branch = a.branch;
  if (typeof a.subject === "string" && a.subject) out.subject = a.subject;
  return out;
}

// v3 (commit subjects count): `#N` / `owner/repo#N` written in a commit's OWN
// subject line is the developer's word in the delivered artifact — an observed
// link, not an inference. A ref must stand on its own (start, space or an
// opening bracket before it), so `C#`, `&#39;` and `path/file.md#12` never
// match. Not read: a merge commit's subject (`Merge pull request #12 …` names a
// PR being merged, not work) and GitHub's squash suffix `… (#123)` (the PR
// number, not an issue).
const SUBJECT_REF = /(?:^|[\s([,;:])((?:[A-Za-z0-9][\w.-]*\/)+[\w.-]+)?#(\d+)(?![\w-])/g;
// A trailing closing quote is tolerated: `Revert "fix: ledger (#45)"` still ends in the suffix.
const SQUASH_SUFFIX = /\s*\(#\d+\)\s*["']?\s*$/;
const MERGE_SUBJECT = /^Merge\b/;
// Review S3: git's own revert subject (`Revert "<subject>"`) undoes the item's work — never a link.
// (The body's `This reverts commit <sha>` line is not in the action; the subject prefix is git's own.)
const REVERT_SUBJECT = /^Revert\s+"/;

/**
 * The item refs a commit's own subject names: `owner/repo#N` as written, a
 * bare `#N` only when the commit's repo is known to be a forge repo (the
 * caller's `bareOk`) — never guessed. Unique, in order.
 */
export function commitSubjectRefs(subject: string | undefined, bareOk: boolean): string[] {
  if (!subject || MERGE_SUBJECT.test(subject) || REVERT_SUBJECT.test(subject)) return [];
  const text = subject.replace(SQUASH_SUFFIX, "");
  const out: string[] = [];
  for (const m of text.matchAll(SUBJECT_REF)) {
    // `docs/api.md#12` is a file anchor, not a repo: a dotted last segment is never read as one
    // (a dotted repo name like `x/next.js#5` is then missed — a missing link, never a wrong one).
    if (m[1]?.split("/").pop()?.includes(".")) continue;
    const ref = m[1] ? `${m[1]}#${m[2]}` : bareOk ? `#${m[2]}` : null;
    if (ref && !out.includes(ref)) out.push(ref);
  }
  return out;
}

/**
 * A turn's actions with every ref-less `committed` whose subject names items
 * expanded (v3): the commit itself (unchanged), then one rung-only
 * `committed` per named item, carrying the commit's sha.
 */
function expandSubjectCommits(actions: ActionLike[], bareOk: boolean): ActionLike[] {
  const out: ActionLike[] = [];
  for (const a of actions) {
    const refs = a.verb === "committed" && a.refKind === "commit" ? commitSubjectRefs(a.subject, bareOk) : [];
    if (refs.length === 0) {
      out.push(a);
      continue;
    }
    // The commit itself: branch lineage may still take it; it never lands on a focus its subject contradicts.
    out.push({ ...a, subjectItems: refs });
    for (const ref of refs) {
      const item: ActionLike = { verb: "committed", ref, refKind: "issue", source: a.source, fromSubject: true };
      if (a.sha) item.sha = a.sha;
      out.push(item);
    }
  }
  return out;
}

/** Every action a turn carries: `actions` when several, else `[action]`. */
export function turnActions(turn: ProfileTurnInput): ActionLike[] {
  const props = turn.props;
  if (!props || typeof props !== "object") return [];
  if (Array.isArray(props.actions)) {
    const list = props.actions.map(asAction).filter((a): a is ActionLike => a !== null);
    if (list.length > 0) return list;
  }
  const one = asAction(props.action);
  return one ? [one] : [];
}

function isItemRef(a: ActionLike): a is ActionLike & { ref: string; refKind: ProfileRefKind } {
  return !!a.ref && (a.refKind === "issue" || a.refKind === "merge_request");
}

// --- ref normalisation -------------------------------------------------------

const REF_SHAPE = /^(.*?)([#!])(\d+)$/;

/** Canon key: kind + number (`merge_request:17`). A GitHub PR is `#N` with refKind merge_request, so the marker alone cannot say. */
function canonKey(ref: string, refKind: ProfileRefKind): string | null {
  const m = REF_SHAPE.exec(ref);
  return m ? `${refKind}:${m[3]}` : null;
}

/**
 * Map bare `!N`/`#N` refs onto the one qualified `owner/repo!N` / `owner/repo#N`
 * seen in the same session (same kind and number). Ambiguous (two projects
 * with the same number) or unseen bare refs stay bare.
 */
function buildRefCanon(
  allTurns: ProfileTurnInput[],
  projectRepo?: string | null,
): { canon: Map<string, string>; ambiguous: Set<string> } {
  const qualifiedByKey = new Map<string, Set<string>>();
  const project = projectRepo ? repoKey(projectRepo) : null;
  for (const t of allTurns) {
    for (const a of turnActions(t)) {
      if (!isItemRef(a)) continue;
      const m = REF_SHAPE.exec(a.ref);
      if (!m || !m[1]) continue;
      // D-051 F1: another repo's `owner/repo#5` is never where this project's bare `#5` goes.
      if (project !== null && repoKey(m[1]) !== project) continue;
      const key = `${a.refKind}:${m[3]}`;
      const set = qualifiedByKey.get(key) ?? new Set<string>();
      set.add(a.ref);
      qualifiedByKey.set(key, set);
    }
  }
  const canon = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [key, set] of qualifiedByKey) {
    if (set.size === 1) canon.set(key, [...set][0]);
    else ambiguous.add(key);
  }
  return { canon, ambiguous };
}

/** Host-stripped, lower-cased `owner/repo` of a ref prefix or identity (`codehub.example/acme/billing` → `acme/billing`). */
function repoKey(prefix: string): string {
  const segs = prefix
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .split("/")
    .filter(Boolean);
  if (segs.length >= 3 && segs[0].includes(".")) segs.shift();
  return segs.join("/");
}

// --- the fold ----------------------------------------------------------------

interface RefState {
  ref: string;
  refKind: ProfileRefKind;
  review: Set<ReviewRung>;
  build: Set<BuildRung>;
  triaged: boolean;
  /** Any cli/mcp action (beyond `referenced`) touched the ref, or a ref-less build action landed on it through an observed focus. */
  observed: boolean;
  /** Some action named this ref itself (any verb, any source). */
  explicit: boolean;
  /** D-053: the focus came from the developer's own prose naming the ref. */
  userNamed: boolean;
  /** D-053: a ref-less build action attached here only because the developer named the ref. */
  inferred: boolean;
  /** W4: a build rung (or edit) landed here from an observed source, not from a prose focus. */
  observedBuild: boolean;
  /**
   * v4 (driver decision B1): build evidence that may carry cost — ONLY the branch↔PR pairing: a
   * commit/push/MR create on a branch observed to be this MR's source branch (lineage, including
   * a PR checkout), or an MR create naming it. Never a commit on the default branch or any
   * unpaired branch, never a focus a paste/slash line/view/prose set (those only label).
   */
  costBuild: boolean;
  /** v4 B2/S3: an actual review command on this MR — `gh pr review` (any mode) or an approval. */
  reviewCmd: boolean;
  /** The developer named it (slash line / paste), or it was viewed/checked out: the base of `reviewed`. */
  seen: boolean;
  edits: number;
  /** Flat position + proof of each edit, for "edits count only when a commit follows" (A-B7). */
  /** `inf` (W4): the edit landed on a focus only the developer's prose set. */
  editAt: { pos: number; ev: EvidenceTurn; inf?: boolean }[];
  reads: number;
  tests: number;
  turns: number;
  /** v3: of `turns`, those credited only because a view made this ref the focus — dropped when the ref stays view-only. */
  viewTurns: number;
  related: Set<string>;
  first: number;
  last: number;
  evidence: RefProfile["evidence"];
  shas: string[];
  state?: string;
  url?: string;
  skill?: string;
}

interface FlatTurn {
  turn: ProfileTurnInput;
  child?: string;
  /** D-057: a child with no spawn row in the session — folded in at the end, its time unknown. */
  untimed?: true;
}

function flatten(turns: ProfileTurnInput[], children: ProfileChildSession[]): FlatTurn[] {
  const bySpawn = new Map<string, ProfileChildSession[]>();
  const unanchored: ProfileChildSession[] = [];
  for (const c of children) {
    if (c.spawnToolUseId) {
      const list = bySpawn.get(c.spawnToolUseId) ?? [];
      list.push(c);
      bySpawn.set(c.spawnToolUseId, list);
    } else unanchored.push(c);
  }
  const sorted = [...turns].sort((a, b) => a.idx - b.idx);
  const out: FlatTurn[] = [];
  const placed = new Set<ProfileChildSession>();
  for (const t of sorted) {
    out.push({ turn: t });
    const toolUseId = t.props?.toolUseId;
    if (typeof toolUseId !== "string") continue;
    for (const c of bySpawn.get(toolUseId) ?? []) {
      placed.add(c);
      for (const ct of [...c.turns].sort((a, b) => a.idx - b.idx)) out.push({ turn: ct, child: c.id });
    }
  }
  // A child whose spawn row is missing (or unknown) folds in at the end — its
  // actions still count for the parent's refs, under the final focus.
  for (const c of [...children.filter((c) => !placed.has(c) && c.spawnToolUseId), ...unanchored]) {
    for (const ct of [...c.turns].sort((a, b) => a.idx - b.idx)) out.push({ turn: ct, child: c.id, untimed: true });
  }
  return out;
}

function evidenceOf(ft: FlatTurn): EvidenceTurn {
  return ft.child ? { idx: ft.turn.idx, child: ft.child } : { idx: ft.turn.idx };
}

/** A ref-less build action (committed/pushed/opened_mr naming no issue/MR), and when the focus it would land on was set. */
interface ReflessBuild {
  pos: number;
  /** Main-session turn idx of the action (a child's action counts at its spawn turn). */
  mainIdx: number;
  /** D-055 guard: the action ran on a pre-existing non-default start branch. */
  onStartBranch: boolean;
  /**
   * Flat position of the last focus switch before it that outranks the
   * developer's own naming (a developer slash line/paste, a checkout, an
   * action naming its own ref); null when there was none. A view is not one:
   * looking at another item does not move the developer off the ref they named.
   */
  focusSince: number | null;
}

/**
 * D-057: one build action (an edit, or a commit/push naming no issue/MR) and
 * where the fold put it. `landed` is the ref it attached to by observed
 * evidence (branch lineage, an MR checkout, a commit subject naming an item,
 * or the session's focus), or null when nothing observed linked it — the
 * actions a model-segment association may claim (override 1).
 */
export interface BuildTrace {
  verb: "edited" | "committed" | "pushed";
  /** The action's own turn idx (a child's own idx when `child` is set). */
  idx: number;
  /** Main-session turn idx of the action: a child's action counts at its spawn turn. */
  mainIdx: number;
  /** The folded child session the action ran in, when any. */
  child: string | null;
  /** A child with no spawn row: the action's time in the session is unknown. */
  untimed: boolean;
  sha?: string;
  branch?: string;
  subject?: string;
  file?: string;
  /**
   * The ref the fold attached it to (profile spelling), `subject` for a commit its own subject
   * labels, `lineage:<ref>` when its branch is observed to be an MR's but another explicit focus
   * kept it (branch evidence still outranks a model segment), or null.
   */
  landed: string | null;
}

interface FoldResult {
  refs: Map<string, RefState>;
  /** D-057: every edit / ref-less commit / push, in order, with where it landed. */
  builds: BuildTrace[];
  /** D-057: main-session turn idx → the ref its share was credited to (null = unclaimed). */
  turnOwner: Map<number, string | null>;
  /** D-057: main-session turn idxs credited only because a view set the focus (they never price). */
  viewTurnIdx: Set<number>;
  /** D-057: MR ref → the source branches observed for it (this session and earlier ones). */
  mrBranches: Map<string, string[]>;
  /** D-057: main-session turn idx of every switch onto an MR's branch (checkout, or switch to an observed source branch). */
  mrSwitches: { mainIdx: number; ref: string }[];
  counts: {
    edits: number;
    reads: number;
    tests: number;
    commits: number;
    pushes: number;
    forgeActions: number;
    userProse: number;
  };
  files: number;
  refless: ReflessBuild[];
  /** Flat position of the last `committed` action in the session (children included); -1 when none. */
  lastCommitPos: number;
}

const REFLESS_BUILD = new Set(["committed", "pushed", "opened_mr"]);

type MrTarget = { ref: string; refKind: ProfileRefKind };

/** D-055 lineage inputs, fixed for both passes. */
interface LineageCtx {
  /** Branch → MR (null = ambiguous) from the whole session, then earlier sessions. */
  branchMap: ReadonlyMap<string, MrTarget | null>;
  /** Earlier sessions' mappings only — seeds S22's "observed before" map. */
  knownMap: ReadonlyMap<string, MrTarget>;
  /** The branch the session started on, when known. */
  startName: string | null;
  /** `startName` when it is a non-default branch (the D-055 guard applies there). */
  guardBranch: string | null;
  /** L1: the project's default branch when known — never mapped to an MR. */
  defaultBranch: string | null;
}

const NO_LINEAGE: LineageCtx = {
  branchMap: new Map(),
  knownMap: new Map(),
  startName: null,
  guardBranch: null,
  defaultBranch: null,
};

/** W5: the working branch after an MR checkout whose local branch was not observed — it matches no branch. */
const UNKNOWN_BRANCH = "\u0000unknown";

function fold(
  flat: FlatTurn[],
  canonical: (ref: string, refKind: ProfileRefKind) => string,
  activated: ReadonlyMap<number, { ref: string; refKind: ProfileRefKind }>,
  ambiguousAt: ReadonlySet<number> = new Set(),
  lineage: LineageCtx = NO_LINEAGE,
  soleViewRef: string | null = null,
  subjectBareOk = false,
  sameItem: (a: string, b: string, bKind: ProfileRefKind) => boolean = (a, b) => a === b,
): FoldResult {
  const refs = new Map<string, RefState>();
  const stateFor = (ref: string, refKind: ProfileRefKind, ft: FlatTurn): RefState => {
    let s = refs.get(ref);
    if (!s) {
      s = {
        ref,
        refKind,
        review: new Set(),
        build: new Set(),
        triaged: false,
        observed: false,
        explicit: false,
        userNamed: false,
        inferred: false,
        observedBuild: false,
        costBuild: false,
        reviewCmd: false,
        seen: false,
        edits: 0,
        editAt: [],
        reads: 0,
        tests: 0,
        turns: 0,
        viewTurns: 0,
        related: new Set(),
        first: ft.turn.idx,
        last: ft.turn.idx,
        evidence: {},
        shas: [],
      };
      refs.set(ref, s);
    }
    return s;
  };
  const touch = (s: RefState, ft: FlatTurn) => {
    if (!ft.child) {
      if (ft.turn.idx < s.first) s.first = ft.turn.idx;
      if (ft.turn.idx > s.last) s.last = ft.turn.idx;
    }
  };
  const climb = <R extends ReviewRung | BuildRung>(s: RefState, ladder: Set<R>, rung: R, ft: FlatTurn) => {
    ladder.add(rung);
    s.evidence[rung] ??= evidenceOf(ft);
    touch(s, ft);
  };

  const counts = { edits: 0, reads: 0, tests: 0, commits: 0, pushes: 0, forgeActions: 0, userProse: 0 };
  const files = new Set<string>();
  const refless: ReflessBuild[] = [];
  const builds: BuildTrace[] = [];
  const mrSwitches: { mainIdx: number; ref: string }[] = [];
  const turnOwner = new Map<number, string | null>();
  const viewTurnIdx = new Set<number>();
  /** Main-session idxs of the turns before the first focus (handed to it once it appears). */
  let leadingIdx: number[] = [];
  let curIdx = -1;
  let lastCommitPos = -1;
  /** S22: an MR's source branch, once an action on the MR showed it (opened_mr's head branch, a view result's). */
  const branchToMr = new Map<string, { ref: string; refKind: ProfileRefKind }>(lineage.knownMap);
  /** D-055: branch → MR learned so far in this fold (commit lines on an MR's checkout add to it). */
  const branchMap = new Map(lineage.branchMap);
  const mrOf = (b: string | undefined | null): MrTarget | null => (b ? (branchMap.get(b) ?? null) : null);
  /** L1: learn branch → MR only for a real, non-default branch. */
  const mappable = (b: string | null | undefined): b is string =>
    !!b && b !== UNKNOWN_BRANCH && !isDefaultBranch(b, lineage.defaultBranch);
  /** W5/L2: is `b` observed to be MR `ref`'s branch (this session or an earlier one)? */
  const isBranchOf = (b: string, ref: string): boolean => branchMap.get(b)?.ref === ref;
  /** D-055: the working branch and the MR it is observed to belong to. */
  let curBranch: string | null = lineage.startName;
  let curMr: MrTarget | null = mrOf(curBranch);
  /** Main-session idx of the latest non-child turn (a child's action counts at its spawn turn). */
  let mainIdx = -1;

  let focus: string | null = null;
  /** D-055: how the focus was set — lineage outranks a `weak` one (view or prose), never an `explicit` one. */
  let focusKind: "explicit" | "weak" | null = null;
  /** Last switch that outranks the developer's naming (see ReflessBuild.focusSince). */
  let focusSince: number | null = null;
  /** True while the focus was set only by the developer's prose (D-053), not by an action. */
  let focusFromProse = false;
  /** True while the focus was set only by a view: it takes turn share, never ref-less build actions. */
  let focusFromView = false;
  /** B16: the current flat turn belongs to a folded child (its turns are not the parent's share). */
  let inChild = false;
  let inChildId: string | null = null;
  /** B16: the parent's focus state at the child's first turn, restored after it. */
  let saved: {
    focus: string | null;
    focusKind: "explicit" | "weak" | null;
    focusSince: number | null;
    focusFromProse: boolean;
    focusFromView: boolean;
    lastOwner: string | null;
    released: boolean;
  } | null = null;
  /** Turns before the first focus — handed to it once it appears. */
  let leading = 0;
  /** v3: a commit subject naming other items ended the focus — later unfocused turns stay unclaimed, never leading. */
  let released = false;
  /** Where the previous turn's share went, so a tool_result follows its tool_use. */
  let lastOwner: string | null = null;

  const credit = (ref: string | null) => {
    if (inChild) {
      lastOwner = ref;
      return;
    }
    if (ref === null) {
      if (!released) {
        leading += 1;
        leadingIdx.push(curIdx);
      }
      turnOwner.set(curIdx, null);
      lastOwner = null;
      return;
    }
    const s = refs.get(ref);
    if (s) {
      s.turns += 1;
      turnOwner.set(curIdx, ref);
      if (focusFromView && ref === focus) {
        s.viewTurns += 1;
        viewTurnIdx.add(curIdx);
      }
    } else turnOwner.set(curIdx, null);
    lastOwner = ref;
  };
  /** Returns the main-session idxs of the leading turns handed to `ref` (empty when none). */
  const setFocus = (ref: string, pos: number, outranksNaming = true): number[] => {
    let handed: number[] = [];
    if (focus === null && leading > 0 && !inChild) {
      const s = refs.get(ref);
      if (s) {
        s.turns += leading;
        handed = leadingIdx;
        for (const i of handed) turnOwner.set(i, ref);
      }
      leading = 0;
      leadingIdx = [];
    }
    focus = ref;
    released = false;
    focusFromProse = false;
    focusFromView = false;
    focusKind = outranksNaming ? "explicit" : "weak";
    if (outranksNaming) focusSince = pos;
    return handed;
  };
  /** D-055: may observed branch lineage take this action off the current focus? */
  const lineageWins = (m: MrTarget | null): m is MrTarget =>
    m !== null && (focus === null || focusKind !== "explicit" || focus === m.ref);

  for (let pos = 0; pos < flat.length; pos++) {
    const ft = flat[pos];
    const t = ft.turn;
    const kind = t.kind;
    const tool = (t.tool_name ?? "").toLowerCase();
    // B16: a child starts on the parent's focus; what it switches to stays in
    // the child — the parent's own later turns (and cost) keep the parent's focus.
    const childNow = ft.child ?? null;
    if (childNow !== inChildId) {
      if (inChildId !== null && saved) {
        ({ focus, focusKind, focusSince, focusFromProse, focusFromView, lastOwner, released } = saved);
        saved = null;
      }
      if (childNow !== null)
        saved = { focus, focusKind, focusSince, focusFromProse, focusFromView, lastOwner, released };
      inChildId = childNow;
    }
    inChild = childNow !== null;
    if (!ft.child) mainIdx = t.idx;
    curIdx = mainIdx;

    if (kind === "tool_result") {
      credit(lastOwner ?? focus);
      continue;
    }
    if (kind === "thinking") {
      credit(focus);
      continue;
    }

    if (kind === "prose" && t.role === "user") counts.userProse += 1;

    // D-053: the developer named this ref in their own words, and a ref-less
    // build action after it (with no explicit focus switch between) lands on it.
    const named = activated.get(pos);
    if (named) {
      const s = stateFor(named.ref, named.refKind, ft);
      s.userNamed = true;
      s.evidence.referenced ??= evidenceOf(ft);
      touch(s, ft);
      setFocus(named.ref, pos);
      focusFromProse = true;
      focusKind = "weak";
    } else if (ambiguousAt.has(pos) && focusFromProse) {
      // D-053: a turn naming two refs ends the focus an earlier naming set;
      // ref-less build actions after it attach nothing.
      focus = null;
      focusKind = null;
      focusSince = pos;
      focusFromProse = false;
      focusFromView = false;
    }

    const actions = expandSubjectCommits(turnActions(t), subjectBareOk);
    let owner: string | null = focus;

    if (actions.length > 0) {
      for (const raw of actions) {
        let a = raw;
        // S22: `git checkout <branch>` where <branch> is an MR's source branch
        // this session already saw (never guessed from the branch name).
        if (!isItemRef(a) && a.verb === "navigated" && a.refKind === "branch") {
          const mr = branchToMr.get(a.branch ?? a.ref ?? "");
          if (mr) a = { ...a, verb: "checked_out", ref: mr.ref, refKind: mr.refKind };
        }
        if (a.fromSubject) {
          // counted once, on the commit itself
        } else if (a.verb !== "referenced" && a.verb !== "navigated" && a.verb !== "tested") counts.forgeActions += 1;
        if (a.verb === "tested") counts.tests += 1;
        if (a.verb === "committed" && !a.fromSubject) {
          counts.commits += 1;
          lastCommitPos = pos;
        }
        if (a.verb === "pushed") counts.pushes += 1;

        // Review S1/S2: a subject `#N` naming the item already in focus (any spelling; on a GitHub
        // host a PR and an issue share the number) is that item — its rung lands there, no second row.
        if (a.fromSubject && a.ref && focus !== null) {
          const fs = refs.get(focus);
          if (fs && sameItem(a.ref, focus, fs.refKind)) {
            fs.observed = true;
            fs.observedBuild = true;
            // v4 B1: a subject naming the focus is a label (the rung); cost needs the branch↔PR pairing.
            climb(fs, fs.build, "committed", ft);
            if (a.sha && !fs.shas.includes(a.sha)) fs.shas.push(a.sha);
            continue;
          }
        }

        if (isItemRef(a)) {
          let ref = canonical(a.ref, a.refKind);
          // Review S2: a subject's spelling of an item the session already has is that item.
          if (a.fromSubject && !refs.has(ref)) {
            for (const [key, st] of refs) {
              if (sameItem(a.ref, key, st.refKind)) {
                ref = key;
                break;
              }
            }
          }
          const s = stateFor(ref, a.refKind, ft);
          s.explicit = true;
          if (a.url && !s.url) s.url = a.url;
          if (a.skill && !s.skill) s.skill = a.skill;
          if (a.state) s.state = a.state;
          if (a.branch && a.refKind === "merge_request" && a.verb !== "navigated" && mappable(a.branch)) {
            branchToMr.set(a.branch, { ref, refKind: a.refKind });
          }
          const developer = DEVELOPER_SOURCES.has(a.source);

          switch (a.verb) {
            case "referenced":
              s.evidence.referenced ??= evidenceOf(ft);
              touch(s, ft);
              if (developer) {
                s.seen = true;
                setFocus(ref, pos);
                owner = ref;
              }
              break;
            case "viewed":
              s.observed = true;
              s.seen = true;
              climb(s, s.review, "viewed", ft);
              if (focus === null && !inChild && ref === soleViewRef) {
                // Nothing to switch from, and the only item the session ever acts on: it is what
                // the session is on. D-053: a view never outranks the developer's own naming.
                // v3: a sub-agent's view never sets the parent's focus, and with more than one
                // item in the session the first view is not "the" item (it took 98% of a sweep).
                const before = s.turns;
                for (const i of setFocus(ref, pos, false)) viewTurnIdx.add(i);
                focusFromView = true;
                s.viewTurns += s.turns - before;
                owner = ref;
              } else if (focus !== null && focus !== ref) {
                s.related.add(focus);
                refs.get(focus)?.related.add(ref);
                // B15: the view's turn stays with the focus (share 0 for the viewed ref).
              }
              break;
            case "checked_out":
              s.observed = true;
              s.seen = true;
              climb(s, s.review, "checked_out", ft);
              setFocus(ref, pos);
              owner = ref;
              // D-055: the working branch is now this MR's (its name when the action carried it).
              curMr = { ref, refKind: a.refKind };
              mrSwitches.push({ mainIdx, ref });
              // W5: git's switch line was not captured — the branch is unknown and matches none.
              curBranch = a.branch ?? UNKNOWN_BRANCH;
              if (mappable(curBranch) && !branchMap.get(curBranch)) branchMap.set(curBranch, curMr);
              break;
            case "commented":
              s.observed = true;
              climb(s, s.review, "commented", ft);
              // v4 B2/S3: only an actual review command (`gh pr review 12 --comment`) is a review; a
              // plain `gh pr comment` / `glab mr note` / issue comment is conversation — no turn, no cost.
              if (a.refKind === "merge_request" && isReviewCommand(t, ref)) {
                s.reviewCmd = true;
                owner = ref;
              }
              break;
            case "approved":
              s.observed = true;
              s.reviewCmd = true;
              climb(s, s.review, "approved", ft);
              owner = ref;
              break;
            case "opened":
              // v3: `gh/glab issue create` whose own result named the new issue — observed, but
              // filing is no rung and takes no focus or turn share (the item reads as a mention).
              s.observed = true;
              s.evidence.opened ??= evidenceOf(ft);
              touch(s, ft);
              break;
            case "triaged":
              // v4: triage is no work on the item — recorded, never a focus or a turn.
              s.observed = true;
              s.triaged = true;
              s.evidence.triaged ??= evidenceOf(ft);
              touch(s, ft);
              break;
            case "committed":
            case "pushed":
            case "opened_mr":
            case "merged":
            case "closed":
              s.observed = true;
              s.observedBuild = true;
              climb(s, s.build, a.verb, ft);
              if (a.verb === "committed" && a.sha) s.shas.push(a.sha);
              // v3: a subject-named item gets the rung only — no focus, no turn, so no cost share.
              if (a.fromSubject) break;
              // v4 (driver decision): closing or merging an item by number is a closure verb — the
              // rung only. A sweep that closes twenty issues never moves the focus (or its cost)
              // onto each; a merge's cost comes from the MR's own lineage (its branch's commits).
              if (a.verb === "merged" || a.verb === "closed") break;
              // v4 B1: an MR create (or a commit/push the forge tied to the MR) is that MR's branch —
              // build evidence. A commit/push naming an issue is a label only.
              if (a.refKind === "merge_request") s.costBuild = true;
              setFocus(ref, pos);
              owner = ref;
              break;
            default:
              // rewrote / navigated / tested on an item ref: recorded on the focus only.
              touch(s, ft);
              break;
          }
        } else {
          if (a.verb === "navigated" && a.refKind === "branch") {
            // D-055: a checkout/switch moves the working branch; its MR, when observed.
            const b = a.branch ?? a.ref;
            if (b) {
              curBranch = b;
              curMr = mrOf(b);
              if (curMr) mrSwitches.push({ mainIdx, ref: curMr.ref });
            }
          }
          if (REFLESS_BUILD.has(a.verb)) {
            // D-055: the branch this action ran on, and the MR it is observed to belong to.
            const b = a.branch ?? (a.verb === "pushed" ? a.ref : undefined);
            // W5: an unknown working branch (after an MR checkout) is never "the same" as a named one.
            const sameBranch = !b || (curBranch === null ? true : curBranch !== UNKNOWN_BRANCH && curBranch === b);
            const lin = mrOf(b) ?? (sameBranch ? curMr : null);
            const onBranch = b ?? curBranch;
            const trace: BuildTrace | null =
              a.verb === "committed" || a.verb === "pushed"
                ? {
                    verb: a.verb,
                    idx: t.idx,
                    mainIdx,
                    child: ft.child ?? null,
                    untimed: !!ft.untimed,
                    ...(a.sha ? { sha: a.sha } : {}),
                    ...(onBranch && onBranch !== UNKNOWN_BRANCH ? { branch: onBranch } : {}),
                    ...(a.subject ? { subject: a.subject } : {}),
                    landed: null,
                  }
                : null;
            if (trace) builds.push(trace);
            if (a.verb === "committed" && b) {
              curBranch = b;
              curMr = lin;
              if (lin && mappable(b) && !branchMap.get(b)) branchMap.set(b, lin);
            }
            if (lineageWins(lin)) {
              const s = stateFor(lin.ref, lin.refKind, ft);
              s.observed = true;
              s.observedBuild = true;
              s.costBuild = true;
              climb(s, s.build, a.verb as BuildRung, ft);
              if (a.verb === "committed" && a.sha) s.shas.push(a.sha);
              setFocus(lin.ref, pos);
              owner = lin.ref;
              if (trace) trace.landed = lin.ref;
              continue;
            }
            // D-057 S1: the branch is observed to be an MR's even though an explicit focus kept the
            // action — observed branch evidence; a model segment must never claim it.
            // (`lineageWins` is a type guard, so its false branch narrows `lin` too far — re-widen.)
            const kept = lin as MrTarget | null;
            if (kept && trace) trace.landed = `lineage:${kept.ref}`;
            if (a.subjectItems) {
              if (trace) trace.landed = "subject";
              // v3 (driver decision): the subject's items get a rung only (the actions right after
              // this one). The commit never lands on a focus its own subject does not name; that
              // focus ends here, and the turns until the next focus stay unattributed. With no focus
              // yet, the turns so far were about the subject's items: they are never handed to
              // whatever focus comes next ("leading" turns), they stay unattributed too.
              const fs = focus === null ? undefined : refs.get(focus);
              if (!fs || !a.subjectItems.some((r) => sameItem(r, fs.ref, fs.refKind))) {
                focus = null;
                focusKind = null;
                focusFromProse = false;
                focusFromView = false;
                if (!inChild) leading = 0;
                released = true;
                owner = null;
              }
              continue;
            }
            refless.push({
              pos,
              mainIdx,
              onStartBranch: lineage.guardBranch !== null && onBranch === lineage.guardBranch,
              focusSince: focus === null ? null : focusSince,
            });
          }
          if (focus === null) continue;
          // e2e: a view-set focus is not build focus — the action lands nowhere.
          if (focusFromView && REFLESS_BUILD.has(a.verb)) continue;
          // W5/L2: a build action naming a branch lands on an MR focus only when that
          // branch is observed to be the MR's — a pasted MR URL or an MR checkout whose
          // branch went unseen never claims a commit made on some other branch.
          if (REFLESS_BUILD.has(a.verb)) {
            const b = a.branch ?? (a.verb === "pushed" ? a.ref : undefined);
            if (b && refs.get(focus)?.refKind === "merge_request" && !isBranchOf(b, focus)) continue;
          }
          // Branch/commit-kind or ref-less actions accrue to the focus (B3: the
          // session's ref row for a commit is the issue it was on).
          const s = refs.get(focus);
          if (s) {
            switch (a.verb) {
              case "committed":
              case "pushed":
              case "opened_mr":
                // D-053: on a focus only the developer's prose set, the action is
                // observed but its ref is inferred — the tier says so.
                // W4: marked by how THIS action landed (a prose focus), even on a viewed ref.
                if (focusFromProse) s.inferred = true;
                else {
                  if (a.verb !== "opened_mr" && builds.length > 0) {
                    const last = builds[builds.length - 1];
                    if (last.idx === t.idx && last.child === (ft.child ?? null) && last.landed === null)
                      last.landed = focus;
                  }
                  s.observed = true;
                  s.observedBuild = true;
                  // v4 B1: a focus (paste, slash line, action naming the item) only labels — no cost.
                }
                climb(s, s.build, a.verb, ft);
                if (a.verb === "committed" && a.sha) s.shas.push(a.sha);
                break;
              case "merged":
              case "closed":
                // A closure on a bare branch says nothing about the item; recorded nowhere.
                break;
              case "tested":
                s.tests += 1;
                touch(s, ft);
                break;
              default:
                break;
            }
          }
        }
      }
    } else if (kind === "tool_use") {
      if (EDIT_TOOLS.has(tool)) {
        counts.edits += 1;
        if (t.file_path) files.add(t.file_path);
        const trace: BuildTrace = {
          verb: "edited",
          idx: t.idx,
          mainIdx,
          child: ft.child ?? null,
          untimed: !!ft.untimed,
          ...(t.file_path ? { file: t.file_path } : {}),
          landed: null,
        };
        builds.push(trace);
        // D-057 S1: an edit on an MR's observed branch is never model-claimable, whatever the focus.
        if (curMr) trace.landed = `lineage:${curMr.ref}`;
        if (lineageWins(curMr)) {
          trace.landed = curMr.ref;
          // D-055: an edit on a branch observed to be an MR's is building that MR.
          const s = stateFor(curMr.ref, curMr.refKind, ft);
          s.observed = true;
          s.edits += 1;
          s.editAt.push({ pos, ev: evidenceOf(ft) });
          touch(s, ft);
          owner = curMr.ref;
        } else if (focus !== null && !focusFromView) {
          const s = refs.get(focus);
          if (s) {
            if (!focusFromProse) trace.landed = focus;
            s.edits += 1;
            s.editAt.push({ pos, ev: evidenceOf(ft), inf: focusFromProse });
            touch(s, ft);
          }
        }
      } else if (READ_TOOLS.has(tool)) {
        counts.reads += 1;
        if (focus !== null) {
          const s = refs.get(focus);
          if (s) {
            s.reads += 1;
            touch(s, ft);
          }
        }
      } else if (SPAWN_TOOLS.has(tool)) {
        // The spawn row itself is just a turn on the focus; the child's turns follow it in `flat`.
      }
    }

    credit(owner);
  }

  const mrBranches = new Map<string, string[]>();
  for (const src of [branchMap, branchToMr] as ReadonlyMap<string, MrTarget | null>[]) {
    for (const [b, m] of src) {
      if (!m || b === UNKNOWN_BRANCH) continue;
      const list = mrBranches.get(m.ref) ?? [];
      if (!list.includes(b)) list.push(b);
      mrBranches.set(m.ref, list);
    }
  }
  return {
    refs,
    builds,
    turnOwner,
    viewTurnIdx,
    mrBranches,
    mrSwitches,
    counts,
    files: files.size,
    refless,
    lastCommitPos,
  };
}

/**
 * D-053: which of the developer's ref mentions a ref-less build action
 * attaches to. For each such action: the developer's LAST mention before it
 * wins, unless an explicit focus switch (slash line, paste, checkout, an
 * action naming a ref) came after that mention — then the focus stands. A
 * turn naming two different refs is ambiguous and attaches nothing. The
 * activated mention is the first of an unbroken run of mentions of the same
 * ref (so the edits between "For #41 …" and "now commit #41" count on #41).
 */
function activateUserRefs(
  userAt: { pos: number; ref: string; refKind: ProfileRefKind; idx: number; spanTo?: number }[],
  refless: readonly ReflessBuild[],
  userProsePos: readonly number[] = [],
): { activated: Map<number, { ref: string; refKind: ProfileRefKind }>; ambiguousAt: Set<number> } {
  const out = new Map<number, { ref: string; refKind: ProfileRefKind }>();
  const ambiguousAt = new Set<number>();
  if (userAt.length === 0) return { activated: out, ambiguousAt };
  const idOf = (u: { ref: string; refKind: ProfileRefKind }) => `${u.refKind}\u0000${u.ref}`;
  const refsAtPos = new Map<number, Set<string>>();
  for (const u of userAt) {
    const set = refsAtPos.get(u.pos) ?? new Set<string>();
    set.add(idOf(u));
    refsAtPos.set(u.pos, set);
  }
  for (const [pos, set] of refsAtPos) if (set.size > 1) ambiguousAt.add(pos);
  // D-055: the extractor's worked spans per ref (from a mention's turn to spanTo).
  const spansOf = new Map<string, { from: number; to: number }[]>();
  for (const u of userAt) {
    if (u.spanTo === undefined) continue;
    const list = spansOf.get(idOf(u)) ?? [];
    list.push({ from: u.idx, to: u.spanTo });
    spansOf.set(idOf(u), list);
  }
  for (const e of refless) {
    let k = -1;
    for (let i = 0; i < userAt.length; i++) if (userAt[i].pos < e.pos) k = i;
    if (k < 0) continue;
    const last = userAt[k];
    if (e.focusSince !== null && last.pos <= e.focusSince) continue;
    if ((refsAtPos.get(last.pos)?.size ?? 0) > 1) continue;
    // D-055: when the extractor bounded the work on this ref, the action must fall inside.
    const spans = spansOf.get(idOf(last));
    if (spans && !spans.some((sp) => sp.from <= e.mainIdx && e.mainIdx <= sp.to)) continue;
    // D-055 guard: on a pre-existing non-default branch, the naming must be the last user prose turn before the action.
    if (e.onStartBranch && userProsePos.some((p) => p > last.pos && p < e.pos)) continue;
    let j = k;
    while (
      j > 0 &&
      idOf(userAt[j - 1]) === idOf(last) &&
      (refsAtPos.get(userAt[j - 1].pos)?.size ?? 0) === 1 &&
      (e.focusSince === null || userAt[j - 1].pos > e.focusSince)
    ) {
      j -= 1;
    }
    out.set(userAt[j].pos, { ref: last.ref, refKind: last.refKind });
  }
  return { activated: out, ambiguousAt };
}

export type ReflessResolver = typeof activateUserRefs;
export const DEFAULT_REFLESS_RESOLVER: ReflessResolver = activateUserRefs;

/**
 * D-055: the session-wide branch → MR map (this session's opened_mr / view /
 * checkout source branches, then earlier sessions' for branches this one
 * never mapped) and the start branch. The start branch is the one a commit
 * line named before the first checkout/switch; with no switch at all in the
 * session, `opts.startBranch`; otherwise unknown.
 */
function lineageContext(
  flat: FlatTurn[],
  canonical: (ref: string, refKind: ProfileRefKind) => string,
  opts: BuildProfileOptions,
): LineageCtx {
  const branchMap = new Map<string, MrTarget | null>();
  let firstNav = -1;
  let startFromCommit: string | null = null;
  flat.forEach((ft, pos) => {
    for (const a of turnActions(ft.turn)) {
      const nav =
        (a.verb === "navigated" && a.refKind === "branch" && !!(a.branch ?? a.ref)) || a.verb === "checked_out";
      if (nav && firstNav < 0) firstNav = pos;
      if (a.verb === "committed" && a.branch && firstNav < 0 && startFromCommit === null) startFromCommit = a.branch;
      if (!isItemRef(a) || a.refKind !== "merge_request" || !a.branch || !LINEAGE_VERBS.has(a.verb)) continue;
      // L1: a default branch never maps to an MR (a fork PR's head `main`).
      if (isDefaultBranch(a.branch, opts.defaultBranch)) continue;
      const ref = canonical(a.ref, a.refKind);
      const prev = branchMap.get(a.branch);
      if (prev === undefined) branchMap.set(a.branch, { ref, refKind: a.refKind });
      else if (prev && prev.ref !== ref) branchMap.set(a.branch, null);
    }
  });
  const knownMap = new Map<string, MrTarget>();
  for (const k of opts.knownBranches ?? []) {
    if (!k.branch || !k.ref || k.refKind !== "merge_request") continue;
    if (isDefaultBranch(k.branch, opts.defaultBranch)) continue;
    const m = { ref: canonical(k.ref, k.refKind), refKind: k.refKind };
    if (!knownMap.has(k.branch)) knownMap.set(k.branch, m);
    if (!branchMap.has(k.branch)) branchMap.set(k.branch, m);
  }
  const startName = startFromCommit ?? (firstNav < 0 ? (opts.startBranch ?? null) : null);
  const isDefault = (b: string) => (opts.defaultBranch ? b === opts.defaultBranch : b === "main" || b === "master");
  const guardBranch = startName && !isDefault(startName) && !branchMap.get(startName) ? startName : null;
  return { branchMap, knownMap, startName, guardBranch, defaultBranch: opts.defaultBranch ?? null };
}

/**
 * Fold a session's turns into per-ref facts. Pure; never throws; a session
 * with no refs yields `refs: []` and the counts.
 */
export function buildProfile(turns: ProfileTurnInput[], opts: BuildProfileOptions = {}): SessionProfile {
  return buildProfileDetailed(turns, opts).profile;
}

/** D-057: what the model-segment association needs beside the profile — see `buildProfileDetailed`. */
export interface ProfileTrace {
  /** Every edit / ref-less commit / push, in session order, with the ref observed evidence attached it to (or null). */
  builds: BuildTrace[];
  /** Main-session turn idxs whose share some ref already claims (they price or they were a view focus's). */
  claimedTurnIdx: Set<number>;
  /** Main-session turns counted for shares (the denominator of `turn_share`). */
  ownTurns: number;
  /** The main-session turn idxs, in order. */
  ownTurnIdx: number[];
  /** MR ref (profile spelling) → its observed source branches: a model segment never claims another branch's build for it. */
  mrBranches: Map<string, string[]>;
  /** Main-session turn idx of every switch onto an MR's branch: a model segment never claims an edit made after one (S2). */
  mrSwitches: { mainIdx: number; ref: string }[];
  /** Profile ref spelling → the ref's kind, for every ref the profile holds. */
  refKinds: Map<string, ProfileRefKind>;
}

/**
 * `buildProfile`, plus the trace of each build action (D-057 override 1: a
 * model segment only claims actions with no observed link) and which turns
 * a ref already claims (a segment's share comes only from unclaimed turns).
 * The profile is byte-identical to `buildProfile`'s.
 */
export function buildProfileDetailed(
  turns: ProfileTurnInput[],
  opts: BuildProfileOptions = {},
): { profile: SessionProfile; trace: ProfileTrace } {
  const children = opts.childSessions ?? [];
  const flat = flatten(turns, children);
  const { canon, ambiguous } = buildRefCanon(
    flat.map((f) => f.turn),
    opts.projectRepo,
  );

  // D-053: the developer's own ref mentions, in the profile's ref spelling
  // (the one qualified spelling an action used, when there is one). D-055:
  // none at all when the MEMBRAL_INFER_REF kill switch is off.
  const inferRef = opts.inferRef ?? inferRefEnabled();
  const userAt: { pos: number; ref: string; refKind: ProfileRefKind; idx: number; spanTo?: number }[] = [];
  if (inferRef && opts.userRefs && opts.userRefs.length > 0) {
    const posOfIdx = new Map<number, number>();
    flat.forEach((f, pos) => {
      if (!f.child && f.turn.role === "user" && f.turn.kind === "prose") posOfIdx.set(f.turn.idx, pos);
    });
    for (const u of opts.userRefs) {
      const pos = posOfIdx.get(u.idx);
      if (pos === undefined) continue;
      const key = canonKey(u.ref, u.refKind);
      let ref = u.ref;
      if (key && canon.has(key)) ref = canon.get(key) as string;
      else if (key && !ambiguous.has(key) && REF_SHAPE.exec(u.ref)?.[1]) canon.set(key, u.ref);
      userAt.push({
        pos,
        ref,
        refKind: u.refKind,
        idx: u.idx,
        ...(u.spanTo !== undefined ? { spanTo: u.spanTo } : {}),
      });
    }
    userAt.sort((a, b) => a.pos - b.pos);
  }

  const canonical = (ref: string, refKind: ProfileRefKind): string => {
    const m = REF_SHAPE.exec(ref);
    if (!m || m[1]) return ref;
    return canon.get(`${refKind}:${m[3]}`) ?? ref;
  };

  const lineage = lineageContext(flat, canonical, opts);

  // v3: a view may set the focus only when its item is the ONLY item the main
  // session's own actions name (children excluded — their views never move the
  // parent's focus). Any second item and a view is just a look.
  const subjectBareOk = opts.projectIsForgeRepo === true;
  // Review S1/S2: one item across spellings — repo (a bare ref is this project's) + number, and the
  // same kind unless the host is GitHub, where an issue and a PR share one number space.
  const projRepo = opts.projectRepo ? repoKey(opts.projectRepo) : null;
  const projHost = opts.projectHost ? opts.projectHost.toLowerCase() : null;
  const itemOf = (ref: string): { host: string | null; repo: string | null; n: string; marker: string } | null => {
    const m = REF_SHAPE.exec(ref);
    if (!m) return null;
    const prefix = m[1].replace(/\/+$/, "");
    const segs = prefix.toLowerCase().split("/").filter(Boolean);
    const hosted = segs.length >= 3 && segs[0].includes(".");
    const repo = prefix ? repoKey(prefix) : projRepo;
    const host = hosted ? segs[0] : repo !== null && repo === projRepo ? projHost : null;
    return { host, repo, n: m[3], marker: m[2] };
  };
  const sameItem = (a: string, b: string, bKind: ProfileRefKind): boolean => {
    const x = itemOf(a);
    const y = itemOf(b);
    if (!x || !y || x.repo === null || x.repo !== y.repo || x.n !== y.n) return false;
    if (bKind === "issue" && y.marker === "#") return true;
    const gx = x.host ? githubItemKey(`${x.host}/${x.repo}#${x.n}`) : null;
    const gy = y.host ? githubItemKey(`${y.host}/${y.repo}#${y.n}`) : null;
    return gx !== null && gx === gy;
  };
  const mainItems = new Set<string>();
  for (const f of flat) {
    if (f.child) continue;
    for (const a of expandSubjectCommits(turnActions(f.turn), subjectBareOk))
      if (isItemRef(a)) mainItems.add(canonical(a.ref, a.refKind));
  }
  const soleViewRef = mainItems.size === 1 ? [...mainItems][0] : null;

  // Pass 1 finds the ref-less build actions and the focus each would land on;
  // pass 2 folds again with the developer mentions those actions attach to.
  let result = fold(flat, canonical, new Map(), new Set(), lineage, soleViewRef, subjectBareOk, sameItem);
  if (userAt.length > 0 && result.refless.length > 0) {
    const userProsePos: number[] = [];
    flat.forEach((f, pos) => {
      if (!f.child && f.turn.role === "user" && f.turn.kind === "prose") userProsePos.push(pos);
    });
    const { activated, ambiguousAt } = activateUserRefs(userAt, result.refless, userProsePos);
    if (activated.size > 0)
      result = fold(flat, canonical, activated, ambiguousAt, lineage, soleViewRef, subjectBareOk, sameItem);
  }
  const { refs, counts, lastCommitPos } = result;
  // D-057: a turn is claimed when the ref it was credited to keeps turn share (not a view's turn).
  const claimedTurnIdx = new Set<number>();
  for (const [idx, owner] of result.turnOwner) {
    const st = owner === null ? undefined : refs.get(owner);
    if (st && costEligible(st) && !result.viewTurnIdx.has(idx)) claimedTurnIdx.add(idx);
  }

  const total = flat.length;
  // B16: shares are of the main session's own turns (a child's cost is its own).
  const ownTotal = flat.filter((f) => !f.child).length;
  const out: RefProfile[] = [];
  for (const s of refs.values()) {
    const hasDelivery = BUILD_LADDER.some((r) => r !== "edited" && s.build.has(r));
    // A-B7: on a ref the session reviewed (any review rung), an edit counts as
    // building it only when a commit follows in the session — review notes
    // written and never committed are not delivery. A ref with no review rung
    // keeps D-051's `edited` for uncommitted edits (the narrowest change).
    const reviewing = s.review.size > 0;
    const committedEdits = reviewing ? s.editAt.filter((e) => e.pos < lastCommitPos) : s.editAt;
    // Edits deliver on an issue being built, not on an MR checked out for review (B3).
    if (committedEdits.length > 0 && (hasDelivery || !s.review.has("checked_out"))) {
      s.build.add("edited");
      s.evidence.edited = committedEdits[0].ev;
      if (!s.observed && !s.explicit && s.userNamed) s.inferred = true;
      // W4: which way the counted edits reached this ref decides the tier below.
      if (committedEdits.some((e) => e.inf)) s.inferred = true;
      if (committedEdits.some((e) => !e.inf)) s.observedBuild = true;
    } else delete s.evidence.edited;
    // B14: the one rung derived from several calls — the ref was put in front
    // of the agent, then reads/tests (or edits on its checkout) followed, and
    // nothing was delivered on it.
    if (s.seen && !hasDelivery && (s.reads > 0 || s.tests > 0 || (s.edits > 0 && s.review.has("checked_out")))) {
      s.review.add("reviewed");
      s.evidence.reviewed ??= s.evidence.checked_out ?? s.evidence.viewed ?? s.evidence.referenced;
    }
    const review_verb = [...REVIEW_LADDER].reverse().find((r) => s.review.has(r)) ?? null;
    const build_verb = [...BUILD_LADDER].reverse().find((r) => s.build.has(r)) ?? null;
    const discussed =
      !s.triaged &&
      build_verb === null &&
      (review_verb === null || review_verb === "viewed") &&
      committedEdits.length === 0;
    // v4 (driver decisions B1/B2): turn share — and so cost — only through the
    // branch↔PR pairing (costBuild) or an actual review command on the MR. Views,
    // comments, closes, reopens, triage, subject `#N` rungs, pastes, slash lines
    // and the DERIVED `reviewed` (a view + reads) carry none: their turns go back
    // to the session's unclaimed share. The rows and their verbs stay. The turns
    // a view focus collected never price (v3's rule, restored for every ref).
    s.turns = Math.max(0, s.turns - s.viewTurns);
    if (!costEligible(s)) s.turns = 0;
    const profile: RefProfile = {
      ref: s.ref,
      refKind: s.refKind,
      review_verb,
      build_verb,
      triaged: s.triaged,
      discussed,
      // W4: a delivery that reached this ref only through the developer's prose is
      // inferred even when the ref was also viewed (observed) in the session.
      tier:
        build_verb !== null && s.inferred && !s.observedBuild
          ? "inferred_ref"
          : s.observed
            ? "observed"
            : s.inferred
              ? "inferred_ref"
              : "discussed",
      turn_share: 0, // set below, rounded so the session's shares sum exactly (sharesSummingExactly)
      turns: s.turns,
      related_to: [...s.related].sort(),
      first_turn_idx: s.first,
      last_turn_idx: s.last,
      evidence: s.evidence,
      shas: s.shas,
    };
    if (s.state) profile.state = s.state;
    if (s.url) profile.url = s.url;
    if (s.skill) profile.skill = s.skill;
    out.push(profile);
  }
  out.sort((a, b) => a.first_turn_idx - b.first_turn_idx || a.ref.localeCompare(b.ref));
  const shares = sharesSummingExactly(
    out.map((p) => p.turns),
    ownTotal,
  );
  out.forEach((p, i) => {
    p.turn_share = shares[i];
  });

  const profile: SessionProfile = {
    version: 1,
    turns: total,
    edits: counts.edits,
    files: result.files,
    reads: counts.reads,
    tests: counts.tests,
    commits: counts.commits,
    pushes: counts.pushes,
    forgeActions: counts.forgeActions,
    userProse: counts.userProse,
    refs: out,
  };
  return {
    profile,
    trace: {
      builds: result.builds,
      claimedTurnIdx,
      ownTurns: ownTotal,
      ownTurnIdx: flat.filter((f) => !f.child).map((f) => f.turn.idx),
      mrBranches: result.mrBranches,
      mrSwitches: result.mrSwitches,
      refKinds: new Map(out.map((p) => [p.ref, p.refKind])),
    },
  };
}

/**
 * Each ref's share of `total` turns at 4 dp, rounded so the shares sum to
 * the exact total claimed (1 when every turn is claimed): each share is
 * floored, and the remainder units go to the largest fractional parts
 * (largest-remainder), so 3 x 1/3 is 0.3334 + 0.3333 + 0.3333, never 0.9999,
 * and 1/6 + 1/6 + 4/6 never 1.0001. Integer maths in 1e-4 units.
 */
export function sharesSummingExactly(turns: readonly number[], total: number): number[] {
  const UNIT = 10_000;
  if (total <= 0) return turns.map(() => 0);
  const exact = turns.map((t) => (Math.max(0, t) / total) * UNIT);
  const floors = exact.map((x) => Math.floor(x + 1e-9));
  const claimed = turns.reduce((sum, t) => sum + Math.max(0, t), 0);
  const target = Math.round((claimed / total) * UNIT);
  let left = target - floors.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - floors[i] }))
    .filter(({ i }) => turns[i] > 0)
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] += 1;
    left -= 1;
  }
  return floors.map((u) => u / UNIT);
}

// --- role derivation (Vocabulary "Role rule"; B2 observed beats inferred) --------

export type DerivedRole = Role;

/** v4: may this ref take turn share (and cost)? The branch↔PR pairing, or an actual review command on the MR. */
function costEligible(s: RefState): boolean {
  return s.refKind === "merge_request" && (s.costBuild || s.reviewCmd);
}

/** `gh pr review …` segments of a stored command digest (free text is already `‹text›`). */
const GH_PR_REVIEW = /(?:^|[;&|\n(]\s*)(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*gh\s+pr\s+review\b([^;&|\n)]*)/g;

/**
 * v4 B2/S3: did this turn's command run `gh pr review` on the MR `ref`? Read off the turn's
 * stored digest (the action itself says only `commented`, for `gh pr comment` too): a review
 * segment naming the MR's number (`12`, `#12`, or its `/pull/12` URL) counts.
 */
function isReviewCommand(turn: ProfileTurnInput, ref: string): boolean {
  const digest = turn.props?.inputDigest;
  if (typeof digest !== "string") return false;
  const n = /(\d+)$/.exec(ref)?.[1];
  if (!n) return false;
  for (const m of digest.matchAll(GH_PR_REVIEW)) {
    const args = m[1] ?? "";
    if (new RegExp(`(?:^|\\s)#?${n}(?=\\s|$)|/pull/${n}(?!\\d)`).test(args)) return true;
  }
  return false;
}

export function reviewRank(v: string | null | undefined): number {
  return v && v in REVIEW_RANK ? REVIEW_RANK[v as ReviewRung] : 0;
}
export function buildRank(v: string | null | undefined): number {
  return v && v in BUILD_RANK ? BUILD_RANK[v as BuildRung] : 0;
}

/**
 * v4 read-time guard (Issues page, Today): may a stored row's turn share carry
 * cost? Cost comes only from PR/branch evidence (driver B1), so only an
 * observed merge-request row with a build rung (committed+) or a review verb
 * can; an issue row never does (a commit naming an issue is a label, and a
 * close is a closure verb). A row derived after v4 already carries share 0
 * otherwise; this bounds rows derived before v4 (the deploy re-derives every
 * session with a positive share — S2). D-053 `inferred_ref` and model tiers never price.
 */
export function rowCarriesCost(row: {
  kind: string;
  review_verb?: string | null;
  build_verb?: string | null;
  tier?: string | null;
}): boolean {
  if (row.tier === "inferred_ref" || row.tier === "inferred" || row.tier === "discussed") return false;
  if (row.kind !== "merge_request") return false;
  return buildRank(row.build_verb) >= BUILD_RANK.committed || reviewRank(row.review_verb) >= REVIEW_RANK.commented;
}

/**
 * The role, from the observed verbs only (v4 item 7): `worked_on` ⇔ a rung at
 * reviewed+ (review) or committed+ (build); a ref with no verb at all —
 * triage alone, a filing, a slash-line mention, every model-proposed ref —
 * is `referenced`; `referenced` too for an observed ref that got no turn of
 * the session (a `viewed` in passing); `discussed` otherwise.
 */
export function deriveRole(
  p: Pick<RefProfile, "review_verb" | "build_verb" | "triaged" | "tier" | "turn_share"> | null | undefined,
): DerivedRole {
  if (!p) return "referenced";
  if (reviewRank(p.review_verb) >= REVIEW_RANK.reviewed || buildRank(p.build_verb) >= BUILD_RANK.committed) {
    return "worked_on";
  }
  if (!p.review_verb && !p.build_verb) return "referenced";
  if (p.tier === "observed" && p.turn_share === 0) return "referenced";
  return "discussed";
}

/**
 * v4 read-time role for a stored row (Issues page): the verbs decide, never a
 * role an older model pass wrote. No verb → `referenced`; a `worked_on` whose
 * verbs do not reach it → `discussed`.
 */
export function roleFromStoredVerbs(row: {
  role: DerivedRole;
  review_verb?: string | null;
  build_verb?: string | null;
}): DerivedRole {
  if (reviewRank(row.review_verb) >= REVIEW_RANK.reviewed || buildRank(row.build_verb) >= BUILD_RANK.committed)
    return "worked_on";
  if (reviewRank(row.review_verb) === 0 && buildRank(row.build_verb) === 0) return "referenced";
  return row.role === "worked_on" ? "discussed" : row.role;
}
