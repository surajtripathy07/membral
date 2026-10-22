-- ============================================================
-- 023_kg_people_rpcs.sql
-- People as a first-class graph dimension (GitHub issue #78).
--
-- A READ PROJECTION + curation layer over the EXISTING graph — NO new store.
-- People are already public.kg_nodes.type='Person'; they attach to conversations
-- through live edges (Conversation --mentions_person--> Person, and any other
-- edge carrying source_conversation_id). Every read here is a projection over
-- kg_nodes / kg_edges / conversations; every write reuses the migration-018
-- history + undo machinery (issue #60).
--
-- SECURITY MODEL (the migration-015 / 018 pattern):
--   * SECURITY INVOKER, so each call runs as the logged-in end user and RLS
--     (auth.uid() = user_id on kg_nodes / kg_edges / conversations /
--     kg_conversations_processed / kg_node_history) is enforced — the belt.
--   * Every kg_edges / kg_nodes access additionally carries an explicit
--     `user_id = auth.uid()` predicate as suspenders; no caller-supplied user id
--     exists to spoof.
--   * search_path pinned to `public, pg_temp`.
--   * EXECUTE revoked from public/anon, granted only to `authenticated`.
--
-- CYCLE GUARD: like migration 015, the `contains` climb from a conversation up to
-- its LifeArea carries a SQL-standard CYCLE clause — production `contains` chains
-- can be cyclic (dirty extraction data) and would otherwise recurse unbounded.
-- Downstream aggregation is DISTINCT/set-based, so the one cycle-closing row is
-- deduped and never double-counts.
--
-- ARCHIVE = EXCLUDE (issue #78 "exclude false-positive people"): Pass-1 person
-- extraction has known noise ("user", "current_user", …). Excluding a person
-- REUSES kg_edit_archive (status='archived') — no new exclude flag: archive is
-- already "hidden from browse, reachable by deep link, reversible by undo".
-- The LISTING / co-occurrence / area CTEs below drop archived Person nodes
-- (`status is distinct from 'archived'`); kg_person_detail STILL returns an
-- archived person so a deep link can show + unexclude it (mirrors 015 nodes_sel).
--
-- "THIS IS ME" (issue #78 + #76 seam): kg_person_set_identity stores a reversible
-- boolean on the Person node's props (`is_user_identity`) + a kg_node_history
-- snapshot. It is a TOGGLE (call again with false to clear) rather than a
-- kg_edit_ops op, deliberately: migration-018 kg_edit_undo only knows how to
-- reverse rename/move/merge/archive/lock and RAISEs on an unknown op, so pushing
-- an 'identity' op would break the shared undo stack. #76 (automated
-- entity-resolution + deterministic user-identity from the profile) is the
-- coordination seam: when it lands it should READ/WRITE this same
-- props.is_user_identity flag rather than a parallel store. This issue does NOT
-- build the automated resolver.
--
-- MERGE: this migration widens kg_edit_merge (migration 018) to also accept
-- Person↔Person merges. All the re-point / history / undo machinery is already
-- type-agnostic — it re-points EVERY live edge regardless of rel_type, so
-- mentions_person / collaborates_with re-point onto the survivor automatically,
-- source label+aliases fold into the survivor's aliases, and kg_edit_undo (op
-- 'merge') reverses it unchanged. Only the type gate needed opening.
--
-- Apply: `npx supabase migration up` from apps/cloud.
-- ============================================================

-- ------------------------------------------------------------
-- kg_people_list(p_limit, p_offset, p_sort): paginated Person roster with
-- frequency (distinct conversations), recency (latest conversation), and
-- provenance (distinct LifeAreas the person's conversations roll up to).
-- p_sort ∈ frequency | recency | name (falls back to frequency then label).
-- ------------------------------------------------------------
create or replace function public.kg_people_list(
  p_limit int default 60,
  p_offset int default 0,
  p_sort text default 'frequency'
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive
  -- (person_id, conv_id): a Person appears in a conversation via ANY live edge
  -- touching it that carries a source_conversation_id (mentions_person etc.).
  person_convs as (
    select distinct n.id as person_id, e.source_conversation_id as conv_id
    from public.kg_nodes n
    join public.kg_edges e on (e.src_id = n.id or e.dst_id = n.id)
      and e.user_id = auth.uid() and e.deleted_at is null
      and e.source_conversation_id is not null
    where n.user_id = auth.uid() and n.type = 'Person' and n.label != '_self'
      and n.deleted_at is null and n.status is distinct from 'archived'
  ),
  -- conversation -> its directly attached tree node (contributes_to / discusses)
  conv_node as (
    select distinct e.source_conversation_id as conv_id, e.dst_id as node_id
    from public.kg_edges e
    where e.user_id = auth.uid() and e.deleted_at is null
      and e.rel_type in ('contributes_to', 'discusses')
      and e.source_conversation_id in (select conv_id from person_convs)
  ),
  -- climb `contains` from the attached node up toward a LifeArea root
  climb(conv_id, cur, depth) as (
    select conv_id, node_id, 0 from conv_node
    union all
    select cl.conv_id, pe.src_id, cl.depth + 1
    from climb cl
    join public.kg_edges pe on pe.dst_id = cl.cur and pe.rel_type = 'contains'
      and pe.user_id = auth.uid() and pe.deleted_at is null
    where cl.depth < 8
  ) cycle cur set is_cycle using path,
  conv_area as (
    select distinct cl.conv_id, la.id as area_id
    from climb cl
    join public.kg_nodes la on la.id = cl.cur and la.type = 'LifeArea' and la.deleted_at is null
  ),
  person_stats as (
    select pc.person_id,
           count(distinct pc.conv_id)::int as conv_count,
           count(distinct ca.area_id)::int as area_count,
           max(c.created_at) as last_conv_at
    from person_convs pc
    left join public.conversations c on c.id = pc.conv_id
    left join conv_area ca on ca.conv_id = pc.conv_id
    group by pc.person_id
  ),
  rows as (
    select n.id as person_id, n.label, coalesce(n.aliases, '{}') as aliases,
           coalesce((n.props->>'is_user_identity')::boolean, false) as is_self,
           coalesce(ps.conv_count, 0) as conv_count,
           coalesce(ps.area_count, 0) as area_count,
           ps.last_conv_at
    from public.kg_nodes n
    left join person_stats ps on ps.person_id = n.id
    where n.user_id = auth.uid() and n.type = 'Person' and n.label != '_self'
      and n.deleted_at is null and n.status is distinct from 'archived'
  ),
  page as (
    select person_id, label, aliases, is_self, conv_count, area_count, last_conv_at
    from rows
    order by
      (case when p_sort = 'recency'   then extract(epoch from last_conv_at) end) desc nulls last,
      (case when p_sort = 'name'      then lower(label) end) asc nulls last,
      (case when p_sort = 'frequency' then conv_count end) desc nulls last,
      conv_count desc, lower(label) asc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'total', (select count(*) from rows),
    'people', coalesce((select jsonb_agg(to_jsonb(p)) from page p), '[]'::jsonb)
  );
$$;

-- ------------------------------------------------------------
-- kg_person_detail(p_person_id): one Person's full profile — appearances
-- (areas + conversations), co-occurring people (shared conversations),
-- topics discussed, recency, and incoming/outgoing edges. An archived
-- (excluded) person is STILL returned here so a deep link can unexclude it.
-- ------------------------------------------------------------
create or replace function public.kg_person_detail(p_person_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive
  me as (
    select id, label, coalesce(aliases, '{}') as aliases, status,
           coalesce((props->>'is_user_identity')::boolean, false) as is_self
    from public.kg_nodes
    where id = p_person_id and user_id = auth.uid()
      and type = 'Person' and deleted_at is null
  ),
  my_convs as (
    select distinct e.source_conversation_id as conv_id
    from public.kg_edges e
    where e.user_id = auth.uid() and e.deleted_at is null
      and e.source_conversation_id is not null
      and (e.src_id = p_person_id or e.dst_id = p_person_id)
  ),
  conv_node as (
    select distinct e.source_conversation_id as conv_id, e.dst_id as node_id
    from public.kg_edges e
    where e.user_id = auth.uid() and e.deleted_at is null
      and e.rel_type in ('contributes_to', 'discusses')
      and e.source_conversation_id in (select conv_id from my_convs)
  ),
  climb(conv_id, cur, depth) as (
    select conv_id, node_id, 0 from conv_node
    union all
    select cl.conv_id, pe.src_id, cl.depth + 1
    from climb cl
    join public.kg_edges pe on pe.dst_id = cl.cur and pe.rel_type = 'contains'
      and pe.user_id = auth.uid() and pe.deleted_at is null
    where cl.depth < 8
  ) cycle cur set is_cycle using path,
  conv_area as (
    select distinct cl.conv_id, la.id as area_id, la.label as area_label
    from climb cl
    join public.kg_nodes la on la.id = cl.cur and la.type = 'LifeArea' and la.deleted_at is null
  ),
  area_rows as (
    select ca.area_id, ca.area_label, count(distinct ca.conv_id)::int as convs
    from conv_area ca
    group by ca.area_id, ca.area_label
  ),
  conv_rows as (
    select c.id as conv_id, c.title, c.source, c.created_at as conv_date
    from public.conversations c
    where c.user_id = auth.uid() and c.id in (select conv_id from my_convs)
    order by c.created_at desc
    limit 60
  ),
  cooccur as (
    select p.id as person_id, p.label,
           count(distinct e.source_conversation_id)::int as shared_convs
    from public.kg_edges e
    join public.kg_nodes p on (p.id = e.src_id or p.id = e.dst_id)
    where e.user_id = auth.uid() and e.deleted_at is null
      and e.source_conversation_id in (select conv_id from my_convs)
      and p.type = 'Person' and p.id <> p_person_id and p.label != '_self'
      and p.deleted_at is null and p.status is distinct from 'archived'
    group by p.id, p.label
    order by shared_convs desc, lower(p.label)
    limit 40
  ),
  topic_rows as (
    select cp.pass1_result->>'central_topic' as topic, count(*)::int as convs
    from public.kg_conversations_processed cp
    where cp.user_id = auth.uid()
      and cp.conversation_id in (select conv_id from my_convs)
      and coalesce(btrim(cp.pass1_result->>'central_topic'), '') <> ''
    group by topic
    order by convs desc
    limit 20
  ),
  edge_rows as (
    select e.rel_type::text as rel_type,
           case when e.src_id = p_person_id then 'out' else 'in' end as dir,
           o.id as other_id, o.type::text as other_type, o.label as other_label,
           count(*)::int as n
    from public.kg_edges e
    join public.kg_nodes o
      on o.id = case when e.src_id = p_person_id then e.dst_id else e.src_id end
    where e.user_id = auth.uid() and e.deleted_at is null
      and (e.src_id = p_person_id or e.dst_id = p_person_id)
      and o.deleted_at is null and o.type <> 'Conversation'
    group by e.rel_type, dir, o.id, o.type, o.label
    order by n desc, o.label
    limit 60
  )
  select jsonb_build_object(
    'person', (select to_jsonb(m) from me m),
    'conv_count', (select count(*)::int from my_convs),
    'area_count', (select count(*)::int from area_rows),
    'last_conv_at', (select max(created_at) from public.conversations
                     where user_id = auth.uid() and id in (select conv_id from my_convs)),
    'first_conv_at', (select min(created_at) from public.conversations
                      where user_id = auth.uid() and id in (select conv_id from my_convs)),
    'areas', coalesce((select jsonb_agg(to_jsonb(a) order by a.convs desc, a.area_label) from area_rows a), '[]'::jsonb),
    'conversations', coalesce((select jsonb_agg(to_jsonb(r) order by r.conv_date desc nulls last) from conv_rows r), '[]'::jsonb),
    'cooccurring', coalesce((select jsonb_agg(to_jsonb(c)) from cooccur c), '[]'::jsonb),
    'topics', coalesce((select jsonb_agg(to_jsonb(t)) from topic_rows t), '[]'::jsonb),
    'edges', coalesce((select jsonb_agg(to_jsonb(x)) from edge_rows x), '[]'::jsonb)
  );
$$;

-- ------------------------------------------------------------
-- kg_people_scope(p_person_id): the person-scoped projection — the areas,
-- items and conversations that involve this person. Powers "Show me everything
-- with Sarah" (filter the map/tree/pulse to a person). Paginated conversations.
-- ------------------------------------------------------------
create or replace function public.kg_people_scope(
  p_person_id uuid,
  p_limit int default 100,
  p_offset int default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with recursive
  my_convs as (
    select distinct e.source_conversation_id as conv_id
    from public.kg_edges e
    where e.user_id = auth.uid() and e.deleted_at is null
      and e.source_conversation_id is not null
      and (e.src_id = p_person_id or e.dst_id = p_person_id)
  ),
  conv_node as (
    select distinct e.source_conversation_id as conv_id, e.dst_id as node_id
    from public.kg_edges e
    where e.user_id = auth.uid() and e.deleted_at is null
      and e.rel_type in ('contributes_to', 'discusses')
      and e.source_conversation_id in (select conv_id from my_convs)
  ),
  climb(conv_id, cur, depth) as (
    select conv_id, node_id, 0 from conv_node
    union all
    select cl.conv_id, pe.src_id, cl.depth + 1
    from climb cl
    join public.kg_edges pe on pe.dst_id = cl.cur and pe.rel_type = 'contains'
      and pe.user_id = auth.uid() and pe.deleted_at is null
    where cl.depth < 8
  ) cycle cur set is_cycle using path,
  conv_area as (
    select distinct cl.conv_id, la.id as area_id, la.label as area_label
    from climb cl
    join public.kg_nodes la on la.id = cl.cur and la.type = 'LifeArea' and la.deleted_at is null
  ),
  area_rows as (
    select ca.area_id as id, ca.area_label as label, count(distinct ca.conv_id)::int as convs
    from conv_area ca
    group by ca.area_id, ca.area_label
    order by convs desc
  ),
  item_rows as (
    select n.id, n.kind, n.label, count(distinct cn.conv_id)::int as convs
    from conv_node cn
    join public.kg_nodes n on n.id = cn.node_id
      and n.type = 'Item' and n.deleted_at is null and n.status is distinct from 'archived'
    group by n.id, n.kind, n.label
    order by convs desc
    limit 80
  ),
  conv_rows as (
    select c.id as conv_id, c.title, c.source, c.created_at as conv_date
    from public.conversations c
    where c.user_id = auth.uid() and c.id in (select conv_id from my_convs)
    order by c.created_at desc
    limit greatest(p_limit, 0) offset greatest(p_offset, 0)
  )
  select jsonb_build_object(
    'conv_total', (select count(*)::int from my_convs),
    'areas', coalesce((select jsonb_agg(to_jsonb(a)) from area_rows a), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(to_jsonb(i)) from item_rows i), '[]'::jsonb),
    'conversations', coalesce((select jsonb_agg(to_jsonb(r) order by r.conv_date desc nulls last) from conv_rows r), '[]'::jsonb)
  );
$$;

-- ------------------------------------------------------------
-- kg_person_set_identity(p_node_id, p_is_self): mark / unmark a Person as the
-- user ("this is me"). Reversible TOGGLE stored on props.is_user_identity with a
-- kg_node_history snapshot. NOT a kg_edit_ops op (kg_edit_undo can't reverse an
-- unknown op) — clear it by calling again with false. See header for the #76 seam.
-- ------------------------------------------------------------
create or replace function public.kg_person_set_identity(p_node_id uuid, p_is_self boolean)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_label text;
begin
  select label into v_label
  from public.kg_nodes
  where id = p_node_id and user_id = auth.uid() and type = 'Person' and deleted_at is null;
  if not found then
    raise exception 'person not found';
  end if;

  update public.kg_nodes
  set props = case
        when p_is_self then jsonb_set(coalesce(props, '{}'::jsonb), '{is_user_identity}', 'true'::jsonb, true)
        else props - 'is_user_identity'
      end,
      last_modified_by = 'user', updated_at = now()
  where id = p_node_id and user_id = auth.uid();

  insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
  select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n where n.id = p_node_id;

  perform public.kg__mark_portrait_dirty();

  return jsonb_build_object(
    'ok', true, 'op', 'identity', 'node_id', p_node_id, 'is_self', p_is_self,
    'description', case
      when p_is_self then format('Marked “%s” as you.', v_label)
      else format('“%s” is no longer marked as you.', v_label)
    end
  );
end;
$$;

-- ============================================================
-- kg_edit_merge — WIDENED to accept Person↔Person merges (issue #78).
-- Body is migration 018's verbatim, with the ONLY change being the type gate:
-- Person is now an allowed same-class merge alongside Item / LifeArea. Every
-- other line — edge re-pointing, alias absorption, history snapshots, the undo
-- inverse recorded in kg_edit_ops — is unchanged and type-agnostic, so merging
-- two people re-points their mentions_person / collaborates_with edges onto the
-- survivor and kg_edit_undo (op 'merge') reverses it exactly as for areas/items.
-- ============================================================
create or replace function public.kg_edit_merge(p_source_id uuid, p_target_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_src_type       text;
  v_src_label      text;
  v_src_aliases    text[];
  v_tgt_type       text;
  v_tgt_label      text;
  v_tgt_aliases    text[];
  v_new_aliases    text[];
  r                record;
  v_repointed      jsonb := '[]'::jsonb;
  v_expired        uuid[] := '{}';
  v_repoint_count  int := 0;
begin
  if p_source_id = p_target_id then
    raise exception 'a node cannot be merged into itself';
  end if;

  select type::text, label, coalesce(aliases, '{}') into v_src_type, v_src_label, v_src_aliases
  from public.kg_nodes where id = p_source_id and user_id = auth.uid() and deleted_at is null;
  if not found then
    raise exception 'source node not found';
  end if;

  select type::text, label, coalesce(aliases, '{}') into v_tgt_type, v_tgt_label, v_tgt_aliases
  from public.kg_nodes where id = p_target_id and user_id = auth.uid() and deleted_at is null;
  if not found then
    raise exception 'target node not found';
  end if;

  -- Only same-class merges: Item↔Item, LifeArea↔LifeArea, or Person↔Person
  -- (issue #78 widened this from the migration-018 Item/LifeArea-only gate).
  if v_src_type <> v_tgt_type or v_src_type not in ('Item', 'LifeArea', 'Person') then
    raise exception 'only two items, two life areas, or two people can be merged';
  end if;

  -- Outgoing edges of source (src = source).
  for r in
    select * from public.kg_edges
    where user_id = auth.uid() and src_id = p_source_id and expired_at is null and deleted_at is null
  loop
    if r.dst_id = p_target_id
       or exists (
         select 1 from public.kg_edges d
         where d.user_id = auth.uid() and d.src_id = p_target_id and d.dst_id = r.dst_id
           and d.rel_type = r.rel_type and d.expired_at is null and d.deleted_at is null
       ) then
      update public.kg_edges set expired_at = now(), last_modified_by = 'user' where id = r.id;
      v_expired := v_expired || r.id;
    else
      update public.kg_edges set src_id = p_target_id, last_modified_by = 'user' where id = r.id;
      v_repointed := v_repointed || jsonb_build_object('edge_id', r.id, 'orig_src', p_source_id, 'orig_dst', r.dst_id);
      v_repoint_count := v_repoint_count + 1;
    end if;
    insert into public.kg_edge_history (edge_id, user_id, snapshot, actor_type)
    select id, auth.uid(), to_jsonb(e), 'user' from public.kg_edges e where e.id = r.id;
  end loop;

  -- Incoming edges of source (dst = source).
  for r in
    select * from public.kg_edges
    where user_id = auth.uid() and dst_id = p_source_id and expired_at is null and deleted_at is null
  loop
    if r.src_id = p_target_id
       or exists (
         select 1 from public.kg_edges d
         where d.user_id = auth.uid() and d.dst_id = p_target_id and d.src_id = r.src_id
           and d.rel_type = r.rel_type and d.expired_at is null and d.deleted_at is null
       ) then
      update public.kg_edges set expired_at = now(), last_modified_by = 'user' where id = r.id;
      v_expired := v_expired || r.id;
    else
      update public.kg_edges set dst_id = p_target_id, last_modified_by = 'user' where id = r.id;
      v_repointed := v_repointed || jsonb_build_object('edge_id', r.id, 'orig_src', r.src_id, 'orig_dst', p_source_id);
      v_repoint_count := v_repoint_count + 1;
    end if;
    insert into public.kg_edge_history (edge_id, user_id, snapshot, actor_type)
    select id, auth.uid(), to_jsonb(e), 'user' from public.kg_edges e where e.id = r.id;
  end loop;

  -- Absorb source label + aliases into target aliases (deduped, never the target's own label).
  select array_agg(distinct a) into v_new_aliases
  from unnest(v_tgt_aliases || v_src_aliases || array[v_src_label]) a
  where a is not null and btrim(a) <> '' and lower(a) <> lower(v_tgt_label);

  update public.kg_nodes
  set aliases = coalesce(v_new_aliases, '{}'), last_modified_by = 'user', updated_at = now()
  where id = p_target_id and user_id = auth.uid();
  insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
  select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n where n.id = p_target_id;

  update public.kg_nodes
  set deleted_at = now(), last_modified_by = 'user', updated_at = now()
  where id = p_source_id and user_id = auth.uid();
  insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
  select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n where n.id = p_source_id;

  insert into public.kg_edit_ops (user_id, op, payload, inverse)
  values (
    auth.uid(), 'merge',
    jsonb_build_object('source_id', p_source_id, 'target_id', p_target_id),
    jsonb_build_object(
      'source_id', p_source_id, 'target_id', p_target_id,
      'target_prior_aliases', to_jsonb(v_tgt_aliases),
      'repointed', v_repointed,
      'expired', to_jsonb(v_expired)
    )
  );

  perform public.kg__mark_portrait_dirty();

  return jsonb_build_object(
    'ok', true, 'op', 'merge', 'source_id', p_source_id, 'target_id', p_target_id,
    'repointed', v_repoint_count, 'expired', coalesce(array_length(v_expired, 1), 0),
    'description', format('Merged “%s” into “%s”.', v_src_label, v_tgt_label)
  );
end;
$$;

-- ------------------------------------------------------------
-- Lock down execution: logged-in end users only, invoking as themselves.
-- ------------------------------------------------------------
revoke all on function public.kg_people_list(int, int, text) from public, anon;
grant execute on function public.kg_people_list(int, int, text) to authenticated;

revoke all on function public.kg_person_detail(uuid) from public, anon;
grant execute on function public.kg_person_detail(uuid) to authenticated;

revoke all on function public.kg_people_scope(uuid, int, int) from public, anon;
grant execute on function public.kg_people_scope(uuid, int, int) to authenticated;

revoke all on function public.kg_person_set_identity(uuid, boolean) from public, anon;
grant execute on function public.kg_person_set_identity(uuid, boolean) to authenticated;

-- kg_edit_merge grants are preserved by create-or-replace; re-assert for safety.
revoke all on function public.kg_edit_merge(uuid, uuid) from public, anon;
grant execute on function public.kg_edit_merge(uuid, uuid) to authenticated;
