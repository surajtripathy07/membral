-- Manual check for migration 130 (replace_session_raw_units); i33-port design PR 2.
-- Runs inside begin ... rollback, so it leaves no data. Each check raises on failure; a clean run ends with ROLLBACK.
--
--   PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f apps/cloud/scripts/sql-checks/replace-session-raw-units.sql
--
-- Concurrency (two sessions at once) cannot be shown inside one transaction; see the comment at the end for the
-- two-psql recipe. The advisory lock itself is asserted below (check 6) by reading pg_locks.

begin;

create function pg_temp.onehot(i int) returns text language sql as
$$ select ((array_fill(0::float8, array[i - 1]) || array[1::float8] || array_fill(0::float8, array[1536 - i]))::vector(1536))::text $$;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000a1130', 'sql-check-130-a@example.com'),
  ('00000000-0000-4000-8000-0000000b1130', 'sql-check-130-b@example.com');
insert into public.code_projects (id, user_id, repo_identity) values
  ('00000000-0000-4000-8000-0000000a2130', '00000000-0000-4000-8000-0000000a1130', 'code-project:sql-check-130-a'),
  ('00000000-0000-4000-8000-0000000b2130', '00000000-0000-4000-8000-0000000b1130', 'code-project:sql-check-130-b');
insert into public.code_sessions (id, user_id, code_project_id, source, source_session_id, content_hash) values
  ('00000000-0000-4000-8000-0000000a3130', '00000000-0000-4000-8000-0000000a1130',
   '00000000-0000-4000-8000-0000000a2130', 'claude-code', 'sql-check-130-a', ''),
  ('00000000-0000-4000-8000-0000000b3130', '00000000-0000-4000-8000-0000000b1130',
   '00000000-0000-4000-8000-0000000b2130', 'claude-code', 'sql-check-130-b', '');

-- CHECK 1: authenticated and anon cannot call it (revoked), service_role can.
set local role authenticated;
do $$
begin
  begin
    perform public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, ('[]'::jsonb)::jsonb, 's'::text, 1::integer, null::text);
    raise exception 'CHECK 1 FAILED: authenticated could call replace_session_raw_units';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role anon;
do $$
begin
  begin
    perform public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, ('[]'::jsonb)::jsonb, 's'::text, 1::integer, null::text);
    raise exception 'CHECK 1 FAILED: anon could call replace_session_raw_units';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role service_role;
do $$
begin
  if public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, ('[]'::jsonb)::jsonb, 's'::text, 1::integer, null::text) <> 0 then
    raise exception 'CHECK 1 FAILED: service_role could not call it';
  end if;
end $$;
reset role;

