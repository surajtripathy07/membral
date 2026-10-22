-- L1 SQL check for apply_memory_reconciliation (migration 124). BENCH DB ONLY (never prod, never the shared local DB):
--   docker exec -i membral-w4b-db-1 psql -U postgres -v ON_ERROR_STOP=1 < scripts/sql-checks/memory-reconciliation-apply.sql
-- Runs in one transaction and ROLLS BACK; prints PASS lines, raises on a failure.
begin;
do $$
declare
  u uuid; p uuid; a uuid; b uuid; c uuid; n int;
begin
  select user_id, code_project_id into u, p from session_memories where code_project_id is not null limit 1;
  select id into a from session_memories where user_id = u and code_project_id = p and retired_at is null and valid_to is null and kind = 'decision' order by id limit 1;
  select id into b from session_memories where user_id = u and code_project_id = p and retired_at is null and valid_to is null and kind = 'decision' and id <> a order by id limit 1;
  select id into c from session_memories where user_id = u and code_project_id = p and retired_at is null and valid_to is null and kind = 'decision' and id not in (a, b) order by id limit 1;

  -- 1. a memoised 'unrelated' row is upgraded by a later supersedes verdict, and the projection follows
  perform apply_memory_reconciliation(u, 'r1', 'm', 'v', jsonb_build_array(jsonb_build_object('from_id', b, 'to_id', a, 'relation', 'unrelated', 'verified', false)), '[]');
  n := apply_memory_reconciliation(u, 'r2', 'm', 'v',
    jsonb_build_array(jsonb_build_object('from_id', b, 'to_id', a, 'relation', 'supersedes', 'quote', 'q', 'verified', true)),
    jsonb_build_array(jsonb_build_object('id', a, 'superseded_by', b, 'supersede_kind', 'supersedes', 'valid_to', now())));
  if n <> 1 then raise exception 'FAIL 1: expected 1 hidden, got %', n; end if;
  if (select relation || verified::text from memory_links where from_id = b and to_id = a and prompt_version = 'v') <> 'supersedestrue' then
    raise exception 'FAIL 1: link not upgraded'; end if;
  raise notice 'PASS 1 unrelated memo upgraded, projection applied';

  -- 2. no projection without a verified hiding link behind it
  n := apply_memory_reconciliation(u, 'r3', 'm', 'v2', '[]',
    jsonb_build_array(jsonb_build_object('id', c, 'superseded_by', b, 'supersede_kind', 'supersedes', 'valid_to', now())));
  if n <> 0 then raise exception 'FAIL 2: projected without a link'; end if;
  perform apply_memory_reconciliation(u, 'r4', 'm', 'v2', jsonb_build_array(jsonb_build_object('from_id', b, 'to_id', c, 'relation', 'unrelated', 'verified', false)),
    jsonb_build_array(jsonb_build_object('id', c, 'superseded_by', b, 'supersede_kind', 'supersedes', 'valid_to', now())));
  if (select superseded_by from session_memories where id = c) is not null then raise exception 'FAIL 2: projected on an unrelated link'; end if;
  raise notice 'PASS 2 no projection without a verified hiding link';

  -- 3. self-link rejected
  n := apply_memory_reconciliation(u, 'r5', 'm', 'v3', '[]',
    jsonb_build_array(jsonb_build_object('id', c, 'superseded_by', c, 'supersede_kind', 'supersedes', 'valid_to', now())));
  if n <> 0 then raise exception 'FAIL 3: self projection'; end if;
  raise notice 'PASS 3 self projection refused';

  -- 4. valid_to set with no superseded_by is left untouched
  update session_memories set valid_to = now() where id = c;
  perform apply_memory_reconciliation(u, 'r6', 'm', 'v4', jsonb_build_array(jsonb_build_object('from_id', b, 'to_id', c, 'relation', 'supersedes', 'quote', 'q', 'verified', true)),
    jsonb_build_array(jsonb_build_object('id', c, 'superseded_by', b, 'supersede_kind', 'supersedes', 'valid_to', now())));
  if (select superseded_by from session_memories where id = c) is not null then raise exception 'FAIL 4: touched a valid_to-only row'; end if;
  raise notice 'PASS 4 valid_to-only row untouched';
end $$;
rollback;
