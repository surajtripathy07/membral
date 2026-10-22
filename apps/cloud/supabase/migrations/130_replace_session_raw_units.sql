-- ============================================================
-- 130_replace_session_raw_units.sql
-- Write path of the raw units (docs/design/i33-port.md section 5, PR 2): one function that swaps a session's
-- `session_raw_units` rows in a single transaction. The TypeScript writer (apps/cloud/src/lib/memory/raw-units/)
-- builds the units and embeds them FIRST, outside any transaction, then calls this once with the finished rows.
-- Depends on: 029 (code_sessions), 129 (session_raw_units and its owner trigger).
--
--   1. ownership check: the session must be p_user_id's (user_id and code_project_id of every row come from the
--      session row, never from p_rows; the 129 owner trigger still runs on each insert)
--   2. pg_advisory_xact_lock per session: concurrent writers of one session take turns
--   3. already current: when the session already holds exactly these rows (same unit, ord, text_hash, p_source_hash;
--      a vector of the incoming model, or no vector on both sides), nothing is written and -1 is returned, so the
--      second of two concurrent writers does not rewrite them, a writer whose embeddings failed never overwrites rows
--      that embedded fine, and a repeated failure only refreshes embedding_failed_at (the backoff clock)
--   3b. p_content_hash (optional): when given and different from code_sessions.content_hash (or the "" pending
--      sentinel), return -2 and write nothing, so an older writer never overwrites newer units
--   4. delete this session's units, insert p_rows, return the number inserted (p_rows = [] just clears the session)
-- No exception block: every error propagates and rolls the whole call back, so a failure keeps the previous units.
--
-- CHUNKED WRITE (sessions whose rows exceed one rpc's payload): `session_raw_unit_stage` + `stage_session_raw_units`
-- + `commit_session_raw_units`. The writer sends bounded chunks (~8 MB incl. vectors) into the staging table, each its
-- own rpc, then ONE commit call that, under the per-session advisory lock and in one transaction, checks ownership and
-- p_content_hash (-2 and the run's staged rows dropped), checks the staged row count equals p_expected_count (-3,
-- nothing changed; the staged rows stay as orphans until the next write of the session collects them), returns -1 if the session already holds exactly
-- these rows, else deletes the old rows and promotes the staged rows. Readers (129's functions and table) never see the
-- stage table, so until the commit they see the old units exactly and after it the complete new set. A crash or error
-- between chunks leaves only orphans in the stage table: any later write of the session (stage or replace or commit)
-- removes its orphans (this run's predecessors older than p_stale_seconds in stage; everything in replace/commit), and
-- every stage call also deletes up to 1000 staged rows of any session older than one day. Migration 129 is unchanged.
-- Row shape (jsonb array): unit, ord, turn_idx, turn_from, turn_to, parts, win ('[s,e)'), text, full_text, turn_text,
-- embedding (pgvector text or null), embedding_model, embedding_failed (true => embedding_failed_at = now()),
-- text_hash. p_units_version and p_source_hash are stamped on every row.
-- Security as 112/121/129: SECURITY INVOKER, revoked from public/anon/authenticated, service_role only.
-- Additive: a stage table and four new functions. Rollback: drop function public.commit_session_raw_units(uuid, uuid, uuid, integer, text, integer, text); drop function public.stage_session_raw_units(uuid, uuid, uuid, jsonb, integer); drop table public.session_raw_unit_stage; drop function public.replace_session_raw_units(uuid, uuid, jsonb, text, integer, text); drop function public.raw_units_retry_due(uuid, uuid, integer);
-- the writer then logs an rpc error per session and leaves the existing units in place.
-- ============================================================

set search_path = public, extensions;

-- Staging area of the chunked write. NOT read by anything in 129. No indexes beyond the primary key and the run key
-- (the HNSW and GIN indexes live on session_raw_units only), RLS on with no policy (service_role only).
create table if not exists public.session_raw_unit_stage (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  code_session_id      uuid not null references public.code_sessions(id) on delete cascade,
  code_project_id      uuid not null references public.code_projects(id) on delete cascade,
  run_id               uuid not null,
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
  embedding            vector(1536),
  embedding_model      text,
  embedding_failed_at  timestamptz,
  text_hash            text not null,
  created_at           timestamptz not null default now(),
  unique (code_session_id, run_id, unit, ord)
);
create index if not exists session_raw_unit_stage_created_idx on public.session_raw_unit_stage (created_at);
alter table public.session_raw_unit_stage enable row level security;
revoke all on public.session_raw_unit_stage from public;
revoke all on public.session_raw_unit_stage from anon;
revoke all on public.session_raw_unit_stage from authenticated;
grant select, insert, delete on public.session_raw_unit_stage to service_role;

-- The first draft of this function had no p_content_hash; drop that exact signature so no stale 5-arg overload stays.
drop function if exists public.replace_session_raw_units(uuid, uuid, jsonb, text, integer);

create or replace function public.replace_session_raw_units(
  p_user_id uuid,
  p_code_session_id uuid,
  p_rows jsonb,
  p_source_hash text,
  p_units_version integer,
  p_content_hash text default null
)
returns integer
language plpgsql
volatile
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  v_project uuid;
  v_content_hash text;
  v_existing integer;
  v_incoming integer;
  v_same integer;
  n integer;
begin
  select cs.code_project_id into v_project
    from public.code_sessions cs
   where cs.id = p_code_session_id
     and cs.user_id = p_user_id;
  if not found then
    raise exception 'replace_session_raw_units: session % not found for user %', p_code_session_id, p_user_id;
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'replace_session_raw_units: p_rows must be a jsonb array';
  end if;
  if p_source_hash is null or p_source_hash = '' or p_units_version is null then
    raise exception 'replace_session_raw_units: p_source_hash and p_units_version are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('session_raw_units:' || p_code_session_id::text, 0));

  -- Race guard: the writer embedded the turns of content p_content_hash. When the session's stored content_hash is
  -- different (a newer import landed) or still the "" pending sentinel (an import is mid-flight), these units are
  -- from an older or unconfirmed content: write nothing, return -2. A null p_content_hash skips the check (sweeps).
  if p_content_hash is not null then
    select cs.content_hash into v_content_hash from public.code_sessions cs where cs.id = p_code_session_id;
    if v_content_hash is distinct from p_content_hash then
      return -2;
    end if;
  end if;

  select count(*) into v_existing from public.session_raw_units u where u.code_session_id = p_code_session_id;
  v_incoming := jsonb_array_length(p_rows);

  if v_incoming > 0 and v_existing = v_incoming then
    -- Nothing would change when every incoming row has the same (unit, ord, text_hash) under the same source_hash and
    -- version AND either the stored row holds a vector of the incoming model (an incoming failed embed never
    -- replaces a good vector), or both the stored and the incoming row have no vector.
    select count(*) into v_same
      from public.session_raw_units u
      join jsonb_to_recordset(p_rows) as r(unit text, ord int, embedding_model text, embedding text,
                                           embedding_failed boolean, text_hash text)
        on r.unit = u.unit and r.ord = u.ord
     where u.code_session_id = p_code_session_id
       and u.source_hash = p_source_hash
       and u.units_version = p_units_version
       and u.text_hash = r.text_hash
       and ((u.embedding is not null and u.embedding_model is not distinct from r.embedding_model)
            or (u.embedding is null and (coalesce(r.embedding_failed, false) or r.embedding is null)));
    if v_same = v_incoming then
      -- A repeated failure refreshes the failure marker instead of rewriting the rows: the marker is the backoff
      -- clock raw_units_retry_due reads, so a session whose embedder is down is retried once per window.
      update public.session_raw_units set embedding_failed_at = now()
       where code_session_id = p_code_session_id and embedding is null;
      return -1;
    end if;
  end if;

  delete from public.session_raw_unit_stage where code_session_id = p_code_session_id; -- orphans of an interrupted chunked write
  delete from public.session_raw_units where code_session_id = p_code_session_id;

  insert into public.session_raw_units
    (user_id, code_session_id, code_project_id, unit, ord, turn_idx, turn_from, turn_to, parts, win, text, full_text,
     turn_text, embedding, embedding_model, embedding_failed_at, text_hash, units_version, source_hash)
  select p_user_id, p_code_session_id, v_project, r.unit, r.ord, r.turn_idx, r.turn_from, r.turn_to, r.parts,
         r.win::int4range, r.text, r.full_text, r.turn_text,
         case when coalesce(r.embedding_failed, false) then null else r.embedding::vector(1536) end,
         case when coalesce(r.embedding_failed, false) then null else r.embedding_model end,
         case when coalesce(r.embedding_failed, false) or r.embedding is null then now() end,
         r.text_hash, p_units_version, p_source_hash
    from jsonb_to_recordset(p_rows) as r(
      unit text, ord int, turn_idx int, turn_from int, turn_to int, parts jsonb, win text, text text,
      full_text text, turn_text text, embedding text, embedding_model text, embedding_failed boolean, text_hash text
    );

  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.replace_session_raw_units(uuid, uuid, jsonb, text, integer, text) from public;
revoke all on function public.replace_session_raw_units(uuid, uuid, jsonb, text, integer, text) from anon;
revoke all on function public.replace_session_raw_units(uuid, uuid, jsonb, text, integer, text) from authenticated;
grant execute on function public.replace_session_raw_units(uuid, uuid, jsonb, text, integer, text) to service_role;

-- True when the session has a unit without a vector whose failure marker is older than p_retry_seconds. The comparison
-- runs on the database clock (the marker is written with now()), never against the application's clock.
create or replace function public.raw_units_retry_due(p_user_id uuid, p_code_session_id uuid, p_retry_seconds integer)
returns boolean
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  select exists (
    select 1 from public.session_raw_units u
     where u.user_id = p_user_id
       and u.code_session_id = p_code_session_id
       and u.embedding is null
       and u.embedding_failed_at <= now() - make_interval(secs => p_retry_seconds)
  )
$$;

revoke all on function public.raw_units_retry_due(uuid, uuid, integer) from public;
revoke all on function public.raw_units_retry_due(uuid, uuid, integer) from anon;
revoke all on function public.raw_units_retry_due(uuid, uuid, integer) from authenticated;
grant execute on function public.raw_units_retry_due(uuid, uuid, integer) to service_role;


-- Stages one chunk of rows (same row shape as replace_session_raw_units) under p_run_id. Returns the rows staged.
-- Also the GC: this session's staged rows of OTHER runs older than p_stale_seconds, and up to 1000 staged rows of any
-- session older than one day, are deleted.
drop function if exists public.stage_session_raw_units(uuid, uuid, uuid, jsonb, integer);
create or replace function public.stage_session_raw_units(
  p_user_id uuid,
  p_code_session_id uuid,
  p_run_id uuid,
  p_rows jsonb,
  p_stale_seconds integer default 3600
)
returns integer
language plpgsql
volatile
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  v_project uuid;
  n integer;
begin
  select cs.code_project_id into v_project
    from public.code_sessions cs
   where cs.id = p_code_session_id and cs.user_id = p_user_id;
  if not found then
    raise exception 'stage_session_raw_units: session % not found for user %', p_code_session_id, p_user_id;
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or p_run_id is null then
    raise exception 'stage_session_raw_units: p_rows must be a jsonb array and p_run_id is required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('session_raw_units:' || p_code_session_id::text, 0));

  delete from public.session_raw_unit_stage
   where code_session_id = p_code_session_id and run_id <> p_run_id
     and created_at < now() - make_interval(secs => greatest(0, p_stale_seconds));
  delete from public.session_raw_unit_stage
   where id in (select s.id from public.session_raw_unit_stage s where s.created_at < now() - interval '1 day' limit 1000);

  insert into public.session_raw_unit_stage
    (user_id, code_session_id, code_project_id, run_id, unit, ord, turn_idx, turn_from, turn_to, parts, win, text,
     full_text, turn_text, embedding, embedding_model, embedding_failed_at, text_hash)
  select p_user_id, p_code_session_id, v_project, p_run_id, r.unit, r.ord, r.turn_idx, r.turn_from, r.turn_to, r.parts,
         r.win::int4range, r.text, r.full_text, r.turn_text,
         case when coalesce(r.embedding_failed, false) then null else r.embedding::vector(1536) end,
         r.embedding_model, -- the INTENDED model, kept even on a failed embed so commit compares like replace does
         case when coalesce(r.embedding_failed, false) or r.embedding is null then now() end,
         r.text_hash
    from jsonb_to_recordset(p_rows) as r(
      unit text, ord int, turn_idx int, turn_from int, turn_to int, parts jsonb, win text, text text,
      full_text text, turn_text text, embedding text, embedding_model text, embedding_failed boolean, text_hash text
    );
  get diagnostics n = row_count;
  return n;
end;
$$;

-- Commits a staged run: -2 content changed (the run's staged rows are dropped), -3 the staged count is not
-- p_expected_count (incomplete or damaged: nothing changed; the rows stay as orphans until the next write of the session collects them), -1 already current (staged rows dropped),
-- else the number of units promoted. Old rows are deleted and the staged rows promoted in this one transaction.
drop function if exists public.commit_session_raw_units(uuid, uuid, uuid, integer, text, integer, text);
create or replace function public.commit_session_raw_units(
  p_user_id uuid,
  p_code_session_id uuid,
  p_run_id uuid,
  p_expected_count integer,
  p_source_hash text,
  p_units_version integer,
  p_content_hash text default null
)
returns integer
language plpgsql
volatile
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  v_project uuid;
  v_content_hash text;
  v_staged integer;
  v_existing integer;
  v_same integer;
  n integer;
begin
  select cs.code_project_id into v_project
    from public.code_sessions cs
   where cs.id = p_code_session_id and cs.user_id = p_user_id;
  if not found then
    raise exception 'commit_session_raw_units: session % not found for user %', p_code_session_id, p_user_id;
  end if;
  if p_source_hash is null or p_source_hash = '' or p_units_version is null or p_expected_count is null or p_run_id is null then
    raise exception 'commit_session_raw_units: run, count, source hash and version are required';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('session_raw_units:' || p_code_session_id::text, 0));

  if p_content_hash is not null then
    select cs.content_hash into v_content_hash from public.code_sessions cs where cs.id = p_code_session_id;
    if v_content_hash is distinct from p_content_hash then
      delete from public.session_raw_unit_stage where code_session_id = p_code_session_id and run_id = p_run_id;
      return -2;
    end if;
  end if;

  select count(*) into v_staged from public.session_raw_unit_stage
   where code_session_id = p_code_session_id and run_id = p_run_id;
  if v_staged <> p_expected_count then
    return -3;
  end if;

  select count(*) into v_existing from public.session_raw_units u where u.code_session_id = p_code_session_id;
  if v_existing = v_staged and v_staged > 0 then
    select count(*) into v_same
      from public.session_raw_units u
      join public.session_raw_unit_stage s
        on s.code_session_id = u.code_session_id and s.run_id = p_run_id and s.unit = u.unit and s.ord = u.ord
     where u.code_session_id = p_code_session_id
       and u.source_hash = p_source_hash
       and u.units_version = p_units_version
       and u.text_hash = s.text_hash
       and ((u.embedding is not null and u.embedding_model is not distinct from s.embedding_model)
            or (u.embedding is null and s.embedding is null));
    if v_same = v_staged then
      update public.session_raw_units set embedding_failed_at = now()
       where code_session_id = p_code_session_id and embedding is null;
      delete from public.session_raw_unit_stage where code_session_id = p_code_session_id;
      return -1;
    end if;
  end if;

  delete from public.session_raw_units where code_session_id = p_code_session_id;
  insert into public.session_raw_units
    (user_id, code_session_id, code_project_id, unit, ord, turn_idx, turn_from, turn_to, parts, win, text, full_text,
     turn_text, embedding, embedding_model, embedding_failed_at, text_hash, units_version, source_hash)
  select p_user_id, p_code_session_id, v_project, s.unit, s.ord, s.turn_idx, s.turn_from, s.turn_to, s.parts, s.win,
         s.text, s.full_text, s.turn_text, s.embedding, case when s.embedding is null then null else s.embedding_model end,
         s.embedding_failed_at, s.text_hash,
         p_units_version, p_source_hash
    from public.session_raw_unit_stage s
   where s.code_session_id = p_code_session_id and s.run_id = p_run_id;
  get diagnostics n = row_count;
  delete from public.session_raw_unit_stage where code_session_id = p_code_session_id; -- this run and any orphans
  return n;
end;
$$;

revoke all on function public.stage_session_raw_units(uuid, uuid, uuid, jsonb, integer) from public;
revoke all on function public.stage_session_raw_units(uuid, uuid, uuid, jsonb, integer) from anon;
revoke all on function public.stage_session_raw_units(uuid, uuid, uuid, jsonb, integer) from authenticated;
grant execute on function public.stage_session_raw_units(uuid, uuid, uuid, jsonb, integer) to service_role;
revoke all on function public.commit_session_raw_units(uuid, uuid, uuid, integer, text, integer, text) from public;
revoke all on function public.commit_session_raw_units(uuid, uuid, uuid, integer, text, integer, text) from anon;
revoke all on function public.commit_session_raw_units(uuid, uuid, uuid, integer, text, integer, text) from authenticated;
grant execute on function public.commit_session_raw_units(uuid, uuid, uuid, integer, text, integer, text) to service_role;
