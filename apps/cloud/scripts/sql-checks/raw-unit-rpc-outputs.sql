-- Manual check for migrations 131 and 132 (outputs of memory_raw_pools / memory_raw_cover, memory_raw_term_stats and the
-- lab tokenizer session_raw_unit_terms); i33-port PR 4. Run it against a throwaway database
-- that has migrations 001-132 applied. Runs inside begin ... rollback, so it leaves no data. Each check raises on
-- failure; a clean run ends with ROLLBACK.
--
--   PGPASSWORD=postgres psql -h 127.0.0.1 -p 54322 -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f apps/cloud/scripts/sql-checks/raw-unit-rpc-outputs.sql

begin;

create function pg_temp.onehot(i int) returns vector language sql as
$$ select (array_fill(0::float8, array[i - 1]) || array[1::float8] || array_fill(0::float8, array[1536 - i]))::vector(1536) $$;

insert into auth.users (id, email) values
  ('00000000-0000-4000-8000-0000000a1131', 'sql-check-131-a@example.com'),
  ('00000000-0000-4000-8000-0000000b1131', 'sql-check-131-b@example.com');

insert into public.code_projects (id, user_id, repo_identity) values
  ('00000000-0000-4000-8000-0000000a2131', '00000000-0000-4000-8000-0000000a1131', 'code-project:sql-check-131-a'),
  ('00000000-0000-4000-8000-0000000b2131', '00000000-0000-4000-8000-0000000b1131', 'code-project:sql-check-131-b');

insert into public.code_sessions (id, user_id, code_project_id, source, source_session_id, content_hash, started_at) values
  ('00000000-0000-4000-8000-0000000a3131', '00000000-0000-4000-8000-0000000a1131',
   '00000000-0000-4000-8000-0000000a2131', 'claude-code', 'sql-check-131-a', '', '2026-10-10T08:00:00Z'),
  ('00000000-0000-4000-8000-0000000b3131', '00000000-0000-4000-8000-0000000b1131',
   '00000000-0000-4000-8000-0000000b2131', 'claude-code', 'sql-check-131-b', '', '2026-10-11T08:00:00Z');

-- A: turns 0, 2 and 7 (gaps on purpose: the neighbours of turn 2 are 0 and 7, not 1 and 3) and one window in turn 2.
-- Every unit shares one embedding so the dense leg returns them all. B holds a turn with the same text and embedding.
insert into public.session_raw_units
  (id, user_id, code_session_id, code_project_id, unit, ord, turn_idx, turn_from, turn_to, win, parts, text,
   full_text, turn_text, embedding, embedding_model, text_hash, units_version, source_hash)
values
  ('00000000-0000-4000-8000-0000000a4000', '00000000-0000-4000-8000-0000000a1131',
   '00000000-0000-4000-8000-0000000a3131', '00000000-0000-4000-8000-0000000a2131', 'turn', 0, 0, 0, 0, null,
   '{"turn_len": 40}', 'user: zebra migration plan', 'user: zebra migration plan', 'zebra migration plan',
   pg_temp.onehot(1), 'm', 'h-a0', 1, 's-a'),
  ('00000000-0000-4000-8000-0000000a4002', '00000000-0000-4000-8000-0000000a1131',
   '00000000-0000-4000-8000-0000000a3131', '00000000-0000-4000-8000-0000000a2131', 'turn', 1, 2, 2, 2, null,
   '{"turn_len": 90}', 'assistant: the zebra table is renamed', 'assistant: the zebra table is renamed and indexed',
   'the zebra table is renamed and indexed', pg_temp.onehot(1), 'm', 'h-a2', 1, 's-a'),
  ('00000000-0000-4000-8000-0000000a4007', '00000000-0000-4000-8000-0000000a1131',
   '00000000-0000-4000-8000-0000000a3131', '00000000-0000-4000-8000-0000000a2131', 'turn', 2, 7, 7, 7, null,
   '{"turn_len": 30}', 'user: ship it', 'user: ship it', 'ship it', pg_temp.onehot(2), 'm', 'h-a7', 1, 's-a'),
  ('00000000-0000-4000-8000-0000000a4100', '00000000-0000-4000-8000-0000000a1131',
   '00000000-0000-4000-8000-0000000a3131', '00000000-0000-4000-8000-0000000a2131', 'win', 0, 2, 2, 2, '[0,38)',
   null, 'the zebra table is renamed and indexed', null, null, pg_temp.onehot(1), 'm', 'h-aw', 1, 's-a'),
  ('00000000-0000-4000-8000-0000000b4000', '00000000-0000-4000-8000-0000000b1131',
   '00000000-0000-4000-8000-0000000b3131', '00000000-0000-4000-8000-0000000b2131', 'turn', 0, 0, 0, 0, null,
   '{"turn_len": 40}', 'user: zebra migration plan', 'user: zebra migration plan', 'zebra migration plan',
   pg_temp.onehot(1), 'm', 'h-b0', 1, 's-b');