-- CHECK 2: first call inserts; a failed embedding stores NULL + embedding_failed_at (never a zero vector).
create temp table rows_v1 as select jsonb_build_array(
  jsonb_build_object('unit','c700','ord',0,'turn_idx',0,'turn_from',0,'turn_to',1,'parts','[[0,0,5],[1,0,5]]'::jsonb,
    'text','alpha','embedding',pg_temp.onehot(1),'embedding_model','nomic-v2','embedding_failed',false,'text_hash','h0'),
  jsonb_build_object('unit','win','ord',0,'turn_idx',0,'turn_from',0,'turn_to',0,'win','[0,5)',
    'text','alpha','embedding',pg_temp.onehot(2),'embedding_model','nomic-v2','embedding_failed',false,'text_hash','h1'),
  jsonb_build_object('unit','turn','ord',0,'turn_idx',0,'turn_from',0,'turn_to',0,'text','alpha','full_text','alpha',
    'turn_text','alpha','embedding',null,'embedding_model','nomic-v2','embedding_failed',true,'text_hash','h2')
) as r;
grant select on rows_v1 to service_role;
set local role service_role;
do $$
declare n int; rows jsonb := (select r from rows_v1);
begin
  n := public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, (rows)::jsonb, 'src-1'::text, 1::integer, null::text);
  if n <> 3 then raise exception 'CHECK 2 FAILED: inserted % rows, expected 3', n; end if;
  if (select count(*) from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130') <> 3 then
    raise exception 'CHECK 2 FAILED: row count';
  end if;
  if not exists (select 1 from public.session_raw_units where unit = 'turn' and embedding is null and embedding_model is null
                   and embedding_failed_at is not null) then
    raise exception 'CHECK 2 FAILED: failed embedding not stored as NULL + marker';
  end if;
  if exists (select 1 from public.session_raw_units where embedding is not null and embedding_failed_at is not null) then
    raise exception 'CHECK 2 FAILED: embedded row carries a failed marker';
  end if;
  if exists (select 1 from public.session_raw_units where embedding <=> embedding is null and embedding is not null) then
    raise exception 'CHECK 2 FAILED: zero vector stored';
  end if;
  if (select win from public.session_raw_units where unit = 'win') <> '[0,5)'::int4range then
    raise exception 'CHECK 2 FAILED: win span';
  end if;
  if (select user_id from public.session_raw_units limit 1) <> '00000000-0000-4000-8000-0000000a1130'
     or (select count(*) from public.session_raw_units where code_project_id = '00000000-0000-4000-8000-0000000a2130') <> 3 then
    raise exception 'CHECK 2 FAILED: user / project not taken from the session';
  end if;
end $$;
reset role;

-- CHECK 3: a second call with different rows REPLACES (no duplicates, new source_hash stamped, old rows gone).
set local role service_role;
do $$
declare n int;
begin
  n := public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, (jsonb_build_array(jsonb_build_object('unit','c700','ord',0,'turn_idx',0,'turn_from',0,'turn_to',0,'text','beta',
      'embedding',pg_temp.onehot(3),'embedding_model','nomic-v2','embedding_failed',false,'text_hash','h9')))::jsonb, 'src-2'::text, 1::integer, null::text);
  if n <> 1 then raise exception 'CHECK 3 FAILED: returned %', n; end if;
  if (select count(*) from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130') <> 1
     or (select source_hash from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130') <> 'src-2' then
    raise exception 'CHECK 3 FAILED: second call did not replace';
  end if;
end $$;
reset role;

-- CHECK 4: idempotent. The same rows again return -1 and write nothing (ids unchanged); a failed embedding on the
-- incoming side with the same hashes is NOT current, and different content is not either.
create temp table ids_before as select id from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130';
grant select on ids_before to service_role;
set local role service_role;
do $$
declare
  same jsonb := jsonb_build_array(jsonb_build_object('unit','c700','ord',0,'turn_idx',0,'turn_from',0,'turn_to',0,'text','beta',
      'embedding',pg_temp.onehot(3),'embedding_model','nomic-v2','embedding_failed',false,'text_hash','h9'));
begin
  if public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, (same)::jsonb, 'src-2'::text, 1::integer, null::text) <> -1 then
    raise exception 'CHECK 4 FAILED: identical rows were rewritten';
  end if;
  if (select count(*) from public.session_raw_units u join ids_before b using (id) where u.code_session_id = '00000000-0000-4000-8000-0000000a3130') <> 1 then
    raise exception 'CHECK 4 FAILED: row ids changed on a no-op';
  end if;
  -- new source_hash => rewritten
  if public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, (same)::jsonb, 'src-3'::text, 1::integer, null::text) <> 1 then
    raise exception 'CHECK 4 FAILED: changed source_hash was skipped';
  end if;
  -- new units_version => rewritten
  if public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, (same)::jsonb, 'src-3'::text, 2::integer, null::text) <> 1 then
    raise exception 'CHECK 4 FAILED: changed units_version was skipped';
  end if;
end $$;
reset role;

