-- ============================================================
-- 032_kg_edit_move_top_level.sql
-- Promote a sub-bucket to a top-level life area (GitHub issue #60;
-- handoff 0024 directive B, item 1 — small/now scope only. The bigger
-- editable-tree / drag-drop design is explicitly NOT part of this change).
--
-- NUMBERING NOTE: 031 is left free on purpose — reserved for a parallel P2a
-- agent's code_kg tables migration (per handoff 0024's "next number: 031").
-- This change takes 032 instead so the two don't collide.
--
-- kg_edit_move(p_node_id, p_new_parent_id) (migration 018) previously
-- REQUIRED a real destination node id — the move/merge picker (edit-targets.ts
-- moveTargets) had no way to ask for "no parent". This migration extends the
-- same function (CREATE OR REPLACE, same uuid/uuid signature — no grant
-- changes needed) so p_new_parent_id = NULL means "promote to top level":
--   * clears every live `contains` edge INTO the node (same single-parent
--     invariant expiry as a normal move), so it becomes a graph root;
--   * ALSO flips kg_nodes.type to 'LifeArea' when the node was an 'Item' —
--     kg_read_map's root listing (015_kg_read_rpcs.sql) keys strictly on
--     type = 'LifeArea', so a parentless Item would otherwise just vanish
--     from /map instead of surfacing as a new top-level area. This is the one
--     piece of write-path logic this task actually needed beyond "allow a
--     null parent".
--
-- SYMMETRIC FIX (found live-verifying the round trip, not part of the
-- original ask but the natural counterpart of the point above): moving a
-- node onto a REAL destination now flips its type back to 'Item' if it was
-- 'LifeArea'. Without this, a promoted node later moved back under something
-- kept type='LifeArea' forever — kg_read_map's root listing never looks at
-- contains edges, only type, so it would render as a permanent duplicate
-- top-level tile even after gaining a real parent. This generalizes past
-- "un-promoting": it also fixes the same latent bug for the pre-existing
-- (already-allowed) case of moving one ordinary LifeArea node underneath
-- another.
--
-- UNDO CONTRACT (unchanged shape, extended payload): every move's recorded
-- `inverse` now also carries `node_id` and `old_type`, restored by
-- kg_edit_undo's existing 'move' branch. Older kg_edit_ops rows written
-- before this migration have no `old_type` key — the undo branch checks
-- `v_inverse ? 'old_type'` before touching type, so undoing a pre-032 move
-- is unaffected. A promote's `new_edge_id` is NULL (no new edge was created);
-- undo's `where id = (v_inverse->>'new_edge_id')::uuid` on a NULL uuid simply
-- matches zero rows, which is exactly what we want — the real restoration is
-- re-instating the expired parent edge(s) + reverting the type flip.
-- ============================================================

create or replace function public.kg_edit_move(p_node_id uuid, p_new_parent_id uuid)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_node_type      text;
  v_parent_type    text;
  v_parent_label   text;
  v_node_label     text;
  v_expired_ids    uuid[];
  v_new_edge_id    uuid;
