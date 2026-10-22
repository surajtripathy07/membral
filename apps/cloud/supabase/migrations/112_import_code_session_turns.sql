-- ============================================================
-- 112_import_code_session_turns.sql
-- Issue #175 (design: docs/design/import-turns-transaction.md).
-- The importer replaced a session's turns with one PostgREST delete and then
-- one insert per 500 turns, each its own transaction: a failed insert left the
-- session with no turns or only the first chunks. This function does the
-- delete and the insert in one call, so PostgREST runs them in one
-- transaction and a failure keeps the previous turns.
--   1. lock the session row (ownership check; concurrent re-imports of one
--      session take turns instead of racing on unique (session_id, idx))
--   2. p_turns must be a jsonb array
--   3. delete this session's turns
--   4. insert p_turns; user_id/session_id come only from the arguments
--   5. return the number of rows inserted
-- No exception block: every error propagates and rolls the whole call back.
-- Security follows 016/048: SECURITY INVOKER, explicit p_user_id checked in
-- the body, revoked from public/anon/authenticated, service_role only.
-- Idempotent (create or replace). No data changes. Depends on: 029, 031.
--
-- REVERTING: drop function public.import_code_session_turns(uuid, uuid, jsonb);
-- the importer then fails loudly (rpc error) and keeps the old turns.
-- ============================================================

create or replace function public.import_code_session_turns(
  p_user_id uuid,
  p_session_id uuid,
  p_turns jsonb
)
returns integer
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  perform 1
     from public.code_sessions
    where id = p_session_id
      and user_id = p_user_id
      for update;
  if not found then
    raise exception 'import_code_session_turns: session % not found for user %', p_session_id, p_user_id;
  end if;

  if p_turns is null or jsonb_typeof(p_turns) <> 'array' then
    raise exception 'import_code_session_turns: p_turns must be a jsonb array';
  end if;

  delete from public.code_session_turns
   where session_id = p_session_id
     and user_id = p_user_id;

  insert into public.code_session_turns (user_id, session_id, idx, role, kind, text, tool_name, file_path, ts, props)
  select p_user_id, p_session_id, r.idx, r.role, r.kind, r.text, r.tool_name, r.file_path, r.ts,
         coalesce(r.props, '{}'::jsonb)
    from jsonb_to_recordset(p_turns) as r(
      idx int, role text, kind text, text text, tool_name text, file_path text, ts timestamptz, props jsonb
    );

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.import_code_session_turns(uuid, uuid, jsonb) from public;
revoke all on function public.import_code_session_turns(uuid, uuid, jsonb) from anon;
revoke all on function public.import_code_session_turns(uuid, uuid, jsonb) from authenticated;
grant execute on function public.import_code_session_turns(uuid, uuid, jsonb) to service_role;
