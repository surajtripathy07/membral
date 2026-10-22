-- ============================================================
-- 056_api_keys_lock_policies.sql
-- NEW-8 (round-2 adversarial review of the import/auth surfaces): api_keys'
-- RLS INSERT policy ("api_keys: users insert own rows", `with check
-- (auth.uid() = user_id)`, migration 052) plus PostgREST's default
-- `authenticated` INSERT grant let ANY signed-in session mint itself a
-- permanent lls_ key directly against PostgREST — `POST /rest/v1/api_keys`
-- with `{ user_id: <own id>, key_hash: <attacker-chosen>, key_prefix: ...
-- }` satisfies the policy and creates a working key the app never issued or
-- hashed itself, bypassing every one-time device-approval/rate-limit path
-- api-keys.ts / device-auth.ts actually enforce. The DELETE policy
-- ("api_keys: users delete own rows") has the same shape of problem in
-- reverse: it's unused attack surface, not something any feature depends on
-- (every real revocation goes through the service-role client in DELETE
-- /api/keys/devices/[id]'s route.ts, gated by an explicit
-- .eq("id", id).eq("user_id", user.id) predicate, same enforcement model as
-- migration 054 already applied to UPDATE).
--
-- Confirmed via grep across apps/cloud/src that every INSERT/UPDATE/DELETE
-- against api_keys goes through a service-role client (api-keys.ts,
-- device-auth.ts, /api/keys/devices/[id]/route.ts) — the ONLY cookie/RLS-
-- scoped access is the settings page's SELECT (settings/page.tsx), which
-- this migration leaves untouched.
--
-- Fix: drop the INSERT and DELETE policies outright — same treatment
-- migration 054 already gave UPDATE. SELECT is untouched (the settings
-- page's device-key list depends on it). No GRANT changes: PostgREST route
-- access is still governed by RLS, and with zero applicable policies for
-- INSERT/DELETE, `authenticated` requests are simply denied (RLS defaults
-- to deny when no permissive policy matches), not opened up further.
-- ============================================================

drop policy if exists "api_keys: users insert own rows" on public.api_keys;
drop policy if exists "api_keys: users delete own rows" on public.api_keys;

comment on table public.api_keys is
  'Multiple lls_ API keys per user (device-code sign-in, migration 052). Coexists with the legacy single-key profiles.api_key_hash/api_key_prefix columns — see lib/api-keys.ts''s validateApiKey, which checks profiles first, then falls through here. No user-facing INSERT/UPDATE/DELETE RLS policy (migrations 054 + 056): minting, revoking, and any future field edits go through service-role routes only, constrained by an explicit .eq("user_id", ...) predicate — never by RLS. SELECT remains RLS-scoped to auth.uid() = user_id for the settings page''s device-key list.';
