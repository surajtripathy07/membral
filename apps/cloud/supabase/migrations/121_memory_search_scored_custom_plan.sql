-- ============================================================
-- 121_memory_search_scored_custom_plan.sql
-- `memory_search_scored` (118) gets a plan built for each call's actual values.
--
-- WHY: 118's function is `language sql` with a `set search_path` option, so it is never
-- inlined into the caller, and PostgreSQL 17 plans a non-inlined SQL function's body with
-- its arguments as opaque parameters. Under that plan the optional-filter guards
-- (`p_code_project_id is null or ...`, `p_kinds is null or ...`, ...) cannot fold away,
-- so `base` is estimated at 1-2 rows (actual: ~3,400 for one project) and the planner
-- picks nested loops: `lexical` is joined back to `base` row by row, and the `idf`
-- aggregate is re-run once per `base` row. Cost grows with base rows x lexical matches,
-- i.e. with the query's term count. Measured on the local store (5,691 rows, one project
-- of 3,414): 3 query terms 224 ms, 10 terms 1,330 ms, 17 terms 1,884 ms, 153 terms
-- (a long pasted prompt) 6,870 ms. The same body with the values inlined as constants
-- runs in 30, 53, 73 and 410 ms. Prompt-time recall (1.5 s budget) timed out on every
-- prompt longer than a short question.
--
-- WHAT: the same signature, columns, body and result, re-created as `language plpgsql`
-- returning the body through `return query`, with `plan_cache_mode = force_custom_plan`,
-- so every call is planned with its actual argument values (planning is ~1-2 ms).
-- `#variable_conflict use_column`: the RETURNS TABLE names (id, text, kind, ...) are
-- plpgsql variables; every column reference in the body is qualified, and this makes
-- any unqualified one mean the column, as in the SQL function.
--
-- Grants: identical to 118 (service_role only). `create or replace` keeps them; they are
-- re-stated so a fresh database matches.
--
-- Idempotent: `create or replace` with the same signature.
-- Rollback: re-run 118's `create function` block (after `drop function` of this
-- signature), which restores the `language sql` body.
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
