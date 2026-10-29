// Supabase loaders for the /code view (ADR 0021 Q6, P1d).
//
// Thin wrappers around RLS-scoped selects — same pattern as lib/stats.ts's
// getConversationStats and the rest of the dashboard: the caller passes an
// already-authenticated server-component Supabase client (lib/supabase/server
// createClient()), auth.uid() = user_id RLS does the isolation, and every
// query is ALSO explicitly .eq("user_id", userId) as defense-in-depth. Row
// shaping (rollup parsing, turn grouping, duration formatting) lives in
// view.ts and is unit tested there; this file is exercised via the dev
// server / browser verification per CLAUDE.md's cloud test conventions.
//
// ISOLATION (ADR Q2): every query here reads only code_* tables — never
// kg_edges/kg_nodes, never a write. (code_cross_links is written by
// cross-links.ts and read by the §8.3 MCP tools directly; this file has no
// cross-link leg — nothing here renders it, see review-084.md finding 5.)

import type { PostgrestError } from "@supabase/supabase-js";
import { type AgentStatsSessionInput, sessionLiveCostUsd } from "@/lib/agent-stats/aggregate";
import type { AttributionTurnInput, SessionIssueRow } from "@/lib/agent-stats/attribution";
import type { TypedDb } from "@/lib/db/types";
import { PAGE_SIZE, selectAllByIdKeyset, selectAllRows, selectAllSessionsByKeyset } from "../util/pagination";
import { turnWindow } from "./turn-window";
import type { FactTypeTrueCounts, RawTurnRow, SubAgentMeta, ToolUseTurnRef, TurnRow } from "./view";
import {
  parseSubAgentMeta,
  parseSubAgentSpawnIndex,
  RECURRING_MIN_SESSION_COUNT,
  shapeTurnRow,
  titleSourceText,
} from "./view";

type PageResult<Row> = { data: Row[] | null; error: { message: string } | null };

/**
 * Drain a PostgREST select page-by-page up to a hard row ceiling (unlike
 * selectAllRows in kg/pagination.ts, which drains unboundedly until a short
 * page — not what we want for a "show all" turn dump, which must still be
 * bounded even for a pathological session).
 */
async function selectBoundedRows<Row>(
  ceiling: number,
  makePage: (from: number, to: number) => PromiseLike<PageResult<Row>>,
): Promise<Row[]> {
  const out: Row[] = [];
  for (let offset = 0; offset < ceiling; offset += PAGE_SIZE) {
    const to = Math.min(offset + PAGE_SIZE - 1, ceiling - 1);
    const { data, error } = await makePage(offset, to);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < to - offset + 1) break; // short page — nothing more to fetch
  }
  return out;
}

