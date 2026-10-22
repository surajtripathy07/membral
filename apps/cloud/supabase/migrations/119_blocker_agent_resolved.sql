-- ============================================================
-- 119_blocker_agent_resolved.sql
-- An agent can close a blocker through the MCP tool memory_resolve (#436).
-- Depends on: 086 (retire_reason), 092 (resolution receipt), 113 (harness_session_id)
-- ============================================================
--
-- WHY: memory_resolve retires the caller's live blocker (and its recurrence
-- chain) with retire_reason 'agent_resolved' and the agent's quote in
-- resolution_quote. retire_reason is free text (086, no CHECK), so the new
-- value needs no constraint change. What is new is WHERE the resolution
-- happened: the call arrives before the calling session's transcript is
-- imported, so there is no code_sessions row to put in resolved_by_session_id
-- yet. This column keeps the harness's own session id (Claude Code's
-- SessionStart session_id, read from the preamble event that minted the
-- call's recall_token, migration 113). When that session's transcript is
-- uploaded, the import (lib/memory/agent-resolve.ts) looks for the quote in
-- its turns: found -> resolved_by_session_id and resolution_turn_idx are set;
-- otherwise nothing changes (the row stays retired). NULL on every other row.
-- Additive only.

alter table public.session_memories
  add column if not exists resolved_by_harness_session_id text;

comment on column public.session_memories.resolved_by_harness_session_id is
  'For retire_reason = agent_resolved: the harness session id (code_sessions.source_session_id once imported) that called memory_resolve. NULL otherwise.';

-- The import-time verification (lib/memory/agent-resolve.ts) reads the
-- user's agent_resolved rows still waiting for a receipt, newest first, by
-- retired_at (and by harness session id among those few rows).
create index if not exists session_memories_user_agent_resolved_pending_idx
  on public.session_memories (user_id, retired_at)
  where retire_reason = 'agent_resolved' and resolved_by_session_id is null;
