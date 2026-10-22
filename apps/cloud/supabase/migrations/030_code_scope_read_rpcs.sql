-- ============================================================
-- 030_code_scope_read_rpcs.sql
-- Code-dimension read RPCs for token-scoped project sharing
-- (ADR 0021 Q7/Q8, P1e). Extends the #83 area-scope model to the
-- second graph dimension (code sessions, migration 029).
--
-- These are the code-dimension counterparts of migration 024's
-- mcp_* RPCs. Same discipline, applied to code_projects/
-- code_sessions/code_session_turns instead of kg_nodes/kg_edges:
--
--   * security invoker + service_role-ONLY grants. The /api/mcp
--     route calls these through the service client with a
--     server-verified p_user_id; an authenticated end user must
--     never invoke them directly with someone else's id.
--   * FAIL CLOSED on a stale/deleted scope. p_scope_code_project_id
--     lives in profiles.api_key_scope_code_project_id with NO foreign
--     key (migration 029 documents why — every ON DELETE action is
--     wrong: SET NULL silently promotes a scoped key to all-access,
--     CASCADE deletes the profile, RESTRICT lets a scoped key block
--     project deletion). So a stale id must seed an EMPTY set, never
--     everything. Every RPC below realises that with a `scoped` CTE
--     that is non-empty ONLY when the scope is set AND that project
--     still exists for this user; a deleted scope id yields zero rows
--     and the `(p_scope is null or id in scoped)` predicate then
--     rejects every row — the key returns nothing, never the whole
--     corpus.
--
-- SCOPE SEMANTICS (mirrors 024):
--   * p_scope_code_project_id NULL  -> unscoped: the caller (an
--     unscoped key, or a JWT dashboard session) sees ALL of their own
--     code projects. `scoped` is empty, and every predicate is
--     `(NULL is null or ...)` -> true, so the bound vanishes.
--   * p_scope_code_project_id set   -> bound to exactly that one
--     project. A project id / session id belonging to any OTHER
--     project is INVISIBLE (returns null / empty), never 403 — the
--     same 404-equivalent no-existence-leak posture as
--     mcp_scoped_conversation.
--
-- There is deliberately NO recursion here (unlike 024's `contains`
-- walk): a CodeProject has no subtree — the scope is a single project
-- id and the "allowed set" is at most that one row.
-- ============================================================

-- ------------------------------------------------------------
-- code_projects_list(): the CodeProjects the key may see. Scoped ->
-- exactly the one bound project (or EMPTY if that id is stale).
-- Unscoped -> every project the user owns. Ordered most-recent-active
-- first. Returns a jsonb array (never null; empty array when none).
-- ------------------------------------------------------------
create or replace function public.code_projects_list(
  p_user_id uuid,
  p_scope_code_project_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with scoped as (
    select id from public.code_projects
    where user_id = p_user_id
      and p_scope_code_project_id is not null
      and id = p_scope_code_project_id
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id', cp.id,
      'repo_identity', cp.repo_identity,
      'display_name', cp.display_name,
      'source', cp.source,
      'summary', cp.summary,
      'session_count', cp.session_count,
      'last_active_at', cp.last_active_at
    ) order by cp.last_active_at desc nulls last, cp.repo_identity),
    '[]'::jsonb
  )
  from public.code_projects cp
  where cp.user_id = p_user_id
    and (p_scope_code_project_id is null or cp.id in (select id from scoped));
$$;

