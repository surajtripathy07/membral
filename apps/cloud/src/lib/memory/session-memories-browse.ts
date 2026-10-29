// Web reads of memory v1 records (`session_memories`) for the dashboard:
// the /memories browser and the project page's memory section. The agent
// read tools (search.ts, recall.ts, preamble.ts) stay the serving path;
// this file only lists what is stored, so a user can see what Membral
// remembered from their coding sessions. No LLM or embedding calls here --
// a non-empty search box goes through search.ts's `memorySearch` and this
// file only hydrates its results for display.
//
// Every query is scoped by `user_id` on top of RLS (`own_rows`), the same
// belt-and-braces idiom lib/code-sessions/queries.ts uses.

import { quoteForLink } from "@/lib/code-sessions/quote-highlight";
import type { Db } from "@/lib/db/types";
import { isFreshBlocker } from "@/lib/domain/blockers";
import { handoffFeatureEnabled } from "@/lib/env";
import { MEMORY_KINDS, type MemoryKind } from "./schema";
import { memorySearch } from "./search";

export interface BrowseSessionMemory {
  id: string;
  kind: MemoryKind;
  text: string;
  quote: string | null;
  verified: boolean;
  turn_idx: number;
  code_session_id: string;
  code_project_id: string;
  project_name: string | null;
  created_at: string;
  ref: string | null;
  /** The receipt session is a sub-agent transcript (D-050), or the record names an agent. */
  from_sub_agent: boolean;
}

export interface MemoryProjectOption {
  id: string;
  name: string;
}

interface SessionMemoryRow {
  id: string;
  kind: MemoryKind;
  text: string;
  quote: string | null;
  verified: boolean;
  turn_idx: number;
  code_session_id: string;
  code_project_id: string;
  agent_id: string | null;
  created_at: string;
  ref: string | null;
}

const ROW_COLUMNS =
  "id, kind, text, quote, verified, turn_idx, code_session_id, code_project_id, agent_id, created_at, ref";

// UX audit B5: halved from 50. At the new ListRow height (about half a
// card's), 25/page keeps the /memories page under its 3-viewport target.
export const SESSION_MEMORIES_PAGE_SIZE = 25;

/** A `?kind=` value, or null when absent/not one of the five kinds (old chat-claim kinds like `person` land here). */
export function parseMemoryKind(value: string | null | undefined): MemoryKind | null {
  return value && (MEMORY_KINDS as readonly string[]).includes(value) ? (value as MemoryKind) : null;
}

