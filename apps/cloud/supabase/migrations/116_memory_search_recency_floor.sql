-- ============================================================
-- 116_memory_search_recency_floor.sql
-- `memory_search_scored`: 114's `memory_search_records` plus what memory_search
-- needs for a time bound, a recency boost and a relevance floor (W3).
--
-- NEW FUNCTION, NOT A CHANGED ONE. 114's function is left exactly as it is.
--   * Its return columns cannot grow under `create or replace` (Postgres needs a
--     DROP for a new return type), and dropping it breaks any running build that
--     still calls it until the new app deploy lands.
--   * An overload with the same name plus defaulted params would make a call that
--     names only the old 9 params ambiguous to PostgREST ("could not choose the
--     best candidate function"), i.e. break the rollback build too.
--   A new name keeps every old caller working and makes rollback app-only.
--
-- Same filters, same isolation (`m.user_id = p_user_id`, and the session join is
-- and the supersedes check are also bound to `p_user_id`; only service_role
-- may execute it), same IDF-weighted lexical leg, same 0.3 cosine cut,
-- same RRF and order as 114. Added:
--   p_since         hard lower bound on observed_at (explicit since/days only).
--   similarity      raw cosine of the row vs the query (null with no embedding).
--   lex_score       raw IDF-weighted lexical score (null = no query term matched).
--   lex_hits        distinct query lexemes found in text or quote.
--   query_lexemes   distinct lexemes in the query (same for every row).
--   observed_at     when the record's work happened: the code session's
--                   started_at; created_at for chat records or a session with no
--                   start time. NOT created_at alone: that is extraction time,
--                   and a backfill or --force re-import extracts weeks later.
-- The floor and the recency boost are applied in TS (lib/memory/search.ts), where
-- the constants and their calibration live.
--
-- Rollback: `drop function public.memory_search_scored(uuid, text, vector, uuid,
-- text[], text, text, boolean, int, timestamptz);` after the app no longer calls it.
-- ============================================================

set search_path = public, extensions;

create or replace function public.memory_search_scored(
  p_user_id uuid,
  p_query text,
  p_query_embedding vector(1536) default null,
  p_code_project_id uuid default null,
  p_kinds text[] default null,
  p_scope text default null,
  p_path text default null,
  p_include_retired boolean default false,
  p_limit int default 20,
  p_since timestamptz default null
)
returns table (
  id uuid, code_session_id uuid, code_project_id uuid, agent_id text, source text, kind text,
  text text, quote text, turn_idx int, turn_role text, ref text, ref_kind text,
  branch text, head_sha text, thread text, paths text[], verified boolean, durable boolean,
  observed_durable boolean, recurs_of uuid, recurrence_count int, scope text, confidence real,
  supersedes uuid, retired_at timestamptz, chat_conversation_id uuid, created_at timestamptz,
  leg_score float8,
  similarity float8, lex_score float8, lex_hits int, query_lexemes int, observed_at timestamptz
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  with terms as (
    select distinct t.lex, quote_literal(t.lex)::tsquery as tsq
    from unnest(tsvector_to_array(to_tsvector('english', coalesce(p_query, '')))) as t(lex)
  ),
  base as (
    select
      m.id, m.code_session_id, m.code_project_id, m.agent_id, m.source, m.kind,
      m.text, m.quote, m.turn_idx, m.turn_role, m.ref, m.ref_kind,
      m.branch, m.head_sha, m.thread, m.paths, m.verified, m.durable,
      m.observed_durable, m.recurs_of, m.recurrence_count, m.scope, m.confidence,
      m.supersedes, m.retired_at, m.chat_conversation_id, m.created_at,
      coalesce(cs.started_at, m.created_at) as observed_at,
      m.text_fts as tv_text,
      m.quote_fts as tv_quote,
      case when p_query_embedding is not null
        then 1 - (m.embedding <=> p_query_embedding)
        else null
      end as similarity
    from public.session_memories m
    left join public.code_sessions cs
      on cs.id = m.code_session_id and cs.user_id = p_user_id
    where m.user_id = p_user_id
      and (p_code_project_id is null or m.code_project_id = p_code_project_id)
      and (p_kinds is null or m.kind = any(p_kinds))
      and (p_scope is null or m.scope = p_scope)
      and (p_path is null or m.paths @> array[p_path])
      and (p_since is null or coalesce(cs.started_at, m.created_at) >= p_since)
      and (p_include_retired or m.retired_at is null)
      and (
        p_include_retired
        or not exists (
          select 1 from public.session_memories s2
          where s2.supersedes = m.id and s2.user_id = p_user_id and s2.retired_at is null
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
      sum(case when b.tv_text @@ i.tsq then i.w else 0.5 * i.w end) as lex_score,
      count(*)::int as lex_hits
    from base b
    join idf i on b.tv_text @@ i.tsq or b.tv_quote @@ i.tsq
    group by b.id
  ),
  candidates as (
    select b.*, l.lex_score, l.lex_hits
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
    f.rrf::float8 as leg_score,
    f.similarity::float8 as similarity,
    f.lex_score::float8 as lex_score,
    coalesce(f.lex_hits, 0) as lex_hits,
    (select count(*) from terms)::int as query_lexemes,
    f.observed_at
  from fused f
  order by f.rrf desc, f.created_at desc, f.id
  limit greatest(p_limit, 1);
$$;

revoke all on function public.memory_search_scored(
  uuid, text, vector, uuid, text[], text, text, boolean, int, timestamptz
) from public;
revoke all on function public.memory_search_scored(
  uuid, text, vector, uuid, text[], text, text, boolean, int, timestamptz
) from anon;
revoke execute on function public.memory_search_scored(
  uuid, text, vector, uuid, text[], text, text, boolean, int, timestamptz
) from authenticated;
grant execute on function public.memory_search_scored(
  uuid, text, vector, uuid, text[], text, text, boolean, int, timestamptz
) to service_role;