-- ------------------------------------------------------------
-- code_project_detail(): one CodeProject by id — its rollup
-- (props.rollup: what was built / decisions / recurring files+tools /
-- people / open threads, written by P1c) plus a recent-session
-- timeline. Returns NULL when the project does not exist, is not the
-- caller's, OR (when scoped) is not the bound project — the tool layer
-- turns NULL into a plain "not found", so an out-of-scope project is
-- INVISIBLE (404-equivalent, no existence leak, mirrors
-- mcp_scoped_conversation).
-- ------------------------------------------------------------
create or replace function public.code_project_detail(
  p_user_id uuid,
  p_project_id uuid,
  p_scope_code_project_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with scoped as (
    select id from public.code_projects
    where user_id = p_user_id
      and p_scope_code_project_id is not null
      and id = p_scope_code_project_id
  ),
  proj as (
    select cp.*
    from public.code_projects cp
    where cp.id = p_project_id
      and cp.user_id = p_user_id
      and (p_scope_code_project_id is null or cp.id in (select id from scoped))
  ),
  recent_sessions as (
    select s.id, s.title, s.summary, s.git_branch, s.model, s.started_at, s.ended_at,
           s.duration_seconds, s.turn_count, s.user_turn_count, s.tool_count, s.files_touched
    from public.code_sessions s
    join proj on proj.id = s.code_project_id
    where s.user_id = p_user_id
    order by s.started_at desc nulls last
    limit 50
  )
  select case when not exists (select 1 from proj) then null else (
    select jsonb_build_object(
      'id', p.id,
      'repo_identity', p.repo_identity,
      'display_name', p.display_name,
      'repo_path', p.repo_path,
      'remote_url', p.remote_url,
      'source', p.source,
      'summary', p.summary,
      'rollup', p.props->'rollup',
      'session_count', p.session_count,
      'last_active_at', p.last_active_at,
      'sessions', coalesce((select jsonb_agg(to_jsonb(rs)) from recent_sessions rs), '[]'::jsonb)
    )
    from proj p
  ) end;
$$;

-- ------------------------------------------------------------
-- code_session_detail(): one session by id, with its full USER SPINE
-- (code_session_turns ordered by idx). The session must belong to the
-- caller AND, when scoped, to the bound project — a session id from
-- ANY other project returns NULL (404-equivalent, no existence leak).
-- This is the load-bearing cross-project check: it is what stops a
-- code-project-scoped key from pulling a session out of a sibling
-- project by guessing its id.
-- ------------------------------------------------------------
create or replace function public.code_session_detail(
  p_user_id uuid,
  p_session_id uuid,
  p_scope_code_project_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with scoped as (
    select id from public.code_projects
    where user_id = p_user_id
      and p_scope_code_project_id is not null
      and id = p_scope_code_project_id
  ),
  sess as (
    select s.*
    from public.code_sessions s
    where s.id = p_session_id
      and s.user_id = p_user_id
      and (p_scope_code_project_id is null or s.code_project_id in (select id from scoped))
  ),
  turns as (
    select t.idx, t.role, t.kind, t.text, t.tool_name, t.file_path, t.ts
    from public.code_session_turns t
    join sess on sess.id = t.session_id
    where t.user_id = p_user_id
    order by t.idx asc
  )
  select case when not exists (select 1 from sess) then null else (
    select jsonb_build_object(
      'id', s.id,
      'code_project_id', s.code_project_id,
      'source', s.source,
      'cwd', s.cwd,
      'git_branch', s.git_branch,
      'model', s.model,
      'started_at', s.started_at,
      'ended_at', s.ended_at,
      'duration_seconds', s.duration_seconds,
      'turn_count', s.turn_count,
      'user_turn_count', s.user_turn_count,
      'tool_count', s.tool_count,
      'files_touched', s.files_touched,
      'title', s.title,
      'summary', s.summary,
      'turns', coalesce((select jsonb_agg(to_jsonb(t) order by t.idx) from turns t), '[]'::jsonb)
    )
    from sess s
  ) end;
$$;

-- ------------------------------------------------------------
-- code_context_for(): a compact, query-relevant context block for the
-- code dimension — the in-scope project rollup(s) + recent matching
-- session summaries + matching user-spine turns. Matching is a simple
-- case-insensitive substring (ILIKE), no embeddings this phase (ADR
-- P1e). p_query's ILIKE metacharacters (% _ \) are escaped so it is a
-- literal substring match — this is a nicety, not a security control:
-- even a bare `%` cannot cross the scope bound, because the scope
-- filter is a SEPARATE predicate (`code_project_id in scoped`) applied
-- alongside the text match, never inside it. Scoped -> only the bound
-- project's rows; stale scope -> everything empty (fail closed);
-- unscoped -> across all the user's projects.
-- ------------------------------------------------------------
create or replace function public.code_context_for(
  p_user_id uuid,
  p_query text,
  p_scope_code_project_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with scoped as (
    select id from public.code_projects
    where user_id = p_user_id
      and p_scope_code_project_id is not null
      and id = p_scope_code_project_id
  ),
  params as (
    select ('%' || replace(replace(replace(coalesce(p_query, ''), '\', '\\'), '%', '\%'), '_', '\_') || '%') as pat
  ),
  proj as (
    select cp.id, cp.repo_identity, cp.display_name, cp.summary,
           cp.props->'rollup' as rollup, cp.session_count, cp.last_active_at
    from public.code_projects cp
    where cp.user_id = p_user_id
      and (p_scope_code_project_id is null or cp.id in (select id from scoped))
  ),
  matched_sessions as (
    select s.id, s.code_project_id, s.title, s.summary, s.git_branch,
           s.started_at, s.ended_at, s.files_touched
    from public.code_sessions s
    cross join params
    where s.user_id = p_user_id
      and (p_scope_code_project_id is null or s.code_project_id in (select id from scoped))
      and (s.title ilike params.pat escape '\' or s.summary ilike params.pat escape '\')
    order by s.started_at desc nulls last
    limit 15
  ),
  matched_turns as (
    select t.session_id, s.code_project_id, t.idx, t.role, t.kind, t.text,
           t.tool_name, t.file_path, t.ts
    from public.code_session_turns t
    join public.code_sessions s on s.id = t.session_id and s.user_id = p_user_id
    cross join params
    where t.user_id = p_user_id
      and t.text is not null
      and (p_scope_code_project_id is null or s.code_project_id in (select id from scoped))
      and t.text ilike params.pat escape '\'
    order by t.ts desc nulls last
    limit 30
  )
  select jsonb_build_object(
    'query', p_query,
    'project_count', (select count(*) from proj),
    'projects', coalesce(
      (select jsonb_agg(to_jsonb(p) order by p.last_active_at desc nulls last) from proj p),
      '[]'::jsonb
    ),
    'sessions', coalesce((select jsonb_agg(to_jsonb(m)) from matched_sessions m), '[]'::jsonb),
    'turns', coalesce((select jsonb_agg(to_jsonb(mt)) from matched_turns mt), '[]'::jsonb)
  );
$$;

-- ------------------------------------------------------------
-- Lock down execution: service_role ONLY, exactly like migration 024.
-- These take a trusted p_user_id from a service-role-only caller; an
-- authenticated user must never call them directly with another id.
-- ------------------------------------------------------------
revoke all on function public.code_projects_list(uuid, uuid) from public;
revoke all on function public.code_projects_list(uuid, uuid) from anon;
revoke all on function public.code_projects_list(uuid, uuid) from authenticated;
grant execute on function public.code_projects_list(uuid, uuid) to service_role;

revoke all on function public.code_project_detail(uuid, uuid, uuid) from public;
revoke all on function public.code_project_detail(uuid, uuid, uuid) from anon;
revoke all on function public.code_project_detail(uuid, uuid, uuid) from authenticated;
grant execute on function public.code_project_detail(uuid, uuid, uuid) to service_role;

revoke all on function public.code_session_detail(uuid, uuid, uuid) from public;
revoke all on function public.code_session_detail(uuid, uuid, uuid) from anon;
revoke all on function public.code_session_detail(uuid, uuid, uuid) from authenticated;
grant execute on function public.code_session_detail(uuid, uuid, uuid) to service_role;

revoke all on function public.code_context_for(uuid, text, uuid) from public;
revoke all on function public.code_context_for(uuid, text, uuid) from anon;
revoke all on function public.code_context_for(uuid, text, uuid) from authenticated;
grant execute on function public.code_context_for(uuid, text, uuid) to service_role;
