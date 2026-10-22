-- ============================================================
-- 101_memory_semantic_duplicates.sql
-- Semantic dedup of session memories (write time + one-off cleanup), and a
-- merge log so every merge is visible and reversible. The comparison runs
-- inside Postgres (pgvector `<=>`), so no embedding ever travels to the app.
-- Depends on: 084 (session_memories + embedding), 086 (retire_reason)
-- ============================================================
--
-- memory_semantic_duplicates(p_user, p_record_ids, p_min_sim, p_kinds)
-- returns every pair (new_id, existing_id, sim, kind, new_created_at,
-- existing_created_at) where
--   - both rows are the user's, LIVE (retired_at is null), embedded;
--   - kind is in p_kinds (the app never passes 'outcome': an outcome is a
--     delivery receipt, two similar ones are two deliveries);
--   - existing is OLDER than new ((created_at, id) order), so the caller
--     retires `existing_id` and the newest row of a cluster survives;
--   - at least one side is in p_record_ids (null = every live row of the
--     user: the cleanup, scripts/memory/dedup-semantic.ts). Pairs INSIDE one
--     write batch are included: one session extracted in several windows
--     restates its own facts;
--   - same kind, same scope; a 'project' pair also shares code_project_id,
--     a 'global' pair may span projects (global memories are user-wide);
--   - cosine similarity = 1 - (a <=> b) >= p_min_sim.
-- The app groups pairs into clusters (connected components) and keeps only
-- the newest row of each cluster (write.ts planSemanticMerges).
--
-- memory_merges: one row per retired duplicate — kept_id (the survivor),
-- retired_id, sim, kind, source ('write' | 'cleanup'). Owners can read their
-- rows; only the service role writes.
--
-- SECURITY INVOKER; service_role only (called by the extraction worker and
-- the cleanup script, both with the service key).
-- ============================================================

-- pgvector lives in `extensions` on hosted Supabase; the CLI login role does not
-- have it on its search_path, so resolve `vector` for this file explicitly.
set search_path = public, extensions;

create or replace function public.memory_semantic_duplicates(
  p_user uuid,
  p_record_ids uuid[] default null,
  p_min_sim float8 default 0.80,
  p_kinds text[] default array['learning', 'blocker', 'decision', 'preference']
)
returns table (
  new_id uuid,
  existing_id uuid,
  sim float8,
  kind text,
  new_created_at timestamptz,
  existing_created_at timestamptz
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  select n.id as new_id,
         e.id as existing_id,
         (1 - (n.embedding <=> e.embedding))::float8 as sim,
         n.kind,
         n.created_at as new_created_at,
         e.created_at as existing_created_at
  from public.session_memories n
  join public.session_memories e
    on e.user_id = n.user_id
   and e.kind = n.kind
   and e.scope = n.scope
   and (n.scope = 'global' or e.code_project_id = n.code_project_id)
   and (e.created_at, e.id) < (n.created_at, n.id)
   and e.retired_at is null
   and e.embedding is not null
  where n.user_id = p_user
    and n.retired_at is null
    and n.embedding is not null
    and n.kind <> 'outcome'
    and n.kind = any (p_kinds)
    and (p_record_ids is null or n.id = any (p_record_ids) or e.id = any (p_record_ids))
    and 1 - (n.embedding <=> e.embedding) >= p_min_sim
  order by n.id, sim desc, e.id;
$$;

revoke all on function public.memory_semantic_duplicates(uuid, uuid[], float8, text[]) from public;
revoke all on function public.memory_semantic_duplicates(uuid, uuid[], float8, text[]) from anon;
revoke all on function public.memory_semantic_duplicates(uuid, uuid[], float8, text[]) from authenticated;
grant execute on function public.memory_semantic_duplicates(uuid, uuid[], float8, text[]) to service_role;

create table if not exists public.memory_merges (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kept_id uuid not null references public.session_memories (id) on delete cascade,
  retired_id uuid not null references public.session_memories (id) on delete cascade,
  sim float8 not null,
  kind text not null,
  merged_at timestamptz not null default now(),
  source text not null check (source in ('write', 'cleanup'))
);

create index if not exists memory_merges_user_merged_at_idx
  on public.memory_merges (user_id, merged_at desc);
create index if not exists memory_merges_retired_idx
  on public.memory_merges (retired_id);

alter table public.memory_merges enable row level security;

-- Owners read their own merges; no insert/update/delete policy, so only the
-- service role (which bypasses RLS) writes.
create policy own_rows_select on public.memory_merges
  for select using (user_id = auth.uid());