/** A 1-based `?page=` value; anything unparseable is page 1. */
export function parsePage(value: string | null | undefined): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * Where a record's receipt opens: the session page, jumped straight to the
 * turn that produced it (`#turn-<idx>`, per-turn `id`s added in page.tsx /
 * turn-activity.tsx). The session page's default (non-"show all") load caps
 * at `SESSION_TURNS_DEFAULT_CAP` (queries.ts's getCodeSessionDetail): every
 * user-prose turn loads unconditionally, but only the EARLIEST activity
 * turns up to the remaining budget do — so a turn past the cap is a
 * best-effort signal, not a guarantee, that it fell outside that window.
 * v4: `?turn=N` is always added — the page loads the activity window around
 * that turn, so the anchor exists wherever it sits.
 */
export function receiptHref(
  record: Pick<BrowseSessionMemory, "code_session_id" | "turn_idx"> & { quote?: string | null },
): string {
  // v4 item 6: `?turn=N` loads a window around the turn (queries.ts getCodeSessionDetail), so the
  // anchor exists past the default cap — and past `?all=1`'s hard ceiling too.
  // Verify affordance (goal 2026-10-25 3.5): `&quote=` makes the session page mark the cited text in that turn.
  const quote = quoteForLink(record.quote);
  const q = quote ? `&quote=${encodeURIComponent(quote)}` : "";
  return `/code/session/${record.code_session_id}?turn=${record.turn_idx}${q}#turn-${record.turn_idx}`;
}

/** The user's code projects for the filter dropdown, by display name. */
export async function listMemoryProjects(supabase: Db, userId: string): Promise<MemoryProjectOption[]> {
  const { data, error } = await supabase
    .from("code_projects")
    .select("id, display_name, repo_identity")
    .eq("user_id", userId);
  if (error) throw new Error(`listMemoryProjects: ${error.message}`);
  const rows = (data ?? []) as Array<{ id: string; display_name: string | null; repo_identity: string }>;
  return rows
    .map((r) => ({ id: r.id, name: r.display_name || r.repo_identity }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * `?project=` accepts a project id (the new links) or a project name (the
 * older claims-era links from /code/[projectId]); an id match wins.
 */
export function resolveProjectParam(
  projects: readonly MemoryProjectOption[],
  value: string | null | undefined,
): MemoryProjectOption | null {
  if (!value) return null;
  const byId = projects.find((p) => p.id === value);
  if (byId) return byId;
  const lower = value.toLowerCase();
  return projects.find((p) => p.name.toLowerCase() === lower) ?? null;
}

/**
 * The project list the name join uses: the list itself, or a pending
 * listMemoryProjects read (#173 — /memories starts both reads at once).
 */
export type ProjectsInput = readonly MemoryProjectOption[] | PromiseLike<readonly MemoryProjectOption[]>;

/** Joins project names and the sub-agent flag onto raw rows (one query for sessions; names come from `projects`). */
async function hydrate(
  supabase: Db,
  userId: string,
  rows: readonly SessionMemoryRow[],
  projects: ProjectsInput,
): Promise<BrowseSessionMemory[]> {
  if (rows.length === 0) return [];
  const sessionIds = [...new Set(rows.map((r) => r.code_session_id))];
  const { data, error } = await supabase
    .from("code_sessions")
    .select("id, parent_source_session_id")
    .eq("user_id", userId)
    .in("id", sessionIds);
  if (error) throw new Error(`session memories: code_sessions lookup failed: ${error.message}`);
  const subAgentSessions = new Set(
    ((data ?? []) as Array<{ id: string; parent_source_session_id: string | null }>)
      .filter((s) => s.parent_source_session_id)
      .map((s) => s.id),
  );
  // #173: awaited only here, after this function's own query, so a caller can
  // start the list/search read before listMemoryProjects resolves.
  const names = new Map((await projects).map((p) => [p.id, p.name]));
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    text: r.text,
    quote: r.quote,
    verified: r.verified,
    turn_idx: r.turn_idx,
    code_session_id: r.code_session_id,
    code_project_id: r.code_project_id,
    project_name: names.get(r.code_project_id) ?? null,
    created_at: r.created_at,
    ref: r.ref,
    from_sub_agent: subAgentSessions.has(r.code_session_id) || !!r.agent_id,
  }));
}

export interface ListSessionMemoriesOptions {
  projectId?: string | null;
  kind?: MemoryKind | null;
  limit?: number;
  offset?: number;
}

/** Live records (`retired_at is null`), newest first. Fetches one extra row to know whether an older page exists. */
export async function listSessionMemories(
  supabase: Db,
  userId: string,
  projects: ProjectsInput,
  opts: ListSessionMemoriesOptions = {},
): Promise<{ records: BrowseSessionMemory[]; hasMore: boolean }> {
  const limit = opts.limit ?? SESSION_MEMORIES_PAGE_SIZE;
  const offset = opts.offset ?? 0;
  let query = supabase.from("session_memories").select(ROW_COLUMNS).eq("user_id", userId).is("retired_at", null);
  if (opts.projectId) query = query.eq("code_project_id", opts.projectId);
  // Without a kind filter, only the extracted kinds: the "All" view must not list a synthesized `handoff` note. With
  // both handoff flags off no note is written, so the query keeps its pre-handoff shape.
  if (opts.kind) query = query.eq("kind", opts.kind);
  else if (handoffFeatureEnabled()) query = query.in("kind", MEMORY_KINDS);
  const { data, error } = await query.order("created_at", { ascending: false }).range(offset, offset + limit);
  if (error) throw new Error(`listSessionMemories: ${error.message}`);
  const rows = (data ?? []) as SessionMemoryRow[];
  const records = await hydrate(supabase, userId, rows.slice(0, limit), projects);
  return { records, hasMore: rows.length > limit };
}

/**
 * UX W6 (Memory kind chips): live-record count per kind, scoped like the
 * list (optionally one project). One `head` count query per kind, run in
 * parallel; a kind whose count fails is left out, so the chip renders
 * without a number rather than failing the page.
 */
export async function countSessionMemoriesByKind(
  supabase: Db,
  userId: string,
  opts: { projectId?: string | null } = {},
): Promise<Partial<Record<MemoryKind, number>>> {
  const entries = await Promise.all(
    MEMORY_KINDS.map(async (kind) => {
      let query = supabase
        .from("session_memories")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .is("retired_at", null)
        .eq("kind", kind);
      if (opts.projectId) query = query.eq("code_project_id", opts.projectId);
      const { count, error } = await query;
      return error || typeof count !== "number" ? null : ([kind, count] as const);
    }),
  );
  return Object.fromEntries(entries.filter((e): e is readonly [MemoryKind, number] => e !== null));
}

/**
 * The search box: search.ts's `memorySearch` (relevance-ranked, live only,
 * ≤ 20), then the served ids re-read from `session_memories` for the
 * display fields the served shape omits. Served order and served
 * `verified` (re-checked at serve time) win.
 */
export async function searchSessionMemories(
  supabase: Db,
  userId: string,
  projects: ProjectsInput,
  opts: { query: string; projectId?: string | null; kind?: MemoryKind | null },
): Promise<{ records: BrowseSessionMemory[]; degraded?: string }> {
  // The project filter rides the `codeScopeId` slot: it is already a
  // resolved code_projects.id, which is exactly what that slot carries.
  // #436: the /memories archive lists every live record, old blockers included,
  // so its search does too (the hidden-when-read rule is for working surfaces).
  const result = await memorySearch(
    supabase,
    userId,
    opts.projectId ?? null,
    { query: opts.query, kind: opts.kind ?? undefined, limit: 20 },
    { includeStaleBlockers: true },
  );
  const ids = result.records.map((r) => r.id);
  if (ids.length === 0) return { records: [], degraded: result.degraded };
  const { data, error } = await supabase
    .from("session_memories")
    .select(ROW_COLUMNS)
    .eq("user_id", userId)
    .in("id", ids);
  if (error) throw new Error(`searchSessionMemories: ${error.message}`);
  const byId = new Map(((data ?? []) as SessionMemoryRow[]).map((r) => [r.id, r]));
  const served = new Map(result.records.map((r) => [r.id, r]));
  const ordered = ids
    .map((id) => byId.get(id))
    .filter((r): r is SessionMemoryRow => !!r)
    .map((r) => ({
      ...r,
      verified: served.get(r.id)?.verified ?? r.verified,
      turn_idx: served.get(r.id)?.turn_idx ?? r.turn_idx,
    }));
  const records = await hydrate(supabase, userId, ordered, projects);
  return { records, degraded: result.degraded };
}

// ---------------------------------------------------------------------------
// Project page: grouped by kind.
// ---------------------------------------------------------------------------

/** Display order on the project page; outcomes collapse to a count (they are what git/gh already answer, §4). */
export const PROJECT_GROUP_ORDER = ["preference", "blocker", "decision", "learning"] as const;

export const PROJECT_GROUP_LABELS: Record<(typeof PROJECT_GROUP_ORDER)[number], string> = {
  preference: "Preferences",
  blocker: "Open blockers",
  decision: "Decisions",
  learning: "Learnings",
};

export interface ProjectMemoryGroup {
  kind: (typeof PROJECT_GROUP_ORDER)[number];
  label: string;
  records: BrowseSessionMemory[];
  total: number;
}

export interface ProjectMemoryGroups {
  groups: ProjectMemoryGroup[];
  outcomeCount: number;
  total: number;
}

/** Buckets records (already newest first) by kind, `cap` per kind; empty kinds are dropped; blockers older than BLOCKER_FRESH_DAYS are left out. */
export function groupProjectMemories(
  records: readonly BrowseSessionMemory[],
  cap = 8,
  now: number = Date.now(),
): ProjectMemoryGroups {
  const groups: ProjectMemoryGroup[] = [];
  for (const kind of PROJECT_GROUP_ORDER) {
    // #436: "Open blockers" shows fresh blockers only (lib/domain/blockers.ts).
    const ofKind = records.filter((r) => r.kind === kind && isFreshBlocker(r, now));
    if (ofKind.length === 0) continue;
    groups.push({ kind, label: PROJECT_GROUP_LABELS[kind], records: ofKind.slice(0, cap), total: ofKind.length });
  }
  return { groups, outcomeCount: records.filter((r) => r.kind === "outcome").length, total: records.length };
}

/**
 * The project page's grouped memories. The page hands its memory section
 * only the project's display name (`display_name || repo_identity`), so the
 * project is resolved by that name unless an id is given. Two projects
 * sharing a name resolve to the first; the "view all" link carries the id.
 */
export async function loadProjectMemoryGroups(
  supabase: Db,
  userId: string,
  opts: { projectId?: string | null; projectName: string; cap?: number; limit?: number; now?: number },
): Promise<{ project: MemoryProjectOption | null; grouped: ProjectMemoryGroups }> {
  const projects = await listMemoryProjects(supabase, userId);
  const project = resolveProjectParam(projects, opts.projectId ?? opts.projectName);
  if (!project) return { project: null, grouped: groupProjectMemories([], opts.cap) };
  const { records } = await listSessionMemories(supabase, userId, projects, {
    projectId: project.id,
    limit: opts.limit ?? 500,
    offset: 0,
  });
  return { project, grouped: groupProjectMemories(records, opts.cap, opts.now) };
}