-- CHECK 5: ownership. Another user's session, an unknown session, and a non-array p_rows all raise; nothing changes.
set local role service_role;
do $$
begin
  begin
    perform public.replace_session_raw_units('00000000-0000-4000-8000-0000000b1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, ('[]'::jsonb)::jsonb, 's'::text, 1::integer, null::text);
    raise exception 'CHECK 5 FAILED: wrote another user''s session';
  exception when raise_exception then
    if sqlerrm like 'CHECK 5 FAILED%' then raise; end if;
  end;
  begin
    perform public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-00000000dead'::uuid, ('[]'::jsonb)::jsonb, 's'::text, 1::integer, null::text);
    raise exception 'CHECK 5 FAILED: wrote an unknown session';
  exception when raise_exception then
    if sqlerrm like 'CHECK 5 FAILED%' then raise; end if;
  end;
  begin
    perform public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, ('{}'::jsonb)::jsonb, 's'::text, 1::integer, null::text);
    raise exception 'CHECK 5 FAILED: accepted a non-array';
  exception when raise_exception then
    if sqlerrm like 'CHECK 5 FAILED%' then raise; end if;
  end;
  if (select count(*) from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130') <> 1 then
    raise exception 'CHECK 5 FAILED: a rejected call changed rows';
  end if;
end $$;
reset role;

-- CHECK 6: the owner trigger of 129 is still enforced on the table (a direct insert with a mismatched project
-- fails), and the function takes the per-session advisory lock (visible in pg_locks for this transaction).
do $$
begin
  begin
    insert into public.session_raw_units (user_id, code_session_id, code_project_id, unit, ord, turn_idx, text, text_hash, units_version, source_hash)
    values ('00000000-0000-4000-8000-0000000a1130', '00000000-0000-4000-8000-0000000a3130', '00000000-0000-4000-8000-0000000b2130',
            'turn', 7, 0, 'x', 'hx', 1, 's');
    raise exception 'CHECK 6 FAILED: owner trigger did not fire';
  exception when others then
    if sqlerrm like 'CHECK 6 FAILED%' or sqlerrm not like '%do not match code_session%' then raise; end if;
  end;
  if not exists (
    select 1 from pg_locks
     where locktype = 'advisory' and pid = pg_backend_pid() and granted
       and ((classid::bigint << 32) | objid::bigint) = hashtextextended('session_raw_units:00000000-0000-4000-8000-0000000a3130', 0)
  ) then
    raise exception 'CHECK 6 FAILED: no advisory lock held after a call in this transaction';
  end if;
end $$;

-- CHECK 7: p_rows = [] clears the session's units. (Two statements: one expression would read the table with the
-- snapshot taken before the volatile function ran.)
set local role service_role;
do $$
declare n int;
begin
  n := public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, ('[]'::jsonb)::jsonb, 'src-4'::text, 1::integer, null::text);
  if n <> 0 or exists (select 1 from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130') then
    raise exception 'CHECK 7 FAILED: empty p_rows did not clear the session';
  end if;
end $$;
reset role;

-- CHECK 8: repeated failure is not a rewrite. A session whose rows all failed to embed, called again with the same
-- failed rows, returns -1 with the same ids and a refreshed marker; a call that now HAS vectors replaces them; and an
-- incoming failure never replaces rows that hold a vector of the same model.
set local role service_role;
do $$
declare
  failed jsonb := jsonb_build_array(jsonb_build_object('unit','c700','ord',0,'turn_idx',0,'turn_from',0,'turn_to',0,'text','gamma',
      'embedding',null,'embedding_model','m+doc-v1','embedding_failed',true,'text_hash','g1'));
  good jsonb := jsonb_build_array(jsonb_build_object('unit','c700','ord',0,'turn_idx',0,'turn_from',0,'turn_to',0,'text','gamma',
      'embedding',pg_temp.onehot(5),'embedding_model','m+doc-v1','embedding_failed',false,'text_hash','g1'));
  id1 uuid; id2 uuid; t1 timestamptz;
begin
  perform public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, (failed)::jsonb, 'src-5'::text, 1::integer, null::text);
  select id, embedding_failed_at into id1, t1 from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130';
  update public.session_raw_units set embedding_failed_at = embedding_failed_at - interval '1 hour' where code_session_id = '00000000-0000-4000-8000-0000000a3130';
  if not public.raw_units_retry_due('00000000-0000-4000-8000-0000000a1130', '00000000-0000-4000-8000-0000000a3130', 900) then
    raise exception 'CHECK 8 FAILED: retry not due for a marker an hour old';
  end if;
  if public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, (failed)::jsonb, 'src-5'::text, 1::integer, null::text) <> -1 then
    raise exception 'CHECK 8 FAILED: repeated failure rewrote the rows';
  end if;
  select id into id2 from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130';
  if id1 <> id2 then raise exception 'CHECK 8 FAILED: row id changed'; end if;
  if public.raw_units_retry_due('00000000-0000-4000-8000-0000000a1130', '00000000-0000-4000-8000-0000000a3130', 900) then
    raise exception 'CHECK 8 FAILED: marker not refreshed (retry still due)';
  end if;
  if public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, (good)::jsonb, 'src-5'::text, 1::integer, null::text) <> 1 then
    raise exception 'CHECK 8 FAILED: vectors did not replace the failed rows';
  end if;
  if public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, (failed)::jsonb, 'src-5'::text, 1::integer, null::text) <> -1
     or (select embedding is null from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130') then
    raise exception 'CHECK 8 FAILED: an incoming failure replaced a stored vector';
  end if;
end $$;
reset role;

-- CHECK 9: raw_units_retry_due is service_role only.
set local role authenticated;
do $$
begin
  begin
    perform public.raw_units_retry_due('00000000-0000-4000-8000-0000000a1130', '00000000-0000-4000-8000-0000000a3130', 900);
    raise exception 'CHECK 9 FAILED: authenticated could call raw_units_retry_due';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

-- CHECK 10: p_content_hash race guard. Session a is at the "" pending sentinel: a writer with a hash gets -2 and writes
-- nothing; after the content hash is set, the matching hash writes, an older one gets -2 and leaves the rows alone.
do $$
declare r int; before_n int; after_n int;
begin
  delete from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130';
  update public.code_sessions set content_hash = '' where id = '00000000-0000-4000-8000-0000000a3130';
  r := public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, ((select jsonb_build_array(jsonb_build_object('unit','win','ord',0,'turn_idx',0,'turn_from',0,'turn_to',0,
          'win','[0,5)','text','abc','embedding_failed',true,'text_hash','hx')) ))::jsonb, 'sx'::text, 1::integer, 'new-hash'::text);
  if r <> -2 then raise exception 'CHECK 10 FAILED: pending sentinel should give -2, got %', r; end if;
  if (select count(*) from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130') <> 0 then
    raise exception 'CHECK 10 FAILED: -2 wrote rows';
  end if;
  update public.code_sessions set content_hash = 'new-hash' where id = '00000000-0000-4000-8000-0000000a3130';
  r := public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, ((select jsonb_build_array(jsonb_build_object('unit','win','ord',0,'turn_idx',0,'turn_from',0,'turn_to',0,
          'win','[0,5)','text','abc','embedding_failed',true,'text_hash','hx')) ))::jsonb, 'sx'::text, 1::integer, 'new-hash'::text);
  if r <> 1 then raise exception 'CHECK 10 FAILED: matching hash should write 1, got %', r; end if;
  r := public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, ('[]'::jsonb)::jsonb, 'sold'::text, 1::integer, 'old-hash'::text);
  if r <> -2 then raise exception 'CHECK 10 FAILED: older hash should give -2, got %', r; end if;
  if (select count(*) from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130') <> 1 then
    raise exception 'CHECK 10 FAILED: older writer changed the rows';
  end if;
end $$;

-- CHECK 11: chunked write (stage_session_raw_units + commit_session_raw_units). Session a holds 1 old unit here.
create function pg_temp.mkrows(word text, start int, n int) returns jsonb language sql as
$$ select coalesce(jsonb_agg(jsonb_build_object('unit','win','ord',i,'turn_idx',0,'turn_from',0,'turn_to',0,
     'win','[0,5)','text',word || ' unit ' || i,'embedding_failed',true,'text_hash','th' || word || i)), '[]'::jsonb)
   from generate_series(start, start + n - 1) i $$;

-- 11a: service_role only (functions and the stage table).
set local role authenticated;
do $$
begin
  begin
    perform public.stage_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, gen_random_uuid(), '[]'::jsonb);
    raise exception 'CHECK 11a FAILED: authenticated could call stage';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.commit_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, gen_random_uuid(), 0, 's', 1);
    raise exception 'CHECK 11a FAILED: authenticated could call commit';
  exception when insufficient_privilege then null;
  end;
  begin
    perform count(*) from public.session_raw_unit_stage;
    raise exception 'CHECK 11a FAILED: authenticated could read the stage table';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role anon;
