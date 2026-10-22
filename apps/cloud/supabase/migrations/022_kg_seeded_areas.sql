-- ============================================================
-- 022_kg_seeded_areas.sql
-- User-seeded life areas + user-guided scoped re-attach (issue #82, Part B).
--
-- Part B lets the user be the "senior partner" on the shape of their graph:
--   * At bootstrap the run PAUSES after Pass 1 (kg_bootstrap_runs.status =
--     'awaiting_review') so the user can confirm / rename / add / remove the
--     candidate life areas Pass 1 tallied, before Stage A consolidates them.
--   * Post-hoc, the /map search no-results CTA ("Add X as an area") creates a
--     real LifeArea node and pulls the matching conversations into it via a
--     scoped, cheap (~$0.00001, one embedding, JS cosine) re-attach — no full
--     rebuild.
--
-- GROUND TRUTH REGISTRY (kg_seeded_areas): a user-declared area must survive a
-- Stage A re-run (tree rows are per-run and thrown away) and must exist BEFORE
-- any live LifeArea node does (the review step names areas before Stage A ever
-- runs). So the declaration lives in its own table, not on the tree or the node.
-- Stage A's deterministic reconciliation pass (lib/kg/stage-a.ts
-- reconcileSeededAreas) reads this registry each run and either CONFIRMS a
-- discovered area (adopts the user's label, locks it) or CREATES the area from
-- the orphan pool — leaving the discovered clustering the #33 sweep measures
-- completely untouched (an added area draws ONLY from orphans).
--
-- SECURITY MODEL — the 015/018 pattern (NOT 016's service-role p_user_id):
--   * Every RPC is SECURITY INVOKER, runs as the calling end user, RLS enforced.
--   * Every table access ALSO carries an explicit user_id = auth.uid() predicate
--     (the belt to RLS's suspenders); a caller can never name another user's id.
--   * search_path pinned; EXECUTE revoked from public/anon, granted only to
--     `authenticated`. No DELETE policy on kg_seeded_areas — declarations are
--     archived, never hard-deleted (same as kg_edit_ops).
--
-- UNDO: kg_edit_undo() (replaced below) gains `seed_attach` and `seed_create`
-- branches. A post-hoc "add area" records seed_create (the node) then
-- seed_attach (the edges); the LIFO journal undoes the edges first (re-orphaning
-- the conversations) then the node. Same recorded-inverse mechanism migration
-- 018 uses — undo never reads the history log.
--
-- Apply locally: `psql "$DATABASE_URL" -f 022_kg_seeded_areas.sql`
-- (prefer psql -f over `supabase migration up` to preserve local fixtures).
-- ============================================================

-- ------------------------------------------------------------
-- kg_seeded_areas: the user-declared-area registry.
-- ------------------------------------------------------------
create table if not exists public.kg_seeded_areas (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  label            text not null,
  aliases          text[] not null default '{}',
  origin           text not null default 'added',   -- 'confirmed' | 'renamed' | 'added'
  status           text not null default 'active',  -- 'active' | 'empty' | 'archived'
  anchor           vector(1536),                     -- cached label+aliases embedding (lazy)
  promoted_node_id uuid references public.kg_nodes(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- One declaration per (user, case-insensitive label): the review upsert and the
-- post-hoc create both key on this to stay idempotent / offer merge on collision.
create unique index if not exists idx_kg_seeded_areas_user_label
  on public.kg_seeded_areas (user_id, lower(label));
create index if not exists idx_kg_seeded_areas_user_status
  on public.kg_seeded_areas (user_id, status);

alter table public.kg_seeded_areas enable row level security;

-- SELECT/INSERT/UPDATE own rows so the SECURITY INVOKER RPCs write as the caller
-- (see migration 018's header for why INSERT/UPDATE are user-facing). No DELETE.
do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='kg_seeded_areas' and policyname='kg_seeded_areas: users see own rows') then
    create policy "kg_seeded_areas: users see own rows" on public.kg_seeded_areas
      for select using (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='kg_seeded_areas' and policyname='kg_seeded_areas: users insert own rows') then
    create policy "kg_seeded_areas: users insert own rows" on public.kg_seeded_areas
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='kg_seeded_areas' and policyname='kg_seeded_areas: users update own rows') then
    create policy "kg_seeded_areas: users update own rows" on public.kg_seeded_areas
      for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
end $$;

-- ------------------------------------------------------------
-- kg_stage_a_tree: two columns so promote.ts can stamp a seeded row's live node.
-- ------------------------------------------------------------
alter table public.kg_stage_a_tree add column if not exists seeded boolean not null default false;
alter table public.kg_stage_a_tree add column if not exists seed_area_id uuid references public.kg_seeded_areas(id) on delete set null;

-- ============================================================
-- kg_seed_areas_set(p_areas jsonb)
--   Bulk-upsert the reviewed area set (the "Build my Second Brain" review step).
--   p_areas = [{ "label": text, "aliases": text[], "origin": text }, ...].
--   The reviewed set is authoritative: areas the user removed (not in p_areas)
--   are archived (status='archived'), not seeded — "remove = don't seed" (issue
--   #82 design §8.3). Returns the active seeded rows' ids. No node/edge writes
--   here (Stage A reconciliation materializes the nodes later).
-- ============================================================
create or replace function public.kg_seed_areas_set(p_areas jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  v_labels  text[] := '{}';
  r         jsonb;
  v_label   text;
  v_aliases text[];
  v_origin  text;
  v_ids     jsonb := '[]'::jsonb;
  v_id      uuid;
begin
  for r in select * from jsonb_array_elements(coalesce(p_areas, '[]'::jsonb)) loop
    v_label := btrim(coalesce(r->>'label', ''));
    if v_label = '' or char_length(v_label) > 200 then
      continue;
    end if;
    v_aliases := coalesce(array(select jsonb_array_elements_text(coalesce(r->'aliases', '[]'::jsonb))), '{}');
    v_origin  := coalesce(nullif(btrim(coalesce(r->>'origin', '')), ''), 'added');
    if v_origin not in ('confirmed', 'renamed', 'added') then
      v_origin := 'added';
    end if;
    v_labels := v_labels || lower(v_label);

    insert into public.kg_seeded_areas (user_id, label, aliases, origin, status)
    values (auth.uid(), v_label, v_aliases, v_origin, 'active')
    on conflict (user_id, lower(label)) do update
      set aliases = excluded.aliases,
          origin  = excluded.origin,
          status  = 'active',
          anchor  = null,           -- label/aliases changed: invalidate the cached anchor
          updated_at = now()
    returning id into v_id;
    v_ids := v_ids || to_jsonb(v_id);
  end loop;

  -- Anything the user did NOT keep in the reviewed set: archive it (don't seed).
  update public.kg_seeded_areas
    set status = 'archived', updated_at = now()
    where user_id = auth.uid()
      and status <> 'archived'
      and lower(label) <> all (v_labels);

  return jsonb_build_object('ok', true, 'ids', v_ids, 'count', jsonb_array_length(v_ids));
end;
$$;

-- ============================================================
-- kg_seed_area_create(p_label, p_aliases)
--   Post-hoc "add an area" (the /map search no-results CTA). Creates the seeded
--   registry row AND an empty live LifeArea node (props.user_seeded=true,
--   props.empty=true, locked_fields=['label'] so resync can't rename it), links
--   them, and records a reversible `seed_create` op. Returns {area_id, node_id}.
--   The route then embeds the label and calls kg_seed_attach_apply to fill it.
-- ============================================================
create or replace function public.kg_seed_area_create(p_label text, p_aliases text[] default '{}')
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  v_label   text := btrim(coalesce(p_label, ''));
  v_aliases text[] := coalesce(p_aliases, '{}');
  v_area_id uuid;
  v_node_id uuid;
begin
  if v_label = '' or char_length(v_label) > 200 then
    raise exception 'label must be between 1 and 200 characters';
  end if;

  -- Idempotency / merge guard: refuse a duplicate declaration (the route offers
  -- merge into the existing area instead — issue #82 design §8.4).
  if exists (
    select 1 from public.kg_seeded_areas
    where user_id = auth.uid() and lower(label) = lower(v_label) and status <> 'archived'
  ) then
    raise exception 'a seeded area named "%" already exists', v_label;
  end if;

  insert into public.kg_seeded_areas (user_id, label, aliases, origin, status)
  values (auth.uid(), v_label, v_aliases, 'added', 'empty')
  returning id into v_area_id;

  insert into public.kg_nodes (user_id, type, label, aliases, status, props, locked_fields,
                               created_by_actor, created_by_model, last_modified_by)
  values (
    auth.uid(), 'LifeArea', v_label, v_aliases, 'active',
    jsonb_build_object('user_seeded', true, 'empty', true, 'seed_area_id', v_area_id),
    array['label'], 'user', 'user-edit', 'user'
  )
  returning id into v_node_id;

  update public.kg_seeded_areas set promoted_node_id = v_node_id, updated_at = now()
    where id = v_area_id and user_id = auth.uid();

  insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
  select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n where n.id = v_node_id;

  insert into public.kg_edit_ops (user_id, op, payload, inverse)
  values (
    auth.uid(), 'seed_create',
    jsonb_build_object('area_id', v_area_id, 'node_id', v_node_id, 'label', v_label),
    jsonb_build_object('area_id', v_area_id, 'node_id', v_node_id)
  );

  perform public.kg__mark_portrait_dirty();

  return jsonb_build_object('ok', true, 'area_id', v_area_id, 'node_id', v_node_id, 'label', v_label);
end;
$$;

-- ============================================================
-- kg_seed_attach_apply(p_area_node_id, p_attach)
--   Atomically attach a set of conversations to a seeded LifeArea node in ONE
--   undoable op. p_attach = [{ "conv_node_id": uuid, "rel_type": text,
--   "expire_edge_id": uuid|null, "was_orphan": bool }, ...] — the plan the route
--   computed from cached embeddings (lib/kg/seed-attach.ts scoreSeededAssignments).
--   For each: expire the conversation's old `discusses` umbrella edge (if any),
--   insert the new contributes_to/discusses edge conv -> area, and flip
--   props.orphan=false for former orphans. Records ONE `seed_attach` op whose
--   inverse re-orphans + re-expires exactly what changed. Clears the area node's
--   props.empty when at least one conversation attaches.
-- ============================================================
create or replace function public.kg_seed_attach_apply(p_area_node_id uuid, p_attach jsonb)
returns jsonb
language plpgsql
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  v_area_type   text;
  r             jsonb;
  v_conv        uuid;
  v_rel         text;
  v_expire      uuid;
  v_was_orphan  boolean;
  v_new_edge    uuid;
  v_created     uuid[] := '{}';
  v_expired     uuid[] := '{}';
  v_reorphaned  uuid[] := '{}';
  v_count       int := 0;
begin
  select type::text into v_area_type
  from public.kg_nodes
  where id = p_area_node_id and user_id = auth.uid() and deleted_at is null;
  if not found then
    raise exception 'area node not found';
  end if;
  if v_area_type <> 'LifeArea' then
    raise exception 'seed attach target must be a life area';
  end if;

  for r in select * from jsonb_array_elements(coalesce(p_attach, '[]'::jsonb)) loop
    v_conv := (r->>'conv_node_id')::uuid;
    v_rel  := coalesce(nullif(r->>'rel_type', ''), 'discusses');
    if v_rel not in ('contributes_to', 'discusses') then
      v_rel := 'discusses';
    end if;
    v_expire := nullif(r->>'expire_edge_id', '')::uuid;
    v_was_orphan := coalesce((r->>'was_orphan')::boolean, false);

    -- Guard: the conversation node must be the caller's own live node.
    if not exists (
      select 1 from public.kg_nodes
      where id = v_conv and user_id = auth.uid() and type = 'Conversation' and deleted_at is null
    ) then
      continue;
    end if;

    -- Expire the old weak umbrella edge, if the plan named one.
    if v_expire is not null then
      update public.kg_edges set expired_at = now(), last_modified_by = 'user'
        where id = v_expire and user_id = auth.uid() and expired_at is null and deleted_at is null;
      if found then
        v_expired := v_expired || v_expire;
        insert into public.kg_edge_history (edge_id, user_id, snapshot, actor_type)
        select id, auth.uid(), to_jsonb(e), 'user' from public.kg_edges e where e.id = v_expire;
      end if;
    end if;

    -- Insert the new attach edge conv -> area (skip if an identical live one exists).
    if not exists (
      select 1 from public.kg_edges
      where user_id = auth.uid() and src_id = v_conv and dst_id = p_area_node_id
        and rel_type = v_rel::kg_edge_type and expired_at is null and deleted_at is null
    ) then
      insert into public.kg_edges (user_id, src_id, dst_id, rel_type, confidence,
                                   created_by_actor, created_by_model, last_modified_by)
      values (auth.uid(), v_conv, p_area_node_id, v_rel::kg_edge_type, 0.9, 'user', 'user-edit', 'user')
      returning id into v_new_edge;
      v_created := v_created || v_new_edge;
      insert into public.kg_edge_history (edge_id, user_id, snapshot, actor_type)
      select id, auth.uid(), to_jsonb(e), 'user' from public.kg_edges e where e.id = v_new_edge;
      v_count := v_count + 1;
    end if;

    -- Former orphan: it now has a home.
    if v_was_orphan then
      update public.kg_nodes
        set props = coalesce(props, '{}'::jsonb) || jsonb_build_object('orphan', false),
            last_modified_by = 'user', updated_at = now()
        where id = v_conv and user_id = auth.uid();
      v_reorphaned := v_reorphaned || v_conv;
    end if;
  end loop;

  -- The area is no longer empty once anything attached.
  if v_count > 0 then
    update public.kg_nodes
      set props = coalesce(props, '{}'::jsonb) || jsonb_build_object('empty', false),
          updated_at = now()
      where id = p_area_node_id and user_id = auth.uid();
    update public.kg_seeded_areas
      set status = 'active', updated_at = now()
      where user_id = auth.uid() and promoted_node_id = p_area_node_id;
  end if;

  insert into public.kg_edit_ops (user_id, op, payload, inverse)
  values (
    auth.uid(), 'seed_attach',
    jsonb_build_object('area_node_id', p_area_node_id, 'attached', v_count),
    jsonb_build_object(
      'area_node_id', p_area_node_id,
      'created_edge_ids', to_jsonb(v_created),
      'expired_edge_ids', to_jsonb(v_expired),
      'reorphaned_conv_ids', to_jsonb(v_reorphaned)
    )
  );

  perform public.kg__mark_portrait_dirty();

  return jsonb_build_object('ok', true, 'attached', v_count,
    'expired', coalesce(array_length(v_expired, 1), 0));
end;
$$;

-- ============================================================
-- kg_edit_undo() — REPLACED to add the `seed_attach` and `seed_create` branches.
-- Body is migration 018's, verbatim, plus the two branches (marked below).
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
  v_affected int := 0;
  v_rc       int;
begin
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
    for r in select * from jsonb_array_elements(v_inverse->'repointed') loop
      update public.kg_edges
      set src_id = (r->>'orig_src')::uuid, dst_id = (r->>'orig_dst')::uuid, last_modified_by = 'user'
      where id = (r->>'edge_id')::uuid and user_id = auth.uid();
      insert into public.kg_edge_history (edge_id, user_id, snapshot, actor_type)
      select id, auth.uid(), to_jsonb(e), 'user' from public.kg_edges e where e.id = (r->>'edge_id')::uuid;
    end loop;
    update public.kg_edges set expired_at = null, last_modified_by = 'user'
    where id in (select (jsonb_array_elements_text(v_inverse->'expired'))::uuid)
      and user_id = auth.uid();
    insert into public.kg_edge_history (edge_id, user_id, snapshot, actor_type)
    select id, auth.uid(), to_jsonb(e), 'user' from public.kg_edges e
    where e.id in (select (jsonb_array_elements_text(v_inverse->'expired'))::uuid);
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

  -- ---- NEW (022): reverse a scoped seed re-attach ----
  elsif v_op = 'seed_attach' then
    -- Expire the edges the attach created.
    update public.kg_edges set expired_at = now(), last_modified_by = 'user'
    where id in (select (jsonb_array_elements_text(v_inverse->'created_edge_ids'))::uuid)
      and user_id = auth.uid();
    get diagnostics v_rc = row_count; v_affected := v_affected + v_rc;
    -- Un-expire the weak umbrella edges it expired.
    update public.kg_edges set expired_at = null, last_modified_by = 'user'
    where id in (select (jsonb_array_elements_text(v_inverse->'expired_edge_ids'))::uuid)
      and user_id = auth.uid();
    get diagnostics v_rc = row_count; v_affected := v_affected + v_rc;
    insert into public.kg_edge_history (edge_id, user_id, snapshot, actor_type)
    select id, auth.uid(), to_jsonb(e), 'user' from public.kg_edges e
    where e.id in (
      select (jsonb_array_elements_text(v_inverse->'created_edge_ids'))::uuid
      union all
      select (jsonb_array_elements_text(v_inverse->'expired_edge_ids'))::uuid
    );
    -- Re-orphan the conversations that were orphans before the attach.
    update public.kg_nodes
    set props = coalesce(props, '{}'::jsonb) || jsonb_build_object('orphan', true),
        last_modified_by = 'user', updated_at = now()
    where id in (select (jsonb_array_elements_text(v_inverse->'reorphaned_conv_ids'))::uuid)
      and user_id = auth.uid();
    get diagnostics v_rc = row_count; v_affected := v_affected + v_rc;
    v_desc := 'Undid area re-attach — those conversations went back where they were.';

  -- ---- NEW (022): reverse a post-hoc "add area" node creation ----
  elsif v_op = 'seed_create' then
    update public.kg_nodes set deleted_at = now(), last_modified_by = 'user', updated_at = now()
    where id = (v_inverse->>'node_id')::uuid and user_id = auth.uid() and deleted_at is null;
    get diagnostics v_rc = row_count; v_affected := v_affected + v_rc;
    insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
    select id, auth.uid(), to_jsonb(n), 'user' from public.kg_nodes n where n.id = (v_inverse->>'node_id')::uuid;
    update public.kg_seeded_areas set status = 'archived', promoted_node_id = null, updated_at = now()
    where id = (v_inverse->>'area_id')::uuid and user_id = auth.uid();
    v_desc := 'Undid add area — the area was removed.';

  else
    raise exception 'cannot undo unknown op: %', v_op;
  end if;

  if v_affected = 0 then
    return jsonb_build_object('ok', false, 'description', 'Nothing to restore.');
  end if;

  update public.kg_edit_ops set undone_at = now() where id = v_op_id and user_id = auth.uid();

  perform public.kg__mark_portrait_dirty();

  return jsonb_build_object('ok', true, 'op', v_op, 'description', v_desc);
end;
$$;

-- ------------------------------------------------------------
-- Lock down execution: logged-in end users only, invoking as themselves.
-- ------------------------------------------------------------
revoke all on function public.kg_seed_areas_set(jsonb) from public, anon;
grant execute on function public.kg_seed_areas_set(jsonb) to authenticated;

revoke all on function public.kg_seed_area_create(text, text[]) from public, anon;
grant execute on function public.kg_seed_area_create(text, text[]) to authenticated;

revoke all on function public.kg_seed_attach_apply(uuid, jsonb) from public, anon;
grant execute on function public.kg_seed_attach_apply(uuid, jsonb) to authenticated;
