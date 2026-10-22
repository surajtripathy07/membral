-- ============================================================
-- 126_recall_event_empty_reason.sql
-- Goal 2026-10-10 recall precision, §W3b "Membral on Membral" signals.
--
-- memory_recall_events already logs a memory_search call that returned
-- nothing (record_ids = '{}'), but not WHY: the relevance floor dropped weak
-- matches, or nothing matched at all. memory_search computes that reason for
-- the agent (lib/memory/search.ts, MemorySearchResult.reason); this column
-- keeps it on the event so the dogfood signals (lib/memory/dogfood-signals.ts)
-- can count empty-with-reason per session and week.
--
-- * empty_reason — 'below_floor' (candidates existed, none cleared the floor)
--                  or 'no_match' (no candidates). Null on every served event
--                  and on every row before this migration.
--
-- Additive only; RLS unchanged (084's own_rows policy covers the column).
-- The check is added NOT VALID and validated separately: the add takes only a
-- brief ACCESS EXCLUSIVE lock (no scan), and VALIDATE scans under SHARE UPDATE
-- EXCLUSIVE, which does not block reads or inserts.
-- NOTE: `supabase db push` runs this file in ONE transaction, so the ACCESS
-- EXCLUSIVE lock from the add is held through VALIDATE. Acceptable: the table
-- is small and the new column is all NULL, so the scan is near-instant.
-- REVERTING:
--   alter table public.memory_recall_events drop column empty_reason;
--   (dropping the column drops memory_recall_events_empty_reason_check)
-- ============================================================

alter table public.memory_recall_events
  add column if not exists empty_reason text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'memory_recall_events_empty_reason_check'
      and conrelid = 'public.memory_recall_events'::regclass
  ) then
    alter table public.memory_recall_events
      add constraint memory_recall_events_empty_reason_check
        check (empty_reason is null or empty_reason in ('below_floor','no_match')) not valid;
  end if;
end $$;

alter table public.memory_recall_events
  validate constraint memory_recall_events_empty_reason_check;
