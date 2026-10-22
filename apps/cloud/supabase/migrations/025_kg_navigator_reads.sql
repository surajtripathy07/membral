-- ============================================================
-- 025_kg_navigator_reads.sql
-- Read-path RPCs for the Second Brain navigator (GitHub issue #59, phase 1 —
-- the persistent tree-rail + real breadcrumb; ADR 0018 candidate E, built
-- A-first).
--
-- Two functions, both pure reads over the production public.kg_* graph:
--   * kg_read_path(p_node_id)     — the SINGLE canonical contains path root->node
--                                   that backs the breadcrumb (replaces the fake
--                                   two-segment "You > area" crumb).
--   * kg_read_children(p_parent_id default null) — one level of the LifeArea >
--                                   Item tree for the rail, LAZILY: pass null for
--                                   the root LifeAreas, or a node id for its
--                                   direct children. Each child carries a subtree
--                                   conversation rollup, last_touched (recency),
--                                   and a has_children flag so the rail can render
--                                   an expand chevron without a second probe.
--
-- Why lazy children, not a one-shot kg_read_full_tree(): ADR 0018 §4.3 floated
-- fetching the whole outline in one call "while graphs stay <= ~1-2k nodes", but
-- the founder-1k fixture already carries 1000+ nodes, and the navigator brief is
-- explicit that the rail must lazy-expand at that scale. So the tree is walked
-- one level per expand — the rail never eagerly materialises the whole graph.
-- kg_read_full_tree() is intentionally NOT added (it would be dead + would invite
-- the eager path we are avoiding); if a future surface truly needs the whole
-- outline it can page kg_read_children breadth-first.
--
-- Security model — identical to migration 015's read RPCs (the sanctioned graph
-- readers for these surfaces):
--   * SECURITY INVOKER, so every access runs as the calling end user and RLS
--     (auth.uid() = user_id on kg_nodes / kg_edges) is enforced — the belt.
--   * As suspenders, an explicit `user_id = auth.uid()` predicate is written on
--     every kg_nodes / kg_edges access. No p_user_id argument exists, so there is
--     nothing for a caller to spoof.
--   * search_path pinned to `public, pg_temp`.
--   * EXECUTE revoked from public/anon; granted only to `authenticated`.
--
-- contains-edge filtering (deviation from migration 015): 015 filtered only
-- `deleted_at is null` on its walks. Since migration 018 shipped, a user MOVE
-- EXPIRES the old contains edge (`expired_at = now()`, NOT deleted_at — see
-- 018 kg_edit_move / kg_edit_merge). A moved node therefore still has a stale,
-- expired contains edge to its old parent. To keep the canonical path and the
-- child lists correct after edits, EVERY contains traversal below filters BOTH
-- `deleted_at is null AND expired_at is null`. This is the same live-edge
-- predicate lib/kg/read.ts's getEditTargetsPayload already uses.
--
-- Single-parent invariant: dirty extraction data can still carry more than one
-- live contains edge into a node (018's invariant is enforced going forward, not
-- retroactively). kg_read_path resolves ONE canonical parent per node up front
-- (earliest-created live contains edge wins, tie-broken by src_id) so the climb
-- is strictly linear and yields exactly one path — never a branch. A standard
-- SQL CYCLE clause guards the (possible) cyclic dirty data.
-- ============================================================

