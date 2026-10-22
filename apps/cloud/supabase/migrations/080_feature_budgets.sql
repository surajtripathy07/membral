-- ============================================================
-- 080_feature_budgets.sql
-- Per-user, per-feature spend BUDGETS on top of migration 077's on/off
-- switch (issue #128, ADR 0047 v2 — "budgets and teaser").
-- Depends on: 077 (feature_flags), 035 (llm_spend / llm_spend_sum).
-- ============================================================
--
-- WHY: maintainer decision 2026-09-06 (issue #128) — embeddings should be ON
-- for every account by default (bounded by a lifetime budget, then a small
-- daily trickle), while `llm` (the KG/portrait/bridge spend) stays OFF by
-- default with an explicit per-user "teaser" grant (e.g. budget_usd=0.15 —
-- roughly the cost of the latest ~20 chats' pass-1 extraction) before a full,
-- unlimited enable. Migration 077's `enabled` boolean is still the on/off
-- switch; these two new columns are the ORTHOGONAL "how much" on top of it —
-- see lib/feature-flags.ts's checkFeature for how the two combine.
--
-- SEMANTICS (both nullable, both NULL = unlimited, matching migration 035's
-- own "0 is a valid enforcing value" precedent):
--   budget_usd — lifetime USD cap for this (user, feature) pair, summed from
--     llm_spend filtered to the feature's pass group (embeddings: chunk_/
--     conversation_/query_embedding; llm: every other pass — see
--     checkFeature's PASS_GROUPS). Once lifetime spend reaches this, the
--     account is NOT cut off outright if daily_usd is also set — it falls
--     back to that trailing-24h trickle allowance instead (this is the
--     "teaser, then delta" shape from the issue).
--   daily_usd — trailing-24h USD allowance. Either the sole limit (when
--     budget_usd is null) or the post-exhaustion trickle described above.
--
-- Idempotent: `add column if not exists` is safe to re-run.
alter table public.feature_flags
  add column if not exists budget_usd numeric null,
  add column if not exists daily_usd numeric null;

comment on column public.feature_flags.budget_usd is
  'Lifetime USD spend cap for this (user_id, feature), summed from llm_spend over the feature''s pass group. NULL = unlimited. See checkFeature in apps/cloud/src/lib/feature-flags.ts (ADR 0047 v2).';
comment on column public.feature_flags.daily_usd is
  'Trailing-24h USD spend allowance for this (user_id, feature) — the ongoing trickle once budget_usd is exhausted, or the sole limit when budget_usd is null. NULL = unlimited. See checkFeature in apps/cloud/src/lib/feature-flags.ts (ADR 0047 v2).';

-- ------------------------------------------------------------
-- llm_spend_sum gains two OPTIONAL pass-group filters (issue #128):
-- checkFeature needs "sum of cost_usd for THIS user, restricted to (or
-- excluding) a set of pass names" on top of the existing time/run_id
-- filtering — the embeddings budget sums exactly the 3 embedding passes,
-- and the llm budget sums every pass NOT in that set (a denylist, since the
-- llm pass vocabulary grows over time and must not need a migration every
-- time a new KG pass is added). CREATE OR REPLACE with two new trailing
-- DEFAULT NULL params is backward compatible: every existing named-arg
-- caller (checkMonthlyCeiling, the phase-split seed sum) is unaffected.
-- Still server-side (never a client-side fetch-and-reduce — see migration
-- 035's header for why that undercounts past PostgREST's 1000-row cap).
-- ------------------------------------------------------------
-- Postgres treats a different parameter LIST as a distinct overload, even
-- when the leading params match exactly — `create or replace` alone would
-- leave the old 3-arg signature in place alongside this 5-arg one, and two
-- overloads whose optional params overlap makes PostgREST's RPC dispatch
-- ambiguous ("could not choose the best candidate function") for a 3-arg
-- named-parameter call. Drop the old signature first so there is exactly
-- one llm_spend_sum, matching how every other callsite (named args) expects
-- to resolve it.
drop function if exists public.llm_spend_sum(uuid, timestamptz, uuid);

create or replace function public.llm_spend_sum(
  p_user_id uuid,
  p_since timestamptz,
  p_run_id uuid default null,
  p_include_passes text[] default null,
  p_exclude_passes text[] default null
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
    )
    and (p_include_passes is null or pass = any(p_include_passes))
    and (p_exclude_passes is null or pass <> all(p_exclude_passes));
$$;

comment on function public.llm_spend_sum(uuid, timestamptz, uuid, text[], text[]) is
  'Server-side sum of llm_spend.cost_usd for one user. p_run_id set: sums only that run''s rows (p_since ignored). p_run_id null: sums rows with spent_at > p_since. p_include_passes: restrict to these pass names (embeddings budget). p_exclude_passes: exclude these pass names (llm budget — a denylist so new KG passes are covered by default). At most one of include/exclude is normally set. Issue #128 / ADR 0047 v2.';

revoke all on function public.llm_spend_sum(uuid, timestamptz, uuid, text[], text[]) from public;
revoke all on function public.llm_spend_sum(uuid, timestamptz, uuid, text[], text[]) from anon;
revoke all on function public.llm_spend_sum(uuid, timestamptz, uuid, text[], text[]) from authenticated;
grant execute on function public.llm_spend_sum(uuid, timestamptz, uuid, text[], text[]) to service_role;

-- ------------------------------------------------------------
-- Composite index serving the arrival-loop / pass-1 "most recently updated
-- first" candidate order (issue #128 — extraction should prioritize a
-- user's newest conversations first when a budget/incremental cap halts a
-- run mid-corpus, e.g. the teaser's latest-20-chats framing). Mirrors the
-- shape of the existing idx_conversations_embedding_pending partial index
-- (migration history) but unconditional (no partial predicate) since pass1's
-- own convRows scan has no embedding-specific WHERE clause to match.
-- ------------------------------------------------------------
create index if not exists idx_conversations_user_updated_at
  on public.conversations (user_id, updated_at desc);
