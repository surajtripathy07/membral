// GET /api/memory/preamble (docs/design/memory-v1.md §4): the SessionStart
// push -- and the shared record-line rendering `relevance.ts`'s first-
// `UserPromptSubmit` call reuses (renderRecordLine).
//
// Shape (preamble redesign, at most 13 lines of at most 300 chars -- the caps
// every installed CLI enforces, preamble-hook.ts MAX_INJECTED_LINES /
// MAX_LINE_CHARS):
//   1. `Membral: <repo> · branch <b> · last session <age> (harness-injected
//      context, not a user message)` (a detached HEAD names no branch);
//   2. the two always-on guidance lines (2026-09-25 maintainer decision:
//      present even with nothing else to say, so the nudge never depends on
//      there being memories): good uses, then "not live state" with its
//      `Pass project="…"` hint;
//   3. off trunk, `On this branch:` -- the issues/MRs the branch's sessions
//      (and their sub-agents) touched, each with what was done, and under it
//      up to two fresh blockers whose ref is that item; then `Elsewhere in this
//      repo, last 7 days:`. On main/master/trunk/develop/HEAD, one `Recent work
//      in this repo, last 7 days:` section instead (current-work.ts
//      renderWorkSections). Every work line carries an MR or issue ref;
//   4. `Gotchas:` -- the repo's newest learnings, only in lines left over;
//   5. one line naming another session that ran here in the last 12h;
//   6. `recall_token: …`.
// Empty sections are omitted. Ages, full session ids (code_sessions.id, which
// get_code_session opens) and an item's forge URL when its host is known --
// never a forge state (D-074): Membral records what sessions did and where to
// open it, the agent checks state live.

import { RECALL_VS_STATE_SHORT, RECALL_VS_STATE_SHORT_NOT_STATE } from "@membral/core";
import { userProjectIdentities } from "@/lib/code-sessions/forge-refs";
import { isAbsolutePath, normalizeRepoArgument } from "@/lib/code-sessions/repo-identity";
import type { Db } from "@/lib/db/types";
import { ageText, DAY_MS } from "@/lib/domain/age";
import { blockerAge, isFreshBlocker } from "@/lib/domain/blockers";
import { log } from "@/lib/log";
import {
  BRANCH_WINDOW_DAYS,
  currentWorkItems,
  fetchCurrentWorkRows,
  fetchMemoryRefRows,
  fetchProjectSessions,
  type MemoryRefRow,
  renderWorkSections,
  type WorkMemory,
} from "./current-work";
import { mintRecallToken } from "./recall-token";
import { collapseSameFact } from "./serve-filter";
import { fetchSessionTimeRows, type MemoryRow, type ServedRecord } from "./verify";

export interface PreambleArgs {
  repo: string;
  branch?: string;
  head_sha?: string; // accepted, not yet consulted (see the deviation note in verify.ts's header re: memory_branch_state population, §8 bullet 6)
  /** The harness's own session id (`code_sessions.source_session_id`, route `?session=`): never shown as another session. */
  session?: string | null;
}

export interface PreambleResult {
  lines: string[]; // <= 13, each <= 300 chars
  recall_token: string;
  // Always [] since the redesign (no blocker lines). Kept: installed CLIs check it is an array.
  open_blockers: ServedRecord[];
  // Ids of the session_memories records rendered into `lines`, in line order
  // (#361: the route logs them as a surface='preamble' recall event). Not part
  // of the route's response body.
  record_ids: string[];
}

/** The installed CLIs' caps (preamble-hook.ts MAX_INJECTED_LINES / MAX_LINE_CHARS): lines beyond are dropped or cut. */
export const MAX_PREAMBLE_LINES = 13;
export const MAX_LINE_CHARS = 300;

// Only tools the MCP server actually registers (lib/mcp/memory-tools.ts) --
// memory-tools.test.ts fails if a name here is not registered there (e2e C-3:
// the preamble advertised `memory_record`, which does not exist yet, #153).
export const MEMORY_TOOL_NAMES = ["memory_search", "memory_recall", "memory_resolve", "session_summary"] as const;

