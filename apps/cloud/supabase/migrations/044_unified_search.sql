-- ============================================================
-- 044_unified_search.sql
-- Unified retrieval across chat conversations AND code-session turns
-- (goal 2026-07-26 step 10, GitHub issue #87 epic slice).
--
-- NON-DESTRUCTIVE: this migration adds a new tsvector column + index on
-- code_session_turns and a new RPC. `search_conversations` / `code_context_for`
-- are untouched — the legacy repoint/drop stays gated behind 0027 M5's HUMAN
-- GATE. Nothing here drops or rewrites an existing function.
--
-- WHY THIS EXISTS (run-log 2026-07-26): the 2026-07-26 recall-eval run traced
-- one of its misses to "code-session material is unreachable from the chat
-- search surface" — a code-related query hits `search_conversations`, which
-- only ever queries `conversations`, so a session transcript in
-- `code_session_turns` (migration 029) can never surface through MCP no
-- matter how well it matches. This migration gives code_session_turns the
-- same FTS surface `conversations.fts` already has (migration 010) and adds
-- one RPC that unions both dimensions, ranked together.
--
-- REVISION (fresh adversarial review, 2026-07-26, NOT SOLID: 3 BLOCKER/7
-- MAJOR/5 MINOR): the original version of this migration used a single
-- GREATEST(ts_rank, cosine) score under one global LIMIT. Live data proved
-- that structurally broken — corpus cosine averages 0.41 (1021/1185 rows
-- above the 0.3 gate) while ts_rank tops out at 0.39, so cosine dominates and
-- the code leg (FTS-only, no embedding) returns ZERO rows at limit 10/20 the
-- moment a real query embedding is supplied, no matter how well a code turn
-- matches. Fixed below with RANK-THEN-FUSE (reciprocal rank fusion):
--
-- CROSS-LEG RANKING CHOICE (B2, revised): each leg is ranked SEPARATELY —
-- chat rows get their own `row_number() over (order by <chat leg score>
-- desc, ...)`, code rows get their own `row_number()` over the code leg's
-- score — then the two ranked streams are merged by reciprocal rank fusion:
-- `rrf = 1.0 / (60 + leg_rank)`. The final `ORDER BY rrf DESC, recency DESC`
-- (with a stable tiebreak) is what the outer LIMIT and the final jsonb_agg
-- order both use. Because the legs are disjoint (a row is either a chat hit
-- or a code hit, never both), RRF naturally interleaves them — chat#1,
-- code#1, chat#2, code#2, ... — which GUARANTEES code representation near
-- the top of any limit whenever the code leg matches at all, regardless of
-- how the two legs' raw scores compare on an absolute scale. This sidesteps
-- needing to calibrate a blend weight between two signals on different
-- scales with no eval harness yet to tune it against (the same reason the
-- original GREATEST design gave for avoiding a weighted sum) while actually
-- delivering cross-leg fairness, which GREATEST-under-one-LIMIT did not. `60`
-- is RRF's standard damping constant (diminishes the influence of rank
-- differences deep in a list; well-established from IR literature, not
-- tuned here — the eval harness, goal step 5, is the right place to
-- revisit it once there is data to tune against).
--
-- FTS CONFIG (MINOR 1, revised): `code_session_turns.fts` now uses the
-- 'english' config (stopwords + stemming), matching `conversations.fts`
-- (migration 010) — NOT the 'simple' config migration 039/040 established
-- for `kg_claims.claim_text`. This is a deliberate divergence from that
-- precedent, not an oversight: `kg_claims.claim_text` is short, structured,
-- LLM-extracted claim text where stemming/stopword removal buys little and
-- multilingual robustness matters more (that surface's own header explains
-- why). `code_session_turns.text` and `conversation_chunks.text` (migration
-- 045) are natural-language prose — commit messages, assistant narration,
-- pasted error text — the same shape of content `conversations.fts` already
-- indexes with 'english'. Query-side `plainto_tsquery` is 'english' to
-- match, for both of the NEW surfaces this migration and 045 introduce. One
-- search surface (natural-language chat/code prose), one FTS config.
--
-- SECURITY (M2, added this revision): `p_include_code` now defaults to
-- FALSE (was TRUE — a scoped call that omitted the parameter got the code
-- leg's full unbounded result with zero chat rows, a live-proven leak). The
-- invariant is ALSO encoded directly in the code leg's own WHERE clause —
-- `p_include_code AND p_scope_id IS NULL` — so even a caller that mistakenly
-- passes `p_include_code := true` alongside a `p_scope_id` never sees code
-- rows: an area-scoped API key's bound is "one LifeArea of chat", and code
-- sessions carry no LifeArea membership at all (ADR 0021 Q2), so there is no
-- way to scope them down to that key's bound other than excluding them
-- outright — the same reasoning code-tools.ts's header documents for why an
-- area-scoped key gets zero code tools. Application call sites
-- (lib/mcp/graph-tools.ts / server.ts) already pass this explicitly on every
-- path; the SQL-level default and invariant are defense in depth for any
-- caller that doesn't.
--
-- RECENCY TIEBREAK (#39, "ranking honors recency + depth where cheap"): each
-- leg's own `row_number()` ordering breaks ties by recency before falling to
-- a final stable key (row id) — `updated_at` for chat, `started_at` for
-- code. DEFERRED (documented, not implemented here): a real depth/purpose
-- weight from pass1 kg data (#39's other ask) -- no cheap read path to that
-- signal exists inside this SQL-only RPC; left for the eval-harness-informed
-- ranking pass step 5 sets up as the regression net for.
-- ============================================================

-- ------------------------------------------------------------
-- code_session_turns.fts: 'english' config (see FTS CONFIG note above).
-- Generated + stored so it back-fills every existing row automatically and
-- stays correct as new turns are imported (import.ts's replaceTurns never
-- touches this column -- it's derived).
-- ------------------------------------------------------------
alter table public.code_session_turns
  add column fts tsvector
  generated always as (to_tsvector('english', coalesce(text, ''))) stored;

create index idx_code_session_turns_fts
  on public.code_session_turns using gin (fts);

-- ------------------------------------------------------------
-- mcp_search_unified(): UNION of chat-conversation hits (migration 016's
-- mcp_search_conversations predicate, byte-for-byte: FTS('english') OR
-- cosine>0.3 when an embedding is supplied) and code-session-turn hits (FTS
-- ('english') over the new column above), tagged `source_type`, ranked
-- together per the header note (RRF, not GREATEST-under-one-LIMIT). Security
-- shape is migration 016's: SECURITY INVOKER + explicit p_user_id (never
-- auth.uid() -- /api/mcp has no Supabase session, see 016's header) + EXECUTE
-- granted to service_role only.
--
-- Signature note: the goal names the first four params
-- (p_user_id, p_query, p_query_embedding default null, p_limit default 20).
-- Two more trailing-default params extend that baseline without breaking it:
--   p_scope_id     -- the existing LifeArea scope (016's `contains` walk),
--                     applies to the CHAT leg only -- code sessions are a
--                     separate graph dimension (ADR 0021 Q2) with no LifeArea
--                     membership at all.
--   p_include_code -- whether the code leg runs, default FALSE (see SECURITY
--                     note above). `true` is passed explicitly by callers
--                     representing a fully unscoped key, matching that same
--                     key's existing code-tools access.
-- ------------------------------------------------------------
create or replace function public.mcp_search_unified(
  p_user_id uuid,
  p_query text,
  p_query_embedding vector(1536) default null,
  p_limit int default 20,
  p_scope_id uuid default null,
  p_include_code boolean default false
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
  -- Single shared tsquery: every FTS surface this RPC touches (conversations,
  -- code_session_turns) now uses the 'english' config, so one plainto_tsquery
  -- serves both legs -- no need for a second, identically-built tsquery.
  q as (
    select plainto_tsquery('english', p_query) as tsq
  ),
  chat_matches as (
    select
      c.id,
      c.title,
      c.updated_at,
      em.summary,
      case when p_query_embedding is not null then 1 - (c.embedding <=> p_query_embedding) else null end as similarity,
      -- ts_rank() returns `real` (float4); cast to float8 so it unifies
      -- cleanly with `similarity` (float8, from the pgvector `<=>` operator)
      -- everywhere the two are combined/compared below.
      ts_rank(c.fts, q.tsq, 32)::float8 as fts_rank,
      (coalesce(c.title, '') || ' ' || public.conversation_messages_text(c.messages)) as headline_source,
      q.tsq as tsq
    from public.conversations c
    left join public.extracted_metadata em on em.conversation_id = c.id
    cross join q
    where c.user_id = p_user_id
      and (p_scope_id is null or c.id in (select cid from allowed_convs))
      and (
        c.fts @@ q.tsq
        or (p_query_embedding is not null and 1 - (c.embedding <=> p_query_embedding) > 0.3)
      )
  ),
  -- DISTINCT ON (t.session_id) (round-2 adversarial re-verification of
  -- migration 045, MAJOR-2, 2026-07-26 -- fixes a live-proven bug, applied
  -- here too so this file's function text stays consistent with 045's live
  -- `create or replace` of the same function -- see that migration's header
  -- for the full reasoning): without this, the code leg returned one row PER
  -- MATCHING TURN with no session de-dup, so a single chatty session could
  -- occupy several of the caller's limit slots and the result carried
  -- duplicate `id` values (a code hit's `id` IS `session_id`). Keeps only
  -- each session's BEST-scoring turn, tiebroken by `t.idx` for a
  -- deterministic pick on an exact score tie.
  code_matches as (
    select distinct on (t.session_id)
      t.session_id,
      t.idx as turn_idx,
      s.code_project_id,
      coalesce(cp.display_name, cp.repo_identity) as project_name,
      s.title as session_title,
      s.started_at,
      ts_rank(t.fts, q.tsq, 32)::float8 as fts_rank,
      t.text as headline_source,
      q.tsq as tsq
    from public.code_session_turns t
    join public.code_sessions s on s.id = t.session_id and s.user_id = p_user_id
    join public.code_projects cp on cp.id = s.code_project_id and cp.user_id = p_user_id
    cross join q
    where t.user_id = p_user_id
      -- M2: the code leg requires BOTH the caller's opt-in AND the absence
      -- of a LifeArea scope -- see the SECURITY note above.
      and p_include_code
      and p_scope_id is null
      and t.text is not null
      and t.fts @@ q.tsq
    order by t.session_id, ts_rank(t.fts, q.tsq, 32) desc, t.idx
  ),
  -- RANK-THEN-FUSE (B2): each leg gets its own row_number() over its own
  -- leg-appropriate score. `leg_score` is exposed downstream as the row's
  -- `score` field (a within-leg confidence measure); `leg_rank` feeds RRF.
  chat_ranked as (
    select
      cm.*,
      greatest(coalesce(cm.fts_rank, 0), coalesce(cm.similarity, 0)) as leg_score,
      row_number() over (
        order by greatest(coalesce(cm.fts_rank, 0), coalesce(cm.similarity, 0)) desc,
          cm.updated_at desc nulls last,
          cm.id
      ) as leg_rank
    from chat_matches cm
  ),
  code_ranked as (
    select
      cd.*,
      coalesce(cd.fts_rank, 0) as leg_score,
      row_number() over (
        order by coalesce(cd.fts_rank, 0) desc,
          cd.started_at desc nulls last,
          cd.session_id,
          cd.turn_idx
      ) as leg_rank
    from code_matches cd
  ),
  combined as (
    select
      'chat'::text as source_type,
      cr.id as conversation_id,
      null::uuid as session_id,
      null::int as turn_idx,
      null::uuid as code_project_id,
      null::text as project_name,
      cr.title,
      cr.summary,
      cr.similarity,
      cr.leg_score as score,
      cr.updated_at as recency,
      cr.headline_source,
      cr.tsq as headline_tsq,
      'english'::regconfig as headline_cfg,
      1.0 / (60 + cr.leg_rank) as rrf
    from chat_ranked cr
    union all
    select
      'code'::text as source_type,
      null::uuid as conversation_id,
      cd.session_id,
      cd.turn_idx,
      cd.code_project_id,
      cd.project_name,
      cd.session_title as title,
      null::text as summary,
      null::float8 as similarity,
      cd.leg_score as score,
      cd.started_at as recency,
      cd.headline_source,
      cd.tsq as headline_tsq,
      'english'::regconfig as headline_cfg,
      1.0 / (60 + cd.leg_rank) as rrf
    from code_ranked cd
  ),
  top as (
    select *
    from combined
    -- Final order: RRF fusion, then recency, then a fully deterministic
    -- stable tiebreak (source_type + whichever id columns are non-null for
    -- that leg) -- ties in rrf/recency must never depend on heap order.
    order by rrf desc, recency desc nulls last, source_type, conversation_id, session_id, turn_idx
    limit greatest(p_limit, 1)
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'source_type', t.source_type,
        'conversation_id', t.conversation_id,
        'session_id', t.session_id,
        'turn_idx', t.turn_idx,
        'code_project_id', t.code_project_id,
        'project_name', t.project_name,
        'title', t.title,
        'summary', t.summary,
        'similarity', t.similarity,
        'score', t.score,
        'recency', t.recency,
        'snippet', ts_headline(
          t.headline_cfg,
          coalesce(t.headline_source, ''),
          t.headline_tsq,
          'MaxFragments=1, MaxWords=35, MinWords=15'
        )
      )
      order by t.rrf desc, t.recency desc nulls last, t.source_type, t.conversation_id, t.session_id, t.turn_idx
    ),
    '[]'::jsonb
  )
  from top t;
$$;

revoke all on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean) from public;
revoke all on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean) from anon;
revoke all on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean) from authenticated;
grant execute on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean) to service_role;
