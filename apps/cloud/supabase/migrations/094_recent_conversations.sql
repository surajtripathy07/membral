-- ============================================================
-- 094_recent_conversations.sql
-- mcp_recent_conversations(): backs the list_recent_conversations MCP tool —
-- the user's recent chats AND main coding sessions, newest first.
-- Depends on: 024 (the LifeArea `contains` scope predicate, copied from
-- mcp_scoped_conversation), 030 (the code-project scope predicate, copied
-- from code_session_detail), 089 (code_sessions.parent_source_session_id).
-- ============================================================
--
-- WHY: an agent asked for "the chat I had yesterday" or "yesterday's coding
-- session" had no tool that lists recent activity; search has no time axis.
--
-- WHAT: one merged list, ordered by activity time desc, then limited.
--   chat rows  conversations, activity = coalesce(updated_at, created_at).
--              Code-lane mirrors (source = 'claude-code') are left out, as
--              search_conversations drops them from its chat hits — the real
--              session shows up as a code row instead.
--   code rows  code_sessions with parent_source_session_id is null (main
--              sessions; sub-agents are reachable from their parent),
--              activity = coalesce(ended_at, started_at, created_at).
-- Metadata only — never messages or turns. summary is cut to 200 chars.
-- p_since null = no lower bound; p_limit clamped to 1..100; p_source keeps
-- rows of either kind whose source equals it.
--
-- SCOPING (mirrors the existing read RPCs exactly):
--   * p_scope_id (area-scoped key): chat rows only where the chat is attached
--     under the LifeArea's `contains` subtree (024's predicate), and NO code
--     rows at all (044's rule: an area has no code-project membership).
--   * p_scope_code_project_id (code-project-scoped key): code rows only from
--     that project (030's predicate, fail-closed on a stale id), and NO chat
--     rows (a code-scoped key never reads the chat side).
--   * p_include_chat / p_include_code: the caller's `kind` filter.
-- ============================================================

create or replace function public.mcp_recent_conversations(
  p_user_id uuid,
  p_since timestamptz default null,
  p_limit int default 30,
  p_source text default null,
  p_scope_id uuid default null,
  p_scope_code_project_id uuid default null,
  p_include_chat boolean default true,
  p_include_code boolean default true
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive allowed(node) as (
    select id from public.kg_nodes
    where user_id = p_user_id and deleted_at is null
      and p_scope_id is not null and id = p_scope_id and type = 'LifeArea'
    union all
    select e.dst_id from public.kg_edges e join allowed a on e.src_id = a.node
    where e.rel_type = 'contains' and e.user_id = p_user_id and e.deleted_at is null
  ) cycle node set is_cycle using path,
  allowed_convs as (
    select distinct e.source_conversation_id as cid
    from public.kg_edges e
    where e.user_id = p_user_id and e.deleted_at is null
      and e.rel_type in ('contributes_to', 'discusses')
      and e.dst_id in (select node from allowed)
      and e.source_conversation_id is not null
  ),
  scoped_project as (
    select id from public.code_projects
    where user_id = p_user_id
      and p_scope_code_project_id is not null
      and id = p_scope_code_project_id
  ),
  chat_rows as (
    select
      coalesce(c.updated_at, c.created_at) as activity,
      c.id,
      jsonb_build_object(
        'type', 'chat',
        'id', c.id,
        'title', c.title,
        'source', c.source,
        'created_at', c.created_at,
        'updated_at', c.updated_at,
        'message_count', case when jsonb_typeof(c.messages) = 'array' then jsonb_array_length(c.messages) else 0 end
      ) as row
    from public.conversations c
    where c.user_id = p_user_id
      and p_include_chat
      and p_scope_code_project_id is null
      and c.source <> 'claude-code'
      and (p_source is null or c.source = p_source)
      and (p_since is null or coalesce(c.updated_at, c.created_at) >= p_since)
      and (p_scope_id is null or c.id in (select cid from allowed_convs))
    order by coalesce(c.updated_at, c.created_at) desc nulls last, c.id
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ),
  code_rows as (
    select
      coalesce(s.ended_at, s.started_at, s.created_at) as activity,
      s.id,
      jsonb_build_object(
        'type', 'code',
        'id', s.id,
        'project_name', coalesce(cp.display_name, cp.repo_identity),
        'git_branch', s.git_branch,
        'source', s.source,
        'started_at', s.started_at,
        'ended_at', s.ended_at,
        'turn_count', s.turn_count,
        'summary', case when length(s.summary) > 200 then left(s.summary, 199) || '…' else s.summary end
      ) as row
    from public.code_sessions s
    join public.code_projects cp on cp.id = s.code_project_id and cp.user_id = p_user_id
    where s.user_id = p_user_id
      and p_include_code
      and p_scope_id is null
      and s.parent_source_session_id is null
      and (p_scope_code_project_id is null or s.code_project_id in (select id from scoped_project))
      and (p_source is null or s.source = p_source)
      and (p_since is null or coalesce(s.ended_at, s.started_at, s.created_at) >= p_since)
    order by coalesce(s.ended_at, s.started_at, s.created_at) desc nulls last, s.id
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ),
  merged as (
    select * from chat_rows
    union all
    select * from code_rows
    order by activity desc nulls last, id
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  )
  select coalesce(jsonb_agg(m.row order by m.activity desc nulls last, m.id), '[]'::jsonb)
  from merged m;
$$;

-- Grants: service_role only, same as every mcp_* RPC (the /api/mcp route
-- calls these with the service client and a server-verified p_user_id).
revoke all on function public.mcp_recent_conversations(uuid, timestamptz, int, text, uuid, uuid, boolean, boolean) from public;
revoke all on function public.mcp_recent_conversations(uuid, timestamptz, int, text, uuid, uuid, boolean, boolean) from anon;
revoke all on function public.mcp_recent_conversations(uuid, timestamptz, int, text, uuid, uuid, boolean, boolean) from authenticated;
grant execute on function public.mcp_recent_conversations(uuid, timestamptz, int, text, uuid, uuid, boolean, boolean) to service_role;
