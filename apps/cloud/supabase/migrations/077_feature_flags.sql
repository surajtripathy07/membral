-- ============================================================
-- 077_feature_flags.sql
-- Per-user feature flag for every LLM-spending surface (issue #126).
-- Depends on: none beyond auth.users (Supabase built-in).
-- ============================================================
--
-- WHY: going public on membral.me, every feature that spends money on an
-- external provider (OpenAI embeddings/chat, OpenRouter bridge) must be OFF
-- by default for a fresh signup and switchable on per user by the
-- maintainer — see docs/adr/0047-llm-feature-flag.md for the full decision.
-- Cost caps/ceilings (migration 035's llm_spend, checkMonthlyCeiling) bound
-- how MUCH a permitted user can spend; this table is the orthogonal
-- on/off switch for whether they may spend AT ALL. A Stripe-backed paywall
-- can write these same rows later (webhook: checkout completed -> upsert
-- enabled=true) without any schema change — see the ADR's "future paywall"
-- section.
--
-- TABLE DESIGN: one row per (user, feature) — today the only feature value
-- is 'llm' (apps/cloud/src/lib/feature-flags.ts's `Feature` union), kept as
-- a free `text` column rather than an enum/check constraint so a second
-- feature can be added later without a migration. `note` is an operator-
-- facing free-text field (why this row exists — e.g. "founder account",
-- "beta tester", "paywall: sub active") — never read by application logic.
-- Absence of a row means disabled (fail-closed, ADR D2) — there is
-- deliberately no `enabled=false` row inserted for a fresh signup; the
-- feature-flags.ts helper treats "no row" and "row with enabled=false"
-- identically.
--
-- `enabled` DEFAULTS TO FALSE (issue #126 verification finding 10, fixed
-- post-review — this migration originally shipped `default true`, a
-- schema-level fail-OPEN in a table whose whole point is fail-closed). The
-- app itself never relies on the column default — scripts/flags.ts's grant
-- always sets `enabled: true` explicitly, and a future Stripe webhook should
-- do the same — but any future insert that omits the column (a hand-written
-- SQL fix, a partial upsert) must land disabled, not silently enabled.
--
-- RLS: authenticated may SELECT their own row (a user should be able to see
-- whether their own account has a feature switched on, e.g. for a future
-- account/billing UI) — but NO insert/update/delete policy: every write
-- goes through the service-role client (apps/cloud/scripts/flags.ts, and
-- eventually a Stripe webhook), matching migration 036's sync_heartbeats
-- shape minus the write policies (this table has no legitimate end-user
-- writer at all, unlike a heartbeat a user's own session could plausibly
-- write).
create table if not exists public.feature_flags (
  user_id     uuid not null references auth.users(id) on delete cascade,
  feature     text not null,
  enabled     boolean not null default false,
  note        text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (user_id, feature)
);

-- Idempotent fix-up for any environment where this migration already ran
-- with the original `default true` (issue #126 verification finding 10) —
-- `create table if not exists` above is a no-op on such an environment, so
-- the default must be corrected explicitly. Existing rows are untouched
-- (this only changes what a FUTURE column-omitting insert defaults to).
alter table public.feature_flags alter column enabled set default false;

comment on table public.feature_flags is
  'Per-user on/off switch for a spend-gated feature (issue #126, ADR 0047). One row per (user_id, feature); feature is a free-text key (currently only ''llm''). Absence of a row = disabled (fail-closed). Written by apps/cloud/scripts/flags.ts (service role) or MEMBRAL_FEATURE_ALLOWLIST env bootstrap; read via lib/feature-flags.ts''s hasFeature/assertFeature. A future paywall (Stripe webhook) writes the same rows — see the ADR.';

alter table public.feature_flags enable row level security;

drop policy if exists "feature_flags: users see own rows" on public.feature_flags;
create policy "feature_flags: users see own rows" on public.feature_flags
  for select using (auth.uid() = user_id);

-- No insert/update/delete policy — service_role (which bypasses RLS
-- entirely) is the only writer, by design (see header).
