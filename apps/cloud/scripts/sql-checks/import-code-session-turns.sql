-- Manual atomicity check for public.import_code_session_turns (migration 112, issue #175).
-- Design: docs/design/import-turns-transaction.md §5. Runs inside begin … rollback, so it
-- leaves no data. Each check raises on failure; a clean run ends with ROLLBACK.
--
--   PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f apps/cloud/scripts/sql-checks/import-code-session-turns.sql

begin;

-- Seed: one user (the 004 trigger creates the profile), project, session and 3 turns.
insert into auth.users (id, email)
values ('00000000-0000-4000-8000-0000000c0175', 'sql-check-175@example.com');

insert into public.code_projects (id, user_id, repo_identity)
values ('00000000-0000-4000-8000-0000000d0175', '00000000-0000-4000-8000-0000000c0175', 'code-project:sql-check-175');

insert into public.code_sessions (id, user_id, code_project_id, source, source_session_id, content_hash)
values ('00000000-0000-4000-8000-0000000e0175', '00000000-0000-4000-8000-0000000c0175',
        '00000000-0000-4000-8000-0000000d0175', 'claude-code', 'sql-check-175', '');

insert into public.code_session_turns (user_id, session_id, idx, role, kind, text)
select '00000000-0000-4000-8000-0000000c0175', '00000000-0000-4000-8000-0000000e0175', i, 'user', 'prose', 'old ' || i
  from generate_series(0, 2) as i;

create temp table old_turn_ids on commit drop as
  select id from public.code_session_turns where session_id = '00000000-0000-4000-8000-0000000e0175';
grant select on old_turn_ids to service_role, authenticated;

set local role service_role;

-- 1. Duplicate idx: the unique violation fires after the function's own delete;
--    the whole call rolls back and the 3 original rows remain.
--    The DO block's exception handler makes a savepoint that stands in for PostgREST's request transaction; the function has no exception block, so its delete is undone the same way in both.
do $$
declare
  kept integer;
begin
  begin
    perform public.import_code_session_turns(
      '00000000-0000-4000-8000-0000000c0175', '00000000-0000-4000-8000-0000000e0175',
      '[{"idx":0,"role":"user","kind":"prose","text":"a"},{"idx":0,"role":"user","kind":"prose","text":"b"}]'::jsonb);
    raise exception 'CHECK 1 FAILED: duplicate idx did not raise';
  exception when unique_violation then
    null;
  end;
  select count(*) into kept
    from public.code_session_turns t join old_turn_ids o using (id)
   where t.session_id = '00000000-0000-4000-8000-0000000e0175';
  if kept <> 3 or (select count(*) from public.code_session_turns
                    where session_id = '00000000-0000-4000-8000-0000000e0175') <> 3 then
    raise exception 'CHECK 1 FAILED: expected the 3 original turns, found % of them', kept;
  end if;
  raise notice 'CHECK 1 ok: duplicate idx raised, 3 original turns remain';
end;
$$;

-- 2. Wrong p_user_id: raises, changes nothing.
do $$
begin
  begin
    perform public.import_code_session_turns(
      '00000000-0000-4000-8000-0000000c9999', '00000000-0000-4000-8000-0000000e0175',
      '[{"idx":0,"role":"user","kind":"prose","text":"x"}]'::jsonb);
    raise exception 'CHECK 2 FAILED: wrong user did not raise';
  exception when raise_exception then
    if sqlerrm like 'CHECK 2 FAILED%' then raise; end if;
  end;
  if (select count(*) from public.code_session_turns t join old_turn_ids o using (id)) <> 3 then
    raise exception 'CHECK 2 FAILED: turns changed after a wrong-user call';
  end if;
  raise notice 'CHECK 2 ok: wrong user raised, turns unchanged';
end;
$$;

-- 3. Valid 2-turn payload: returns 2, leaves exactly those 2 rows.
do $$
declare
  n integer;
begin
  n := public.import_code_session_turns(
    '00000000-0000-4000-8000-0000000c0175', '00000000-0000-4000-8000-0000000e0175',
    '[{"idx":0,"role":"user","kind":"prose","text":"new 0","ts":"2026-09-28T10:00:00Z"},
      {"idx":1,"role":"assistant","kind":"tool_use","tool_name":"Edit","file_path":"/tmp/a.ts","props":{"toolUseId":"t1"}}]'::jsonb);
  if n <> 2 then
    raise exception 'CHECK 3 FAILED: returned %, expected 2', n;
  end if;
  if (select count(*) from public.code_session_turns
       where session_id = '00000000-0000-4000-8000-0000000e0175') <> 2 then
    raise exception 'CHECK 3 FAILED: expected 2 rows';
  end if;
  if (select count(*) from public.code_session_turns t join old_turn_ids o using (id)) <> 0 then
    raise exception 'CHECK 3 FAILED: old turns survived a successful call';
  end if;
  if (select props from public.code_session_turns
       where session_id = '00000000-0000-4000-8000-0000000e0175' and idx = 0) <> '{}'::jsonb then
    raise exception 'CHECK 3 FAILED: missing props did not default to {}';
  end if;
  raise notice 'CHECK 3 ok: returned 2, 2 new rows';
end;
$$;

reset role;
set local role authenticated;

-- 4. authenticated has no EXECUTE.
do $$
begin
  begin
    perform public.import_code_session_turns(
      '00000000-0000-4000-8000-0000000c0175', '00000000-0000-4000-8000-0000000e0175', '[]'::jsonb);
    raise exception 'CHECK 4 FAILED: authenticated could execute the function';
  exception when insufficient_privilege then
    raise notice 'CHECK 4 ok: authenticated -> %', sqlerrm;
  end;
end;
$$;

reset role;
rollback;
