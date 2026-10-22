-- ============================================================
-- 053_claims_advance_fencing.sql
-- Adversarial-review fixes to the arrival loop + sync-state surface
-- (migration 049's kg_claims_advance_state / lock RPCs, and
-- arrival-loop.ts's D2 backfill + D7 lag computation). Three pieces:
--
-- PIECE A — M8: fencing token for the advance lock. Migration 049's
-- kg_claims_advance_release_lock(p_user_id, p_claims_projected) released
-- purely on user_id — if a lock went stale (kg_claims_advance_try_lock's own
-- p_stale_after_seconds, default 900s) and got re-granted to a SECOND
-- caller, the FIRST caller's own `finally` could still clear it, wiping the
-- second caller's still-in-progress lock. kg_claims_advance_try_lock now
-- returns the acquired `lock_acquired_at` timestamp itself as a fencing
-- TOKEN (instead of a bare boolean); the new kg_claims_advance_release_lock
-- only releases when the row's CURRENT lock_acquired_at still equals the
-- token the caller was handed. A caller whose token no longer matches
-- silently no-ops (its lock already belongs to someone else — releasing
-- would be releasing THEIR lock, not this caller's).
--
-- PIECE B — M9: one-shot D2 hash backfill. `hash_backfill_done_at` records
-- when the arrival loop last found the NULL-source_hash backlog fully
-- exhausted (arrival-loop.ts's backfillAllSourceHashes) — once set, the
-- backfill never runs again for that user, bounding the blast radius of its
-- own documented caveat (conversations.updated_at is client-supplied, so a
-- byte-identical re-import after a normalizer change could in principle be
-- mis-read as "unchanged").
--
-- PIECE C — H2: persisted claims lag. `claims_lag_conversations` mirrors
-- arrival-loop.ts's ClaimsLagInfo.claimsLagConversations (D7), written by
-- the SAME release RPC at the end of a cycle (a single atomic UPDATE
-- alongside the fencing release) instead of a second round trip. Before this
-- fix, GET /api/sync-state called computeClaimsLag directly on every poll
-- (every 15s per open Today tab) — a full per-conversation sha256 scan
-- (~33MB for a founder-1k-scale corpus) on a read-only, high-frequency
-- route. sync-state now reads this column; computeClaimsLag itself is
-- unchanged and still runs only inside an advance cycle, which already holds
-- the per-user lock (at most once per ~20-minute sweep).
-- ============================================================

-- ------------------------------------------------------------
-- Piece B + C: new columns on kg_claims_advance_state (migration 049).
-- ------------------------------------------------------------
alter table public.kg_claims_advance_state
  add column if not exists hash_backfill_done_at timestamptz;

comment on column public.kg_claims_advance_state.hash_backfill_done_at is
  'M9 (adversarial review, migration 053): set once arrival-loop.ts''s backfillAllSourceHashes finds the NULL-source_hash backlog for this user fully exhausted (a page returns zero remaining candidates). NULL means the one-shot D2 backfill has not yet completed for this user (or this row predates migration 053) — backfillAllSourceHashes only runs at all while this is NULL. Never cleared automatically once set.';

alter table public.kg_claims_advance_state
  add column if not exists claims_lag_conversations int;

comment on column public.kg_claims_advance_state.claims_lag_conversations is
  'H2 (adversarial review, migration 053): D7''s claims_lag_conversations (arrival-loop.ts''s computeClaimsLag), persisted by kg_claims_advance_release_lock at the end of each advance cycle that computed a fresh value. NULL means no advance cycle has ever persisted one yet ("not computed yet") — read by GET /api/sync-state instead of that route calling computeClaimsLag itself (which stays advance-cycle-only, see that function''s own H2 doc note).';

-- ------------------------------------------------------------
-- Piece A: kg_claims_advance_try_lock — now returns the acquired
-- lock_acquired_at (timestamptz) as a fencing token instead of boolean.
-- Return-type change requires DROP + CREATE (CREATE OR REPLACE cannot alter
-- a function's return type).
-- ------------------------------------------------------------
drop function if exists public.kg_claims_advance_try_lock(uuid, int);

create function public.kg_claims_advance_try_lock(
  p_user_id uuid,
  p_stale_after_seconds int default 900
) returns timestamptz
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_acquired_at timestamptz;
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
  returning lock_acquired_at into v_acquired_at;

  return v_acquired_at;
end;
$$;

revoke all on function public.kg_claims_advance_try_lock(uuid, int) from public;
revoke all on function public.kg_claims_advance_try_lock(uuid, int) from anon;
revoke all on function public.kg_claims_advance_try_lock(uuid, int) from authenticated;
grant execute on function public.kg_claims_advance_try_lock(uuid, int) to service_role;

comment on function public.kg_claims_advance_try_lock(uuid, int) is
  'D1 concurrency guard (ADR 0030 addendum "D9 — the arrival loop"), M8-fenced as of migration 053: row-based compare-and-swap lock for POST /api/kg/claims/advance AND queue.ts''s processKgPass1 (L11), one row per user. Returns the acquired lock_acquired_at (a fencing TOKEN) iff THIS call acquired the lock (the row was free or its prior lock was stale); NULL otherwise. Callers MUST pass the returned token to kg_claims_advance_release_lock in a finally block — a lock never released (a crashed request) self-heals after p_stale_after_seconds (default 900s).';

-- ------------------------------------------------------------
-- kg_claims_advance_release_lock — fenced on the token (M8), and now also
-- persists H2's claims_lag_conversations in the same atomic UPDATE.
-- New signature (return type unchanged, but the parameter list differs from
-- 049's (uuid, boolean) — DROP the old one explicitly so no two-arg overload
-- is left callable with stale (non-fenced) semantics).
-- ------------------------------------------------------------
drop function if exists public.kg_claims_advance_release_lock(uuid, boolean);

create function public.kg_claims_advance_release_lock(
  p_user_id uuid,
  p_token timestamptz,
  p_claims_projected boolean default false,
  p_claims_lag_conversations int default null
) returns void
language sql
security invoker
set search_path = public, pg_temp
as $$
  update public.kg_claims_advance_state
     set running = false,
         last_advance_completed_at = now(),
         last_claims_projected_at = case when p_claims_projected then now() else last_claims_projected_at end,
         claims_lag_conversations = coalesce(p_claims_lag_conversations, claims_lag_conversations),
         updated_at = now()
   where user_id = p_user_id
     and lock_acquired_at = p_token;
$$;

revoke all on function public.kg_claims_advance_release_lock(uuid, timestamptz, boolean, int) from public;
revoke all on function public.kg_claims_advance_release_lock(uuid, timestamptz, boolean, int) from anon;
revoke all on function public.kg_claims_advance_release_lock(uuid, timestamptz, boolean, int) from authenticated;
grant execute on function public.kg_claims_advance_release_lock(uuid, timestamptz, boolean, int) to service_role;

comment on function public.kg_claims_advance_release_lock(uuid, timestamptz, boolean, int) is
  'M8-fenced release (migration 053, replacing 049''s (uuid, boolean) signature): releases the kg_claims_advance_try_lock row for p_user_id ONLY when its CURRENT lock_acquired_at still equals p_token (the token try_lock returned on acquisition) — a mismatched token is a silent no-op (this caller''s lock already went stale and was re-granted to someone else; releasing would clear THEIR lock, not this caller''s). When it does release: sets running=false, stamps last_claims_projected_at = now() iff p_claims_projected, and (H2) sets claims_lag_conversations = p_claims_lag_conversations when given (a null argument leaves the previously-persisted value untouched — a caller that never computed a fresh lag figure this cycle, e.g. a refusal path, does not clobber the last real one).';
