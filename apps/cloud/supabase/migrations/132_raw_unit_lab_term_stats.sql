-- ============================================================
-- 132_raw_unit_lab_term_stats.sql
-- Two parity fixes of the I33 read path (docs/design/i33-port.md section 9; scripts/eval/i33/parity-product.mjs).
-- Depends on: 129 (session_raw_units), 131 (memory_raw_term_stats, memory_raw_cover). Migration 131 is unchanged.
--
-- 1. memory_raw_term_stats counts the lab's tokens, not Postgres lexemes. The whole-turn snippet weighs each query term by
--    idf = ln(1 + (N - df + 0.5) / (df + 0.5)) over the user's turn rows. The lab computes df from `terms()` tokens
--    (lowercase letter/digit/underscore runs of length >= 2, light suffix folding: ing, ed, es, s) of the whole turn,
--    while 131 counted rows whose english `fts` matched the term (stemmed, stop words dropped, a different word set). The
--    different idf changes which pieces win the snippet, so the served text differed on 12 of 20 dev questions.
--    NEW `session_raw_unit_terms(text)`: that tokenizer in SQL (immutable; the same function the index and the query use).
--    NEW partial GIN index on it over the turn rows, so df stays an index count (as `fts` was) and no column, row
--    rewrite or write-path change is needed. Existing rows are indexed when the index is built.
--    Tokens shorter than 2 or longer than 255 characters are dropped (the cap is on the raw token, before suffix folding):
--    a GIN key over about 2.7 KB is rejected, so one long non-compressible token (a 4000-character hex string) would fail
--    the index build and every later insert of that session. The lab's queries never carry such a term.
--    Where it differs from the JS tokenizer: Postgres `[[:alnum:]]` and JS `\p{L}\p{N}` disagree on a few number-like
--    symbols (the common ones are listed in the class below; other No/Nl characters are separators here); lengths count
--    characters, not UTF-16 units; `lower()` follows the database locale. Input is cut at 250,000 CHARACTERS (`fts`'s own
--    cut, session_raw_units_fts_src in 129, is sized in BYTES: 250,000 bytes), so one huge turn cannot make the index
--    build or an insert slow.
--
-- 2. memory_raw_cover pairs a unit with a record of the same embedding FAMILY. Units of a nomic family are stored under
--    'nomic-embed-text+doc-v1' (the document-prefix version, embed.ts unitEmbeddingModel) and records under
--    'nomic-embed-text', so 131's equal-model test never paired a unit with a record: the "already covered by a served
--    record" rule never fired for nomic. The model is now compared before the '+'. unit-unit pairs are unchanged (same
--    model), as is the default family (both sides null).
--
-- Same signatures and return types, so `create or replace` keeps the grants (service_role only); the new function gets
-- the same grants (revoke from public/anon/authenticated, execute to service_role), as in 129 and 131.
--
-- KNOWN TOKENIZER DIFFERENCES (SQL here vs the lab's JS `terms()`):
--    - Number-like symbols outside the class below (superscript 4 in x^4, subscript digits in H2O / CO2, circled digits
--      outside the listed range) are separators in SQL, so the JS token "h2o" is "h" + "o" here (the "h" is dropped).
--    - JS `toLowerCase()` and libc `lower()` differ for a few letters (dotted capital I, final sigma).
--    - A lone astral-plane letter counts 2 UTF-16 units in JS (kept, length >= 2) and 1 character in SQL (dropped).
--    - A C-locale or non-UTF8 database makes `[[:alnum:]]` and `lower()` ASCII-only, so non-ASCII letters become
--      separators. The database must be UTF8 with a UTF-8 locale (the supabase/postgres image is) for parity.
--
-- PROD APPLY: the read path only runs locally; hosted stores hold no raw units, so there the index is built over zero
--    rows. A plain CREATE INDEX holds a SHARE lock (blocks writes to session_raw_units) for the whole single-threaded
--    build, and the Supabase CLI wraps each migration in a transaction, so CREATE INDEX CONCURRENTLY cannot go in this
--    file. For a large local store, build the index by hand first:
--      create index concurrently if not exists idx_session_raw_units_turn_terms on public.session_raw_units
--        using gin (public.session_raw_unit_terms(coalesce(full_text, text))) where unit = 'turn';
--    check `select indisvalid from pg_index where indexrelid = 'public.idx_session_raw_units_turn_terms'::regclass`
--    (an INVALID leftover from an interrupted build would be silently skipped by `if not exists`: drop it and rebuild),
--    then apply this migration (its `if not exists` is then a no-op), then run `analyze public.session_raw_units;`.
--    The index needs the function, so run this file's `create or replace function public.session_raw_unit_terms`
--    statement by hand before the CREATE INDEX CONCURRENTLY.
--
-- Rollback: drop index idx_session_raw_units_turn_terms; drop function session_raw_unit_terms(text); then re-run 131's
-- definitions of memory_raw_term_stats and memory_raw_cover (create or replace; their grants are unchanged).
-- ============================================================

set search_path = public, extensions;

create or replace function public.session_raw_unit_terms(p_text text)
returns text[]
language sql
immutable
parallel safe
cost 10000
set search_path = pg_catalog
as $$
  select coalesce(array_agg(distinct s.t), '{}'::text[])
  from (
    select case
             when length(w.w) > 5 and w.w like '%ing' then left(w.w, length(w.w) - 3)
             when length(w.w) > 4 and w.w like '%ed' then left(w.w, length(w.w) - 2)
             when length(w.w) > 4 and w.w like '%es' then left(w.w, length(w.w) - 2)
             when length(w.w) > 3 and w.w like '%s' and w.w not like '%ss' then left(w.w, length(w.w) - 1)
             else w.w
           end as t
    from (
      select m[1] as w
      from regexp_matches(lower(left(coalesce(p_text, ''), 250000)), '([[:alnum:]_²³¹¼½¾⅐-ↈ①-⒛]+)', 'g') as m
    ) w
    where length(w.w) between 2 and 255
  ) s;
$$;

revoke all on function public.session_raw_unit_terms(text) from public;
revoke all on function public.session_raw_unit_terms(text) from anon;
revoke execute on function public.session_raw_unit_terms(text) from authenticated;
grant execute on function public.session_raw_unit_terms(text) to service_role;

create index if not exists idx_session_raw_units_turn_terms
  on public.session_raw_units using gin (public.session_raw_unit_terms(coalesce(full_text, text)))
  where unit = 'turn';

create or replace function public.memory_raw_term_stats(
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
             and public.session_raw_unit_terms(coalesce(u.full_text, u.text)) @> array[t.term]
         ), tot.n
  from unnest(coalesce(p_terms, '{}'::text[])) as t(term), tot
  union all
  select null::text, null::int, tot.n from tot;
end;
$$;

-- memory_raw_cover
-- ------------------------------------------------------------
create or replace function public.memory_raw_cover(
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
    and coalesce(split_part(b.embedding_model, '+', 1), 'text-embedding-3-small')
        = coalesce(split_part(a.embedding_model, '+', 1), 'text-embedding-3-small')
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

