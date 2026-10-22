// Code-dimension MCP tool logic (ADR 0021 Q7/Q8, P1e) — the code-session
// counterpart of graph-tools.ts. Backs the code tools registered in server.ts,
// reading the public.code_* tables through the migration-030 read RPCs
// (SECURITY INVOKER, service_role-only — see that migration's header). Every
// function takes a SupabaseClient (dependency-injected) and the server-verified
// userId — never a client-supplied one — plus the per-key code-project bound
// `codeScopeId`.
//
// SCOPING (mirrors graph-tools.ts): `codeScopeId` is the key's MANDATORY outer
// bound, injected by the /api/mcp route straight from the validated key —
// NEVER from a request body. null = unscoped (an unscoped key, or a JWT
// dashboard session): all of the user's code projects. Non-null = bound to
// exactly that one code_projects.id. Enforcement is PURE SQL inside the RPCs
// (fail-closed on a stale id), so a client-supplied project/session id can only
// ever resolve WITHIN the bound, never escape it.

import { getFirstUserMessages } from "@/lib/code-sessions/queries";
import { sessionDisplayTitle } from "@/lib/code-sessions/view";
import type { Db } from "@/lib/db/types";

export interface CodeProjectSummary {
  id: string;
  repo_identity: string;
  display_name: string | null;
  source: string | null;
  summary: string | null;
  session_count: number;
  last_active_at: string | null;
}

export interface CodeSessionSummary {
  id: string;
  title: string | null;
  summary: string | null;
  git_branch: string | null;
  model?: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds?: number | null;
  turn_count?: number;
  user_turn_count?: number;
  tool_count?: number;
  files_touched: string[] | null;
}

export interface CodeProjectDetail {
  id: string;
  repo_identity: string;
  display_name: string | null;
  repo_path: string | null;
  remote_url: string | null;
  source: string | null;
  summary: string | null;
  rollup: unknown;
  session_count: number;
  last_active_at: string | null;
  sessions: CodeSessionSummary[];
}

export interface CodeSessionTurn {
  idx: number;
  role: string;
  kind: string;
  text: string | null;
  tool_name: string | null;
  file_path: string | null;
  ts: string | null;
}

export interface CodeSessionDetail {
  id: string;
  code_project_id: string;
  source: string;
  cwd: string | null;
  git_branch: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  turn_count: number;
  user_turn_count: number;
  tool_count: number;
  files_touched: string[] | null;
  title: string | null;
  summary: string | null;
  turns: CodeSessionTurn[];
  /** Migration 096: code_sessions.id of the parent when this session is a sub-agent, else null. */
  parent_session_id: string | null;
  /** Migration 096: child (sub-agent) sessions, oldest first, at most 200. */
  sub_agents: CodeSubAgent[];
  /** Migration 096: count of all child sessions (can exceed sub_agents.length). */
  sub_agents_total: number;
}

export interface CodeSubAgent {
  /** code_sessions.id — open with get_code_session. */
  id: string;
  agent_type: string | null;
  description: string | null;
  started_at: string | null;
  ended_at: string | null;
  turn_count: number | null;
  /** First user prose turn (the brief the parent gave it), cut to 160 chars. */
  brief: string | null;
}

export interface CodeContextResult {
  query: string;
  project_count: number;
  projects: {
    id: string;
    repo_identity: string;
    display_name: string | null;
    summary: string | null;
    rollup: unknown;
  }[];
  sessions: (CodeSessionSummary & { code_project_id: string })[];
  turns: (CodeSessionTurn & { session_id: string; code_project_id: string })[];
}

// ---------------- list_code_projects ----------------

export async function listCodeProjects(
  supabase: Db,
  userId: string,
  codeScopeId: string | null = null,
): Promise<CodeProjectSummary[]> {
  const { data, error } = await supabase.rpc("code_projects_list", {
    p_user_id: userId,
    p_scope_code_project_id: codeScopeId,
  });
  if (error) throw new Error(`code_projects_list failed: ${error.message}`);
  return (data ?? []) as CodeProjectSummary[];
}

