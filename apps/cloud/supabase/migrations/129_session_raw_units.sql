-- ============================================================
-- 129_session_raw_units.sql
-- Raw units of a code session (700-char chunks, sliding windows, whole turns) in their own table, plus the two RPCs the
-- I33 read path calls: `memory_raw_pools` (candidate pools) and `memory_raw_cover` (cover-test pairs and neighbours).
-- Design: docs/design/i33-port.md D1 (table), D2 (pools), D3 (native ranking), D4 (cover); PR 1 of section 5.
-- Depends on: 001 (profiles), 029 (code_sessions, code_projects), 045 (RLS-by-user pattern), 121 (RPC pattern),
-- and the `session_memories` table (records) for the cover pairs.
--
-- WHY A TABLE OF ITS OWN: units are not records. In `session_memories` they would leak into the preamble, browse,
-- dedupe, reconciliation and every `kind` check. This table is modelled on `conversation_chunks` (045).
--
-- TABLE `session_raw_units` (D1)
--   unit: 'c700' | 'win' | 'turn'. `ord` is the index within the unit type of one session. `turn_idx` is the turn a
--   c700 or turn row belongs to; `turn_from`/`turn_to` and `win` (int4range) are the span of a window; `parts` is the
--   c700 part list; `full_text` and `turn_text` are turn-row only. `fts` is generated, english, over `text` and
--   `full_text` joined, capped at 250,000 BYTES combined (`session_raw_units_fts_src`; the cut is on characters, sized
--   so the UTF-8 bytes of the kept prefix never exceed 250,000, also for multi-byte text) so one very long turn cannot
--   exceed the 1 MB (1,048,575 byte) tsvector limit and fail the insert; a tsvector of 250,000 bytes of text stays far
--   below the limit even when every token is unique. The session title is joined at query time (not in this PR). `text_hash` is the hash of the embedded
--   text (key for vector reuse); `source_hash` is the hash of the session's turns plus `units_version` (the stale test).
--   The decision recorded in D3 is Postgres-native ranking, so there are no `terms` / `term_count` columns and no GIN on
--   them.
--   Indexes: unique (code_session_id, unit, ord); (user_id, unit); (code_project_id); GIN on fts; HNSW vector_cosine_ops
--   (pgvector defaults m 16, ef_construction 64) where embedding is not null.
--   Access: RLS on, select and delete policies by user_id only. `service_role` bypasses RLS and is the sole writer, so
--   there are no insert or update policies, and insert, update and truncate are also revoked from anon and
--   authenticated (Supabase default privileges grant them). A BEFORE INSERT trigger
--   (`session_raw_units_check_owner`) rejects a row whose user_id or code_project_id differs from its code_sessions row,
--   so a writer bug cannot attach units to another owner's session. It guards INSERT only: if a session is ever
--   moved to another code_project (UPDATE code_sessions.code_project_id), the writer MUST update
--   session_raw_units.code_project_id for that session in the same transaction (the project filter of the RPCs reads
--   this column); nothing here alters code_sessions, so that sync lives in the code that moves the session.
--
-- RPC `memory_raw_pools` (D2, D3)
--   One round trip returns three pools: R1 top 60 c700 units, R2 top 160 windows, R3 top 60 turns (R2 and R3 only when
--   p_want_r23). Each pool fuses a dense leg (cosine, floor p_min_similarity as in `memory_search_scored`; default 0.3,
--   <= 0 means no floor) and a lexical leg (`ts_rank_cd` over `fts` against the OR of the query's english lexemes) by
--   reciprocal rank fusion, 1/(60+rank) per leg as in 121. Each leg fetches enough rows that the fused top K is exact:
--   an item outside the top N of both lists scores at most 2/(61+N), and the K-th fused item scores at least
--   1/(60+K); N = 2(60+K)-61 gives 180 for K 60 and 380 for K 160 (D3's bound). The design's `p_terms` argument is
--   not part of the signature: it exists only for the exact-BM25 form, which D3's ablation ruled out.
--   Filtered HNSW stops at hnsw.ef_search rows and drops the rows the user/unit filter rejects, so the function sets
--   ef_search = 400 and iterative scan relaxed_order (pgvector 0.8+; this migration fails loudly on an older pgvector).
--   Design U8. relaxed_order trades exact distance order for speed. D3's exact bound for the fused top K therefore
--   holds only up to HNSW recall: the dense legs return the approximate nearest neighbours, not the exact ones.
--   `plan_cache_mode = force_custom_plan` is the 121 lesson (optional-filter guards need the actual values).
--
-- RPC `memory_raw_cover` (D4)
--   For the cover test (cosine >= 0.86): the pairs (unit, record) and (unit, unit) with their cosine, and the
--   neighbour turns (turn_idx - 1 and turn_to + 1 of the same session) with their `turn_text`. No vectors cross the
--   wire. Embeddings are read once and normalised (`l2_normalize`, cosine unchanged) so each pair does not detoast the
--   6 KB vector again (measured: 260k buffer hits and 285 ms for 280 units without it). Pairs only compare vectors of the same embedding_model. Every table read is filtered by p_user_id: the
--   function runs as service_role, which bypasses RLS.
--   Result columns: kind ('unit_record' | 'unit_unit' | 'neighbour'), a_id, b_id, cosine, turn_idx, turn_text.
--   'unit_record': a_id unit, b_id record. 'unit_unit': a_id < b_id. 'neighbour': a_id unit, b_id the neighbour turn row.
--
-- Both functions: security invoker, execute revoked from public/anon/authenticated, granted to service_role only (121).
-- Additive only: a new table and two new functions; nothing existing is altered.
-- Rollback: drop function public.memory_raw_cover(uuid, uuid[], uuid[]); drop function public.memory_raw_pools(uuid,
-- text, vector, text, double precision, uuid, boolean); drop table public.session_raw_units;
-- ============================================================

set search_path = public, extensions;

do $$
declare v text; parts int[];
begin
  select extversion into v from pg_extension where extname = 'vector';
  if v is null then
    raise exception 'migration 129 needs the pgvector extension (>= 0.8.0, for hnsw.iterative_scan); it is not installed';
  end if;
  parts := string_to_array(v, '.')::int[];
  if (parts[1], coalesce(parts[2], 0)) < (0, 8) then
    raise exception 'migration 129 needs pgvector >= 0.8.0 (hnsw.iterative_scan); installed version is %', v;
  end if;
end
$$;

-- The text indexed by `fts`: text and full_text joined, at most 250,000 UTF-8 bytes. Immutable, as a generated
-- column requires. Cut on characters: if the first 250,000 characters are over the byte cap, keep
-- 250,000 - (extra bytes of multi-byte characters) characters, but never fewer than 62,500 (4 bytes per character is the
-- UTF-8 maximum, so 62,500 characters always fit).
create or replace function public.session_raw_units_fts_src(p_text text, p_full_text text)
returns text
language sql
immutable
parallel safe
as $$
  select case
    when octet_length(s.c1) <= 250000 then s.c1
    else left(s.c1, greatest(62500, 250000 - (octet_length(s.c1) - char_length(s.c1))))
  end
  from (select left(coalesce(p_text, '') || ' ' || coalesce(p_full_text, ''), 250000) as c1) s
$$;

create table if not exists public.session_raw_units (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  code_session_id      uuid not null references public.code_sessions(id) on delete cascade,
  code_project_id      uuid not null references public.code_projects(id) on delete cascade,
  unit                 text not null check (unit in ('c700', 'win', 'turn')),
  ord                  int not null,
  turn_idx             int,
  turn_from            int,
  turn_to              int,
  parts                jsonb,
  win                  int4range,
  text                 text not null,
  full_text            text,
  turn_text            text,
  fts                  tsvector generated always as (
    to_tsvector('english', public.session_raw_units_fts_src(text, full_text))
  ) stored,
  embedding            vector(1536),
  embedding_model      text,
  embedding_failed_at  timestamptz,
  text_hash            text not null,
  units_version        int not null,
  source_hash          text not null,
  created_at           timestamptz not null default now(),
  unique (code_session_id, unit, ord)
);

create index if not exists idx_session_raw_units_user_unit
  on public.session_raw_units (user_id, unit);

create index if not exists idx_session_raw_units_project
  on public.session_raw_units (code_project_id);

create index if not exists idx_session_raw_units_fts
  on public.session_raw_units using gin (fts);

-- Partial, as 045: units are inserted first and embedded second, so a null embedding is a normal state.
create index if not exists idx_session_raw_units_embedding
  on public.session_raw_units using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

alter table public.session_raw_units enable row level security;

drop policy if exists "session_raw_units: users see own rows" on public.session_raw_units;
create policy "session_raw_units: users see own rows" on public.session_raw_units
  for select using (auth.uid() = user_id);
drop policy if exists "session_raw_units: users delete own rows" on public.session_raw_units;
create policy "session_raw_units: users delete own rows" on public.session_raw_units
  for delete using (auth.uid() = user_id);

revoke insert, update, truncate on public.session_raw_units from anon, authenticated;

-- Owner consistency on insert (see the header for project reassignment).
create or replace function public.session_raw_units_check_owner()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare s record;
begin
  select cs.user_id, cs.code_project_id into s
  from public.code_sessions cs where cs.id = new.code_session_id;
  if not found then
    raise exception 'session_raw_units: code_session % does not exist', new.code_session_id
      using errcode = 'foreign_key_violation';
  end if;
  if new.user_id is distinct from s.user_id or new.code_project_id is distinct from s.code_project_id then
    raise exception 'session_raw_units: user_id / code_project_id do not match code_session %', new.code_session_id
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_session_raw_units_check_owner on public.session_raw_units;
create trigger trg_session_raw_units_check_owner
  before insert on public.session_raw_units
  for each row execute function public.session_raw_units_check_owner();

-- ------------------------------------------------------------
-- memory_raw_pools
-- ------------------------------------------------------------
create or replace function public.memory_raw_pools(
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
  similarity float8, lex_score float8, sem_rank int, lex_rank int, rrf float8
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
    select nullif(string_agg('''' || replace(replace(t.lex, '\', '\\'), '''', '''''') || '''', ' | '), '')::tsquery as tsq
    from (
      select distinct l.lex
      from unnest(tsvector_to_array(to_tsvector('english', coalesce(p_query, '')))) as l(lex)
    ) t
  ),
  -- Each leg is written per unit with a literal unit and LIMIT: with the unit and limit coming from a lateral join the
  -- planner cannot cost the filtered HNSW scan and picks a bitmap scan plus a sort of every row of the user (measured:
  -- 3.9 s on 357k units, against 22-33 ms for the literal form).
  dense as (
    select 'r1'::text as pool, d.id, d.similarity from (
      select u.id, 1 - (u.embedding <=> p_query_embedding) as similarity
      from public.session_raw_units u
      where u.user_id = p_user_id and u.unit = 'c700' and u.embedding is not null
        and p_query_embedding is not null
        and (p_embedding_model is null or u.embedding_model = p_embedding_model)
        and (p_code_project_id is null or u.code_project_id = p_code_project_id)
      order by u.embedding <=> p_query_embedding
      limit 180
    ) d
    union all
    select 'r2'::text as pool, d.id, d.similarity from (
      select u.id, 1 - (u.embedding <=> p_query_embedding) as similarity
      from public.session_raw_units u
      where u.user_id = p_user_id and u.unit = 'win' and u.embedding is not null
        and p_query_embedding is not null
        and p_want_r23
        and (p_embedding_model is null or u.embedding_model = p_embedding_model)
        and (p_code_project_id is null or u.code_project_id = p_code_project_id)
      order by u.embedding <=> p_query_embedding
      limit 380
    ) d
    union all
    select 'r3'::text as pool, d.id, d.similarity from (
      select u.id, 1 - (u.embedding <=> p_query_embedding) as similarity
      from public.session_raw_units u
      where u.user_id = p_user_id and u.unit = 'turn' and u.embedding is not null
        and p_query_embedding is not null
        and p_want_r23
        and (p_embedding_model is null or u.embedding_model = p_embedding_model)
        and (p_code_project_id is null or u.code_project_id = p_code_project_id)
      order by u.embedding <=> p_query_embedding
      limit 180
    ) d
  ),
  lex as (
    select 'r1'::text as pool, l.id, l.lex_score from (
      select u.id, ts_rank_cd(u.fts, qt.tsq)::float8 as lex_score
      from public.session_raw_units u, qt
      where qt.tsq is not null and u.user_id = p_user_id and u.unit = 'c700' and u.fts @@ qt.tsq
        and (p_code_project_id is null or u.code_project_id = p_code_project_id)
      order by lex_score desc, u.id
      limit 180
    ) l
    union all
    select 'r2'::text as pool, l.id, l.lex_score from (
      select u.id, ts_rank_cd(u.fts, qt.tsq)::float8 as lex_score
      from public.session_raw_units u, qt
      where qt.tsq is not null and u.user_id = p_user_id and u.unit = 'win' and u.fts @@ qt.tsq and p_want_r23
        and (p_code_project_id is null or u.code_project_id = p_code_project_id)
      order by lex_score desc, u.id
      limit 380
    ) l
    union all
    select 'r3'::text as pool, l.id, l.lex_score from (
      select u.id, ts_rank_cd(u.fts, qt.tsq)::float8 as lex_score
      from public.session_raw_units u, qt
      where qt.tsq is not null and u.user_id = p_user_id and u.unit = 'turn' and u.fts @@ qt.tsq and p_want_r23
        and (p_code_project_id is null or u.code_project_id = p_code_project_id)
      order by lex_score desc, u.id
      limit 180
    ) l
  ),
  joined as (
    select coalesce(d.pool, l.pool) as pool, coalesce(d.id, l.id) as id,
           d.similarity, l.lex_score
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
            j.similarity desc nulls last, j.id)
      end as sem_rank,
      case when j.lex_score is not null
        then row_number() over (
          partition by j.pool order by (j.lex_score is not null) desc, j.lex_score desc nulls last, j.id)
      end as lex_rank
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
    select f.*, row_number() over (partition by f.pool order by f.rrf desc, f.id) as pos
    from fused f
  )
  select
    t.pool, u.id, u.code_session_id, u.code_project_id, u.unit, u.ord,
    u.turn_idx, u.turn_from, u.turn_to, u.parts, u.win, u.text,
    t.similarity::float8, t.lex_score::float8, t.sem_rank::int, t.lex_rank::int, t.rrf::float8
  from top t
  join active a on a.pool = t.pool
  join public.session_raw_units u on u.id = t.id and u.user_id = p_user_id
  where t.pos <= a.k
  order by t.pool, t.rrf desc, u.id;
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
create or replace function public.memory_raw_cover(
  p_user_id uuid,
  p_unit_ids uuid[],
  p_record_ids uuid[]
)
returns table (
  kind text, a_id uuid, b_id uuid, cosine float8, turn_idx int, turn_text text
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
    select u.id, u.code_session_id, l2_normalize(u.embedding) as embedding, u.embedding_model,
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
  select 'unit_record'::text, a.id, b.id, (1 - (a.embedding <=> b.embedding))::float8, null::int, null::text
  from us a
  join rs b on a.embedding is not null
    and coalesce(b.embedding_model, 'text-embedding-3-small') = coalesce(a.embedding_model, 'text-embedding-3-small')
  where 1 - (a.embedding <=> b.embedding) >= 0.86
  union all
  select 'unit_unit'::text, a.id, b.id, (1 - (a.embedding <=> b.embedding))::float8, null::int, null::text
  from us a
  join us b on a.id < b.id and a.embedding is not null and b.embedding is not null
    and a.embedding_model is not distinct from b.embedding_model
  where 1 - (a.embedding <=> b.embedding) >= 0.86
  union all
  select 'neighbour'::text, a.id, n.id, null::float8, n.turn_idx, n.turn_text
  from us a
  join public.session_raw_units n
    on n.code_session_id = a.code_session_id
   and n.user_id = p_user_id
   and n.unit = 'turn'
   and n.turn_idx in (a.t_from - 1, a.t_to + 1);
end;
$$;

revoke all on function public.memory_raw_cover(uuid, uuid[], uuid[]) from public;
revoke all on function public.memory_raw_cover(uuid, uuid[], uuid[]) from anon;
revoke execute on function public.memory_raw_cover(uuid, uuid[], uuid[]) from authenticated;
grant execute on function public.memory_raw_cover(uuid, uuid[], uuid[]) to service_role;
