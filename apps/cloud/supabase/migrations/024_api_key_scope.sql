-- ============================================================
-- 024_api_key_scope.sql
-- Area-scoped API tokens — graph-layer enforcement per key
-- (GitHub issue #83).
--
-- NOTE ON NUMBERING: issue #83 assigned this migration number 019, but by the
-- time it landed another parallel agent had already created AND applied
-- 019_kg_stage_a_naming_fallback.sql (issue #79). Migration versions are a
-- primary key in supabase_migrations.schema_migrations, so 019 was taken;
-- 020-023 were reserved for other in-flight agents, so this took the next
-- free number, 024.
--
-- An `lls_` API key may be constrained to a single LifeArea. When it is,
-- EVERY read reachable through that key is bounded to that LifeArea's
-- `contains` subgraph — enforced in SQL, never a TS post-filter, using the
-- same cycle-guarded `contains`-traversal pattern as migration 016.
--
-- WHERE THE SCOPE LIVES: profiles.api_key_scope_node_id.
--   * NULL  -> the key is unscoped ("All of my graph"); behaves exactly as
--     every key did before this migration.
--   * non-NULL -> a LifeArea node id (public.kg_nodes.id). The token scope is
--     a MANDATORY OUTER BOUND: the /api/mcp route injects it from the key
--     (never from the request body), and a client-supplied `scope` param may
--     only narrow WITHIN it, never escape it.
--
-- WHY NO FOREIGN KEY on api_key_scope_node_id: a real FK would need an
-- ON DELETE action, and every safe option is wrong here. ON DELETE SET NULL
-- would silently turn a scoped key into an all-access key the instant its
-- LifeArea is hard-deleted — a privilege escalation. ON DELETE CASCADE would
-- delete the profile. ON DELETE RESTRICT would let a scoped key block the
-- graph-edit RPCs (migration 018) from deleting an area. So the column is a
-- plain uuid: a stale id simply seeds an EMPTY `contains` subtree in every
-- RPC below (the seed predicate requires the node to still exist as a live
-- LifeArea), so a deleted scope area fails CLOSED — the key returns nothing,
-- never everything.
-- ============================================================

alter table public.profiles
  add column if not exists api_key_scope_node_id uuid;

comment on column public.profiles.api_key_scope_node_id is
  'Area scope for this profile''s lls_ API key: NULL = all of the graph; else a public.kg_nodes.id of type LifeArea. No FK on purpose — a stale/deleted id fails CLOSED (empty subtree), never open. See migration 019.';

-- ------------------------------------------------------------
-- mcp_scope_within(): is p_candidate_id inside p_bound_id's `contains`
-- subtree (inclusive of the bound itself)? Backs the token-scope OUTER BOUND
-- check: when a scoped token's caller supplies a `scope` param, the route
-- resolves it to a LifeArea id and calls this to confirm it lies within the
-- token's bound. A candidate outside the bound (or a bound that no longer
-- exists as a live LifeArea -> empty subtree -> false) is rejected as an
-- "unknown scope" — the SAME failure a genuinely nonexistent scope produces,
-- so there is no existence leak distinguishing "outside your token" from
-- "not a real area".
-- ------------------------------------------------------------
create or replace function public.mcp_scope_within(
  p_user_id uuid,
  p_bound_id uuid,
  p_candidate_id uuid
)
returns boolean
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive sub(node) as (
    select id from public.kg_nodes
    where user_id = p_user_id and id = p_bound_id and type = 'LifeArea' and deleted_at is null
    union all
    select e.dst_id from public.kg_edges e join sub s on e.src_id = s.node
    where e.rel_type = 'contains' and e.user_id = p_user_id and e.deleted_at is null
  ) cycle node set is_cycle using path
  select exists (select 1 from sub where node = p_candidate_id);
$$;

-- ------------------------------------------------------------
-- mcp_scoped_conversation(): fetch a single conversation by id, but ONLY if
-- it is attached (via contributes_to / discusses) under the p_scope_id
-- LifeArea's `contains` subtree. Returns the full conversation row as jsonb,
-- or NULL when the conversation does not exist, is not the caller's, or is
-- out of scope — the caller (get_conversation tool) turns NULL into a plain
-- "not found", so out-of-scope is INVISIBLE (404-equivalent, never 403: no
-- existence leak). When p_scope_id is NULL the scope check is skipped and
-- this behaves as a plain user_id-scoped fetch (unscoped-token parity).
--
-- ORPHAN CONVERSATIONS (decision, issue #83 §5): a conversation with no
-- contributes_to/discusses edge into the scope subtree is out of scope and
-- therefore INVISIBLE to a scoped token — the `exists` below is false for it.
-- Unscoped tokens still see every conversation, unchanged.
-- ------------------------------------------------------------
create or replace function public.mcp_scoped_conversation(
  p_user_id uuid,
  p_conversation_id uuid,
  p_scope_id uuid default null
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive allowed(node) as (
    select id from public.kg_nodes
    where user_id = p_user_id and deleted_at is null
      and p_scope_id is not null and id = p_scope_id and type = 'LifeArea'
    union all
    select e.dst_id from public.kg_edges e join allowed a on e.src_id = a.node
    where e.rel_type = 'contains' and e.user_id = p_user_id and e.deleted_at is null
  ) cycle node set is_cycle using path,
  in_scope as (
    select 1
    where p_scope_id is null
       or exists (
         select 1 from public.kg_edges e
         where e.user_id = p_user_id and e.deleted_at is null
           and e.rel_type in ('contributes_to', 'discusses')
           and e.source_conversation_id = p_conversation_id
           and e.dst_id in (select node from allowed)
       )
  )
  select to_jsonb(c) from (
    select c.id, c.source, c.title, c.created_at, c.updated_at, c.model, c.messages, c.metadata
    from public.conversations c
    where c.id = p_conversation_id
      and c.user_id = p_user_id
      and exists (select 1 from in_scope)
  ) c;
$$;

-- ------------------------------------------------------------
-- mcp_who_is_this_user(): REPLACES the migration-016 two-arg version. Adds a
-- third argument p_suppress_global: when TRUE (the /api/mcp route sets it iff
-- the KEY itself is area-scoped), the global identity_line and portrait are
-- withheld — a scoped token gets ONLY the scoped area view, never the global
-- identity/portrait (issue #83). Suppression keys off the TOKEN scope, not
-- the effective/narrowed scope, so a default-all token that voluntarily
-- passes a `scope` param still returns identity+portrait exactly as before
-- (regression parity). Body is otherwise identical to migration 016.
-- ------------------------------------------------------------
drop function if exists public.mcp_who_is_this_user(uuid, uuid);

create or replace function public.mcp_who_is_this_user(
  p_user_id uuid,
  p_scope_id uuid default null,
  p_suppress_global boolean default false
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive
  self_node as (
    select props->>'identity_line' as identity_line
    from public.kg_nodes
    where user_id = p_user_id and type = 'User' and label = '_self' and deleted_at is null
    limit 1
  ),
  portrait as (
    select markdown_compact
    from public.kg_user_portraits
    where user_id = p_user_id
  ),
  root as (
    select id, label, props
    from public.kg_nodes
    where user_id = p_user_id and id = p_scope_id and type = 'LifeArea' and deleted_at is null
  ),
  sub(node) as (
    select id from root
    union all
    select e.dst_id from public.kg_edges e join sub s on e.src_id = s.node
    where e.rel_type = 'contains' and e.user_id = p_user_id and e.deleted_at is null
  ) cycle node set is_cycle using path,
  cvs as (
    select distinct e.source_conversation_id as cid
    from sub s
    join public.kg_edges e on e.dst_id = s.node
      and e.rel_type in ('contributes_to', 'discusses') and e.user_id = p_user_id and e.deleted_at is null
      and e.source_conversation_id is not null
  ),
  people_rows as (
    select p.label, count(distinct cvs.cid)::int as links
    from cvs
    join public.kg_edges pe on pe.source_conversation_id = cvs.cid and pe.user_id = p_user_id and pe.deleted_at is null
    join public.kg_nodes p on p.id = pe.src_id or p.id = pe.dst_id
    where p.type = 'Person' and p.label != '_self' and p.deleted_at is null
    group by p.label
    order by links desc
    limit 5
  ),
  children as (
    select n.id as child_id, n.label, n.kind
    from public.kg_edges e
    join root r on r.id = e.src_id
    join public.kg_nodes n on n.id = e.dst_id
    where e.rel_type = 'contains' and e.user_id = p_user_id and e.deleted_at is null
      and n.type = 'Item' and n.deleted_at is null
  ),
  csub(top, node) as (
    select c.child_id, c.child_id from children c
    union all
    select s.top, e.dst_id from public.kg_edges e join csub s on e.src_id = s.node
    where e.rel_type = 'contains' and e.user_id = p_user_id and e.deleted_at is null
  ) cycle node set is_cycle using path,
  top_items as (
    select ch.child_id as id, ch.label, ch.kind,
           count(distinct e.source_conversation_id)::int as convs
    from children ch
    join csub s on s.top = ch.child_id
    left join public.kg_edges e on e.dst_id = s.node
      and e.rel_type in ('contributes_to', 'discusses') and e.user_id = p_user_id and e.deleted_at is null
    group by ch.child_id, ch.label, ch.kind
    order by convs desc
    limit 5
  )
  select jsonb_build_object(
    'identity_line', case when p_suppress_global then null else (select identity_line from self_node) end,
    'portrait_compact', case when p_suppress_global then null else (select markdown_compact from portrait) end,
    'scope', case when p_scope_id is null then null else (
      select jsonb_build_object(
        'id', r.id,
        'label', r.label,
        'summary', r.props->>'summary',
        'conv_count', (select count(*) from cvs),
        'top_items', coalesce((select jsonb_agg(to_jsonb(x)) from top_items x), '[]'::jsonb),
        'top_people', coalesce((select jsonb_agg(to_jsonb(x)) from people_rows x), '[]'::jsonb)
      )
      from root r
    ) end
  );
$$;

-- ------------------------------------------------------------
-- mcp_life_areas(): REPLACES the migration-016 one-arg version. Adds an
-- optional p_scope_id. When NULL (unscoped token) it lists EVERY LifeArea,
-- exactly as before (regression parity). When set (a scoped token), the
-- listed roots are restricted to the scope area itself plus any nested
-- LifeAreas inside its `contains` subtree — so a scoped token can never even
-- learn the NAMES of the user's other life areas. Counts are unchanged
-- (still computed over each root's own subtree). Body is otherwise identical
-- to migration 016.
-- ------------------------------------------------------------
drop function if exists public.mcp_life_areas(uuid);

create or replace function public.mcp_life_areas(p_user_id uuid, p_scope_id uuid default null)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive
  -- When scoped, the set of LifeAreas the token may even see: the bound area
  -- plus every LifeArea reachable from it via `contains`. Empty when unscoped
  -- (seed guarded on p_scope_id is not null) so the downstream filter
  -- short-circuits to "all".
  in_bound(node) as (
    select id from public.kg_nodes
    where user_id = p_user_id and deleted_at is null
      and p_scope_id is not null and id = p_scope_id and type = 'LifeArea'
    union all
    select e.dst_id from public.kg_edges e join in_bound b on e.src_id = b.node
    where e.rel_type = 'contains' and e.user_id = p_user_id and e.deleted_at is null
  ) cycle node set is_cycle_b using path_b,
  roots as (
    select id, label, props
    from public.kg_nodes
    where user_id = p_user_id and type = 'LifeArea' and label != '_self' and deleted_at is null
      and (p_scope_id is null or id in (select node from in_bound))
  ),
  sub(root, node) as (
    select r.id, r.id from roots r
    union all
    select s.root, e.dst_id from public.kg_edges e join sub s on e.src_id = s.node
    where e.rel_type = 'contains' and e.user_id = p_user_id and e.deleted_at is null
  ) cycle node set is_cycle using path,
  item_counts as (
    select s.root, count(distinct n.id)::int as item_count
    from sub s
    join public.kg_nodes n on n.id = s.node
    where n.type = 'Item' and n.deleted_at is null
    group by s.root
  ),
  conv_counts as (
    select s.root, count(distinct e.source_conversation_id)::int as conv_count
    from sub s
    join public.kg_edges e on e.dst_id = s.node
      and e.rel_type in ('contributes_to', 'discusses') and e.user_id = p_user_id and e.deleted_at is null
      and e.source_conversation_id is not null
    group by s.root
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id', r.id,
      'label', r.label,
      'summary', r.props->>'summary',
      'item_count', coalesce(ic.item_count, 0),
      'conv_count', coalesce(cc.conv_count, 0)
    ) order by coalesce(cc.conv_count, 0) desc),
    '[]'::jsonb
  )
  from roots r
  left join item_counts ic on ic.root = r.id
  left join conv_counts cc on cc.root = r.id;
$$;

-- ------------------------------------------------------------
-- mcp_context_for(): REPLACES the migration-016 version to close a scope
-- LEAK (issue #83, found by adversarial verification). 016 bounded only the
-- `seeds` CTE by `allowed_convs`; the depth-2 expansion (hop1 -> hop2 ->
-- frontier) then walked contains/contributes_to/discusses/mentions_person/
-- uses_tool across the user's ENTIRE graph with no scope predicate. A shared
-- entity (a Person/Tool mentioned in both an in-scope and an out-of-scope
-- conversation) bridged a seed into other life areas, so out-of-scope
-- Conversation/entity/Item nodes flowed into the returned arrays — even
-- though get_conversation on those same convs correctly 404s.
--
-- THE FIX: when p_scope_id is not null, the materialized `frontier_nodes`
-- (the ONLY source of every output row) is intersected with an `in_scope`
-- node set. All output CTEs (entity_rows, item_rows, conv_rows) read from
-- frontier_nodes, so this single predicate fully bounds the output. The
-- graph walk may still traverse out-of-scope ids while exploring, but none
-- of them can appear in the result.
--
-- `in_scope` = the scope's `contains` subtree (LifeArea + Items, `allowed`)
--   UNION the in-scope Conversation nodes (source_conversation_id in
--   `allowed_convs`) UNION nodes ADJACENT to an in-scope Conversation node
--   (the entities legitimately mentioned by in-scope conversations). A shared
--   Person stays (it is adjacent to an in-scope conv), but the out-of-scope
--   convs/Items reachable only THROUGH that Person do not — they are neither
--   in the subtree, nor in-scope conv nodes, nor adjacent to an in-scope conv
--   node.
--
-- UNSCOPED PARITY: when p_scope_id is null, `allowed`/`allowed_convs`/
-- `in_scope_conv_nodes`/`in_scope` are all empty and the added frontier
-- predicate is `(p_scope_id is null or ...)` -> true for every node, so the
-- result is byte-for-byte identical to migration 016.
-- ------------------------------------------------------------
create or replace function public.mcp_context_for(
  p_user_id uuid,
  p_query_embedding vector(1536),
  p_scope_id uuid default null,
  p_seed_limit int default 5
)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  with recursive
  allowed(node) as (
    select id from public.kg_nodes
    where user_id = p_user_id and deleted_at is null
      and p_scope_id is not null and id = p_scope_id and type = 'LifeArea'
    union all
    select e.dst_id from public.kg_edges e join allowed a on e.src_id = a.node
    where e.rel_type = 'contains' and e.user_id = p_user_id and e.deleted_at is null
  ) cycle node set is_cycle using path,
  allowed_convs as (
    select distinct e.source_conversation_id as cid
    from public.kg_edges e
    where e.user_id = p_user_id and e.deleted_at is null
      and e.rel_type in ('contributes_to', 'discusses')
      and e.dst_id in (select node from allowed)
      and e.source_conversation_id is not null
  ),
  seeds as (
    select ce.conversation_id as cid
    from public.kg_conv_embeddings ce
    where ce.user_id = p_user_id
      and (p_scope_id is null or ce.conversation_id in (select cid from allowed_convs))
    order by ce.embedding <=> p_query_embedding
    limit greatest(p_seed_limit, 1)
  ),
  seed_nodes as (
    select id from public.kg_nodes
    where user_id = p_user_id and type = 'Conversation' and deleted_at is null
      and source_conversation_id in (select cid from seeds)
  ),
  hop1 as (
    select distinct
      case when e.src_id in (select id from seed_nodes) then e.dst_id else e.src_id end as node_id
    from public.kg_edges e
    where e.user_id = p_user_id and e.deleted_at is null
      and e.rel_type in ('contains', 'contributes_to', 'discusses', 'mentions_person', 'uses_tool')
      and coalesce(e.confidence, 1.0) >= 0.5
      and (e.src_id in (select id from seed_nodes) or e.dst_id in (select id from seed_nodes))
  ),
  hop2 as (
    select distinct
      case when e.src_id in (select node_id from hop1) then e.dst_id else e.src_id end as node_id
    from public.kg_edges e
    where e.user_id = p_user_id and e.deleted_at is null
      and e.rel_type in ('contains', 'contributes_to', 'discusses', 'mentions_person', 'uses_tool')
      and coalesce(e.confidence, 1.0) >= 0.5
      and (e.src_id in (select node_id from hop1) or e.dst_id in (select node_id from hop1))
  ),
  frontier as (
    select id as node_id from seed_nodes
    union
    select node_id from hop1
    union
    select node_id from hop2
  ),
  -- SCOPE BOUND (issue #83): the in-scope conversation nodes, and then the
  -- full set of node ids a scoped token may see in the context block.
  in_scope_conv_nodes as (
    select id from public.kg_nodes
    where user_id = p_user_id and type = 'Conversation' and deleted_at is null
      and source_conversation_id in (select cid from allowed_convs)
  ),
  in_scope(id) as (
    select node from allowed
    union
    select id from in_scope_conv_nodes
    union
    select case when e.src_id in (select id from in_scope_conv_nodes) then e.dst_id else e.src_id end
    from public.kg_edges e
    where e.user_id = p_user_id and e.deleted_at is null
      and (e.src_id in (select id from in_scope_conv_nodes) or e.dst_id in (select id from in_scope_conv_nodes))
  ),
  frontier_nodes as (
    select n.id, n.type::text as type, n.kind, n.label, n.source_conversation_id
    from public.kg_nodes n
    where n.user_id = p_user_id and n.deleted_at is null and n.id in (select node_id from frontier)
      and n.label != '_self'
      and (p_scope_id is null or n.id in (select id from in_scope))
  ),
  entity_rows as (
    select id, type, kind, label
    from frontier_nodes
    where type in ('Person', 'Organization', 'Tool', 'Artifact')
    limit 20
  ),
  item_rows as (
    select id, type, kind, label
    from frontier_nodes
    where type in ('Item', 'LifeArea')
    limit 20
  ),
  conv_rows as (
    select c.id, c.title, c.created_at as conv_date
    from frontier_nodes fn
    join public.conversations c on c.id = fn.source_conversation_id
    where fn.type = 'Conversation'
    order by c.created_at desc
    limit 15
  )
  select jsonb_build_object(
    'seed_count', (select count(*) from seeds),
    'entities', coalesce((select jsonb_agg(to_jsonb(e)) from entity_rows e), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(to_jsonb(i)) from item_rows i), '[]'::jsonb),
    'conversations', coalesce((select jsonb_agg(to_jsonb(c) order by c.conv_date desc) from conv_rows c), '[]'::jsonb)
  );
$$;

-- ------------------------------------------------------------
-- Lock down execution: service_role ONLY, exactly like migration 016 (these
-- take a trusted p_user_id from a service-role-only caller; an authenticated
-- user must never call them directly with someone else's id).
-- ------------------------------------------------------------
revoke all on function public.mcp_scope_within(uuid, uuid, uuid) from public;
revoke all on function public.mcp_scope_within(uuid, uuid, uuid) from anon;
revoke all on function public.mcp_scope_within(uuid, uuid, uuid) from authenticated;
grant execute on function public.mcp_scope_within(uuid, uuid, uuid) to service_role;

revoke all on function public.mcp_scoped_conversation(uuid, uuid, uuid) from public;
revoke all on function public.mcp_scoped_conversation(uuid, uuid, uuid) from anon;
revoke all on function public.mcp_scoped_conversation(uuid, uuid, uuid) from authenticated;
grant execute on function public.mcp_scoped_conversation(uuid, uuid, uuid) to service_role;

revoke all on function public.mcp_who_is_this_user(uuid, uuid, boolean) from public;
revoke all on function public.mcp_who_is_this_user(uuid, uuid, boolean) from anon;
revoke all on function public.mcp_who_is_this_user(uuid, uuid, boolean) from authenticated;
grant execute on function public.mcp_who_is_this_user(uuid, uuid, boolean) to service_role;

revoke all on function public.mcp_life_areas(uuid, uuid) from public;
revoke all on function public.mcp_life_areas(uuid, uuid) from anon;
revoke all on function public.mcp_life_areas(uuid, uuid) from authenticated;
grant execute on function public.mcp_life_areas(uuid, uuid) to service_role;

-- mcp_context_for keeps its migration-016 signature; CREATE OR REPLACE
-- preserves existing grants, but re-assert them idempotently for clarity.
revoke all on function public.mcp_context_for(uuid, vector(1536), uuid, int) from public;
revoke all on function public.mcp_context_for(uuid, vector(1536), uuid, int) from anon;
revoke all on function public.mcp_context_for(uuid, vector(1536), uuid, int) from authenticated;
grant execute on function public.mcp_context_for(uuid, vector(1536), uuid, int) to service_role;