// ---------------- get_code_project ----------------

/**
 * One CodeProject by id under the key's bound. Returns null when the project
 * does not exist, is not the user's, OR (when scoped) is not the bound project
 * — the tool layer turns null into a plain "not found", so an out-of-scope
 * project is INVISIBLE (404-equivalent, no existence leak). The id NEVER
 * escapes the bound: scoping is a SQL predicate in code_project_detail.
 */
export async function getCodeProject(
  supabase: Db,
  userId: string,
  projectId: string,
  codeScopeId: string | null = null,
): Promise<CodeProjectDetail | null> {
  const { data, error } = await supabase.rpc("code_project_detail", {
    p_user_id: userId,
    p_project_id: projectId,
    p_scope_code_project_id: codeScopeId,
  });
  if (error) throw new Error(`code_project_detail failed: ${error.message}`);
  const detail = (data ?? null) as CodeProjectDetail | null;
  if (detail) await fillSessionTitleFallbacks(supabase, userId, detail.sessions);
  return detail;
}

/**
 * D (2026-09-25) "no more Untitled session": patches `title` in place for
 * every session that has neither a title nor a summary, using its first real
 * user message (getFirstUserMessages — one batched query for only the rows
 * that need it; every other row is untouched). sessionDisplayTitle is still
 * the single fallback chain (title -> summary -> first message -> "Untitled
 * session"), so a session with no user prose turn at all still ends up with
 * that neutral placeholder rather than a raw `null`.
 */
async function fillSessionTitleFallbacks(supabase: Db, userId: string, sessions: CodeSessionSummary[]): Promise<void> {
  const needFallback = sessions.filter((s) => !s.title?.trim() && !s.summary?.trim()).map((s) => s.id);
  const firstMessages = needFallback.length > 0 ? await getFirstUserMessages(supabase, userId, needFallback) : null;
  for (const s of sessions) {
    s.title = sessionDisplayTitle({ title: s.title, summary: s.summary, firstUserMessage: firstMessages?.get(s.id) });
  }
}

// ---------------- get_code_session ----------------

/**
 * One session (with its user spine) by id under the key's bound. Returns null
 * when the session does not exist, is not the user's, OR (when scoped) does not
 * belong to the bound project — this is the load-bearing cross-project guard
 * that stops a scoped key pulling a sibling project's session by guessing its
 * id. Out-of-scope is INVISIBLE (404-equivalent, no existence leak).
 */
export async function getCodeSession(
  supabase: Db,
  userId: string,
  sessionId: string,
  codeScopeId: string | null = null,
): Promise<CodeSessionDetail | null> {
  const { data, error } = await supabase.rpc("code_session_detail", {
    p_user_id: userId,
    p_session_id: sessionId,
    p_scope_code_project_id: codeScopeId,
  });
  if (error) throw new Error(`code_session_detail failed: ${error.message}`);
  const detail = (data ?? null) as CodeSessionDetail | null;
  // D (2026-09-25): the RPC already returns every turn, so the first real
  // user prose turn (role/kind filter — see view.ts's sessionDisplayTitle doc
  // comment on why that's already harness-injected-free) is right here, no
  // extra query needed (unlike fillSessionTitleFallbacks above, which has no
  // turns to read from).
  if (detail) {
    const firstProse = detail.turns.find((t) => t.role === "user" && t.kind === "prose")?.text;
    detail.title = sessionDisplayTitle({ title: detail.title, summary: detail.summary, firstUserMessage: firstProse });
  }
  return detail;
}

// ---------------- get_code_context_for ----------------

export async function getCodeContextFor(
  supabase: Db,
  userId: string,
  query: string,
  codeScopeId: string | null = null,
): Promise<CodeContextResult> {
  const { data, error } = await supabase.rpc("code_context_for", {
    p_user_id: userId,
    p_query: query,
    p_scope_code_project_id: codeScopeId,
  });
  if (error) throw new Error(`code_context_for failed: ${error.message}`);
  return (data ?? { query, project_count: 0, projects: [], sessions: [], turns: [] }) as CodeContextResult;
}
