-- ============================================================
-- 090_memory_backfill_window_parents.sql
-- The backfill window (memory_extraction_claim's "latest N per user") counted
-- every code_sessions row, so a sub-agent transcript (migration 089,
-- parent_source_session_id set) competed with its own parent for one of the
-- N slots. A chatty run with many sub-agents could push a user's real
-- top-level sessions outside the window, and a child could be marked
-- 'outside_backfill_window' even though its parent (the session whose
-- content it is part of) was inside it.
-- Depends on: 088 (memory_extraction_claim), 089 (parent_source_session_id)
-- ============================================================
--
-- FIX: rank only top-level sessions (parent_source_session_id is null) for
-- the "latest N" cut, then admit a child whenever ITS parent (matched by
-- (user_id, source, source_session_id) <-> (user_id, source,
-- parent_source_session_id), same join key as queries.ts/view.ts) is inside
-- that parent window. A child whose parent fell outside the window, or
-- whose parent no longer exists, follows its parent out.
--
-- Signature, SECURITY INVOKER, search_path and grants unchanged from 088.

create or replace function public.memory_extraction_claim(
  p_user uuid,
  p_lease_seconds integer,
  p_backfill_limit integer,
  p_max_attempts integer
) returns table (session_id uuid, lease_token uuid, attempts integer)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  perform pg_advisory_xact_lock(hashtextextended('memory_extraction:' || p_user::text, 0));

  if exists (
    select 1 from public.memory_extraction_queue q
    where q.user_id = p_user and q.status = 'running' and q.lease_until > now()
  ) then
    return;
  end if;

  -- 088: a killed run whose row was re-uploaded meanwhile starts fresh.
  update public.memory_extraction_queue q
     set status = 'pending', attempts = 0, dirty = false, last_reason = 'requeued_during_run',
         lease_until = null, lease_token = null, updated_at = now()
   where q.user_id = p_user
     and q.status = 'running'
     and q.lease_until <= now()
     and q.dirty;

  -- 090: rank parents only, then pull in their children.
  with parent_window as (
    select cs.id, cs.source, cs.source_session_id
      from public.code_sessions cs
     where cs.user_id = p_user
       and cs.parent_source_session_id is null
     order by coalesce(cs.ended_at, cs.started_at, cs.created_at) desc, cs.id
     limit greatest(p_backfill_limit, 0)
  ),
  window_ids as (
    select id from parent_window
    union
    select child.id
      from public.code_sessions child
      join parent_window pw
        on pw.source = child.source
       and pw.source_session_id = child.parent_source_session_id
     where child.user_id = p_user
  )
  update public.memory_extraction_queue q
     set status = 'not_queued', last_reason = 'outside_backfill_window',
         lease_until = null, lease_token = null, updated_at = now()
   where q.user_id = p_user
     and q.status = 'pending'
     and q.session_id not in (select id from window_ids);

  update public.memory_extraction_queue q
     set status = 'failed', last_reason = 'max_attempts',
         lease_until = null, lease_token = null, updated_at = now()
   where q.user_id = p_user
     and q.attempts >= p_max_attempts
     and (q.status = 'pending' or (q.status = 'running' and q.lease_until <= now()));

  return query
  update public.memory_extraction_queue q
     set status = 'running',
         lease_until = now() + make_interval(secs => greatest(p_lease_seconds, 1)),
         lease_token = gen_random_uuid(),
         attempts = q.attempts + 1,
         dirty = false, -- 088: this run reads the latest transcript
         updated_at = now()
   where q.session_id = (
     select c.session_id
       from public.memory_extraction_queue c
       join public.code_sessions cs on cs.id = c.session_id
      where c.user_id = p_user
        and c.attempts < p_max_attempts
        and (c.status = 'pending' or (c.status = 'running' and c.lease_until <= now()))
      order by coalesce(cs.ended_at, cs.started_at, cs.created_at) desc, c.session_id
      limit 1
      for update of c skip locked
   )
  returning q.session_id, q.lease_token, q.attempts;
end;
$$;

revoke all on function public.memory_extraction_claim(uuid, integer, integer, integer) from public;
revoke all on function public.memory_extraction_claim(uuid, integer, integer, integer) from anon;
revoke all on function public.memory_extraction_claim(uuid, integer, integer, integer) from authenticated;
grant execute on function public.memory_extraction_claim(uuid, integer, integer, integer) to service_role;