// Always emitted as lines 2-3, even for a repo with zero memories yet (the
// no-project branch below) -- never emitted on a fetch/timeout/non-200
// failure, because the CLI hook that prints this never gets a response body
// to read a line from in the first place (preamble-hook.ts stays silent on
// every failure path, unchanged by this line's addition).
// The text is the shared recall-vs-state rule (@membral/core agent-guidance.ts).
export const ROUTING_LINES: readonly string[] = RECALL_VS_STATE_SHORT;
/** The routing line that carries the project hint (the last one). */
export const ROUTING_LINE = RECALL_VS_STATE_SHORT_NOT_STATE;

/**
 * G (2026-09-25): names the current repo so the agent knows what to pass as
 * memory_search's `project` / memory_recall's and session_summary's `repo`
 * (resolveProjectId in search.ts now also matches this short name, not just
 * a remote URL or path). Folded onto the last routing line rather than a new
 * line -- the push is capped at MAX_PREAMBLE_LINES (13), as MAX_INJECTED_LINES
 * (preamble-hook.ts) caps the CLI print, so an extra line would just be dropped.
 * `repoName` is the same value the header renders on line 1 --
 * project.display_name/repo_identity when a project exists, else the raw
 * repo argument -- so the hint always names the same repo as line 1.
 * The hint is short (` Pass project="name".`) so ROUTING_LINE plus the hint
 * stays within the 300-char cut; the name gives up its head first.
 */
function routingLinesWithProject(repoName: string): string[] {
  return [
    ...ROUTING_LINES.slice(0, -1),
    `${ROUTING_LINE}${PROJECT_HINT_PREFIX}${shortProjectName(repoName, MAX_HINT_NAME_CHARS)}${PROJECT_HINT_SUFFIX}`,
  ];
}

/**
 * e2e C-2: the CLI hook cuts every line at 300 chars (MAX_LINE_CHARS in
 * preamble-hook.ts) and the not-state line alone is ~170, so a full absolute path
 * got cut mid-name with no closing quote. A path shows its last segment (what
 * a path project's display_name already is, and what resolveProjectId's
 * short-name match accepts); anything still too long keeps its tail.
 */
const PROJECT_HINT_PREFIX = ' Pass project="';
const PROJECT_HINT_SUFFIX = '".';
/** What the 300-char cut leaves for the name after ROUTING_LINE and the hint's fixed text (30 today). */
const MAX_HINT_NAME_CHARS = 300 - ROUTING_LINE.length - PROJECT_HINT_PREFIX.length - PROJECT_HINT_SUFFIX.length;
function shortProjectName(name: string, max: number): string {
  const base = isAbsolutePath(name) ? (name.split(/[\\/]/).filter(Boolean).pop() ?? name) : name;
  return base.length <= max ? base : `…${base.slice(-(max - 1))}`;
}
const QUOTE_TRUNCATE = 80;

