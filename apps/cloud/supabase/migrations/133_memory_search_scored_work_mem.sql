-- 133: give memory_search_scored enough work_mem that its materialized `base`
-- CTE (about 1 KB per row x ~2.4k rows) stays in memory.
--
-- Measured on prod with `explain analyze select * from memory_search_scored(...)`: at the default work_mem of
-- ~2 MB the `base` CTE spilled to a temp file and `idf` rescanned it once per query word. With work_mem 16 MB a
-- short prompt went from ~175 ms to ~85 ms and a 60-word prompt from ~127 ms to ~115 ms; the inlined-body plan
-- went from 542 ms to 251 ms with no temp I/O. pg_stat_statements on the PostgREST wrapper showed a 1319 ms mean
-- (3879 ms max) over 252 calls, which exceeds the 1.5 s prompt-recall budget on longer prompts.
--
-- This setting is ALREADY APPLIED ON PROD BY HAND; this migration records it so a fresh database gets the same
-- function setting. It is idempotent: `alter function ... set work_mem` is safe to re-run.
--
-- A later `create or replace function memory_search_scored` replaces the function's settings, so its definition must
-- repeat `set work_mem = '16MB'` or this setting is silently lost.
--
-- Settings only: the body (migration 128) is unchanged. Undo with
--   alter function ... reset work_mem;
-- Hosted Supabase keeps pgvector in `extensions`; the `vector` in the signature resolves on this search_path.
set search_path = public, extensions;
alter function public.memory_search_scored(
  uuid, text, vector, uuid, text[], text, text, boolean, integer, timestamptz, text, double precision
) set work_mem = '16MB';
