-- ============================================================
-- 018_kg_edit_rpcs.sql
-- Real graph editing for the Second Brain UI (GitHub issue #60, phase 1):
-- rename / move / merge / archive / lock / undo.
--
-- Companion to migration 015 (read RPCs). Where 015 is the ONLY sanctioned
-- READER of the production graph for the /map surfaces, this is the ONLY
-- sanctioned WRITER for user-initiated edits. The bootstrap pipeline still
-- writes via lib/kg/graph-writer.ts (service role); these functions are the
-- browser edit path.
--
-- SECURITY MODEL (the 015 pattern, NOT the 016 pattern):
--   * Every function is SECURITY INVOKER, so each runs as the calling end user
--     and RLS (auth.uid() = user_id on kg_nodes / kg_edges / kg_*_history /
--     kg_user_portraits / kg_edit_ops) is enforced — the belt's suspenders.
--   * As the belt, every table access additionally carries an explicit
--     `user_id = auth.uid()` predicate. A caller cannot name another user's
--     node id: the lookups filter on auth.uid(), so a foreign id simply
--     "not found"s (verified in the psql transcript, step 5).
--   * search_path pinned to `public, pg_temp`.
--   * EXECUTE revoked from public/anon, granted only to `authenticated` — these
--     are session-called, so auth.uid() is real (matches 015, not 016's
--     service-role p_user_id functions).
--
-- UNDO: every mutating op records a row in kg_edit_ops carrying an `inverse`
-- jsonb with exactly enough state to reverse it. kg_edit_undo() pops the
-- caller's most-recent not-yet-undone op and applies that inverse atomically.
-- Undo relies ONLY on the recorded inverse, never on the history log — the
-- kg_*_history rows are an append-only audit trail, not the undo mechanism.
--
-- WHY kg_edit_ops has user-facing INSERT/UPDATE RLS policies (not just SELECT):
-- the functions are SECURITY INVOKER, so they write kg_edit_ops AS the calling
-- user; that requires the user to hold insert/update privileges + a permissive
-- RLS policy. We therefore CANNOT revoke table writes from `authenticated`
-- without breaking the functions themselves. The residual exposure — a user
-- hand-crafting an op row over PostgREST and calling undo — is bounded entirely
-- to that user's OWN graph (every undo update is `where user_id = auth.uid()`),
-- i.e. nothing they cannot already do through the legitimate edit functions.
-- No cross-user reach, no privilege escalation. DELETE is never granted.
--
-- PORTRAIT: every mutating function (including undo) ends by setting
-- kg_user_portraits.portrait_dirty=true for auth.uid() — the documented edit
-- trigger for lazy portrait regen (see lib/kg/portrait.ts DIRTY FLAG note).
--
-- Amended 2026-07-24 (issue #60 review): kg_edit_archive takes p_archived
-- boolean (archive / unarchive, same reversible inverse); kg_edit_move rejects
-- moving a node whose type ∉ (LifeArea, Item); kg_edit_undo tracks rows-affected
-- and returns ok:false 'Nothing to restore.' when the inverse matched nothing.
--
-- Apply: `npx supabase migration up` from apps/cloud.
-- ============================================================

-- ------------------------------------------------------------
-- kg_edit_ops: append-only log of user edits, with a reversible `inverse`.
-- ------------------------------------------------------------
create table public.kg_edit_ops (
  id         uuid primary key default gen_random_uuid(),
  seq        bigint generated always as identity,  -- monotonic LIFO order for undo
  user_id    uuid not null references public.profiles(id) on delete cascade,
  op         text not null,               -- rename | move | merge | archive | lock
  payload    jsonb not null default '{}', -- the forward parameters (audit / display)
  inverse    jsonb not null default '{}', -- everything needed to reverse the op
  created_at timestamptz not null default now(),
  undone_at  timestamptz                  -- set when kg_edit_undo reverses this op
);

-- Latest-not-undone lookup for kg_edit_undo. Order by `seq`, NOT created_at:
-- created_at is now() (transaction-start time), so two ops committed in the same
-- transaction share it and the tiebreak would be a random uuid — non-LIFO. The
-- identity `seq` is strictly increasing per insert, so undo always pops the most
-- recent op deterministically.
create index idx_kg_edit_ops_user_active
  on public.kg_edit_ops (user_id, seq desc)
  where undone_at is null;

alter table public.kg_edit_ops enable row level security;

-- SELECT own rows; INSERT/UPDATE own rows so the SECURITY INVOKER functions can
-- write as the calling user (see header). No DELETE policy — ops are permanent.
create policy "kg_edit_ops: users see own rows" on public.kg_edit_ops
  for select using (auth.uid() = user_id);
create policy "kg_edit_ops: users insert own rows" on public.kg_edit_ops
  for insert with check (auth.uid() = user_id);
create policy "kg_edit_ops: users update own rows" on public.kg_edit_ops
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ------------------------------------------------------------
-- internal: mark the caller's portrait dirty (upsert a stub row if missing).
-- Not exposed to clients; every mutating function calls it last.
-- ------------------------------------------------------------
create or replace function public.kg__mark_portrait_dirty()
returns void
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  insert into public.kg_user_portraits (user_id, portrait_dirty)
  values (auth.uid(), true)
  on conflict (user_id) do update set portrait_dirty = true;
end;
$$;

-- ============================================================
-- kg_edit_rename(p_node_id, p_label)
-- ============================================================
create or replace function public.kg_edit_rename(p_node_id uuid, p_label text)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_label       text := btrim(coalesce(p_label, ''));
  v_old_label   text;
  v_old_locked  text[];
  v_new_locked  text[];
begin
  if v_label = '' or char_length(v_label) > 200 then
    raise exception 'label must be between 1 and 200 characters';
  end if;

  select label, locked_fields into v_old_label, v_old_locked
  from public.kg_nodes
  where id = p_node_id and user_id = auth.uid() and deleted_at is null;
  if not found then
    raise exception 'node not found';
  end if;

  -- User edit wins over AI: lock the label so resync never paraphrases it back.
  v_new_locked := array(select distinct unnest(coalesce(v_old_locked, '{}') || array['label']));

  update public.kg_nodes
  set label = v_label, locked_fields = v_new_locked, last_modified_by = 'user', updated_at = now()
  where id = p_node_id and user_id = auth.uid();

  insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
  select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n where n.id = p_node_id;

  insert into public.kg_edit_ops (user_id, op, payload, inverse)
  values (
    auth.uid(), 'rename',
    jsonb_build_object('node_id', p_node_id, 'label', v_label),
    jsonb_build_object('node_id', p_node_id, 'label', v_old_label, 'locked_fields', to_jsonb(coalesce(v_old_locked, '{}')))
  );

  perform public.kg__mark_portrait_dirty();

  return jsonb_build_object(
    'ok', true, 'op', 'rename', 'node_id', p_node_id, 'label', v_label,
    'description', format('Renamed to “%s”. Locked from AI changes.', v_label)
  );
end;
$$;

-- ============================================================
-- kg_edit_move(p_node_id, p_new_parent_id)
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

  insert into public.kg_edit_ops (user_id, op, payload, inverse)
  values (
    auth.uid(), 'move',
    jsonb_build_object('node_id', p_node_id, 'new_parent_id', p_new_parent_id),
    jsonb_build_object('new_edge_id', v_new_edge_id, 'expired_edge_ids', to_jsonb(coalesce(v_expired_ids, '{}')))
  );

  perform public.kg__mark_portrait_dirty();

  return jsonb_build_object(
    'ok', true, 'op', 'move', 'node_id', p_node_id, 'new_parent_id', p_new_parent_id,
    'description', format('Moved “%s” into “%s”.', v_node_label, v_parent_label)
  );
end;
$$;

-- ============================================================
-- kg_edit_merge(p_source_id, p_target_id)
--   Fold source into target: re-point source's live edges onto target
--   (expiring any that would duplicate an existing live target edge, or become a
--   self-edge), absorb source label+aliases into target aliases, soft-delete
--   source. Fully reversible via the recorded inverse.
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

  -- Only same-class merges: Item↔Item or LifeArea↔LifeArea.
  if v_src_type <> v_tgt_type or v_src_type not in ('Item', 'LifeArea') then
    raise exception 'only two items, or two life areas, can be merged';
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

-- ============================================================
-- kg_edit_archive(p_node_id, p_archived)
--   p_archived=true archives (status='archived'); false unarchives
--   (status='active'). Both record a reversible op whose inverse restores the
--   exact prior status. Unarchive is the affordance the inspector shows on an
--   archived node (which the read RPCs hide from browse but keep deep-linkable).
-- ============================================================
create or replace function public.kg_edit_archive(p_node_id uuid, p_archived boolean)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_old_status text;
  v_label      text;
  v_new_status text := case when p_archived then 'archived' else 'active' end;
  v_op         text := case when p_archived then 'archive' else 'unarchive' end;
begin
  select status, label into v_old_status, v_label
  from public.kg_nodes where id = p_node_id and user_id = auth.uid() and deleted_at is null;
  if not found then
    raise exception 'node not found';
  end if;

  update public.kg_nodes
  set status = v_new_status, last_modified_by = 'user', updated_at = now()
  where id = p_node_id and user_id = auth.uid();

  insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
  select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n where n.id = p_node_id;

  -- Both archive and unarchive undo the same way: restore the prior status. The
  -- undo branch keys on op='archive' for either (see kg_edit_undo).
  insert into public.kg_edit_ops (user_id, op, payload, inverse)
  values (
    auth.uid(), 'archive',
    jsonb_build_object('node_id', p_node_id, 'archived', p_archived),
    jsonb_build_object('node_id', p_node_id, 'status', to_jsonb(v_old_status))
  );

  perform public.kg__mark_portrait_dirty();

  return jsonb_build_object(
    'ok', true, 'op', v_op, 'node_id', p_node_id,
    'description', format('%s “%s”.', case when p_archived then 'Archived' else 'Unarchived' end, v_label)
  );
end;
$$;

-- ============================================================
-- kg_edit_set_lock(p_node_id, p_field, p_locked)
-- ============================================================
create or replace function public.kg_edit_set_lock(p_node_id uuid, p_field text, p_locked boolean)
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_old_locked text[];
  v_new_locked text[];
begin
  if p_field not in ('label', 'summary', 'kind', 'status') then
    raise exception 'lock field must be one of label, summary, kind, status';
  end if;

  select locked_fields into v_old_locked
  from public.kg_nodes where id = p_node_id and user_id = auth.uid() and deleted_at is null;
  if not found then
    raise exception 'node not found';
  end if;

  if p_locked then
    v_new_locked := array(select distinct unnest(coalesce(v_old_locked, '{}') || array[p_field]));
  else
    v_new_locked := array(select x from unnest(coalesce(v_old_locked, '{}')) x where x <> p_field);
  end if;

  update public.kg_nodes
  set locked_fields = v_new_locked, last_modified_by = 'user', updated_at = now()
  where id = p_node_id and user_id = auth.uid();

  insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
  select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n where n.id = p_node_id;

  -- Self-inverse: undoing a lock is the same op with the boolean flipped.
  insert into public.kg_edit_ops (user_id, op, payload, inverse)
  values (
    auth.uid(), 'lock',
    jsonb_build_object('node_id', p_node_id, 'field', p_field, 'locked', p_locked),
    jsonb_build_object('node_id', p_node_id, 'field', p_field, 'locked', not p_locked)
  );

  perform public.kg__mark_portrait_dirty();

  return jsonb_build_object(
    'ok', true, 'op', 'lock', 'node_id', p_node_id, 'field', p_field, 'locked', p_locked,
    'description', case when p_locked then 'Locked — AI won’t change this.' else 'Unlocked — AI can refine this again.' end
  );
end;
$$;

-- ============================================================
-- kg_edit_undo() — reverse the caller's most-recent not-yet-undone op.
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
    -- Expire the edge the move created; un-expire the ones it expired.
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

-- ============================================================
-- Lock down execution: logged-in end users only, invoking as themselves.
-- ============================================================
revoke all on function public.kg__mark_portrait_dirty() from public, anon;

revoke all on function public.kg_edit_rename(uuid, text) from public, anon;
grant execute on function public.kg_edit_rename(uuid, text) to authenticated;

revoke all on function public.kg_edit_move(uuid, uuid) from public, anon;
grant execute on function public.kg_edit_move(uuid, uuid) to authenticated;

revoke all on function public.kg_edit_merge(uuid, uuid) from public, anon;
grant execute on function public.kg_edit_merge(uuid, uuid) to authenticated;

revoke all on function public.kg_edit_archive(uuid, boolean) from public, anon;
grant execute on function public.kg_edit_archive(uuid, boolean) to authenticated;

revoke all on function public.kg_edit_set_lock(uuid, text, boolean) from public, anon;
grant execute on function public.kg_edit_set_lock(uuid, text, boolean) to authenticated;

revoke all on function public.kg_edit_undo() from public, anon;
grant execute on function public.kg_edit_undo() to authenticated;
