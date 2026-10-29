-- ============================================================
-- 135_session_memories_source_claude_mem.sql
-- `membral import claude-mem` (goal 2026-10-25 box 3.2) stores a claude-mem
-- observation as a session_memories row with source = 'claude-mem', so a reader
-- can tell an imported, un-quoted record from an extracted one. Widens the
-- source check from ('hook','agent','extractor') to add 'claude-mem'.
--
-- The check was declared inline on the column in 084, so Postgres named it
-- session_memories_source_check. The new check is added NOT VALID (no table scan
-- under the ACCESS EXCLUSIVE lock, only new writes are checked) and validated in
-- its own statement. A migration file runs in one transaction, so the ACCESS
-- EXCLUSIVE lock is held through VALIDATE and the split saves nothing here; the
-- table is small, so the scan is brief. Statements kept as written. Additive:
-- the old app never writes the new value and reads source as text.
-- ============================================================
alter table public.session_memories
  drop constraint if exists session_memories_source_check;
alter table public.session_memories
  add constraint session_memories_source_check
  check (source in ('hook', 'agent', 'extractor', 'claude-mem')) not valid;
alter table public.session_memories
  validate constraint session_memories_source_check;