set local role service_role;
do $$
declare
  n integer;
  r record;
  a_user constant uuid := '00000000-0000-4000-8000-0000000a1131';
begin
  -- 1. Pools: the new columns. Two query lexemes (zebra, tabl after stemming: 'zebra table'); the turn row of turn 2
  -- contains both, the turn row of turn 0 only 'zebra'.
  select * into r from public.memory_raw_pools(a_user, 'zebra table', pg_temp.onehot(1), 'm', 0, null, true)
    where pool = 'r3' and id = '00000000-0000-4000-8000-0000000a4002';
  if not found then raise exception 'CHECK 1 FAILED: r3 row for A''s turn 2 missing'; end if;
  if r.query_lexemes <> 2 then raise exception 'CHECK 1 FAILED: query_lexemes % <> 2', r.query_lexemes; end if;
  if r.lex_hits <> 2 then raise exception 'CHECK 1 FAILED: lex_hits % <> 2 for the turn holding both lexemes', r.lex_hits; end if;
  if r.full_text <> 'assistant: the zebra table is renamed and indexed' then
    raise exception 'CHECK 1 FAILED: r3 row has full_text %', r.full_text; end if;
  if r.session_time <> '2026-10-10T08:00:00Z'::timestamptz then
    raise exception 'CHECK 1 FAILED: session_time %', r.session_time; end if;
  select * into r from public.memory_raw_pools(a_user, 'zebra table', pg_temp.onehot(1), 'm', 0, null, true)
    where pool = 'r3' and id = '00000000-0000-4000-8000-0000000a4000';
  if r.lex_hits <> 1 then raise exception 'CHECK 1 FAILED: lex_hits % <> 1 for the turn holding one lexeme', r.lex_hits; end if;
  select count(*) into n from public.memory_raw_pools(a_user, 'zebra table', pg_temp.onehot(1), 'm', 0, null, true)
    where pool <> 'r3' and full_text is not null;
  if n <> 0 then raise exception 'CHECK 1 FAILED: % non-r3 rows carry full_text', n; end if;
  select * into r from public.memory_raw_pools(a_user, 'the', pg_temp.onehot(1), 'm', 0, null, true) limit 1;
  if r.query_lexemes <> 0 or r.lex_hits <> 0 then
    raise exception 'CHECK 1 FAILED: a query of stop words must give 0 lexemes / 0 hits, got % / %', r.query_lexemes, r.lex_hits; end if;
  raise notice 'CHECK 1 ok: pools carry session_time, lex_hits, query_lexemes and r3 full_text';

  -- 1b. R2's lexical leg is the lab's idf score and sees the session title; session_time is the session's end.
  update public.code_sessions set ended_at = '2026-10-12T20:00:00Z', title = 'Quokka rollout'
    where id = '00000000-0000-4000-8000-0000000a3131';
  select * into r from public.memory_raw_pools(a_user, 'quokka zebra', pg_temp.onehot(1), 'm', 0, null, true)
    where pool = 'r2' and id = '00000000-0000-4000-8000-0000000a4100';
  if not found then raise exception 'CHECK 1b FAILED: r2 window row missing'; end if;
  -- one window (N = 1): 'zebra' df 1 via fts, 'quokka' df 1 via the title only -> 2 * ln(1 + 1/1)
  if abs(r.lex_score - 2 * ln(2)) > 1e-9 then raise exception 'CHECK 1b FAILED: lex_score % <> 2 ln 2', r.lex_score; end if;
  if r.lex_hits <> 2 or r.query_lexemes <> 2 then
    raise exception 'CHECK 1b FAILED: lex_hits / query_lexemes % / %', r.lex_hits, r.query_lexemes; end if;
  if r.session_time <> '2026-10-12T20:00:00Z'::timestamptz then
    raise exception 'CHECK 1b FAILED: session_time % is not ended_at', r.session_time; end if;
  raise notice 'CHECK 1b ok: r2 idf score, title lexeme and ended_at session_time';

  -- 2. Cover: the window's own turn row and its STORED neighbours (0 and 7, across the gaps), once each, with turn_len.
  select count(*) into n from public.memory_raw_cover(a_user, array['00000000-0000-4000-8000-0000000a4100']::uuid[], '{}')
    where kind = 'turn' and b_id = '00000000-0000-4000-8000-0000000a4002' and turn_idx = 2 and turn_len = 90
      and code_session_id = '00000000-0000-4000-8000-0000000a3131'
      and turn_text = 'the zebra table is renamed and indexed';
  if n <> 1 then raise exception 'CHECK 2 FAILED: expected the window''s own turn row once, got %', n; end if;
  select count(*) into n from public.memory_raw_cover(a_user, array['00000000-0000-4000-8000-0000000a4100']::uuid[], '{}')
    where kind = 'neighbour' and turn_idx in (0, 7);
  if n <> 2 then raise exception 'CHECK 2 FAILED: expected stored neighbours 0 and 7, got % rows', n; end if;
  select count(*) into n from public.memory_raw_cover(a_user, array['00000000-0000-4000-8000-0000000a4100']::uuid[], '{}')
    where kind = 'neighbour' and turn_idx in (1, 3);
  if n <> 0 then raise exception 'CHECK 2 FAILED: neighbours must be stored rows, not turn_idx -/+ 1'; end if;
  -- two windows / turns of one turn -> still one row per distinct turn row
  select count(*) into n from public.memory_raw_cover(a_user,
      array['00000000-0000-4000-8000-0000000a4100', '00000000-0000-4000-8000-0000000a4002']::uuid[], '{}')
    where kind = 'turn' and b_id = '00000000-0000-4000-8000-0000000a4002';
  if n <> 1 then raise exception 'CHECK 2 FAILED: turn row repeated % times', n; end if;
  -- c700 units get no turn rows: a unit that is not win / turn contributes none.
  -- (no c700 fixture row: the branch is the `a.unit in (win, turn)` filter, exercised by the pair rows below)
  select count(*) into n from public.memory_raw_cover(a_user,
      array['00000000-0000-4000-8000-0000000a4100', '00000000-0000-4000-8000-0000000a4002']::uuid[], '{}')
    where kind = 'unit_unit' and cosine >= 0.99;
  if n <> 1 then raise exception 'CHECK 2 FAILED: unit_unit pair of the 129 contract lost (% rows)', n; end if;
  -- B's turn never appears for A
  select count(*) into n from public.memory_raw_cover(a_user,
      array['00000000-0000-4000-8000-0000000a4100', '00000000-0000-4000-8000-0000000b4000']::uuid[], '{}')
    where b_id = '00000000-0000-4000-8000-0000000b4000' or a_id = '00000000-0000-4000-8000-0000000b4000';
  if n <> 0 then raise exception 'CHECK 2 FAILED: B''s unit leaked into A''s cover (% rows)', n; end if;
  raise notice 'CHECK 2 ok: cover returns own and stored-neighbour turn rows once each with turn_len, 129 pairs intact';

  -- 3. Term stats (132): df counts the lab's tokens (session_raw_unit_terms) of A's turn rows, not english lexemes. A has
  -- three turn rows: 'user: zebra migration plan' (turn 0), 'assistant: the zebra table is renamed and indexed' (turn 2)
  -- and 'user: ship it' (turn 7); the null-term row carries their count. Query terms are the lab's folded tokens.
  select count(*) into n from public.memory_raw_term_stats(a_user, array['zebra', 'table', 'renam', 'renamed', 'nothing'])
    where term = 'zebra' and df = 2 and total = 3;
  if n <> 1 then raise exception 'CHECK 3 FAILED: zebra df'; end if;
  -- 'table' ends in 'e': no suffix is folded, and only turn 2 holds it -> df 1 (the stemmed 131 form 'tabl' is not a lab token).
  select count(*) into n from public.memory_raw_term_stats(a_user, array['zebra', 'table', 'renam', 'renamed', 'nothing'])
    where term = 'table' and df = 1;
  if n <> 1 then raise exception 'CHECK 3 FAILED: df of "table"'; end if;
  -- 'renamed' folds (ed rule, length > 4) to 'renam'; the stored token is the folded one, so the folded query hits and the
  -- unfolded surface form does not.
  select count(*) into n from public.memory_raw_term_stats(a_user, array['zebra', 'table', 'renam', 'renamed', 'nothing'])
    where term = 'renam' and df = 1;
  if n <> 1 then raise exception 'CHECK 3 FAILED: df of the folded token "renam"'; end if;
  select count(*) into n from public.memory_raw_term_stats(a_user, array['zebra', 'table', 'renam', 'renamed', 'nothing'])
    where term = 'renamed' and df = 0;
  if n <> 1 then raise exception 'CHECK 3 FAILED: the unfolded "renamed" must not be a stored token'; end if;
  select count(*) into n from public.memory_raw_term_stats(a_user, array['zebra', 'table', 'renam', 'renamed', 'nothing'])
    where term = 'nothing' and df = 0;
  if n <> 1 then raise exception 'CHECK 3 FAILED: df of an absent term'; end if;
  select count(*) into n from public.memory_raw_term_stats(a_user, '{}') where term is null and total = 3;
  if n <> 1 then raise exception 'CHECK 3 FAILED: total row for an empty term list'; end if;
  -- the tokenizer itself: lowercase, folded, de-duplicated, length 2..255 on the raw token
  if public.session_raw_unit_terms('Tables, Running a x ' || repeat('q', 256) || ' it''s') is distinct from
     array['it', 'runn', 'tabl']::text[] then
    raise exception 'CHECK 3 FAILED: session_raw_unit_terms gave %', public.session_raw_unit_terms('Tables, Running a x ' || repeat('q', 256) || ' it''s');
  end if;
  raise notice 'CHECK 3 ok: term stats count the user''s turn rows only, with the lab tokenizer';
end;
$$;
reset role;

-- 4. Grants: authenticated cannot call the new function or the recreated ones.
set local role authenticated;
do $$
begin
  begin
    perform * from public.memory_raw_term_stats('00000000-0000-4000-8000-0000000a1131', '{}');
    raise exception 'CHECK 4 FAILED: authenticated called memory_raw_term_stats';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.memory_raw_pools('00000000-0000-4000-8000-0000000a1131', 'zebra');
    raise exception 'CHECK 4 FAILED: authenticated called memory_raw_pools';
  exception when insufficient_privilege then null;
  end;
  begin
    perform * from public.memory_raw_cover('00000000-0000-4000-8000-0000000a1131', '{}', '{}');
    raise exception 'CHECK 4 FAILED: authenticated called memory_raw_cover';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.session_raw_unit_terms('x');
    raise exception 'CHECK 4 FAILED: authenticated called session_raw_unit_terms';
  exception when insufficient_privilege then null;
  end;
  raise notice 'CHECK 4 ok: authenticated gets permission denied on all three RPCs and the tokenizer';
end;
$$;
reset role;

rollback;
