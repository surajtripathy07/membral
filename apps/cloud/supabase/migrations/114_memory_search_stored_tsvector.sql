-- ============================================================
-- 114_memory_search_stored_tsvector.sql
-- `memory_search_records` (091) without the per-row, per-query to_tsvector.
-- Rollback: re-apply 091's function FIRST, then drop text_fts/quote_fts (SQL function
-- bodies are not dependency-tracked, so dropping the columns first breaks the RPC at runtime).
-- Same signature, same return columns, same scoring, same order and
-- tie-breaks: only WHERE the tsvectors come from changes.
--
-- WHY: on prod (one user, ~2.4k session_memories rows) the RPC took 2.5 s of
-- execution (EXPLAIN ANALYZE: function scan 2503 ms, temp read=660
-- written=220). 091's header said "no new index is needed" because the
-- filtered set is scanned once -- true, but every call re-parsed `text` and
-- `quote` of every one of the user's records twice (to_tsvector is the
-- expensive part), and `base` carried `m.*`, i.e. the 1536-dim `embedding`
-- (~6 KB/row), into a CTE that is referenced several times and therefore
-- materialised -- past work_mem, so it spilled to temp files.
--
-- NOW:
--   1. Two stored generated columns, `text_fts` and `quote_fts`, with
--      EXACTLY the expressions 091 computed at query time
--      (`to_tsvector('english', coalesce(<col>, ''))`) -- so every `@@` test
--      sees the same lexemes and the scores are bit-identical. Naming follows
--      the existing `fts` generated columns (001 conversations, 044
--      code_session_turns, 045 conversation_chunks).
--   2. GIN indexes on both, for any future direct `@@` filter. Honest note:
--      the RPC's `base` CTE is materialised (it is read by idf, lexical and
--      candidates), so the planner does not use these indexes inside this
--      function today; the win here is (1) and (3), not the index.
--   3. `base` selects the columns the function returns plus the two
--      tsvectors and the cosine similarity -- no `embedding` -- so the
--      materialised CTE stays small. The cosine is still computed per row in
--      `base` exactly as before (the vector arm needs the similarity of every
--      filtered row for its > 0.3 cut and its rank; the HNSW index from 084
--      cannot serve "every row above a threshold, filtered by user", and at a
--      few thousand rows a sequential distance computation is cheap).
--
-- LOCKS: `add column ... generated always as (...) stored` rewrites the table
-- (and rebuilds its indexes, including 084's HNSW) under an ACCESS EXCLUSIVE
-- lock -- reads and writes on session_memories wait for it. At ~2.4k rows on
-- prod that is a short block (seconds at most, dominated by the HNSW
-- rebuild); extraction writes that arrive meanwhile wait, they do not fail.
-- The GIN builds are plain `create index` (SHARE lock: blocks writes, not
-- reads) -- not CONCURRENTLY, because the migration runner wraps the file in
-- a transaction.
--
-- Additive and re-runnable: `if not exists` on the columns and indexes,
-- `create or replace` on the function; grants restated as in 091.
-- ============================================================

-- pgvector lives in `extensions` on hosted Supabase; the CLI login role does not
-- have it on its search_path, so resolve `vector` for this file explicitly.
set search_path = public, extensions;

-- One statement, so the table (and its HNSW index) is rewritten once, not twice.
-- Fail fast instead of queueing every read behind the ACCESS EXCLUSIVE lock.
set lock_timeout = '5s';
-- Serial index builds: a parallel HNSW/GIN build needs a dynamic shared memory segment larger
-- than a small instance's /dev/shm (local Docker: 64 MB, failed with SQLSTATE 53100).
set max_parallel_maintenance_workers = 0;

alter table public.session_memories
  add column if not exists text_fts tsvector
    generated always as (to_tsvector('english', coalesce(text, ''))) stored,
  add column if not exists quote_fts tsvector
    generated always as (to_tsvector('english', coalesce(quote, ''))) stored;

create index if not exists session_memories_text_fts_idx
  on public.session_memories using gin (text_fts);
create index if not exists session_memories_quote_fts_idx
  on public.session_memories using gin (quote_fts);

create or replace function public.memory_search_records(
  p_user_id uuid,
  p_query text,
  p_query_embedding vector(1536) default null,
  p_code_project_id uuid default null,
  p_kinds text[] default null,
  p_scope text default null,
  p_path text default null,
  p_include_retired boolean default false,
  p_limit int default 20
)
returns table (
  id uuid, code_session_id uuid, code_project_id uuid, agent_id text, source text, kind text,
  text text, quote text, turn_idx int, turn_role text, ref text, ref_kind text,
  branch text, head_sha text, thread text, paths text[], verified boolean, durable boolean,
  observed_durable boolean, recurs_of uuid, recurrence_count int, scope text, confidence real,
  supersedes uuid, retired_at timestamptz, chat_conversation_id uuid, created_at timestamptz,
  leg_score float8
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  with terms as (
    select distinct t.lex, quote_literal(t.lex)::tsquery as tsq -- the lexeme verbatim, no re-parse
    from unnest(tsvector_to_array(to_tsvector('english', coalesce(p_query, '')))) as t(lex)
  ),
  base as (
    select
      m.id, m.code_session_id, m.code_project_id, m.agent_id, m.source, m.kind,
      m.text, m.quote, m.turn_idx, m.turn_role, m.ref, m.ref_kind,
      m.branch, m.head_sha, m.thread, m.paths, m.verified, m.durable,
      m.observed_durable, m.recurs_of, m.recurrence_count, m.scope, m.confidence,
      m.supersedes, m.retired_at, m.chat_conversation_id, m.created_at,
      m.text_fts as tv_text,   -- 114: stored, = to_tsvector('english', coalesce(text, ''))
      m.quote_fts as tv_quote, -- 114: stored, = to_tsvector('english', coalesce(quote, ''))
      case when p_query_embedding is not null
        then 1 - (m.embedding <=> p_query_embedding)
        else null
      end as similarity
    from public.session_memories m
    where m.user_id = p_user_id
      and (p_code_project_id is null or m.code_project_id = p_code_project_id)
      and (p_kinds is null or m.kind = any(p_kinds))
      and (p_scope is null or m.scope = p_scope)
      and (p_path is null or m.paths @> array[p_path])
      and (p_include_retired or m.retired_at is null)
      and (
        p_include_retired
        or not exists (
          select 1 from public.session_memories s2
          where s2.supersedes = m.id and s2.retired_at is null
        )
      )
  ),
  idf as (
    select
      t.lex,
      t.tsq,
      ln(1 + (select count(*) from base)::float8 / greatest(count(*), 1)) as w
    from terms t
    join base b on b.tv_text @@ t.tsq or b.tv_quote @@ t.tsq
    group by t.lex, t.tsq
  ),
  lexical as (
    select
      b.id,
      sum(case when b.tv_text @@ i.tsq then i.w else 0.5 * i.w end) as lex_score
    from base b
    join idf i on b.tv_text @@ i.tsq or b.tv_quote @@ i.tsq
    group by b.id
  ),
  candidates as (
    select b.*, l.lex_score
    from base b
    left join lexical l on l.id = b.id
    where l.lex_score is not null
      or (b.similarity is not null and b.similarity > 0.3)
  ),
  ranked as (
    select
      c.*,
      case when c.lex_score is not null
        then row_number() over (order by c.lex_score desc nulls last, c.similarity desc nulls last, c.id)
      end as lex_rank,
      case when c.similarity is not null and c.similarity > 0.3
        then row_number() over (order by c.similarity desc nulls last, c.id)
      end as sem_rank
    from candidates c
  ),
  fused as (
    select
      r.*,
      coalesce(1.0 / (60 + r.lex_rank), 0) + coalesce(1.0 / (60 + r.sem_rank), 0) as rrf
    from ranked r
  )
  select
    f.id, f.code_session_id, f.code_project_id, f.agent_id, f.source, f.kind,
    f.text, f.quote, f.turn_idx, f.turn_role, f.ref, f.ref_kind,
    f.branch, f.head_sha, f.thread, f.paths, f.verified, f.durable,
    f.observed_durable, f.recurs_of, f.recurrence_count, f.scope, f.confidence,
    f.supersedes, f.retired_at, f.chat_conversation_id, f.created_at,
    f.rrf::float8 as leg_score
  from fused f
  order by f.rrf desc, f.created_at desc, f.id
  limit greatest(p_limit, 1);
$$;

revoke all on function public.memory_search_records(
  uuid, text, vector, uuid, text[], text, text, boolean, int
) from public;
revoke all on function public.memory_search_records(
  uuid, text, vector, uuid, text[], text, text, boolean, int
) from anon;
grant execute on function public.memory_search_records(
  uuid, text, vector, uuid, text[], text, text, boolean, int
) to service_role;
