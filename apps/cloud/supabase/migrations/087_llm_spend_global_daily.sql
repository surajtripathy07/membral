-- ============================================================
-- 087_llm_spend_global_daily.sql
-- Global (all-users) LLM spend sum for the daily ceiling, per-day totals for
-- observability (goal 2026-09-24 memory-on-prod P2 + P7), and the memory
-- extraction queue (review B1/m6: one session per serverless invocation).
-- Depends on: 029 (code_sessions), 035 (llm_spend)
-- ============================================================
--
-- WHY an RPC and not a plain query: the sum MUST happen server-side —
-- PostgREST caps `.select()` at 1000 rows, so a client-side fetch-and-reduce
-- silently under-counts (migration 035, WHY #3). There is no plain PostgREST
-- query that returns SUM(...) without an RPC.
--
-- WHY a new index: 035's indexes both lead with user_id, so a range on
-- spent_at alone across ALL users cannot use them (full scan). The daily
-- ceiling check runs once per upload batch, so it gets its own index.
--
-- OBSERVABILITY (P7) — per-day spend totals, run from the Supabase SQL
-- editor (service role), newest day first:
--
--   select * from public.llm_spend_daily_totals(14);
--
-- Memory-extraction runs/skips/failures are in the hosted logs as JSON lines
-- with msg "[memory-extraction]" (apps/cloud/src/lib/memory/extraction-log.ts).
--
-- RLS / SECURITY: same as 035's llm_spend_sum — SECURITY INVOKER,
-- EXECUTE granted to service_role only.

create index if not exists idx_llm_spend_spent_at
  on public.llm_spend (spent_at);

-- llm_spend_global_sum(p_since) -> numeric: SUM(cost_usd) over every user
-- with spent_at >= p_since. Returns 0 (never null) when no rows match.
create or replace function public.llm_spend_global_sum(
  p_since timestamptz
) returns numeric
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(sum(cost_usd), 0)::numeric
  from public.llm_spend
  where spent_at >= p_since;
$$;

revoke all on function public.llm_spend_global_sum(timestamptz) from public;
revoke all on function public.llm_spend_global_sum(timestamptz) from anon;
revoke all on function public.llm_spend_global_sum(timestamptz) from authenticated;
grant execute on function public.llm_spend_global_sum(timestamptz) to service_role;

-- llm_spend_daily_totals(p_days) -> one row per UTC day for the last
-- p_days days (today included): total spend, the memory-extraction share
-- (pass names starting with 'memory'), distinct users, and call count.
create or replace function public.llm_spend_daily_totals(
  p_days integer default 14
) returns table (
  day date,
  total_usd numeric,
  memory_usd numeric,
  users bigint,
  calls bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    (spent_at at time zone 'UTC')::date as day,
    coalesce(sum(cost_usd), 0)::numeric as total_usd,
    coalesce(sum(cost_usd) filter (where pass like 'memory%'), 0)::numeric as memory_usd,
    count(distinct user_id) as users,
    count(*) as calls
  from public.llm_spend
  where spent_at >= (date_trunc('day', now() at time zone 'UTC') at time zone 'UTC')
                    - make_interval(days => greatest(p_days, 1) - 1)
  group by 1
  order by 1 desc;
$$;

revoke all on function public.llm_spend_daily_totals(integer) from public;
revoke all on function public.llm_spend_daily_totals(integer) from anon;
revoke all on function public.llm_spend_daily_totals(integer) from authenticated;
grant execute on function public.llm_spend_daily_totals(integer) to service_role;

-- ============================================================
-- Memory extraction queue (goal 2026-09-24 review B1 + m6)
-- ============================================================
--
-- WHY: extraction takes ~60s per session, so running a whole upload batch
-- inside the upload route's after() hit maxDuration and lost the rest (and
-- their unflushed spend). Now the upload route only marks sessions
-- 'pending' here; POST /api/memory/extract-next claims ONE session per
-- invocation, extracts it, flushes spend, and chains the next call. A daily
-- cron re-kicks users whose chain died (expired lease / leftover pending).
--
-- STATUS: pending -> running -> done | skipped | skipped_budget | failed;
-- not_queued = outside the user's backfill window (most recent N sessions).
-- A 'running' row whose lease_until has passed is reclaimable (the run was
-- killed). lease_token guards completion: a re-upload resets the row to
-- 'pending' and clears the token, so a stale worker's finish is a no-op.
--
-- RLS: enabled with NO policies — service role only.

create table if not exists public.memory_extraction_queue (
  session_id   uuid primary key references public.code_sessions(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'pending'
               check (status in ('pending', 'running', 'done', 'skipped', 'skipped_budget', 'failed', 'not_queued')),
  queued_at    timestamptz not null default now(),
  lease_until  timestamptz,
  lease_token  uuid,
  attempts     integer not null default 0,
  last_reason  text,
  updated_at   timestamptz not null default now()
);

create index if not exists idx_memory_extraction_queue_user_status
  on public.memory_extraction_queue (user_id, status);

alter table public.memory_extraction_queue enable row level security;
revoke all on public.memory_extraction_queue from anon, authenticated;

-- memory_extraction_claim(p_user, p_lease_seconds, p_backfill_limit, p_max_attempts)
--   -> at most one row: the claimed session, its lease token, its attempt count.
--
-- 1. Per-user serialisation: a transaction-scoped advisory lock on the user,
--    then "no live lease for this user" — one extraction at a time per user,
--    so a first sync of many batches never fans out (review m6).
-- 2. Backfill window: pending rows whose session is not among the user's
--    p_backfill_limit most recent code_sessions become 'not_queued'.
-- 3. Rows that used up p_max_attempts (killed runs) become 'failed'.
-- 4. Claim the most recent claimable row with FOR UPDATE SKIP LOCKED, so two
--    concurrent claims (different users, or the lock-free path) never get
--    the same row.
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
