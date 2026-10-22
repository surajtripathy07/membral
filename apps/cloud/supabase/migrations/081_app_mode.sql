-- ============================================================
-- 081_app_mode.sql
-- Issue #127/#130 self-hosting decision, maintainer quote 2026-09-08
-- (verbatim): "since we do have idea of opensource, the default local
-- setup should have no constraints or constraints explicitly called out
-- and highlighted about how to change for local setup."
--
-- FIX: a single operator-controlled switch, `app_settings` row
-- `key = 'mode'`, value 'open' or 'hosted' (jsonb string — same
-- table/convention as migration 079's `signups_disabled` row). NO ROW =
-- 'open' — a fresh clone (local dev, a stranger's self-host, CI) gets NO
-- product constraints by default: `llm`/`embeddings` are enabled and
-- unlimited for every user unless an explicit `feature_flags` row
-- (migration 077/080) disables or budgets them, and new profiles get an
-- unlimited (NULL) `conversation_limit`. 'hosted' restores today's
-- behaviour (llm off by default, embeddings budgeted, new profiles
-- `conversation_limit = 100`) — this repo's own live/founder/tusk
-- deployments set it explicitly via `scripts/flags.ts mode hosted` (see
-- docs/DEPLOY.md).
--
-- `public.app_mode()` is the SQL read surface the two triggers below use
-- (SECURITY DEFINER so it can read `app_settings` regardless of the
-- calling role — same posture as migration 079's
-- `enforce_signups_enabled()`). `apps/cloud/src/lib/feature-flags.ts`'s
-- `getAppMode()` is the separate APPLICATION read surface (service-role,
-- 60s in-process cache, fails closed to 'hosted' on a query ERROR —
-- money-safety; a MISSING row still defaults to 'open', matching this
-- function) — the two independently read the SAME row rather than one
-- calling the other, so a Postgres-only client (a raw psql session,
-- another service) gets the same default without needing Next.js.
--
-- This migration changes NEW-INSERT behaviour only:
--   - migration 004's `handle_new_user()` (profile-creation trigger on
--     auth.users) now sets `conversation_limit` from `app_mode()` instead
--     of relying on migration 001's column default (100) —
--     `CASE app_mode() WHEN 'hosted' THEN 100 ELSE NULL END`.
--   - migration 078's `enforce_conversation_limit()` trigger now treats a
--     NULL `conversation_limit` as UNLIMITED (returns early, no count(*))
--     instead of coalescing it to 100 — matching `lib/billing.ts`'s
--     `getConversationQuota` (also updated in this issue to map a NULL
--     `conversation_limit` to `Number.POSITIVE_INFINITY` instead of
--     falling back to the free-tier default).
--
-- Existing rows are NOT touched by this migration — every account created
-- before it keeps whatever `conversation_limit` it already has (100 for
-- the column-default rows, 10000 for founder/tusk's hand-raised rows).
-- Migration 001's column default (100) is deliberately left as-is: it's
-- the fallback for any INSERT into public.profiles that does NOT go
-- through the handle_new_user trigger (there is no such path today, but a
-- column default of 100 rather than NULL is the safer fail-closed choice
-- for an insert path nobody has audited against this decision).
-- ============================================================

create or replace function public.app_mode()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case
    when (select value #>> '{}' from public.app_settings where key = 'mode') = 'hosted' then 'hosted'
    else 'open'
  end;
$$;

comment on function public.app_mode() is
  'Issue #127 self-hosting decision (2026-09-08): reads app_settings row key=''mode''. No row, or any value other than the literal ''hosted'', resolves to ''open'' (no product constraints). Written by scripts/flags.ts mode open|hosted. See apps/cloud/src/lib/feature-flags.ts''s getAppMode() for the independent application-layer read of the same row (fails closed to ''hosted'' on a query error, for money-safety — this SQL function has no equivalent "error" state to fail closed from, since a failed read here would abort the calling trigger/transaction outright, which is itself a fail-closed outcome).';

-- ------------------------------------------------------------
-- migration 004's handle_new_user(), extended: conversation_limit is now
-- mode-dependent instead of relying on the column default.
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  insert into public.profiles (id, email, conversation_limit)
  values (
    new.id,
    new.email,
    case public.app_mode() when 'hosted' then 100 else null end
  );
  return new;
end;
$$;

-- ------------------------------------------------------------
-- migration 078's enforce_conversation_limit(), extended: a NULL
-- conversation_limit now means UNLIMITED (skip the check) instead of
-- being coalesced to the free-tier default of 100. A profiles row that
-- somehow doesn't exist yet (should not happen -- handle_new_user above
-- always creates one) still falls back to 100, same as before 081.
-- ------------------------------------------------------------
create or replace function public.enforce_conversation_limit()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_limit integer;
  v_count integer;
begin
  -- An upsert of an EXISTING (user_id, source, source_id) row is an
  -- UPDATE, not new usage - always allowed regardless of quota. Unchanged
  -- from migration 078.
  if exists (
    select 1
      from public.conversations
     where user_id = new.user_id
       and source = new.source
       and source_id = new.source_id
  ) then
    return new;
  end if;

  -- Serialize concurrent quota checks for THIS user. Unchanged from
  -- migration 078 (HIGH 6).
  perform pg_advisory_xact_lock(hashtext(new.user_id::text));

  select conversation_limit
    into v_limit
    from public.profiles
   where id = new.user_id;

  if v_limit is null then
    if not exists (select 1 from public.profiles where id = new.user_id) then
      -- No profiles row at all (should not happen) — fall back to the
      -- same free-tier default getConversationQuota() uses.
      v_limit := 100;
    else
      -- Explicit NULL = unlimited (issue #127 open-mode default, this
      -- migration). Skip the count entirely.
      return new;
    end if;
  end if;

  select count(*)
    into v_count
    from public.conversations
   where user_id = new.user_id;

  if v_count >= v_limit then
    raise exception 'conversation_limit'
      using errcode = 'P0001',
            detail = json_build_object('limit', v_limit, 'count', v_count)::text;
  end if;

  return new;
end;
$$;

comment on function public.enforce_conversation_limit() is
  'Issue #127 round-2 HIGH 3/4/6, extended by issue #127 self-hosting decision (migration 081): atomic before-insert quota check for public.conversations. NULL conversation_limit = unlimited (skip check) — the open-mode default (migration 081). Raises errcode P0001, message ''conversation_limit'', detail {"limit":N,"count":N} when a brand-new (user_id,source,source_id) row would exceed a non-null profiles.conversation_limit. Existing rows (updates) always pass. See lib/billing.ts''s parseConversationLimitError for the app-side translation.';
