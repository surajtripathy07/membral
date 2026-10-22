-- ============================================================
-- 016_kg_mcp_rpcs.sql
-- Graph-projecting MCP tools (GitHub issue #41 / membral-ort.5).
--
-- Cloud /api/mcp is the SINGLE MCP surface (ADR 0001 addendum 2026-06-30);
-- these RPCs back its category-scoped tools: list_life_areas,
-- who_is_this_user, get_active_projects, get_related_conversations,
-- get_context_for, search_conversations. get_conversation needs no new RPC
-- (a plain user_id-scoped `conversations` select, as it already is in
-- lib/mcp/server.ts).
--
-- SCOPING AT THE GRAPH LAYER: every "scope" argument here is a LifeArea node
-- id, already resolved by the caller via mcp_resolve_scope() below (the MCP
-- tool layer resolves scope text -> id once, then passes the id down). Each
-- function that accepts p_scope_id constrains its result set via a `contains`
-- recursive CTE over kg_edges (never a text/label post-filter). kg data has
-- real `contains` cycles (confirmed by migration 015's own comment + the x34
-- sweep-metrics work) so every unbounded recursion carries a SQL-standard
-- `CYCLE ... SET ... USING path` guard, same as 015.
--
-- SECURITY MODEL (deviates from 015 -- see why below):
--   * 015's functions are SECURITY INVOKER + `auth.uid()`, granted to
--     `authenticated`, because their caller is always a real end-user
--     Supabase session (cookie-bound client) -- auth.uid() is trustworthy
--     there, and RLS enforces it as the actual "belt".
--   * /api/mcp has NO Supabase session: it authenticates via a Bearer `lls_`
--     API key (validateApiKey(), see lib/api-keys.ts) OR a JWT passed
--     manually, resolves a userId in application code, and then -- like
--     every other key-authed route in this codebase (search.ts,
--     lib/mcp/server.ts's existing get_conversation/weekly_digest) -- talks
--     to Postgres with SUPABASE_SERVICE_ROLE_KEY for every query. Under a
--     service-role connection `auth.uid()` is NULL (no `sub` claim; verified
--     empirically by migration 014's own investigation), so an
--     auth.uid()-keyed function would silently return nothing for every
--     caller here.
--   * So every function below takes an explicit `p_user_id uuid` argument
--     instead, exactly like migration 014's `search_conversations`
--     (search_user_id). Because that argument is trusted input from a
--     service-role-only caller and NOT re-derived from a session, EXECUTE
--     must NOT be granted to `authenticated` -- an ordinary logged-in user
--     could otherwise call these RPCs directly over PostgREST with someone
--     else's p_user_id and read their whole graph. EXECUTE is revoked from
--     public/anon/authenticated and granted ONLY to `service_role` (the
--     server-only key, never shipped to a browser). This is the 014 pattern,
--     not the 015 pattern -- the "belt" here is the mandatory p_user_id
--     predicate on every table access (present on every CTE branch below,
--     including nested kg_edges/kg_nodes joins reached via the recursive
--     walk); the "suspenders" is the service_role-only grant.
--   * `search_path` is pinned to `public, pg_temp` for the functions with no
--     vector op, and additionally `extensions` for the three that use the
--     pgvector `<=>` operator -- that operator lives in the `extensions`
--     schema (`create extension vector with schema extensions`, 001), not
--     `public`; omitting it fails at call time with "operator does not
--     exist: vector <=> vector" (the exact bug migration 014 documents and
--     fixes for search_conversations).
--
-- Embeddings: query-time embedding of a tool's `topic`/`query` argument is
-- computed in the route/tool layer (lib/embeddings.ts generateEmbedding,
-- same helper apps/cloud/src/lib/search.ts already uses) and passed in as a
-- `vector(1536)` parameter -- these functions never call an embedding
-- provider themselves. Conversation-level embeddings are read from
-- `kg_conv_embeddings` (migration 013), NOT `kg_nodes.embedding`: the Stage B
-- writer (stage-b.ts insertConversationNode) never populates the latter for
-- Conversation nodes, so it is always NULL for that type in production data
-- (verified by inspection -- no caller in graph-writer.ts/stage-b.ts passes
-- `embedding` for a Conversation node).
-- ============================================================

-- ------------------------------------------------------------
-- mcp_resolve_scope(): scope text (a LifeArea uuid OR its label, case
-- insensitive) -> {id, label}, or null if nothing matches. The tool layer
-- calls this once per scoped request and, on null, returns a clean "unknown
-- scope" error instead of silently running unscoped.
-- ------------------------------------------------------------
create or replace function public.mcp_resolve_scope(p_user_id uuid, p_scope text)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  -- The uuid cast is computed once in its own CTE via a CASE (guaranteed lazy
  -- per Postgres semantics, unlike an inline `regex AND id = p_scope::uuid`
  -- guard — AND/OR branches are NOT guaranteed short-circuit order for
  -- deterministic subexpressions, so a non-uuid p_scope like a plain label
  -- can still hit `invalid input syntax for type uuid` even behind a
  -- same-clause regex guard; verified empirically against local Postgres).
  with parsed as (
    select case
      when p_scope ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p_scope::uuid
      else null
    end as scope_uuid
  )
  select to_jsonb(x) from (
    select n.id, n.label
    from public.kg_nodes n, parsed p
    where n.user_id = p_user_id and n.type = 'LifeArea' and n.label != '_self' and n.deleted_at is null
      and (n.id = p.scope_uuid or lower(n.label) = lower(p_scope))
    order by (lower(n.label) = lower(p_scope)) desc
    limit 1
  ) x;
$$;

-- ------------------------------------------------------------
-- mcp_life_areas(): every LifeArea (excluding the synthetic `_self` root)
-- with its summary + item/conversation counts over its `contains` subtree.
-- Backs list_life_areas().
-- ------------------------------------------------------------
create or replace function public.mcp_life_areas(p_user_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive
  roots as (
    select id, label, props
    from public.kg_nodes
    where user_id = p_user_id and type = 'LifeArea' and label != '_self' and deleted_at is null
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
-- mcp_who_is_this_user(): identity_line (props->>'identity_line' on the
-- `_self` User node) + compact portrait markdown (kg_user_portraits), and
-- when p_scope_id is given, that LifeArea's summary + top-5 items/people
-- over its `contains` subtree. Backs who_is_this_user(scope?).
-- ------------------------------------------------------------
create or replace function public.mcp_who_is_this_user(p_user_id uuid, p_scope_id uuid default null)
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
    'identity_line', (select identity_line from self_node),
    'portrait_compact', (select markdown_compact from portrait),
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
-- mcp_active_projects(): Items of kind project/workstream that are not
-- completed/abandoned ("non-archived" -- the pipeline's actual status
-- vocabulary per kg/types.ts StageANameVerdict is active|completed|paused|
-- null; there is no literal "archived" status, so non-archived is modeled
-- as status not in ('completed','abandoned') -- paused/active/null all
-- still count as "in play"), with conversation counts + last-touched date.
-- Optionally scoped to one LifeArea's `contains` subtree. Backs
-- get_active_projects(scope?).
-- ------------------------------------------------------------
create or replace function public.mcp_active_projects(p_user_id uuid, p_scope_id uuid default null)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive
  -- Seed is empty when unscoped (p_scope_id is null), so the recursion never
  -- runs and every downstream "p_scope_id is null or id in (select node from
  -- allowed)" check short-circuits to true without walking the whole graph.
  allowed(node) as (
    select id from public.kg_nodes
    where user_id = p_user_id and deleted_at is null
      and p_scope_id is not null and id = p_scope_id and type = 'LifeArea'
    union all
    select e.dst_id from public.kg_edges e join allowed a on e.src_id = a.node
    where e.rel_type = 'contains' and e.user_id = p_user_id and e.deleted_at is null
  ) cycle node set is_cycle using path,
  items as (
    select n.id, n.label, n.kind, n.status
    from public.kg_nodes n
    where n.user_id = p_user_id and n.type = 'Item' and n.deleted_at is null
      and n.kind in ('project', 'workstream')
      and coalesce(n.status, 'active') not in ('completed', 'abandoned')
      and (p_scope_id is null or n.id in (select node from allowed))
  ),
  conv_rows as (
    select e.dst_id as item_id, e.source_conversation_id as cid, c.created_at as conv_date
    from public.kg_edges e
    join public.conversations c on c.id = e.source_conversation_id
    where e.user_id = p_user_id and e.deleted_at is null
      and e.rel_type in ('contributes_to', 'discusses')
      and e.dst_id in (select id from items)
  ),
  rollup as (
    select item_id, count(distinct cid)::int as conv_count, max(conv_date) as last_touched
    from conv_rows
    group by item_id
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id', i.id,
      'label', i.label,
      'kind', i.kind,
      'status', i.status,
      'conv_count', coalesce(r.conv_count, 0),
      'last_touched', r.last_touched
    ) order by r.last_touched desc nulls last),
    '[]'::jsonb
  )
  from items i
  left join rollup r on r.item_id = i.id;
$$;

-- ------------------------------------------------------------
-- mcp_related_conversations(): nearest conversations to a caller-supplied
-- topic embedding (pgvector cosine over kg_conv_embeddings -- see the header
-- note on why not kg_nodes.embedding), each annotated with the LifeArea it
-- climbs to (same `contains`-climb approach as migration 015's
-- kg_read_pulse). Optionally scoped: only conversations attached under the
-- scope LifeArea's subtree are considered at all. Backs
-- get_related_conversations(topic, scope?, limit).
-- ------------------------------------------------------------
create or replace function public.mcp_related_conversations(
  p_user_id uuid,
  p_query_embedding vector(1536),
  p_scope_id uuid default null,
  p_limit int default 10
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
  candidates as (
    select c.id as conv_id, c.title, c.created_at as conv_date, ce.embedding
    from public.conversations c
    join public.kg_conv_embeddings ce on ce.conversation_id = c.id and ce.user_id = p_user_id
    where c.user_id = p_user_id
      and (p_scope_id is null or c.id in (select cid from allowed_convs))
    order by ce.embedding <=> p_query_embedding
    limit greatest(p_limit, 1)
  ),
  attach as (
    select distinct on (c.conv_id)
           c.conv_id, c.title, c.conv_date, e.dst_id as node_id
    from candidates c
    left join public.kg_edges e on e.source_conversation_id = c.conv_id
      and e.rel_type in ('contributes_to', 'discusses') and e.user_id = p_user_id and e.deleted_at is null
    order by c.conv_id, e.created_at desc nulls last
  ),
  climb(conv_id, title, conv_date, cur, depth) as (
    select a.conv_id, a.title, a.conv_date, a.node_id, 0
    from attach a
    union all
    select cl.conv_id, cl.title, cl.conv_date, pe.src_id, cl.depth + 1
    from climb cl
    join public.kg_edges pe on pe.dst_id = cl.cur and pe.rel_type = 'contains'
      and pe.user_id = p_user_id and pe.deleted_at is null
    where cl.depth < 8
  ) cycle cur set is_cycle2 using path2,
  area_rows as (
    select distinct on (cl.conv_id)
           cl.conv_id, cl.title, cl.conv_date, la.label as area_label
    from climb cl
    left join public.kg_nodes la on la.id = cl.cur and la.type = 'LifeArea' and la.deleted_at is null
    order by cl.conv_id, (la.id is not null) desc, cl.depth desc
  )
  select coalesce(
    jsonb_agg(jsonb_build_object(
      'id', ar.conv_id,
      'title', ar.title,
      'date', ar.conv_date,
      'area', ar.area_label
    ) order by cd.embedding <=> p_query_embedding),
    '[]'::jsonb
  )
  from area_rows ar
  join candidates cd on cd.conv_id = ar.conv_id;
$$;

-- ------------------------------------------------------------
-- mcp_context_for(): resolve a topic (caller-supplied embedding) to its
-- nearest seed conversations, then expand a depth-2 subgraph over
-- contains/contributes_to/discusses/mentions_person/uses_tool edges,
-- filtered by edge confidence (>= 0.5, the CONFIDENCE.INBOX floor from
-- kg/types.ts) -- recency is applied downstream by ordering the returned
-- conversations newest-first rather than a hard cutoff, since "recent but
-- weakly linked" and "old but strongly linked" both have legitimate reads
-- and no explicit recency window was specified. Returns a compact context
-- block: entities (Person/Organization/Tool/Artifact), items (Item/
-- LifeArea), and the key conversations reached. Backs
-- get_context_for(topic, scope?).
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
  frontier_nodes as (
    select n.id, n.type::text as type, n.kind, n.label, n.source_conversation_id
    from public.kg_nodes n
    where n.user_id = p_user_id and n.deleted_at is null and n.id in (select node_id from frontier)
      and n.label != '_self'
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
-- mcp_search_conversations(): the same FTS-or-cosine predicate as
-- public.search_conversations (003 -> 012 -> 014), plus an optional
-- graph-layer scope filter (conversations attached under the scope
-- LifeArea's `contains` subtree). Kept as its own function rather than
-- reusing search_conversations(text, vector, int, uuid) directly because
-- that function has no scope notion at all and is a fixed 4-arg signature
-- locked down in 014 -- adding a 5th `p_scope_id` argument there would
-- require dropping/recreating an overload another surface already depends
-- on. Backs search_conversations(query, scope?, limit).
-- ------------------------------------------------------------
create or replace function public.mcp_search_conversations(
  p_user_id uuid,
  p_query_text text,
  p_query_embedding vector(1536),
  p_scope_id uuid default null,
  p_limit int default 10
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
  matches as (
    select
      c.id, c.source, c.title, c.created_at,
      em.summary,
      1 - (c.embedding <=> p_query_embedding) as similarity
    from public.conversations c
    left join public.extracted_metadata em on em.conversation_id = c.id
    where c.user_id = p_user_id
      and (p_scope_id is null or c.id in (select cid from allowed_convs))
      and (
        c.fts @@ plainto_tsquery('english', p_query_text)
        or 1 - (c.embedding <=> p_query_embedding) > 0.3
      )
    order by similarity desc nulls last
    limit greatest(p_limit, 1)
  )
  select coalesce(jsonb_agg(to_jsonb(m)), '[]'::jsonb) from matches m;
$$;

-- ------------------------------------------------------------
-- Lock down execution: service_role ONLY (see header for why this is NOT
-- `authenticated`, unlike migration 015).
-- ------------------------------------------------------------
revoke all on function public.mcp_resolve_scope(uuid, text) from public;
revoke all on function public.mcp_resolve_scope(uuid, text) from anon;
revoke all on function public.mcp_resolve_scope(uuid, text) from authenticated;
grant execute on function public.mcp_resolve_scope(uuid, text) to service_role;

revoke all on function public.mcp_life_areas(uuid) from public;
revoke all on function public.mcp_life_areas(uuid) from anon;
revoke all on function public.mcp_life_areas(uuid) from authenticated;
grant execute on function public.mcp_life_areas(uuid) to service_role;

revoke all on function public.mcp_who_is_this_user(uuid, uuid) from public;
revoke all on function public.mcp_who_is_this_user(uuid, uuid) from anon;
revoke all on function public.mcp_who_is_this_user(uuid, uuid) from authenticated;
grant execute on function public.mcp_who_is_this_user(uuid, uuid) to service_role;

revoke all on function public.mcp_active_projects(uuid, uuid) from public;
revoke all on function public.mcp_active_projects(uuid, uuid) from anon;
revoke all on function public.mcp_active_projects(uuid, uuid) from authenticated;
grant execute on function public.mcp_active_projects(uuid, uuid) to service_role;

revoke all on function public.mcp_related_conversations(uuid, vector(1536), uuid, int) from public;
revoke all on function public.mcp_related_conversations(uuid, vector(1536), uuid, int) from anon;
revoke all on function public.mcp_related_conversations(uuid, vector(1536), uuid, int) from authenticated;
grant execute on function public.mcp_related_conversations(uuid, vector(1536), uuid, int) to service_role;

revoke all on function public.mcp_context_for(uuid, vector(1536), uuid, int) from public;
revoke all on function public.mcp_context_for(uuid, vector(1536), uuid, int) from anon;
revoke all on function public.mcp_context_for(uuid, vector(1536), uuid, int) from authenticated;
grant execute on function public.mcp_context_for(uuid, vector(1536), uuid, int) to service_role;

revoke all on function public.mcp_search_conversations(uuid, text, vector(1536), uuid, int) from public;
revoke all on function public.mcp_search_conversations(uuid, text, vector(1536), uuid, int) from anon;
revoke all on function public.mcp_search_conversations(uuid, text, vector(1536), uuid, int) from authenticated;
grant execute on function public.mcp_search_conversations(uuid, text, vector(1536), uuid, int) to service_role;
