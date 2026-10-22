-- ============================================================
-- 088_memory_queue_dirty_requeue.sql
-- Memory extraction queue: a re-upload during a run never resets the running
-- row (P10 re-review N1). Enqueue and finish become RPCs so the "is it
-- running?" decision and the write are one statement.
-- Depends on: 087 (memory_extraction_queue, memory_extraction_claim)
-- ============================================================
--
-- WHY (N1): 087's enqueue was a plain upsert that reset a 'running' row to
-- 'pending' and cleared its lease. The claim's "no live lease for this user"
-- check then found nothing, a second run started for the same user, found
-- tail capture's per-session props lock still held, and the row was marked
-- 'done' — the re-uploaded tail was never extracted.
--
-- NOW:
--   enqueue on a 'running' row  -> sets dirty = true, lease untouched
--   finish on a dirty row       -> back to 'pending' (attempts 0, dirty
--                                  cleared, last_reason 'requeued_during_run')
--   claim                        -> an expired 'running' row that is dirty is
--                                  reset to 'pending' (attempts 0) before the
--                                  max-attempts sweep; every claim clears dirty
--
-- LOCKING: enqueue takes the SAME per-user advisory lock as the claim, so the
-- multi-row upsert and the claim's bulk updates never interleave (review
-- N-m4's deadlock note). Session ids are sorted before the insert.
--
-- SECURITY: SECURITY INVOKER, search_path pinned, execute revoked from
-- public/anon/authenticated and granted to service_role only (as 087).

alter table public.memory_extraction_queue
  add column if not exists dirty boolean not null default false;

-- memory_extraction_enqueue(p_user, p_requeue, p_ensure) -> rows now waiting
--   p_requeue: sessions whose content changed (imported this batch). A new or
--              finished row becomes 'pending' (attempts 0); a 'running' row
--              is only marked dirty.
--   p_ensure:  sessions the upload skipped (unchanged content). Queued only
--              when they have NO row yet — a batch whose enqueue failed and
--              was retried by the CLI (N-m4) re-posts them as unchanged.
create or replace function public.memory_extraction_enqueue(
  p_user uuid,
  p_requeue uuid[],
  p_ensure uuid[]
) returns integer
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
declare
  n_requeue integer := 0;
  n_ensure integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended('memory_extraction:' || p_user::text, 0));

  if coalesce(array_length(p_requeue, 1), 0) > 0 then
    insert into public.memory_extraction_queue as q
      (session_id, user_id, status, queued_at, lease_until, lease_token, attempts, last_reason, dirty, updated_at)
    select s.id, p_user, 'pending', now(), null, null, 0, null, false, now()
      from (select distinct unnest(p_requeue) as id) s
     order by s.id
    on conflict (session_id) do update
       set status      = case when q.status = 'running' then 'running' else 'pending' end,
           dirty       = (q.status = 'running'),
           attempts    = case when q.status = 'running' then q.attempts else 0 end,
           lease_until = case when q.status = 'running' then q.lease_until else null end,
           lease_token = case when q.status = 'running' then q.lease_token else null end,
           last_reason = case when q.status = 'running' then q.last_reason else null end,
           queued_at   = now(),
           updated_at  = now()
     where q.user_id = p_user;
    get diagnostics n_requeue = row_count;
  end if;

  if coalesce(array_length(p_ensure, 1), 0) > 0 then
    insert into public.memory_extraction_queue
      (session_id, user_id, status, queued_at, attempts, dirty, updated_at)
    select s.id, p_user, 'pending', now(), 0, false, now()
      from (select distinct unnest(p_ensure) as id) s
     order by s.id
    on conflict (session_id) do nothing;
    get diagnostics n_ensure = row_count;
  end if;

  return n_requeue + n_ensure;
end;
$$;

revoke all on function public.memory_extraction_enqueue(uuid, uuid[], uuid[]) from public;
revoke all on function public.memory_extraction_enqueue(uuid, uuid[], uuid[]) from anon;
revoke all on function public.memory_extraction_enqueue(uuid, uuid[], uuid[]) from authenticated;
grant execute on function public.memory_extraction_enqueue(uuid, uuid[], uuid[]) to service_role;

-- memory_extraction_finish(p_session, p_token, p_status, p_reason, p_attempts)
--   -> the status actually written, or null when the lease is no longer ours.
-- A dirty row (re-uploaded mid-run) always goes back to 'pending' with a
-- fresh attempt count, whatever the run's own verdict was. p_attempts null
-- keeps the claim's count; a number overwrites it (a release that does not
-- count the attempt passes attempts - 1).
create or replace function public.memory_extraction_finish(
  p_session uuid,
  p_token uuid,
  p_status text,
  p_reason text,
  p_attempts integer
) returns text
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  update public.memory_extraction_queue q
     set status      = case when q.dirty then 'pending' else p_status end,
         attempts    = case when q.dirty then 0 else greatest(coalesce(p_attempts, q.attempts), 0) end,
         last_reason = case when q.dirty then 'requeued_during_run' else p_reason end,
         dirty       = false,
         lease_until = null,
         lease_token = null,
         updated_at  = now()
   where q.session_id = p_session
     and q.lease_token = p_token
  returning q.status;
$$;

revoke all on function public.memory_extraction_finish(uuid, uuid, text, text, integer) from public;
revoke all on function public.memory_extraction_finish(uuid, uuid, text, text, integer) from anon;
revoke all on function public.memory_extraction_finish(uuid, uuid, text, text, integer) from authenticated;
grant execute on function public.memory_extraction_finish(uuid, uuid, text, text, integer) to service_role;

-- memory_extraction_claim: 087's body plus two dirty-aware steps (marked).
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

  update public.memory_extraction_queue q
     set status = 'not_queued', last_reason = 'outside_backfill_window',
         lease_until = null, lease_token = null, updated_at = now()
   where q.user_id = p_user
     and q.status = 'pending'
     and q.session_id not in (
       select cs.id from public.code_sessions cs
        where cs.user_id = p_user
        order by coalesce(cs.ended_at, cs.started_at, cs.created_at) desc, cs.id
        limit greatest(p_backfill_limit, 0)
     );

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
