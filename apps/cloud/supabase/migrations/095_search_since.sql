-- ============================================================
-- 095_search_since.sql
-- mcp_search_unified(): optional recency bound `p_since`.
-- Depends on: 093 (latest definition, copied here in full).
-- ============================================================
--
-- WHY: an agent asked for "the chat I had yesterday about X" could not bound
-- search by time.
--
-- WHAT CHANGES: a trailing `p_since timestamptz default null`. Adding a
-- parameter to `create or replace` would create an OVERLOAD, so the exact
-- 093 signature is dropped first and grants are re-issued for the new one.
--   chat leg: keeps conversations with coalesce(updated_at, created_at) >= p_since
--   code leg: keeps sessions with coalesce(ended_at, started_at, created_at) >= p_since
-- With p_since null the body is 093's, row for row.
-- ============================================================

-- Hosted Supabase keeps pgvector in `extensions`; the function body pins its
-- own search_path too (see 084's header).
set search_path = public, extensions;

drop function if exists public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean);

create or replace function public.mcp_search_unified(
  p_user_id uuid,
  p_query text,
  p_query_embedding vector(1536) default null,
  p_limit int default 20,
  p_scope_id uuid default null,
  p_include_code boolean default false,
  p_since timestamptz default null
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
  -- Single shared tsquery: conversations.fts, code_session_turns.fts, and
  -- conversation_chunks.fts all use 'english' now -- see 044's FTS CONFIG note.
  -- q_lex (093): the query's distinct lexemes, same 'english' parser and
  -- dictionaries plainto_tsquery uses, so it is exactly the term set `tsq`
  -- ANDs together. Used only for title coverage in chat_pool.
  q as (
    select
      plainto_tsquery('english', p_query) as tsq,
      tsvector_to_array(to_tsvector('english', coalesce(p_query, ''))) as q_lex
  ),
  -- Best MATCHING chunk per conversation (fix 2, migration header): filters
  -- to chunks that actually match THIS query's predicate BEFORE the
  -- DISTINCT ON, so a non-matching sibling can never shadow a real hit and
  -- the GIN index has a usable predicate to work with (was a bare seq scan
  -- of every chunk, M6). `ts_rank(..., 33)` = normalization bitmask 1|32:
  -- length-normalized (option 1) AND squashed into [0,1) (option 32).
  --
  -- MEASURED CORRECTION (round-2 adversarial re-verification, 2026-07-26):
  -- this comment used to claim bitmask 33 is "comparable in scale" to the
  -- whole-conversation `ts_rank(..., 32)` it's GREATEST-ed against below.
  -- Live measurement refuted that: bitmask 33's extra `/(1+log(length))`
  -- divisor makes a chunk's score ~4-10x SMALLER than a conversation-level
  -- 32-score for the same match quality (a chunk is short, so
  -- `1+log(length)` barely discounts 32's rank at all, while it heavily
  -- discounts 33's) -- so in practice GREATEST(chunk score, conv score)
  -- ALWAYS picks the conversation-level score, never the chunk score. This
  -- does NOT reintroduce bug B3 (a resolved row still never scores below its
  -- own conversation-level baseline -- see RANK-THEN-FUSE below and the
  -- oracle test's REGRESSION GUARD) -- resolution still never DEMOTES a
  -- row's rank, which is the blocker B3 fixed. What's still missing: chunk
  -- resolution therefore affects the returned snippet/message-span (which
  -- chunk a hit points at) but never the row's actual RANK today -- true
  -- cross-scale comparability between a chunk score and a whole-document
  -- score is DEFERRED, not delivered by bitmask 33 alone. Candidate fix (not
  -- implemented here): apply the SAME normalization scheme to both sides in
  -- the eval-harness-informed ranking pass (goal step 5's follow-on), rather
  -- than assuming ts_rank's bitmask options make two differently-sized
  -- documents' scores commensurate on their own.
  --
  -- `cc.text <> ''` excludes the zero-message sentinel row (fix 3) -- it
  -- never matches any real query, but exclude it explicitly rather than
  -- relying on that incidentally being true (an empty tsvector's `@@` is
  -- always false, but a stray future sentinel-adjacent change should not
  -- silently start "matching" via a similarity fluke).
  chunk_best as (
    select distinct on (cc.conversation_id)
      cc.conversation_id,
      cc.chunk_idx,
      cc.message_start_idx,
      cc.message_end_idx,
      cc.text as chunk_text,
      case when p_query_embedding is not null and cc.embedding is not null
        then 1 - (cc.embedding <=> p_query_embedding) else null end as chunk_similarity,
      ts_rank(cc.fts, q.tsq, 33)::float8 as chunk_fts_rank
    from public.conversation_chunks cc
    cross join q
    where cc.user_id = p_user_id
      and cc.text <> ''
      and (
        cc.fts @@ q.tsq
        or (p_query_embedding is not null and cc.embedding is not null and 1 - (cc.embedding <=> p_query_embedding) > 0.3)
      )
    order by
      cc.conversation_id,
      greatest(
        coalesce(ts_rank(cc.fts, q.tsq, 33), 0),
        coalesce(
          case when p_query_embedding is not null and cc.embedding is not null
            then 1 - (cc.embedding <=> p_query_embedding) else null end,
          0
        )
      ) desc,
      cc.chunk_idx -- MINOR: deterministic final tiebreak on an exact score tie
  ),
  chat_pool as (
    select
      c.id,
      c.title as conv_title,
      c.updated_at,
      em.summary as conv_summary,
      case when p_query_embedding is not null then 1 - (c.embedding <=> p_query_embedding) else null end as conv_similarity,
      ts_rank(c.fts, q.tsq, 32)::float8 as conv_fts_rank,
      (coalesce(c.title, '') || ' ' || public.conversation_messages_text(c.messages)) as conv_headline_source,
      q.tsq as conv_tsq,
      -- Every row chunk_best produces already matched this query (fix 2) --
      -- "has a best matching chunk" and "is resolved" are the same thing.
      (cb.conversation_id is not null) as resolved,
      cb.chunk_idx,
      cb.message_start_idx,
      cb.message_end_idx,
      cb.chunk_text,
      cb.chunk_fts_rank,
      cb.chunk_similarity,
      -- TITLE BOOST (093): conversations.fts weights title and body equally
      -- and ts_rank(..., 32) saturates near 0.5, so a chat titled exactly like
      -- the query could rank below a long chat that merely mentions every
      -- term. Only candidate-pool rows pay for this per-row title tsvector.
      --   all query terms in title  -> +1.0 (above any body-only score, which
      --                                is < 1.0 by construction)
      --   >= 60% of query lexemes   -> +0.3 x coverage
      --   otherwise                 -> 0
      case
        when to_tsvector('english', coalesce(c.title, '')) @@ q.tsq then 1.0::float8
        when tc.coverage >= 0.6 then 0.3 * tc.coverage
        else 0::float8
      end as title_boost
    from public.conversations c
    cross join q
    left join public.extracted_metadata em on em.conversation_id = c.id
    left join chunk_best cb on cb.conversation_id = c.id
    cross join lateral (
      select (
        select count(*) from unnest(q.q_lex) as l(lex)
        where l.lex = any(tsvector_to_array(to_tsvector('english', coalesce(c.title, ''))))
      )::float8 / nullif(cardinality(q.q_lex), 0) as coverage
    ) tc
    where c.user_id = p_user_id
      and (p_scope_id is null or c.id in (select cid from allowed_convs))
      -- 095: recency bound. Null p_since = no bound (093 behaviour).
      and (p_since is null or coalesce(c.updated_at, c.created_at) >= p_since)
      and (
        c.fts @@ q.tsq
        or (p_query_embedding is not null and 1 - (c.embedding <=> p_query_embedding) > 0.3)
        -- CANDIDATE POOL WIDENING: matched via its OWN chunk even when the
        -- whole-document predicate above does not match at all.
        or cb.conversation_id is not null
      )
  ),
  -- DISTINCT ON (t.session_id) (round-2 adversarial re-verification, MAJOR-2,
  -- 2026-07-26 -- fixes a live-proven bug): the pre-fix version returned one
  -- row PER MATCHING TURN with no session de-dup at all -- a single chatty
  -- session with several matching turns could occupy multiple slots of the
  -- caller's limit (live: one session took 3 of 19 code slots) and the
  -- returned array carried duplicate `id` values (toUnifiedResult's `id` for
  -- a code hit IS `session_id` -- see graph-tools.ts's own doc comment on
  -- that field, which this bug directly contradicted). Fixed by mirroring
  -- chunk_best's pattern (migration header, fix 2): DISTINCT ON per session,
  -- keeping only that session's BEST-scoring turn, tiebroken by `t.idx` for a
  -- fully deterministic pick when two turns in the same session tie on rank.
  -- `s.summary` is also selected here now (MINOR-3 fix, round-2 review): lets
  -- the code leg's `title` fall back to a session's summary the same way
  -- code-sessions/view.ts's sessionDisplayTitle() already does for the /code
  -- dashboard, instead of surfacing `title: null` for a session that was
  -- never given an explicit title (live: 65/68 sessions) -- see
  -- graph-tools.ts's toUnifiedResult for the consumer side of this fix.
  code_matches as (
    select distinct on (t.session_id)
      t.session_id,
      t.idx as turn_idx,
      s.code_project_id,
      coalesce(cp.display_name, cp.repo_identity) as project_name,
      s.title as session_title,
      s.summary as session_summary,
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
      -- of a LifeArea scope -- see 044's SECURITY note.
      and p_include_code
      and p_scope_id is null
      and t.text is not null
      and t.fts @@ q.tsq
      -- 095: recency bound on the session. Null p_since = no bound.
      and (p_since is null or coalesce(s.ended_at, s.started_at, s.created_at) >= p_since)
    order by t.session_id, ts_rank(t.fts, q.tsq, 32) desc, t.idx
  ),
  -- RANK-THEN-FUSE (B2/B3): chat leg base score is GREATEST(chunk score,
  -- conversation score) when resolved -- so a chunk hit can only ever
  -- IMPROVE a row's rank over the pre-chunking baseline, never bury it below
  -- the fallback rendering's own score -- else the plain conversation score
  -- (044's original formula, unchanged for a non-resolved row).
  -- 093: leg_score = base + title_boost (see chat_pool). The boost is added
  -- AFTER the greatest(), so resolved-never-demotes still holds, and the
  -- returned `score` is this boosted leg_score (it can now exceed 1.0; a
  -- score >= 1.0 on a chat row means "every query term is in the title").
  chat_scored as (
    select
      cp.*,
      case when cp.resolved
        then greatest(
          coalesce(cp.chunk_fts_rank, 0), coalesce(cp.chunk_similarity, 0),
          coalesce(cp.conv_fts_rank, 0), coalesce(cp.conv_similarity, 0)
        )
        else greatest(coalesce(cp.conv_fts_rank, 0), coalesce(cp.conv_similarity, 0))
      end + cp.title_boost as leg_score
    from chat_pool cp
  ),
  chat_ranked as (
    select
      cs.*,
      row_number() over (
        order by cs.leg_score desc, cs.updated_at desc nulls last, cs.id
      ) as leg_rank
    from chat_scored cs
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
      cr.conv_title as title,
      case when cr.resolved then null else cr.conv_summary end as summary,
      cr.conv_similarity as similarity,
      cr.leg_score as score,
      cr.updated_at as recency,
      case when cr.resolved then cr.chunk_text else cr.conv_headline_source end as headline_source,
      -- Same tsq regardless of resolved/fallback: chunk and conversation FTS
      -- now share one 'english' tsquery (see the `q` CTE) -- no branch needed.
      cr.conv_tsq as headline_tsq,
      'english'::regconfig as headline_cfg,
      case when cr.resolved then cr.chunk_idx else null end as chunk_idx,
      case when cr.resolved then cr.message_start_idx else null end as message_start_idx,
      case when cr.resolved then cr.message_end_idx else null end as message_end_idx,
      cr.resolved as resolved,
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
      -- MINOR-3 fix: a code hit's `summary` is no longer hard-null -- it
      -- carries the session's own summary so a null-titled session can still
      -- render via sessionDisplayTitle()'s title-or-summary fallback (see the
      -- code_matches CTE comment above and graph-tools.ts's toUnifiedResult).
      cd.session_summary as summary,
      null::float8 as similarity,
      cd.leg_score as score,
      cd.started_at as recency,
      cd.headline_source,
      cd.tsq as headline_tsq,
      'english'::regconfig as headline_cfg,
      null::int as chunk_idx,
      null::int as message_start_idx,
      null::int as message_end_idx,
      -- A code turn is already the atomic, already-resolved unit (there is
      -- no coarser "code session as a whole" fallback rendering to fall back
      -- to) -- `resolved: true` here means the same thing `resolved: true`
      -- means on a chat row: "this hit points at a specific span, not a
      -- whole-document title."
      true as resolved,
      1.0 / (60 + cd.leg_rank) as rrf
    from code_ranked cd
  ),
  top as (
    select *
    from combined
    -- Final order: RRF fusion, then recency, then a fully deterministic
    -- stable tiebreak.
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
        'resolved', t.resolved,
        'chunk_idx', t.chunk_idx,
        'message_start_idx', t.message_start_idx,
        'message_end_idx', t.message_end_idx,
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

-- Grants: service_role only, as in 044/093, re-issued for the new signature.
revoke all on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean, timestamptz) from public;
revoke all on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean, timestamptz) from anon;
revoke all on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean, timestamptz) from authenticated;
grant execute on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean, timestamptz) to service_role;
