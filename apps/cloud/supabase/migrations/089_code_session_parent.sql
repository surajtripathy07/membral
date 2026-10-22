-- ============================================================
-- 089_code_session_parent.sql
-- Sub-agent transcripts become their own code sessions, linked to the
-- session that spawned them.
-- Depends on: 029 (code_sessions), 030 (code_project_detail)
-- ============================================================
--
-- WHY: Claude Code writes every sub-agent (Task/Agent tool) transcript to
-- <sessionId>/subagents/agent-<id>.jsonl, and opencode stores sub-agents as
-- child rows (parent_id) in its own database. Until now only a usage summary
-- of each reached code_sessions.props.subAgents, so memory extraction and the
-- session view never saw what a sub-agent actually did. The CLI now uploads
-- each sub-agent as its own session; this column records its parent.
--
-- NO FOREIGN KEY: the value is the parent's SOURCE session id (the same
-- namespace as source_session_id), not a code_sessions.id — a child can be
-- uploaded before its parent (separate POSTs, retries), so upload order must
-- not matter. Join on (user_id, source, source_session_id).
--
-- Lists and counts of sessions (dashboard, stats, MCP project detail) filter
-- `parent_source_session_id is null`; a fetch by id still returns a child.

alter table public.code_sessions
  add column if not exists parent_source_session_id text;

comment on column public.code_sessions.parent_source_session_id is
  'Source session id of the session that spawned this one (a sub-agent transcript); null for a top-level session. Same namespace as source_session_id; no FK so upload order does not matter.';

create index if not exists code_sessions_parent_source_session_idx
  on public.code_sessions (user_id, source, parent_source_session_id)
  where parent_source_session_id is not null;

-- code_project_detail() (030) lists a project's recent sessions for the MCP
-- get_code_project tool — top-level sessions only. Identical to 030 apart
-- from the parent filter; create or replace keeps 030's grants.
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
      and s.parent_source_session_id is null
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
