-- ============================================================
-- 075_search_bridge_returns_jsonb.sql
-- Issue #115 extension: three more ACL-denied set-returning functions
-- reachable via PostgREST (POST /rest/v1/rpc/<fn>) under a role that lacks
-- EXECUTE, converted `returns table` / `returns setof` -> `returns jsonb`,
-- same fix migration 074 applied to mcp_claims_browse and migration 070
-- applied to its own memory-grain RPCs (mcp_memories_context,
-- mcp_memories_browse, mcp_memories_identity, kg_memory_keys_for_claims,
-- kg_memories_browse, kg_memory_instances_page, kg_memories_facets). Postgres
-- refuses create-or-replace across a return-type change, so every function
-- below is a drop + create. Query bodies, ORDER BY/LIMIT clamps, and ACLs are
-- otherwise BYTE-IDENTICAL to each function's authoritative definition
-- (verified by grepping every migration for later redefinitions, same method
-- 074 used to confirm 047 was authoritative for mcp_claims_browse).
--
-- SCOPE NOTE — only 3 of the 5 functions this migration was asked to convert
-- are converted here; the other two (kg_memories_for, claims_browse_entity_
-- labels) are NOT touched. See the "DEFERRED" section at the bottom of this
-- file for why: both have SQL-side callers (`select * from public.<fn>(...)`)
-- inside OTHER security-invoker functions that read named table columns, and
-- a return-type change to jsonb would silently break every one of them —
-- this migration does not touch those callers, so converting the two
-- deferred functions here would ship broken SQL, not a behavior-preserving
-- fix.
-- ============================================================

-- ------------------------------------------------------------
-- 1. search_conversations — last defined in 071_search_fts_fix.sql. Single
-- caller in the app: callSearchRpc (apps/cloud/src/lib/search.ts:70), whose
-- `(data || []).map(mapRow)` is unchanged by this migration — PostgREST
-- already serialized a `returns table` result as a JSON array of rows, and
-- supabase-js parses a `returns jsonb` array result the same way.
--
-- The ORDER BY that made 071's FTS-hit group dominant (fts_hit desc,
-- fts_rank desc, similarity desc nulls last, id) moves from the outer SELECT
-- into an `order by` on the jsonb_agg itself, applied to the SAME `ranked`
-- CTE that already carries the LIMIT — group order, not just membership, is
-- unchanged.
-- ------------------------------------------------------------

drop function if exists public.search_conversations(text, vector(1536), int, uuid, text);

create function public.search_conversations(
  query_text      text,
  query_embedding vector(1536),
  match_count     int default 10,
  search_user_id  uuid default auth.uid(),
  p_lane          text default 'all'
)
returns jsonb
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with q as (
    select plainto_tsquery('english', query_text) as tsq
  ),
  matches as (
    select
      c.id,
      c.source,
      c.title,
      c.created_at,
      em.summary,
      case
        when query_embedding is not null then 1 - (c.embedding <=> query_embedding)
        else null
      end as similarity,
      ts_rank(c.fts, q.tsq, 32)::float8 as fts_rank,
      (c.fts @@ q.tsq) as fts_hit
    from public.conversations c
    left join public.extracted_metadata em on em.conversation_id = c.id
    cross join q
    where c.user_id = search_user_id
      and (p_lane = 'all' or (p_lane = 'chat' and c.source <> 'claude-code') or (p_lane = 'code' and c.source = 'claude-code'))
      and (
        c.fts @@ q.tsq
        or (query_embedding is not null and 1 - (c.embedding <=> query_embedding) > 0.3)
      )
  ),
  ranked as (
    -- Same LIMIT clamp as 071 (match_count passed straight to LIMIT, no
    -- greatest() -- 071's F3 kept 0 -> 0 rows, negative -> LIMIT error).
    select id, source, title, created_at, summary, similarity, fts_hit, fts_rank
    from matches
    order by fts_hit desc, fts_rank desc, similarity desc nulls last, id
    limit match_count
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'id', r.id, 'source', r.source, 'title', r.title, 'created_at', r.created_at,
        'summary', r.summary, 'similarity', r.similarity
      )
      order by r.fts_hit desc, r.fts_rank desc, r.similarity desc nulls last, r.id
    ),
    '[]'::jsonb
  )
  from ranked r;
$$;