do $$
begin
  begin
    perform public.stage_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, gen_random_uuid(), '[]'::jsonb);
    raise exception 'CHECK 11a FAILED: anon could call stage';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.commit_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, gen_random_uuid(), 0, 's', 1);
    raise exception 'CHECK 11a FAILED: anon could call commit';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
set local role service_role;
do $$
begin
  perform public.stage_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, gen_random_uuid(), '[]'::jsonb);
  if public.commit_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, gen_random_uuid(), 1, 's', 1) <> -3 then
    raise exception 'CHECK 11a FAILED: service_role commit of an unknown run should return -3';
  end if;
end $$;
reset role;

-- 11b: staged chunks are invisible to readers (the table and memory_raw_pools); the old unit stays.
do $$
declare r uuid := '00000000-0000-4000-8000-000000000b11'; n int;
begin
  perform public.stage_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, r, pg_temp.mkrows('zebra', 0, 3));
  perform public.stage_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, r, pg_temp.mkrows('zebra', 3, 2));
  if (select count(*) from public.session_raw_unit_stage where run_id = r) <> 5 then
    raise exception 'CHECK 11b FAILED: 5 rows should be staged';
  end if;
  if (select count(*) from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130'::uuid) <> 1 then
    raise exception 'CHECK 11b FAILED: the old units changed while only staged';
  end if;
  select count(*) into n from public.memory_raw_pools('00000000-0000-4000-8000-0000000a1130'::uuid, 'zebra', null, null, null, null, true) p where p.text like 'zebra%';
  if n <> 0 then raise exception 'CHECK 11b FAILED: memory_raw_pools saw % staged rows', n; end if;
  -- 11c: an incomplete commit (expected 6, staged 5) returns -3 and changes nothing
  if public.commit_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, r, 6, 'sx5', 1, 'new-hash') <> -3 then
    raise exception 'CHECK 11c FAILED: incomplete commit should return -3';
  end if;
  if (select count(*) from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130'::uuid) <> 1
     or (select count(*) from public.session_raw_unit_stage where run_id = r) <> 5 then
    raise exception 'CHECK 11c FAILED: -3 changed rows';
  end if;
  -- 11d: a stale content hash returns -2, drops the run's staged rows, keeps the old units
  if public.commit_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, r, 5, 'sx5', 1, 'older-hash') <> -2 then
    raise exception 'CHECK 11d FAILED: stale content hash should return -2';
  end if;
  if (select count(*) from public.session_raw_unit_stage where run_id = r) <> 0
     or (select count(*) from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130'::uuid) <> 1 then
    raise exception 'CHECK 11d FAILED: -2 left staged rows or changed units';
  end if;
end $$;

-- 11e: retry after the interruption completes: commit promotes all 5, the old unit is gone, the stage is empty, the
-- promoted rows are readable by memory_raw_pools.
do $$
declare r uuid := '00000000-0000-4000-8000-000000000b12'; n int;
begin
  perform public.stage_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, r, pg_temp.mkrows('zebra', 0, 3));
  perform public.stage_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, r, pg_temp.mkrows('zebra', 3, 2));
  if public.commit_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, r, 5, 'sx5', 1, 'new-hash') <> 5 then
    raise exception 'CHECK 11e FAILED: commit should promote 5';
  end if;
  if (select count(*) from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130'::uuid and text like 'zebra%' and source_hash = 'sx5' and units_version = 1) <> 5
     or (select count(*) from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130'::uuid) <> 5 then
    raise exception 'CHECK 11e FAILED: units after commit';
  end if;
  if (select count(*) from public.session_raw_unit_stage where code_session_id = '00000000-0000-4000-8000-0000000a3130'::uuid) <> 0 then
    raise exception 'CHECK 11e FAILED: stage not emptied';
  end if;
  select count(*) into n from public.memory_raw_pools('00000000-0000-4000-8000-0000000a1130'::uuid, 'zebra', null, null, null, null, true) p where p.text like 'zebra%';
  if n = 0 then raise exception 'CHECK 11e FAILED: promoted rows not readable'; end if;
  -- 11h: committing exactly what is stored returns -1 and empties the stage
  perform public.stage_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, '00000000-0000-4000-8000-000000000b13', pg_temp.mkrows('zebra', 0, 5));
  if public.commit_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, '00000000-0000-4000-8000-000000000b13', 5, 'sx5', 1, 'new-hash') <> -1 then
    raise exception 'CHECK 11h FAILED: identical rows should return -1';
  end if;
  if (select count(*) from public.session_raw_unit_stage where code_session_id = '00000000-0000-4000-8000-0000000a3130'::uuid) <> 0 then
    raise exception 'CHECK 11h FAILED: stage not emptied on -1';
  end if;
