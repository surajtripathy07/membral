/**
 * W3 D5: the preamble's current-work section, "Seen in the last 7 days" —
 * built ONLY from observed forge refs (`code_session_forge_refs`, migration
 * 115), grouped by issue, each item shown with when it was last seen.
 * Design: docs/design/observed-forge-refs.md §4; D-071 for the one labelled
 * MR→issue link that comes from `session_memories`.
 *
 * Rules (§4):
 * - Groups are issues. Edges: a commit-subject row (an item row carrying a
 *   `sha`) joins its item to that commit; a commit row's `branch` and an MR
 *   row's `branch` join it to that branch, only inside one session and only
 *   for a non-default branch (`isDefaultBranch`); D-071 `ref_issue` joins an
 *   MR to its issue, labelled with its basis.
 * - A path from an issue may pass through commits, branches and MRs, never
 *   through another issue: groups never merge, and an item linked to two
 *   issues is listed under each.
 * - `prose_ref` rows never lead or group (they are dropped here).
 * - An MR/branch with no issue edge is its own group; a lone commit is not
 *   shown on its own. Same-session items with no edge get at most an
 *   `also in this session: !14` mention, never nested: only for an item not
 *   listed on any line of the section, and at most once per session (on that
 *   session's first listed lead).
 * - A branch is shown only when its name passes git's ref-name rules and is
 *   not a file the session touched (a stale checkout-of-a-path row).
 * - Recall, not state: every item renders `seen 5h ago` (its latest
 *   observation, a relative age, no timezone) and never a forge state such as
 *   "open": Membral records what sessions did and the agent checks the PR or
 *   issue live. The recorded state is still read for one thing: when the
 *   latest observation that carries a state says merged/closed, the item is
 *   dropped. That filter uses only states a session observed (the
 *   `observed_state` its own forge call returned), never a live forge read.
 * - Titles: the observed title (latest forge row with one), else the newest
 *   `session_memories.ref_title` for the same resolver key, marked
 *   `extracted title`.
 *
 * Identity is the one resolver (`itemKeyResolver`, lib/domain/ref-identity.ts)
 * re-run over the window's rows plus every project identity; the stored
 * `item_key` is never trusted alone (§3). Pure apart from `fetchCurrentWorkRows`.
 */

import { isForgeRepoIdentity } from "@/lib/attribution/grounding";
import { isDefaultBranch } from "@/lib/code-sessions/profile";
import { canonicalItemRef, HOSTLIKE, type ItemKind } from "@/lib/code-sessions/ref-canon";
import type { Db } from "@/lib/db/types";
import { ageText, DAY_MS } from "@/lib/domain/age";
import { githubItemKey, itemKeyResolver } from "@/lib/domain/ref-identity";
import { refToUrl } from "@/lib/forge/ref-url";
import { log } from "@/lib/log";
import { issueLinkPhrase, refLabel } from "./ref-label";
import { asOfDay } from "./serve-filter";

/** N of "the last N days" (W3 goal 3.6 DEFAULT). Also the blocker window (preamble.ts). */
export const CURRENT_WORK_WINDOW_DAYS = 7;
export const CURRENT_WORK_HEADING = `Seen in the last ${CURRENT_WORK_WINDOW_DAYS} days`;
/** Members listed on one group line before `+N more`. */
const MAX_MEMBERS_PER_LINE = 4;
/** The CLI hook cuts every line at 300 chars (preamble-hook.ts MAX_LINE_CHARS). */
const MAX_LINE_CHARS = 300;
/** At most this many `also in this session` mentions on one line. */
const MAX_ALSO = 2;

/** Moved to lib/domain/age.ts (#436) so blockers share it; re-exported for existing importers. */
export { ageText };

const DROP_STATES = new Set(["merged", "closed"]);

/** The columns the preamble reads from `code_session_forge_refs`. */
export const FORGE_REF_READ_COLUMNS =
  "session_id, turn_idx, action_ix, kind, target_kind, prose_ref, host, project, number, sha, branch, observed_state, title, url, observed_at";

export interface ForgeRefReadRow {
  session_id: string;
  turn_idx: number;
  action_ix?: number | null;
  kind: string;
  target_kind?: string | null;
  prose_ref: boolean;
  host: string | null;
  project: string | null;
  number: number | null;
  sha: string | null;
  branch: string | null;
  observed_state: string | null;
  title: string | null;
  url?: string | null;
  observed_at: string;
}

/** A live `session_memories` row's ref fields (D10 title fallback, D-071 link). */
export interface MemoryRefRow {
  ref: string | null;
  ref_kind: string | null;
  ref_title?: string | null;
  ref_issue?: string | null;
  ref_issue_basis?: string | null;
  created_at: string;
}

type NodeKind = "issue" | "merge_request" | "commit" | "branch";

interface Item {
  key: string;
  kind: NodeKind;
  token: string;
  title: string | null;
  titleExtracted: boolean;
  state: string | null;
  stateAt: string | null;
  lastSeen: string;
  sessions: Set<string>;
  /** Per session: when that session last observed the item. */
  sessionSeen: Map<string, string>;
  issueLink: string | null;
  /** The item's forge page from its qualified spelling (`host/owner/repo#N`); null when no host is known. */
  url: string | null;
}

export interface CurrentWorkGroup {
  lead: Item;
  members: Item[];
  /** Other groups' leads seen in a session of this lead with no edge to it; `renderCurrentWork` picks the mention. */
  also: Item[];
  latest: string;
  /** Items this group touches but never lists: other issues a path reached and stopped at. Never mentioned. */
  stops: Set<string>;
}

export interface CurrentWorkInput {
  rows: readonly ForgeRefReadRow[];
  memoryRefs?: readonly MemoryRefRow[];
  /** The preamble project's `repo_identity`: its own items render as bare `#N`. */
  projectIdentity: string;
  /** Every `repo_identity` of the user's projects (host binding, design §3). */
  projectIdentities?: readonly string[];
  /** `code_sessions.files_touched` per session: a branch named like one of them is a path, not a branch. */
  sessionFiles?: ReadonlyMap<string, readonly string[]>;
  now: number;
}

