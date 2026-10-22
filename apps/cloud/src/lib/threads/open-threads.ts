// Open threads — goal 2026-09-26 W7 / P5 (D-051). Pure: `computeThreads(rows)`
// folds what the dashboard already stores about a ref into one Thread per
// ref; queries.ts is the only module that touches Supabase.
//
// A Thread is one qualified ref (`host/owner/repo#N` or `!N`, exactly as
// `code_session_issues.ref` qualifies it) — never a branch, never a cwd
// (Vocabulary). Everything on it is observed: the ladders come from
// `code_session_issues.review_verb/build_verb` (W4's profile, folded from the
// turns' structured actions), the shas and closure verbs from
// `code_session_turns.props.action(s)` (W3), the merge/branch-gone proof from
// `memory_branch_state` (W6's ref-keyed sweep). No number here comes from a
// model's reading of the transcript.
//
// Behaviour contract (docs/goals/2026-09-26_open-threads-from-observed-actions_goal.md):
//   B5  a ref with only `discussed` sessions is listed (`recent`) with its cost
//       and is never `open`.
//   B6  open needs two facts: (a) a build rung >= `committed` on the ref in
//       the window, and (b) no closure evidence — no `merged`/`closed` action
//       on the ref at or after the last build action, no `memory_branch_state`
//       proof (merged_at / branch_gone_at) for a branch the thread's own
//       commits sit on. `edited` alone never opens. Review-ladder refs never
//       open: a review that reached `reviewed` with no `commented` seen carries
//       the plain note "no comment seen" — no badge, never "unresolved".
//       Rewrites move the closure check to the newest sha per branch: a
//       branch-state row whose `last_seen_sha` is a sha the thread superseded
//       is not evidence; a row whose sha is a LATER commit on the branch is
//       (the thread's older shas are its ancestors). `branch_gone_at` is
//       sha-independent and counts only on a row that also carries a
//       `last_seen_sha` — the row must prove the branch existed and vanished.
//   B8  `priority` is the owner's own quote (a user-turn preference/decision
//       memory on the ref that extraction flagged `priority: true` — the
//       model's reading of the owner's words, in any language; no word list
//       here) or absent. Nothing sorts by it.
//   B11 `cost_est` per session = the session's cost x the row's `turn_share`;
//       `cost_est_total` is their sum; every figure is an estimate.
//   B12 nothing here throws — a malformed action is skipped, a session with no
//       rows yields no thread.
//
// Judgement calls, recorded so P6 can overturn a rule row rather than the page:
//   - `triaged` is not a column: a `worked_on` row with neither ladder rung is
//     a triage (the Role rule's only remaining way to be worked_on), as is a
//     `triaged` action naming the ref.
//   - a `committed`/`pushed`/`rewrote` action carries a branch or sha, not an
//     issue ref (the profile assigned it by focus); here it belongs to every
//     ref the same session has at build rung >= committed. Two refs committed
//     in one session share their shas.
//   - the `closed` verb on a BRANCH (`push --delete`, `branch -d`) is closure
//     evidence for a thread whose commits sit on that branch (B14 closure
//     class), same strength as a forge `closed`.
//   - a dismissed thread (a `thread_dismissals` row on its (kind, ref)) stays
//     in `recent` with `dismissed: true` — the day's cost is still a fact —
//     and is never open, until a new observed committed/pushed/opened_mr
//     action on it lands after the dismissal (maintainer rule).
//   - identity is (kind, ref) everywhere: a glab-style issue #17 and MR !17 share
//     the stored ref `host/owner/repo#17`, so a memory or dismissal names a
//     thread only with its kind. A kind-less memory ref matches by the exact
//     string only when no thread of the other kind shares that string.
//   - B16: a sub-agent session folds into its parent when the parent is in
//     the window — its issue rows raise the parent's rungs, its actions act
//     as the parent's. Cost is priced per session: the parent's cost x the
//     parent's own row share, plus each child's cost x that child's own row
//     share (a child's turns are not in the parent's share, so a sub-agent
//     never takes a slice of the whole orchestration's cost). A child with
//     no worked_on row of its own is priced at the parent's share on each of
//     the parent's refs, so its cost never vanishes. Branch and
//     closure evidence comes only from the sessions that acted on the ref
//     (a row at build >= committed, or a child whose own action names it),
//     never from a sibling child's commits. `parent_source_session_id` is the parent's SOURCE session id
//     (migration 089), so the parent is found by (source, source_session_id)
//     — or by id. A child whose parent is not in hand is not shown on its own
//     (B16: a child's rows are never a separate row).
//   - a `reopened` state (or verb) on the ref after its last closure
//     evidence voids that closure — the forge says the item is live again.
//   - `title` is observed text only: the newest commit subject among the
//     thread's own commits, else the forge's own title from a view result
//     naming the ref, else the ref itself — never an evidence quote or a
//     command digest (a subject carrying the digest's `‹text›` placeholder
//     is command text, not a subject).
//   - "later" is wall-clock: actions order by the turn's `ts`, falling back
//     to the session start, then (session id, idx).
//   - a row with `tier: discussed` contributes no observed rung (B5): its
//     verbs are shown per session, never folded into the ladder.
//   - an observed merge of an MR never closes the issue it served (maintainer
//     decision, review F7): `related_to` links rows, it does not carry
//     closure. The issue closes on its own evidence.
//   - a sweep proof (`memory_branch_state`) counts only when its
//     `last_seen_sha` is the newest sha a session on this thread named on
//     that branch: a reused branch name with an unrelated sha proves nothing.
//   - `last_seen_at` is the latest session start on the ref, not a clock read.
//   - an action names a thread by (kind, number): `code_session_issues.ref` is
//     always `host/owner/repo#N` (extract.ts's qualifyIssueRef maps `!N` to
//     `#N`), while `glab mr merge 17049` yields `ref: "!17049"`. The action's
//     `refKind` decides the kind when present (GitHub PRs are `#N`), else the
//     marker does; a project part (`acme/billing!17`, a full host path) must
//     match the thread's `owner/repo` tail. A BARE ref (`#15`, `!17`) counts
//     only from a session in one of the thread's own projects — `#15` in
//     project B never closes `…/acme/billing#15`.