comment on function public.search_conversations(text, vector(1536), int, uuid, text) is
  'Hybrid FTS/embedding conversation search backing /search (migration 008 -> 012 -> 014 -> 071; issue #115, migration 075: returns jsonb instead of returns table -- an ACL-denied set-returning function segfaults the backend under an unauthorized PostgREST role, the same crash 074 fixed for mcp_claims_browse. Query body, ORDER BY (fts_hit desc, fts_rank desc, similarity desc nulls last, id -- now inside jsonb_agg), and LIMIT clamp are otherwise unchanged from 071. Single caller: callSearchRpc in apps/cloud/src/lib/search.ts.';

revoke all on function public.search_conversations(text, vector(1536), int, uuid, text) from public;
revoke all on function public.search_conversations(text, vector(1536), int, uuid, text) from anon;
revoke all on function public.search_conversations(text, vector(1536), int, uuid, text) from authenticated;
grant execute on function public.search_conversations(text, vector(1536), int, uuid, text) to service_role;

-- ------------------------------------------------------------
-- 2. bridge_related_by_conversation — last defined in
-- 055_claims_browse_corrections.sql:264. Caller: GET /api/bridge/context
-- (apps/cloud/src/app/api/bridge/context/route.ts:320), which maps
-- `(data ?? []) as { conversation_id: string }[]` into its RRF fusion --
-- unchanged, since supabase-js parses a jsonb array result identically to a
-- `returns table` one. Similarity order feeds that RRF fusion, so it must
-- move inside the jsonb_agg, same as object 1 above.
-- ------------------------------------------------------------

drop function if exists public.bridge_related_by_conversation(uuid, vector(1536), uuid, int);

create function public.bridge_related_by_conversation(
  p_user_id uuid,
  p_query_embedding vector(1536),
  p_exclude_conversation_id uuid default null,
  p_limit int default 8
)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  with ranked as (
    select
      c.id,
      c.title,
      c.created_at,
      (1 - (c.embedding <=> p_query_embedding))::real as similarity,
      (c.embedding <=> p_query_embedding) as distance
      from public.conversations c
     where c.user_id = p_user_id
       and c.embedding is not null
       and (p_exclude_conversation_id is null or c.id <> p_exclude_conversation_id)
       and 1 - (c.embedding <=> p_query_embedding) > 0.3
     order by c.embedding <=> p_query_embedding
     limit greatest(coalesce(p_limit, 8), 1)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'conversation_id', r.id, 'title', r.title, 'conv_date', r.created_at, 'similarity', r.similarity
      )
      order by r.distance
    ),
    '[]'::jsonb
  )
  from ranked r;
$$;

comment on function public.bridge_related_by_conversation(uuid, vector, uuid, int) is
  'GET /api/bridge/context''s related-conversations fallback (migration 055; issue #115, migration 075: returns jsonb instead of returns table, same fix as mcp_claims_browse -- an ACL-denied set-returning function segfaults the backend under an unauthorized PostgREST role). Same >0.3 similarity floor and cosine order (now inside jsonb_agg) as migration 055; used when mcp_related_conversations (kg_conv_embeddings-cache-backed, bootstrap-only) returns zero rows. Migration-016-shaped: security invoker, explicit p_user_id, EXECUTE service_role only.';

revoke all on function public.bridge_related_by_conversation(uuid, vector, uuid, int) from public;
revoke all on function public.bridge_related_by_conversation(uuid, vector, uuid, int) from anon;
revoke all on function public.bridge_related_by_conversation(uuid, vector, uuid, int) from authenticated;
grant execute on function public.bridge_related_by_conversation(uuid, vector, uuid, int) to service_role;

