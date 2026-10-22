-- ============================================================
-- 085_memory_search_rpc.sql
-- Memory v1 (docs/design/memory-v1.md §4), goal 2026-09-13, step 3 (#152).
-- Depends on: 084 (session_memories, memory_branch_state).
--
-- WHY THIS MIGRATION EXISTS (the goal-file/BRIEF instruction this satisfies):
-- §8.3's brief says "prefer two queries fused in TS to avoid a migration;
-- if you must add SQL, it is migration 085 and you must say so." Two legs
-- of `memory_search` are unavoidably SQL-only: pgvector's `<=>` cosine
-- distance operator has no supabase-js query-builder equivalent (no
-- `.order("embedding <=> $1")` exists on the JS client — every other cosine
-- read in this codebase, e.g. migration 044's mcp_search_unified, goes
-- through an RPC for exactly this reason), so ranking `session_memories` by
-- semantic similarity to a query embedding REQUIRES a Postgres function
-- regardless of the "prefer TS" default. Given a migration is unavoidable
-- for that leg, this RPC fuses BOTH legs (FTS + cosine) inside the same SQL
-- function using the same RANK-THEN-FUSE reciprocal-rank-fusion (RRF)
-- pattern migration 044 already established for
-- `mcp_search_unified` — one query, one round trip, one scoring convention
-- to maintain — rather than running the FTS leg as a second TS-side
-- supabase-js query that duplicates this same WHERE-clause filtering logic
-- a second time for no operational benefit. This is a DEVIATION from "two
-- queries fused in TS": documented here, and again in the read-tools' own
-- header comments (lib/memory/search.ts).
--
-- This RPC returns the RETRIEVAL candidate set only (relevance-ranked, capped
-- generously above the caller's requested limit) — it does NOT decide final
-- serving order. §4's eight ranking rules (repo match is a parameter here,
-- but durable/verified/live/voice/branch/recency/paths/source) are applied
-- AFTER this call by the pure `lib/memory/rank.ts`, on the server, once per
-- read tool. This function's only job is "which records are relevant to this
-- query text/embedding at all."
--
-- SECURITY: mirrors every other MCP-backing RPC (016, 030, 044): SECURITY
-- INVOKER + an explicit p_user_id parameter (never auth.uid() — /api/mcp
-- calls run under the service_role key, which has no Supabase session/JWT
-- to read auth.uid() from) + EXECUTE granted to service_role only.
-- ============================================================

-- pgvector lives in `extensions` on hosted Supabase; the CLI login role does not
-- have it on its search_path, so resolve `vector` for this file explicitly.
set search_path = public, extensions;

create or replace function public.memory_search_records(
  p_user_id uuid,
  p_query text,
  p_query_embedding vector(1536) default null,
  p_code_project_id uuid default null,
  p_kinds text[] default null,
  p_scope text default null,
  p_path text default null,
  p_include_retired boolean default false,
  p_limit int default 20
)
returns table (
  id uuid, code_session_id uuid, code_project_id uuid, agent_id text, source text, kind text,
  text text, quote text, turn_idx int, turn_role text, ref text, ref_kind text,
  branch text, head_sha text, thread text, paths text[], verified boolean, durable boolean,
  observed_durable boolean, recurs_of uuid, recurrence_count int, scope text, confidence real,
  supersedes uuid, retired_at timestamptz, chat_conversation_id uuid, created_at timestamptz,
  leg_score float8
)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  with q as (
    select plainto_tsquery('english', p_query) as tsq
  ),
  candidates as (
    select
      m.*,
      case when q.tsq is not null and q.tsq::text <> ''
        then ts_rank(to_tsvector('english', coalesce(m.text, '')), q.tsq, 32)::float8
        else 0
      end as fts_rank,
      case when p_query_embedding is not null
        then 1 - (m.embedding <=> p_query_embedding)
        else null
      end as similarity
    from public.session_memories m
    cross join q
    where m.user_id = p_user_id
      and (p_code_project_id is null or m.code_project_id = p_code_project_id)
      and (p_kinds is null or m.kind = any(p_kinds))
      and (p_scope is null or m.scope = p_scope)
      and (p_path is null or m.paths @> array[p_path])
      and (p_include_retired or m.retired_at is null)
      and (
        p_include_retired
        or not exists (
          select 1 from public.session_memories s2
          where s2.supersedes = m.id and s2.retired_at is null
        )
      )
      and (
        (q.tsq is not null and q.tsq::text <> '' and to_tsvector('english', coalesce(m.text, '')) @@ q.tsq)
        or (p_query_embedding is not null and 1 - (m.embedding <=> p_query_embedding) > 0.3)
      )
  ),
  ranked as (
    select
      c.*,
      greatest(coalesce(c.fts_rank, 0), coalesce(c.similarity, 0)) as leg_score,
      row_number() over (
        order by greatest(coalesce(c.fts_rank, 0), coalesce(c.similarity, 0)) desc,
          c.created_at desc,
          c.id
      ) as leg_rank
    from candidates c
  )
  select
    r.id, r.code_session_id, r.code_project_id, r.agent_id, r.source, r.kind,
    r.text, r.quote, r.turn_idx, r.turn_role, r.ref, r.ref_kind,
    r.branch, r.head_sha, r.thread, r.paths, r.verified, r.durable,
    r.observed_durable, r.recurs_of, r.recurrence_count, r.scope, r.confidence,
    r.supersedes, r.retired_at, r.chat_conversation_id, r.created_at,
    r.leg_score
  from ranked r
  order by r.leg_rank
  limit greatest(p_limit, 1);
$$;

revoke all on function public.memory_search_records(
  uuid, text, vector, uuid, text[], text, text, boolean, int
) from public;
revoke all on function public.memory_search_records(
  uuid, text, vector, uuid, text[], text, text, boolean, int
) from anon;
grant execute on function public.memory_search_records(
  uuid, text, vector, uuid, text[], text, text, boolean, int
) to service_role;