/** git check-ref-format, the parts that matter here: no space/control/~^:?*[\\, no "..", "@{", "//", no leading "-" or "/", no trailing "/", "." or ".lock", no "/." segment. */
export function isGitBranchName(name: string): boolean {
  if (!name || name === "@") return false;
  if (/[\s~^:?*[\\]/.test(name) || [...name].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f))
    return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//") || name.includes("/.")) return false;
  if (name.startsWith("-") || name.startsWith("/") || name.startsWith(".")) return false;
  if (name.endsWith("/") || name.endsWith(".") || name.endsWith(".lock")) return false;
  return true;
}

/** A name whose last segment has an extension and that names a file the session touched. */
function isTouchedFilePath(name: string, files: readonly string[] | undefined): boolean {
  if (!files?.length || !/\.[A-Za-z0-9]+$/.test(name.split("/").pop() ?? "")) return false;
  return files.some((f) => f === name || f.endsWith(`/${name}`));
}

function hostedParts(identity: string): { host: string; project: string } | null {
  const segs = identity.trim().toLowerCase().split("/").filter(Boolean);
  if (segs.length < 3 || !HOSTLIKE.test(segs[0])) return null;
  return { host: segs[0], project: segs.slice(1).join("/") };
}

/** `as of 2026-10-04 (3d ago)`: the absolute day every preamble line carries (D-074, L2), then the age. Age alone when the time does not parse. */
export function asOfAge(at: string, now: number): string {
  const day = asOfDay(at);
  return day ? `as of ${day} (${ageText(at, now)})` : ageText(at, now);
}

/** `seen 5h ago`: when a session last touched the item. No forge state is rendered (the agent checks it live). */
export function seenText(at: string, now: number): string {
  return `seen ${ageText(at, now)}`;
}

function memoryItemKind(refKind: string | null): ItemKind | null {
  if (!refKind) return null;
  const k = refKind.toLowerCase();
  if (k === "issue") return "issue";
  if (k === "pr" || k === "mr" || k === "merge_request") return "merge_request";
  return null;
}

/** A same-session retry against another repo, observed this soon after, says which repo a row meant. */
const SIBLING_WINDOW_MS = 10 * 60_000;

/** A moved row's key (`session \0 kind \0 number`) -> the repo it moved to. */
export type MovedRefs = Map<string, { project: string; host: string | null }>;

const movedKey = (session: string, kind: string | null | undefined, n: number) => `${session}\u0000${kind}\u0000${n}`;

/**
 * A forge CLI run without `-R` defaults to the cwd's repo (`glab mr view 123456` in this checkout);
 * the agent then retries against the right repo. Such a row -- filed under this repo, or with no
 * project at all -- moves to the other repo only when ALL hold:
 * - the row itself carries no evidence it is this repo's: no sha, no url, no observed state, no title
 *   (a failed view has none of these; a commit subject, a merged MR or a titled view does);
 * - the SAME session then made a direct action (no sha) on the same kind and number in exactly one
 *   other repo, observed after it and within SIBLING_WINDOW_MS.
 * A row with no project and a host that is not this repo's is dropped. Everything else stays.
 * Returns the rows and the moves (so a bare-ref memory from that session follows them). Pure.
 */
export function attributeBareRows(
  rows: readonly ForgeRefReadRow[],
  own: { host: string; project: string } | null,
): { rows: ForgeRefReadRow[]; moved: MovedRefs } {
  const kindOf = (r: ForgeRefReadRow) => (r.kind === "comment" ? r.target_kind : r.kind);
  const ownProject = own?.project ?? null;
  const isOwn = (project: string | null) => !!project && !!ownProject && project.toLowerCase() === ownProject;
  const foreign = new Map<string, ForgeRefReadRow[]>();
  for (const r of rows) {
    if (!r.project || isOwn(r.project) || r.sha || r.number === null || r.number === undefined) continue;
    const k = movedKey(r.session_id, kindOf(r), r.number);
    foreign.set(k, [...(foreign.get(k) ?? []), r]);
  }
  const moved: MovedRefs = new Map();
  const out: ForgeRefReadRow[] = [];
  for (const r of rows) {
    const candidate =
      r.number !== null &&
      r.number !== undefined &&
      (!r.project || isOwn(r.project)) &&
      !r.sha &&
      !r.url &&
      !r.observed_state &&
      !r.title;
    if (!candidate) {
      out.push(r);
      continue;
    }
    const at = Date.parse(r.observed_at);
    const after = (foreign.get(movedKey(r.session_id, kindOf(r), r.number as number)) ?? []).filter((f) => {
      const t = Date.parse(f.observed_at);
      return t > at && t - at <= SIBLING_WINDOW_MS;
    });
    const projects = new Set(after.map((f) => (f.project as string).toLowerCase()));
    if (projects.size === 1) {
      const target = { project: after[0].project as string, host: after[0].host ?? r.host };
      moved.set(movedKey(r.session_id, kindOf(r), r.number as number), target);
      out.push({ ...r, ...target });
      continue;
    }
    if (projects.size > 1) continue; // retried against several repos: whose it is cannot be told
    if (!r.project && r.host && own && r.host.toLowerCase() !== own.host) continue; // another forge's
    out.push(r);
  }
  return { rows: out, moved };
}

export type MemoryRefKeyer = (
  ref: string | null | undefined,
  refKind: string | null | undefined,
  sessionId?: string | null,
) => string | null;

interface ItemGraph {
  items: Map<string, Item>;
  edges: Map<string, Set<string>>;
  inferredEdges: Set<string>;
  /**
   * The resolver key of a memory's `ref` (null when it is not an issue/MR ref). A bare `!12` from a
   * session whose `!12` row moved to another repo (attributeBareRows) resolves to that repo too.
   */
  keyOfMemoryRef: MemoryRefKeyer;
}

/**
 * The items (issues, MRs, commits, branches) the window's rows observed, with their edges, after
 * the merged/closed drop (design §4). `windowDays` defaults to CURRENT_WORK_WINDOW_DAYS. Pure.
 */
