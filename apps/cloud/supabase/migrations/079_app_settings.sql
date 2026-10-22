-- ============================================================
-- 079_app_settings.sql
-- Issue #127 round-2 adversarial review, HIGH 5: MEMBRAL_SIGNUPS_DISABLED
-- (lib/env.ts's signupsDisabled()) only gates the Next.js signup SERVER
-- ACTION. Supabase's GoTrue endpoint (`POST /auth/v1/signup`) is a separate
-- origin, reachable directly with the public anon key - flipping the env
-- var stops nothing there, so an incident that needed the kill-switch
-- would still see scripted account creation continue at GoTrue's own
-- (dashboard-configured, often unconfigured) limits.
--
-- FIX: a small operator-controlled settings table + a BEFORE INSERT trigger
-- on auth.users itself, so the block applies to EVERY path that creates a
-- user - the app's signup() action, a direct GoTrue call, or anything else.
-- Same "belt and braces" posture as the conversation_limit trigger in
-- migration 078: the app-level check still runs first (cheap, friendly
-- message, no wasted rate-limit-bucket write - see (auth)/actions.ts), this
-- is the backstop that makes the switch REAL regardless of which door
-- someone comes through. The authoritative switch for a hosted deployment
-- remains Supabase Dashboard -> Authentication -> Providers -> Email ->
-- "Allow new users to sign up" (see docs/DEPLOY.md S6) - this trigger is a
-- second layer for when that dashboard toggle wasn't (or couldn't be, e.g.
-- local dev) flipped in time.
-- ============================================================

create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table public.app_settings is
  'Issue #127: small operator-controlled settings table. Service-role only (RLS enabled, no policies - matches migration 028''s rate_limit_hits / migration 077''s feature_flags convention). Written by scripts/flags.ts signups on|off.';

alter table public.app_settings enable row level security;
-- Deliberately NO policies: anon/authenticated get zero rows via PostgREST;
-- only the service-role key (which bypasses RLS) reads/writes this table.

create or replace function public.enforce_signups_enabled()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_disabled boolean;
begin
  select coalesce((value #>> '{}')::boolean, false)
    into v_disabled
    from public.app_settings
   where key = 'signups_disabled';

  if v_disabled then
    raise exception 'signups_disabled'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.enforce_signups_enabled() is
  'Issue #127 round-2 HIGH 5: before-insert kill-switch on auth.users. Raises errcode P0001, message ''signups_disabled'' when app_settings.signups_disabled = true. See (auth)/actions.ts''s translation of the resulting supabase.auth.signUp() error into the friendly "Signups are currently closed." message.';

-- Same security-definer / owner-runs-as-migration-role convention as
-- migration 004's handle_new_user trigger on auth.users (this repo's only
-- other auth.users trigger) - runs BEFORE that one in insertion order
-- (alphabetically after "handle_new_user" by trigger name is irrelevant;
-- Postgres fires BEFORE triggers in name order, and a raised exception in
-- either one aborts the insert before the AFTER INSERT profile-creation
-- trigger ever runs, so no orphaned profiles row is created for a rejected
-- signup).
drop trigger if exists auth_users_enforce_signups on auth.users;
create trigger auth_users_enforce_signups
  before insert on auth.users
  for each row
  execute function public.enforce_signups_enabled();