-- ------------------------------------------------------------
-- kg_read_path(p_node_id): canonical contains chain root -> node.
-- Returns { path: [ {id,label,type,kind}, ... ] } ordered from the LifeArea root
-- down to p_node_id (inclusive). Empty path for a missing / foreign / deleted
-- node (RLS + the auth.uid() predicate make a cross-user id resolve to nothing).
-- ------------------------------------------------------------
create or replace function public.kg_read_path(p_node_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive
  -- One canonical live contains-parent per node: earliest edge wins so the
  -- chosen parent is stable across calls even when dirty data has several.
  parent_of as (
    select distinct on (e.dst_id) e.dst_id as node_id, e.src_id as parent_id
    from public.kg_edges e
    where e.rel_type = 'contains' and e.user_id = auth.uid()
      and e.deleted_at is null and e.expired_at is null
    order by e.dst_id, e.created_at asc nulls last, e.src_id
  ),
  -- Climb from the target up through canonical parents. Seed only if the node
  -- itself is a live, own-graph node (foreign/deleted -> no seed -> empty path).
  climb(node_id, depth) as (
    select n.id, 0
    from public.kg_nodes n
    where n.id = p_node_id and n.user_id = auth.uid() and n.deleted_at is null
    union all
    select po.parent_id, c.depth + 1
    from climb c
    join parent_of po on po.node_id = c.node_id
  ) cycle node_id set is_cycle using path,
  path_rows as (
    select c.depth, n.id, n.label, n.type::text as type, n.kind
    from climb c
    join public.kg_nodes n on n.id = c.node_id
      and n.user_id = auth.uid() and n.deleted_at is null
  )
  select jsonb_build_object(
    'path',
    coalesce(
      (select jsonb_agg(
                jsonb_build_object('id', p.id, 'label', p.label, 'type', p.type, 'kind', p.kind)
                order by p.depth desc)
       from path_rows p),
      '[]'::jsonb)
  );
$$;

-- ------------------------------------------------------------
-- kg_read_children(p_parent_id default null): one lazy level of the LifeArea >
-- Item tree for the rail.
--   * p_parent_id IS NULL -> the ROOT LifeAreas (type='LifeArea', no live
--     contains-parent) — the rail's initial render.
--   * p_parent_id given   -> the direct live contains-children (LifeArea or
--     Item) of that node — one expand.
-- Archived / '_self' / deleted nodes are excluded from the listing (same
-- browse-visibility rule as migration 015). Each returned child carries:
--   convs        — DISTINCT conversations anywhere in the child's own contains
--                  subtree (matches 015's child_rows rollup),
--   last_touched — the most recent such conversation's date (recency sort axis
--                  + the "last 90 days" temporal filter; timestamptz so to_jsonb
--                  emits ISO-8601, per 015's pulse note),
--   has_children — whether the child has its own visible contains-children, so
--                  the rail draws an expand chevron without a probing round trip.
-- Default order is recency (last_touched desc), then convs desc, then label.
-- ------------------------------------------------------------
create or replace function public.kg_read_children(p_parent_id uuid default null)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive
  kids as (
    select n.id as child_id, n.label, n.type::text as type, n.kind, n.status
    from public.kg_nodes n
    where n.user_id = auth.uid() and n.deleted_at is null
      and n.type in ('LifeArea', 'Item') and n.label != '_self'
      and n.status is distinct from 'archived'
      and (
        case
          when p_parent_id is null then
            -- roots: LifeAreas with no live contains-parent
            n.type = 'LifeArea' and not exists (
              select 1 from public.kg_edges e
              where e.rel_type = 'contains' and e.dst_id = n.id
                and e.user_id = auth.uid() and e.deleted_at is null and e.expired_at is null
            )
          else
            exists (
              select 1 from public.kg_edges e
              where e.rel_type = 'contains' and e.src_id = p_parent_id and e.dst_id = n.id
                and e.user_id = auth.uid() and e.deleted_at is null and e.expired_at is null
            )
        end
      )
  ),
  -- subtree walk from every child for its conversation rollup
  ksub(top, node) as (
    select k.child_id, k.child_id from kids k
    union all
    select s.top, e.dst_id from public.kg_edges e join ksub s on e.src_id = s.node
    where e.rel_type = 'contains' and e.user_id = auth.uid()
      and e.deleted_at is null and e.expired_at is null
  ) cycle node set is_cycle using path,
  rollup as (
    select k.child_id,
           count(distinct e.source_conversation_id)::int as convs,
           max(c.created_at) as last_touched
    from kids k
    join ksub s on s.top = k.child_id
    left join public.kg_edges e on e.dst_id = s.node
      and e.rel_type in ('contributes_to', 'discusses') and e.user_id = auth.uid()
      and e.deleted_at is null and e.expired_at is null
    left join public.conversations c on c.id = e.source_conversation_id
    group by k.child_id
  ),
  haskids as (
    select k.child_id,
           exists (
             select 1
             from public.kg_edges e
             join public.kg_nodes cn on cn.id = e.dst_id
             where e.rel_type = 'contains' and e.src_id = k.child_id
               and e.user_id = auth.uid() and e.deleted_at is null and e.expired_at is null
               and cn.type in ('LifeArea', 'Item') and cn.deleted_at is null
               and cn.status is distinct from 'archived' and cn.label != '_self'
           ) as has_children
    from kids k
  ),
  child_rows as (
    select k.child_id as id, k.label, k.type, k.kind, k.status,
           coalesce(r.convs, 0) as convs, r.last_touched,
           coalesce(h.has_children, false) as has_children
    from kids k
    left join rollup r on r.child_id = k.child_id
    left join haskids h on h.child_id = k.child_id
  )
  select jsonb_build_object(
    'children',
    coalesce(
      (select jsonb_agg(to_jsonb(cr) order by cr.last_touched desc nulls last, cr.convs desc, cr.label)
       from child_rows cr),
      '[]'::jsonb)
  );
$$;

-- ------------------------------------------------------------
-- Lock down execution: only logged-in end users, invoking as themselves.
-- ------------------------------------------------------------
revoke all on function public.kg_read_path(uuid) from public;
revoke all on function public.kg_read_path(uuid) from anon;
grant execute on function public.kg_read_path(uuid) to authenticated;

revoke all on function public.kg_read_children(uuid) from public;
revoke all on function public.kg_read_children(uuid) from anon;
grant execute on function public.kg_read_children(uuid) to authenticated;
