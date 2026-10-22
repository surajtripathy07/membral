-- 113: memory_recall_events learns WHERE a record was served, and which
-- harness session it was served into (#361, goal W2 item 2.1).
--
-- * surface            — 'mcp' (a memory tool call, every row before this
--                        migration), 'preamble' (the SessionStart push,
--                        GET /api/memory/preamble), 'prompt_hook' (reserved:
--                        no per-prompt hook ships yet).
-- * harness_session_id — the harness's own session id (Claude Code's
--                        SessionStart `session_id`), which equals
--                        code_sessions.source_session_id once that session's
--                        transcript is imported. The preamble fires before
--                        any code_sessions row exists, so this is how the
--                        import-time reconciliation finds the event.
-- * tool               — widened to allow 'preamble'.
-- * influence_checked_at — when lib/memory/influence.ts last computed
--                        influenced_edit / influenced_quote for the row.
--
-- Additive only: existing rows take surface = 'mcp' from the default.

alter table public.memory_recall_events
  add column if not exists surface text not null default 'mcp'
    check (surface in ('mcp','preamble','prompt_hook')),
  add column if not exists harness_session_id text,
  add column if not exists influence_checked_at timestamptz;

alter table public.memory_recall_events
  drop constraint if exists memory_recall_events_tool_check;
alter table public.memory_recall_events
  add constraint memory_recall_events_tool_check
    check (tool in ('memory_search','memory_recall','session_summary','preamble'));

-- The reconciliation looks events up by (user_id, harness_session_id) and by
-- (user_id, code_session_id) right after a session's turns are imported.
create index if not exists memory_recall_events_user_harness_session_idx
  on public.memory_recall_events (user_id, harness_session_id)
  where harness_session_id is not null;
create index if not exists memory_recall_events_user_code_session_idx
  on public.memory_recall_events (user_id, code_session_id)
  where code_session_id is not null;