import {
  type AttributionTurnInput,
  commitTiedToItem,
  mrBranchesBySession,
  subAgentParents,
} from "@/lib/agent-stats/attribution";
import { childCostOnItem, rowlessChildrenByCostParent } from "@/lib/agent-stats/child-pricing";
import { rowCarriesCost } from "@/lib/code-sessions/profile";
import { preferredRef } from "@/lib/code-sessions/ref-canon";
import { BUILD_RANK, type BuildRung, REVIEW_RANK, type ReviewRung, ROLE_RANK, type Role } from "@/lib/domain/ladder";
import { foldDiscussedKinds, githubItemKey, itemKeyResolver } from "@/lib/domain/ref-identity";
import { type ForgeFamily, type ForgeRefKind, refToUrl } from "@/lib/forge/ref-url";
import { type ForgeEvidence, glabFamilyOf, glabHostsFrom, turnPropsEvidence } from "@/lib/format/forge-url";
import { CLOSURE_DETECTORS, type ClosureContext, cmpPos, rank, timeOf } from "@/lib/threads/closure";

export const THREAD_WINDOW_DAYS = 30;
export const THREAD_LIMIT = 5;
export const BLOCKER_LIMIT = 5;

export type { BuildRung, ReviewRung } from "@/lib/domain/ladder";
export type ThreadRole = Role;