function buildItemGraph(input: CurrentWorkInput, windowDays: number = CURRENT_WORK_WINDOW_DAYS): ItemGraph {
  const since = input.now - windowDays * DAY_MS;
  const own = hostedParts(input.projectIdentity);
  const { rows, moved } = attributeBareRows(
    input.rows.filter((r) => !r.prose_ref && Date.parse(r.observed_at) >= since),
    own,
  );
  const forgeProject = isForgeRepoIdentity(input.projectIdentity) ? input.projectIdentity : null;
  const branchOk = (r: ForgeRefReadRow): r is ForgeRefReadRow & { branch: string } =>
    !!r.branch &&
    !isDefaultBranch(r.branch) &&
    isGitBranchName(r.branch) &&
    !isTouchedFilePath(r.branch, input.sessionFiles?.get(r.session_id));

  // Item spellings (issue / MR; a comment is its target item).
  const itemKindOf = (r: ForgeRefReadRow): ItemKind | null => {
    const k = r.kind === "comment" ? r.target_kind : r.kind;
    return k === "issue" || k === "merge_request" ? k : null;
  };
  const spellingOf = (r: ForgeRefReadRow): string | null => {
    if (r.number === null || r.number === undefined) return null;
    const path = [r.host, r.project].filter(Boolean).join("/");
    return `${path}#${r.number}`;
  };
  const memRefs = (input.memoryRefs ?? [])
    .map((m) => {
      const kind = memoryItemKind(m.ref_kind);
      const c = m.ref && kind ? canonicalItemRef(m.ref, forgeProject, kind) : null;
      return c && kind ? { m, kind: c.kind, spelling: c.ref } : null;
    })
    .filter((x): x is { m: MemoryRefRow; kind: ItemKind; spelling: string } => x !== null);
  const scope: { ref: string; kind: string }[] = [];
  for (const r of rows) {
    const k = itemKindOf(r);
    const s = spellingOf(r);
    if (k && s) scope.push({ ref: s, kind: k });
  }
  for (const x of memRefs) scope.push({ ref: x.spelling, kind: x.kind });
  const keyOf = itemKeyResolver(scope, { projectIdentities: input.projectIdentities ?? [input.projectIdentity] });

  // §2 GitHub kind fold, re-applied on read: a subject row takes the one kind another row observed.
  const ghKinds = new Map<string, Set<string>>();
  for (const r of rows) {
    const k = itemKindOf(r);
    const s = spellingOf(r);
    if (!k || !s || (r.kind === "issue" && r.sha)) continue;
    const gh = githubItemKey(s);
    if (gh) ghKinds.set(gh, new Set([...(ghKinds.get(gh) ?? []), k]));
  }

  // Short shas bind to the one longer in-window sha they prefix.
  const fullShas = [...new Set(rows.map((r) => r.sha).filter((s): s is string => !!s))];
  const shaKey = (sha: string): string => {
    const longer = fullShas.filter((s) => s.length > sha.length && s.startsWith(sha));
    return `commit\u0000${longer.length === 1 ? longer[0] : sha}`;
  };

  const items = new Map<string, Item>();
  const edges = new Map<string, Set<string>>();
  /** D-071 inferred MR→issue edges (`a\0b`, both directions): a walk lists the MR but never passes it. */
  const inferredEdges = new Set<string>();
  const link = (a: string, b: string) => {
    if (a === b) return;
    edges.set(a, new Set([...(edges.get(a) ?? []), b]));
    edges.set(b, new Set([...(edges.get(b) ?? []), a]));
  };
  const touch = (key: string, kind: NodeKind, token: string, r: ForgeRefReadRow, observation = true): Item => {
    let it = items.get(key);
    if (!it) {
      it = {
        key,
        kind,
        token,
        title: null,
        titleExtracted: false,
        state: null,
        stateAt: null,
        lastSeen: r.observed_at,
        sessions: new Set(),
        sessionSeen: new Map(),
        issueLink: null,
        url: null,
      };
      items.set(key, it);
    }
    if (observation) {
      it.sessions.add(r.session_id);
      if (r.observed_at > it.lastSeen) it.lastSeen = r.observed_at;
      const prev = it.sessionSeen.get(r.session_id);
      if (!prev || r.observed_at > prev) it.sessionSeen.set(r.session_id, r.observed_at);
    }
    return it;
  };
  const tokenOf = (r: ForgeRefReadRow, kind: ItemKind): string => {
    const github = !!r.host && /(^|\.)github\.[a-z]+$/i.test(r.host);
    const mark = kind === "merge_request" && !github ? "!" : "#";
    const sameRepo = !r.project || (own && own.project === r.project.toLowerCase());
    return `${sameRepo ? "" : r.project}${mark}${r.number}`;
  };

  // Sorted oldest first so "latest observation with a state" is the last write.
  const ordered = [...rows].sort(
    (a, b) =>
      a.observed_at.localeCompare(b.observed_at) || a.turn_idx - b.turn_idx || (a.action_ix ?? 0) - (b.action_ix ?? 0),
  );
  for (const r of ordered) {
    let kind = itemKindOf(r);
    const spelling = spellingOf(r);
    if (kind && spelling) {
      if (r.kind === "issue" && r.sha) {
        const gh = githubItemKey(spelling);
        const seen = gh ? ghKinds.get(gh) : undefined;
        if (seen && seen.size === 1) kind = [...seen][0] as ItemKind;
      }
      const it = touch(keyOf(spelling, kind), kind, tokenOf(r, kind), r);
      // A link for opening the item, never its state; a spelling with no host gives none.
      if (!it.url) it.url = refToUrl(spelling, kind);
      if (r.kind !== "comment") {
        if (r.observed_state) {
          it.state = r.observed_state;
          it.stateAt = r.observed_at;
        }
        if (r.title?.trim()) it.title = r.title.trim();
      }
      if (r.sha) {
        const c = touch(shaKey(r.sha), "commit", r.sha.slice(0, 7), r);
        link(it.key, c.key);
      }
      if (kind === "merge_request" && r.kind === "merge_request" && branchOk(r)) {
        const b = touch(`branch\u0000${r.session_id}\u0000${r.branch}`, "branch", r.branch, r);
        link(it.key, b.key);
      }
      continue;
    }
    if (r.kind === "commit" && r.sha) {
      const c = touch(shaKey(r.sha), "commit", r.sha.slice(0, 7), r);
      if (branchOk(r)) {
        const b = touch(`branch\u0000${r.session_id}\u0000${r.branch}`, "branch", r.branch, r);
        link(c.key, b.key);
      }
      continue;
    }
    if (r.kind === "branch" && branchOk(r)) {
      touch(`branch\u0000${r.session_id}\u0000${r.branch}`, "branch", r.branch, r);
    }
  }

  // D10 title fallback (newest extracted title per key) and D-071 MR→issue links (labelled).
  const byNewest = [...memRefs].sort((a, b) => b.m.created_at.localeCompare(a.m.created_at));
  const titled = new Set<string>();
  const linked = new Set<string>();
  for (const { m, kind, spelling } of byNewest) {
    const it = items.get(keyOf(spelling, kind));
    if (!it) continue;
    if (!it.title && !titled.has(it.key) && m.ref_title?.trim()) {
      it.title = m.ref_title.trim();
      it.titleExtracted = true;
      titled.add(it.key);
    }
    if (kind === "merge_request" && !linked.has(it.key)) {
      const phrase = issueLinkPhrase(m.ref_issue, m.ref_issue_basis, input.projectIdentity);
      if (!phrase || !m.ref_issue) continue;
      linked.add(it.key);
      it.issueLink = phrase;
      const c = canonicalItemRef(m.ref_issue, forgeProject, "issue");
      const issue = c ? items.get(keyOf(c.ref, "issue")) : undefined;
      if (issue && issue.kind === "issue") {
        link(it.key, issue.key);
        if (m.ref_issue_basis === "inferred") {
          inferredEdges.add(`${it.key}\u0000${issue.key}`);
          inferredEdges.add(`${issue.key}\u0000${it.key}`);
        }
      }
    }
  }

  // A latest state of merged/closed drops the item (and its edges).
  const dropped = new Set<string>();
  for (const it of [...items.values()]) {
    if (it.state && DROP_STATES.has(it.state.toLowerCase())) {
      items.delete(it.key);
      dropped.add(it.key);
    }
  }
  // ...and the branches/commits that hung only off a finished item: a component of branch/commit
  // nodes that touched a dropped item and touches no live issue or MR goes with it.
  const isPoint = (k: string) => {
    const kind = items.get(k)?.kind;
    return kind === "branch" || kind === "commit";
  };
  const pointSeen = new Set<string>();
  for (const start of [...items.keys()]) {
    if (!isPoint(start) || pointSeen.has(start)) continue;
    const comp = new Set([start]);
    const queue = [start];
    let touchedDropped = false;
    let touchesLive = false;
    while (queue.length) {
      const cur = queue.shift() as string;
      for (const n of edges.get(cur) ?? []) {
        if (dropped.has(n)) touchedDropped = true;
        else if (isPoint(n)) {
          if (!comp.has(n)) {
            comp.add(n);
            queue.push(n);
          }
        } else if (items.has(n)) touchesLive = true;
      }
    }
    for (const k of comp) pointSeen.add(k);
    if (touchedDropped && !touchesLive) for (const k of comp) items.delete(k);
  }

  const keyOfMemoryRef: MemoryRefKeyer = (ref, refKind, sessionId) => {
    const kind = memoryItemKind(refKind ?? null);
    const bare = ref ? /^[#!](\d+)$/.exec(ref.trim()) : null;
    const to = bare && kind && sessionId ? moved.get(movedKey(sessionId, kind, Number(bare[1]))) : undefined;
    if (to && kind) return keyOf(`${[to.host, to.project].filter(Boolean).join("/")}#${bare?.[1]}`, kind);
    const c = ref && kind ? canonicalItemRef(ref, forgeProject, kind) : null;
    return c ? keyOf(c.ref, c.kind) : null;
  };
  return { items, edges, inferredEdges, keyOfMemoryRef };
}

/** An issue or MR the window's rows observed (preamble redesign: one line per item). */
export interface WorkItem {
  key: string;
  kind: "issue" | "merge_request";
  /** `#4`, `!12`, `other/repo#3`. */
  token: string;
  title: string | null;
  lastSeen: string;
  /** Per session: when that session last observed the item. */
  sessionSeen: ReadonlyMap<string, string>;
  /** The item's forge page when its host is known (`refToUrl`); null otherwise. */
  url: string | null;
}

/**
 * The issues and MRs observed in the last `windowDays` (merged/closed ones dropped, design §4),
 * newest first, plus the resolver for a memory's `ref` so a memory can be matched to its item.
 * Commits and branches are not items here: they never lead a line. Pure.
 */
export function currentWorkItems(
  input: CurrentWorkInput,
  windowDays: number = CURRENT_WORK_WINDOW_DAYS,
): { items: WorkItem[]; keyOfMemoryRef: ItemGraph["keyOfMemoryRef"] } {
  const { items, keyOfMemoryRef } = buildItemGraph(input, windowDays);
  const out: WorkItem[] = [];
  for (const it of items.values()) {
    if (it.kind !== "issue" && it.kind !== "merge_request") continue;
    out.push({
      key: it.key,
      kind: it.kind,
      token: it.token,
      title: it.title,
      lastSeen: it.lastSeen,
      sessionSeen: it.sessionSeen,
      url: it.url,
    });
  }
  out.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || a.token.localeCompare(b.token));
  return { items: out, keyOfMemoryRef };
}

