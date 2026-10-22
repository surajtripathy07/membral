-- ============================================================
-- 099_code_session_issues.sql
-- Issues and merge requests a coding session worked on or mentioned, as the
-- memory extractor read them from the session itself. Feeds
-- /code/stats/issues: a session's cost is split across its worked_on rows;
-- referenced rows are listed as mentions with no cost.
-- Depends on: 029 (code_sessions).
-- ============================================================
--
-- WHO WRITES: apps/cloud/src/lib/memory/tail-capture.ts (via write.ts's
-- writeSessionIssues), service-role client, after grounding: a row exists
-- only when its evidence_quote was found in the session's own turns and
-- contains the issue number. A run that covers the session from its first
-- turn replaces the session's rows; a tail run adds to them.
-- WHO READS: the owner (select policy below), via /api/agent-stats/issues.
--
-- ref is qualified: "group/project#123", "owner/repo#45", a URL, or — when
-- the session showed only a bare "#N" — "<code_projects.repo_identity>#N",
-- so #123 in two repos never merge.

create table if not exists public.code_session_issues (
  id bigint generated always as identity primary key,
  session_id uuid not null references public.code_sessions (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  ref text not null check (char_length(ref) between 1 and 500),
  number int not null check (number >= 0),
  kind text not null check (kind in ('issue', 'merge_request')),
  role text not null check (role in ('worked_on', 'referenced')),
  evidence_quote text not null check (char_length(evidence_quote) <= 500),
  turn_idx int not null,
  created_at timestamptz not null default now(),
  unique (session_id, ref, kind, role)
);

create index if not exists code_session_issues_user_idx
  on public.code_session_issues (user_id);

alter table public.code_session_issues enable row level security;

drop policy if exists "code_session_issues_select_own" on public.code_session_issues;
create policy "code_session_issues_select_own"
  on public.code_session_issues for select
  to authenticated
  using (user_id = auth.uid());

revoke all on public.code_session_issues from anon;
revoke insert, update, delete on public.code_session_issues from authenticated;
