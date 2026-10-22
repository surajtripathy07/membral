-- ============================================================
-- 107_session_memories_priority.sql
-- E2E fix C-6 (U16): the "You said" block and a thread's priority quote read
-- an extraction-time flag instead of an English word list over the quote.
-- Depends on: 084 (session_memories).
-- ============================================================
--
-- WHY a column: the signal is the extractor's reading of the owner's own
-- words ("das muss diese Woche fertig werden" is a priority in any language),
-- produced in the same call that writes the record (prompt
-- memory-extract-v11). lib/threads/open-threads.ts reads it; nothing sorts
-- by it. Rows written before v11 default to false — no backfill guesses.
-- Only a user-turn preference/decision counts (enforced at read time in
-- open-threads.ts, not by a CHECK: one mis-attributed row must never fail
-- its whole insert batch).

alter table public.session_memories
  add column if not exists priority boolean not null default false;