export async function getCodeSessionCount(supabase: TypedDb, userId: string): Promise<number> {
  const { count, error } = await supabase
    .from("code_sessions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("parent_source_session_id", null);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

// ---- Recent sessions (cross-project) ---------------------------------------
//
// Handoff 0024 directive D: surface the code dimension on /pulse ("Lately")
// and /conversations, not just at /code. This is the one cross-project read
// in this file — every other loader above/below scopes to a single project
// or session; this drains the newest sessions across ALL of a user's
// projects, for a compact "recent code activity" strip on primary pages.
// Callers MUST gate on hasCodeSessions(getCodeSessionCount(...)) first (same
// count-gate the /code nav entry uses — see (dashboard)/layout.tsx).

export interface RecentCodeSessionRow {
  id: string;
  code_project_id: string;
  title: string | null;
  summary: string | null;
  started_at: string | null;
  // #88 item 8: title is NULL corpus-wide, so the card needs duration + turn
  // count to read as an actual session card rather than a bare date/project line.
  duration_seconds: number | null;
  turn_count: number;
  // F6 (adversarial finding): a bare turn_count ("81 turns") doesn't match
  // the established "N turns (M yours)" idiom already used on /code and
  // /code/[projectId] — carry user_turn_count too so the card can match it.
  user_turn_count: number;
  project_display_name: string | null;
  project_repo_identity: string | null;
}

/**
 * Flatten a code_sessions row embedding code_projects(display_name,
 * repo_identity) (same PostgREST embedded-resource shape as
 * getCodeSessionDetail above) into RecentCodeSessionRow. Split out as a pure
 * function so the join-flattening is unit-testable without a live Supabase
 * client — the round-trip itself is browser-verified per this file's header.
 */
// biome-ignore lint/suspicious/noExplicitAny: PostgREST embedded-resource shape isn't in the (stale) generated database types
export function shapeRecentCodeSessionRow(raw: any): RecentCodeSessionRow {
  return {
    id: raw.id,
    code_project_id: raw.code_project_id,
    title: raw.title ?? null,
    summary: raw.summary ?? null,
    started_at: raw.started_at ?? null,
    duration_seconds: raw.duration_seconds ?? null,
    turn_count: raw.turn_count ?? 0,
    user_turn_count: raw.user_turn_count ?? 0,
    project_display_name: raw.code_projects?.display_name ?? null,
    project_repo_identity: raw.code_projects?.repo_identity ?? null,
  };
}

export async function getRecentCodeSessions(
  supabase: TypedDb,
  userId: string,
  limit: number,
): Promise<RecentCodeSessionRow[]> {
  const { data, error } = await supabase
    .from("code_sessions")
    .select(
      "id, code_project_id, title, summary, started_at, duration_seconds, turn_count, user_turn_count, code_projects(display_name, repo_identity)",
    )
    .eq("user_id", userId)
    .is("parent_source_session_id", null)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  // biome-ignore lint/suspicious/noExplicitAny: PostgREST embedded-resource shape isn't in the (stale) generated database types
  return ((data ?? []) as any[]).map(shapeRecentCodeSessionRow);
}

// ---- Sub-agent child sessions (migration 089) ------------------------------
//
// A sub-agent transcript is its own code_sessions row whose
// parent_source_session_id names the spawning session's SOURCE id. Every list
// above excludes those rows; this is the one read that returns them, for the
// session view to show a parent's sub-agents.

export interface ChildSessionRow {
  id: string;
  source_session_id: string;
  title: string | null;
  started_at: string | null;
  turn_count: number;
  agent_type: string | null;
  description: string | null;
  tool_use_id: string | null;
  // Join keys for nesting (view.ts's buildSubAgentTree) — a nested spawn's
  // meta.json agentId/parentAgentId (ADR 0026); null for an opencode child,
  // which has no nested-spawn concept (opencode.ts's header comment).
  agent_id: string | null;
  parent_agent_id: string | null;
}

// biome-ignore lint/suspicious/noExplicitAny: PostgREST json-path select shape isn't in the (stale) generated database types
export function shapeChildSessionRow(raw: any): ChildSessionRow {
  const sub = raw.sub_agent ?? raw.props?.subAgent ?? null;
  return {
    id: raw.id,
    source_session_id: raw.source_session_id,
    title: raw.title ?? null,
    started_at: raw.started_at ?? null,
    turn_count: raw.turn_count ?? 0,
    agent_type: typeof sub?.agentType === "string" ? sub.agentType : null,
    description: typeof sub?.description === "string" ? sub.description : null,
    tool_use_id: typeof sub?.toolUseId === "string" ? sub.toolUseId : null,
    agent_id: typeof sub?.agentId === "string" ? sub.agentId : null,
    parent_agent_id: typeof sub?.parentAgentId === "string" ? sub.parentAgentId : null,
  };
}

// A parent with more sub-agents than this is pathological (137 was an entire
// 1k-session corpus, ADR 0026 §1.3) — bounded rather than drained.
const SESSION_CHILDREN_CEILING = 500;

export async function listChildSessions(
  supabase: TypedDb,
  userId: string,
  source: string,
  sourceSessionId: string,
): Promise<ChildSessionRow[]> {
  const { data, error } = await supabase
    .from("code_sessions")
    .select("id, source_session_id, title, started_at, turn_count, sub_agent:props->subAgent")
    .eq("user_id", userId)
    .eq("source", source)
    .eq("parent_source_session_id", sourceSessionId)
    .order("started_at", { ascending: true })
    .limit(SESSION_CHILDREN_CEILING);
  if (error) throw new Error(error.message);
  // biome-ignore lint/suspicious/noExplicitAny: see shapeChildSessionRow
  return ((data ?? []) as any[]).map(shapeChildSessionRow);
}

export interface ParentSessionForChild {
  id: string;
  title: string | null;
  summary: string | null;
  git_branch: string | null;
  turn_count: number;
  started_at: string | null;
  /** The parent's first user-prose turn — the breadcrumb label when it has no title/summary (view.ts's parentBreadcrumbLabel). */
  first_prompt: string | null;
}

/**
 * Resolve a child session's parent by (user_id, source, source_session_id =
 * the child's parent_source_session_id) — the same join key
 * listChildSessions matches children against, in reverse. Used by the child
 * session page's breadcrumb; `.maybeSingle()` is safe here (unlike
 * getCodeSessionFacts's F7 concern) since (user_id, source,
 * source_session_id) is the table's own natural key, enforced at import.
 */
export async function getParentSessionForChild(
  supabase: TypedDb,
  userId: string,
  source: string,
  parentSourceSessionId: string,
): Promise<ParentSessionForChild | null> {
  const { data, error } = await supabase
    .from("code_sessions")
    .select("id, title, summary, git_branch, turn_count, started_at")
    .eq("user_id", userId)
    .eq("source", source)
    .eq("source_session_id", parentSourceSessionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  const parent = data as Omit<ParentSessionForChild, "first_prompt">;
  let firstPrompt: string | null = null;
  if (!parent.title?.trim()) {
    const promptRes = await supabase
      .from("code_session_turns")
      .select("text")
      .eq("user_id", userId)
      .eq("session_id", parent.id)
      .eq("role", "user")
      .eq("kind", "prose")
      .order("idx", { ascending: true })
      .range(0, 0);
    if (promptRes.error) throw new Error(promptRes.error.message);
    firstPrompt = (promptRes.data?.[0] as { text: string | null } | undefined)?.text ?? null;
  }
  return { ...parent, first_prompt: firstPrompt };
}

/**
 * Batch read-time helper for D (2026-09-25, "no more Untitled session"): each
 * given session's first real user prose turn text (role=user, kind=prose —
 * harness-injected turns are never written with that kind, see view.ts's
 * sessionDisplayTitle doc comment), for feeding sessionDisplayTitle's
 * firstUserMessage fallback. One query for however many ids are passed (call
 * only with the ids that actually need it — a session with a title or
 * summary already never needs this); picks the lowest `idx` per session_id
 * in JS rather than relying on a DB-side ORDER BY (a plain per-session min,
 * so it's correct regardless of how the rows come back).
 */
export async function getFirstUserMessages(
  supabase: TypedDb,
  userId: string,
  sessionIds: string[],
): Promise<Map<string, string>> {
  if (sessionIds.length === 0) return new Map();
  // Paged: every user prose turn of the batch, which can pass PostgREST's
  // 1000-row cap (an unordered, capped read dropped some sessions' prompts).
  // Paged by keyset (review S5): every user prose turn of the batch, which can pass PostgREST's
  // 1000-row cap (an unordered, capped read dropped some sessions' prompts).
  const data = await selectAllByIdKeyset<{
    id: string;
    session_id: string;
    idx: number;
    text: string | null;
    owner_text?: string | null;
  }>(() =>
    supabase
      .from("code_session_turns")
      .select("id, session_id, idx, text, owner_text:props->>ownerText")
      .eq("user_id", userId)
      .in("session_id", sessionIds)
      .eq("role", "user")
      .eq("kind", "prose"),
  );

  // UX W6 (review 3b): the title fallback reads the owner's own words — the
  // stored `ownerText` (cecfe8e) when the prompt carried a paste, else the
  // text with any paste span stripped. A prompt that was ONLY a paste is
  // skipped, so the next real prompt titles the session.
  const best = new Map<string, { idx: number; text: string }>();
  for (const row of data) {
    if (!row.text) continue;
    const own = titleSourceText(row.text, row.owner_text ?? null);
    if (!own.trim()) continue;
    const existing = best.get(row.session_id);
    if (!existing || row.idx < existing.idx) best.set(row.session_id, { idx: row.idx, text: own });
  }
  return new Map([...best].map(([id, v]) => [id, v.text] as const));
}

// ---- Project list -----------------------------------------------------------

export interface CodeProjectListRow {
  id: string;
  display_name: string | null;
  repo_identity: string;
  session_count: number;
  last_active_at: string | null;
  summary: string | null;
}

export interface CodeProjectsPage {
  projects: CodeProjectListRow[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export async function getCodeProjectsPage(
  supabase: TypedDb,
  userId: string,
  page: number,
  pageSize: number,
): Promise<CodeProjectsPage> {
  const from = (page - 1) * pageSize;
  const to = from + pageSize - 1;

  const [listRes, countRes] = await Promise.all([
    supabase
      .from("code_projects")
      .select("id, display_name, repo_identity, session_count, last_active_at, summary")
      .eq("user_id", userId)
      .order("last_active_at", { ascending: false, nullsFirst: false })
      .range(from, to),
    supabase.from("code_projects").select("id", { count: "exact", head: true }).eq("user_id", userId),
  ]);
  if (listRes.error) throw new Error(listRes.error.message);
  if (countRes.error) throw new Error(countRes.error.message);

  const total = countRes.count ?? 0;
  return {
    projects: (listRes.data ?? []) as CodeProjectListRow[],
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  };
}

// ---- Project detail -----------------------------------------------------------

export interface CodeProjectRow {
  id: string;
  display_name: string | null;
  repo_identity: string;
  remote_url: string | null;
  summary: string | null;
  props: Record<string, unknown> | null;
  session_count: number;
  last_active_at: string | null;
}

export interface CodeSessionListRow {
  id: string;
  title: string | null;
  summary: string | null;
  git_branch: string | null;
  started_at: string | null;
  duration_seconds: number | null;
  turn_count: number;
  user_turn_count: number;
  files_touched: string[] | null;
  /** D (2026-09-25): first real user message, filled in only for rows with neither title nor summary — see
   *  getFirstUserMessages. Feeds sessionDisplayTitle's firstUserMessage fallback in sessions-timeline.tsx. */
  firstUserMessage?: string | null;
  /** UX W5: the session's whole live cost (sessionLiveCostUsd — main + sub-agents, same path as the session header); null when unpriced. */
  costUsd?: number | null;
}

export interface CodeProjectDetail {
  project: CodeProjectRow;
  sessions: CodeSessionListRow[];
  sessionsTotal: number;
  sessionsPage: number;
  sessionsPageSize: number;
  sessionsTotalPages: number;
}

export async function getCodeProjectDetail(
  supabase: TypedDb,
  userId: string,
  projectId: string,
  sessionsPage: number,
  sessionsPageSize: number,
): Promise<CodeProjectDetail | null> {
  const projectRes = await supabase
    .from("code_projects")
    .select("id, display_name, repo_identity, remote_url, summary, props, session_count, last_active_at")
    .eq("user_id", userId)
    .eq("id", projectId)
    .maybeSingle();
  if (projectRes.error) throw new Error(projectRes.error.message);
  if (!projectRes.data) return null;

  const from = (sessionsPage - 1) * sessionsPageSize;
  const to = from + sessionsPageSize - 1;

  const [sessionsRes, sessionsCountRes] = await Promise.all([
    supabase
      .from("code_sessions")
      .select(
        "id, title, summary, git_branch, started_at, duration_seconds, turn_count, user_turn_count, files_touched, usage:props->usage, models:props->models, sub_agents:props->subAgents",
      )
      .eq("user_id", userId)
      .eq("code_project_id", projectId)
      .is("parent_source_session_id", null)
      .order("started_at", { ascending: false, nullsFirst: false })
      .range(from, to),
    supabase
      .from("code_sessions")
      .select("id", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("code_project_id", projectId)
      .is("parent_source_session_id", null),
  ]);
  if (sessionsRes.error) throw new Error(sessionsRes.error.message);
  if (sessionsCountRes.error) throw new Error(sessionsCountRes.error.message);

  const sessionsTotal = sessionsCountRes.count ?? 0;
  // UX W5: each row's live cost from the SAME rows (no extra query, no per-row
  // read); the three json-path pricing columns are dropped once priced.
  const sessions = (
    (sessionsRes.data ?? []) as (CodeSessionListRow & { usage?: unknown; models?: unknown; sub_agents?: unknown })[]
  ).map(({ usage, models, sub_agents, ...row }) => ({
    ...row,
    costUsd: sessionLiveCostUsd({
      id: row.id,
      started_at: row.started_at,
      turn_count: row.turn_count,
      user_turn_count: row.user_turn_count,
      props: { usage, models, subAgents: sub_agents },
    }),
  }));

  // D (2026-09-25): only the rows sessionDisplayTitle would otherwise render
  // "Untitled session" for (no title, no summary) pay for the extra query.
  const needFallback = sessions.filter((s) => !s.title?.trim() && !s.summary?.trim()).map((s) => s.id);
  if (needFallback.length > 0) {
    const firstMessages = await getFirstUserMessages(supabase, userId, needFallback);
    for (const s of sessions) {
      const msg = firstMessages.get(s.id);
      if (msg) s.firstUserMessage = msg;
    }
  }

  return {
    project: projectRes.data as CodeProjectRow,
    sessions,
    sessionsTotal,
    sessionsPage,
    sessionsPageSize,
    sessionsTotalPages: Math.max(1, Math.ceil(sessionsTotal / sessionsPageSize)),
  };
}

// ---- Code-graph facts (GitHub issue #87) -----------------------------------
//
// Surfaces the P2a deterministic code-graph (code_kg_nodes/code_kg_edges,
// migration 031) in the UI for the first time — reads ONLY those two tables,
// never kg_edges, never a write, per this file's isolation header above.
//
// 031's own header (OWNERSHIP NOTE, F11) warns that a project-scoped reader
// filtering on code_project_id alone is a graph-poisoning vector (RLS blocks
// cross-USER reads, but does not check that a code_project_id actually
// belongs to the row's user_id) — every query below filters on BOTH user_id
// AND the scoping id, never one alone.

export interface CodeKgFactRow {
  id: string;
  node_type: "file" | "tool" | "subagent";
  key: string;
  label: string;
  props: Record<string, unknown>;
  session_count: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
}

export interface CodeProjectFactsResult {
  rows: CodeKgFactRow[];
  /** TRUE per-type total/qualifying counts from exact head-count queries — NOT derived from `rows`, which is fetch-capped per type. Feed straight into shapeProjectFacts's trueCountsByType so "+K more" reflects the full corpus (F3 adversarial finding). */
  trueCounts: Partial<Record<CodeKgFactRow["node_type"], FactTypeTrueCounts>>;
}

const PROJECT_FACTS_NODE_TYPES = ["file", "tool", "subagent"] as const;
// Per-type, not shared: the original single `.limit(60)` query spanned ALL
// three node_types combined, ordered by session_count desc — on a real
// founder-1k project, a type with many high-count rows (e.g. tools) crowded
// low-count-but-real subagent/file rows out of the fetch entirely, silently
// under-reporting "+K more" (adversarial finding F3: observed "+34/+6" in the
// UI against a true "+37/+12"). One query per type, each with its own
// budget, plus exact head-counts for moreCount below, fixes both.
const PROJECT_FACTS_PER_TYPE_LIMIT = 40;

/**
 * The Tier-1 graph's file/tool/subagent nodes for one project: one query per
 * node_type (own `.limit`, so one type's row count never starves another's),
 * plus exact `count: "exact", head: true` queries for each type's TRUE total
 * and qualifying (session_count >= RECURRING_MIN_SESSION_COUNT) row counts —
 * shapeProjectFacts (view.ts) uses those true counts for "+K more" rather
 * than counting only the fetched (capped) rows.
 */
export async function getCodeProjectFacts(
  supabase: TypedDb,
  userId: string,
  projectId: string,
): Promise<CodeProjectFactsResult> {
  const rows: CodeKgFactRow[] = [];
  const trueCounts: CodeProjectFactsResult["trueCounts"] = {};

  for (const nodeType of PROJECT_FACTS_NODE_TYPES) {
    const countBase = () =>
      supabase
        .from("code_kg_nodes")
        .select("id", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("code_project_id", projectId)
        .eq("node_type", nodeType);

    const [totalRes, qualifyingRes, dataRes] = await Promise.all([
      countBase(),
      countBase().gte("session_count", RECURRING_MIN_SESSION_COUNT),
      supabase
        .from("code_kg_nodes")
        .select("id, node_type, key, label, props, session_count, first_seen_at, last_seen_at")
        .eq("user_id", userId)
        .eq("code_project_id", projectId)
        .eq("node_type", nodeType)
        .order("session_count", { ascending: false })
        .limit(PROJECT_FACTS_PER_TYPE_LIMIT),
    ]);
    if (totalRes.error) throw new Error(totalRes.error.message);
    if (qualifyingRes.error) throw new Error(qualifyingRes.error.message);
    if (dataRes.error) throw new Error(dataRes.error.message);

    trueCounts[nodeType] = { total: totalRes.count ?? 0, qualifying: qualifyingRes.count ?? 0 };
    rows.push(...((dataRes.data ?? []) as CodeKgFactRow[]));
  }

  return { rows, trueCounts };
}

export interface CodeKgSessionEdgeRow {
  rel_type: "touched" | "used";
  weight: number;
  props: Record<string, unknown>;
  node_type: string;
  key: string;
  label: string;
}

/**
 * UX W5 (cost-consistency.md #5, ADR 0032 §1.3 finding 4): only the run
 * metadata the facts strip renders — `models` and `usage` — never the mirror
 * node's stored `est_cost_usd` snapshot. The select names the two json paths,
 * so PostgREST returns them as top-level keys; a row that still carries a
 * whole `props` object is picked the same way.
 */
export function pickSessionRunProps(row: Record<string, unknown>): Record<string, unknown> {
  const src = row.props && typeof row.props === "object" ? (row.props as Record<string, unknown>) : row;
  const picked: Record<string, unknown> = {};
  if (src.models !== undefined && src.models !== null) picked.models = src.models;
  if (src.usage !== undefined && src.usage !== null) picked.usage = src.usage;
  return picked;
}

export interface CodeSessionFactsRaw {
  /** The session mirror node's run metadata (models/usage only — see pickSessionRunProps). Null when no graph has been built for this session yet (e.g. before the first Stage-1 build, or a session predating P2a). */
  sessionProps: Record<string, unknown> | null;
  edges: CodeKgSessionEdgeRow[];
}

/**
 * The session mirror node (node_type='session', ref_id=sessionId) + its
 * outgoing touched/used edges, each resolved to the destination file/tool
 * node's key+label. `ref_id` is code_sessions.id — a globally unique UUID —
 * so looking it up needs no separate code_project_id filter to disambiguate
 * (unlike getCodeProjectFacts's file/tool/subagent `key`s, which are only
 * unique WITHIN a project); user_id is still filtered as defense-in-depth.
 *
 * F7 (adversarial finding): `.maybeSingle()` THROWS if more than one row
 * matches — and a session mirror node is only unique per (code_project_id,
 * node_type, key) at the DB level (031's own unique constraint), not per
 * (user_id, node_type, ref_id). A mis-linked import that re-mirrors the same
 * source session under a second code_project_id would produce two rows here
 * and 500 this page. Order + take the first instead: deterministic
 * (earliest-created wins, so a rebuild never flips which row "wins" between
 * page loads) and never throws on a duplicate — it just picks one.
 */
export async function getCodeSessionFacts(
  supabase: TypedDb,
  userId: string,
  sessionId: string,
): Promise<CodeSessionFactsRaw> {
  const nodeRes = await supabase
    .from("code_kg_nodes")
    .select("id, models:props->models, usage:props->usage")
    .eq("user_id", userId)
    .eq("node_type", "session")
    .eq("ref_id", sessionId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (nodeRes.error) throw new Error(nodeRes.error.message);
  // biome-ignore lint/suspicious/noExplicitAny: fake/real supabase-js row shape
  const nodeRow = (((nodeRes.data ?? []) as any[])[0] ?? null) as Record<string, unknown> | null;
  if (!nodeRow) return { sessionProps: null, edges: [] };
  const sessionNode = { id: nodeRow.id as string, props: pickSessionRunProps(nodeRow) };

  const edgesRes = await supabase
    .from("code_kg_edges")
    .select("dst_node_id, rel_type, weight, props")
    .eq("user_id", userId)
    .eq("src_node_id", sessionNode.id)
    .in("rel_type", ["touched", "used"]);
  if (edgesRes.error) throw new Error(edgesRes.error.message);
  // biome-ignore lint/suspicious/noExplicitAny: fake/real supabase-js row shape
  const edgeRows = (edgesRes.data ?? []) as any[];
  if (edgeRows.length === 0) return { sessionProps: sessionNode.props, edges: [] };

  const dstIds = [...new Set(edgeRows.map((e) => e.dst_node_id as string))];
  const nodesRes = await supabase
    .from("code_kg_nodes")
    .select("id, node_type, key, label")
    .eq("user_id", userId)
    .in("id", dstIds);
  if (nodesRes.error) throw new Error(nodesRes.error.message);
  // biome-ignore lint/suspicious/noExplicitAny: fake/real supabase-js row shape
  const nodesById = new Map(((nodesRes.data ?? []) as any[]).map((n) => [n.id as string, n]));

  const edges: CodeKgSessionEdgeRow[] = edgeRows
    .map((e) => {
      const node = nodesById.get(e.dst_node_id as string);
      if (!node) return null;
      return {
        rel_type: e.rel_type as "touched" | "used",
        weight: e.weight as number,
        props: (e.props as Record<string, unknown>) ?? {},
        node_type: node.node_type as string,
        key: node.key as string,
        label: node.label as string,
      };
    })
    .filter((e): e is CodeKgSessionEdgeRow => e !== null);

  return { sessionProps: sessionNode.props, edges };
}

// ---- Session detail -----------------------------------------------------------

export interface CodeSessionRow {
  id: string;
  code_project_id: string;
  title: string | null;
  summary: string | null;
  git_branch: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  turn_count: number;
  user_turn_count: number;
  tool_count: number;
  files_touched: string[] | null;
  project_display_name: string | null;
  project_repo_identity: string | null;
  // Migration 089 (sub-agent sessions): source_session_id is the join key
  // listChildSessions matches children's parent_source_session_id against;
  // parent_source_session_id/subAgent are set only on a CHILD session's own
  // row (null on a normal/parent session) — the page uses parent_source_session_id
  // to tell the two apart.
  source: string;
  source_session_id: string;
  parent_source_session_id: string | null;
  subAgent: SubAgentMeta | null;
}

export interface CodeSessionDetail {
  session: CodeSessionRow;
  turns: TurnRow[];
  turnsTotal: number;
  truncated: boolean;
  /** Set on a `?turn=N` load: the idx range rendered (the page links to the turns either side). */
  window?: { from: number; to: number; hasLater: boolean };
  /** This session's own props.subAgents[] agentId -> spawning toolUseId (view.ts's parseSubAgentSpawnIndex) — the opencode child join. */
  subAgentSpawnIndex: Map<string, string>;
}

// Cap for the default (non-"show all") load — most sessions are well under
// this; the page renders a "show all N turns" affordance above the cap
// rather than always paying for a full drain (P1d spec: "load in one go but
// cap + show all if huge").
export const SESSION_TURNS_DEFAULT_CAP = 500;
// Hard ceiling even for "show all" — a pathological session still renders
// something bounded rather than draining forever.
export const SESSION_TURNS_HARD_CEILING = 5000;
export { SESSION_TURN_WINDOW_AFTER, SESSION_TURN_WINDOW_BEFORE, turnWindow } from "./turn-window";

/** v4 item 6: the `?turn=N` search param as a turn index, or null when absent/malformed. */
export function parseTurnParam(raw: string | string[] | undefined): number | null {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || !/^\d{1,7}$/.test(v)) return null;
  return Number(v);
}

export interface ListRecentUsageRowsOptions {
  since: Date;
  /** Scopes to one project's rows (the detail page); omitted, account-wide (the projects list page). */
  projectId?: string;
  /** Each caller's own select column string — kept exact, not shared, so a caller never fetches a column it doesn't use. */
  select: string;
  /**
   * false (both current callers, G3 step 3D-3): the plain awaited query,
   * still capped at PostgREST's ~1000-row default (defect 3, tracked, not
   * fixed here) — same single unbounded read as before this step, byte for
   * byte. true: drains past that cap via selectAllRows — unused today, for
   * a future caller that needs the true 30-day total beyond 1000 sessions.
   */
  paginate: boolean;
}

/**
 * G3 step 3D-3 — the 30-day code_sessions cost read shared by /code
 * (account-wide 30-day summary strip) and /code/[projectId] ($/model
 * section): same chain order as both inline reads it replaces —
 * .eq("user_id") → [.eq("code_project_id")] →
 * .is("parent_source_session_id", null) → .gte("started_at") →
 * .order("started_at", { ascending: true }) — each caller keeping its own
 * `select` string and its own try/catch around the call.
 */
export async function listRecentUsageRows<Row = Record<string, unknown>>(
  supabase: TypedDb,
  userId: string,
  { since, projectId, select, paginate }: ListRecentUsageRowsOptions,
): Promise<PageResult<Row>> {
  const buildQuery = () => {
    let query = supabase.from("code_sessions").select(select).eq("user_id", userId);
    if (projectId) query = query.eq("code_project_id", projectId);
    return query
      .is("parent_source_session_id", null)
      .gte("started_at", since.toISOString())
      .order("started_at", { ascending: true });
  };

  if (paginate) {
    const rows = await selectAllRows((from, to) => buildQuery().range(from, to) as PromiseLike<PageResult<Row>>);
    return { data: rows, error: null };
  }

  return (await buildQuery()) as PageResult<Row>;
}

/**
 * #93 — one session's raw `props` (usage + models + subAgents), shaped as
 * AgentStatsSessionInput so the session page can call the SAME
 * aggregateAgentStats() used everywhere else (aggregate.ts) with a
 * single-row array and read off `by_model` — a per-model breakdown for this
 * one session INCLUDING its sub-agents, never a second pricing/grouping
 * implementation. Deliberately a separate, minimal query from
 * getCodeSessionDetail (which never selects `props` — that column can carry
 * a lot of sub-agent sidecar JSON we don't want on every session-page load
 * unless the caller actually asks for the cost breakdown).
 */
export async function getCodeSessionUsageRow(
  supabase: TypedDb,
  userId: string,
  sessionId: string,
): Promise<AgentStatsSessionInput | null> {
  const { data, error } = await supabase
    .from("code_sessions")
    .select("id, started_at, turn_count, user_turn_count, props")
    .eq("user_id", userId)
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as AgentStatsSessionInput | null) ?? null;
}

export async function getCodeSessionDetail(
  supabase: TypedDb,
  userId: string,
  sessionId: string,
  loadAll: boolean,
  /** v4 item 6: a deep-linked turn (`?turn=N`) — the activity window is loaded around it, so its anchor exists. */
  aroundTurn: number | null = null,
): Promise<CodeSessionDetail | null> {
  const sessionRes = await supabase
    .from("code_sessions")
    .select(
      "id, code_project_id, title, summary, git_branch, started_at, ended_at, duration_seconds, turn_count, user_turn_count, tool_count, files_touched, source, source_session_id, parent_source_session_id, props, code_projects(display_name, repo_identity)",
    )
    .eq("user_id", userId)
    .eq("id", sessionId)
    .maybeSingle();
  if (sessionRes.error) throw new Error(sessionRes.error.message);
  if (!sessionRes.data) return null;

  // biome-ignore lint/suspicious/noExplicitAny: PostgREST embedded-resource shape isn't in the (stale) generated database types
  const raw = sessionRes.data as any;
  const session: CodeSessionRow = {
    id: raw.id,
    code_project_id: raw.code_project_id,
    title: raw.title,
    summary: raw.summary,
    git_branch: raw.git_branch,
    started_at: raw.started_at,
    ended_at: raw.ended_at,
    duration_seconds: raw.duration_seconds,
    turn_count: raw.turn_count,
    user_turn_count: raw.user_turn_count,
    tool_count: raw.tool_count,
    files_touched: raw.files_touched,
    project_display_name: raw.code_projects?.display_name ?? null,
    project_repo_identity: raw.code_projects?.repo_identity ?? null,
    source: raw.source,
    source_session_id: raw.source_session_id,
    parent_source_session_id: raw.parent_source_session_id ?? null,
    subAgent: parseSubAgentMeta(raw.props ?? null),
  };

  const turnsTotal = session.turn_count;
  let turns: TurnRow[];
  let truncated: boolean;

  if (loadAll) {
    const ceiling = Math.min(turnsTotal, SESSION_TURNS_HARD_CEILING);
    // biome-ignore format: keep the query-chain layout; the cast is type-only (3B-5, props is Json in the schema)
    const rawTurns = await selectBoundedRows<RawTurnRow>(ceiling, (from, to) =>
      supabase
        .from("code_session_turns")
        .select("idx, role, kind, text, tool_name, file_path, ts, props")
        .eq("user_id", userId)
        .eq("session_id", sessionId)
        .order("idx", { ascending: true })
        .range(from, to) as PromiseLike<PageResult<RawTurnRow>>,
    );
    turns = rawTurns.map(shapeTurnRow);
    truncated = turnsTotal > SESSION_TURNS_HARD_CEILING;
  } else if (aroundTurn !== null) {
    // A deep link renders a bounded window around N first — every turn in it
    // (prose and activity), keyset-paged so no response cap can cut it. The
    // upper side is NOT clamped by `turn_count` (review r2 S6: it can lag the
    // stored turns); one extra row says whether later turns exist.
    const win = turnWindow(aroundTurn);
    // biome-ignore format: keep the query-chain layout; the cast is type-only (3B-5, props is Json in the schema)
    const rawTurns = await selectBoundedRows<RawTurnRow>(win.to - win.from + 2, (from, to) =>
      supabase
        .from("code_session_turns")
        .select("idx, role, kind, text, tool_name, file_path, ts, props")
        .eq("user_id", userId)
        .eq("session_id", sessionId)
        .gte("idx", win.from)
        .lte("idx", win.to + 1)
        .order("idx", { ascending: true })
        .range(from, to) as PromiseLike<PageResult<RawTurnRow>>,
    );
    const hasLater = rawTurns.some((t) => t.idx > win.to);
    turns = rawTurns.filter((t) => t.idx <= win.to).map(shapeTurnRow);
    truncated = win.from > 0 || hasLater;
    const lastIdx = turns.length > 0 ? turns[turns.length - 1].idx : win.from;
    return {
      session,
      turns,
      turnsTotal: Math.max(turnsTotal, lastIdx + 1),
      truncated,
      window: { from: win.from, to: hasLater ? win.to : lastIdx, hasLater },
      subAgentSpawnIndex: parseSubAgentSpawnIndex(raw.props ?? null),
    };
  } else {
    // The user spine is the narrative (ADR 0021 Q6) — it must NEVER be
    // truncated away. Load every user-prose turn unconditionally (they are
    // few even in huge sessions), then fill the remaining budget with the
    // earliest activity turns; only the activity is capped.
    const proseRes = await supabase
      .from("code_session_turns")
      .select("idx, role, kind, text, tool_name, file_path, ts, props")
      .eq("user_id", userId)
      .eq("session_id", sessionId)
      .eq("role", "user")
      .eq("kind", "prose")
      .order("idx", { ascending: true })
      .range(0, SESSION_TURNS_DEFAULT_CAP - 1);
    if (proseRes.error) throw new Error(proseRes.error.message);
    const prose = ((proseRes.data ?? []) as RawTurnRow[]).map(shapeTurnRow);

    const activityBudget = Math.max(SESSION_TURNS_DEFAULT_CAP - prose.length, 0);
    // biome-ignore format: keep the query-chain layout; the cast is type-only (3B-5, props is Json in the schema)
    const activity =
      activityBudget > 0
        ? (
            await selectBoundedRows<RawTurnRow>(activityBudget, (from, to) =>
              supabase
                .from("code_session_turns")
                .select("idx, role, kind, text, tool_name, file_path, ts, props")
                .eq("user_id", userId)
                .eq("session_id", sessionId)
                .or("role.neq.user,kind.neq.prose")
                .order("idx", { ascending: true })
                .range(from, to) as PromiseLike<PageResult<RawTurnRow>>,
            )
          ).map(shapeTurnRow)
        : [];

    turns = [...prose, ...activity].sort((a, b) => a.idx - b.idx);
    truncated = turnsTotal > turns.length;
  }

  return { session, turns, turnsTotal, truncated, subAgentSpawnIndex: parseSubAgentSpawnIndex(raw.props ?? null) };
}

/**
 * Every tool_use turn's idx + toolUseId for one session — idx and one jsonb
 * field per row, no text — so sub-agent matching is session-wide even when
 * the page renders only the first SESSION_TURNS_DEFAULT_CAP turns.
 */
export async function getSessionToolUseIndex(
  supabase: TypedDb,
  userId: string,
  sessionId: string,
): Promise<ToolUseTurnRef[]> {
  const rows = await selectBoundedRows<{ idx: number; tool_use_id?: unknown; props?: Record<string, unknown> | null }>(
    SESSION_TURNS_HARD_CEILING,
    (from, to) =>
      supabase
        .from("code_session_turns")
        .select("idx, tool_use_id:props->>toolUseId")
        .eq("user_id", userId)
        .eq("session_id", sessionId)
        .eq("kind", "tool_use")
        .order("idx", { ascending: true })
        .range(from, to),
  );
  const out: ToolUseTurnRef[] = [];
  for (const row of rows) {
    const id = row.tool_use_id ?? row.props?.toolUseId;
    if (typeof id === "string" && id) out.push({ idx: row.idx, toolUseId: id });
  }
  return out;
}

// ---- Recent sessions + outcome link (#93 — usage visibility that reconciles) ----
//
// A compact "what did each recent session touch" row for /code/stats:
// branch + whatever the existing per-issue attribution (lib/agent-stats/
// attribution.ts) could resolve from that session's own commits. NOT a new
// attribution mechanism — this reuses parseCommitEvents/groupCommitEventsBySession
// verbatim; getSessionTurnsForOutcomes below just fetches the turns those
// pure functions need, scoped to a bounded recent-session batch (unlike
// /api/agent-stats/issues, which drains the user's FULL turn history).

export interface RecentSessionForStatsRow {
  id: string;
  started_at: string | null;
  git_branch: string | null;
  code_project_id: string;
  project_display_name: string | null;
  project_repo_identity: string | null;
}

/** Split out for the same reason as shapeRecentCodeSessionRow above — the
 * PostgREST embedded-resource shape isn't in the (stale) generated DB types. */
// biome-ignore lint/suspicious/noExplicitAny: PostgREST embedded-resource shape isn't in the (stale) generated database types
export function shapeRecentSessionForStatsRow(raw: any): RecentSessionForStatsRow {
  return {
    id: raw.id,
    started_at: raw.started_at ?? null,
    git_branch: raw.git_branch ?? null,
    code_project_id: raw.code_project_id,
    project_display_name: raw.code_projects?.display_name ?? null,
    project_repo_identity: raw.code_projects?.repo_identity ?? null,
  };
}

export async function getRecentSessionsForStats(
  supabase: TypedDb,
  userId: string,
  sinceIso: string,
  limit: number,
): Promise<RecentSessionForStatsRow[]> {
  const { data, error } = await supabase
    .from("code_sessions")
    .select("id, started_at, git_branch, code_project_id, code_projects(display_name, repo_identity)")
    .eq("user_id", userId)
    .is("parent_source_session_id", null)
    .gte("started_at", sinceIso)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  // biome-ignore lint/suspicious/noExplicitAny: PostgREST embedded-resource shape isn't in the (stale) generated database types
  return ((data ?? []) as any[]).map(shapeRecentSessionForStatsRow);
}

const OUTCOME_TURN_PAGE_SIZE = 1000;

/**
 * Fetch every turn for a BOUNDED set of session ids (unlike
 * /api/agent-stats/issues' fetchAllTurns, which drains the user's entire
 * history) — the caller hands this the ids of the recent-session batch
 * getRecentSessionsForStats just returned, so this stays cheap even though
 * it pages the same way (a single Supabase response caps at 1000 rows).
 */
export async function getSessionTurnsForOutcomes(
  supabase: TypedDb,
  userId: string,
  sessionIds: string[],
): Promise<AttributionTurnInput[]> {
  if (sessionIds.length === 0) return [];
  const all: AttributionTurnInput[] = [];
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from("code_session_turns")
      .select("session_id, idx, role, kind, text, tool_name, ts, props")
      .eq("user_id", userId)
      .in("session_id", sessionIds)
      .order("id", { ascending: true })
      .range(from, from + OUTCOME_TURN_PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    if (!data || data.length === 0) break;
    all.push(...(data as AttributionTurnInput[]));
    if (data.length < OUTCOME_TURN_PAGE_SIZE) break;
    from += OUTCOME_TURN_PAGE_SIZE;
  }
  return all;
}

// ---- Route/loader reads lifted out of app/** (G3 step 3B-3) ---------------
//
// Each chain below moved verbatim from the route or loader named in its doc
// comment — same select string, same filters in the same order. Whether a
// failure throws or comes back as `{ error }` is exactly what the call site
// did before, so its own error handling (500 vs empty fallback) is unchanged.

/** Aggregate-count result shape of a `{ count: "exact", head: true }` select. */
export type CountResult = { count: number | null; error: { message: string } | null };

/** /api/agent-stats: every top-level session since `prevSinceIso` (all when
 * undefined), optionally narrowed to one project. Keyset-paged; throws. */
export async function listSessionsForAgentStats(
  supabase: TypedDb,
  userId: string,
  projectId: string | null,
  prevSinceIso: string | undefined,
): Promise<AgentStatsSessionInput[]> {
  return selectAllSessionsByKeyset<AgentStatsSessionInput>(() => {
    let query = supabase
      .from("code_sessions")
      .select("id, started_at, turn_count, user_turn_count, props")
      .eq("user_id", userId)
      // Sub-agent sessions (migration 089) are already counted through the
      // parent's props.subAgents usage — never twice.
      .is("parent_source_session_id", null);
    if (projectId) query = query.eq("code_project_id", projectId);
    if (prevSinceIso) query = query.gte("started_at", prevSinceIso);
    return query;
  });
}

/** /api/agent-stats: count of the user's top-level sessions ever (optionally
 * one project). Returns `{ count, error }` — the route answers 500 itself. */
export async function countSessionsEverForAgentStats(
  supabase: TypedDb,
  userId: string,
  projectId: string | null,
): Promise<CountResult> {
  let everCountQuery = supabase
    .from("code_sessions")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .is("parent_source_session_id", null);
  if (projectId) everCountQuery = everCountQuery.eq("code_project_id", projectId);
  return await everCountQuery;
}

/** /api/agent-stats/issues: every turn the user has (keyset by id); throws. */
export async function listAllTurnsForAttribution(
  supabase: TypedDb,
  userId: string,
): Promise<Array<AttributionTurnInput & { id: string }>> {
  return selectAllByIdKeyset<AttributionTurnInput & { id: string }>(() =>
    supabase
      .from("code_session_turns")
      .select("id, session_id, idx, role, kind, text, tool_name, ts, props")
      .eq("user_id", userId),
  );
}

/** /api/agent-stats/issues: every code_session_issues row (keyset by id); throws. */
export async function listAllSessionIssuesForAttribution(
  supabase: TypedDb,
  userId: string,
): Promise<Array<SessionIssueRow & { id: string }>> {
  return selectAllByIdKeyset<SessionIssueRow & { id: string }>(() =>
    supabase
      .from("code_session_issues")
      .select(
        "id, session_id, ref, number, kind, role, review_verb, build_verb, tier, turn_share, related_to, turn_idx, evidence_quote",
      )
      .eq("user_id", userId),
  );
}

/** /api/agent-stats/issues: every session (sub-agents included) with its
 * project's repo identity; keyset on (started_at, id); throws. `Row` is the
 * caller's row type — the embedded-resource shape isn't in the DB types. */
export async function listSessionsForIssueAttribution<Row extends { id: string; started_at: string | null }>(
  supabase: TypedDb,
  userId: string,
): Promise<Row[]> {
  return selectAllSessionsByKeyset<Row>(() =>
    supabase
      .from("code_sessions")
      .select(
        "id, started_at, turn_count, user_turn_count, props, parent_source_session_id, source, source_session_id, code_projects(repo_identity)",
      )
      .eq("user_id", userId),
  );
}

export interface CodeSessionSignalRow {
  source: string | null;
  started_at: string | null;
  code_project_id: string | null;
}

/**
 * /api/sync-state: bounded page-drain of (source, started_at, code_project_id)
 * — everything needed to group by harness client-side. Capped at `ceiling`
 * rows rather than draining unboundedly. Throws on a failed page.
 */
export async function listCodeSessionSignalRows(
  supabase: TypedDb,
  userId: string,
  ceiling: number,
): Promise<CodeSessionSignalRow[]> {
  const out: CodeSessionSignalRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; offset < ceiling; offset += pageSize) {
    const to = Math.min(offset + pageSize - 1, ceiling - 1);
    const { data, error } = await supabase
      .from("code_sessions")
      .select("source, started_at, code_project_id")
      .eq("user_id", userId)
      .is("parent_source_session_id", null)
      .order("id")
      .range(offset, to);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as CodeSessionSignalRow[];
    out.push(...rows);
    if (rows.length < to - offset + 1) break;
  }
  return out;
}

/** /code/stats: top-level sessions started at or after `sinceIso`; keyset-paged; throws. */
export async function listSessionsForStatsWindow(
  supabase: TypedDb,
  userId: string,
  sinceIso: string,
): Promise<AgentStatsSessionInput[]> {
  return selectAllSessionsByKeyset<AgentStatsSessionInput>(() =>
    supabase
      .from("code_sessions")
      .select("id, started_at, turn_count, user_turn_count, props")
      .eq("user_id", userId)
      .is("parent_source_session_id", null)
      .gte("started_at", sinceIso),
  );
}

/** /code/stats: top-level sessions in [`fromIso`, `untilIso`); keyset-paged; throws. */
export async function listSessionsForStatsPriorWindow(
  supabase: TypedDb,
  userId: string,
  fromIso: string,
  untilIso: string,
): Promise<AgentStatsSessionInput[]> {
  return selectAllSessionsByKeyset<AgentStatsSessionInput>(() =>
    supabase
      .from("code_sessions")
      .select("id, started_at, turn_count, user_turn_count, props")
      .eq("user_id", userId)
      .is("parent_source_session_id", null)
      .gte("started_at", fromIso)
      .lt("started_at", untilIso),
  );
}

/** /code/stats: the issues each of `sessionIds` worked on (keyset by id); throws. */
export async function listSessionIssuesForSessions(
  supabase: TypedDb,
  userId: string,
  sessionIds: string[],
): Promise<Array<SessionIssueRow & { id: string }>> {
  return selectAllByIdKeyset<SessionIssueRow & { id: string }>(() =>
    supabase
      .from("code_session_issues")
      .select("id, session_id, ref, number, kind, role")
      .eq("user_id", userId)
      .in("session_id", sessionIds),
  );
}

/** /api/code-sessions/stats: top-level sessions since `sinceIso`, oldest
 * first. Returns `{ data, error }` — the route answers 500 itself. */
export async function listSessionsForUsageReconcile(
  supabase: TypedDb,
  userId: string,
  sinceIso: string,
): Promise<PageResult<unknown>> {
  return await supabase
    .from("code_sessions")
    .select("id, started_at, turn_count, user_turn_count, props")
    .eq("user_id", userId)
    // Sub-agent sessions (migration 089): their usage is already in the
    // parent's props.subAgents — counting them again would double the cost.
    .is("parent_source_session_id", null)
    .gte("started_at", sinceIso)
    .order("started_at", { ascending: true });
}

/** /api/code-sessions/known: the stored digest columns for one chunk of
 * source_session_ids. Returns `{ data, error }` — the route answers 500 itself. */
export async function getKnownSessionDigests(
  supabase: TypedDb,
  userId: string,
  sourceSessionIds: string[],
): Promise<PageResult<unknown>> {
  return await supabase
    .from("code_sessions")
    .select(
      "source, source_session_id, turn_count, ended_at, content_hash, actions_version:props->actions_version, open_upload:props->open_upload",
    )
    .eq("user_id", userId)
    .in("source_session_id", sourceSessionIds);
}

/** POST /api/code-sessions: code_sessions ids for one source's
 * source_session_ids (the parents a child import names); throws. */
export async function listSessionIdsBySourceSessionIds(
  supabase: TypedDb,
  userId: string,
  source: string,
  sourceSessionIds: string[],
): Promise<string[]> {
  const { data, error } = await supabase
    .from("code_sessions")
    .select("id")
    .eq("user_id", userId)
    .eq("source", source)
    .in("source_session_id", sourceSessionIds);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
}

export interface CodeProjectScopeRow {
  id: string;
  display_name: string | null;
  repo_identity: string;
}

/** /settings: code projects for the API-key scope picker (ADR 0021 Q7), most
 * recently active first. No user_id filter — the caller passes an RLS-scoped
 * client, which does the isolation. Returns the raw `{ data, error }` — the
 * settings loader reads `data` only. */
export async function listCodeProjectsForScopePicker(
  supabase: TypedDb,
): Promise<{ data: CodeProjectScopeRow[] | null; error: { message: string } | null }> {
  return await supabase
    .from("code_projects")
    .select("id, display_name, repo_identity")
    .order("last_active_at", { ascending: false });
}

/** /code/session/[sessionId]: the one session's code_session_issues rows (G3
 * step 3B-6b, moved verbatim from the page loader). Returns the raw
 * `{ data, error }`; the loader throws on error and casts the rows. */
export async function listSessionIssuesForSessionPage(
  supabase: TypedDb,
  userId: string,
  sessionId: string,
): Promise<{ data: unknown[] | null; error: PostgrestError | null }> {
  const { data, error } = await supabase
    .from("code_session_issues")
    .select(
      "session_id, ref, number, kind, role, evidence_quote, turn_idx, review_verb, build_verb, tier, turn_share, related_to",
    )
    .eq("user_id", userId)
    .eq("session_id", sessionId);
  return { data, error };
}
