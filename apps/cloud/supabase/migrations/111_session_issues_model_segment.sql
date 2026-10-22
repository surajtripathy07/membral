-- ============================================================
-- 111_session_issues_model_segment.sql
-- D-057 (docs/design/session-issue-association.md §5–§6): build work no
-- observed evidence linked can be linked to an issue/PR by the model's reading
-- of the session (lib/memory/session-association.ts). Such a row shows like
-- any other link (tier 'observed' — the build action itself was observed);
-- internally it records how it was linked, so the evaluation, an audit or a
-- rollback can find it:
--   source            'model_segment' when the row's build rung came from a
--                     model segment; NULL for every other row (observed or
--                     extractor rows, and every row written before this).
--   segment_evidence  the segments that linked it: [{from_turn, to_turn,
--                     evidence: [{turn, quote}], reason, claimed_turns}].
--   segment_reason    the segments' reasons, joined (display/audit).
-- Not a user-facing tier.
--
-- WHO WRITES: lib/memory/session-issues.ts writeSessionIssueRows, only while
-- MEMBRAL_SESSION_ASSOC is on (the columns are never sent with it off, so the
-- writer works before this migration is applied). Service-role client.
-- WHO READS: the owner, through the existing code_session_issues select policy.
--
-- Additive and idempotent: nullable columns, no default, no backfill (design
-- §6: no backfill until the flag turns on; then a re-run over candidate
-- sessions). Apply locally first, and to prod only in migration order.
-- Depends on: 099, 103, 108.
--
-- ORDER: apply this BEFORE turning MEMBRAL_SESSION_ASSOC on — with the flag on
-- and the columns missing, every issue-row upsert fails (logged, non-fatal, but
-- the session's rows are not written).
--
-- REVERTING: turn the flag off, then
--   update public.code_session_issues
--     set source = null, segment_evidence = null, segment_reason = null
--     where source = 'model_segment' or segment_evidence is not null;
-- and re-derive the affected sessions (the no-LLM re-derivation writes the
-- observed rows again and drops rungs only a segment raised). Never delete by
-- source alone: an observed row a segment raised carries source too. Then drop
-- the three columns.
-- ============================================================

alter table public.code_session_issues
  add column if not exists source text
    check (source is null or source in ('model_segment')),
  add column if not exists segment_evidence jsonb,
  add column if not exists segment_reason text
    check (segment_reason is null or char_length(segment_reason) <= 500);

comment on column public.code_session_issues.source is
  'D-057: model_segment when the build rung came from the session-issue association (a model segment), NULL otherwise. Internal; not a user-facing tier.';
comment on column public.code_session_issues.segment_evidence is
  'D-057: the model segments that linked this row — [{from_turn, to_turn, evidence: [{turn, quote}], reason, claimed_turns}].';
comment on column public.code_session_issues.segment_reason is
  'D-057: the linking segments'' reasons, joined with " | " (<= 500 chars).';
