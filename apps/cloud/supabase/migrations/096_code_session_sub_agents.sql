-- ============================================================
-- 096_code_session_sub_agents.sql
-- code_session_detail(): adds sub_agents, sub_agents_total and
-- parent_session_id. Depends on: 030 (latest definition, copied here in
-- full; same signature, so create or replace keeps its grants), 089
-- (code_sessions.parent_source_session_id).
-- ============================================================
--
-- WHY: get_code_session showed a session's turns but not the sub-agents it
-- spawned, and a sub-agent session did not point back at its parent, so an
-- agent could not walk between them.
--
-- WHAT CHANGES (new keys only; every 030 key is unchanged):
--   sub_agents         child sessions matched on (user_id, source,
--                      parent_source_session_id = this source_session_id),
--                      the key listChildSessions and 090 use. Each: id (open
--                      with get_code_session), agent_type and description
--                      (props.subAgent), started_at, ended_at, turn_count,
--                      brief (first user prose turn, cut to 160 chars).
--                      Oldest first, at most 200.
--   sub_agents_total   count of all children (can exceed 200).
--   parent_session_id  code_sessions.id of the parent when this session is a
--                      sub-agent, else null.
-- Children and parent are bounded by the same p_scope_code_project_id
-- predicate as the session itself.
-- ============================================================

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
  ),
  -- 096: this session's sub-agent sessions. Same join key as
  -- listChildSessions (lib/code-sessions/queries.ts) and 090:
  -- (user_id, source, parent_source_session_id = this source_session_id).
  -- Same project bound as `sess`, so a scoped key never sees a child
  -- outside its project. Capped at 200, oldest first; the total rides along.
  children as (
    select c.id, c.started_at, c.ended_at, c.turn_count, c.props
    from public.code_sessions c
    join sess on c.source = sess.source and c.parent_source_session_id = sess.source_session_id
    where c.user_id = p_user_id
      and (p_scope_code_project_id is null or c.code_project_id in (select id from scoped))
  ),
  children_capped as (
    select * from children order by started_at asc nulls last, id limit 200
  ),
  -- 096: the parent when this session IS a sub-agent (reverse of the above,
  -- getParentSessionForChild's key), under the same project bound.
  parent as (
    select p.id
    from public.code_sessions p
    join sess on p.source = sess.source and p.source_session_id = sess.parent_source_session_id
    where p.user_id = p_user_id
      and (p_scope_code_project_id is null or p.code_project_id in (select id from scoped))
    limit 1
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
      'turns', coalesce((select jsonb_agg(to_jsonb(t) order by t.idx) from turns t), '[]'::jsonb),
      'parent_session_id', (select id from parent),
      'sub_agents_total', (select count(*) from children),
      'sub_agents', coalesce((
        select jsonb_agg(
          jsonb_build_object(
            'id', c.id,
            'agent_type', c.props->'subAgent'->>'agentType',
            'description', c.props->'subAgent'->>'description',
            'started_at', c.started_at,
            'ended_at', c.ended_at,
            'turn_count', c.turn_count,
            'brief', (
              select case when length(ft.text) > 160 then left(ft.text, 159) || '…' else ft.text end
              from public.code_session_turns ft
              where ft.user_id = p_user_id and ft.session_id = c.id and ft.role = 'user' and ft.kind = 'prose'
              order by ft.idx
              limit 1
            )
          )
          order by c.started_at asc nulls last, c.id
        )
        from children_capped c
      ), '[]'::jsonb)
    )
    from sess s
  ) end;
$$;

-- Grants: same as 030, re-asserted.
revoke all on function public.code_session_detail(uuid, uuid, uuid) from public;
revoke all on function public.code_session_detail(uuid, uuid, uuid) from anon;
revoke all on function public.code_session_detail(uuid, uuid, uuid) from authenticated;
grant execute on function public.code_session_detail(uuid, uuid, uuid) to service_role;
