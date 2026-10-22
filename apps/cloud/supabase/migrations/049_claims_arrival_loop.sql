-- ============================================================
-- 049_claims_arrival_loop.sql
-- ADR 0030 addendum "D9 — the arrival loop" (docs/adr/0030-recentering-verified-record.md,
-- 2026-07-28 sign-off, #102). Two pieces:
--
-- PIECE A — D2, hash-gated re-extraction. `source_hash` on
-- kg_conversations_processed: sha256 (source-hash.ts's computeSourceHash) over
-- the conversation's normalized (role, content) message array. pass1.ts's
-- isSkippable now requires this to MATCH the conversation's CURRENT content
-- hash (in addition to the existing schema_version/claims_rev/prompt_hash
-- watermarks) before skipping re-extraction — a conversation that gains turns
-- (or whose content otherwise changes) after its last extraction is no longer
-- skipped forever just because the watermarks are current. NULL on every
-- pre-existing row (including today's 'done' rows) is INTENTIONALLY never
-- skippable (`row.source_hash != null && row.source_hash === currentHash` —
-- see pass1.ts) — the corpus gets re-extracted once, on the first arrival-loop
-- or sync cycle after this migration deploys, to backfill the column, then
-- settles into "only genuinely-changed conversations re-extract" from there.
--
-- PIECE B — D1's concurrency guard + D7's `last_claims_projected_at`.
-- POST /api/kg/claims/advance (the sweep-driven arrival-loop trigger) needs a
-- lock so two concurrent calls for the SAME user (e.g. an overlapping sweep
-- retry, or a manual trigger racing the sweep) don't double-run pass1 +
-- runClaimsStage concurrently against the same rows. A row-based
-- compare-and-swap via two tiny RPCs (kg_claims_advance_try_lock /
-- kg_claims_advance_release_lock) rather than a session-pinned
-- pg_advisory_lock: this app talks to Postgres through Supabase's pooled
-- (transaction-mode) connections, where an explicit session-level advisory
-- lock held across more than one statement is unsafe (the connection backing
-- it can be handed to a different caller between statements). Each RPC call
-- is a single statement/transaction, so it works correctly under pooling.
-- The row this locks on (kg_claims_advance_state) also carries D7's
-- last_claims_projected_at — the one D7 field with no other natural home
-- (last_conversation_synced_at / last_pass1_completed_at are both computed
-- on demand from conversations.synced_at / kg_conversations_processed.
-- completed_at — see arrival-loop.ts's computeClaimsLag).
--
-- A stale lock (a crashed/killed request that never reached its `finally`
-- release) self-heals after p_stale_after_seconds (default 900s = 15min,
-- comfortably under the sweep's 20-minute cadence) rather than wedging the
-- arrival loop for that user forever.
-- ============================================================

-- ------------------------------------------------------------
-- Piece A: kg_conversations_processed.source_hash (D2).
-- ------------------------------------------------------------
alter table public.kg_conversations_processed
  add column if not exists source_hash text;

comment on column public.kg_conversations_processed.source_hash is
  'D2 (ADR 0030 addendum "D9 — the arrival loop"): sha256 over the conversation''s normalized (role, content) message array at the time of its last successful pass1 extraction (source-hash.ts computeSourceHash). pass1.ts''s isSkippable requires this to equal the conversation''s CURRENT content hash (in addition to the pre-existing schema_version/claims_rev/prompt_hash watermarks) before skipping re-extraction, so a conversation that gains turns after being marked done is re-extracted instead of being skipped forever. NULL (every pre-migration row, and any row whose extraction failed) is never skippable by construction — the corpus backfills this column once, on its next extraction pass after this migration deploys.';

-- ------------------------------------------------------------
-- Piece B: kg_claims_advance_state — one row per user, doubling as (1) the
-- POST /api/kg/claims/advance concurrency lock and (2) D7's
-- last_claims_projected_at. Same RLS/grant posture as llm_spend (migration
-- 035) and kg_bootstrap_runs (migration 017): RLS enabled with NO policies
-- (anon/authenticated get zero rows via PostgREST); every read/write goes
-- through the service-role client (arrival-loop.ts), which bypasses RLS.
-- ------------------------------------------------------------
create table if not exists public.kg_claims_advance_state (
  user_id                    uuid primary key references public.profiles(id) on delete cascade,
  running                    boolean not null default false,
  lock_acquired_at           timestamptz,
  last_advance_started_at    timestamptz,
  last_advance_completed_at  timestamptz,
  last_claims_projected_at   timestamptz,
  updated_at                 timestamptz not null default now()
);

alter table public.kg_claims_advance_state enable row level security;
-- No policies: ordinary (anon/authenticated) sessions get zero rows via
-- PostgREST. Every read/write goes through arrival-loop.ts's service-role
-- client, which bypasses RLS.

-- ------------------------------------------------------------
-- kg_claims_advance_try_lock(p_user_id, p_stale_after_seconds default 900)
--   -> boolean (true = lock acquired by THIS call, false = already running
--   elsewhere and not yet stale).
--
-- Atomic compare-and-swap: the INSERT ... ON CONFLICT ... DO UPDATE ... WHERE
-- only fires the update (and therefore RETURNS a row) when the existing row
-- is free (running = false) OR its lock is stale (acquired further back than
-- p_stale_after_seconds) — a concurrent caller racing this one either loses
-- the WHERE (gets zero rows back, i.e. NOT FOUND -> false) or, vanishingly
-- rarely under Postgres's row-level locking for a single UPDATE statement,
-- serializes behind it and then also fails the WHERE once it re-evaluates
-- against the just-updated row. Either way, at most one caller can ever
-- observe `true` for a given non-stale lock.
-- ------------------------------------------------------------
create or replace function public.kg_claims_advance_try_lock(
  p_user_id uuid,
  p_stale_after_seconds int default 900
) returns boolean
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_acquired boolean := false;
begin
  insert into public.kg_claims_advance_state (user_id, running, lock_acquired_at, last_advance_started_at, updated_at)
  values (p_user_id, true, now(), now(), now())
  on conflict (user_id) do update
    set running = true,
        lock_acquired_at = now(),
        last_advance_started_at = now(),
        updated_at = now()
  where kg_claims_advance_state.running = false
     or kg_claims_advance_state.lock_acquired_at < now() - make_interval(secs => greatest(coalesce(p_stale_after_seconds, 900), 0))
  returning true into v_acquired;

  return coalesce(v_acquired, false);
end;
$$;

revoke all on function public.kg_claims_advance_try_lock(uuid, int) from public;
revoke all on function public.kg_claims_advance_try_lock(uuid, int) from anon;
revoke all on function public.kg_claims_advance_try_lock(uuid, int) from authenticated;
grant execute on function public.kg_claims_advance_try_lock(uuid, int) to service_role;

comment on function public.kg_claims_advance_try_lock(uuid, int) is
  'D1 concurrency guard (ADR 0030 addendum "D9 — the arrival loop"): row-based compare-and-swap lock for POST /api/kg/claims/advance, one row per user. Returns true iff THIS call acquired the lock (the row was free or its prior lock was stale). Callers MUST release via kg_claims_advance_release_lock in a finally block; a lock never released (a crashed request) self-heals after p_stale_after_seconds (default 900s).';

-- ------------------------------------------------------------
-- kg_claims_advance_release_lock(p_user_id, p_claims_projected default false)
--   -> void. Always clears `running`, regardless of whether this caller
--   actually held the lock (idempotent — safe to call from a `finally` even
--   on a path that never confirmed acquisition). `p_claims_projected` stamps
--   D7's last_claims_projected_at ONLY when the caller's own runClaimsStage
--   call actually folded (not on a torn-projection fold-skip — see
--   claims-stage.ts's own foldSkipped) — the caller decides that, this RPC
--   just records it.
-- ------------------------------------------------------------
create or replace function public.kg_claims_advance_release_lock(
  p_user_id uuid,
  p_claims_projected boolean default false
) returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  update public.kg_claims_advance_state
     set running = false,
         last_advance_completed_at = now(),
         last_claims_projected_at = case when p_claims_projected then now() else last_claims_projected_at end,
         updated_at = now()
   where user_id = p_user_id;
$$;

revoke all on function public.kg_claims_advance_release_lock(uuid, boolean) from public;
revoke all on function public.kg_claims_advance_release_lock(uuid, boolean) from anon;
revoke all on function public.kg_claims_advance_release_lock(uuid, boolean) from authenticated;
grant execute on function public.kg_claims_advance_release_lock(uuid, boolean) to service_role;

comment on function public.kg_claims_advance_release_lock(uuid, boolean) is
  'Releases the kg_claims_advance_try_lock row for p_user_id (sets running=false unconditionally — idempotent) and, when p_claims_projected, stamps D7''s last_claims_projected_at = now(). No-op (0 rows updated) if no lock row exists yet for this user, which is fine — try_lock always creates one first.';