end $$;

-- 11f: commit ordering with two writers of one session: the first commit wins and wipes every staged run, the second
-- sees -3 (its rows are gone) and the stored set is the first writer's, complete.
do $$
declare ra uuid := '00000000-0000-4000-8000-000000000b21'; rb uuid := '00000000-0000-4000-8000-000000000b22';
begin
  perform public.stage_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, ra, pg_temp.mkrows('aardvark', 0, 2));
  perform public.stage_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, rb, pg_temp.mkrows('badger', 0, 3));
  if public.commit_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, rb, 3, 'sxb', 1, 'new-hash') <> 3 then
    raise exception 'CHECK 11f FAILED: first commit';
  end if;
  if public.commit_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, ra, 2, 'sxa', 1, 'new-hash') <> -3 then
    raise exception 'CHECK 11f FAILED: second commit should return -3';
  end if;
  if (select count(*) from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130'::uuid and text like 'badger%') <> 3
     or (select count(*) from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130'::uuid) <> 3 then
    raise exception 'CHECK 11f FAILED: stored set is not the first writer''s';
  end if;
end $$;

-- 11g: GC. A stale run of this session and a 2-day-old row of another session are removed by the next stage call;
-- a fresh run of another writer is kept; a small replace removes this session's orphans.
do $$
declare ro uuid := '00000000-0000-4000-8000-000000000b31'; rf uuid := '00000000-0000-4000-8000-000000000b32';
        rn uuid := '00000000-0000-4000-8000-000000000b33';
begin
  insert into public.session_raw_unit_stage (user_id, code_session_id, code_project_id, run_id, unit, ord, text, text_hash, created_at)
  values ('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, '00000000-0000-4000-8000-0000000a2130', ro, 'win', 0, 'orphan', 'tho', now() - interval '2 hours'),
         ('00000000-0000-4000-8000-0000000b1130', '00000000-0000-4000-8000-0000000b3130', '00000000-0000-4000-8000-0000000b2130', ro, 'win', 0, 'orphan b', 'thob', now() - interval '2 days');
  perform public.stage_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, rf, pg_temp.mkrows('fresh', 0, 1));
  perform public.stage_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, rn, pg_temp.mkrows('newer', 0, 1));
  if exists (select 1 from public.session_raw_unit_stage where run_id = ro) then
    raise exception 'CHECK 11g FAILED: stale orphans survived the stage-call GC';
  end if;
  if (select count(*) from public.session_raw_unit_stage where run_id in (rf, rn)) <> 2 then
    raise exception 'CHECK 11g FAILED: fresh runs were collected';
  end if;
  perform public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, pg_temp.mkrows('small', 0, 1), 'sxs', 1, 'new-hash');
  if exists (select 1 from public.session_raw_unit_stage where code_session_id = '00000000-0000-4000-8000-0000000a3130'::uuid) then
    raise exception 'CHECK 11g FAILED: replace left this session''s orphans';
  end if;
