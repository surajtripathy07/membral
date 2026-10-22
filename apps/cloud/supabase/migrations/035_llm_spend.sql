-- ============================================================
-- 035_llm_spend.sql
-- Append-only per-call LLM spend ledger (GitHub issue #21, ADR 0027 J6.2).
-- Depends on: 001 (profiles)
-- ============================================================
--
-- WHY: bootstrap.ts summed totalCostUsd and reported it AFTER a run finished —
-- there was no mid-run cap enforcement and no durable record of spend a
-- rolling per-user ceiling could be computed against. Three things needed a
-- durable log, not an in-memory counter:
--   1. The per-run cap (LlmClient.capUsd) must survive a PHASE-SPLIT bootstrap
--      (queue.ts builds a separate LlmClient for Phase 1 and Phase 2 of the
--      same run) — Phase 2's client seeds its totalCostUsd from this ledger
--      instead of starting back at 0, so the single cap actually holds across
--      both phases. Scoped by run_id (below), NOT a started_at time window —
--      a time window can be contaminated by OTHER concurrent spend for the
--      same user (e.g. the steady-state per-import Pass 1 trigger firing
--      while a bootstrap sits parked at the review gate), which could make a
--      parked run permanently un-completable (seeded already "over cap" by
--      spend that has nothing to do with it).
--   2. The monthly ceiling (checkMonthlyCeiling, spend-ledger.ts) sums
--      cost_usd over the trailing 30 days per user — a recurring job (the
--      timed memory sweep, ADR 0027 J6) needs a ceiling ACROSS runs, which by
--      definition cannot live in any single run's in-memory state.
--   3. (Adversarial review B1) PostgREST caps any `.select()` result at 1000
--      rows by default — summing cost_usd by fetching rows client-side and
--      reducing in JS silently truncates past 1000 rows (e.g. 1200 rows of
--      $0.001 sums to $1.00, not the true $1.20, permanently under-detecting
--      a breached ceiling). The sum MUST happen server-side — see
--      llm_spend_sum below. There must be NO client-side row-fetch-and-reduce
--      path anywhere in this codebase for this table.
--
-- APPEND-ONLY, NOT aggregated (same argument as migration 028's rate-limit
-- log): a running counter column would need read-modify-write races handled
-- per writer; an append-only log lets every LlmClient call insert independently
-- and lets the ceiling/ledger math be a plain SUM(...) over a time window —
-- exactly the sliding-window shape 028 already established for this codebase.
--
-- WRITE PATH (lib/kg/spend-ledger.ts createSpendLedger): buffers rows
-- in-memory and flushes in batches of ~20 (and always at run end) rather than
-- one INSERT per LLM call — a batch bootstrap run makes hundreds of calls, and
-- one row-per-call round-trip would be needless DB pressure on the same
-- request path the cap itself exists to protect. TRADEOFF: a hard process
-- crash between flushes loses at most that buffer's worth of spend rows from
-- the ledger (the run's own cost tracking in-memory is unaffected; only the
-- DURABLE ledger — used for cross-run/cross-phase accounting — under-counts
-- by a bounded, small amount). Spend-logging failures NEVER crash or halt a
-- run (CLAUDE.md rule): every write is try/catch'd and merely logged on error.
--
-- RLS / SECURITY: service-role only, identical lock-down pattern to migration
-- 028's rate_limit_hits — RLS enabled with NO policies (anon/authenticated get
-- zero rows via PostgREST). llm_spend_sum is SECURITY INVOKER (like 028's
-- rate_limit_check) — its only caller is the service-role server client, which
-- bypasses RLS regardless; INVOKER keeps it from being an ambient-authority
-- SECURITY DEFINER. EXECUTE is service_role-only (granted below).

create table if not exists public.llm_spend (
  id        uuid primary key default gen_random_uuid(),
  user_id   uuid not null references public.profiles(id) on delete cascade,
  spent_at  timestamptz not null default now(),
  pass      text not null,
  model     text not null,
  cost_usd  numeric not null,
  -- The kg_bootstrap_runs.id this spend belongs to, when the caller is running
  -- under a tracked bootstrap run (Phase 1 AND Phase 2 of the SAME run tag
  -- every row with the same run_id). NULL for callers with no run concept:
  -- the steady-state per-import Pass 1 trigger, the code-sessions sweep, and
  -- portrait/relationship/person-portrait regeneration.
  run_id    uuid null
);

-- Serves the rolling-window sum (user_id, spent_at > now() - interval '30 days').
create index if not exists idx_llm_spend_user_time
  on public.llm_spend (user_id, spent_at);

-- Serves the phase-split seed sum (user_id, run_id).
create index if not exists idx_llm_spend_user_run
  on public.llm_spend (user_id, run_id);

alter table public.llm_spend enable row level security;
-- No policies: ordinary (anon/authenticated) sessions get zero rows via
-- PostgREST. Every read/write goes through the service-role client (queue.ts,
-- bootstrap-runs.ts, code-sessions/synthesize.ts, portrait/route.ts), which
-- bypasses RLS.

-- ------------------------------------------------------------
-- llm_spend_sum(p_user_id, p_since, p_run_id default null) -> numeric
--
-- Server-side sum — see WHY #3 above for why a client-side row fetch is
-- unacceptable here (PostgREST's 1000-row default cap silently truncates the
-- sum). Two mutually exclusive modes selected by whether p_run_id is passed:
--   - p_run_id IS NOT NULL: sum ONLY rows tagged with that run_id (the
--     phase-split seed use — p_since is ignored in this mode; callers should
--     still pass a real timestamp for readability/audit, but any value works).
--   - p_run_id IS NULL: sum rows with spent_at > p_since (the rolling
--     30-day monthly-ceiling use).
-- Returns 0 (never null) when there are no matching rows.
-- ------------------------------------------------------------
create or replace function public.llm_spend_sum(
  p_user_id uuid,
  p_since timestamptz,
  p_run_id uuid default null
) returns numeric
language sql
security invoker
set search_path = public, pg_temp
as $$
  select coalesce(sum(cost_usd), 0)::numeric
  from public.llm_spend
  where user_id = p_user_id
    and (
      (p_run_id is not null and run_id = p_run_id)
      or
      (p_run_id is null and spent_at > p_since)
    );
$$;

revoke all on function public.llm_spend_sum(uuid, timestamptz, uuid) from public;
revoke all on function public.llm_spend_sum(uuid, timestamptz, uuid) from anon;
revoke all on function public.llm_spend_sum(uuid, timestamptz, uuid) from authenticated;
grant execute on function public.llm_spend_sum(uuid, timestamptz, uuid) to service_role;
