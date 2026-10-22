-- ============================================================
-- 115_code_session_forge_refs.sql
-- W3 D9 (design: docs/design/observed-forge-refs.md §1, §5).
-- One row per (turn, action, item) a coding session observed through a
-- structured forge action: issues, merge requests, commits, branches and
-- comments. A log of what the session saw: no role, no cost share. Coexists
-- with code_session_issues (per-session attribution); D5 reads only this one.
--
-- WHO WRITES: apps/cloud/src/lib/code-sessions/import.ts (via
-- lib/code-sessions/forge-refs.ts) through the 5-argument
-- import_code_session_turns overload,
-- in the same transaction as the session's turns; and
-- apps/cloud/scripts/backfill-forge-refs.ts through
-- replace_code_session_forge_refs. Service role only, no LLM.
-- WHO READS: the owner (select policy below); service-role readers always
-- filter on user_id explicitly.
--
-- item_key is the write-time key from lib/domain/ref-identity.ts
-- (itemKeyResolver): a cache for indexing, re-resolved on read.
--
-- The 3-argument import_code_session_turns (112) is left as it is: callers
-- that pass no refs keep 112's behaviour exactly. The 5-argument overload
-- below (p_forge_refs, p_forge_refs_version) calls it, then writes the refs.
-- PostgREST picks the overload by the argument names sent.
--
-- Depends on: 029 (code_sessions), 112.
-- Idempotent (if not exists / create or replace). No data changes.
--
-- REVERTING:
--   drop function public.replace_code_session_forge_refs(uuid, uuid, jsonb, integer, text, text);
--   drop function public.import_code_session_turns(uuid, uuid, jsonb, jsonb, integer);
--   drop function public.write_code_session_forge_refs(uuid, uuid, jsonb, integer);
--   drop table public.code_session_forge_refs;
--   alter table public.code_sessions drop constraint code_sessions_id_user_id_key;
-- ============================================================

-- The composite FK target. id is already the primary key, so this adds no
-- new uniqueness, only a referencable (id, user_id) pair.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.code_sessions'::regclass
       and conname = 'code_sessions_id_user_id_key'
  ) then
    alter table public.code_sessions add constraint code_sessions_id_user_id_key unique (id, user_id);
  end if;
end;
$$;

create table if not exists public.code_session_forge_refs (
  id bigint generated always as identity primary key,
  user_id uuid not null,
  session_id uuid not null,
  turn_idx int not null,
  action_ix smallint not null check (action_ix >= 0),
  kind text not null check (kind in ('issue', 'merge_request', 'commit', 'branch', 'comment')),
  target_kind text check (target_kind in ('issue', 'merge_request')),
  verb text not null check (char_length(verb) between 1 and 40),
  source text not null check (source in ('cli', 'mcp', 'command', 'paste')),
  prose_ref boolean not null default false,
  host text check (char_length(host) <= 200),
  project text check (char_length(project) <= 300),
  number int check (number > 0),
  sha text check (sha ~ '^[0-9a-f]{7,40}$'),
  branch text check (char_length(branch) <= 200),
  observed_state text check (char_length(observed_state) <= 20),
  title text check (char_length(title) <= 200),
  url text check (char_length(url) <= 500),
  observed_at timestamptz not null,
  item_key text not null check (char_length(item_key) between 1 and 600),
  constraint code_session_forge_refs_comment_target check ((kind = 'comment') = (target_kind is not null)),
  constraint code_session_forge_refs_session_fk foreign key (session_id, user_id)
    references public.code_sessions (id, user_id) on delete cascade,
  constraint code_session_forge_refs_one_row unique (session_id, turn_idx, action_ix, kind, item_key)
);

create index if not exists code_session_forge_refs_user_observed_idx
  on public.code_session_forge_refs (user_id, observed_at desc);
create index if not exists code_session_forge_refs_user_item_idx
  on public.code_session_forge_refs (user_id, project, kind, number);
create index if not exists code_session_forge_refs_user_branch_idx
  on public.code_session_forge_refs (user_id, project, branch) where branch is not null;
create index if not exists code_session_forge_refs_session_idx
  on public.code_session_forge_refs (session_id);

alter table public.code_session_forge_refs enable row level security;

drop policy if exists "code_session_forge_refs_select_own" on public.code_session_forge_refs;
create policy "code_session_forge_refs_select_own"
  on public.code_session_forge_refs for select
  to authenticated
  using (user_id = auth.uid());

revoke all on public.code_session_forge_refs from anon;
revoke insert, update, delete on public.code_session_forge_refs from authenticated;
revoke truncate, references, trigger on public.code_session_forge_refs from authenticated;
revoke truncate, references, trigger on public.code_session_forge_refs from anon;