end $$;

-- 11i: a commit whose embed FAILED never overwrites a stored good vector (same semantics as replace: -1, vector kept).
do $$
declare good jsonb; failed jsonb; r uuid := '00000000-0000-4000-8000-000000000b41';
begin
  good := jsonb_build_array(jsonb_build_object('unit','win','ord',0,'turn_idx',0,'turn_from',0,'turn_to',0,'win','[0,5)',
    'text','vec unit 0','embedding',pg_temp.onehot(1),'embedding_model','m1','embedding_failed',false,'text_hash','thvec0'));
  failed := jsonb_build_array(jsonb_build_object('unit','win','ord',0,'turn_idx',0,'turn_from',0,'turn_to',0,'win','[0,5)',
    'text','vec unit 0','embedding_model','m1','embedding_failed',true,'text_hash','thvec0'));
  if public.replace_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, good, 'sxv', 1, 'new-hash') <> 1 then
    raise exception 'CHECK 11i FAILED: seed';
  end if;
  perform public.stage_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, r, failed);
  if public.commit_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, r, 1, 'sxv', 1, 'new-hash') <> -1 then
    raise exception 'CHECK 11i FAILED: failed-embed commit over a good vector should return -1';
  end if;
  if (select count(*) from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130'::uuid and embedding is not null and embedding_model = 'm1') <> 1 then
    raise exception 'CHECK 11i FAILED: the good vector was overwritten';
  end if;
  -- and a failed embed promoted into an empty slot stores NULL model (not the intended one)
  delete from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130'::uuid;
  perform public.stage_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, r, failed);
  if public.commit_session_raw_units('00000000-0000-4000-8000-0000000a1130'::uuid, '00000000-0000-4000-8000-0000000a3130'::uuid, r, 1, 'sxv', 1, 'new-hash') <> 1 then
    raise exception 'CHECK 11i FAILED: promote failed row';
  end if;
  if (select count(*) from public.session_raw_units where code_session_id = '00000000-0000-4000-8000-0000000a3130'::uuid and embedding is null
        and embedding_model is null and embedding_failed_at is not null) <> 1 then
    raise exception 'CHECK 11i FAILED: promoted failed row should have null vector, null model, failure marker';
  end if;
end $$;

rollback;

-- Concurrency recipe (two psql sessions; this file cannot show it in one transaction). With one user/session seeded and
-- committed, in psql A:  begin; select replace_session_raw_units(<same args>);  -- holds the lock, do not commit yet
-- in psql B:             select replace_session_raw_units(<same args>);          -- blocks
-- then commit A: B returns -1 (rows already current) and the session still has exactly one set of rows.
