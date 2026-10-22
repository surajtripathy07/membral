-- ============================================================
-- 026_kg_entity_resolution.sql
-- Automated entity resolution + deterministic user-identity filter
-- (GitHub issue #76). Closes the "#76 seam" documented in migration 023.
--
-- WHAT THIS DOES (all reversible, all history-snapshotted):
--   1. kg__normalize_label(text)   — deterministic canonical form (lower, trim,
--      collapse whitespace, strip punctuation + diacritics). The single source of
--      truth for "same label"; mirrored verbatim in lib/kg/resolve.ts for the
--      unit tests + any client-side preview.
--   2. kg_edit_merge              — WIDENED so the cross-kind entity classes
--      (Tool / Organization / Artifact) can merge into each other ("ignore-kind"
--      resolution). Item / LifeArea / Person stay STRICTLY same-type. Every other
--      line of the migration-018/023 body is unchanged, so the merge is still
--      re-pointed, alias-folded, history-snapshotted and undoable (op 'merge').
--   3. kg_people_list / kg_person_detail — re-created to EXCLUDE
--      props.is_user_identity persons from the people surface (the owner "is never
--      a Person in their own graph"), while kg_person_detail STILL resolves a
--      flagged person by id so the flag stays reversible via a deep link.
--   4. kg_resolve_entities()      — the idempotent maintenance entrypoint. Flags
--      the owner's self-referential Person nodes, then collapses duplicate
--      entities and (conservatively) duplicate people via kg_edit_merge.
--
-- SECURITY MODEL (the migration-015 / 018 / 023 pattern):
--   * Every function is SECURITY INVOKER, so each runs as the calling end user and
--     RLS (auth.uid() = user_id on kg_nodes / kg_edges / kg_node_history /
--     kg_edit_ops / profiles) is enforced — the belt.
--   * Every table access additionally carries an explicit `user_id = auth.uid()`
--     predicate as suspenders; no caller-supplied user id exists to spoof.
--   * search_path pinned to `public, pg_temp`.
--   * EXECUTE revoked from public/anon, granted only to `authenticated`.
--
-- NORMALIZE RULE (kg__normalize_label, IMMUTABLE, no extension needed):
--   normalize(NFKD) → strip U+0300..U+036F combining marks → lower →
--   replace every run of non-alphanumerics with a single space → btrim.
--   `[[:alnum:]]` is unicode-aware under the en_US.UTF-8 ctype, so non-latin
--   letters survive (mirrors the TS `\p{L}\p{N}`). Examples:
--     "CodeHub" = "Codehub" = "codehub"; "DALL-E" = "DALL·E" = "dall e";
--     "Edward A. Murphy Jr." = "Edward A. Murphy, Jr." = "edward a murphy jr";
--     "José" = "Jose" = "jose".
--
-- REVERSIBILITY: entity + person merges go through kg_edit_merge → each records a
-- kg_edit_ops 'merge' row with a full inverse; kg_edit_undo reverses them LIFO,
-- one merge per undo (phase-1 single-step undo, per migration 018). The identity
-- flag writes a kg_node_history snapshot and is cleared by kg_person_set_identity
-- (migration 023) with p_is_self=false. Nothing is hard-deleted.
--
-- IDEMPOTENCY: re-running kg_resolve_entities after a resolved graph is a no-op —
-- every duplicate group collapses to ONE live node (the others soft-deleted), so
-- the `deleted_at is null` grouping finds no group > 1; identity flagging is
-- guarded on `is_user_identity is not already true`. No new merges, no new ops.
--
-- PIPELINE SLOT (NOT wired this issue): kg_resolve_entities is the natural
-- post-Stage-B maintenance pass (after graph-writer.ts has materialized nodes).
-- Bootstrap timing is deliberately left unchanged here; the RPC is exposed at
-- POST /api/kg/resolve-entities and can be called on demand.
--
-- Apply locally with `psql -f` (preserves fixture data), NOT `supabase db reset`.
-- ============================================================

-- ------------------------------------------------------------
-- kg__normalize_label(text): the canonical "same label" form. Deterministic +
-- IMMUTABLE so it can back GROUP BY and be reasoned about; mirrored in
-- lib/kg/resolve.ts (normalizeLabel).
-- ------------------------------------------------------------
create or replace function public.kg__normalize_label(p_label text)
returns text
language sql
immutable
security invoker
set search_path = public, pg_temp
as $$
  select btrim(regexp_replace(
    lower(regexp_replace(normalize(coalesce(p_label, ''), NFKD), E'[\\u0300-\\u036f]', '', 'g')),
    '[^[:alnum:]]+', ' ', 'g'));
$$;

revoke all on function public.kg__normalize_label(text) from public, anon;
grant execute on function public.kg__normalize_label(text) to authenticated;

-- ============================================================
-- kg_edit_merge — WIDENED for cross-kind entity resolution (issue #76).
--
-- Body is migration 023's verbatim; the ONLY change is the type gate. Previously:
-- source/target had to be the SAME type and that type in (Item, LifeArea, Person).
-- Now the entity classes Tool / Organization / Artifact may ALSO merge into each
-- other regardless of kind — "acme" the Artifact folds into "Acme"
-- the Organization — and the survivor (= target) keeps ITS OWN type. Item /
-- LifeArea / Person remain strictly same-type (a Person can NEVER merge into a
-- Tool). Everything downstream — edge re-pointing, alias absorption, history
-- snapshots, the undo inverse in kg_edit_ops — is type-agnostic and unchanged.
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

  -- Allowed merges (issue #76 widened the migration-018/023 gate):
  --   * two Items, two LifeAreas, or two Persons — SAME type (unchanged);
  --   * any two entities (Tool / Organization / Artifact) — cross-kind allowed,
  --     survivor keeps its own type.
  -- A Person can therefore never merge into a Tool, nor an Item into an Org.
  if not (
    (v_src_type = v_tgt_type and v_src_type in ('Item', 'LifeArea', 'Person'))
    or (v_src_type in ('Tool', 'Organization', 'Artifact')
        and v_tgt_type in ('Tool', 'Organization', 'Artifact'))
  ) then
    raise exception 'these two node types cannot be merged';
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

revoke all on function public.kg_edit_merge(uuid, uuid) from public, anon;
grant execute on function public.kg_edit_merge(uuid, uuid) to authenticated;

-- ============================================================
-- kg_people_list — re-created from migration 023 with ONE added filter: exclude
-- props.is_user_identity persons (the owner is never a Person in their own graph).
-- The filter is applied to BOTH the stats source (person_convs) and the listing
-- (rows) so counts and roster agree.
-- ============================================================
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
  person_convs as (
    select distinct n.id as person_id, e.source_conversation_id as conv_id
    from public.kg_nodes n
    join public.kg_edges e on (e.src_id = n.id or e.dst_id = n.id)
      and e.user_id = auth.uid() and e.deleted_at is null
      and e.source_conversation_id is not null
    where n.user_id = auth.uid() and n.type = 'Person' and n.label != '_self'
      and n.deleted_at is null and n.status is distinct from 'archived'
      and coalesce((n.props->>'is_user_identity')::boolean, false) = false
  ),
  conv_node as (
    select distinct e.source_conversation_id as conv_id, e.dst_id as node_id
    from public.kg_edges e
    where e.user_id = auth.uid() and e.deleted_at is null
      and e.rel_type in ('contributes_to', 'discusses')
      and e.source_conversation_id in (select conv_id from person_convs)
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
      and coalesce((n.props->>'is_user_identity')::boolean, false) = false
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

revoke all on function public.kg_people_list(int, int, text) from public, anon;
grant execute on function public.kg_people_list(int, int, text) to authenticated;

-- ============================================================
-- kg_person_detail — re-created from migration 023 with the identity filter added
-- to the co-occurrence CTE (a flagged owner never shows as a co-occurring person).
-- The `me` CTE is deliberately UNFILTERED: a deep link to a flagged person STILL
-- resolves, so "this is me" stays reversible from the person's own page.
-- ============================================================
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
      and coalesce((p.props->>'is_user_identity')::boolean, false) = false
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

revoke all on function public.kg_person_detail(uuid) from public, anon;
grant execute on function public.kg_person_detail(uuid) to authenticated;

-- ============================================================
-- kg_resolve_entities() — the idempotent maintenance entrypoint (issue #76).
--
-- Returns { ok, identities_flagged, entity_merges, person_merges }. Every merge
-- goes through kg_edit_merge (reversible, one kg_edit_ops row each); the identity
-- flag writes a kg_node_history snapshot and is guarded so a second run is a no-op.
--
-- SURVIVOR SELECTION (deterministic, both entity + person groups):
--   most live incident edges DESC, then earliest created_at, then id ASC.
--   The survivor keeps its own label; every variant label folds into its aliases
--   (via kg_edit_merge). For cross-kind entity groups the survivor keeps its type.
--
-- PERSON MERGE — CONSERVATIVE. Two Person nodes merge ONLY when:
--   (a) their normalized labels are IDENTICAL (case/punctuation variants of the
--       same name — "Alex Martin" ≡ "alex_martin"), OR
--   (b) one person's label appears (normalized) in another person's aliases
--       (alias merge — "Wife" → the real name).
--   Never a fuzzy/edit-distance match: "Kabir Rao" and "Kabir Rai"
--   differ by one letter and are LEFT SEPARATE. is_user_identity persons and the
--   '_self' sentinel are excluded from person-merge grouping entirely, so the
--   owner is never merged into (or away from) a real contact.
--
-- USER-IDENTITY MATCH (deterministic): self-tokens = the generic set
--   {user, current user, me, myself, i} PLUS, when profiles.display_name is set,
--   its normalized form and its no-space ("local-part") variant. A Person whose
--   normalized label is in that set is flagged props.is_user_identity=true. Bare
--   first-name matching is DELIBERATELY omitted so an unrelated contact who shares
--   the owner's first name is not swept up; the trade-off is a lone first-name
--   self-reference may remain a Person (reversible via "this is me").
-- ============================================================
create or replace function public.kg_resolve_entities()
returns jsonb
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_uid            uuid := auth.uid();
  v_display        text;
  v_norm_display   text;
  v_self_tokens    text[];
  v_ident_flagged  int := 0;
  v_entity_merges  int := 0;
  v_person_merges  int := 0;
  g                record;
  s                record;
  v_survivor       uuid;
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;

  -- ---------- 1. user-identity flag ----------
  select display_name into v_display from public.profiles where id = v_uid;
  v_norm_display := public.kg__normalize_label(coalesce(v_display, ''));
  v_self_tokens := array['user', 'current user', 'me', 'myself', 'i'];
  if v_norm_display <> '' then
    v_self_tokens := v_self_tokens
      || v_norm_display                        -- full normalized display name
      || replace(v_norm_display, ' ', '');     -- no-space ("local-part") variant
  end if;

  for s in
    select id from public.kg_nodes
    where user_id = v_uid and type = 'Person' and deleted_at is null
      and label <> '_self'
      and coalesce((props->>'is_user_identity')::boolean, false) = false
      and public.kg__normalize_label(label) = any(v_self_tokens)
  loop
    update public.kg_nodes
    set props = jsonb_set(coalesce(props, '{}'::jsonb), '{is_user_identity}', 'true'::jsonb, true),
        last_modified_by = 'user', updated_at = now()
    where id = s.id and user_id = v_uid;
    insert into public.kg_node_history (node_id, user_id, snapshot, actor_type)
    select id, v_uid, to_jsonb(n), 'user' from public.kg_nodes n where n.id = s.id;
    v_ident_flagged := v_ident_flagged + 1;
  end loop;

  -- ---------- 2. non-person entity resolution (ignore-kind) ----------
  for g in
    select public.kg__normalize_label(label) as norm
    from public.kg_nodes
    where user_id = v_uid and deleted_at is null and type in ('Tool', 'Organization', 'Artifact')
    group by public.kg__normalize_label(label)
    having count(*) > 1
  loop
    select n.id into v_survivor
    from public.kg_nodes n
    where n.user_id = v_uid and n.deleted_at is null and n.type in ('Tool', 'Organization', 'Artifact')
      and public.kg__normalize_label(n.label) = g.norm
    order by (select count(*) from public.kg_edges e
              where e.user_id = v_uid and e.deleted_at is null and e.expired_at is null
                and (e.src_id = n.id or e.dst_id = n.id)) desc,
             n.created_at asc, n.id asc
    limit 1;

    for s in
      select n.id from public.kg_nodes n
      where n.user_id = v_uid and n.deleted_at is null and n.type in ('Tool', 'Organization', 'Artifact')
        and public.kg__normalize_label(n.label) = g.norm and n.id <> v_survivor
    loop
      perform public.kg_edit_merge(s.id, v_survivor);
      v_entity_merges := v_entity_merges + 1;
    end loop;
  end loop;

  -- ---------- 3a. person resolution — identical normalized label ----------
  for g in
    select public.kg__normalize_label(label) as norm
    from public.kg_nodes
    where user_id = v_uid and deleted_at is null and type = 'Person'
      and label <> '_self'
      and coalesce((props->>'is_user_identity')::boolean, false) = false
    group by public.kg__normalize_label(label)
    having count(*) > 1
  loop
    select n.id into v_survivor
    from public.kg_nodes n
    where n.user_id = v_uid and n.deleted_at is null and n.type = 'Person'
      and n.label <> '_self'
      and coalesce((n.props->>'is_user_identity')::boolean, false) = false
      and public.kg__normalize_label(n.label) = g.norm
    order by (select count(*) from public.kg_edges e
              where e.user_id = v_uid and e.deleted_at is null and e.expired_at is null
                and (e.src_id = n.id or e.dst_id = n.id)) desc,
             n.created_at asc, n.id asc
    limit 1;

    for s in
      select n.id from public.kg_nodes n
      where n.user_id = v_uid and n.deleted_at is null and n.type = 'Person'
        and n.label <> '_self'
        and coalesce((n.props->>'is_user_identity')::boolean, false) = false
        and public.kg__normalize_label(n.label) = g.norm and n.id <> v_survivor
    loop
      perform public.kg_edit_merge(s.id, v_survivor);
      v_person_merges := v_person_merges + 1;
    end loop;
  end loop;

  -- ---------- 3b. person resolution — alias merge ----------
  -- A live Person whose label matches (normalized) an alias of ANOTHER live
  -- Person folds INTO that person (the alias-holder is the survivor). The
  -- per-iteration liveness guard makes a symmetric pair merge exactly once.
  for s in
    select src.id as src_id, tgt.id as tgt_id
    from public.kg_nodes src
    join public.kg_nodes tgt
      on tgt.user_id = v_uid and tgt.type = 'Person' and tgt.deleted_at is null
         and tgt.id <> src.id and tgt.label <> '_self'
         and coalesce((tgt.props->>'is_user_identity')::boolean, false) = false
    where src.user_id = v_uid and src.type = 'Person' and src.deleted_at is null
      and src.label <> '_self'
      and coalesce((src.props->>'is_user_identity')::boolean, false) = false
      and exists (
        select 1 from unnest(tgt.aliases) a
        where public.kg__normalize_label(a) = public.kg__normalize_label(src.label)
      )
  loop
    if exists (select 1 from public.kg_nodes where id = s.src_id and user_id = v_uid and deleted_at is null)
       and exists (select 1 from public.kg_nodes where id = s.tgt_id and user_id = v_uid and deleted_at is null) then
      perform public.kg_edit_merge(s.src_id, s.tgt_id);
      v_person_merges := v_person_merges + 1;
    end if;
  end loop;

  perform public.kg__mark_portrait_dirty();

  return jsonb_build_object(
    'ok', true,
    'identities_flagged', v_ident_flagged,
    'entity_merges', v_entity_merges,
    'person_merges', v_person_merges
  );
end;
$$;

revoke all on function public.kg_resolve_entities() from public, anon;
grant execute on function public.kg_resolve_entities() to authenticated;
