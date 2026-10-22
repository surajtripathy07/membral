-- ============================================================
-- 100_memory_backfill_max_age.sql
-- Maintainer decision 2026-09-25: besides the "latest N top-level sessions"
-- backfill window (090), sessions older than a max age (default 30 days,
-- MEMBRAL_MEMORY_BACKFILL_MAX_AGE_DAYS in the app) are not extracted.
-- Depends on: 090 (memory_extraction_claim with the parent window)
-- ============================================================
--
-- CHANGE: memory_extraction_claim takes p_max_age_days integer default null.
--   - null or <= 0: no age bound (an app build that predates this migration
--     calls with four named args and behaves exactly as under 090).
--   - otherwise: the parent window keeps only top-level sessions whose
--     coalesce(ended_at, started_at, created_at) > now() - p_max_age_days
--     days, THEN applies the count limit; children still follow parents.
--     Clamped to 36500 days so a "disable" value never overflows timestamps.
-- A pending row pushed out is marked not_queued with last_reason
-- 'older_than_max_age' when age is the reason (the session, or the parent a
-- child follows, is past the cutoff); otherwise 'outside_backfill_window'.
--
-- The 4-arg signature is dropped explicitly: keeping it beside a 5-arg one
-- with a default makes a 4-arg call ambiguous. SECURITY INVOKER, search_path
-- and grants as 088/090.

drop function if exists public.memory_extraction_claim(uuid, integer, integer, integer);

create or replace function public.memory_extraction_claim(
  p_user uuid,
  p_lease_seconds integer,
  p_backfill_limit integer,
  p_max_attempts integer,
  p_max_age_days integer default null
) returns table (session_id uuid, lease_token uuid, attempts integer)
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  v_cutoff timestamptz;
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

  -- 100: null cutoff = no age bound.
  if p_max_age_days is not null and p_max_age_days > 0 then
    v_cutoff := now() - make_interval(days => least(p_max_age_days, 36500));
  end if;

  -- 090: rank parents only, then pull in their children. 100: age first.
  with parent_window as (
    select cs.id, cs.source, cs.source_session_id
      from public.code_sessions cs
     where cs.user_id = p_user
       and cs.parent_source_session_id is null
       and (v_cutoff is null or coalesce(cs.ended_at, cs.started_at, cs.created_at) > v_cutoff)
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
  ),
  aged_ids as (
    -- Sessions past the cutoff, plus children whose parent is past it.
    select cs.id
      from public.code_sessions cs
      left join public.code_sessions parent
        on parent.user_id = cs.user_id
       and parent.source = cs.source
       and parent.source_session_id = cs.parent_source_session_id
     where v_cutoff is not null
       and cs.user_id = p_user
       and (coalesce(cs.ended_at, cs.started_at, cs.created_at) <= v_cutoff
            or coalesce(parent.ended_at, parent.started_at, parent.created_at) <= v_cutoff)
  )
  update public.memory_extraction_queue q
     set status = 'not_queued',
         last_reason = case when q.session_id in (select id from aged_ids)
                            then 'older_than_max_age'
                            else 'outside_backfill_window' end,
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

revoke all on function public.memory_extraction_claim(uuid, integer, integer, integer, integer) from public;
revoke all on function public.memory_extraction_claim(uuid, integer, integer, integer, integer) from anon;
revoke all on function public.memory_extraction_claim(uuid, integer, integer, integer, integer) from authenticated;
grant execute on function public.memory_extraction_claim(uuid, integer, integer, integer, integer) to service_role;

-- The signature changed: PostgREST must see the 5-arg function.
notify pgrst, 'reload schema';
