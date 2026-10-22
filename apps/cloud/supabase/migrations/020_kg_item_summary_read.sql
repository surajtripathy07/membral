-- ============================================================
-- 020_kg_item_summary_read.sql
-- Expose each Item's props.summary (issue #81 — portrait synthesis now
-- writes a 1-3 sentence written summary per Item, same as it already does
-- for LifeAreas) through kg_read_tree_node's child_rows, so the area-page
-- child cards (map/[areaId]/page.tsx) and the inspector's "Inside" list can
-- render a one-liner without an extra round trip. The inspector's PRIMARY
-- summary display (for whichever node is open) already gets props.summary
-- for free — nodes_sel below has always selected the entire props column.
--
-- CREATE OR REPLACE of the migration-015 function: only the `kids` and
-- `child_rows` CTEs change (add `summary`); everything else is byte-identical
-- to 015 so this migration carries no other behavior change.
-- ============================================================

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
    -- summary added (issue #81): props->>'summary' set by lib/kg/portrait.ts's
    -- item-summary batch call, same merge/locked_fields rules as LifeArea.summary.
    select e.dst_id as child_id, n.label, n.kind, n.props->>'summary' as summary
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
    select k.child_id as id, k.label, k.kind, k.summary,
           count(distinct e.source_conversation_id)::int as convs
    from kids k
    join ksub s on s.top = k.child_id
    left join public.kg_edges e on e.dst_id = s.node
      and e.rel_type in ('contributes_to', 'discusses') and e.user_id = auth.uid() and e.deleted_at is null
    group by k.child_id, k.label, k.kind, k.summary
    order by convs desc
  )
  select jsonb_build_object(
    'node', (select to_jsonb(x) from nodes_sel x limit 1),
    'conv_rows', coalesce((select jsonb_agg(to_jsonb(r) order by r.conv_occurred_at desc nulls last) from conv_rows r), '[]'::jsonb),
    'entity_rows', coalesce((select jsonb_agg(to_jsonb(r) order by r.convs desc, r.type, r.label) from entity_rows r), '[]'::jsonb),
    'child_rows', coalesce((select jsonb_agg(to_jsonb(r) order by r.convs desc) from child_rows r), '[]'::jsonb)
  );
$$;

-- Re-grant (create or replace preserves existing grants, this is belt-and-suspenders
-- consistent with how 015 originally locked this function down).
revoke all on function public.kg_read_tree_node(uuid) from public;
revoke all on function public.kg_read_tree_node(uuid) from anon;
grant execute on function public.kg_read_tree_node(uuid) to authenticated;
