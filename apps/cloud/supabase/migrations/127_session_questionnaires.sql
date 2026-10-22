-- ============================================================
-- 127_session_questionnaires.sql
-- Goal 2026-10-10 recall precision, §W3b "Session-end questionnaire,
-- verifiable answers only".
--
-- One row per (session, source): the four questions about the context
-- injected into a coding session, answered by the session itself ('self',
-- uploaded by the CLI after SessionEnd through POST /api/memory/questionnaire)
-- or by the extraction pass's judge ('judge', tail-capture.ts). Agreement per
-- question is computed on read (lib/memory/questionnaire.ts); the self-report
-- is read for that comparison only, never as a metric and never by a recall
-- or serving path.
--
-- * source_session_id — the harness's session id (the self-report can arrive
--   before the session is imported, so this is the join key, not
--   code_session_id).
-- * code_session_id — set when known (always on judge rows).
-- * question_order — the order the questions were asked in ('self'); the
--   judge asks q1..q4.
-- * answers — {q1:[{line, turn, worked_out?, turn_idx?}], q2:…, q3:…, q4:…};
--   every item carries a turn pointer (the app drops items without one).
--
-- WHO WRITES: service role only (lib/memory/write/questionnaire.ts).
-- WHO READS: the owner (select policy); service-role readers filter user_id.
-- Idempotent. No data changes.
--
-- REVERTING:
--   drop table public.session_questionnaires;
-- ============================================================

create table if not exists public.session_questionnaires (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  harness text not null default 'claude-code' check (harness in ('claude-code')),
  source_session_id text not null check (length(source_session_id) between 1 and 200),
  code_session_id uuid references public.code_sessions(id) on delete set null,
  source text not null check (source in ('self','judge')),
  question_order text[] not null,
  answers jsonb not null,
  created_at timestamptz not null default now(),
  unique (user_id, harness, source_session_id, source)
);
create index if not exists session_questionnaires_user_created_idx
  on public.session_questionnaires (user_id, created_at desc);

alter table public.session_questionnaires enable row level security;

drop policy if exists "session_questionnaires_select_own" on public.session_questionnaires;
create policy "session_questionnaires_select_own"
  on public.session_questionnaires for select
  using (user_id = auth.uid());

revoke all on public.session_questionnaires from anon;
revoke insert, update, delete, truncate, references, trigger on public.session_questionnaires from authenticated;
