-- ============================================================
-- 015_kg_read_rpcs.sql
-- Read-path bridge for the Second Brain UI (GitHub issue #16).
--
-- The dashboard /map, /pulse and area-room surfaces historically read the
-- throwaway graph_spike.* schema over a superuser pg pool (lib/spike-db.ts),
-- bypassing RLS. These four functions port the exact spike read SQL onto the
-- production public.kg_* tables and are the ONLY sanctioned readers of the
-- graph for those surfaces.
--
-- Security model (mirrors 012/014 search_conversations hardening, inverted):
--   * SECURITY INVOKER, so every access runs as the calling end user and RLS
--     (policies auth.uid() = user_id on kg_nodes/kg_edges/kg_conversations_processed
--     and conversations) is enforced on all of them — the belt.
--   * As suspenders, an explicit `user_id = auth.uid()` predicate is written on
--     every kg_edges access and on the root/target kg_nodes lookups. The nested
--     kg_nodes joins reached through those edges and the public.conversations
--     joins are covered by RLS alone (verified empirically: a foreign uuid and a
--     cross-user node id both return empty / null node). No search_user_id
--     argument exists, so there is nothing for a caller to spoof.
--   * search_path pinned to `public, pg_temp`.
--   * EXECUTE revoked from public/anon; granted only to `authenticated`, so each
--     call runs as the logged-in end user and can only ever see their own graph.
--
-- Table mapping vs the spike SQL: graph_spike.nodes -> public.kg_nodes,
-- graph_spike.edges -> public.kg_edges,
-- graph_spike.conversations_processed -> public.kg_conversations_processed.
-- Column names are identical; kg_* additionally carry `deleted_at`, filtered
-- `IS NULL` on every node/edge access. Census counts are cast ::text to match
-- the raw-pool bigint-as-string shape the pages consume.
--
-- NOTE (deviation from the spike SQL): production kg_edges can contain cyclic
-- `contains` chains (dirty extraction data — verified locally on the demo
-- graph). The spike subtree walks had no cycle guard and would recurse until
-- the backend OOM-crashed. Every unbounded `contains` recursion below carries
-- a SQL-standard `CYCLE ... SET ... USING path` clause so a repeated node
-- prunes that branch. Downstream aggregation is DISTINCT/Set-based, so the one
-- cycle-closing row a CYCLE clause emits is deduped and never double-counts.
--
-- ARCHIVE VISIBILITY (issue #60 phase 1, amended 2026-07-24): the edit path can
-- set status='archived' on a node. Semantics are "hidden from browse, reachable
-- directly, recoverable by undo". So the LISTING CTEs below exclude archived
-- nodes (`status is distinct from 'archived'` — keeps NULL/active): area_rows +
-- children + people_rows in kg_read_map, kids in kg_read_tree_node. The
-- recursive conv-count TRAVERSALS (sub / csub / subtree_convs / cvs / esub /
-- ksub / climb) are DELIBERATELY left unfiltered — they walk `contains` edges,
-- not node status, so an archived mid-tree Item never orphans its children nor
-- changes an area's conversation totals. A directly-fetched node in
-- kg_read_tree_node (nodes_sel) STAYS returned when archived so a deep link /
-- the inspector can still show and unarchive it; read.ts passes its status
-- through for the UI to badge.
-- ============================================================

-- ------------------------------------------------------------
-- kg_read_map(): one payload for the Map-of-you tile grid.
-- Returns raw row arrays; the 16-bucket sparkline, top-N children/people,
-- merge detection and per-area assembly happen in lib/kg/read.ts.
-- ------------------------------------------------------------
create or replace function public.kg_read_map()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive
  roots as (
    select id from public.kg_nodes
    where user_id = auth.uid() and type = 'LifeArea' and label != '_self' and deleted_at is null
  ),
  area_rows as (
    select id, label, props, status from public.kg_nodes
    where user_id = auth.uid() and type = 'LifeArea' and label != '_self' and deleted_at is null
      and status is distinct from 'archived'
  ),
  -- subtree walk over `contains` from every LifeArea root
  sub(root, node) as (
    select r.id, r.id from roots r
    union all
    select s.root, e.dst_id from public.kg_edges e join sub s on e.src_id = s.node
    where e.rel_type = 'contains' and e.user_id = auth.uid() and e.deleted_at is null
  ) cycle node set is_cycle using path,
  subtree_convs as (
    select s.root, c.id as conv_id, c.created_at as conv_date
    from sub s
    join public.kg_edges e on e.dst_id = s.node
      and e.rel_type in ('contributes_to', 'discusses') and e.user_id = auth.uid() and e.deleted_at is null
    join public.conversations c on c.id = e.source_conversation_id
  ),
  cvs as (
    select distinct s.root, e.source_conversation_id as cid
    from sub s
    join public.kg_edges e on e.dst_id = s.node
      and e.rel_type in ('contributes_to', 'discusses') and e.user_id = auth.uid() and e.deleted_at is null
      and e.source_conversation_id is not null
  ),
  people_rows as (
    select cvs.root as area_id, p.label, count(distinct cvs.cid)::int as links
    from cvs
    join public.kg_edges pe on pe.source_conversation_id = cvs.cid and pe.user_id = auth.uid() and pe.deleted_at is null
    join public.kg_nodes p on p.id = pe.src_id or p.id = pe.dst_id
    where p.type = 'Person' and p.label != '_self' and p.deleted_at is null
      and p.status is distinct from 'archived'
    group by cvs.root, p.label
  ),
  -- direct child Items with their own subtree conversation rollup
  children as (
    select e.src_id as area_id, n.id as child_id, n.label, n.kind
    from public.kg_edges e
    join roots r on r.id = e.src_id
    join public.kg_nodes n on n.id = e.dst_id
    where e.rel_type = 'contains' and e.user_id = auth.uid() and e.deleted_at is null
      and n.type = 'Item' and n.deleted_at is null and n.status is distinct from 'archived'
  ),
  csub(top, node) as (
    select c.child_id, c.child_id from children c
    union all
    select s.top, e.dst_id from public.kg_edges e join csub s on e.src_id = s.node
    where e.rel_type = 'contains' and e.user_id = auth.uid() and e.deleted_at is null
  ) cycle node set is_cycle using path,
  child_rows as (
    select ch.area_id, ch.child_id, ch.label, ch.kind,
           count(distinct e.source_conversation_id)::int as convs
    from children ch
    join csub s on s.top = ch.child_id
    left join public.kg_edges e on e.dst_id = s.node
      and e.rel_type in ('contributes_to', 'discusses') and e.user_id = auth.uid() and e.deleted_at is null
    group by ch.area_id, ch.child_id, ch.label, ch.kind
  ),
  census as (
    select
      (count(*) filter (where type = 'LifeArea' and label != '_self'))::text as life_areas,
      (count(*) filter (where type = 'Item'))::text                          as items,
      (count(*) filter (where type = 'Conversation'))::text                  as conversations,
      (count(*) filter (where type in ('Person', 'Tool', 'Organization', 'Artifact') and label != '_self'))::text as entities
    from public.kg_nodes where user_id = auth.uid() and deleted_at is null
  )
  select jsonb_build_object(
    'area_rows', coalesce((select jsonb_agg(to_jsonb(a)) from area_rows a), '[]'::jsonb),
    'subtree_convs', coalesce((select jsonb_agg(to_jsonb(s)) from subtree_convs s), '[]'::jsonb),
    'child_rows', coalesce((select jsonb_agg(to_jsonb(c)) from child_rows c), '[]'::jsonb),
    'people_rows', coalesce((select jsonb_agg(to_jsonb(p)) from people_rows p), '[]'::jsonb),
    'census', coalesce((select to_jsonb(x) from census x), '{}'::jsonb)
  );
$$;

-- ------------------------------------------------------------
-- kg_read_pulse(): census + recent conversations with canonical area.
-- ------------------------------------------------------------
create or replace function public.kg_read_pulse()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive
  attach as (
    -- conv_date stays timestamptz through the climb so the final to_jsonb emits
    -- ISO-8601 'T' form (matches kg_read_map); a ::text cast here would emit the
    -- space-separated form some strict Date parsers (Safari) reject.
    select distinct on (c.id)
           c.id as conv_id, c.title, c.source, c.created_at as conv_date, e.dst_id as node_id
    from public.conversations c
    left join public.kg_edges e on e.source_conversation_id = c.id
      and e.rel_type in ('contributes_to', 'discusses') and e.user_id = auth.uid() and e.deleted_at is null
    where c.user_id = auth.uid()
    order by c.id, c.created_at desc
  ),
  climb as (
    select a.conv_id, a.title, a.source, a.conv_date, a.node_id as cur, a.node_id, 0 as depth
    from attach a
    union all
    select cl.conv_id, cl.title, cl.source, cl.conv_date, pe.src_id, cl.node_id, cl.depth + 1
    from climb cl
    join public.kg_edges pe on pe.dst_id = cl.cur and pe.rel_type = 'contains'
      and pe.user_id = auth.uid() and pe.deleted_at is null
    where cl.depth < 8
  ),
  recent_rows as (
    select distinct on (cl.conv_id)
           cl.conv_id, cl.title, cl.source, cl.conv_date,
           la.id as area_id, la.label as area_label
    from climb cl
    left join public.kg_nodes la on la.id = cl.cur and la.type = 'LifeArea' and la.deleted_at is null
    order by cl.conv_id, (la.id is not null) desc, cl.depth desc
  ),
  census as (
    select
      (count(*) filter (where type = 'LifeArea' and label != '_self'))::text as life_areas,
      (count(*) filter (where type = 'Conversation'))::text                  as conversations,
      (count(*) filter (where type in ('Person', 'Tool', 'Organization', 'Artifact') and label != '_self'))::text as entities,
      min(props->>'identity_line') filter (where label = '_self')            as identity_line
    from public.kg_nodes where user_id = auth.uid() and deleted_at is null
  )
  select jsonb_build_object(
    'census', coalesce((select to_jsonb(x) from census x), '{}'::jsonb),
    'recent_rows', coalesce((select jsonb_agg(to_jsonb(r)) from recent_rows r), '[]'::jsonb)
  );
$$;

-- ------------------------------------------------------------
-- kg_read_tree_node(p_node_id): detail for one block/area — the node, the
-- conversations attached directly, entities anywhere in its subtree, and the
-- direct child Items with their own rollup.
-- ------------------------------------------------------------
create or replace function public.kg_read_tree_node(p_node_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive
  nodes_sel as (
    select id, type::text as type, kind, label, props, status
    from public.kg_nodes
    where user_id = auth.uid() and id = p_node_id and deleted_at is null
  ),
  conv_rows as (
    select c.id, c.title, c.created_at as conv_occurred_at, e.rel_type,
           cp.pass1_result->>'central_topic' as central_topic
    from public.kg_edges e
    join public.conversations c on c.id = e.source_conversation_id
    left join public.kg_conversations_processed cp on cp.conversation_id = c.id
    where e.user_id = auth.uid() and e.dst_id = p_node_id
      and e.rel_type in ('contributes_to', 'discusses') and e.deleted_at is null
    order by c.created_at desc
    limit 80
  ),
  esub(id) as (
    select p_node_id
    union all
    select e.dst_id from public.kg_edges e join esub on e.src_id = esub.id
    where e.rel_type = 'contains' and e.user_id = auth.uid() and e.deleted_at is null
  ) cycle id set is_cycle using path,
  ecvs as (
    select distinct e.source_conversation_id as cid
    from public.kg_edges e
    where e.user_id = auth.uid() and e.dst_id in (select id from esub)
      and e.rel_type in ('contributes_to', 'discusses') and e.source_conversation_id is not null
      and e.deleted_at is null
  ),
  entity_rows as (
    select n.id, n.type::text as type, n.kind, n.label,
           count(distinct e.source_conversation_id)::int as convs
    from public.kg_edges e
    join public.kg_nodes n on (n.id = e.src_id or n.id = e.dst_id)
    where e.user_id = auth.uid() and e.source_conversation_id in (select cid from ecvs)
      and n.type in ('Person', 'Tool', 'Organization', 'Artifact') and n.label != '_self'
      and e.deleted_at is null and n.deleted_at is null
    group by n.id, n.type, n.kind, n.label
    order by convs desc, n.type, n.label
    limit 120
  ),
  kids as (
    select e.dst_id as child_id, n.label, n.kind
    from public.kg_edges e
    join public.kg_nodes n on n.id = e.dst_id
    where e.user_id = auth.uid() and e.src_id = p_node_id and e.rel_type = 'contains'
      and n.type = 'Item' and e.deleted_at is null and n.deleted_at is null
      and n.status is distinct from 'archived'
  ),
  ksub(top, node) as (
    select k.child_id, k.child_id from kids k
    union all
    select s.top, e.dst_id from public.kg_edges e join ksub s on e.src_id = s.node
    where e.rel_type = 'contains' and e.user_id = auth.uid() and e.deleted_at is null
  ) cycle node set is_cycle using path,
  child_rows as (
    select k.child_id as id, k.label, k.kind,
           count(distinct e.source_conversation_id)::int as convs
    from kids k
    join ksub s on s.top = k.child_id
    left join public.kg_edges e on e.dst_id = s.node
      and e.rel_type in ('contributes_to', 'discusses') and e.user_id = auth.uid() and e.deleted_at is null
    group by k.child_id, k.label, k.kind
    order by convs desc
  )
  select jsonb_build_object(
    'node', (select to_jsonb(x) from nodes_sel x limit 1),
    'conv_rows', coalesce((select jsonb_agg(to_jsonb(r) order by r.conv_occurred_at desc nulls last) from conv_rows r), '[]'::jsonb),
    'entity_rows', coalesce((select jsonb_agg(to_jsonb(r) order by r.convs desc, r.type, r.label) from entity_rows r), '[]'::jsonb),
    'child_rows', coalesce((select jsonb_agg(to_jsonb(r) order by r.convs desc) from child_rows r), '[]'::jsonb)
  );
$$;

-- ------------------------------------------------------------
-- kg_read_node_sources(p_node_id): provenance for the inspector's "Sources —
-- placed here because of these conversations" panel. Pools the conversations
-- from edges touching the node AND the node's own source_conversation_id (nodes
-- the LLM emitted without an anchoring edge). No recursion -> no cycle guard.
-- ------------------------------------------------------------
create or replace function public.kg_read_node_sources(p_node_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with edge_sources as (
    select e.source_conversation_id as conversation_id,
           count(*) filter (where e.src_id = p_node_id)::int as outgoing_edge_count,
           count(*) filter (where e.dst_id = p_node_id)::int as incoming_edge_count,
           array_agg(distinct e.rel_type::text order by e.rel_type::text) as rel_types
    from public.kg_edges e
    where e.user_id = auth.uid() and (e.src_id = p_node_id or e.dst_id = p_node_id)
      and e.source_conversation_id is not null and e.deleted_at is null
    group by e.source_conversation_id
  ),
  node_source as (
    select n.source_conversation_id as conversation_id
    from public.kg_nodes n
    where n.user_id = auth.uid() and n.id = p_node_id
      and n.source_conversation_id is not null and n.deleted_at is null
  ),
  all_conv_ids as (
    select conversation_id from edge_sources
    union
    select conversation_id from node_source
  ),
  source_rows as (
    select c.id as conversation_id, c.title, c.source, c.created_at as conv_occurred_at,
           coalesce(es.outgoing_edge_count, 0) as outgoing_edge_count,
           coalesce(es.incoming_edge_count, 0) as incoming_edge_count,
           coalesce(es.rel_types, array[]::text[]) as rel_types
    from all_conv_ids a
    join public.conversations c on c.id = a.conversation_id
    left join edge_sources es on es.conversation_id = a.conversation_id
    order by c.created_at desc
    limit 50
  )
  select jsonb_build_object(
    'source_conversations',
    coalesce((select jsonb_agg(to_jsonb(r) order by r.conv_occurred_at desc nulls last) from source_rows r), '[]'::jsonb)
  );
$$;

-- ------------------------------------------------------------
-- Lock down execution: only logged-in end users, invoking as themselves.
-- ------------------------------------------------------------
revoke all on function public.kg_read_map() from public;
revoke all on function public.kg_read_map() from anon;
grant execute on function public.kg_read_map() to authenticated;

revoke all on function public.kg_read_pulse() from public;
revoke all on function public.kg_read_pulse() from anon;
grant execute on function public.kg_read_pulse() to authenticated;

revoke all on function public.kg_read_tree_node(uuid) from public;
revoke all on function public.kg_read_tree_node(uuid) from anon;
grant execute on function public.kg_read_tree_node(uuid) to authenticated;

revoke all on function public.kg_read_node_sources(uuid) from public;
revoke all on function public.kg_read_node_sources(uuid) from anon;
grant execute on function public.kg_read_node_sources(uuid) to authenticated;
