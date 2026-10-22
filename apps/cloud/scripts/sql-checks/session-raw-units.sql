-- Manual check for migration 129 (session_raw_units, memory_raw_pools, memory_raw_cover); i33-port design PR 1.
-- Runs inside begin ... rollback, so it leaves no data. Each check raises on failure; a clean run ends with ROLLBACK.
--
--   PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f apps/cloud/scripts/sql-checks/session-raw-units.sql
--
-- Check 2 has positive controls (A's own units return a neighbour, a unit_unit pair and a unit_record pair) so that its
-- "A cannot see B" assertions are not vacuous. To see them bite, run a scratch copy in which the RPCs lose their
-- p_user_id filters: it must stop with "CHECK 2 FAILED".

begin;

-- one-hot style 1536-d vectors: onehot(1) is the unit vector on axis 1, onehot(2) on axis 2 (cosine 0 between them)
create function pg_temp.onehot(i int) returns vector language sql as
$$ select (array_fill(0::float8, array[i - 1]) || array[1::float8] || array_fill(0::float8, array[1536 - i]))::vector(1536) $$;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000a1129', 'sql-check-129-a@example.com'),
  ('00000000-0000-4000-8000-0000000b1129', 'sql-check-129-b@example.com');

insert into public.code_projects (id, user_id, repo_identity) values
  ('00000000-0000-4000-8000-0000000a2129', '00000000-0000-4000-8000-0000000a1129', 'code-project:sql-check-129-a'),
  ('00000000-0000-4000-8000-0000000b2129', '00000000-0000-4000-8000-0000000b1129', 'code-project:sql-check-129-b');

insert into public.code_sessions (id, user_id, code_project_id, source, source_session_id, content_hash) values
  ('00000000-0000-4000-8000-0000000a3129', '00000000-0000-4000-8000-0000000a1129',
   '00000000-0000-4000-8000-0000000a2129', 'claude-code', 'sql-check-129-a', ''),
  ('00000000-0000-4000-8000-0000000b3129', '00000000-0000-4000-8000-0000000b1129',
   '00000000-0000-4000-8000-0000000b2129', 'claude-code', 'sql-check-129-b', '');

-- A: turns 0 and 1 (same embedding, adjacent: a unit_unit pair and neighbours) and a scratch turn 5 (no embedding, deleted in check 3).
-- B: turns 0 and 1 with the same embedding as A's, so a filter that forgot p_user_id would return B's rows.
insert into public.session_raw_units
  (id, user_id, code_session_id, code_project_id, unit, ord, turn_idx, text, turn_text, embedding, embedding_model,
   text_hash, units_version, source_hash)
values
  ('00000000-0000-4000-8000-0000000a4129', '00000000-0000-4000-8000-0000000a1129',
   '00000000-0000-4000-8000-0000000a3129', '00000000-0000-4000-8000-0000000a2129', 'turn', 0, 0,
   'alpha unit text', 'alpha unit text', pg_temp.onehot(1), 'm', 'h-a0', 1, 's-a'),
  ('00000000-0000-4000-8000-0000000a4130', '00000000-0000-4000-8000-0000000a1129',
   '00000000-0000-4000-8000-0000000a3129', '00000000-0000-4000-8000-0000000a2129', 'turn', 1, 1,
   'alpha second turn', 'alpha second turn', pg_temp.onehot(1), 'm', 'h-a1', 1, 's-a'),
  ('00000000-0000-4000-8000-0000000a4131', '00000000-0000-4000-8000-0000000a1129',
   '00000000-0000-4000-8000-0000000a3129', '00000000-0000-4000-8000-0000000a2129', 'turn', 2, 5,
   'alpha scratch', 'alpha scratch', null, null, 'h-a5', 1, 's-a'),
  ('00000000-0000-4000-8000-0000000b4129', '00000000-0000-4000-8000-0000000b1129',
   '00000000-0000-4000-8000-0000000b3129', '00000000-0000-4000-8000-0000000b2129', 'turn', 0, 0,
   'beta unit text', 'beta unit text', pg_temp.onehot(1), 'm', 'h-b0', 1, 's-b'),
  ('00000000-0000-4000-8000-0000000b4130', '00000000-0000-4000-8000-0000000b1129',
   '00000000-0000-4000-8000-0000000b3129', '00000000-0000-4000-8000-0000000b2129', 'turn', 1, 1,
   'beta second turn', 'beta second turn', pg_temp.onehot(1), 'm', 'h-b1', 1, 's-b');

insert into public.session_memories
  (id, user_id, code_session_id, code_project_id, source, kind, text, turn_idx, turn_role, content_hash,
   embedding, embedding_model)
values
  ('00000000-0000-4000-8000-0000000a5129', '00000000-0000-4000-8000-0000000a1129',
   '00000000-0000-4000-8000-0000000a3129', '00000000-0000-4000-8000-0000000a2129',
   'extractor', 'learning', 'alpha record', 0, 'assistant', 'rec-a', pg_temp.onehot(1), 'm'),
  ('00000000-0000-4000-8000-0000000b5129', '00000000-0000-4000-8000-0000000b1129',
   '00000000-0000-4000-8000-0000000b3129', '00000000-0000-4000-8000-0000000b2129',
   'extractor', 'learning', 'beta record', 0, 'assistant', 'rec-b', pg_temp.onehot(1), 'm');

-- 1. Authenticated cannot call either RPC (permission denied), and neither can anon.
set local role authenticated;
do $$
begin
  begin
    perform * from public.memory_raw_pools('00000000-0000-4000-8000-0000000a1129', 'alpha');
    raise exception 'CHECK 1 FAILED: authenticated called memory_raw_pools';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.memory_raw_cover('00000000-0000-4000-8000-0000000a1129', '{}', '{}');
    raise exception 'CHECK 1 FAILED: authenticated called memory_raw_cover';
  exception when insufficient_privilege then null;
  end;
  raise notice 'CHECK 1 ok: authenticated gets permission denied on both RPCs';
end;
$$;
reset role;

set local role anon;
do $$
begin
  begin
    perform * from public.memory_raw_pools('00000000-0000-4000-8000-0000000a1129', 'alpha');
    raise exception 'CHECK 1b FAILED: anon called memory_raw_pools';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.memory_raw_cover('00000000-0000-4000-8000-0000000a1129', '{}', '{}');
    raise exception 'CHECK 1b FAILED: anon called memory_raw_cover';
  exception when insufficient_privilege then null;
  end;
  raise notice 'CHECK 1b ok: anon gets permission denied on both RPCs';
end;
$$;
reset role;

-- 2. service_role calls: positive controls for A's own data, then B's data must stay invisible to A.
set local role service_role;
do $$
declare
  a uuid[] := array['00000000-0000-4000-8000-0000000a4129', '00000000-0000-4000-8000-0000000a4130']::uuid[];
  b uuid[] := array['00000000-0000-4000-8000-0000000b4129', '00000000-0000-4000-8000-0000000b4130']::uuid[];
  n integer;
begin
  -- pools: query embedding, no floor -> A's units come back with a semantic rank; none of B's.
  select count(*) into n from public.memory_raw_pools('00000000-0000-4000-8000-0000000a1129', 'alpha unit',
    pg_temp.onehot(1), 'm', 0, null, true) where sem_rank is not null and id = any(a);
  if n < 1 then raise exception 'CHECK 2 FAILED: pools returned no semantic row for A''s own units'; end if;
  select count(*) into n from public.memory_raw_pools('00000000-0000-4000-8000-0000000a1129', 'alpha unit',
    pg_temp.onehot(1), 'm', 0, null, true) where id = any(b);
  if n <> 0 then raise exception 'CHECK 2 FAILED: pools returned % of B''s units to A', n; end if;
  select count(*) into n from public.memory_raw_pools('00000000-0000-4000-8000-0000000a1129', 'beta', null, null, null, null, true);
  if n <> 0 then raise exception 'CHECK 2 FAILED: user A matched user B''s text (% rows)', n; end if;

  -- cover, positive controls: A's own units.
  select count(*) into n from public.memory_raw_cover('00000000-0000-4000-8000-0000000a1129', a,
    array['00000000-0000-4000-8000-0000000a5129']::uuid[]) where kind = 'unit_unit' and cosine >= 0.99;
  if n <> 1 then raise exception 'CHECK 2 FAILED: expected 1 unit_unit pair for A, got %', n; end if;
  select count(*) into n from public.memory_raw_cover('00000000-0000-4000-8000-0000000a1129', a,
    array['00000000-0000-4000-8000-0000000a5129']::uuid[]) where kind = 'unit_record' and b_id = '00000000-0000-4000-8000-0000000a5129';
  if n <> 2 then raise exception 'CHECK 2 FAILED: expected 2 unit_record pairs for A, got %', n; end if;
  select count(*) into n from public.memory_raw_cover('00000000-0000-4000-8000-0000000a1129', a, '{}')
    where kind = 'neighbour' and turn_text is not null;
  if n < 1 then raise exception 'CHECK 2 FAILED: no neighbour row for A''s own units'; end if;

  -- cover, negative: A names B's ids -> nothing; mixed ids -> nothing from B.
  select count(*) into n from public.memory_raw_cover('00000000-0000-4000-8000-0000000a1129', b,
    array['00000000-0000-4000-8000-0000000b5129']::uuid[]);
  if n <> 0 then raise exception 'CHECK 2 FAILED: cover returned % rows for B''s ids passed by A', n; end if;
  select count(*) into n from public.memory_raw_cover('00000000-0000-4000-8000-0000000a1129', a || b,
    array['00000000-0000-4000-8000-0000000a5129', '00000000-0000-4000-8000-0000000b5129']::uuid[])
    where a_id = any(b) or b_id = any(b) or b_id = '00000000-0000-4000-8000-0000000b5129';
  if n <> 0 then raise exception 'CHECK 2 FAILED: cover leaked % of B''s rows into a mixed call', n; end if;
  raise notice 'CHECK 2 ok: positive controls return rows for A; B''s ids and rows stay invisible to A';
end;
$$;
reset role;

-- 3. Table policy and grants as authenticated user A.
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000a1129', true);
do $$
declare n integer;
begin
  select count(*) into n from public.session_raw_units;
  if n <> 3 then raise exception 'CHECK 3 FAILED: user A sees % units, expected 3', n; end if;
  select count(*) into n from public.session_raw_units where user_id = '00000000-0000-4000-8000-0000000b1129';
  if n <> 0 then raise exception 'CHECK 3 FAILED: user A reads user B''s units'; end if;
  -- insert without the grant: denied by the missing table privilege
  begin
    insert into public.session_raw_units
      (user_id, code_session_id, code_project_id, unit, ord, text, text_hash, units_version, source_hash)
    values ('00000000-0000-4000-8000-0000000a1129', '00000000-0000-4000-8000-0000000a3129',
            '00000000-0000-4000-8000-0000000a2129', 'turn', 9, 'x', 'h', 1, 's');
    raise exception 'CHECK 3 FAILED: authenticated inserted a unit';
  exception when insufficient_privilege then
    if sqlerrm not like 'permission denied for table%' then raise exception 'CHECK 3 FAILED: expected a missing-grant error, got: %', sqlerrm; end if;
  end;
  delete from public.session_raw_units where user_id = '00000000-0000-4000-8000-0000000b1129';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'CHECK 3 FAILED: user A deleted user B''s unit'; end if;
  delete from public.session_raw_units where id = '00000000-0000-4000-8000-0000000a4131';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'CHECK 3 FAILED: user A could not delete own unit (% rows)', n; end if;
  begin
    update public.session_raw_units set text = 'changed' where id = '00000000-0000-4000-8000-0000000a4129';
    raise exception 'CHECK 3 FAILED: authenticated updated a unit without the grant';
  exception when insufficient_privilege then
    if sqlerrm not like 'permission denied for table%' then raise exception 'CHECK 3 FAILED: expected a missing-grant error, got: %', sqlerrm; end if;
  end;
  raise notice 'CHECK 3 ok: A sees own units only, insert/update denied by missing grant, deletes own row, not B''s';
end;
$$;
reset role;

-- 3b. With the table grants put back (what a Supabase default privilege would give), RLS alone must still hold:
-- the missing insert policy denies the insert (a different error from the missing grant), and an update matches 0 rows.
grant insert, update on public.session_raw_units to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000a1129', true);
do $$
declare n integer;
begin
  begin
    insert into public.session_raw_units
      (user_id, code_session_id, code_project_id, unit, ord, text, text_hash, units_version, source_hash)
    values ('00000000-0000-4000-8000-0000000a1129', '00000000-0000-4000-8000-0000000a3129',
            '00000000-0000-4000-8000-0000000a2129', 'turn', 9, 'x', 'h', 1, 's');
    raise exception 'CHECK 3b FAILED: authenticated inserted a unit with the grant but no policy';
  exception when insufficient_privilege then
    if sqlerrm not like '%row-level security%' then raise exception 'CHECK 3b FAILED: expected an RLS error, got: %', sqlerrm; end if;
  end;
  update public.session_raw_units set text = 'changed' where id = '00000000-0000-4000-8000-0000000a4129';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'CHECK 3b FAILED: authenticated UPDATE changed % rows', n; end if;
  raise notice 'CHECK 3b ok: with grants but no policy, insert hits RLS and UPDATE affects 0 rows';
end;
$$;
reset role;
revoke insert, update on public.session_raw_units from authenticated;

-- 4. Privileges: PUBLIC has no execute on either RPC, service_role has; anon/authenticated have no write privileges.
do $$
declare n integer;
begin
  select count(*) into n from pg_proc p, aclexplode(p.proacl) x
  where p.oid in ('public.memory_raw_pools(uuid, text, vector, text, double precision, uuid, boolean)'::regprocedure,
                  'public.memory_raw_cover(uuid, uuid[], uuid[])'::regprocedure)
    and x.grantee = 0 and x.privilege_type = 'EXECUTE';
  if n <> 0 then raise exception 'CHECK 4 FAILED: PUBLIC has execute on % RPC(s)', n; end if;
  if not has_function_privilege('service_role', 'public.memory_raw_cover(uuid, uuid[], uuid[])', 'execute')
     or not has_function_privilege('service_role',
          'public.memory_raw_pools(uuid, text, vector, text, double precision, uuid, boolean)', 'execute') then
    raise exception 'CHECK 4 FAILED: service_role lost execute';
  end if;
  if has_table_privilege('anon', 'public.session_raw_units', 'insert,update,truncate')
     or has_table_privilege('authenticated', 'public.session_raw_units', 'insert')
     or has_table_privilege('authenticated', 'public.session_raw_units', 'update')
     or has_table_privilege('authenticated', 'public.session_raw_units', 'truncate') then
    raise exception 'CHECK 4 FAILED: anon/authenticated can write to session_raw_units';
  end if;
  raise notice 'CHECK 4 ok: PUBLIC has no execute on either RPC; anon/authenticated cannot write the table';
end;
$$;

-- 5. Owner trigger: a unit must carry its session's user_id and code_project_id.
do $$
begin
  begin
    insert into public.session_raw_units
      (user_id, code_session_id, code_project_id, unit, ord, text, text_hash, units_version, source_hash)
    values ('00000000-0000-4000-8000-0000000b1129', '00000000-0000-4000-8000-0000000a3129',
            '00000000-0000-4000-8000-0000000a2129', 'turn', 20, 'x', 'h', 1, 's');
    raise exception 'CHECK 5 FAILED: a unit with another user_id than its session was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.session_raw_units
      (user_id, code_session_id, code_project_id, unit, ord, text, text_hash, units_version, source_hash)
    values ('00000000-0000-4000-8000-0000000a1129', '00000000-0000-4000-8000-0000000a3129',
            '00000000-0000-4000-8000-0000000b2129', 'turn', 21, 'x', 'h', 1, 's');
    raise exception 'CHECK 5 FAILED: a unit with another code_project_id than its session was accepted';
  exception when check_violation then null;
  end;
  begin
    insert into public.session_raw_units
      (user_id, code_session_id, code_project_id, unit, ord, text, text_hash, units_version, source_hash)
    values ('00000000-0000-4000-8000-0000000a1129', '00000000-0000-4000-8000-00000000dead',
            '00000000-0000-4000-8000-0000000a2129', 'turn', 22, 'x', 'h', 1, 's');
    raise exception 'CHECK 5 FAILED: a unit of an unknown session was accepted';
  exception when foreign_key_violation then null;
  end;
  raise notice 'CHECK 5 ok: owner trigger rejects a mismatched user, a mismatched project and an unknown session';
end;
$$;

-- 6. Pathological text must not break the insert (tsvector limit 1,048,575 bytes): unique multi-byte tokens
-- (about 1.3 MB of text, 3-4 bytes per character) in text and full_text, and 300,000 four-byte characters.
do $$
declare n integer; sz integer;
begin
  insert into public.session_raw_units
    (user_id, code_session_id, code_project_id, unit, ord, text, full_text, text_hash, units_version, source_hash)
  select '00000000-0000-4000-8000-0000000a1129', '00000000-0000-4000-8000-0000000a3129',
         '00000000-0000-4000-8000-0000000a2129', 'turn', 30,
         (select string_agg('жжж' || g, ' ') from generate_series(1, 60000) g),
         (select string_agg('яяя' || g, ' ') from generate_series(1, 60000) g), 'h-path1', 1, 's';
  insert into public.session_raw_units
    (user_id, code_session_id, code_project_id, unit, ord, text, text_hash, units_version, source_hash)
  values ('00000000-0000-4000-8000-0000000a1129', '00000000-0000-4000-8000-0000000a3129',
          '00000000-0000-4000-8000-0000000a2129', 'turn', 31, repeat('😀', 300000), 'h-path2', 1, 's');
  insert into public.session_raw_units
    (user_id, code_session_id, code_project_id, unit, ord, text, text_hash, units_version, source_hash)
  select '00000000-0000-4000-8000-0000000a1129', '00000000-0000-4000-8000-0000000a3129',
         '00000000-0000-4000-8000-0000000a2129', 'turn', 32,
         (select string_agg(md5(g::text), ' ') from generate_series(1, 200000) g), 'h-path3', 1, 's';
  select max(length(fts)) into sz from public.session_raw_units where ord in (30, 31, 32) and code_session_id = '00000000-0000-4000-8000-0000000a3129';
  select max(octet_length(public.session_raw_units_fts_src(text, full_text))) into sz
    from public.session_raw_units where ord in (30, 31, 32) and code_session_id = '00000000-0000-4000-8000-0000000a3129';
  if sz > 250000 then raise exception 'CHECK 6 FAILED: fts source is % bytes', sz; end if;
  select count(*) into n from public.session_raw_units where ord in (30, 31, 32) and code_session_id = '00000000-0000-4000-8000-0000000a3129';
  if n <> 3 then raise exception 'CHECK 6 FAILED: % of 3 pathological units were stored', n; end if;
  raise notice 'CHECK 6 ok: unique-token and multi-byte units insert; fts source capped at % bytes', sz;
end;
$$;

-- 7. tsquery quoting: a lexeme with a backslash and a quote must parse and match (quote_literal would emit E'..').
do $$
declare lex text := 'a''\b'; q tsquery; n integer;
begin
  q := ('''' || replace(replace(lex, '\', '\\'), '''', '''''') || '''')::tsquery;
  if not (array_to_tsvector(array[lex]) @@ q) then raise exception 'CHECK 7 FAILED: quoted lexeme did not match itself'; end if;
  -- end to end: a query string full of quotes and backslashes must not raise
  perform * from public.memory_raw_pools('00000000-0000-4000-8000-0000000a1129', 'it''s c:\temp\o''neil "alpha" \ '' ', null, null, null, null, true);
  select count(*) into n from public.memory_raw_pools('00000000-0000-4000-8000-0000000a1129', 'alpha \ '' unit', null, null, null, null, true);
  if n < 1 then raise exception 'CHECK 7 FAILED: lexical leg found nothing for a query with quotes and backslashes'; end if;
  raise notice 'CHECK 7 ok: lexemes with a backslash and a quote are quoted safely';
end;
$$;

-- 8. Cascade: deleting the session removes its units (B's units stay).
do $$
declare n integer;
begin
  delete from public.code_sessions where id = '00000000-0000-4000-8000-0000000a3129';
  select count(*) into n from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3129';
  if n <> 0 then raise exception 'CHECK 8 FAILED: % units survived their session', n; end if;
  select count(*) into n from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000b3129';
  if n <> 2 then raise exception 'CHECK 8 FAILED: B''s units were removed'; end if;
  raise notice 'CHECK 8 ok: deleting a session deletes its units only';
end;
$$;

rollback;
