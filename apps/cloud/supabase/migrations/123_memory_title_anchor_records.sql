-- ============================================================
-- 123_memory_title_anchor_records.sql
-- `memory_title_anchor_records` finds the newest outcomes and decisions of sessions whose
-- short title names the prompt's programme.
--
-- WHY: a prompt that resumes a programme of work names the programme, and the
-- records that answer it (a `held` decision, a "Deployed main ... to prod" outcome) rarely
-- repeat that name; their session's short title does. The search ranks those records below
-- older rewordings of one merge (eval loop 2, 2026-10-09: the session titled after the
-- programme served nothing in five slots). Prompt recall (prompt-recall.ts) calls this
-- beside hop 1, on the extended path only, and places what it returns after the path
-- anchors and before the search results.
--
-- WHAT: `memory_title_anchor_records(p_user_id, p_project_id, p_tokens, p_limit)`:
--   sessions of one user's project whose `code_sessions.short_title` carries at least TWO
--   distinct tokens on word boundaries (case-insensitive; tokens are lowercased letter runs
--   of length >= 4, sent by the caller); of each, the newest live, verified, non-superseded
--   records of kind outcome or decision, at most 2 per session; sessions ordered by the number of
--   distinct matched tokens (most first), then newest started_at; at most p_limit (clamped to 1..20) in all. Same columns as `memory_anchor_records` (122).
--   security invoker, service_role only, like 121 and 122.
--
-- Idempotent: `create or replace`. Rollback:
--   drop function public.memory_title_anchor_records(uuid, uuid, text[], int)
-- ============================================================

set search_path = public, extensions;

create or replace function public.memory_title_anchor_records(
  p_user_id uuid,
  p_project_id uuid,
  p_tokens text[],
  p_limit int default 2
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
    select distinct lower(t.tok) as tok
      from unnest(coalesce(p_tokens, '{}'::text[])) as t(tok)
     where lower(t.tok) ~ '^[[:alpha:]]{4,}$'
  ),
  hit as (
    select cs.id, cs.started_at,
           (select count(*) from toks
             where lower(cs.short_title) ~ ('\m' || toks.tok || '\M')) as matches
      from public.code_sessions cs
     where cs.user_id = p_user_id
       and cs.code_project_id = p_project_id
       and cs.short_title is not null
  ),
  hit2 as (
    select id, started_at, matches from hit where matches >= 2
  ),
  ranked as (
    select m.*, hit2.started_at as session_started_at, hit2.matches as session_matches,
           row_number() over (
             partition by m.code_session_id
             order by m.created_at desc, m.turn_idx desc, m.id
           ) as rn
      from public.session_memories m
      join hit2 on hit2.id = m.code_session_id
     where m.user_id = p_user_id
       and m.code_project_id = p_project_id
       and m.retired_at is null
       and m.verified
       and m.kind in ('outcome', 'decision')
       and not exists (
         select 1 from public.session_memories s2
          where s2.supersedes = m.id and s2.user_id = p_user_id and s2.retired_at is null
       )
  )
  select r.id, r.code_session_id, r.code_project_id, r.agent_id, r.source, r.kind,
         r.text, r.quote, r.turn_idx, r.turn_role, r.ref, r.ref_kind,
         r.branch, r.head_sha, r.thread, r.paths, r.verified, r.durable,
         r.observed_durable, r.recurrence_count, r.scope, r.confidence,
         r.supersedes, r.retired_at, r.chat_conversation_id, r.created_at
    from ranked r
   where r.rn <= 2
   order by r.session_matches desc, coalesce(r.session_started_at, r.created_at) desc, r.code_session_id, r.rn
   limit least(greatest(coalesce(p_limit, 2), 1), 20);
$$;

revoke all on function public.memory_title_anchor_records(uuid, uuid, text[], int) from public;
revoke all on function public.memory_title_anchor_records(uuid, uuid, text[], int) from anon;
revoke execute on function public.memory_title_anchor_records(uuid, uuid, text[], int) from authenticated;
grant execute on function public.memory_title_anchor_records(uuid, uuid, text[], int) to service_role;