/** Groups per design §4, newest first. Pure. */
export function currentWorkGroups(input: CurrentWorkInput): CurrentWorkGroup[] {
  const { items, edges, inferredEdges } = buildItemGraph(input);
  if (items.size === 0) return [];
  const neighbours = (key: string) => [...(edges.get(key) ?? [])].filter((k) => items.has(k));
  const groups: CurrentWorkGroup[] = [];
  const covered = new Set<string>();
  const listed = (reached: Set<string>, lead: string) =>
    [...reached]
      .filter((k) => k !== lead)
      .map((k) => items.get(k) as Item)
      .filter((i) => i.kind === "merge_request" || i.kind === "commit")
      .sort((a, b) =>
        a.kind !== b.kind ? (a.kind === "merge_request" ? -1 : 1) : b.lastSeen.localeCompare(a.lastSeen),
      );

  // Issue groups: walk from each issue, never through another issue.
  for (const lead of items.values()) {
    if (lead.kind !== "issue") continue;
    const reached = new Set([lead.key]);
    const queue = [lead.key];
    while (queue.length) {
      const cur = queue.shift() as string;
      for (const n of neighbours(cur)) {
        if (reached.has(n)) continue;
        reached.add(n);
        // Never through another issue; never past an MR joined only by an inferred link (D-071).
        if ((items.get(n) as Item).kind !== "issue" && !inferredEdges.has(`${cur}\u0000${n}`)) queue.push(n);
      }
    }
    const stops = new Set<string>();
    for (const k of reached) {
      if ((items.get(k) as Item).kind !== "issue" || k === lead.key) covered.add(k);
      else stops.add(k);
    }
    const members = listed(reached, lead.key);
    groups.push({ lead, members, also: [], latest: maxSeen([lead, ...members]), stops });
  }

  // Items with no issue edge: one group per connected component, led by its newest MR, else its branch.
  const seenComp = new Set<string>();
  for (const start of items.values()) {
    if (covered.has(start.key) || seenComp.has(start.key) || start.kind === "issue") continue;
    const comp = new Set([start.key]);
    const queue = [start.key];
    while (queue.length) {
      const cur = queue.shift() as string;
      for (const n of neighbours(cur)) {
        if (comp.has(n) || covered.has(n) || (items.get(n) as Item).kind === "issue") continue;
        comp.add(n);
        queue.push(n);
      }
    }
    for (const k of comp) seenComp.add(k);
    const compItems = [...comp].map((k) => items.get(k) as Item);
    const newest = (kind: NodeKind) =>
      compItems.filter((i) => i.kind === kind).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen))[0];
    const lead = newest("merge_request") ?? newest("branch");
    if (!lead) continue; // a lone commit is not a group
    const members = listed(comp, lead.key);
    groups.push({ lead, members, also: [], latest: maxSeen([lead, ...members, ...compItems]), stops: new Set() });
  }

  // `also in this session` candidates: other leads seen in a session of this lead, with no edge to
  // this group (an issue a path stopped at is linked, not unlinked, and is never mentioned: no chaining).
  for (const g of groups) {
    const inGroup = new Set([g.lead.key, ...g.members.map((m) => m.key), ...g.stops]);
    g.also = groups
      .map((o) => o.lead)
      .filter((o) => !inGroup.has(o.key) && [...o.sessions].some((s) => g.lead.sessions.has(s)))
      .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
  }

  return groups.sort((a, b) => b.latest.localeCompare(a.latest) || a.lead.token.localeCompare(b.lead.token));
}

