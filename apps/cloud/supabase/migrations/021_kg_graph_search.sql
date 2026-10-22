-- ============================================================
-- 021_kg_graph_search.sql
-- Graph search / find-or-falsify over the user's WHOLE graph (issue #82,
-- Part A). Backs the /map search box (⌘K / "/"): "does X already exist
-- somewhere in my graph, and if so where" — the answer either deep-links to
-- an existing home, or (no rows at all) hands off to the no-results CTA,
-- which is Part B's post-hoc "add this as an area" entry point (issue #82
-- design comment, migration 022, a separate agent).
--
-- Hybrid, one round trip:
--   (a) label/alias substring match across kg_nodes: LifeArea, Item, Person,
--       Organization, Tool (Artifact and the synthetic `_self`/archived rows
--       excluded — same visibility rule as kg_read_map, migration 015).
--   (b) FTS-or-embedding match over conversations, reusing kg_conv_embeddings
--       (migration 013) — the exact predicate shape of migration 016's
--       mcp_search_conversations (fts @@ plainto_tsquery OR cosine > 0.3),
--       swapped from conversations.embedding to kg_conv_embeddings.embedding
--       per that migration's own note that Conversation kg_nodes never carry
--       an embedding. The query text is embedded client-side by the SAME
--       lib/embeddings.ts generateEmbedding() helper apps/cloud/src/lib/
--       search.ts already uses for the existing /search page (lib/kg/
--       search.ts, new file, does the call and passes the vector in) — no
--       new embedding infra.
--
-- Each kg_nodes hit is annotated with its owning LifeArea (area_id/area_label)
-- so the UI can deep-link "home":
--   * a LifeArea hit's own id is its area_id.
--   * an Item hit climbs `contains` edges upward (same climb shape as 015/016)
--     to its nearest LifeArea ancestor.
--   * a Person/Organization/Tool hit has no `contains` edge at all (entities
--     attach to the graph via mentions_person/uses_tool edges FROM a
--     conversation, never via `contains`) — so its home is inferred: walk its
--     mentioning conversations to their attach node, climb THAT to a
--     LifeArea, and pick the area with the most such conversations. Same
--     inverse of kg_read_map's people_rows assembly.
--   Best-effort: a freshly-extracted or oddly-shaped node can still resolve to
--   no area (area_id null) — the UI treats that as "in your graph, home
--   unclear" rather than hiding the hit.
--
-- SECURITY: SECURITY INVOKER, called from the browser's cookie-bound client
-- (same idiom as /api/spike's bridged ops, lib/kg/read.ts) — auth.uid() is a
-- real, trustworthy end-user session here, so every access is ALSO predicated
-- on `auth.uid()` directly (the true belt, 015's model). p_user_id is kept as
-- an explicit argument (016's model, and the shape this issue's design calls
-- for) purely as a second, redundant predicate: every table access requires
-- BOTH `user_id = p_user_id` AND `user_id = auth.uid()`, so a caller can never
-- pass someone else's p_user_id to widen what RLS + auth.uid() already scope
-- them to — it can only ever narrow the result to empty. search_path pinned
-- to `public, extensions, pg_temp` (`extensions` for the pgvector `<=>`
-- operator, per 016's own documented gotcha).
-- ============================================================

create or replace function public.kg_search_graph(
  p_user_id uuid,
  p_query_text text,
  p_query_embedding vector(1536) default null,
  p_limit int default 20
)
returns jsonb
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  with recursive
  -- ---------- (a) node label/alias substring hits ----------
  node_hits as (
    select n.id, n.type::text as ntype, n.kind, n.label, n.props->>'summary' as summary
    from public.kg_nodes n
    where n.user_id = p_user_id and n.user_id = auth.uid() and n.deleted_at is null
      and n.status is distinct from 'archived'
      and n.label != '_self'
      and n.type in ('LifeArea', 'Item', 'Person', 'Organization', 'Tool')
      and length(trim(p_query_text)) > 0
      and (
        n.label ilike '%' || p_query_text || '%'
        or exists (select 1 from unnest(n.aliases) al where al ilike '%' || p_query_text || '%')
      )
    order by (lower(n.label) = lower(trim(p_query_text))) desc, n.label
    limit greatest(p_limit, 1) * 3
  ),
  -- climb `contains` upward from every LifeArea/Item hit to its LifeArea root
  -- (a LifeArea hit climbs zero hops and resolves to itself).
  item_climb(hit_id, cur, depth) as (
    select id, id, 0 from node_hits where ntype in ('LifeArea', 'Item')
    union all
    select ic.hit_id, pe.src_id, ic.depth + 1
    from item_climb ic
    join public.kg_edges pe on pe.dst_id = ic.cur and pe.rel_type = 'contains'
      and pe.user_id = p_user_id and pe.user_id = auth.uid() and pe.deleted_at is null
    where ic.depth < 8
  ) cycle cur set is_cycle using path,
  item_area as (
    select distinct on (ic.hit_id) ic.hit_id, la.id as area_id, la.label as area_label
    from item_climb ic
    join public.kg_nodes la on la.id = ic.cur and la.type = 'LifeArea' and la.deleted_at is null
    order by ic.hit_id, ic.depth
  ),
  -- Person/Organization/Tool hits have no `contains` parent: infer a home via
  -- the conversations that mention them, climbed to their attach node's area.
  entity_convs as (
    select nh.id as hit_id, e.source_conversation_id as cid
    from node_hits nh
    join public.kg_edges e on (e.src_id = nh.id or e.dst_id = nh.id)
      and e.user_id = p_user_id and e.user_id = auth.uid() and e.deleted_at is null
      and e.source_conversation_id is not null
    where nh.ntype in ('Person', 'Organization', 'Tool')
  ),
  entity_attach as (
    select distinct on (ec.hit_id, ec.cid)
           ec.hit_id, ec.cid, ae.dst_id as node_id
    from entity_convs ec
    left join public.kg_edges ae on ae.source_conversation_id = ec.cid
      and ae.rel_type in ('contributes_to', 'discusses') and ae.user_id = p_user_id
      and ae.user_id = auth.uid() and ae.deleted_at is null
    order by ec.hit_id, ec.cid, ae.created_at desc nulls last
  ),
  entity_climb(hit_id, cur, depth) as (
    select hit_id, node_id, 0 from entity_attach where node_id is not null
    union all
    select ecl.hit_id, pe.src_id, ecl.depth + 1
    from entity_climb ecl
    join public.kg_edges pe on pe.dst_id = ecl.cur and pe.rel_type = 'contains'
      and pe.user_id = p_user_id and pe.user_id = auth.uid() and pe.deleted_at is null
    where ecl.depth < 8
  ) cycle cur set is_cycle2 using path2,
  entity_area_votes as (
    select ecl.hit_id, la.id as area_id, la.label as area_label, count(*) as votes
    from entity_climb ecl
    join public.kg_nodes la on la.id = ecl.cur and la.type = 'LifeArea' and la.deleted_at is null
    group by ecl.hit_id, la.id, la.label
  ),
  entity_area as (
    select distinct on (hit_id) hit_id, area_id, area_label
    from entity_area_votes
    order by hit_id, votes desc
  ),
  node_results as (
    select nh.id, nh.ntype as type, nh.kind, nh.label, nh.summary,
           coalesce(ia.area_id, ea.area_id) as area_id,
           coalesce(ia.area_label, ea.area_label) as area_label
    from node_hits nh
    left join item_area ia on ia.hit_id = nh.id
    left join entity_area ea on ea.hit_id = nh.id
  ),
  -- ---------- (b) conversation FTS-or-embedding hits ----------
  conv_hits as (
    select c.id, c.title, c.source, c.created_at as conv_date,
           case when p_query_embedding is not null and ce.embedding is not null
                then 1 - (ce.embedding <=> p_query_embedding)
                else null
           end as similarity
    from public.conversations c
    left join public.kg_conv_embeddings ce on ce.conversation_id = c.id and ce.user_id = p_user_id
      and ce.user_id = auth.uid()
    where c.user_id = p_user_id and c.user_id = auth.uid()
      and length(trim(p_query_text)) > 0
      and (
        c.fts @@ plainto_tsquery('english', p_query_text)
        or (p_query_embedding is not null and ce.embedding is not null
            and 1 - (ce.embedding <=> p_query_embedding) > 0.3)
      )
    order by similarity desc nulls last, c.created_at desc
    limit greatest(p_limit, 1)
  )
  select jsonb_build_object(
    'nodes',
      coalesce(
        (select jsonb_agg(to_jsonb(nr) order by (lower(nr.label) = lower(trim(p_query_text))) desc, nr.label)
         from node_results nr),
        '[]'::jsonb
      ),
    'conversations',
      coalesce(
        (select jsonb_agg(to_jsonb(ch) order by ch.similarity desc nulls last, ch.conv_date desc) from conv_hits ch),
        '[]'::jsonb
      )
  );
$$;

-- ------------------------------------------------------------
-- Lock down execution: logged-in end users only, invoking as themselves
-- (same grant shape as migration 015's bridged read RPCs).
-- ------------------------------------------------------------
revoke all on function public.kg_search_graph(uuid, text, vector(1536), int) from public;
revoke all on function public.kg_search_graph(uuid, text, vector(1536), int) from anon;
grant execute on function public.kg_search_graph(uuid, text, vector(1536), int) to authenticated;
