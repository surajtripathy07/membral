-- ============================================================
-- 120_memory_text_fts_thread.sql
-- `session_memories.text_fts` indexes the record's `thread` as well as its `text`.
--
-- WHY: `thread` is the per-session topic label extraction assigns (e.g. "W3 prod deploy
-- M1"). A record such as "Deployed main at <sha> to prod after applying migrations
-- 115, 116, 117 and 119" never names its topic in `text`, so a query about a programme
-- name missed it on the lexical arm (measured: absent from the
-- top 15). Lexical arm only: stored embeddings stay text-only (one embedding input
-- for every row, old and new). This migration rewrites `text_fts` for every row, so
-- the lexical arm covers old rows immediately.
--
-- WHAT: drop and re-add the stored generated column with the new expression (the
-- GIN index goes with the column and is rebuilt). `quote_fts` is unchanged.
-- `memory_search_records` (114) and `memory_search_scored` (116/118) read the column
-- `m.text_fts`, not its expression, so neither function changes. Their bodies are
-- not dependency-tracked, so dropping the column does not touch them; it is back
-- before the transaction commits.
--
-- LOCKS: the table rewrite (and its HNSW index) and the GIN index rebuild take an
-- ACCESS EXCLUSIVE lock on session_memories for their whole duration: preamble,
-- prompt recall and memory_search reads block until it commits. Seconds at prod's
-- few thousand rows, but run it off-peak on hosted.
--
-- Idempotent: the column is rebuilt only when its expression does not already
-- mention `thread`; the index is `if not exists`.
-- Rollback: the same block with 114's expression `to_tsvector('english', coalesce(text, ''))`.
-- ============================================================

set search_path = public, extensions;
set local lock_timeout = '5s';
-- Serial index builds: local Docker's /dev/shm is 64 MB (SQLSTATE 53100 on parallel builds).
set local max_parallel_maintenance_workers = 0;

do $$
declare
  v_expr text;
begin
  select pg_get_expr(d.adbin, d.adrelid)
    into v_expr
    from pg_attribute a
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.session_memories'::regclass
     and a.attname = 'text_fts'
     and not a.attisdropped;

  if v_expr is null or v_expr not like '%thread%' then
    alter table public.session_memories drop column if exists text_fts;
    alter table public.session_memories
      add column text_fts tsvector
        generated always as (
          to_tsvector('english', coalesce(thread, '') || ' ' || coalesce(text, ''))
        ) stored;
  end if;
end
$$;

create index if not exists session_memories_text_fts_idx
  on public.session_memories using gin (text_fts);
