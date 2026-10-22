-- ============================================================
-- 054_api_keys_update_policy.sql
-- L5 (adversarial review of migration 052): api_keys' RLS UPDATE policy
-- ("api_keys: users update own rows", `using (auth.uid() = user_id)`, no
-- WITH CHECK) let an authenticated user run ANY update against their own
-- api_keys rows via PostgREST directly — including flipping revoked_at back
-- to NULL, i.e. un-revoking a key they'd previously revoked (e.g. after a
-- suspected leak). The app never relies on that policy: every revocation
-- path (DELETE /api/keys/devices/[id]'s route.ts, and legacy DELETE
-- /api/keys for the single-key profiles columns) goes through the
-- service-role client, which bypasses RLS entirely — the user-facing
-- UPDATE policy exists only as unused attack surface, not as something any
-- feature depends on.
--
-- Fix: drop the policy outright rather than narrow it with a WITH CHECK.
-- api_keys has no legitimate user-initiated UPDATE today — revocation
-- and any future field edits (label/scope changes, etc.) should go through
-- a service-role-validated route the same way revocation does today (see
-- DELETE /api/keys/devices/[id]'s own comment on why service-role +
-- explicit `.eq("user_id", ...)` is this table's enforcement model, not
-- RLS). SELECT/INSERT/DELETE policies from migration 052 are untouched —
-- out of scope for this fix, and not the reported issue.
-- ============================================================

drop policy if exists "api_keys: users update own rows" on public.api_keys;

comment on table public.api_keys is
  'Multiple lls_ API keys per user (device-code sign-in, migration 052). Coexists with the legacy single-key profiles.api_key_hash/api_key_prefix columns — see lib/api-keys.ts''s validateApiKey, which checks profiles first, then falls through here. No user-facing UPDATE RLS policy (migration 054, L5): revocation and any future field edits go through service-role routes only, constrained by an explicit .eq("user_id", ...) predicate — never by RLS.';
