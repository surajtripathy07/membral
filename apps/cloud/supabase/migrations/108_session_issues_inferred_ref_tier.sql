-- ============================================================
-- 108_session_issues_inferred_ref_tier.sql
-- D-053: a build action (edited, committed, pushed) that names no issue or
-- merge request attaches to the ref the developer last named in their own
-- prose before it. The action is observed; only its ref is inferred, so the
-- row says so: code_session_issues.tier accepts 'inferred_ref'
-- (lib/code-sessions/profile.ts writes it, the dashboard labels it "linked
-- from your prompt").
-- Additive and idempotent: the tier check is dropped-if-exists and re-added
-- with a WIDER value set (same pattern as 105 §4). No data changes.
-- Depends on: 103, 105.
--
-- REVERTING: drop code_session_issues_tier_check and re-add
-- ('observed','discussed','inferred') only after rows with tier
-- 'inferred_ref' are gone (re-extract those sessions, or update them to
-- 'observed' — the action was observed).
-- ============================================================

alter table public.code_session_issues drop constraint if exists code_session_issues_tier_check;
alter table public.code_session_issues
  add constraint code_session_issues_tier_check
  check (tier is null or tier in ('observed', 'discussed', 'inferred', 'inferred_ref'));