-- ------------------------------------------------------------
-- 3. bridge_claim_next_command — last defined in
-- 050_bridge_device_context.sql:98. `returns setof public.agent_commands`
-- with an UPDATE ... RETURNING * body; no explicit stability keyword in the
-- authoritative definition (Postgres default VOLATILE), preserved here the
-- same way -- no stable/volatile keyword added.
--
-- Converted to a CTE around the same UPDATE ... RETURNING *, then
-- `jsonb_agg(to_jsonb(c))` over the claimed row(s) -- `to_jsonb` on the CTE's
-- row applies the SAME column-name-keyed, type-coerced JSON shape PostgREST
-- already produced for `returns setof agent_commands` (uuid/timestamptz
-- columns to string, jsonb columns passed through as nested objects), so
-- every field the caller reads (id, type, payload, bridge_session_id --
-- apps/cloud/src/app/api/bridge/agent/next/route.ts:60 and
-- packages/cli/src/bridge.ts's AgentCommand) survives with the same JSON
-- type. At-most-one-row semantics preserved exactly: zero claimed rows ->
-- jsonb_agg is NULL -> coalesced to '[]'::jsonb; one claimed row -> a
-- 1-element array, same as `Array.isArray(data) ? data[0] : data` already
-- expects in route.ts.
-- ------------------------------------------------------------

drop function if exists public.bridge_claim_next_command(uuid, uuid);

create function public.bridge_claim_next_command(p_user_id uuid, p_device_id uuid)
returns jsonb
language sql
security invoker
set search_path = public, pg_temp
as $$
  with claimed as (
    update public.agent_commands
       set status = 'claimed',
           claimed_at = now(),
           device_id = p_device_id
     where id = (
       select id
         from public.agent_commands
        where user_id = p_user_id
          and status = 'pending'
          and (device_id = p_device_id or device_id is null)
        order by created_at
        limit 1
        for update skip locked
     )
    returning *
  )
  select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
  from claimed c;
$$;

comment on function public.bridge_claim_next_command(uuid, uuid) is
  'Bridge demo: atomically claims the oldest pending agent_commands row for p_user_id that p_device_id is allowed to run (device_id IS NULL or = p_device_id), stamping device_id = p_device_id on claim. FOR UPDATE SKIP LOCKED avoids double-claiming across concurrent daemon polls (migration 050). Issue #115, migration 075: returns jsonb instead of setof public.agent_commands -- same ACL-denied-SRF segfault fix as mcp_claims_browse; the UPDATE ... RETURNING * body is unchanged, now wrapped in a CTE and jsonb_agg(to_jsonb(...)) over the claimed row(s) -- empty result serializes as [], one row as a 1-element array, same at-most-one-row semantics the caller (apps/cloud/src/app/api/bridge/agent/next/route.ts) already handles via Array.isArray(data) ? data[0] : data. Migration-016-shaped: security invoker, explicit p_user_id, EXECUTE service_role only.';

revoke all on function public.bridge_claim_next_command(uuid, uuid) from public;
revoke all on function public.bridge_claim_next_command(uuid, uuid) from anon;
revoke all on function public.bridge_claim_next_command(uuid, uuid) from authenticated;
grant execute on function public.bridge_claim_next_command(uuid, uuid) to service_role;

-- ============================================================
-- DEFERRED — kg_memories_for, claims_browse_entity_labels
--
-- Both are `returns table` set-returning functions with the same
-- authenticated-granted / anon-revoked ACL shape as the three converted
-- above (kg_memories_for: 070_kg_memories.sql:303, granted to authenticated,
-- revoked from anon/public -- a direct POST /rest/v1/rpc/kg_memories_for by
-- an unauthenticated caller hits the SAME ACL-denied-SRF segfault class.
-- claims_browse_entity_labels: last defined 069_people_facet_owner_org_
-- exclusion.sql:234, granted to authenticated, revoked from anon).
--
-- NOT converted here because both are consumed internally, as
-- `select * from public.<fn>(...)`, by OTHER security-invoker functions that
-- read named table columns off the result -- a return-type change to jsonb
-- breaks every one of those call sites (a jsonb-returning function produces
-- one row / one jsonb column via `select * from fn(...)`, not the original
-- named columns), independent of any grant. Confirmed by grep across every
-- migration (`from public.kg_memories_for(`, `from public.
-- claims_browse_entity_labels(`):
--
--   kg_memories_for is called from:
--     - kg_memories (view, 070_kg_memories.sql:787)
--     - kg_memories_browse (070_kg_memories.sql:1073)
--     - mcp_memories_context (070_kg_memories.sql:1310)
--     - mcp_memories_browse (070_kg_memories.sql:1420)
--     - kg_memory_keys_for_claims (070_kg_memories.sql:1540)
--     - mcp_memories_identity (070_kg_memories.sql:1581)
--   all security invoker, all within migration 070 itself.
--
--   claims_browse_entity_labels is called from:
--     - kg_claims_browse (last defined 068_code_lane_project_filter.sql,
--       security invoker -- real end-user authenticated sessions invoke it,
--       so its grants are load-bearing, not just theoretical PostgREST
--       exposure)
--     - kg_claims_facets (last defined 061_claims_lane.sql)
--     - kg_memories_for itself (070_kg_memories.sql:486,500)
--     - kg_memory_instances_page (070_kg_memories.sql:894,898)
--     - kg_memories_facets (070_kg_memories.sql:1213,1216)
--
-- Converting either function's return type in isolation, without also
-- rewriting every one of these consumers in the SAME migration, would ship
-- broken SQL (undefined column errors at call time) -- a much larger,
-- higher-blast-radius change than "these five functions", touching the
-- entire memory/claims-browse serving chain across 4 additional migrations
-- (061, 068, 070 x2). Left for a dedicated follow-up migration + its own
-- scope decision, not attempted here.
-- ============================================================
