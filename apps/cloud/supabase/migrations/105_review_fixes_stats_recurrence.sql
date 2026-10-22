-- ============================================================
-- 105_review_fixes_stats_recurrence.sql
-- Review fixes on the 2026-09-26 goal (open threads from observed actions).
-- Additive and idempotent: indexes and functions are `if not exists` /
-- `create or replace`, the one constraint is dropped-if-exists then re-added
-- with a WIDER value set, revokes are no-ops when already revoked. Runs in
-- the CLI's single transaction (no `concurrently`, which cannot run inside
-- one — same convention as 084's ATOMICITY note).
-- Depends on: 029 (code_sessions), 084 (session_memories), 103, 104.
--
-- 1. code_sessions (started_at) and (user_id, started_at) indexes — the
--    nightly user_stats derivation reads a day window across all users by
--    started_at, and the first-session lookup is a per-user min. Plain
--    CREATE INDEX takes a SHARE lock on code_sessions (writes wait, reads
--    do not) for the build; fine at today's size.
-- 2. user_first_session_at(uuid[]) — first session per user in one grouped
--    query (replaces an N+1 of one query per active user). Service role only.
-- 3. increment_memory_recurrence(uuid, uuid[], int[]) — B7's
--    `recurrence_count = recurrence_count + n` as ONE atomic UPDATE (two
--    sessions of a project extracted concurrently no longer lose an
--    increment), and it only bumps LIVE rows (never a retired chain root).
--    Service role only.
-- 4. code_session_issues.tier accepts 'inferred' — a row from a session with
--    no structured actions (pre-W3 CLI): role from the extractor, turn_share
--    null (equal split at read time), as before W4.
-- 5. user_stats: revoke TRUNCATE, REFERENCES, TRIGGER from authenticated and
--    anon (104 revoked insert/update/delete only; PostgREST could not reach
--    these, this is hygiene).
--
-- REVERTING 103's role check (not done here, documentation only): 103
-- replaced code_session_issues_role_check with a validated check allowing
-- ('worked_on','referenced','discussed'). To revert, drop it:
--   alter table public.code_session_issues drop constraint if exists code_session_issues_role_check;
-- Restoring the pre-103 check (worked_on|referenced) only succeeds once no
-- row has role 'discussed' — delete or re-role those rows first.
-- Reverting (4) likewise: drop code_session_issues_tier_check and re-add
-- ('observed','discussed') only after rows with tier 'inferred' are gone.
-- ============================================================

-- 1. indexes
create index if not exists code_sessions_started_at_idx
  on public.code_sessions (started_at);
create index if not exists code_sessions_user_started_at_idx
  on public.code_sessions (user_id, started_at);

-- 2. first session per user
create or replace function public.user_first_session_at(p_user_ids uuid[])
returns table (user_id uuid, first_at timestamptz)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select s.user_id, min(s.started_at) as first_at
  from public.code_sessions s
  where s.user_id = any(p_user_ids)
    and s.started_at is not null
  group by s.user_id
$$;

revoke all on function public.user_first_session_at(uuid[]) from public;
revoke all on function public.user_first_session_at(uuid[]) from anon;
revoke all on function public.user_first_session_at(uuid[]) from authenticated;
grant execute on function public.user_first_session_at(uuid[]) to service_role;

-- 3. atomic recurrence increment, live rows only
create or replace function public.increment_memory_recurrence(
  p_user_id uuid,
  p_ids uuid[],
  p_counts int[]
)
returns int
language sql
volatile
security invoker
set search_path = public, pg_temp
as $$
  with inc as (
    select u.id, sum(u.n)::int as n
    from unnest(p_ids, p_counts) as u(id, n)
    where u.n > 0
    group by u.id
  ),
  bumped as (
    update public.session_memories m
       set recurrence_count = coalesce(m.recurrence_count, 1) + inc.n
      from inc
     where m.id = inc.id
       and m.user_id = p_user_id
       and m.retired_at is null
    returning m.id
  )
  select count(*)::int from bumped
$$;

revoke all on function public.increment_memory_recurrence(uuid, uuid[], int[]) from public;
revoke all on function public.increment_memory_recurrence(uuid, uuid[], int[]) from anon;
revoke all on function public.increment_memory_recurrence(uuid, uuid[], int[]) from authenticated;
grant execute on function public.increment_memory_recurrence(uuid, uuid[], int[]) to service_role;

-- 4. tier 'inferred'
alter table public.code_session_issues drop constraint if exists code_session_issues_tier_check;
alter table public.code_session_issues
  add constraint code_session_issues_tier_check
  check (tier is null or tier in ('observed', 'discussed', 'inferred'));

-- 5. user_stats grant hygiene
revoke truncate, references, trigger on public.user_stats from authenticated;
revoke truncate, references, trigger on public.user_stats from anon;