begin
  select type::text, label into v_node_type, v_node_label
  from public.kg_nodes
  where id = p_node_id and user_id = auth.uid() and deleted_at is null;
  if not found then
    raise exception 'node not found';
  end if;
  -- Only the browse-tree node types are re-parentable. Entities (Person, Tool,
  -- Organization, Artifact, …) live off conversation edges, not the contains
  -- tree, so a direct POST asking to re-parent one is rejected here.
  if v_node_type not in ('LifeArea', 'Item') then
    raise exception 'only a life area or an item can be moved';
  end if;

  -- ----------------------------------------------------------
  -- Promote-to-top-level branch (p_new_parent_id IS NULL): no destination
  -- node to validate/cycle-check against — just clear the node's parent and,
  -- for an Item, flip it to LifeArea so it surfaces as a /map root.
  -- ----------------------------------------------------------
  if p_new_parent_id is null then
    select array_agg(id) into v_expired_ids
    from public.kg_edges
    where user_id = auth.uid() and dst_id = p_node_id and rel_type = 'contains'
      and expired_at is null and deleted_at is null;
    if v_expired_ids is null then
      raise exception 'node is already top level';
    end if;

    update public.kg_edges
    set expired_at = now(), last_modified_by = 'user'
    where id = any(v_expired_ids);

    insert into public.kg_edge_history (edge_id, user_id, snapshot, actor_type)
    select id, auth.uid(), to_jsonb(e), 'user'
    from public.kg_edges e where e.id = any(v_expired_ids);

    if v_node_type <> 'LifeArea' then
      update public.kg_nodes
      set type = 'LifeArea', last_modified_by = 'user', updated_at = now()
      where id = p_node_id and user_id = auth.uid();
      insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
      select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n where n.id = p_node_id;
    end if;

    insert into public.kg_edit_ops (user_id, op, payload, inverse)
    values (
      auth.uid(), 'move',
      jsonb_build_object('node_id', p_node_id, 'new_parent_id', null),
      jsonb_build_object(
        'node_id', p_node_id, 'old_type', v_node_type,
        'new_edge_id', null, 'expired_edge_ids', to_jsonb(v_expired_ids)
      )
    );

    perform public.kg__mark_portrait_dirty();

    return jsonb_build_object(
      'ok', true, 'op', 'move', 'node_id', p_node_id, 'new_parent_id', null,
      'description', format('Promoted “%s” to a top-level life area.', v_node_label)
    );
  end if;

  select type::text, label into v_parent_type, v_parent_label
  from public.kg_nodes
  where id = p_new_parent_id and user_id = auth.uid() and deleted_at is null;
  if not found then
    raise exception 'destination not found';
  end if;
  if v_parent_type not in ('LifeArea', 'Item') then
    raise exception 'a node can only be moved under a life area or an item';
  end if;

  -- Cycle guard: the new parent must not be the node itself, nor live inside the
  -- node's own contains-subtree. Recursive walk from p_node_id following
  -- `contains` dst; a repeated node prunes the branch (dirty data can be cyclic).
  if exists (
    with recursive sub(id) as (
      select p_node_id
      union all
      select e.dst_id from public.kg_edges e join sub s on e.src_id = s.id
      where e.rel_type = 'contains' and e.user_id = auth.uid()
        and e.deleted_at is null and e.expired_at is null
    ) cycle id set is_cycle using path
    select 1 from sub where id = p_new_parent_id
  ) then
    raise exception 'cannot move a node under itself or its own descendant';
  end if;

  -- Single-parent invariant: expire ALL live contains edges into the node.
  -- Capture their ids first (RETURNING INTO an array is a single-row form), then
  -- expire and snapshot the post-state.
  select array_agg(id) into v_expired_ids
  from public.kg_edges
  where user_id = auth.uid() and dst_id = p_node_id and rel_type = 'contains'
    and expired_at is null and deleted_at is null;

  update public.kg_edges
  set expired_at = now(), last_modified_by = 'user'
  where id = any(coalesce(v_expired_ids, '{}'));

  insert into public.kg_edge_history (edge_id, user_id, snapshot, actor_type)
  select id, auth.uid(), to_jsonb(e), 'user'
  from public.kg_edges e where e.id = any(coalesce(v_expired_ids, '{}'));

  insert into public.kg_edges (user_id, src_id, dst_id, rel_type, created_by_actor, created_by_model, last_modified_by)
  values (auth.uid(), p_new_parent_id, p_node_id, 'contains', 'user', 'user-edit', 'user')
  returning id into v_new_edge_id;

  insert into public.kg_edge_history (edge_id, user_id, snapshot, actor_type)
  select id, auth.uid(), to_jsonb(e), 'user' from public.kg_edges e where e.id = v_new_edge_id;

  -- Symmetric counterpart of the promote branch above: a node gaining a REAL
  -- parent is by definition no longer a root, so a former-promoted LifeArea
  -- flips back to Item here. Without this, kg_read_map's root listing (015 —
  -- keys on type = 'LifeArea' alone, it never looks at contains edges) would
  -- keep rendering it as a duplicate top-level tile forever after this move,
  -- even though it now also correctly appears as a nested child.
  if v_node_type = 'LifeArea' then
    update public.kg_nodes
    set type = 'Item', last_modified_by = 'user', updated_at = now()
    where id = p_node_id and user_id = auth.uid();
    insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
    select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n where n.id = p_node_id;
  end if;

  insert into public.kg_edit_ops (user_id, op, payload, inverse)
  values (
    auth.uid(), 'move',
    jsonb_build_object('node_id', p_node_id, 'new_parent_id', p_new_parent_id),
    jsonb_build_object(
      'node_id', p_node_id, 'old_type', v_node_type,
      'new_edge_id', v_new_edge_id, 'expired_edge_ids', to_jsonb(coalesce(v_expired_ids, '{}'))
    )
  );

  perform public.kg__mark_portrait_dirty();

  return jsonb_build_object(
    'ok', true, 'op', 'move', 'node_id', p_node_id, 'new_parent_id', p_new_parent_id,
    'description', format('Moved “%s” into “%s”.', v_node_label, v_parent_label)
  );
