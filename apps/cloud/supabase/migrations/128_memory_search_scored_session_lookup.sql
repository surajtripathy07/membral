-- ============================================================
-- 128_memory_search_scored_session_lookup.sql
-- `memory_search_scored` (121): the session start time is read by primary-key lookup, not by a nested-loop join.
--
-- WHY: 121's `base` CTE left-joins `code_sessions` on `cs.id = m.code_session_id and cs.user_id = p_user_id`. The
-- planner estimates the filtered `session_memories` side at ~1,800 rows (actual ~3,700 for the largest project on the
-- local store) and picks a nested loop that Materializes ALL of the user's sessions and filters them per memory row:
-- 3,659 rows x ~816 sessions = 2.98 million rejected join pairs, ~150 ms of the call (`explain (analyze)`: "Rows
-- Removed by Join Filter: 2981668"). With nested loops disabled the same call runs in ~62 ms. This is the recall
-- latency regression: every MCP search and prompt recall on a project of a few thousand records paid it.
--
-- WHAT: the same join as a `left join lateral` subselect keyed on `code_sessions.id` (the primary key, so at most one
-- row) with `limit 1`. The `limit 1` is what matters: without it the planner flattens the subselect back into the same
-- join (measured: identical plan); with it, each memory row looks its session up by index (`code_sessions_id_user_id_key`). Same rows, same columns, same result -- `observed_at` and the
-- `p_since` filter read the same `started_at` (NULL when the memory has no session of this user, as before).
-- Standalone body on the local store: 430 ms -> 68 ms. Nothing else changes: signature, body, grants, `plan_cache_mode`.
--
-- Idempotent: `create or replace` with the same signature.
-- Rollback: re-run 121's `create or replace function` block.
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
  p_since timestamptz default null,
  p_embedding_model text default null,
  p_min_similarity double precision default null
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
language plpgsql
stable
security invoker
set search_path = public, extensions, pg_temp
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  return query
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
        and coalesce(m.embedding_model, 'text-embedding-3-small')
          = coalesce(p_embedding_model, 'text-embedding-3-small')
        then 1 - (m.embedding <=> p_query_embedding)
        else null
      end as similarity
    from public.session_memories m
    left join lateral (
      select c.started_at
      from public.code_sessions c
      where c.id = m.code_session_id and c.user_id = p_user_id
      limit 1
    ) cs on true
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
      or (b.similarity is not null
        and ((p_min_similarity is not null and p_min_similarity <= 0)
          or b.similarity > coalesce(p_min_similarity, 0.3)))
  ),
  ranked as (
    select
      c.*,
      case when c.lex_score is not null
        then row_number() over (order by c.lex_score desc nulls last, c.similarity desc nulls last, c.id)
      end as lex_rank,
      case when c.similarity is not null
        and ((p_min_similarity is not null and p_min_similarity <= 0)
          or c.similarity > coalesce(p_min_similarity, 0.3))
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
end;
$$;

revoke all on function public.memory_search_scored(
  uuid, text, vector, uuid, text[], text, text, boolean, int, timestamptz, text, double precision
) from public;
revoke all on function public.memory_search_scored(
  uuid, text, vector, uuid, text[], text, text, boolean, int, timestamptz, text, double precision
) from anon;
revoke execute on function public.memory_search_scored(
  uuid, text, vector, uuid, text[], text, text, boolean, int, timestamptz, text, double precision
) from authenticated;
grant execute on function public.memory_search_scored(
  uuid, text, vector, uuid, text[], text, text, boolean, int, timestamptz, text, double precision
) to service_role;
