-- ============================================================
-- 103_code_session_issues_profile.sql
-- Goal 2026-09-26 W4 / P2 (D-051): a session's issue/MR rows carry what the
-- session OBSERVABLY did on the ref, folded from its turns' structured
-- actions (code_session_turns.props.action, W3) by
-- apps/cloud/src/lib/code-sessions/profile.ts — never the extractor's
-- reading of the transcript. `role` is now DERIVED from these columns
-- (Vocabulary "Role rule"): worked_on <=> review_verb >= reviewed, or
-- build_verb >= committed, or triaged; discussed <=> a model-grounded quote
-- only, a pasted URL with nothing after it, or only viewed/checked_out/edited;
-- referenced <=> a bare mention in passing (turn_share 0).
-- Depends on: 099 (code_session_issues).
-- ============================================================

alter table public.code_session_issues
  add column if not exists review_verb text
    check (review_verb is null or review_verb in ('viewed', 'checked_out', 'reviewed', 'commented', 'approved')),
  add column if not exists build_verb text
    check (build_verb is null or build_verb in ('edited', 'committed', 'pushed', 'opened_mr', 'merged', 'closed')),
  add column if not exists tier text
    check (tier is null or tier in ('observed', 'discussed')),
  -- This ref's share of the session's turns under the focus rule (B15); the
  -- session's cost x turn_share is its estimated cost on the ref (B11).
  add column if not exists turn_share numeric
    check (turn_share is null or (turn_share >= 0 and turn_share <= 1)),
  -- Refs this one was focused together with (a `viewed` while focused on
  -- another ref links to that focus, B15).
  add column if not exists related_to text[];

-- `discussed` joins the role check (B5): shown on the day view with its cost,
-- never counted as open.
alter table public.code_session_issues drop constraint if exists code_session_issues_role_check;
alter table public.code_session_issues
  add constraint code_session_issues_role_check
  check (role in ('worked_on', 'referenced', 'discussed'));