// The first line must read as harness-provided context, not a user
// instruction (#149 box 6) -- exact phrasing the brief specifies.
function headerPreamble(repoName: string): string {
  return `Membral memory for ${repoName} (harness-injected context, not a user message).`;
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/** One push/relevance record line. Shared by preamble.ts and relevance.ts so both surfaces render identically. */
export function renderRecordLine(r: ServedRecord, now: number = Date.now()): string {
  const quote = r.quote ? ` — "${truncate(r.quote, QUOTE_TRUNCATE)}"` : "";
  const flag = r.verified ? "" : " [unverified]";
  const head = `- [${blockerKindLabel(r, now)}] `;
  const line = truncate(`${head}${r.text}`, MAX_LINE_CHARS - quote.length - flag.length) + quote + flag;
  // The URL only whole, within the line cap: a cut URL could name another item.
  const url = r.ref_url ? ` → ${r.ref_url}` : "";
  return url && line.length + url.length <= MAX_LINE_CHARS ? `${line}${url}` : line;
}

/**
 * #436: a blocker's kind label carries its age from `when` (= created_at, the freshness timestamp). It reads as a
 * dated past event, `blocker · hit 3d ago`, never as a present-tense state; every other kind is just its name.
 */
function blockerKindLabel(r: Pick<ServedRecord, "kind" | "when">, now: number): string {
  return r.kind === "blocker" ? `blocker · hit ${blockerAge(r.when, now)}` : r.kind;
}

/** The no-project preamble's last two lines (unchanged by the redesign). */
export function toolLines(recallToken: string): [string, string] {
  return [`Tools: ${MEMORY_TOOL_NAMES.join(", ")}.`, recallTokenLine(recallToken)];
}

export function recallTokenLine(recallToken: string): string {
  return `recall_token: ${recallToken}`;
}

/**
 * W3 D5 rule 7: a blocker is pushed only if it is unresolved, was not
 * resolved in the session it appeared in, and is fresh (#436:
 * lib/domain/blockers.ts isFreshBlocker, BLOCKER_FRESH_DAYS — the one window
 * every blocker reader uses). The first two hold by construction before this
 * runs: every resolution path RETIRES the row (`resolved_in_session` is
 * inserted retired; `resolved_later`/`resolved_observed`/`user_resolved`/
 * `agent_resolved` retire it and `resolved_by_session_id` is only ever set
 * with that retirement, 092), and the read keeps `retired_at is null` only.
 * `durable` is not a resolution signal (it is a schema default for most
 * rows); the candidate filter's `durable` test is the separate rule 2.
 * Non-blockers pass. Pure but for the clock.
 */
export function isBlockerShown(row: MemoryRow, now: number = Date.now()): boolean {
  if (row.kind !== "blocker") return true;
  if (row.retired_at) return false;
  return isFreshBlocker(row, now);
}

function excludeSuperseded(rows: readonly MemoryRow[]): MemoryRow[] {
  const superseded = new Set(rows.map((r) => r.supersedes).filter((id): id is string => !!id));
  return rows.filter((r) => !superseded.has(r.id));
}

/** A memory row as the preamble reads it: MemoryRow plus B7's chain link. */
type ChainedRow = MemoryRow & { recurs_of?: string | null };

/**
 * B7 recurrence in the preamble: every live blocker row of one recurrence
 * chain (linked through `recurs_of`, transitively — a chain whose root was
 * retired and restarted on a live row stays one chain) collapses to its
 * NEWEST live row. `seen` maps that row's id to how often the blocker was
 * seen in this project: the largest of the members' `recurrence_count`, the
 * `recurrence_count` of any RETIRED root a member points at
 * (`retiredRootCounts` — the caller reads those, since `rows` are live
 * only), and the number of distinct sessions among the chain's live rows. A root counts every
 * occurrence recorded against it, and a re-rooted live root inherits its
 * retired predecessor's count at write (write.ts carryRetiredRootCounts), so
 * the maximum is the whole chain. Non-blocker rows pass through untouched. Pure.
 */
export function collapseRecurrenceChains<T extends ChainedRow>(
  rows: readonly T[],
  retiredRootCounts: ReadonlyMap<string, number> = new Map(),
): { rows: T[]; seen: Map<string, number>; firstSeenAt: Map<string, string> } {
  const parent = new Map<string, string>();
  const find = (id: string): string => {
    let root = id;
    while (parent.has(root) && parent.get(root) !== root) root = parent.get(root) as string;
    parent.set(id, root);
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  const blockers = rows.filter((r) => r.kind === "blocker");
  for (const r of blockers) {
    if (!parent.has(r.id)) parent.set(r.id, r.id);
    if (r.recurs_of) {
      if (!parent.has(r.recurs_of)) parent.set(r.recurs_of, r.recurs_of);
      union(r.id, r.recurs_of);
    }
  }
  const groups = new Map<string, T[]>();
  for (const r of blockers) {
    const g = find(r.id);
    const list = groups.get(g);
    if (list) list.push(r);
    else groups.set(g, [r]);
  }
  const keep = new Set<string>();
  const seen = new Map<string, number>();
  // F-024: the earliest LIVE member's date, so a collapsed line can add
  // "first YYYY-MM-DD" beside the newest row's own date -- only meaningful
  // with >=2 live members (a lone row's "first" would just repeat "newest").
  // A retired root's own date isn't available here (retiredRootCounts only
  // carries its count, not its created_at), so a re-rooted chain's true
  // first sighting can predate this -- documented simplification, same
  // shape as verify.ts's `when` note.
  const firstSeenAt = new Map<string, string>();
  for (const members of groups.values()) {
    const newest = members.reduce((a, b) => (b.created_at > a.created_at ? b : a));
    keep.add(newest.id);
    const counted = members.reduce(
      (m, r) => Math.max(m, r.recurrence_count ?? 1, (r.recurs_of && retiredRootCounts.get(r.recurs_of)) || 1),
      1,
    );
    // One session is one sighting: a session may keep two distinct rows in one chain (write.ts, review N2).
    const sessions = new Set(members.map((r) => (r as { code_session_id?: string | null }).code_session_id ?? r.id));
    seen.set(newest.id, Math.max(counted, sessions.size));
    if (members.length >= 2) {
      const first = members.reduce((a, b) => (b.created_at < a.created_at ? b : a));
      firstSeenAt.set(newest.id, first.created_at);
    }
  }
  return { rows: rows.filter((r) => r.kind !== "blocker" || keep.has(r.id)), seen, firstSeenAt };
}

/**
 * `recurrence_count` of each retired chain root a live blocker points at
 * (`recurs_of` outside the live set). Best-effort: a failed read counts
 * only what the live rows carry. Shared with lib/threads/queries.ts
 * `collapseBlockerChains`, so the dashboard and the preamble count alike.
 */
export async function retiredRootCountsFor(
  supabase: Db,
  userId: string,
  live: readonly ChainedRow[],
): Promise<Map<string, number>> {
  const liveIds = new Set(live.map((r) => r.id));
  const missing = [
    ...new Set(
      live
        .filter((r) => r.kind === "blocker" && r.recurs_of && !liveIds.has(r.recurs_of))
        .map((r) => r.recurs_of as string),
    ),
  ];
  if (missing.length === 0) return new Map();
  const { data, error } = await supabase
    .from("session_memories")
    .select("id, recurrence_count")
    .eq("user_id", userId)
    .in("id", missing);
  if (error) return new Map();
  return new Map(
    ((data ?? []) as Array<{ id: string; recurrence_count: number | null }>).map((r) => [
      r.id,
      r.recurrence_count ?? 1,
    ]),
  );
}

type ProjectRow = { id: string; display_name: string | null; repo_identity: string };
/** Lines between the routing lines and the recall_token line (13 total, the installed CLIs' cap): header + routing + token are fixed. */
const MAX_BODY_LINES = MAX_PREAMBLE_LINES - (1 + ROUTING_LINES.length + 1);
/** Newest live memories read for the work sections. */
const WORK_MEMORY_LIMIT = 500;

/** Line 1: repo, branch when known, and the last other session's age. */
function headerLine(repoName: string, branch: string | undefined, lastActive: string | null, now: number): string {
  const parts = [`Membral: ${repoName}`];
  // A detached HEAD names no branch.
  if (branch?.trim() && branch.trim() !== "HEAD") parts.push(`branch ${branch.trim()}`);
  parts.push(lastActive ? `last session ${ageText(lastActive, now)}` : "no prior sessions");
  const line = `${parts.join(" · ")} (harness-injected context, not a user message)`;
  return line.length <= MAX_LINE_CHARS ? line : `${line.slice(0, MAX_LINE_CHARS - 1)}…`;
}

// Latency budget (production runs the function and the database in
// different regions, so every SEQUENTIAL request costs ~0.25 s): three
// dependent steps, each one parallel batch --
//   1. the project (and a scoped key's bound project, in parallel);
//   2. the last sessions (header) + the project's sessions in the branch
//      window + its live decision/outcome/learning memories + the user's
//      project identities (the resolver's host set, design §3);
//   3. the window sessions' forge rows + the memory ref fields (titles).
// READS ONLY: nothing here writes (the route logs the recall event itself).
export async function buildPreamble(
  supabase: Db,
  userId: string,
  args: PreambleArgs,
  codeScopeId: string | null = null,
): Promise<PreambleResult> {
  const identity = normalizeRepoArgument(args.repo);
  const [identityRes, boundRes] = await Promise.all([
    supabase
      .from("code_projects")
      .select("id, display_name, repo_identity")
      .eq("user_id", userId)
      .eq("repo_identity", identity)
      .maybeSingle(),
    codeScopeId
      ? supabase
          .from("code_projects")
          .select("id, display_name, repo_identity")
          .eq("user_id", userId)
          .eq("id", codeScopeId)
          .maybeSingle()
      : Promise.resolve(null),
  ]);
  if (identityRes.error) throw new Error(`preamble: code_projects lookup failed: ${identityRes.error.message}`);
  let project = identityRes.data as ProjectRow | null;
  // A code-project-scoped key's bound wins, always (same convention as
  // resolveProjectId in search.ts) -- if the resolved repo isn't the bound
  // project, the caller gets the BOUND project's preamble, never a repo
  // outside their key's scope and never a silent cross-project leak.
  if (codeScopeId && project?.id !== codeScopeId) {
    if (boundRes?.error) throw new Error(`preamble: code_projects bound lookup failed: ${boundRes.error.message}`);
    project = (boundRes?.data ?? null) as ProjectRow | null;
  }
  const repoName = project ? (project.display_name ?? project.repo_identity) : args.repo;
  const recallToken = mintRecallToken(userId, project?.id ?? null);

  if (!project) {
    return {
      lines: [
        `${headerPreamble(repoName)} No prior sessions recorded yet.`,
        ...routingLinesWithProject(repoName),
        ...toolLines(recallToken),
      ],
      recall_token: recallToken,
      open_blockers: [],
      record_ids: [],
    };
  }

  const now = Date.now();
  const branchSince = new Date(now - BRANCH_WINDOW_DAYS * DAY_MS).toISOString();
  const requester = args.session ?? null;
  // Additive: a failed read omits the work sections; the header, routing line
  // and recall_token always render.
  const omitSection = (what: string) => (err: unknown) => {
    log.warn(`preamble: work sections ${what} failed, sections omitted`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  };
  const [{ data: lastRows, error: lastErr }, sessionsRead, memRead, identities] = await Promise.all([
    supabase
      .from("code_sessions")
      .select("id, source_session_id, started_at, ended_at")
      .eq("user_id", userId)
      .eq("code_project_id", project.id)
      .is("parent_source_session_id", null)
      // Latest ACTIVITY, not start (e2e U14): a session resumed the next day
      // is the last session, and its day-2 date is the one to show.
      .order("ended_at", { ascending: false, nullsFirst: false })
      .limit(3),
    fetchProjectSessions(supabase, userId, project.id, branchSince).catch(omitSection("sessions")),
    supabase
      .from("session_memories")
      .select(
        "id, code_session_id, kind, text, ref, ref_kind, branch, created_at, supersedes, recurs_of, recurrence_count",
      )
      .eq("user_id", userId)
      .eq("code_project_id", project.id)
      .is("retired_at", null)
      .in("kind", ["decision", "outcome", "learning", "blocker"])
      .order("created_at", { ascending: false })
      .limit(WORK_MEMORY_LIMIT)
      .then(({ data, error }) => {
        if (error) throw new Error(error.message);
        return (data ?? []) as unknown as (WorkMemory & { supersedes: string | null })[];
      })
      .then(undefined, omitSection("memories")),
    userProjectIdentities(supabase, userId).catch(() => [project.repo_identity]),
  ]);
  if (lastErr) throw new Error(`preamble: code_sessions lookup failed: ${lastErr.message}`);

  const lastSession = (
    (lastRows ?? []) as { source_session_id?: string | null; started_at: string | null; ended_at: string | null }[]
  ).find((r) => !requester || r.source_session_id !== requester);
  const lastActive = lastSession ? (lastSession.ended_at ?? lastSession.started_at) : null;

  // Never the requesting session itself (the route passes the harness session id), nor its sub-agents.
  const sessions = (sessionsRead ?? []).filter(
    (s) => !requester || (s.source_session_id !== requester && s.parent_source_session_id !== requester),
  );
  const sessionIds = sessions.map((s) => s.id);
  // A sub-agent's issues, MRs and memories are its parent session's work: shown under the parent's id and branch.
  const topBySource = new Map(
    sessions.filter((s) => !s.parent_source_session_id && s.source_session_id).map((s) => [s.source_session_id, s.id]),
  );
  const canonical = new Map(
    sessions.map((s) => [s.id, (s.parent_source_session_id && topBySource.get(s.parent_source_session_id)) || s.id]),
  );
  const canon = (id: string | null) => (id ? (canonical.get(id) ?? id) : id);
  const [forgeRowsRead, memoryRefs] = await Promise.all([
    sessionIds.length
      ? fetchCurrentWorkRows(supabase, userId, sessionIds, branchSince).catch(omitSection("forge refs"))
      : Promise.resolve(null),
    sessionIds.length ? fetchMemoryRefRows(supabase, userId, project.id) : Promise.resolve([] as MemoryRefRow[]),
  ]);

  const { items, keyOfMemoryRef } = currentWorkItems(
    {
      rows: (forgeRowsRead ?? []).map((r) => ({ ...r, session_id: canon(r.session_id) as string })),
      sessionFiles: new Map(sessions.map((s) => [s.id, s.files_touched])),
      memoryRefs,
      projectIdentity: project.repo_identity,
      projectIdentities: identities,
      now,
    },
    BRANCH_WINDOW_DAYS,
  );
  // Blockers: only fresh ones (BLOCKER_FRESH_DAYS, the one window every blocker reader uses), one
  // line per recurrence chain (its newest live row).
  // A row's happened_at is when the work happened (its session), not when extraction wrote it: a backfill
  // re-extracts old sessions today. Freshness, ordering and the "hit Nd ago" label all judge on it. Session times
  // come from the windowed list when present, else a user-scoped read by id; created_at is the last fallback.
  const candidates = excludeSuperseded((memRead ?? []) as unknown as MemoryRow[]);
  const sessionTime = new Map<string, string | null>(sessions.map((s) => [s.id, s.ended_at ?? s.started_at]));
  const missing = [
    ...new Set(candidates.map((r) => r.code_session_id).filter((id): id is string => !!id && !sessionTime.has(id))),
  ];
  if (missing.length)
    for (const s of await fetchSessionTimeRows(supabase, userId, missing))
      sessionTime.set(s.id, s.ended_at ?? s.started_at);
  const happenedAt = (r: MemoryRow): string =>
    (r.code_session_id && sessionTime.get(r.code_session_id)) || r.created_at;
  // Blockers judge on the session time everywhere downstream (freshness, recurrence-chain newest, sort), so their
  // created_at is replaced by happened_at; other kinds keep created_at for ordering.
  const live = candidates
    .map((r) => {
      const happened_at = happenedAt(r);
      return r.kind === "blocker" ? { ...r, created_at: happened_at, happened_at } : { ...r, happened_at };
    })
    .filter((r) => isBlockerShown(r, now));
  // L2: paraphrases of one fact (any kind) collapse to the member from the newest session (happened_at), never by
  // insert order; blocker chains were collapsed above.
  const sameFact = collapseSameFact(
    (collapseRecurrenceChains(live as ChainedRow[]).rows as Array<ChainedRow & { happened_at: string }>).map((r) => ({
      ...r,
      code_project_id: project.id,
      code_session_id: r.code_session_id ?? r.id,
    })),
    (r) => Date.parse(r.happened_at) || undefined,
  ).rows;
  const memories = (sameFact as unknown as WorkMemory[]).map((m) => ({
    ...m,
    code_session_id: canon(m.code_session_id),
  }));
  const work = renderWorkSections({
    items,
    keyOfMemoryRef,
    memories,
    sessions,
    branch: args.branch ?? null,
    maxLines: MAX_BODY_LINES,
    now,
  });

  return {
    lines: [
      headerLine(repoName, args.branch, lastActive, now),
      ...routingLinesWithProject(repoName),
      ...work.lines,
      recallTokenLine(recallToken),
    ],
    recall_token: recallToken,
    // Kept for installed CLIs, which check the key is an array; the redesign renders no blocker lines.
    open_blockers: [],
    record_ids: work.memoryIds,
  };
}
