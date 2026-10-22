-- ============================================================
-- 109_code_session_props_patch.sql
-- Several writers share code_sessions.props: the importer (usage, models,
-- subAgents, …) and memory extraction (memory_extraction,
-- memory_checkpoint_turn_idx, memory_extraction_lock). Each used to write the
-- WHOLE props object back from a snapshot read earlier, so a write that
-- landed in between was lost (observed: a resumed session's props.usage
-- reverted to the previous invocation's after an extraction run finished).
-- This function patches only the named keys in one statement:
--   props = (props - p_remove) || p_set
-- so concurrent writers of different keys never clobber each other.
-- p_expect (optional): the patch applies only when props @> p_expect — a
-- compare-and-delete, e.g. releasing memory_extraction_lock only while it
-- still carries this run's run_id (never another run's lease).
-- A p_set / p_expect that is not a JSON object is a no-op (returns false):
-- `||` with an array or JSON null would turn props into an array.
-- Idempotent (drop-if-exists of the 4-arg form, create or replace). No data changes.
-- Depends on: 029.
--
-- REVERTING: drop function public.code_session_props_patch(uuid, uuid, jsonb, text[], jsonb);
-- the app then fails its props writes loudly (rpc error), never silently.
-- ============================================================

-- An earlier draft had no p_expect; drop that overload so PostgREST never sees two candidates.
drop function if exists public.code_session_props_patch(uuid, uuid, jsonb, text[]);

create or replace function public.code_session_props_patch(
  p_user_id uuid,
  p_session_id uuid,
  p_set jsonb,
  p_remove text[] default '{}',
  p_expect jsonb default null
)
returns boolean
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  with patched as (
    update public.code_sessions s
       set props = (coalesce(s.props, '{}'::jsonb) - coalesce(p_remove, '{}'::text[])) || coalesce(p_set, '{}'::jsonb)
     where s.id = p_session_id
       and s.user_id = p_user_id
       and jsonb_typeof(coalesce(p_set, '{}'::jsonb)) = 'object'
       and (p_expect is null or (jsonb_typeof(p_expect) = 'object' and coalesce(s.props, '{}'::jsonb) @> p_expect))
    returning 1
  )
  select exists (select 1 from patched)
$$;

revoke all on function public.code_session_props_patch(uuid, uuid, jsonb, text[], jsonb) from public;
revoke all on function public.code_session_props_patch(uuid, uuid, jsonb, text[], jsonb) from anon;
grant execute on function public.code_session_props_patch(uuid, uuid, jsonb, text[], jsonb) to authenticated;
grant execute on function public.code_session_props_patch(uuid, uuid, jsonb, text[], jsonb) to service_role;
