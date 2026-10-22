-- ============================================================
-- 125_session_feedback_and_served_verdicts.sql
-- Goal 2026-10-10 recall precision, box 9 (a)/(b), §W3b; issue #307.
--
-- Two tables the extraction pass writes, both about Membral ITSELF rather than
-- about the work a session did:
--
-- * session_feedback — what the user or agent said about Membral in a session
--   (a served line was wrong or stale, recall had nothing, injected context was
--   noise, the hook was slow, a recall helped), with its quote and turn. Before
--   prompt v24 these lines were extracted as ordinary decisions/learnings and
--   later served back as facts (#307). They now live in their own table, which
--   no recall or serving path reads: memory_search / memory_recall (MCP),
--   prompt-recall, the preamble, self-recall and every memory_* RPC
--   (memory_search_scored, memory_search_records, memory_anchor_records,
--   memory_title_anchor_records, memory_semantic_duplicates) select from
--   session_memories only, and session_memories' kind check (084) keeps
--   rejecting 'feedback'. No RPC changes here.
--
-- * served_record_verdicts — per session, each record that memory_recall_events
--   says was served into it, judged confirmed / contradicted / unused by the
--   extraction pass, with the quote and turn that show it (D-021: a verdict
--   other than 'unused' carries its receipt; the app drops a quoteless verdict
--   to 'unused' before it gets here, and the check below enforces it).
--
-- WHO WRITES: apps/cloud/src/lib/memory/write/feedback.ts, service role only,
-- from tail-capture.ts. WHO READS: the owner (select policies below); service-
-- role readers always filter on user_id explicitly.
--
-- Depends on: 029 (code_sessions, code_projects), 084 (session_memories,
-- memory_recall_events), 113 (surface values).
-- Idempotent (if not exists / drop policy if exists). No data changes.
--
-- REVERTING:
--   drop table public.served_record_verdicts;
--   drop table public.session_feedback;
-- ============================================================

create table if not exists public.session_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  code_session_id uuid not null references public.code_sessions(id) on delete cascade,
  code_project_id uuid not null references public.code_projects(id) on delete cascade,
  about text not null default 'membral' check (about = 'membral'),
  sentiment text not null check (sentiment in ('wrong','stale','missing','noise','slow','useful')),
  surface text check (surface in ('mcp','preamble','prompt_hook')),
  text text not null,
  quote text not null,
  turn_idx int not null,              -- plain int, no FK (same reason as session_memories, 084)
  turn_role text not null check (turn_role in ('user','assistant')),
  prompt_version text not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  unique (user_id, code_session_id, content_hash)
);
create index if not exists session_feedback_user_created_idx
  on public.session_feedback (user_id, created_at desc);

create table if not exists public.served_record_verdicts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  code_session_id uuid not null references public.code_sessions(id) on delete cascade,
  memory_id uuid not null references public.session_memories(id) on delete cascade,
  -- The first recall event that served the record into this session; events
  -- are pruned after 90 days (084), the verdict outlives them.
  recall_event_id uuid references public.memory_recall_events(id) on delete set null,
  surface text not null check (surface in ('mcp','preamble','prompt_hook')),
  verdict text not null check (verdict in ('confirmed','contradicted','unused')),
  quote text,
  turn_idx int,
  prompt_version text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, code_session_id, memory_id),
  check (verdict = 'unused' or (quote is not null and turn_idx is not null))
);
create index if not exists served_record_verdicts_user_created_idx
  on public.served_record_verdicts (user_id, created_at desc);
create index if not exists served_record_verdicts_user_verdict_idx
  on public.served_record_verdicts (user_id, verdict)
  where verdict <> 'unused';

alter table public.session_feedback       enable row level security;
alter table public.served_record_verdicts enable row level security;

drop policy if exists "session_feedback_select_own" on public.session_feedback;
create policy "session_feedback_select_own"
  on public.session_feedback for select
  using (user_id = auth.uid());

drop policy if exists "served_record_verdicts_select_own" on public.served_record_verdicts;
create policy "served_record_verdicts_select_own"
  on public.served_record_verdicts for select
  using (user_id = auth.uid());

revoke all on public.session_feedback from anon;
revoke all on public.served_record_verdicts from anon;
revoke insert, update, delete, truncate, references, trigger on public.session_feedback from authenticated;
revoke insert, update, delete, truncate, references, trigger on public.served_record_verdicts from authenticated;
