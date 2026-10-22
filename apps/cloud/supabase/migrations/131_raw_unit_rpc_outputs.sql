-- ============================================================
-- 131_raw_unit_rpc_outputs.sql
-- What the I33 read path (src/lib/memory/raw-units/search, PR 4) needs beyond migration 129's RPC outputs.
-- Design: docs/design/i33-port.md D2 (pools), D4 (cover), section 5 PR 4. No table change.
-- Depends on: 129 (session_raw_units, memory_raw_pools, memory_raw_cover), 029 (code_sessions.started_at).
--
-- `memory_raw_pools` gains four output columns (parameters and existing columns unchanged; the body is 129's):
--   session_time    code_sessions.ended_at of the unit's session, started_at when it has not ended (the served line prints
--                   its day; the lab's session_time_iso is the session's end).
--   lex_hits        distinct query lexemes found in the row's `fts` or in its session's title (the records floor's
--                   lexical evidence, as `memory_search_scored` counts them; every row of a call has the same
--                   query_lexemes).
--   query_lexemes   distinct lexemes of the query (0 when the query has none).
--   full_text       the whole turn, R3 rows only (null elsewhere): the lexical field and the snippet source.
--
-- `memory_raw_pools` ranks the lexical leg of R1 (c700) and R2 (win) as the lab's `scoredCandidates` does, not by
-- ts_rank_cd: score = the sum over the query's lexemes found in the row of ln(1 + N / df), where N is the user's count of
-- units of that kind and df the count of them holding the lexeme; ties break on similarity (descending), then id. A lexeme
-- is "found" in a row when its `fts` holds it or its session's title (code_sessions.title, english) does: the title is
-- matched at query time, not stored in `fts`. R3 (turn) uses native ts_rank_cd (design D3) over the turn's own text
-- (full_text, else text): `fts` holds text then full_text, so ranking `fts` itself would count a turn's first 1000
-- characters twice and rank differently from the lab. Re-parsing every matching turn is the cost, so only the best 1000
-- by the stored `fts` are re-ranked.
--
-- Leg limits: the lab's legs are untruncated (candidate = lexical hit or similarity above the cut). Each leg here keeps
-- 1000 / 2000 / 1000 (R1 / R2 / R3) rows: on the dev sample the pools equal the lab's on 20 / 18 / 18 of 20 questions,
-- against 1 / 1 / 1 at the earlier 180 / 380 / 180, and an unbounded leg reproduces 20 / 19 / 20 but costs about 4.5 s
-- (p95, heavy user, 357k units) against about 0.95 s here.
--
-- `memory_raw_cover` gains two output columns and two behaviours:
--   code_session_id the unit's session (the caller prints its first 8 characters).
--   turn_len        the turn's uncapped piece length, from the turn row's `parts` ({"turn_len": n}); turn rows only.
--   kind 'turn'     NEW: the turn row of each win / turn unit itself (its `turn_text` is what window expansion and the
--                   snippet part read); one row per distinct turn row.
--   kind 'neighbour' now returns the STORED previous and next turn rows of a win / turn unit (nearest lower and higher
--                   turn_idx of the session, as the lab's per-session turn order), not turn_idx - 1 / + 1: turns without
--                   a row (thinking-only, empty) leave gaps. c700 units get none (nothing reads them). One row per
--                   distinct turn row.
--
-- NEW `memory_raw_term_stats(p_user_id, p_terms)`: document frequencies for the whole-turn snippet's idf. One row per
-- term (df = the user's turn rows whose `fts` matches the english-stemmed term) and one row with term null carrying
-- the count of the user's turn rows. This is Postgres-lexeme df, not the lab's `terms()`-token df (D3: native ranking).
--
-- Return types change, which `create or replace` cannot do, so the two 129 functions are dropped and recreated (same
-- parameters, same grants: security invoker, pinned search_path, force_custom_plan, execute for service_role only).
-- Rollback: re-run the function definitions of migration 129 and drop memory_raw_term_stats.
-- ============================================================

set search_path = public, extensions;

drop function if exists public.memory_raw_pools(uuid, text, vector, text, double precision, uuid, boolean);
drop function if exists public.memory_raw_cover(uuid, uuid[], uuid[]);
drop function if exists public.memory_raw_term_stats(uuid, text[]);
-- ------------------------------------------------------------
-- memory_raw_pools
-- ------------------------------------------------------------
-- Load pgvector into this session first: hnsw.* are placeholder GUCs until the library is loaded, and a
-- non-superuser (the local stack applies migrations as `postgres`) cannot SET a placeholder in CREATE FUNCTION.
do $$ begin perform '[0]'::vector; end $$;

create function public.memory_raw_pools(
  p_user_id uuid,
  p_query text,
  p_query_embedding vector(1536) default null,
  p_embedding_model text default null,
  p_min_similarity double precision default null,
  p_code_project_id uuid default null,
  p_want_r23 boolean default true
)
returns table (
  pool text, id uuid, code_session_id uuid, code_project_id uuid, unit text, ord int,
  turn_idx int, turn_from int, turn_to int, parts jsonb, win int4range, text text,
  similarity float8, lex_score float8, sem_rank int, lex_rank int, rrf float8,
  session_time timestamptz, lex_hits int, query_lexemes int, full_text text
)
language plpgsql
stable
security invoker
set search_path = public, extensions, pg_temp
set plan_cache_mode = force_custom_plan
set hnsw.ef_search = 400
set hnsw.iterative_scan = 'relaxed_order'
as $$
#variable_conflict use_column
begin
  return query
  with cfg(pool, k) as (
    values ('r1', 60), ('r2', 160), ('r3', 60)
  ),
  active as (
    select c.pool, c.k from cfg c where c.pool = 'r1' or p_want_r23
  ),
  qt as (
    -- Each lexeme is quoted for tsquery input: backslash and single quote doubled, wrapped in single quotes
    -- (quote_literal would emit an E'..' string for a backslash, which tsquery cannot parse).
    -- tsq is the OR of all of them (the lexical leg); tqs the same lexemes one tsquery each (the lex_hits count).
    select nullif(string_agg('''' || replace(replace(t.lex, '\', '\\'), '''', '''''') || '''', ' | '), '')::tsquery as tsq,
           array_agg(('''' || replace(replace(t.lex, '\', '\\'), '''', '''''') || '''')::tsquery order by t.lex collate "C") as tqs
    from (
      select distinct l.lex
      from unnest(tsvector_to_array(to_tsvector('english', coalesce(p_query, '')))) as l(lex)
    ) t
  ),
  -- Each leg is written per unit with a literal unit and LIMIT: with the unit and limit coming from a lateral join the
  -- planner cannot cost the filtered HNSW scan and picks a bitmap scan plus a sort of every row of the user (measured:
  -- 3.9 s on 357k units, against 22-33 ms for the literal form).
  dense as (
    select 'r1'::text as pool, d.id, d.similarity, d.ukey from (
      select u.id, 1 - (u.embedding <=> p_query_embedding) as similarity, (left(u.code_session_id::text, 8) || '-' || coalesce(case when u.unit = 'turn' then u.turn_idx else u.ord end, 0)::text) as ukey
      from public.session_raw_units u
      where u.user_id = p_user_id and u.unit = 'c700' and u.embedding is not null
        and p_query_embedding is not null
        and (p_embedding_model is null or u.embedding_model = p_embedding_model)
        and (p_code_project_id is null or u.code_project_id = p_code_project_id)
      order by u.embedding <=> p_query_embedding
      limit 1000
    ) d
    union all
    select 'r2'::text as pool, d.id, d.similarity, d.ukey from (
      select u.id, 1 - (u.embedding <=> p_query_embedding) as similarity, (left(u.code_session_id::text, 8) || '-' || coalesce(case when u.unit = 'turn' then u.turn_idx else u.ord end, 0)::text) as ukey
      from public.session_raw_units u
      where u.user_id = p_user_id and u.unit = 'win' and u.embedding is not null
        and p_query_embedding is not null
        and p_want_r23
        and (p_embedding_model is null or u.embedding_model = p_embedding_model)
        and (p_code_project_id is null or u.code_project_id = p_code_project_id)
      order by u.embedding <=> p_query_embedding
      limit 2000
    ) d
    union all
    select 'r3'::text as pool, d.id, d.similarity, d.ukey from (
      select u.id, 1 - (u.embedding <=> p_query_embedding) as similarity, (left(u.code_session_id::text, 8) || '-' || coalesce(case when u.unit = 'turn' then u.turn_idx else u.ord end, 0)::text) as ukey
      from public.session_raw_units u
      where u.user_id = p_user_id and u.unit = 'turn' and u.embedding is not null
        and p_query_embedding is not null
        and p_want_r23
        and (p_embedding_model is null or u.embedding_model = p_embedding_model)
        and (p_code_project_id is null or u.code_project_id = p_code_project_id)
      order by u.embedding <=> p_query_embedding
      limit 1000
    ) d
  ),
  ql as (
    select q.tq, q.ord::int as ord
    from qt, unnest(coalesce(qt.tqs, '{}'::tsquery[])) with ordinality as q(tq, ord)
  ),
  -- Sessions whose title holds a query lexeme (one row per session and lexeme).
  tt as materialized (
    select cs.id as sid, ql.ord
    from public.code_sessions cs
    cross join lateral (select to_tsvector('english', cs.title) as v) tv
    cross join ql
    where cs.user_id = p_user_id and cs.title is not null and tv.v @@ ql.tq
  ),
  -- Lexeme weights per unit kind: ln(1 + N / df), df = rows holding the lexeme in `fts` plus rows whose `fts` lacks it
  -- but whose session title has it (the two counts are separate so the first can use the GIN index).
  idf as materialized (
    select k.unit, ql.ord, ql.tq, ln(1 + k.n::float8 / (d1.n + d2.n)) as w
    from (
      select x.unit, count(*) as n from public.session_raw_units x
      where x.user_id = p_user_id and x.unit in ('c700', 'win') group by x.unit
    ) as k
    cross join ql
    cross join lateral (
      select count(*) as n from public.session_raw_units x
      where x.user_id = p_user_id and x.unit = k.unit and x.fts @@ ql.tq
    ) d1
    cross join lateral (
      select count(*) as n from public.session_raw_units x
      where x.user_id = p_user_id and x.unit = k.unit and not (x.fts @@ ql.tq)
        and x.code_session_id in (select t.sid from tt t where t.ord = ql.ord)
    ) d2
    where d1.n + d2.n > 0
  ),
  -- Lexical score per R1 / R2 row: the sum of the weights of the query lexemes the row holds in `fts` (one GIN lookup
  -- per lexeme) or, failing that, whose session title holds them. Summed in query-lexeme order, as the lab does.
  hits as (
    select u.id, u.unit, i.ord, i.w
    from idf i
    join public.session_raw_units u on u.user_id = p_user_id and u.unit = i.unit and u.fts @@ i.tq
    where (i.unit = 'c700' or p_want_r23)
      and (p_code_project_id is null or u.code_project_id = p_code_project_id)
    union all
    select u.id, u.unit, i.ord, i.w
    from idf i
    join public.session_raw_units u on u.user_id = p_user_id and u.unit = i.unit and not (u.fts @@ i.tq)
      and u.code_session_id in (select t.sid from tt t where t.ord = i.ord)
    where (i.unit = 'c700' or p_want_r23)
      and (p_code_project_id is null or u.code_project_id = p_code_project_id)
  ),
  scored0 as (
    select h.id, h.unit, sum(h.w order by h.ord)::float8 as lex_score
    from hits h group by h.id, h.unit
  ),
  -- Only the rows that can reach a leg (ties at the cut kept) pay for a cosine and a key.
  scored as (
    select r.id, r.unit, (left(u.code_session_id::text, 8) || '-' || coalesce(case when u.unit = 'turn' then u.turn_idx else u.ord end, 0)::text) as ukey,
           r.lex_score, 1 - (u.embedding <=> p_query_embedding) as tie_sim
    from (
      select s.*, rank() over (partition by s.unit order by s.lex_score desc) as rk from scored0 s
    ) r
    join public.session_raw_units u on u.id = r.id and u.user_id = p_user_id
    where r.rk <= case r.unit when 'c700' then 1000 else 2000 end
  ),
  lex as (
    select 'r1'::text as pool, l.id, l.ukey, l.lex_score, row_number() over (order by l.lex_score desc, l.tie_sim desc nulls last, l.ukey collate "C") as lex_pos
    from (
      select s.id, s.ukey, s.lex_score, s.tie_sim from scored s where s.unit = 'c700'
      order by s.lex_score desc, s.tie_sim desc nulls last, s.ukey collate "C"
      limit 1000
    ) l
    union all
    select 'r2'::text as pool, l.id, l.ukey, l.lex_score, row_number() over (order by l.lex_score desc, l.tie_sim desc nulls last, l.ukey collate "C") as lex_pos
    from (
      select s.id, s.ukey, s.lex_score, s.tie_sim from scored s where s.unit = 'win' and p_want_r23
      order by s.lex_score desc, s.tie_sim desc nulls last, s.ukey collate "C"
      limit 2000
    ) l
    union all
    select 'r3'::text as pool, l.id, l.ukey, l.lex_score, row_number() over (order by l.lex_score desc, l.ukey collate "C") as lex_pos
    from (
      select u.id, (left(u.code_session_id::text, 8) || '-' || coalesce(case when u.unit = 'turn' then u.turn_idx else u.ord end, 0)::text) collate "C" as ukey, ts_rank_cd(to_tsvector('english', public.session_raw_units_fts_src(null, coalesce(u.full_text, u.text))), qt.tsq)::float8 as lex_score
      from (
        -- The lab ranks over the turn's own text, `fts` holds it twice (text then full_text), so the exact rank re-parses
        -- the text. Re-parsing every matching turn is the cost: only the best R3_PRE by the stored `fts` are re-ranked.
        select c.* from public.session_raw_units c, qt
        where qt.tsq is not null and c.user_id = p_user_id and c.unit = 'turn' and c.fts @@ qt.tsq and p_want_r23
          and (p_code_project_id is null or c.code_project_id = p_code_project_id)
        order by ts_rank_cd(c.fts, qt.tsq) desc
        limit 1000 -- r3pre
      ) u, qt
      order by lex_score desc, ukey
      limit 1000
    ) l
  ),
  joined as (
    select coalesce(d.pool, l.pool) as pool, coalesce(d.id, l.id) as id, coalesce(d.ukey, l.ukey) as ukey,
           d.similarity, l.lex_score, l.lex_pos
    from dense d
    full join lex l on l.pool = d.pool and l.id = d.id
  ),
  ranked as (
    select
      j.*,
      case when j.similarity is not null
        and ((p_min_similarity is not null and p_min_similarity <= 0)
          or j.similarity > coalesce(p_min_similarity, 0.3))
        then row_number() over (
          partition by j.pool
          order by (j.similarity is not null
            and ((p_min_similarity is not null and p_min_similarity <= 0)
              or j.similarity > coalesce(p_min_similarity, 0.3))) desc,
            j.similarity desc nulls last, j.ukey collate "C")
      end as sem_rank,
      j.lex_pos as lex_rank
    from joined j
  ),
  fused as (
    select
      r.*,
      coalesce(1.0 / (60 + r.lex_rank), 0) + coalesce(1.0 / (60 + r.sem_rank), 0) as rrf
    from ranked r
    where r.lex_rank is not null or r.sem_rank is not null
  ),
  top as (
    select f.*, row_number() over (partition by f.pool order by f.rrf desc, f.ukey collate "C") as pos
    from fused f
  )
  select
    t.pool, u.id, u.code_session_id, u.code_project_id, u.unit, u.ord,
    u.turn_idx, u.turn_from, u.turn_to, u.parts, u.win, u.text,
    -- A row the dense leg did not return still carries its cosine (the floors read it), as the lab's scoredCandidates does.
    coalesce(t.similarity, case when p_query_embedding is not null and u.embedding is not null
      and (p_embedding_model is null or u.embedding_model = p_embedding_model)
      then 1 - (u.embedding <=> p_query_embedding) end)::float8, t.lex_score::float8, t.sem_rank::int, t.lex_rank::int, t.rrf::float8,
    coalesce(cs.ended_at, cs.started_at), h.n, coalesce(cardinality(qt.tqs), 0)::int,
    case when t.pool = 'r3' then u.full_text end
  from top t
  join active a on a.pool = t.pool
  join public.session_raw_units u on u.id = t.id and u.user_id = p_user_id
  left join public.code_sessions cs on cs.id = u.code_session_id and cs.user_id = p_user_id
  cross join qt
  cross join lateral (
    select count(*)::int as n
    from ql q
    where u.fts @@ q.tq or exists (select 1 from tt t where t.sid = u.code_session_id and t.ord = q.ord)
  ) h
  where t.pos <= a.k
  order by t.pool, t.rrf desc, t.ukey collate "C";
end;
$$;

revoke all on function public.memory_raw_pools(
  uuid, text, vector, text, double precision, uuid, boolean
) from public;
revoke all on function public.memory_raw_pools(
  uuid, text, vector, text, double precision, uuid, boolean
) from anon;
revoke execute on function public.memory_raw_pools(
  uuid, text, vector, text, double precision, uuid, boolean
) from authenticated;
grant execute on function public.memory_raw_pools(
  uuid, text, vector, text, double precision, uuid, boolean
) to service_role;

-- ------------------------------------------------------------
-- memory_raw_cover
-- ------------------------------------------------------------
create function public.memory_raw_cover(
  p_user_id uuid,
  p_unit_ids uuid[],
  p_record_ids uuid[]
)
returns table (
  kind text, a_id uuid, b_id uuid, cosine float8, turn_idx int, turn_text text,
  code_session_id uuid, turn_len int
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
  with us as materialized (
    select u.id, u.code_session_id, u.unit, u.turn_idx as unit_turn,
           l2_normalize(u.embedding) as embedding, u.embedding_model,
           coalesce(u.turn_from, u.turn_idx) as t_from, coalesce(u.turn_to, u.turn_idx) as t_to
    from public.session_raw_units u
    where u.user_id = p_user_id and u.id = any(coalesce(p_unit_ids, '{}'::uuid[]))
  ),
  rs as materialized (
    select m.id, l2_normalize(m.embedding) as embedding, m.embedding_model
    from public.session_memories m
    where m.user_id = p_user_id and m.id = any(coalesce(p_record_ids, '{}'::uuid[]))
      and m.embedding is not null
  )
  select 'unit_record'::text, a.id, b.id, (1 - (a.embedding <=> b.embedding))::float8, null::int, null::text,
         null::uuid, null::int
  from us a
  join rs b on a.embedding is not null
    and coalesce(b.embedding_model, 'text-embedding-3-small') = coalesce(a.embedding_model, 'text-embedding-3-small')
  where 1 - (a.embedding <=> b.embedding) >= 0.86
  union all
  select 'unit_unit'::text, a.id, b.id, (1 - (a.embedding <=> b.embedding))::float8, null::int, null::text,
         null::uuid, null::int
  from us a
  join us b on a.id < b.id and a.embedding is not null and b.embedding is not null
    and a.embedding_model is not distinct from b.embedding_model
  where 1 - (a.embedding <=> b.embedding) >= 0.86
  union all
  -- the turn row of each win / turn unit itself
  (select distinct on (n.id)
         'turn'::text, a.id, n.id, null::float8, n.turn_idx, n.turn_text, n.code_session_id,
         (n.parts ->> 'turn_len')::int
  from us a
  join public.session_raw_units n
    on n.code_session_id = a.code_session_id
   and n.user_id = p_user_id
   and n.unit = 'turn'
   and n.turn_idx = a.unit_turn
  where a.unit in ('win', 'turn')
  order by n.id, a.id)
  union all
  -- the stored previous and next turn rows of each win / turn unit
  (select distinct on (nb.id)
         'neighbour'::text, a.id, nb.id, null::float8, nb.turn_idx, nb.turn_text, nb.code_session_id,
         (nb.parts ->> 'turn_len')::int
  from us a
  cross join lateral (
    (select n.id, n.turn_idx, n.turn_text, n.code_session_id, n.parts
     from public.session_raw_units n
     where n.code_session_id = a.code_session_id and n.user_id = p_user_id and n.unit = 'turn'
       and n.turn_idx < a.t_from
     order by n.turn_idx desc
     limit 1)
    union all
    (select n.id, n.turn_idx, n.turn_text, n.code_session_id, n.parts
     from public.session_raw_units n
     where n.code_session_id = a.code_session_id and n.user_id = p_user_id and n.unit = 'turn'
       and n.turn_idx > a.t_to
     order by n.turn_idx asc
     limit 1)
  ) nb
  where a.unit in ('win', 'turn')
  order by nb.id, a.id);
end;
$$;

revoke all on function public.memory_raw_cover(uuid, uuid[], uuid[]) from public;
revoke all on function public.memory_raw_cover(uuid, uuid[], uuid[]) from anon;
revoke execute on function public.memory_raw_cover(uuid, uuid[], uuid[]) from authenticated;
grant execute on function public.memory_raw_cover(uuid, uuid[], uuid[]) to service_role;

-- ------------------------------------------------------------
-- memory_raw_term_stats
-- ------------------------------------------------------------
create function public.memory_raw_term_stats(
  p_user_id uuid,
  p_terms text[]
)
returns table (term text, df int, total int)
language plpgsql
stable
security invoker
set search_path = public, extensions, pg_temp
set plan_cache_mode = force_custom_plan
as $$
#variable_conflict use_column
begin
  return query
  with tot as (
    select count(*)::int as n
    from public.session_raw_units u
    where u.user_id = p_user_id and u.unit = 'turn'
  )
  select t.term, (
           select count(*)::int
           from public.session_raw_units u
           where u.user_id = p_user_id and u.unit = 'turn'
             and u.fts @@ plainto_tsquery('english', t.term)
         ), tot.n
  from unnest(coalesce(p_terms, '{}'::text[])) as t(term), tot
  union all
  select null::text, null::int, tot.n from tot;
end;
$$;

revoke all on function public.memory_raw_term_stats(uuid, text[]) from public;
revoke all on function public.memory_raw_term_stats(uuid, text[]) from anon;
revoke execute on function public.memory_raw_term_stats(uuid, text[]) from authenticated;
grant execute on function public.memory_raw_term_stats(uuid, text[]) to service_role;