function maxSeen(list: readonly Item[]): string {
  return list.reduce((m, i) => (i.lastSeen > m ? i.lastSeen : m), "");
}

/** One item: `!9 Fix ledger (probably for #4) — seen 2d ago`; a commit `a1b2c3d — seen 5h ago`. */
export function renderItem(it: Item, now: number): string {
  const label =
    it.kind === "branch" ? `branch ${it.token}` : it.kind === "commit" ? it.token : refLabel(it.token, it.title);
  const notes = [it.titleExtracted ? "extracted title" : null, it.issueLink].filter(Boolean);
  const note = notes.length ? ` (${notes.join("; ")})` : "";
  const when = seenText(it.lastSeen, now);
  return `${label}${note} — ${when}`;
}

/** One group line, kept under the hook's per-line cut by dropping trailing members into `+N more`. `also` defaults to none. */
export function renderGroupLine(g: CurrentWorkGroup, now: number, alsoItems: readonly Item[] = []): string {
  const also = alsoItems.length
    ? `; also in this session: ${alsoItems.map((a) => (a.kind === "branch" ? `branch ${a.token}` : a.token)).join(", ")}`
    : "";
  const head = `- ${renderItem(g.lead, now)}`;
  let shown = Math.min(g.members.length, MAX_MEMBERS_PER_LINE);
  for (;;) {
    const parts = g.members.slice(0, shown).map((m) => renderItem(m, now));
    const extra = g.members.length - shown;
    const tail = `${parts.length ? `: ${parts.join(" · ")}` : ""}${extra > 0 ? ` · +${extra} more` : ""}`;
    const line = `${head}${tail}${also}`;
    if (line.length <= MAX_LINE_CHARS || shown === 0) return line;
    shown--;
  }
}

/**
 * The section's lines, at most `maxLines` (heading included): the heading,
 * one line per group, and `…N more` when groups were cut. Empty when there
 * are no groups (no empty heading).
 */
export function renderCurrentWork(groups: readonly CurrentWorkGroup[], maxLines: number, now: number): string[] {
  if (groups.length === 0 || maxLines < 2) return [];
  const fits = groups.length + 1 <= maxLines;
  const shown = fits ? groups.length : Math.max(1, maxLines - 2);
  const visible = groups.slice(0, shown);
  // An item listed on any line is never mentioned in `also`; each session's mention goes on its first listed lead only.
  const listed = new Set(visible.flatMap((g) => [g.lead.key, ...g.members.map((m) => m.key)]));
  const mentionedSessions = new Set<string>();
  const lines = [CURRENT_WORK_HEADING];
  for (const g of visible) {
    const open = [...g.lead.sessions].filter((sid) => !mentionedSessions.has(sid));
    for (const sid of g.lead.sessions) mentionedSessions.add(sid);
    const also = g.also
      .filter((a) => !listed.has(a.key) && [...a.sessions].some((sid) => open.includes(sid)))
      .slice(0, MAX_ALSO);
    lines.push(renderGroupLine(g, now, also));
  }
  if (shown < groups.length) lines.push(`…${groups.length - shown} more`);
  return lines;
}

/** The newest live memory refs read for titles and MR→issue links. */
const MEMORY_REF_ROW_LIMIT = 500;

/** Session ids per `.in()` request (keeps the PostgREST URL short). */
const SESSION_ID_CHUNK = 100;

/** A project session as the preamble reads it (sub-agent runs flagged, `parent_source_session_id` set). */
export interface ProjectSessionRow {
  id: string;
  source_session_id: string | null;
  parent_source_session_id: string | null;
  git_branch: string | null;
  short_title: string | null;
  started_at: string | null;
  ended_at: string | null;
  files_touched: string[];
}

/** When the session was last active: `ended_at`, else `started_at` (a still-open session). */
export function sessionActivity(s: Pick<ProjectSessionRow, "started_at" | "ended_at">): string {
  return s.ended_at ?? s.started_at ?? "";
}

/** Read caps: top-level sessions and sub-agent runs in the window (bounds the forge-row read too). */
const MAX_TOP_SESSIONS = 500;
const MAX_SUBAGENT_SESSIONS = 1500;