-- Replace one session's ref rows. Shared body of the two functions below;
-- the caller holds the session-row lock. p_forge_refs null: remove the rows
-- and clear props.forge_refs_version (the backfill then sees the gap).
create or replace function public.write_code_session_forge_refs(
  p_user_id uuid,
  p_session_id uuid,
  p_forge_refs jsonb,
  p_version integer
)
returns integer
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  n integer := 0;
begin
  if p_forge_refs is not null and jsonb_typeof(p_forge_refs) <> 'array' then
    raise exception 'write_code_session_forge_refs: p_forge_refs must be a jsonb array or null';
  end if;

  delete from public.code_session_forge_refs
   where session_id = p_session_id
     and user_id = p_user_id;

  if p_forge_refs is null then
    update public.code_sessions
       set props = coalesce(props, '{}'::jsonb) - 'forge_refs_version'
     where id = p_session_id
       and user_id = p_user_id;
    return 0;
  end if;

  insert into public.code_session_forge_refs (
    user_id, session_id, turn_idx, action_ix, kind, target_kind, verb, source, prose_ref,
    host, project, number, sha, branch, observed_state, title, url, observed_at, item_key
  )
  select p_user_id, p_session_id, r.turn_idx, r.action_ix, r.kind, r.target_kind, r.verb, r.source,
         coalesce(r.prose_ref, false), r.host, r.project, r.number, r.sha, r.branch, r.observed_state,
         r.title, r.url, r.observed_at, r.item_key
    from jsonb_to_recordset(p_forge_refs) as r(
      turn_idx int, action_ix smallint, kind text, target_kind text, verb text, source text,
      prose_ref boolean, host text, project text, number int, sha text, branch text,
      observed_state text, title text, url text, observed_at timestamptz, item_key text
    );
  get diagnostics n = row_count;

  update public.code_sessions
     set props = coalesce(props, '{}'::jsonb) || jsonb_build_object('forge_refs_version', p_version)
   where id = p_session_id
     and user_id = p_user_id;
  return n;
end;
$$;

revoke all on function public.write_code_session_forge_refs(uuid, uuid, jsonb, integer) from public;
revoke all on function public.write_code_session_forge_refs(uuid, uuid, jsonb, integer) from anon;
revoke all on function public.write_code_session_forge_refs(uuid, uuid, jsonb, integer) from authenticated;
grant execute on function public.write_code_session_forge_refs(uuid, uuid, jsonb, integer) to service_role;

-- 112's turn replacement plus this session's ref rows, in one transaction
-- under the same session-row lock. Returns the number of turns inserted, as
-- 112 does.
create or replace function public.import_code_session_turns(
  p_user_id uuid,
  p_session_id uuid,
  p_turns jsonb,
  p_forge_refs jsonb,
  p_forge_refs_version integer
)
returns integer
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  n integer;
begin
  -- 112: locks the session row (ownership check), replaces the turns.
  n := public.import_code_session_turns(p_user_id, p_session_id, p_turns);
  perform public.write_code_session_forge_refs(p_user_id, p_session_id, p_forge_refs, p_forge_refs_version);
  return n;
end;
$$;

revoke all on function public.import_code_session_turns(uuid, uuid, jsonb, jsonb, integer) from public;
revoke all on function public.import_code_session_turns(uuid, uuid, jsonb, jsonb, integer) from anon;
revoke all on function public.import_code_session_turns(uuid, uuid, jsonb, jsonb, integer) from authenticated;
grant execute on function public.import_code_session_turns(uuid, uuid, jsonb, jsonb, integer) to service_role;

-- The backfill's refs-only write: same session-row lock, turns untouched.
-- The backfill computed p_forge_refs from turns it read WITHOUT the lock, so
-- it passes what it read: the session's content_hash and an md5 of its turn
-- ids in idx order (every turns replacement mints new ids, a forced
-- re-import included). If either changed under the lock, or an import is in
-- flight (content_hash '' = PENDING_CONTENT_HASH, lib/code-sessions/import.ts),
-- nothing is written and -1 (skipped) is returned. Otherwise: rows written.
create or replace function public.replace_code_session_forge_refs(
  p_user_id uuid,
  p_session_id uuid,
  p_forge_refs jsonb,
  p_forge_refs_version integer,
  p_expected_content_hash text,
  p_expected_turn_ids_md5 text
)
returns integer
language plpgsql
volatile
security invoker
set search_path = public, pg_temp
as $$
declare
  current_hash text;
  current_turns text;
begin
  select content_hash into current_hash
    from public.code_sessions
   where id = p_session_id
     and user_id = p_user_id
     for update;
  if not found then
    raise exception 'replace_code_session_forge_refs: session % not found for user %', p_session_id, p_user_id;
  end if;

  select md5(coalesce(string_agg(t.id::text, ',' order by t.idx), ''))
    into current_turns
    from public.code_session_turns t
   where t.session_id = p_session_id
     and t.user_id = p_user_id;

  if current_hash = '' or current_hash is distinct from p_expected_content_hash
     or current_turns is distinct from p_expected_turn_ids_md5 then
    return -1;
  end if;
  return public.write_code_session_forge_refs(p_user_id, p_session_id, p_forge_refs, p_forge_refs_version);
end;
$$;

revoke all on function public.replace_code_session_forge_refs(uuid, uuid, jsonb, integer, text, text) from public;
revoke all on function public.replace_code_session_forge_refs(uuid, uuid, jsonb, integer, text, text) from anon;
revoke all on function public.replace_code_session_forge_refs(uuid, uuid, jsonb, integer, text, text) from authenticated;
grant execute on function public.replace_code_session_forge_refs(uuid, uuid, jsonb, integer, text, text) to service_role;
