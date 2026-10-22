-- ============================================================
-- 092_memory_blocker_resolution_receipt.sql
-- A blocker closed by a LATER session keeps a receipt of what closed it.
-- Depends on: 029 (code_sessions), 084 (session_memories), 086 (retire_reason)
-- ============================================================
--
-- WHY: a blocker was only ever retired when the SAME session resolved it
-- (retire_reason 'resolved_in_session'). A blocker fixed in a later session
-- stayed open forever and kept surfacing in the SessionStart preamble. Tail
-- capture (lib/memory/tail-capture.ts) now asks, after each session's
-- extraction, whether that session resolved any open blocker from an earlier
-- session, and accepts a "yes" only with an evidence quote found verbatim in
-- the resolving session's transcript. The resolved row is retired with
-- retire_reason 'resolved_later' and these three columns hold the receipt:
--   resolved_by_session_id — the code_sessions.id whose transcript closed it
--   resolution_quote       — the verbatim evidence quote
--   resolution_turn_idx    — the turn of that session the quote was found in
-- All nullable; NULL on every other row. `on delete set null` so deleting
-- the resolving session never deletes the (already retired) blocker.

alter table public.session_memories
  add column if not exists resolved_by_session_id uuid
    references public.code_sessions(id) on delete set null,
  add column if not exists resolution_quote text,
  add column if not exists resolution_turn_idx int;

comment on column public.session_memories.resolved_by_session_id is
  'For retire_reason = resolved_later: the code session whose transcript resolved this blocker. NULL otherwise.';
comment on column public.session_memories.resolution_quote is
  'For retire_reason = resolved_later: the verbatim evidence quote from resolved_by_session_id. NULL otherwise.';
comment on column public.session_memories.resolution_turn_idx is
  'For retire_reason = resolved_later: the turn idx in resolved_by_session_id where resolution_quote appears. NULL otherwise.';