/**
 * The project's sessions active inside the window (ended or started since `sinceIso`, or still
 * open: `ended_at` null), newest first. Top-level sessions carry their branch, short title and
 * `files_touched`; sub-agent runs (`parent_source_session_id` set) are read with ids and times only
 * -- the issues and MRs a sub-agent touched are its parent session's work, shown under the parent.
 * Two parallel reads, each capped. Explicit `user_id` filter (service role). The window test is also
 * applied here, so a backend that ignores `.or()` still gets the same set.
 */
export async function fetchProjectSessions(
  supabase: Db,
  userId: string,
  projectId: string,
  sinceIso: string,
): Promise<ProjectSessionRow[]> {
  const window = `ended_at.gte.${sinceIso},started_at.gte.${sinceIso},ended_at.is.null`;
  const [top, sub] = await Promise.all([
    supabase
      .from("code_sessions")
      .select(
        "id, source_session_id, parent_source_session_id, git_branch, short_title, started_at, ended_at, files_touched",
      )
      .eq("user_id", userId)
      .eq("code_project_id", projectId)
      .is("parent_source_session_id", null)
      .or(window)
      // Latest activity first, open sessions on top: a long-running or resumed session is never the first cut.
      .order("ended_at", { ascending: false, nullsFirst: true })
      .order("started_at", { ascending: false })
      .limit(MAX_TOP_SESSIONS),
    supabase
      .from("code_sessions")
      .select("id, source_session_id, parent_source_session_id, started_at, ended_at")
      .eq("user_id", userId)
      .eq("code_project_id", projectId)
      .not("parent_source_session_id", "is", null)
      .or(window)
      // Latest activity first, open sessions on top: a long-running or resumed session is never the first cut.
      .order("ended_at", { ascending: false, nullsFirst: true })
      .order("started_at", { ascending: false })
      .limit(MAX_SUBAGENT_SESSIONS),
  ]);
  const error = top.error ?? sub.error;
  if (error) throw new Error(`current work: window sessions read failed: ${error.message}`);
  const since = Date.parse(sinceIso);
  const inWindow = (iso: string | null | undefined) => !!iso && Date.parse(iso) >= since;
  type Read = Partial<ProjectSessionRow> & { id: string };
  return (
    [...((top.data ?? []) as Read[]), ...((sub.data ?? []) as Read[])]
      // A session still open (no `ended_at`) counts whenever it started.
      .filter((r) => !r.ended_at || inWindow(r.ended_at) || inWindow(r.started_at))
      .map((r) => ({
        id: r.id,
        source_session_id: r.source_session_id ?? null,
        parent_source_session_id: r.parent_source_session_id ?? null,
        git_branch: r.git_branch ?? null,
        short_title: r.short_title ?? null,
        started_at: r.started_at ?? null,
        ended_at: r.ended_at ?? null,
        files_touched: r.files_touched ?? [],
      }))
  );
}

/**
 * The non-prose forge rows of `sessionIds` observed since `sinceIso`, newest
 * first. Explicit `user_id` filter; the session list is chunked.
 */
export async function fetchCurrentWorkRows(
  supabase: Db,
  userId: string,
  sessionIds: readonly string[],
  sinceIso: string,
): Promise<ForgeRefReadRow[]> {
  const ids = [...new Set(sessionIds)];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += SESSION_ID_CHUNK) chunks.push(ids.slice(i, i + SESSION_ID_CHUNK));
  const pages = await Promise.all(
    chunks.map(async (chunk) => {
      const { data, error } = await supabase
        .from("code_session_forge_refs")
        .select(FORGE_REF_READ_COLUMNS)
        .eq("user_id", userId)
        .in("session_id", chunk)
        .gte("observed_at", sinceIso)
        .eq("prose_ref", false)
        .order("observed_at", { ascending: false })
        .limit(1000);
      if (error) throw new Error(`current work: forge refs read failed: ${error.message}`);
      return (data ?? []) as unknown as ForgeRefReadRow[];
    }),
  );
  return pages.flat();
}

/**
 * The project's live memory refs with their D10 fields (migration 117:
 * `ref_title`, `ref_issue`, `ref_issue_basis`) — a read of its own, so a
 * database without 117 loses only the titles and links, never the preamble.
 * Newest MEMORY_REF_ROW_LIMIT rows; a row another live row supersedes is left
 * out (as `excludeSuperseded` does for the main rows, preamble.ts).
 * Explicit `user_id` filter. Any error gives `[]` (logged).
 */