end;
$$;

-- ============================================================
-- kg_edit_undo() — extend the 'move' branch to also restore the pre-move
-- node type (only when the recorded inverse carries one — older pre-032
-- move ops don't, and are left exactly as before).
-- ============================================================
create or replace function public.kg_edit_undo()
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_op_id    uuid;
  v_op       text;
  v_inverse  jsonb;
  v_desc     text;
  r          jsonb;
  v_field    text;
  v_locked   boolean;
  v_new_lock text[];
  v_old_lock text[];
  v_node_id  uuid;
  v_affected int := 0;  -- total rows the inverse actually touched
  v_rc       int;
begin
  -- CONCURRENCY (known, phase-1 semantics): undo is single-step, last-writer-
  -- wins. It pops the most-recent not-yet-undone op and applies its recorded
  -- inverse with no check that the live rows still match the pre-op state. If
  -- another edit landed on the same node after this op, undo restores this op's
  -- snapshot and silently clobbers that later edit. No optimistic-concurrency
  -- guard in phase 1 — accepted and documented, not fixed here.
  select id, op, inverse into v_op_id, v_op, v_inverse
  from public.kg_edit_ops
  where user_id = auth.uid() and undone_at is null
  order by seq desc
  limit 1;

  if not found then
    return jsonb_build_object('ok', false, 'description', 'Nothing to undo.');
  end if;

  if v_op = 'rename' then
    v_node_id := (v_inverse->>'node_id')::uuid;
    v_old_lock := array(select jsonb_array_elements_text(v_inverse->'locked_fields'));
    update public.kg_nodes
    set label = v_inverse->>'label', locked_fields = v_old_lock, last_modified_by = 'user', updated_at = now()
    where id = v_node_id and user_id = auth.uid();
    get diagnostics v_rc = row_count; v_affected := v_affected + v_rc;
    insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
    select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n where n.id = v_node_id;
    v_desc := format('Undid rename — restored “%s”.', v_inverse->>'label');

  elsif v_op = 'move' then
    -- Expire the edge the move created (a no-op when null — a promote-to-
    -- top-level created no new edge); un-expire the ones it expired.
    update public.kg_edges set expired_at = now(), last_modified_by = 'user'
    where id = (v_inverse->>'new_edge_id')::uuid and user_id = auth.uid();
    get diagnostics v_rc = row_count; v_affected := v_affected + v_rc;
    update public.kg_edges set expired_at = null, last_modified_by = 'user'
    where id in (select (jsonb_array_elements_text(v_inverse->'expired_edge_ids'))::uuid)
      and user_id = auth.uid();
    get diagnostics v_rc = row_count; v_affected := v_affected + v_rc;
    insert into public.kg_edge_history (edge_id, user_id, snapshot, actor_type)
    select id, auth.uid(), to_jsonb(e), 'user' from public.kg_edges e
    where e.id = (v_inverse->>'new_edge_id')::uuid
       or e.id in (select (jsonb_array_elements_text(v_inverse->'expired_edge_ids'))::uuid);
    -- A promote-to-top-level also flips type Item -> LifeArea; restore the
    -- prior type when the recorded inverse carries one.
    if v_inverse ? 'old_type' then
      v_node_id := (v_inverse->>'node_id')::uuid;
      update public.kg_nodes
      set type = (v_inverse->>'old_type')::public.kg_node_type, last_modified_by = 'user', updated_at = now()
      where id = v_node_id and user_id = auth.uid() and type::text <> (v_inverse->>'old_type');
      get diagnostics v_rc = row_count; v_affected := v_affected + v_rc;
      if v_rc > 0 then
        insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
        select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n where n.id = v_node_id;
      end if;
    end if;
    v_desc := 'Undid move — restored the original placement.';

  elsif v_op = 'merge' then
    -- Re-point edges back to their original endpoints.
    for r in select * from jsonb_array_elements(v_inverse->'repointed') loop
      update public.kg_edges
      set src_id = (r->>'orig_src')::uuid, dst_id = (r->>'orig_dst')::uuid, last_modified_by = 'user'
      where id = (r->>'edge_id')::uuid and user_id = auth.uid();
      insert into public.kg_edge_history (edge_id, user_id, snapshot, actor_type)
      select id, auth.uid(), to_jsonb(e), 'user' from public.kg_edges e where e.id = (r->>'edge_id')::uuid;
    end loop;
    -- Un-expire the edges the merge expired.
    update public.kg_edges set expired_at = null, last_modified_by = 'user'
    where id in (select (jsonb_array_elements_text(v_inverse->'expired'))::uuid)
      and user_id = auth.uid();
    insert into public.kg_edge_history (edge_id, user_id, snapshot, actor_type)
    select id, auth.uid(), to_jsonb(e), 'user' from public.kg_edges e
    where e.id in (select (jsonb_array_elements_text(v_inverse->'expired'))::uuid);
    -- Restore the target's prior aliases and un-delete the source node.
    update public.kg_nodes
    set aliases = array(select jsonb_array_elements_text(v_inverse->'target_prior_aliases')),
        last_modified_by = 'user', updated_at = now()
    where id = (v_inverse->>'target_id')::uuid and user_id = auth.uid();
    get diagnostics v_rc = row_count; v_affected := v_affected + v_rc;
    update public.kg_nodes
    set deleted_at = null, last_modified_by = 'user', updated_at = now()
    where id = (v_inverse->>'source_id')::uuid and user_id = auth.uid();
    get diagnostics v_rc = row_count; v_affected := v_affected + v_rc;
    insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
    select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n
    where n.id in ((v_inverse->>'target_id')::uuid, (v_inverse->>'source_id')::uuid);
    v_desc := 'Undid merge — restored both nodes and their connections.';

  elsif v_op = 'archive' then
    v_node_id := (v_inverse->>'node_id')::uuid;
    -- `->>` yields SQL NULL for a jsonb null, so a node whose status was NULL
    -- before archiving is restored to NULL (not the empty string).
    update public.kg_nodes
    set status = v_inverse->>'status', last_modified_by = 'user', updated_at = now()
    where id = v_node_id and user_id = auth.uid();
    get diagnostics v_rc = row_count; v_affected := v_affected + v_rc;
    insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
    select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n where n.id = v_node_id;
    v_desc := 'Undid archive — the node’s previous status is restored.';

  elsif v_op = 'lock' then
    v_node_id := (v_inverse->>'node_id')::uuid;
    v_field := v_inverse->>'field';
    v_locked := (v_inverse->>'locked')::boolean;
    select locked_fields into v_old_lock from public.kg_nodes
    where id = v_node_id and user_id = auth.uid();
    if v_locked then
      v_new_lock := array(select distinct unnest(coalesce(v_old_lock, '{}') || array[v_field]));
    else
      v_new_lock := array(select x from unnest(coalesce(v_old_lock, '{}')) x where x <> v_field);
    end if;
    update public.kg_nodes
    set locked_fields = v_new_lock, last_modified_by = 'user', updated_at = now()
    where id = v_node_id and user_id = auth.uid();
    get diagnostics v_rc = row_count; v_affected := v_affected + v_rc;
    insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
    select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n where n.id = v_node_id;
    v_desc := case when v_locked then 'Undid unlock — locked again.' else 'Undid lock — unlocked again.' end;

  else
    raise exception 'cannot undo unknown op: %', v_op;
  end if;

  -- If the inverse matched nothing (e.g. the target rows were deleted or the op
  -- carried foreign ids), don't consume the op or claim success — no-op instead.
  if v_affected = 0 then
    return jsonb_build_object('ok', false, 'description', 'Nothing to restore.');
  end if;

  update public.kg_edit_ops set undone_at = now() where id = v_op_id and user_id = auth.uid();

  perform public.kg__mark_portrait_dirty();

  return jsonb_build_object('ok', true, 'op', v_op, 'description', v_desc);
end;
$$;

-- Signatures are unchanged (kg_edit_move(uuid, uuid), kg_edit_undo()) — the
-- 018 grants to `authenticated` already cover these replaced bodies, no new
-- revoke/grant statements needed.
