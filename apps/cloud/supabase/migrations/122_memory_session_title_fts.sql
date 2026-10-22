-- ============================================================
-- 122_memory_session_title_fts.sql
-- `session_memories.session_title` (the session's `code_sessions.short_title`) joins
-- `thread` and `text` in the lexical index, and `memory_anchor_records` finds records
-- that name a file path from the query.
--
-- WHY (session title): a record such as "the goal is paused until the release ships"
-- never names the programme it belongs to; its session's short title does. Search read
-- neither, so a query naming the programme missed every record of that session on the
-- lexical arm (eval loop 2, 2026-10-09: fused ranks 78 and 132 against a pool of 30).
-- Lexical arm only, as 120: embeddings stay text-only.
--
-- WHY (anchor records): Postgres keeps a path as one lexeme, so `lib/kg/queue.ts` in a
-- query never matches `apps/cloud/src/lib/kg/queue.ts` in a record; a record naming the
-- query's file could rank 79th of 736 and never reach the candidate pool. Prompt recall
-- (prompt-recall.ts) calls this function with the prompt's path and file tokens and
-- merges what it returns ahead of the search results.
--
-- WHAT:
--   1. drop `text_fts` (its GIN index goes with it), add `session_title text`, fill it
--      from `code_sessions.short_title` (same user only), re-add `text_fts` as
--      thread || session_title || text. `quote_fts` is unchanged.
--      `memory_search_records` (114) and `memory_search_scored` (121) read the column
--      `m.text_fts`, not its expression, so neither function changes.
--   2. `memory_anchor_records(p_user_id, p_code_project_id, p_tokens, p_kinds, p_limit)`:
--      live, verified, non-superseded records of one user's project where an element of
--      `paths` equals a token or ends with `/` + token, or `text` carries the token on a
--      path boundary (not after a letter, digit, `_`, `.` or `-`; not before a letter,
--      digit, `_`, `-` or `.x`): `queue.ts` matches `lib/kg/queue.ts`, never
--      `extraction-queue.ts`. Tokens are lowercased by the caller. Newest first, at most
--      20. service_role only, like 121.
--
-- WRITE PATH: new rows get `session_title` at insert (write/io.ts, from tail-capture's
-- session row). A title written after a record exists is not copied back.
--
-- LOCKS: the column drop/add, the backfill UPDATE, the table rewrite and the HNSW and GIN
-- rebuilds run under an ACCESS EXCLUSIVE lock on session_memories for their whole
-- duration: preamble, prompt recall and memory_search reads block until it commits. Expect
-- tens of seconds at ~10k rows; time it on a restored prod copy first, and run it off-peak
-- on hosted. `set local` below only applies when the file runs inside a transaction: the
-- local stack's runner wraps it, bare `psql -f` does not (wrap it with `-1` or begin/commit).
-- DEPLOY ORDER: apply before the app that writes `session_title` (the insert names the
-- column whenever the session has a title).
--
-- Idempotent: the rebuild runs only when `text_fts` does not already mention
-- `session_title`; `add column if not exists`; `create or replace`; index `if not exists`.
-- Rollback: 120's block (expression thread || text), then `alter table ... drop column
-- session_title` and `drop function public.memory_anchor_records(uuid, uuid, text[], text[], int)`.
-- ============================================================

set search_path = public, extensions;
set local lock_timeout = '5s';
-- Serial index builds: local Docker's /dev/shm is 64 MB (SQLSTATE 53100 on parallel builds).
set local max_parallel_maintenance_workers = 0;

do $$
declare
  v_expr text;
begin
  select pg_get_expr(d.adbin, d.adrelid)
    into v_expr
    from pg_attribute a
    join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attrelid = 'public.session_memories'::regclass
     and a.attname = 'text_fts'
     and not a.attisdropped;

  if v_expr is null or v_expr not like '%session_title%' then
    alter table public.session_memories drop column if exists text_fts;
    alter table public.session_memories add column if not exists session_title text;

    update public.session_memories m
       set session_title = cs.short_title
      from public.code_sessions cs
     where cs.id = m.code_session_id
       and cs.user_id = m.user_id
       and cs.short_title is not null
       and m.session_title is distinct from cs.short_title;

    alter table public.session_memories
      add column text_fts tsvector
        generated always as (
          to_tsvector(
            'english',
            coalesce(thread, '') || ' ' || coalesce(session_title, '') || ' ' || coalesce(text, '')
          )
        ) stored;
  end if;
end
$$;

create index if not exists session_memories_text_fts_idx
  on public.session_memories using gin (text_fts);

create or replace function public.memory_anchor_records(
  p_user_id uuid,
  p_code_project_id uuid,
  p_tokens text[],
  p_kinds text[] default null,
  p_limit int default 5
)
returns table (
  id uuid, code_session_id uuid, code_project_id uuid, agent_id text, source text, kind text,
  text text, quote text, turn_idx int, turn_role text, ref text, ref_kind text,
  branch text, head_sha text, thread text, paths text[], verified boolean, durable boolean,
  observed_durable boolean, recurrence_count int, scope text, confidence real,
  supersedes uuid, retired_at timestamptz, chat_conversation_id uuid, created_at timestamptz
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  with toks as (
    select distinct t.tok,
           regexp_replace(t.tok, '([.*+?^${}()|\[\]\\])', '\\\1', 'g') as re
      from unnest(coalesce(p_tokens, '{}'::text[])) as t(tok)
     where length(t.tok) >= 2
  )
  select m.id, m.code_session_id, m.code_project_id, m.agent_id, m.source, m.kind,
         m.text, m.quote, m.turn_idx, m.turn_role, m.ref, m.ref_kind,
         m.branch, m.head_sha, m.thread, m.paths, m.verified, m.durable,
         m.observed_durable, m.recurrence_count, m.scope, m.confidence,
         m.supersedes, m.retired_at, m.chat_conversation_id, m.created_at
    from public.session_memories m
    left join public.code_sessions cs
      on cs.id = m.code_session_id and cs.user_id = p_user_id
   where m.user_id = p_user_id
     and m.code_project_id = p_code_project_id
     and m.retired_at is null
     and m.verified
     and (p_kinds is null or m.kind = any(p_kinds))
     and not exists (
       select 1 from public.session_memories s2
        where s2.supersedes = m.id and s2.user_id = p_user_id and s2.retired_at is null
     )
     and exists (
       select 1 from toks
        where exists (
                select 1 from unnest(m.paths) as p(path)
                 where lower(p.path) = toks.tok
                    or right(lower(p.path), length(toks.tok) + 1) = '/' || toks.tok
              )
           or lower(m.text) ~ ('(^|[^a-z0-9_.-])' || toks.re || '(?![a-z0-9_-]|\.[a-z0-9])')
     )
   order by coalesce(cs.started_at, m.created_at) desc, m.id
   limit least(greatest(coalesce(p_limit, 5), 1), 20);
$$;

revoke all on function public.memory_anchor_records(uuid, uuid, text[], text[], int) from public;
revoke all on function public.memory_anchor_records(uuid, uuid, text[], text[], int) from anon;
revoke execute on function public.memory_anchor_records(uuid, uuid, text[], text[], int) from authenticated;
grant execute on function public.memory_anchor_records(uuid, uuid, text[], text[], int) to service_role;
