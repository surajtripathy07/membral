-- ============================================================
-- 091_memory_search_hybrid_rrf.sql
-- Replaces 085's `memory_search_records` scoring. Same signature, same
-- return columns; `leg_score` is now the fused score (higher = better).
--
-- WHY: 085 "fused" the legs with greatest(ts_rank, cosine). ts_rank with
-- normalization 32 lives in ~0.0-0.1 while cosine lives in ~0.3-0.7, so the
-- lexical leg never decided anything; and plainto_tsquery ANDs every term,
-- so a record carrying only some of the query's words had no lexical score
-- at all. Live finding (2026-09-25): `memory_search("pnpm NODE_ENV")` served
-- loosely related env/build records above the exact hits.
--
-- NOW: reciprocal-rank fusion (k = 60, the 044 convention) of two ranked legs
--   - lexical: each query lexeme weighted by its inverse document frequency
--     over this call's filtered records (ln(1 + N/df)), full weight when the
--     lexeme is in `text`, half when only in `quote`. A distinctive term
--     ("pnpm", "node_env" parts) outweighs a common one ("use", "always").
--     OR semantics: matching some of the terms still scores.
--   - semantic: cosine similarity on `embedding` (> 0.3 to enter, as before).
-- The filtered set is scanned once (the user's live records; ~1.5k locally),
-- same shape as 085, so no new index is needed.
-- ============================================================

-- pgvector lives in `extensions` on hosted Supabase; the CLI login role does not
-- have it on its search_path, so resolve `vector` for this file explicitly.
set search_path = public, extensions;

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
      m.*,
      to_tsvector('english', coalesce(m.text, '')) as tv_text,
      to_tsvector('english', coalesce(m.quote, '')) as tv_quote,
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