export async function fetchMemoryRefRows(supabase: Db, userId: string, projectId: string): Promise<MemoryRefRow[]> {
  try {
    const [refs, sup] = await Promise.all([
      supabase
        .from("session_memories")
        .select("id, ref, ref_kind, ref_title, ref_issue, ref_issue_basis, created_at")
        .eq("user_id", userId)
        .eq("code_project_id", projectId)
        .is("retired_at", null)
        .not("ref", "is", null)
        .order("created_at", { ascending: false })
        .limit(MEMORY_REF_ROW_LIMIT),
      supabase
        .from("session_memories")
        .select("supersedes")
        .eq("user_id", userId)
        .eq("code_project_id", projectId)
        .is("retired_at", null)
        .not("supersedes", "is", null),
    ]);
    const error = refs.error ?? sup.error;
    if (error) {
      log.warn("current work: memory ref fields unavailable, serving without titles/links", { error: error.message });
      return [];
    }
    const superseded = new Set(((sup.data ?? []) as Array<{ supersedes: string | null }>).map((r) => r.supersedes));
    return ((refs.data ?? []) as unknown as Array<MemoryRefRow & { id: string }>).filter((r) => !superseded.has(r.id));
  } catch (err) {
    log.warn("current work: memory ref read threw, serving without titles/links", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ---------------------------------------------------------------------------
// Preamble redesign. Every work line carries an MR or issue ref: one line per
// item (issues and MRs ranked together by recency), saying what was done -- the
// newest live decision or outcome memory whose own `ref` resolves to that item,
// else such a learning, else the touching session's short title when that
// session touched no other item; otherwise the line is bare. A memory is never
// attached by session alone (one session that touched four PRs would deal its
// decisions out to the wrong ones), and a decision with no ref is never shown.
// Under an item on this branch, up to two blockers whose ref resolves to it.
// Then, if lines remain, "Gotchas:" -- the repo's newest learnings, the only
// lines with no ref. Ages, full session ids (code_sessions.id, what get_code_session
// opens) and forge URLs only; no forge state words (D-074): the agent checks state live.
// ---------------------------------------------------------------------------

/** A live, non-superseded `session_memories` row as the work sections read it. */
export interface WorkMemory {
  id: string;
  code_session_id: string | null;
  kind: string;
  text: string;
  ref: string | null;
  ref_kind: string | null;
  branch: string | null;
  created_at: string;
  /** When the work happened (the source session's time); a backfill makes created_at the extraction time. Optional: falls back to created_at. */
  happened_at?: string;
}

export const ON_BRANCH_HEADING = "On this branch:";
export const ELSEWHERE_HEADING = `Elsewhere in this repo, last ${CURRENT_WORK_WINDOW_DAYS} days:`;
/** On a trunk branch there is no "On this branch": one section of the repo's recent work. */
export const RECENT_WORK_HEADING = `Recent work in this repo, last ${CURRENT_WORK_WINDOW_DAYS} days:`;
export const GOTCHAS_HEADING = "Gotchas:";
/** How far back "On this branch" looks (the extraction recency window). Elsewhere is CURRENT_WORK_WINDOW_DAYS. */
export const BRANCH_WINDOW_DAYS = 30;
/** The parallel-session line looks back this far. */
export const PARALLEL_SESSION_HOURS = 12;
/** The "what was done" text is cut to this many chars (word boundary, `…`). */
export const WHAT_WAS_DONE_MAX_CHARS = 120;
/** An item line (ref, title, age, session, what was done) is cut to this many chars, so the push stays short. */
export const ITEM_LINE_MAX_CHARS = 140;
/** Blocker and gotcha lines are cut to this many chars. */
export const SHORT_TEXT_MAX_CHARS = 100;
const MAX_BLOCKER_LINES = 2;
/** The parallel-session line's branch name is cut to this many chars. */
const PARALLEL_BRANCH_MAX_CHARS = 60;
const MAX_GOTCHAS = 2;

const DONE_KINDS = new Set(["decision", "outcome"]);
const TRUNK_BRANCHES = new Set(["main", "master", "trunk", "develop", "HEAD"]);

/** A trunk branch (or a detached HEAD): its sessions are the whole repo's, so there is no "On this branch". */
export function isTrunkBranch(branch: string | null | undefined, defaultBranch?: string | null): boolean {
  const b = branch?.trim();
  return !b || TRUNK_BRANCHES.has(b) || (!!defaultBranch && b === defaultBranch);
}

/** `text` cut to `max` chars on a word boundary, marked `…`. */
export function clipText(text: string, max: number = WHAT_WAS_DONE_MAX_CHARS): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** `prefix: text`, cut on a word boundary so the line stays within `max` (default MAX_LINE_CHARS); `prefix` alone with no text. */
export function fitLine(prefix: string, text: string | null | undefined, max: number = MAX_LINE_CHARS): string {
  const head = prefix.length > max ? `${prefix.slice(0, max - 1)}…` : prefix;
  const body = (text ?? "").replace(/\s+/g, " ").trim();
  if (!body) return head;
  const full = `${head}: ${body}`;
  if (full.length <= max) return full;
  const room = max - head.length - 3; // ": " + "…"
  if (room < 8) return head;
  const cut = body.slice(0, room);
  const space = cut.lastIndexOf(" ");
  return `${head}: ${(space > room / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "")}…`;
}

/** Near-identical texts share this key (lower-cased words, punctuation dropped, first 12 words). */
function dedupeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 12)
    .join(" ");
}

export interface WorkSectionsInput {
  items: readonly WorkItem[];
  keyOfMemoryRef: MemoryRefKeyer;
  /** Live decisions, outcomes, learnings and blockers, session ids already mapped to the top-level session. */
  memories: readonly WorkMemory[];
  /** The project's sessions in the branch window, never the requesting session (sub-agent runs flagged). */
  sessions: readonly ProjectSessionRow[];
  branch: string | null;
  /** Body lines available (headings and the parallel-session line included). */
  maxLines: number;
  now: number;
}

/** One item line and the blocker lines that hang under it. */
interface ItemBlock {
  lines: string[];
  memoryIds: string[];
}

/**
 * The body of the redesigned preamble. Off trunk: `On this branch:` (items touched by sessions on
 * the request's branch) and `Elsewhere in this repo, last 7 days:` (the repo's other items). On a
 * trunk branch: one `Recent work in this repo, last 7 days:` section. Then `Gotchas:` when lines
 * remain, and one parallel-session line. Empty sections are omitted. Returns the lines and the
 * memory ids rendered into them. Pure.
 */
export function renderWorkSections(input: WorkSectionsInput): { lines: string[]; memoryIds: string[] } {
  const { now } = input;
  const sessionById = new Map(input.sessions.map((s) => [s.id, s]));
  const trunk = isTrunkBranch(input.branch);
  const branch = trunk ? null : (input.branch?.trim() as string);
  const onBranchSessions = new Set(
    branch ? input.sessions.filter((s) => s.git_branch === branch).map((s) => s.id) : [],
  );
  const since7 = now - CURRENT_WORK_WINDOW_DAYS * DAY_MS;

  // Memories from known (non-requesting) sessions, newest first, with their item key.
  const mems = input.memories
    .filter((m) => m.code_session_id && sessionById.has(m.code_session_id) && m.text?.trim())
    .map((m) => ({ m, key: input.keyOfMemoryRef(m.ref, m.ref_kind, m.code_session_id) }))
    .sort((a, b) => b.m.created_at.localeCompare(a.m.created_at));
  const used = new Set<string>();

  const newestSession = (it: WorkItem): string | null => {
    let best: string | null = null;
    let at = "";
    for (const [sid, seen] of it.sessionSeen)
      if (seen > at) {
        best = sid;
        at = seen;
      }
    return best;
  };
  // Only a memory whose own ref resolves to the item is attached to it.
  const pick = (it: WorkItem, kinds: (k: string) => boolean) =>
    mems.find((x) => !used.has(x.m.id) && kinds(x.m.kind) && x.key === it.key)?.m ?? null;
  const itemsPerSession = new Map<string, number>();
  for (const it of input.items)
    for (const sid of it.sessionSeen.keys()) itemsPerSession.set(sid, (itemsPerSession.get(sid) ?? 0) + 1);

  let blockersLeft = MAX_BLOCKER_LINES;
  const itemBlock = (it: WorkItem, withBlockers: boolean): ItemBlock => {
    const mem = pick(it, (k) => DONE_KINDS.has(k)) ?? pick(it, (k) => k === "learning");
    if (mem) used.add(mem.id);
    const sid = mem?.code_session_id ?? newestSession(it);
    const session = sid ? sessionById.get(sid) : undefined;
    // The observed title is already on the label; a session's own title only when it touched this item alone.
    const soleItem = !!sid && itemsPerSession.get(sid) === 1;
    const raw = mem ? mem.text : soleItem ? (session?.short_title ?? null) : null;
    // The full code_sessions.id: get_code_session opens it (a short or harness id would not).
    const label = sid ?? "";
    const prefix = `- ${refLabel(it.token, it.title)} — ${asOfAge(it.lastSeen, now)}${sid ? `, session ${label}` : ""}`;
    // The text keeps the room it had beside the old 9-char `5c61aaaa…` label; the full id rides on top.
    const line = fitLine(prefix, raw ? clipText(raw) : null, ITEM_LINE_MAX_CHARS + Math.max(0, label.length - 9));
    // The URL only whole: a cut URL could name another item, so one that does not fit the CLI cut is dropped.
    const urlTail = it.url ? ` → ${it.url}` : "";
    const block: ItemBlock = {
      lines: [urlTail && line.length + urlTail.length <= MAX_LINE_CHARS ? `${line}${urlTail}` : line],
      memoryIds: mem ? [mem.id] : [],
    };
    if (withBlockers)
      for (const x of mems) {
        if (blockersLeft <= 0) break;
        if (used.has(x.m.id) || x.m.kind !== "blocker" || x.key !== it.key) continue;
        used.add(x.m.id);
        blockersLeft--;
        block.lines.push(
          `- hit ${asOfAge(x.m.happened_at ?? x.m.created_at, now)}: ${clipText(x.m.text, SHORT_TEXT_MAX_CHARS)}`,
        );
        block.memoryIds.push(x.m.id);
      }
    return block;
  };

  const onBranch = (it: WorkItem) => [...it.sessionSeen.keys()].some((sid) => onBranchSessions.has(sid));
  const recent = (it: WorkItem) => Date.parse(it.lastSeen) >= since7;
  const ob: ItemBlock[] = [];
  const el: ItemBlock[] = [];
  if (branch) {
    for (const it of input.items) if (onBranch(it)) ob.push(itemBlock(it, true));
    for (const it of input.items) if (!onBranch(it) && recent(it)) el.push(itemBlock(it, false));
  } else for (const it of input.items) if (recent(it)) el.push(itemBlock(it, false));

  // The most recent other top-level session in the last 12h (the requester is never in `sessions`).
  const parallelSince = now - PARALLEL_SESSION_HOURS * 3_600_000;
  const parallel = input.sessions
    .filter((s) => {
      const at = Date.parse(sessionActivity(s));
      return !s.parent_source_session_id && Number.isFinite(at) && at >= parallelSince;
    })
    .sort((a, b) => sessionActivity(b).localeCompare(sessionActivity(a)))[0];
  const parallelLine = parallel
    ? `Another session ran here ${ageText(sessionActivity(parallel), now)}${
        parallel.git_branch && parallel.git_branch !== "HEAD"
          ? parallel.git_branch === branch
            ? " on this branch"
            : ` on branch ${clipText(parallel.git_branch, PARALLEL_BRANCH_MAX_CHARS)}`
          : ""
      } (session ${parallel.id}).`
    : null;

  // Items first: each section keeps whole blocks (an item with its blockers) within its share; a
  // heading is only spent on a section that shows at least one block.
  const avail = input.maxLines - (parallelLine ? 1 : 0);
  const room = avail - (ob.length ? 1 : 0) - (el.length ? 1 : 0);
  const size = (bs: ItemBlock[]) => bs.reduce((n, b) => n + b.lines.length, 0);
  const take = (bs: ItemBlock[], cap: number): ItemBlock[] => {
    const out: ItemBlock[] = [];
    let n = 0;
    for (const b of bs) {
      if (n + b.lines.length > cap) break;
      out.push(b);
      n += b.lines.length;
    }
    return out;
  };
  const obShown = take(ob, Math.max(0, Math.max(room - size(el), Math.ceil(room / 2))));
  const elShown = take(el, Math.max(0, avail - (obShown.length ? 1 + size(obShown) : 0) - (el.length ? 1 : 0)));
  const lines: string[] = [];
  if (obShown.length) lines.push(ON_BRANCH_HEADING, ...obShown.flatMap((b) => b.lines));
  if (elShown.length) lines.push(branch ? ELSEWHERE_HEADING : RECENT_WORK_HEADING, ...elShown.flatMap((b) => b.lines));
  const memoryIds = [...obShown, ...elShown].flatMap((b) => b.memoryIds);

  // Gotchas: the repo's newest learnings (no ref needed), near-duplicates dropped, only in lines left over.
  const gotchaRoom = Math.min(MAX_GOTCHAS, avail - lines.length - 1);
  if (gotchaRoom > 0) {
    const seen = new Set<string>();
    const gotchas: { id: string; line: string }[] = [];
    for (const x of mems) {
      if (gotchas.length >= gotchaRoom) break;
      if (used.has(x.m.id) || x.m.kind !== "learning" || Date.parse(x.m.created_at) < since7) continue;
      const key = dedupeKey(x.m.text);
      if (seen.has(key)) continue;
      seen.add(key);
      gotchas.push({ id: x.m.id, line: `- ${clipText(x.m.text, SHORT_TEXT_MAX_CHARS)}` });
    }
    if (gotchas.length) {
      lines.push(GOTCHAS_HEADING, ...gotchas.map((g) => g.line));
      memoryIds.push(...gotchas.map((g) => g.id));
    }
  }
  if (parallelLine && input.maxLines > 0) lines.push(parallelLine);
  return { lines: lines.slice(0, Math.max(0, input.maxLines)), memoryIds };
}