/** The build rungs that are delivery (D-051); `merged`/`closed` are closure, never delivery on their own. */
const DELIVERY_RUNGS: ReadonlySet<string> = new Set(["committed", "pushed", "opened_mr"]);
const SHA_RE = /^[0-9a-f]{7,40}$/;
const BARE_REF_RE = /^[#!]\d+$/;
const DETACHED_BRANCH_PREFIX = "commit:";
const MAX_TITLE_CHARS = 200;
/** The digest's stand-in for a message/title value (core forge-actions.ts): a subject holding it is command text. */
const DIGEST_TEXT_PLACEHOLDER = "‹text›";

// ---- dismissals ---------------------------------------------------------------

/**
 * A dismissal is a `thread_dismissals` row (migration 106) keyed by
 * (user, kind, ref), written by POST /api/threads/dismiss. It lives in its own
 * table, not in `session_memories`, so no memory, MCP or preamble path can
 * serve it (D-051) and no turn is claimed as its receipt (B1).
 */
export const DISMISS_REASONS = ["resolved_elsewhere", "not_delivery_item"] as const;
export type DismissReason = (typeof DISMISS_REASONS)[number];
export const DISMISS_LABEL: Record<DismissReason, string> = {
  resolved_elsewhere: "Resolved elsewhere",
  not_delivery_item: "Not a delivery item",
};

/** One `thread_dismissals` row. */
export interface ThreadDismissalRow {
  ref: string;
  kind: ForgeRefKind;
  reason: DismissReason;
  created_at?: string | null;
}

/** Identity of a thread everywhere (UI keys, dismiss body, dedup): kind + ref. */
export function threadKey(t: { ref: string; kind?: ForgeRefKind; refKind?: ForgeRefKind }): string {
  return `${t.refKind ?? t.kind ?? "issue"}:${t.ref}`;
}

// ---- rows in ------------------------------------------------------------------

/** One `code_session_issues` row (migrations 099 + 103). Pre-W4 rows carry none of the profile columns. */
export interface ThreadIssueRow {
  session_id: string;
  ref: string;
  number: number;
  kind: ForgeRefKind;
  role: ThreadRole;
  evidence_quote: string | null;
  turn_idx: number;
  review_verb?: string | null;
  build_verb?: string | null;
  /** `inferred_ref` (D-053): an observed build action whose ref came from the developer's prose. */
  tier?: "observed" | "discussed" | "inferred" | "inferred_ref" | null;
  turn_share?: number | string | null;
  related_to?: string[] | null;
}

/** The subset of `code_sessions` a thread needs; `cost_usd` is priced by the caller (queries.ts) from props.usage. */
export interface ThreadSessionRow {
  id: string;
  code_project_id: string | null;
  started_at: string | null;
  git_branch: string | null;
  turn_count: number | null;
  /** The parent's source session id (089); sub-agent sessions fold into that parent (B16). */
  parent_source_session_id?: string | null;
  /** With `source_session_id`, how a child names its parent (089: no FK, same namespace). */
  source?: string | null;
  source_session_id?: string | null;
  /** The session's estimated cost in USD (main transcript), null when unpriced. */
  cost_usd: number | null;
  /** Last activity (UX pass 2: the ?group=session header's date); optional for older callers. */
  ended_at?: string | null;
}

/** One `code_session_turns` row that carries `props.action`/`props.actions`. */
export interface ThreadTurnRow {
  session_id: string;
  idx: number;
  /** Wall-clock time of the turn; orders actions across sessions (F4). */
  ts?: string | null;
  props: Record<string, unknown> | null;
}

/** `memory_branch_state` (migration 084), as W6 writes it. */
export interface ThreadBranchStateRow {
  code_project_id: string;
  branch: string;
  last_seen_sha: string | null;
  merged_into: string | null;
  merged_at: string | null;
  branch_gone_at: string | null;
}

/** Live `session_memories` rows: owner quotes on a ref (B8) and blockers (B7). */
export interface ThreadMemoryRow {
  id?: string;
  kind: string;
  ref: string | null;
  /** 084's open enum: `mr`/`pr`/`merge_request` name a merge request, `issue` an issue. */
  ref_kind?: string | null;
  text: string | null;
  quote: string | null;
  turn_role: string | null;
  turn_idx?: number | null;
  recurrence_count?: number | null;
  /** Extraction's own reading (migration 107): the owner's words put this item first or on a clock. */
  priority?: boolean | null;
  retired_at?: string | null;
  created_at?: string | null;
  code_session_id?: string | null;
  /** B7 chain link (queries.ts collapses each chain to its newest live row before computeThreads). */
  recurs_of?: string | null;
  /** When the blocker was last SEEN: ended_at (else started_at) of the newest chain member's session — never the extraction clock. */
  seen_at?: string | null;
}

export interface ComputeThreadsInput {
  issues: readonly ThreadIssueRow[];
  sessions: readonly ThreadSessionRow[];
  turns?: readonly ThreadTurnRow[];
  branchState?: readonly ThreadBranchStateRow[];
  memories?: readonly ThreadMemoryRow[];
  dismissals?: readonly ThreadDismissalRow[];
  /**
   * v4 item 5: wall-clock time of each issue row's proof turn (any turn, not
   * only action turns — a sub-agent's spawn row has no action). A row is dated
   * by its action turn, never by its session's start.
   */
  turnTimes?: readonly { session_id: string; idx: number; ts: string | null }[];
  /** UX pass 2 (review r2 S1): code_projects.id → repo_identity, so a bare `#N` in a commit subject names that repo's item. */
  projectIdentity?: Readonly<Record<string, string | null>>;
  /** Hosts the caller already knows are glab-family (forge-url.ts `glabHostsFrom`); merged with what these rows show. */
  glabHosts?: readonly string[];
}

// ---- threads out --------------------------------------------------------------

export interface ThreadSession {
  id: string;
  started_at: string | null;
  /** v4 item 5: when the row's own action happened (its proof turn's `ts`); `started_at` when unknown. */
  at?: string | null;
  /** The turn the row traces to (B1): the issue row's `turn_idx`, in `proof_session_id`. */
  turn_idx: number;
  /** The session whose turn proves the row: `id`, or the sub-agent child it folded in from (B16). */
  proof_session_id: string;
  /** `observed` unless every row folded here is `discussed` (tier shown, not flattened); `inferred_ref` when its build rung came only from the developer's prose naming the ref (D-053). */
  tier: "observed" | "discussed" | "inferred_ref";
  role: ThreadRole;
  review_verb: ReviewRung | null;
  build_verb: BuildRung | null;
  /** This ref's share of the session's turns (B15), 0..1. */
  share: number;
  /** session cost x share (B11); null when the session is unpriced. */
  cost_est: number | null;
  /** UX pass 2 (?group=session): the whole session's est. cost (`cost_usd`) and its last activity. */
  session_cost_usd?: number | null;
  ended_at?: string | null;
}

export type ThreadClosure =
  | {
      kind: "action";
      session_id: string;
      turn_idx: number;
      /** `merged` | `closed` — the observed verb (or the forge's `state` word). */
      verb: string;
    }
  | {
      kind: "branch_state";
      code_project_id: string;
      branch: string;
      merged_into: string | null;
      merged_at: string | null;
      branch_gone_at: string | null;
    };

export interface Thread {
  ref: string;
  refKind: ForgeRefKind;
  /** Forge page (lib/forge/ref-url.ts); null when the host is unknown. */
  url: string | null;
  /** "gitlab" when the user's own data shows the ref's host is glab-family (forge-url.ts); absent otherwise. `forgeUrl` links by it. */
  forge_family?: ForgeFamily;
  /** Newest commit subject on the thread's commits, else the forge's title from a view result, else the ref (never command text). */
  title?: string;
  /** UX pass 2: the forge's own item title, read off a view result tied to this ref (core forge-actions.ts `title`). */
  forge_title?: string;
  /** UX pass 2: the subject of the first commit attributed to the item (observed). */
  first_commit_subject?: string;
  /** UX pass 2: distinct commit shas attributed to the item. */
  commit_count?: number;
  ladder: {
    review_verb: ReviewRung | null;
    build_verb: BuildRung | null;
    triaged: boolean;
    /** B5: no observed rung at all. */
    discussed: boolean;
  };
  /** Ascending by started_at. */
  sessions: ThreadSession[];
  /** Sum of `sessions[].cost_est` (B11); null when no session was priced. */
  cost_est_total: number | null;
  estimated: true;
  /** v4 item 5: the latest action on the ref (its proof turn's time), else the latest session start. */
  last_seen_at: string | null;
  /** B6. */
  open: boolean;
  closure: ThreadClosure | null;
  /** Plain text, only for a review that reached `reviewed` with no `commented` seen (B6). */
  note?: "no comment seen";
  /** The owner's own quote stating urgency/ordering (B8), verbatim; absent otherwise. */
  priority?: string;
  /** Max `recurrence_count` of live blockers on the ref when >= 2 (B7). */
  recurrence_count?: number;
  /** D-053: every build rung >= committed came from sessions whose ref was inferred from the developer's prose — the row says "linked from your prompt". */
  inferred_ref?: true;
  /**
   * Review S1: every observed action on the thread with its own turn time — the
   * Yesterday block ladders and windows by these, never by a whole session's
   * row. `session` is the owner session (a child's action counts for its parent).
   */
  events?: ThreadEvent[];
  /** A `thread_dismissals` row exists on (kind, ref). Never open. */
  dismissed?: true;
  dismiss_reason?: DismissReason;
}

export interface ThreadEvent {
  session: string;
  at: string | null;
  review_verb: ReviewRung | null;
  build_verb: BuildRung | null;
}

export interface RecurringBlocker {
  id: string;
  text: string;
  /** The owner's own words only: null unless the blocker came from a user turn. */
  quote: string | null;
  ref: string | null;
  recurrence_count: number;
  session_id: string | null;
  turn_idx: number | null;
  last_seen_at: string | null;
}

export interface ComputeThreadsResult {
  /** B6 threads, sorted by est. spend desc (then latest first), capped at `limit`. */
  open: Thread[];
  /** Every thread in the window, discussed included, latest first (the Yesterday block). */
  recent: Thread[];
  /** Live blockers (B7), recurrence desc then latest first, capped at BLOCKER_LIMIT. */
  recurring_blockers: RecurringBlocker[];
  estimated: true;
}

// ---- helpers ------------------------------------------------------------------

export interface ObservedAction {
  verb: string;
  ref?: string;
  refKind?: string;
  sha?: string;
  url?: string;
  branch?: string;
  state?: string;
  subject?: string;
  /** The forge's own item title, when a view result showed it (core adds it; treated like a subject). */
  title?: string;
}

function readActions(props: Record<string, unknown> | null): ObservedAction[] {
  if (!props || typeof props !== "object") return [];
  const list = Array.isArray(props.actions) ? props.actions : props.action ? [props.action] : [];
  const out: ObservedAction[] = [];
  for (const a of list) {
    if (!a || typeof a !== "object") continue;
    const r = a as Record<string, unknown>;
    if (typeof r.verb !== "string") continue;
    // D-051 F1: an action whose repo nothing observable named never counts for the session's project.
    if (r.repoUnknown === true) continue;
    out.push({
      verb: r.verb,
      ref: typeof r.ref === "string" ? r.ref : undefined,
      refKind: typeof r.refKind === "string" ? r.refKind : undefined,
      sha: typeof r.sha === "string" && SHA_RE.test(r.sha.toLowerCase()) ? r.sha.toLowerCase() : undefined,
      url: typeof r.url === "string" ? r.url : undefined,
      branch: typeof r.branch === "string" ? r.branch : undefined,
      state: typeof r.state === "string" ? r.state : undefined,
      subject: typeof r.subject === "string" ? r.subject : undefined,
      title: typeof r.title === "string" ? r.title : undefined,
    });
  }
  return out;
}

function higher<T extends string>(table: Record<string, number>, a: T | null, b: string | null | undefined): T | null {
  if (!b || !(b in table)) return a;
  if (!a || table[b] > table[a]) return b as T;
  return a;
}

function asShare(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
}

function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

const REF_TAIL_RE = /^(.*?)([#!])(\d+)$/;

interface ParsedRef {
  /** `host/owner/repo`, `owner/repo` or "" for a bare `#N`/`!N`. */
  project: string;
  marker: "#" | "!";
  number: number;
}

function parseRef(ref: string): ParsedRef | null {
  const m = REF_TAIL_RE.exec(ref.trim());
  if (!m) return null;
  const number = Number(m[3]);
  if (!Number.isSafeInteger(number)) return null;
  return { project: m[1].replace(/\/+$/, ""), marker: m[2] as "#" | "!", number };
}

/** `acme/billing` names `codehub.example/acme/billing` (and vice versa); `x/billing` does not. */
function projectTailMatches(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/** A ref with no project part (`#15`, `!17`) — meaningful only inside the project the session ran in. */
export function isBareRef(ref: string | undefined): boolean {
  return !!ref && BARE_REF_RE.test(ref.trim());
}

export interface ThreadKey {
  ref: string;
  kind: ForgeRefKind;
  url: string | null;
  /** Another thread of the other kind shares this exact ref string (glab-style `#17` and `!17`). */
  ambiguous?: boolean;
}

/**
 * An action (or a memory's ref) names the thread: the same (kind, number) —
 * see the header's judgement call — or the thread's URL. The action's
 * `refKind`, when it is an issue/merge_request, decides the kind; otherwise
 * the marker does (`!` merge request, `#` issue), except that the exact
 * stored ref (`host/owner/repo#N`) names its thread when no thread of the
 * other kind shares that string.
 */
export function refMatches(
  action: { ref?: string | null; refKind?: string | null } | string | undefined,
  thread: ThreadKey,
): boolean {
  const actionRef = typeof action === "string" ? action : (action?.ref ?? undefined);
  const refKind = typeof action === "string" ? undefined : (action?.refKind ?? undefined);
  if (!actionRef) return false;
  const kindKnown = refKind === "issue" || refKind === "merge_request";
  if (kindKnown && refKind !== thread.kind) return false;
  const trimmed = actionRef.trim();
  if (trimmed === thread.ref && (kindKnown || !thread.ambiguous)) return true;
  if (/^https?:\/\//i.test(trimmed)) {
    if (!thread.url) return false;
    try {
      return new URL(trimmed).toString().replace(/\/$/, "") === thread.url.replace(/\/$/, "");
    } catch {
      return false;
    }
  }
  const a = parseRef(trimmed);
  const t = parseRef(thread.ref);
  if (!a || !t || a.number !== t.number) return false;
  if (!kindKnown) {
    const kindOfMarker: ForgeRefKind = a.marker === "!" ? "merge_request" : "issue";
    if (kindOfMarker !== thread.kind) return false;
  }
  if (a.project && !projectTailMatches(t.project, a.project)) return false;
  return true;
}

/** session_memories.ref_kind (084's open enum) → a forge kind, or undefined when it names neither. */
export function memoryRefKind(refKind: string | null | undefined): ForgeRefKind | undefined {
  const k = refKind?.trim().toLowerCase();
  if (k === "mr" || k === "pr" || k === "merge_request") return "merge_request";
  if (k === "issue") return "issue";
  return undefined;
}

/**
 * e2e R-6: a title that falls back to the ref never shows a local absolute
 * path — a non-git project's ref (`/private/tmp/…/cwd/notes#7`) keeps only
 * its last two path segments (`cwd/notes#7`, the project's display name).
 */
export function displayRef(ref: string): string {
  const at = Math.max(ref.lastIndexOf("#"), ref.lastIndexOf("!"));
  if (at <= 0) return ref;
  const prefix = ref.slice(0, at);
  if (!/^(\/|~\/|[A-Za-z]:[\\/])/.test(prefix)) return ref;
  const segs = prefix.split(/[\\/]+/).filter(Boolean);
  return `${segs.slice(-2).join("/")}${ref.slice(at)}`;
}

/** B8: extraction flagged the owner's words as a priority (the model's reading, any language). */
function isOwnerPriority(m: ThreadMemoryRow): boolean {
  return (
    (m.kind === "preference" || m.kind === "decision") &&
    m.turn_role === "user" &&
    m.priority === true &&
    !!m.quote?.trim()
  );
}

/** The forge says the item is live again (`gh issue reopen`, a view showing `reopened`). */
function isReopenVerb(a: ObservedAction): boolean {
  return a.verb === "reopened" || a.state === "reopened";
}

/**
 * Observed free text fit for a title: one line, capped; null for command text.
 * Core already redacts a subject (secrets, emails, phones) at parse time;
 * queries.ts re-redacts every title server-side — this module stays free of
 * core's node-only code because client components import it.
 */
function observedTitle(text: string | undefined): string | null {
  if (!text || text.includes(DIGEST_TEXT_PLACEHOLDER)) return null;
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return null;
  return clean.length > MAX_TITLE_CHARS ? `${clean.slice(0, MAX_TITLE_CHARS - 1)}…` : clean;
}

/** Wall-clock position of an action (F4): turn ts, else session start; ties by (session id, idx). */
export interface Pos {
  t: number;
  sid: string;
  idx: number;
}

function cmpSessionStart(a: ThreadSessionRow | undefined, b: ThreadSessionRow | undefined): number {
  const ta = timeOf(a?.started_at) ?? 0;
  const tb = timeOf(b?.started_at) ?? 0;
  if (ta !== tb) return ta - tb;
  const ia = a?.id ?? "";
  const ib = b?.id ?? "";
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/** Several rows on one (owner session, kind, ref) — the parent's own and its children's (B16) — as one. */
export interface FoldedRow {
  owner: string;
  /** The row whose turn is the proof: the owner's own strongest row, else the child's. */
  proof: ThreadIssueRow;
  /** Every row folded here (the owner's and its children's) — the link may land on a child's action turn. */
  all: ThreadIssueRow[];
  role: ThreadRole;
  review_verb: ReviewRung | null;
  build_verb: BuildRung | null;
  observed: boolean;
  /** D-053: the build rung came only from `inferred_ref` rows. */
  inferredRef: boolean;
  observedBuild: boolean;
  /** The owner's own share when it has a row, else the child's (a proxy). */
  turn_share: number | string | null | undefined;
  /** Each contributing session's own row (strongest role): its share prices that session's cost. */
  parts: Map<
    string,
    {
      role: ThreadRole;
      turn_share: number | string | null | undefined;
      build_verb: BuildRung | null;
      /** v4 item 1: the row's verbs are build evidence (or an MR review) — only then does its share price. */
      priced: boolean;
    }
  >;
}

/**
 * The row a link should land on: the proof when its turn carries an action on
 * the item, else the first folded row (owner's first, then a child's) whose
 * turn does — so a parent's sub-agent spawn row never takes the link from the
 * child turn that actually commented/reviewed. No action turn anywhere: the proof.
 */
export function linkRow(
  proof: ThreadIssueRow,
  all: readonly ThreadIssueRow[],
  actionTurns: ReadonlySet<string>,
): ThreadIssueRow {
  const has = (r: ThreadIssueRow) => actionTurns.has(`${r.session_id}\u0000${r.turn_idx}`);
  if (has(proof)) return proof;
  // Among action rows: the stronger role first (a comment beats a passing view), then the proof's own session.
  const rank = (r: ThreadIssueRow) => (ROLE_RANK[r.role] ?? 0) * 2 + (r.session_id === proof.session_id ? 1 : 0);
  const withAction = all.filter(has).sort((a, b) => rank(b) - rank(a));
  return withAction[0] ?? proof;
}

function observedRow(row: ThreadIssueRow): boolean {
  return row.tier !== "discussed";
}

// ---- compute ------------------------------------------------------------------

export function computeThreads(
  input: ComputeThreadsInput,
  opts: { limit?: number; now?: Date } = {},
): ComputeThreadsResult {
  const limit = Math.max(0, opts.limit ?? THREAD_LIMIT);
  const sessions = new Map(input.sessions.map((s) => [s.id, s]));
  const memories = (input.memories ?? []).filter((m) => (m.retired_at ?? null) === null);
  const branchState = input.branchState ?? [];
  const dismissals = input.dismissals ?? [];
  // e2e A-B2 + S5: one key per item across stored spellings; different hosts stay apart.
  const itemReadKey = itemKeyResolver([...input.issues, ...dismissals]);
  // Review r2 S1: a commit counts for an item only when attribution TIES it to that item
  // (its MR's source branch, or its own subject names it) — the Issues page's commits rule.
  const mrBranches = mrBranchesBySession((input.turns ?? []) as unknown as AttributionTurnInput[]);
  const projectOf = new Map<string, string>();
  for (const s of input.sessions) {
    const identity = s.code_project_id ? input.projectIdentity?.[s.code_project_id] : null;
    if (identity) projectOf.set(s.id, identity);
  }
  const tieKey = (r: { ref: string; kind: ForgeRefKind }) => itemReadKey(r.ref, r.kind);
  // v4 item 5: a row's own turn time — from turnTimes, else an action turn of the same idx.
  const turnTs = new Map<string, string>();
  for (const t of input.turns ?? []) if (t.ts) turnTs.set(`${t.session_id}\u0000${t.idx}`, t.ts);
  for (const t of input.turnTimes ?? []) if (t.ts) turnTs.set(`${t.session_id}\u0000${t.idx}`, t.ts);
  const turnTime = (sessionId: string, idx: number): string | null => turnTs.get(`${sessionId}\u0000${idx}`) ?? null;

  // B16: a child folds into its parent, found by (source, source_session_id)
  // or by id; a child whose parent is not in hand has no owner (null).
  const bySource = new Map<string, string>();
  for (const s of input.sessions) {
    if (s.source_session_id) bySource.set(`${s.source ?? ""}\u0000${s.source_session_id}`, s.id);
  }
  const ownerOf = (sessionId: string, seen: string[] = []): string | null => {
    if (seen.includes(sessionId)) return null;
    const s = sessions.get(sessionId);
    const parent = s?.parent_source_session_id ?? null;
    if (!parent) return sessionId;
    const found = bySource.get(`${s?.source ?? ""}\u0000${parent}`) ?? (sessions.has(parent) ? parent : undefined);
    if (!found || found === sessionId) return null;
    // D-066: a nested child (grandchild, ...) folds into its root like any child; a cycle or a
    // parent not in hand leaves it without an owner.
    return ownerOf(found, [...seen, sessionId]);
  };

  // Actions in wall-clock order (F4), each tagged with the session it folds into.
  const actions: { session_id: string; owner: string; idx: number; pos: Pos; a: ObservedAction }[] = [];
  for (const t of input.turns ?? []) {
    const s = sessions.get(t.session_id);
    if (!s) continue;
    const owner = ownerOf(t.session_id);
    if (!owner) continue;
    const pos: Pos = { t: timeOf(t.ts) ?? timeOf(s.started_at) ?? 0, sid: t.session_id, idx: t.idx };
    for (const a of readActions(t.props)) {
      actions.push({ session_id: t.session_id, owner, idx: t.idx, pos, a });
    }
  }
  actions.sort((x, y) => cmpPos(x.pos, y.pos));

  // The forge family of each host, from data only (forge-url.ts): glab-grammar
  // URLs in actions/evidence quotes, and hosts a `glab` command acted on.
  const evidence: ForgeEvidence[] = [];
  for (const t of input.turns ?? []) evidence.push(...turnPropsEvidence(t.props, projectOf.get(t.session_id)));
  for (const r of input.issues) evidence.push({ text: r.evidence_quote });
  const glabHosts = glabHostsFrom(evidence);
  for (const h of input.glabHosts ?? []) glabHosts.add(h.toLowerCase());

  // Issue rows folded per (owner session, kind, ref).
  const groups = new Map<string, { ref: string; kind: ForgeRefKind; bySession: Map<string, FoldedRow> }>();
  // One thread per item: a discussed-only GitHub row takes the kind the item was observed as.
  for (const row of foldDiscussedKinds(input.issues)) {
    if (!sessions.has(row.session_id)) continue;
    if (row.kind !== "issue" && row.kind !== "merge_request") continue;
    const owner = ownerOf(row.session_id);
    if (!owner) continue;
    const own = owner === row.session_id;
    // e2e A-B2: `host/o/r#N`, `o/r!N` and `o/r/-/merge_requests/N` rows are one thread.
    const key = itemReadKey(row.ref, row.kind);
    let g = groups.get(key);
    if (!g) {
      g = { ref: row.ref, kind: row.kind, bySession: new Map() };
      groups.set(key, g);
    } else g.ref = preferredRef(g.ref, row.ref);
    const observed = observedRow(row);
    const rv = observed && row.review_verb && row.review_verb in REVIEW_RANK ? (row.review_verb as ReviewRung) : null;
    const bv = observed && row.build_verb && row.build_verb in BUILD_RANK ? (row.build_verb as BuildRung) : null;
    const inferredBuild = !!bv && row.tier === "inferred_ref";
    const observedBuild = !!bv && row.tier !== "inferred_ref";
    const prev = g.bySession.get(owner);
    const part = { role: row.role, turn_share: row.turn_share, build_verb: bv, priced: rowCarriesCost(row) };
    if (!prev) {
      g.bySession.set(owner, {
        parts: new Map([[row.session_id, part]]),
        owner,
        proof: row,
        all: [row],
        role: row.role,
        review_verb: rv,
        build_verb: bv,
        observed,
        inferredRef: inferredBuild,
        observedBuild,
        turn_share: row.turn_share,
      });
      continue;
    }
    prev.all.push(row);
    const prevPart = prev.parts.get(row.session_id);
    if (!prevPart) prev.parts.set(row.session_id, part);
    else {
      if ((ROLE_RANK[row.role] ?? 0) > (ROLE_RANK[prevPart.role] ?? 0)) {
        prevPart.role = row.role;
        prevPart.turn_share = row.turn_share;
        prevPart.priced = rowCarriesCost(row);
      }
      prevPart.build_verb = higher(BUILD_RANK, prevPart.build_verb, bv);
    }
    const prevOwn = prev.proof.session_id === owner;
    const stronger = (ROLE_RANK[row.role] ?? 0) > (ROLE_RANK[prev.role] ?? 0);
    if ((own && !prevOwn) || (own === prevOwn && stronger)) {
      prev.proof = row;
      prev.turn_share = row.turn_share;
    }
    if (stronger) prev.role = row.role;
    prev.review_verb = higher(REVIEW_RANK, prev.review_verb, rv);
    prev.build_verb = higher(BUILD_RANK, prev.build_verb, bv);
    prev.observed = prev.observed || observed;
    // Observed build evidence from any row outranks the inferred label.
    prev.observedBuild = prev.observedBuild || observedBuild;
    prev.inferredRef = (prev.inferredRef || inferredBuild) && !prev.observedBuild;
  }

  // Pre-W4 rows (no turn_share): a session splits equally across its worked_on rows.
  const workedOnWithoutShare = new Map<string, number>();
  for (const g of groups.values()) {
    for (const row of g.bySession.values()) {
      for (const [sid, p] of row.parts) {
        if (p.role === "worked_on" && asShare(p.turn_share) === null) {
          workedOnWithoutShare.set(sid, (workedOnWithoutShare.get(sid) ?? 0) + 1);
        }
      }
    }
  }
  // B16 cost, D-066: a sub-agent child with no rows of its own is priced on its parent's
  // items in the parent's proportions (one rule, shared with the Issues view:
  // agent-stats/child-pricing.ts). It never creates a priced item.
  const sessionsWithRows = new Set(input.issues.filter((r) => rowCarriesCost(r)).map((r) => r.session_id));
  const childrenOf = rowlessChildrenByCostParent(
    input.sessions.map((cs) => cs.id),
    subAgentParents(input.sessions),
    (id) => sessionsWithRows.has(id),
  );
  const shareOf = (
    sid: string,
    p: { role: ThreadRole; turn_share: number | string | null | undefined; priced: boolean },
  ): number => {
    // v4 item 1: triage, comments, closes, views and model rows keep their verbs, never a share.
    if (!p.priced) return 0;
    const v = asShare(p.turn_share);
    if (v !== null) return v;
    return p.role === "worked_on" ? 1 / (workedOnWithoutShare.get(sid) ?? 1) : 0;
  };

  // Ref strings two kinds share (glab-style `#17` and `!17` both store `…#17`).
  const kindsByRef = new Map<string, Set<ForgeRefKind>>();
  for (const g of groups.values()) {
    const set = kindsByRef.get(g.ref) ?? new Set<ForgeRefKind>();
    set.add(g.kind);
    kindsByRef.set(g.ref, set);
  }

  const threads: Thread[] = [];
  for (const g of groups.values()) {
    const url = refToUrl(g.ref, g.kind);
    const key: ThreadKey = { ref: g.ref, kind: g.kind, url, ambiguous: (kindsByRef.get(g.ref)?.size ?? 0) > 1 };
    const memoryNames = (m: ThreadMemoryRow) => refMatches({ ref: m.ref, refKind: memoryRefKind(m.ref_kind) }, key);
    // The projects the thread's own sessions ran in: a bare `#N`/`!N` from
    // anywhere else names some other project's item.
    const threadProjects = new Set<string>();
    for (const sid of g.bySession.keys()) {
      const pid = sessions.get(sid)?.code_project_id;
      if (pid) threadProjects.add(pid);
    }
    const namesThread = (x: { session_id: string; a: ObservedAction }): boolean => {
      const a = x.a;
      const byRef = refMatches(a, key);
      const byUrl = !byRef && !!a.url && refMatches({ ref: a.url, refKind: a.refKind }, key);
      if (!byRef && !byUrl) return false;
      if (byRef && isBareRef(a.ref)) {
        const pid = sessions.get(x.session_id)?.code_project_id;
        return !!pid && threadProjects.has(pid);
      }
      return true;
    };
    const rows = [...g.bySession.values()].sort((a, b) =>
      cmpSessionStart(sessions.get(a.owner), sessions.get(b.owner)),
    );

    let reviewVerb: ReviewRung | null = null;
    let buildVerb: BuildRung | null = null;
    let triaged = false;
    const threadSessions: ThreadSession[] = [];
    let costTotal: number | null = null;
    // The (session, turn)s whose own actions name this ref.
    const actionTurns = new Set(actions.filter((x) => namesThread(x)).map((x) => `${x.session_id}\u0000${x.idx}`));
    let lastSeen: string | null = null;
    let lastSeenMs = Number.NEGATIVE_INFINITY;

    for (const row of rows) {
      const s = sessions.get(row.owner);
      if (!s) continue;
      reviewVerb = higher(REVIEW_RANK, reviewVerb, row.review_verb);
      buildVerb = higher(BUILD_RANK, buildVerb, row.build_verb);
      if (row.observed && row.role === "worked_on" && !row.review_verb && !row.build_verb) triaged = true;

      const shownPart = row.parts.get(row.owner) ?? row.parts.get(row.proof.session_id);
      const share = shownPart ? shareOf(row.parts.has(row.owner) ? row.owner : row.proof.session_id, shownPart) : 0;
      // B16: each session's own cost x its own row's share (parent and children apart).
      let costEst: number | null = null;
      const addCost = (sid: string, share: number) => {
        const cost = sessions.get(sid)?.cost_usd;
        if (cost === null || cost === undefined) return;
        costEst = round6((costEst ?? 0) + childCostOnItem(cost, share));
      };
      for (const [sid, p] of row.parts) {
        const partShare = shareOf(sid, p);
        addCost(sid, partShare);
        for (const c of childrenOf.get(sid) ?? []) addCost(c, partShare);
      }
      if (costEst !== null) costTotal = round6((costTotal ?? 0) + costEst);
      // Maintainer rule: a link lands on the turn that SHOWS the action. A parent's row can sit on
      // its sub-agent spawn turn (the child did the work); then the child's action turn is the link.
      const link = linkRow(row.proof, row.all, actionTurns);
      const at = turnTime(link.session_id, link.turn_idx) ?? s.started_at;
      threadSessions.push({
        id: s.id,
        started_at: s.started_at,
        at,
        turn_idx: link.turn_idx,
        proof_session_id: link.session_id,
        tier: row.inferredRef ? "inferred_ref" : row.observed ? "observed" : "discussed",
        role: row.role,
        review_verb: row.review_verb,
        build_verb: row.build_verb,
        share,
        cost_est: costEst,
        session_cost_usd: s.cost_usd ?? null,
        ended_at: s.ended_at ?? null,
      });
      // v4 item 5: last seen = the latest action on the ref, not the session's start.
      const atMs = timeOf(at);
      if (at && atMs !== null && atMs > lastSeenMs) {
        lastSeen = at;
        lastSeenMs = atMs;
      }
    }

    // `triaged` action naming the ref counts too (from the thread's own projects, or qualified).
    for (const x of actions) {
      if (x.a.verb === "triaged" && namesThread(x)) triaged = true;
    }

    // Build sessions: where this ref reached >= committed (children folded
    // in). Their commit/push/rewrite actions give the thread its branches and
    // newest sha per branch.
    // Keyed to the ACTING session (owner or child), never every child of the
    // owner: a sibling sub-agent's commits say nothing about this ref.
    const buildOwners = new Set(
      rows.filter((r) => rank(BUILD_RANK, r.build_verb) >= BUILD_RANK.committed).map((r) => r.owner),
    );
    const buildSessions = new Set<string>();
    for (const r of rows) {
      for (const [sid, p] of r.parts) {
        if (rank(BUILD_RANK, p.build_verb) >= BUILD_RANK.committed) buildSessions.add(sid);
      }
    }
    for (const x of actions) {
      if (x.session_id !== x.owner && buildOwners.has(x.owner) && namesThread(x)) buildSessions.add(x.session_id);
    }
    const newestSha = new Map<string, string>(); // `${project}\n${branch}` -> newest non-superseded sha
    const namedShas = new Map<string, string[]>();
    const supersededShas = new Map<string, Set<string>>();
    const branchKeys = new Set<string>();
    let lastBuild: Pos | null = null;
    let commitSubject: string | null = null;
    // UX pass 2: what the row can say about a sparse item — observed only, and
    // only commits tied to THIS item (review r2 S1), in order.
    const tiedCommits: { sha: string; subject: string | null }[] = [];
    const keyFor = (s: ThreadSessionRow, branch: string) => `${s.code_project_id ?? ""}\n${branch}`;
    for (const x of actions) {
      if (!buildSessions.has(x.session_id)) continue;
      const s = sessions.get(x.session_id);
      if (!s) continue;
      const a = x.a;
      const isIssueRef =
        a.refKind === "issue" || a.refKind === "merge_request" || (a.ref ? /[#!]\d+$/.test(a.ref) : false);
      if (isIssueRef && !refMatches(a, key)) continue;
      switch (a.verb) {
        case "committed": {
          if (!a.sha) break;
          const branch = a.branch ?? s.git_branch ?? `${DETACHED_BRANCH_PREFIX}${a.sha}`;
          const k = keyFor(s, branch);
          branchKeys.add(k);
          newestSha.set(k, a.sha);
          namedShas.set(k, [...(namedShas.get(k) ?? []), a.sha]);
          lastBuild = x.pos;
          commitSubject = observedTitle(a.subject) ?? commitSubject;
          if (
            commitTiedToItem(
              { branch: a.branch, subject: a.subject ?? "" },
              { ref: g.ref, kind: g.kind },
              x.session_id,
              tieKey,
              {
                mrBranches,
                projectOf,
              },
            )
          ) {
            tiedCommits.push({ sha: a.sha, subject: observedTitle(a.subject) });
          }
          break;
        }
        case "rewrote": {
          const branch = a.branch ?? s.git_branch;
          if (!branch) break;
          const k = keyFor(s, branch);
          branchKeys.add(k);
          const gone = supersededShas.get(k) ?? new Set<string>();
          for (const sha of namedShas.get(k) ?? []) gone.add(sha);
          supersededShas.set(k, gone);
          if (a.sha) {
            newestSha.set(k, a.sha);
            namedShas.set(k, [...(namedShas.get(k) ?? []), a.sha]);
          } else newestSha.delete(k);
          commitSubject = observedTitle(a.subject) ?? commitSubject;
          break;
        }
        case "pushed":
        case "opened_mr": {
          const branch = a.branch ?? s.git_branch;
          if (branch) branchKeys.add(keyFor(s, branch));
          lastBuild = x.pos;
          break;
        }
        default:
          break;
      }
    }
    // A build session with no observed branch still keys on its git_branch.
    for (const sid of buildSessions) {
      const s = sessions.get(sid);
      if (s?.git_branch) branchKeys.add(keyFor(s, s.git_branch));
    }

    // The latest observed reopen on the ref: closure evidence before it is void.
    let lastReopen: Pos | null = null;
    let forgeTitle: string | null = null;
    for (const x of actions) {
      if (!namesThread(x)) continue;
      if (isReopenVerb(x.a)) lastReopen = x.pos;
      forgeTitle = observedTitle(x.a.title) ?? forgeTitle;
    }
    const beforeReopen = (p: Pos) => !!lastReopen && cmpPos(p, lastReopen) < 0;
    // Closure, strongest first: an observed merged/closed on the ref itself
    // (or on one of its own branches) at or after the last build action, by
    // wall clock. An MR's merge never closes the issue it served (F7).
    const closureCtx: ClosureContext = {
      actions,
      lastBuild,
      lastReopen,
      beforeReopen,
      sessions,
      namesThread,
      buildSessions,
      branchKeys,
      keyFor,
      rows,
      branchState,
      newestSha,
      namedShas,
      supersededShas,
    };
    let closure: ThreadClosure | null = null;
    for (const d of CLOSURE_DETECTORS) {
      closure = d(closureCtx);
      if (closure) break;
    }

    // A dismissal holds until a NEW observed build action (committed or
    // higher) on this (kind, ref) lands after it, by wall clock — then the
    // thread is back (either reason). Views, comments and discussion after it
    // do not resurrect it; a dismissal with no time holds.
    const groupKey = itemReadKey(g.ref, g.kind);
    // S4: the fold (foldDiscussedKinds) may have moved a GitHub row to the
    // other kind — a dismissal recorded under either kind for that item holds.
    const ghItem = githubItemKey(g.ref);
    const found = dismissals.find(
      (d) =>
        (d.kind === g.kind && itemReadKey(d.ref, d.kind) === groupKey) ||
        (ghItem !== null && githubItemKey(d.ref) === ghItem),
    );
    const dismissedAt = timeOf(found?.created_at);
    const resurrected = !!found && dismissedAt !== null && !!lastBuild && lastBuild.t > dismissedAt;
    const dismissal = resurrected ? undefined : found;
    const discussed = !reviewVerb && !buildVerb && !triaged;
    // e2e R-8 (D-051): only a build rung — committed, pushed, opened_mr —
    // opens a thread. `merged`/`closed` are closure; a row holding one counts
    // as delivery only when a commit/push/MR on the thread was observed
    // (`lastBuild`), so closing (then reopening) an issue with no commit
    // never makes it open — a reopen only clears the closure.
    const delivering = rows.some((r) => DELIVERY_RUNGS.has(r.build_verb ?? "")) || lastBuild !== null;
    const open = delivering && !closure && !dismissal;

    const thread: Thread = {
      ref: g.ref,
      refKind: g.kind,
      url,
      ladder: { review_verb: reviewVerb, build_verb: buildVerb, triaged, discussed },
      sessions: threadSessions,
      cost_est_total: costTotal,
      estimated: true,
      last_seen_at: lastSeen,
      open,
      closure,
    };
    const family = glabFamilyOf(g.ref, glabHosts);
    if (family) thread.forge_family = family;
    thread.title = commitSubject ?? forgeTitle ?? displayRef(g.ref);
    // UX pass 2: the forge's own title (a view result tied to this ref) and the
    // first commit's subject, kept apart from `title` so the row can prefer the
    // forge's words; the count of distinct commits attributed to the item.
    if (forgeTitle) thread.forge_title = forgeTitle;
    // A sha a later rewrite (squash/rebase) replaced is no longer one of its commits.
    const replaced = new Set<string>();
    for (const set of supersededShas.values()) for (const sha of set) replaced.add(sha);
    const liveTied = tiedCommits.filter((c) => !replaced.has(c.sha));
    const firstSubject = liveTied.find((c) => c.subject)?.subject;
    if (firstSubject) thread.first_commit_subject = firstSubject;
    const tiedCount = new Set(liveTied.map((c) => c.sha)).size;
    if (tiedCount > 0) thread.commit_count = tiedCount;
    // Review S1: the thread's actions, each dated by its own turn. An action naming the ref
    // gives its rung; a ref-less commit/push/MR create in a session that built this ref gives
    // its build rung, capped at what that session's row observed.
    const rowBuildOf = new Map(rows.map((r) => [r.owner, r.build_verb] as const));
    const events: ThreadEvent[] = [];
    for (const x of actions) {
      const at = x.pos.t > 0 ? new Date(x.pos.t).toISOString() : null;
      const v = x.a.verb;
      if (namesThread(x)) {
        const review = v in REVIEW_RANK ? (v as ReviewRung) : null;
        const build = v in BUILD_RANK ? (v as BuildRung) : null;
        if (review || build) events.push({ session: x.owner, at, review_verb: review, build_verb: build });
        continue;
      }
      const refless = !x.a.ref || !/[#!]\d+$/.test(x.a.ref) || x.a.refKind === "branch" || x.a.refKind === "commit";
      if (!refless || !buildSessions.has(x.session_id)) continue;
      if (v !== "committed" && v !== "pushed" && v !== "opened_mr") continue;
      const cap = rowBuildOf.get(x.owner) ?? null;
      if (!cap || rank(BUILD_RANK, cap) < BUILD_RANK.committed) continue;
      const build = rank(BUILD_RANK, v) <= rank(BUILD_RANK, cap) ? (v as BuildRung) : cap;
      events.push({ session: x.owner, at, review_verb: null, build_verb: build });
    }
    if (events.length > 0) thread.events = events;
    const deliveringRows = rows.filter((r) => rank(BUILD_RANK, r.build_verb) >= BUILD_RANK.committed);
    if (deliveringRows.length > 0 && deliveringRows.every((r) => r.inferredRef)) thread.inferred_ref = true;
    if (reviewVerb === "reviewed" && !delivering) thread.note = "no comment seen";

    // B8: the owner's quote, latest first.
    const quotes = memories
      .filter((m) => isOwnerPriority(m) && memoryNames(m))
      .sort((a, b) => ((a.created_at ?? "") < (b.created_at ?? "") ? 1 : -1));
    if (quotes[0]?.quote) thread.priority = quotes[0].quote.trim();

    // B7: recurrence is a count.
    let recurrence = 0;
    for (const m of memories) {
      if (m.kind !== "blocker" || !memoryNames(m)) continue;
      recurrence = Math.max(recurrence, m.recurrence_count ?? 1);
    }
    if (recurrence >= 2) thread.recurrence_count = recurrence;
    if (dismissal) {
      thread.dismissed = true;
      thread.dismiss_reason = dismissal.reason;
    }

    threads.push(thread);
  }

  const seenMs = (t: Thread) => timeOf(t.last_seen_at) ?? Number.NEGATIVE_INFINITY;
  const recent = [...threads].sort(
    (a, b) => seenMs(b) - seenMs(a) || a.ref.localeCompare(b.ref) || a.refKind.localeCompare(b.refKind),
  );
  const open = threads
    .filter((t) => t.open)
    .sort((a, b) => {
      const ca = a.cost_est_total ?? -1;
      const cb = b.cost_est_total ?? -1;
      if (ca !== cb) return cb - ca;
      return seenMs(b) - seenMs(a) || a.ref.localeCompare(b.ref) || a.refKind.localeCompare(b.refKind);
    })
    .slice(0, limit);

  const createdMs = (iso: string | null | undefined) => timeOf(iso) ?? Number.NEGATIVE_INFINITY;
  // Recurrence desc, then latest first — applied before the cap.
  const recurring_blockers: RecurringBlocker[] = memories
    .filter((m) => m.kind === "blocker" && !!m.id && !!m.text)
    .map((m) => ({
      id: m.id as string,
      text: m.text as string,
      quote: m.turn_role === "user" && m.quote?.trim() ? m.quote.trim() : null,
      ref: m.ref ?? null,
      recurrence_count: Math.max(1, m.recurrence_count ?? 1),
      session_id: m.code_session_id ?? null,
      turn_idx: m.turn_idx ?? null,
      last_seen_at: m.seen_at ?? m.created_at ?? null,
    }))
    .sort((a, b) => b.recurrence_count - a.recurrence_count || createdMs(b.last_seen_at) - createdMs(a.last_seen_at))
    .slice(0, BLOCKER_LIMIT);

  return { open, recent, recurring_blockers, estimated: true };
}
