-- ============================================================
-- 134_drop_kg_graph.sql
-- Drop the kg_* knowledge graph and the claims/memories layer built on it
-- (goal docs/goals/2026-10-22_drop-kg-tables-and-chat-schema_goal.md, PR B;
-- PR A removed every TypeScript reader).
--
-- ORDER (Postgres does not track function-body dependencies, so a table drop
-- succeeds and a stale reader then fails at call time; hence readers first):
--   1. REWRITE the chat/code functions that still read kg_*, with no graph
--      reads: mcp_search_unified, mcp_scoped_conversation,
--      mcp_recent_conversations, project_alias_seed. Signatures and return
--      shapes are unchanged. The old LifeArea key scope (profiles.
--      api_key_scope_node_id) no longer resolves to anything, so a key that
--      still carries one FAILS CLOSED: it matches no chat or code rows. An
--      unscoped key and a code-project-scoped key behave exactly as before.
--   2. DROP the five kg_* views, then every function that reads kg_*/code_kg_* or takes a kg_* /
--      serve_candidates row type (kg_*, mcp_* graph/claims readers, claim_*
--      policy helpers, claims_lifecycle_upsert, membral_correct_write,
--      internal.claims_browse_entity_labels, internal.kg_memories_for).
--   3. DROP serve_candidates (the claim_* functions typed on it are gone).
--   4. DROP the RLS policies, then the 17 kg_* tables (children first), then the
--      three enums.
--
-- NOT DROPPED: code_kg_nodes / code_kg_edges. They are the code-session graph
-- (no FK to or from any kg_* table), still written by lib/code-sessions/
-- code-graph.ts + synthesize.ts and read by lib/code-sessions/queries.ts for
-- the /code project and session pages. Retiring them is its own change.
--
-- NOT DROPPED: profiles.api_key_scope_node_id. It has no foreign key (so
-- dropping kg_nodes does not touch it) but lib/api-keys.ts, /api/keys and the
-- settings loader still read and write it, and profiles_api_key_single_scope
-- references it. Removing the column is a follow-up with those TS callers.
--
-- BEFORE APPLYING TO PROD: take a backup (no on-demand restore points) and run
--   select count(*) from profiles where api_key_scope_node_id is not null;
-- Every such key stops returning chat results the moment this applies.
--
-- REVERTING: the dropped data is NOT recoverable from this migration; restore
-- needs the pre-apply backup. Re-creating the schema means re-running the
-- original migrations in order (011, 013, 017, 018, 022, 027, 031, 039, 049,
-- 070, 076 and the later redefinitions of the dropped functions). Restoring
-- the pre-134 bodies of the four rewritten functions means re-running
-- 102_search_tool_output_weight.sql (mcp_search_unified), 024_api_key_scope.sql
-- (mcp_scoped_conversation), 094_recent_conversations.sql
-- (mcp_recent_conversations) and 063/064's project_alias_seed.
-- ============================================================

-- ---- 1. rewrite the readers that survive ----

CREATE OR REPLACE FUNCTION public.mcp_search_unified(p_user_id uuid, p_query text, p_query_embedding vector DEFAULT NULL::vector, p_limit integer DEFAULT 20, p_scope_id uuid DEFAULT NULL::uuid, p_include_code boolean DEFAULT false, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'extensions', 'pg_temp'
AS $function$
  with
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
  -- 102: every candidate chunk, with whether its lexical match survives
  -- once tool-output paragraphs are removed (prose_match). The prose test
  -- runs only on a lexically matching chunk that carries a tool marker.
  chunk_match as (
    select
      cc.conversation_id,
      cc.chunk_idx,
      cc.message_start_idx,
      cc.message_end_idx,
      cc.text as chunk_text,
      case when p_query_embedding is not null and cc.embedding is not null
        then 1 - (cc.embedding <=> p_query_embedding) else null end as chunk_similarity,
      ts_rank(cc.fts, q.tsq, 33)::float8 as raw_fts_rank,
      (cc.fts @@ q.tsq) as fts_match,
      case
        when not (cc.fts @@ q.tsq) then false
        when cc.text !~ '\[(tool_use|tool_result|execution_output)[]:]|^[a-z_]*(_use|_result|_output)(:[^]\n]*)?\]'
          then true
        else to_tsvector('english', public.search_prose_text(cc.text)) @@ q.tsq
      end as prose_match
    from public.conversation_chunks cc
    cross join q
    where cc.user_id = p_user_id
      and cc.text <> ''
      and (
        cc.fts @@ q.tsq
        or (p_query_embedding is not null and cc.embedding is not null and 1 - (cc.embedding <=> p_query_embedding) > 0.3)
      )
  ),
  -- 102: a tool-only chunk match weighs 0.5x (chunk_tool_weight). The
  -- conversation-level weight is 0.5x only when NO lexically matching chunk
  -- of that conversation matched in prose.
  chunk_weighted as (
    select
      cm.*,
      case when cm.fts_match and not cm.prose_match then 0.5 else 1.0 end::float8 as chunk_tool_weight,
      case when bool_or(cm.fts_match) over w and not bool_or(cm.prose_match) over w
        then 0.5 else 1.0 end::float8 as conv_tool_weight
    from chunk_match cm
    window w as (partition by cm.conversation_id)
  ),
  chunk_best as (
    select distinct on (cw.conversation_id)
      cw.conversation_id,
      cw.chunk_idx,
      cw.message_start_idx,
      cw.message_end_idx,
      cw.chunk_text,
      cw.chunk_similarity,
      cw.raw_fts_rank * cw.chunk_tool_weight as chunk_fts_rank,
      cw.prose_match as chunk_prose_match,
      cw.conv_tool_weight
    from chunk_weighted cw
    order by
      cw.conversation_id,
      greatest(cw.raw_fts_rank * cw.chunk_tool_weight, coalesce(cw.chunk_similarity, 0)) desc,
      cw.chunk_idx -- MINOR: deterministic final tiebreak on an exact score tie
  ),
  chat_pool as (
    select
      c.id,
      c.title as conv_title,
      c.updated_at,
      em.summary as conv_summary,
      case when p_query_embedding is not null then 1 - (c.embedding <=> p_query_embedding) else null end as conv_similarity,
      -- 102: halved when every lexical chunk match is tool output
      -- (chunk_weighted). A conversation with no chunks yet is tested on its
      -- whole text, only when it matched lexically and carries a tool marker.
      ts_rank(c.fts, q.tsq, 32)::float8 * case
        when cb.conversation_id is not null then cb.conv_tool_weight
        when c.fts @@ q.tsq
          and public.conversation_messages_text(c.messages) ~ '\[(tool_use|tool_result|execution_output)[]:]'
          and not (
            to_tsvector('english', coalesce(c.title, '') || ' '
              || public.search_prose_text(public.conversation_messages_text(c.messages))) @@ q.tsq
          )
          then 0.5
        else 1.0
      end as conv_fts_rank,
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
      cb.chunk_prose_match,
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
      and p_scope_id is null  -- 134: a graph-scoped key (stale) matches nothing
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
      -- 102: a tool call or result turn weighs 0.5x a prose turn.
      ts_rank(t.fts, q.tsq, 32)::float8
        * case when t.kind in ('tool_result', 'tool_use') then 0.5 else 1.0 end as fts_rank,
      t.text as headline_source,
      q.tsq as tsq
    from public.code_session_turns t
    join public.code_sessions s on s.id = t.session_id and s.user_id = p_user_id
    join public.code_projects cp on cp.id = s.code_project_id and cp.user_id = p_user_id
    cross join q
    where t.user_id = p_user_id
      -- M2: the code leg requires BOTH the caller's opt-in AND the absence
      -- of a (legacy) key scope -- see 044's SECURITY note.
      and p_include_code
      and p_scope_id is null
      and t.text is not null
      and t.fts @@ q.tsq
      -- 097: a Membral tool call or result is Membral's own data echoed back.
      and (t.tool_name is null or t.tool_name !~ '^(mcp__membral__|membral_)')
      -- 095: recency bound on the session. Null p_since = no bound.
      and (p_since is null or coalesce(s.ended_at, s.started_at, s.created_at) >= p_since)
    order by
      t.session_id,
      ts_rank(t.fts, q.tsq, 32) * case when t.kind in ('tool_result', 'tool_use') then 0.5 else 1.0 end desc,
      t.idx
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
  -- 097: share of each matched session's tool_use turns that are Membral
  -- lookups; only sessions already in code_matches are aggregated.
  code_lookup as (
    select
      t.session_id,
      count(*) filter (where t.tool_name ~ '^(mcp__membral__|membral_)') as membral_calls,
      count(*) as tool_calls
    from public.code_session_turns t
    where t.user_id = p_user_id
      and t.kind = 'tool_use'
      and t.session_id in (select session_id from code_matches)
    group by t.session_id
  ),
  code_demoted as (
    select
      cd.*,
      -- Scaled, not a cliff: 1 - 0.5 x share. No Membral calls -> 1.0,
      -- a third -> ~0.83, all -> 0.5.
      coalesce(1.0 - 0.5 * cl.membral_calls::numeric / nullif(cl.tool_calls, 0), 1.0)
        as lookup_factor
    from code_matches cd
    left join code_lookup cl on cl.session_id = cd.session_id
  ),
  code_ranked as (
    select
      cd.*,
      coalesce(cd.fts_rank, 0) * cd.lookup_factor as leg_score,
      row_number() over (
        order by coalesce(cd.fts_rank, 0) * cd.lookup_factor desc,
          cd.started_at desc nulls last,
          cd.session_id,
          cd.turn_idx
      ) as leg_rank
    from code_demoted cd
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
      -- 102: cut the snippet from the prose when the chunk matched there.
      coalesce(cr.resolved and cr.chunk_prose_match, false) as headline_prose,
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
      false as headline_prose,
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
      cd.lookup_factor / (60 + cd.leg_rank) as rrf
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
        -- 102: the query's lexemes OR-ed (header, change 2), so the one
        -- fragment centres on the densest run of query terms; plainto_tsquery
        -- only ever emits '&' between lexemes, so the swap is safe.
        'snippet', ts_headline(
          t.headline_cfg,
          case when t.headline_prose
            then public.search_prose_text(coalesce(t.headline_source, ''))
            else coalesce(t.headline_source, '') end,
          coalesce(nullif(replace(t.headline_tsq::text, ' & ', ' | '), '')::tsquery, t.headline_tsq),
          'MaxFragments=1, MaxWords=35, MinWords=15'
        )
      )
      order by t.rrf desc, t.recency desc nulls last, t.source_type, t.conversation_id, t.session_id, t.turn_idx
    ),
    '[]'::jsonb
  )
  from top t;
$function$;

CREATE OR REPLACE FUNCTION public.mcp_scoped_conversation(p_user_id uuid, p_conversation_id uuid, p_scope_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select to_jsonb(c) from (
    select c.id, c.source, c.title, c.created_at, c.updated_at, c.model, c.messages, c.metadata
    from public.conversations c
    where c.id = p_conversation_id
      and c.user_id = p_user_id
      and p_scope_id is null  -- 134: a graph-scoped key (stale) sees nothing
  ) c;
$function$;

CREATE OR REPLACE FUNCTION public.mcp_recent_conversations(p_user_id uuid, p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 30, p_source text DEFAULT NULL::text, p_scope_id uuid DEFAULT NULL::uuid, p_scope_code_project_id uuid DEFAULT NULL::uuid, p_include_chat boolean DEFAULT true, p_include_code boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  with
  scoped_project as (
    select id from public.code_projects
    where user_id = p_user_id
      and p_scope_code_project_id is not null
      and id = p_scope_code_project_id
  ),
  chat_rows as (
    select
      coalesce(c.updated_at, c.created_at) as activity,
      c.id,
      jsonb_build_object(
        'type', 'chat',
        'id', c.id,
        'title', c.title,
        'source', c.source,
        'created_at', c.created_at,
        'updated_at', c.updated_at,
        'message_count', case when jsonb_typeof(c.messages) = 'array' then jsonb_array_length(c.messages) else 0 end
      ) as row
    from public.conversations c
    where c.user_id = p_user_id
      and p_include_chat
      and p_scope_code_project_id is null
      and c.source <> 'claude-code'
      and (p_source is null or c.source = p_source)
      and (p_since is null or coalesce(c.updated_at, c.created_at) >= p_since)
      and p_scope_id is null  -- 134: a graph-scoped key (stale) sees nothing
    order by coalesce(c.updated_at, c.created_at) desc nulls last, c.id
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ),
  code_rows as (
    select
      coalesce(s.ended_at, s.started_at, s.created_at) as activity,
      s.id,
      jsonb_build_object(
        'type', 'code',
        'id', s.id,
        'project_name', coalesce(cp.display_name, cp.repo_identity),
        'git_branch', s.git_branch,
        'source', s.source,
        'started_at', s.started_at,
        'ended_at', s.ended_at,
        'turn_count', s.turn_count,
        'summary', case when length(s.summary) > 200 then left(s.summary, 199) || '…' else s.summary end
      ) as row
    from public.code_sessions s
    join public.code_projects cp on cp.id = s.code_project_id and cp.user_id = p_user_id
    where s.user_id = p_user_id
      and p_include_code
      and p_scope_id is null
      and s.parent_source_session_id is null
      and (p_scope_code_project_id is null or s.code_project_id in (select id from scoped_project))
      and (p_source is null or s.source = p_source)
      and (p_since is null or coalesce(s.ended_at, s.started_at, s.created_at) >= p_since)
    order by coalesce(s.ended_at, s.started_at, s.created_at) desc nulls last, s.id
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ),
  merged as (
    select * from chat_rows
    union all
    select * from code_rows
    order by activity desc nulls last, id
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  )
  select coalesce(jsonb_agg(m.row order by m.activity desc nulls last, m.id), '[]'::jsonb)
  from merged m;
$function$;

CREATE OR REPLACE FUNCTION public.project_alias_seed(p_user uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_changed int;
  v_slug_inserted int := 0;
  v_lineage_inserted int := 0;
  v_last_run timestamptz;
begin
  -- NEW-1: both operands coalesced to a real boolean -- `IF NULL THEN` never
  -- silently skips the raise again, regardless of which claims are absent.
  if not (
    coalesce(auth.uid() = p_user, false) or coalesce(auth.role() = 'service_role', false)
  ) then
    raise exception 'project_alias_seed requires an end-user session matching p_user, or a service-role caller with an explicit p_user';
  end if;

  -- NEW-4: throttle -- a call within 10 minutes of the last one that
  -- actually did work is a no-op. Read-only up to this point; nothing has
  -- created a temp table or touched project_aliases yet, so this is cheap
  -- even on the throttled path.
  select ran_at into v_last_run from public.project_alias_seed_runs where user_id = p_user;
  if v_last_run is not null and v_last_run > now() - interval '10 minutes' then
    return jsonb_build_object(
      'inserted_total', 0, 'inserted_slug', 0, 'inserted_remote_lineage', 0, 'skipped_recent_run', true
    );
  end if;

  create temporary table tmp_pa_nodes (
    label text primary key
  ) on commit drop;

  create temporary table tmp_pa_owner (
    label text primary key,
    bare text not null,
    owner text
  ) on commit drop;

  create temporary table tmp_pa_edges (
    a text not null,
    b text not null,
    source text not null
  ) on commit drop;

  create temporary table tmp_pa_comp (
    label text primary key,
    root text not null
  ) on commit drop;

  -- Candidate labels: code project display names (134: the claims source
  -- went away with the graph tables).
  insert into tmp_pa_nodes (label)
  select distinct label from (
    select btrim(cp.display_name) as label
      from public.code_projects cp
     where cp.user_id = p_user
       and cp.display_name is not null
  ) s
  where label is not null and label <> ''
  on conflict (label) do nothing;

  -- Finding #4 (063): bare name (project_alias_normalize) + owner
  -- (project_alias_owner) per label, guarded to at least 2 characters of
  -- bare name.
  insert into tmp_pa_owner (label, bare, owner)
  select label, public.project_alias_normalize(label), public.project_alias_owner(label)
    from tmp_pa_nodes
   where length(public.project_alias_normalize(label)) >= 2;

  -- (a) normalized-slug equality, owner-aware (063 finding #4). See that
  -- migration's header for the "safe" (<=1 distinct real owner) vs
  -- "conflicted" (2+ distinct real owners -> only same-owner members edge
  -- to each other, ownerless members get NO edge at all) split.
  with grp as (
    select bare, count(distinct owner) filter (where owner is not null) as n_owners
      from tmp_pa_owner
     group by bare
    having count(*) > 1
  ),
  safe_groups as (
    select bare from grp where n_owners <= 1
  ),
  safe_reps as (
    select bare, min(label) as rep from tmp_pa_owner where bare in (select bare from safe_groups) group by bare
  ),
  safe_edges as (
    select sr.rep as a, n.label as b, 'slug' as source
      from safe_reps sr
      join tmp_pa_owner n on n.bare = sr.bare and n.label <> sr.rep
  ),
  conflicted_subgroups as (
    select bare, owner, min(label) as rep
      from tmp_pa_owner
     where bare in (select bare from grp where n_owners > 1)
       and owner is not null
     group by bare, owner
    having count(*) > 1
  ),
  conflicted_edges as (
    select cs.rep as a, n.label as b, 'slug' as source
      from conflicted_subgroups cs
      join tmp_pa_owner n on n.bare = cs.bare and n.owner = cs.owner and n.label <> cs.rep
  )
  insert into tmp_pa_edges (a, b, source)
  select a, b, source from safe_edges
  union all
  select a, b, source from conflicted_edges;

  -- (b) git-remote lineage: UNCHANGED from 060/063 -- finding #5's
  -- tightening deferred (see 063's header).
  insert into tmp_pa_edges (a, b, source)
  select g.rep, cp.display_name, 'remote-lineage'
    from (
      select repo_path, min(display_name) as rep
        from public.code_projects
       where user_id = p_user
         and repo_path is not null
         and btrim(repo_path) <> ''
         and display_name is not null
       group by repo_path
      having count(*) > 1
    ) g
    join public.code_projects cp
      on cp.user_id = p_user
     and cp.repo_path = g.repo_path
     and cp.display_name is not null
     and cp.display_name <> g.rep;

  insert into tmp_pa_comp (label, root)
  select label, label from tmp_pa_nodes
  on conflict (label) do nothing;

  -- Union-find via iterative minimum-label propagation (unchanged from
  -- 060/063).
  loop
    with sym as (
      select a, b from tmp_pa_edges
      union all
      select b, a from tmp_pa_edges
    ),
    proposal as (
      select c.label, min(c2.root) as new_root
        from tmp_pa_comp c
        join sym e on e.a = c.label
        join tmp_pa_comp c2 on c2.label = e.b
       group by c.label
    )
    update tmp_pa_comp t
       set root = p.new_root
      from proposal p
     where t.label = p.label
       and p.new_root < t.root;
    get diagnostics v_changed = row_count;
    exit when v_changed = 0;
  end loop;

  -- Canonical per component (size > 1): highest occurrence count, ties ->
  -- shortest label, ties -> alphabetical. Findings #3/#7 (063): a candidate
  -- (alias, canonical) pair is skipped whenever EITHER label already
  -- appears as an alias OR a canonical in any 'manual'/'unmerged' row for
  -- this user.
  with freq as (
    select label, count(*) as n from (
      select btrim(cp.display_name) as label
        from public.code_projects cp
       where cp.user_id = p_user and cp.display_name is not null
    ) s
    group by label
  ),
  members as (
    select tc.root, tc.label, coalesce(f.n, 0) as n
      from tmp_pa_comp tc
      left join freq f on f.label = tc.label
  ),
  sized as (
    select root from tmp_pa_comp group by root having count(*) > 1
  ),
  canonical as (
    select m.root, (array_agg(m.label order by m.n desc, length(m.label) asc, m.label asc))[1] as canon
      from members m
      join sized s on s.root = m.root
     group by m.root
  ),
  protected as (
    select alias as label from public.project_aliases where user_id = p_user and source in ('manual', 'unmerged')
    union
    select canonical as label from public.project_aliases where user_id = p_user and source in ('manual', 'unmerged')
  ),
  ins as (
    insert into public.project_aliases (user_id, canonical, alias, source)
    select
      p_user,
      can.canon,
      m.label,
      case
        when exists (
          select 1 from tmp_pa_edges e
           where e.source = 'remote-lineage' and (e.a = m.label or e.b = m.label)
        ) then 'remote-lineage'
        else 'slug'
      end
      from members m
      join canonical can on can.root = m.root
     where m.label <> can.canon
       and not exists (select 1 from protected p where p.label = m.label)
       and not exists (select 1 from protected p where p.label = can.canon)
    on conflict (user_id, alias) do nothing
    returning source
  )
  select
    count(*) filter (where source = 'slug'),
    count(*) filter (where source = 'remote-lineage')
    into v_slug_inserted, v_lineage_inserted
  from ins;

  -- NEW-4: stamp -- only on the path that actually did work.
  insert into public.project_alias_seed_runs (user_id, ran_at)
  values (p_user, now())
  on conflict (user_id) do update set ran_at = excluded.ran_at;

  return jsonb_build_object(
    'inserted_total', v_slug_inserted + v_lineage_inserted,
    'inserted_slug', v_slug_inserted,
    'inserted_remote_lineage', v_lineage_inserted,
    'skipped_recent_run', false
  );
end;
$function$;

-- ---- 2a. views that call the functions below (kg_memories calls internal.kg_memories_for) ----
drop view if exists public.kg_memories;
drop view if exists public.kg_memory_instances;
drop view if exists public.kg_active_blocks;
drop view if exists public.kg_claims_servable;
drop view if exists public.kg_claim_lifecycle_orphans;

-- ---- 2b. drop functions that read or are typed on the graph ----
-- (claim_* take a serve_candidates / kg_* row type, so they go before that view and the tables)

drop function if exists internal.claims_browse_entity_labels(p_user_id uuid, p_kind text, p_include_inferred boolean, p_include_code_projects boolean);
drop function if exists internal.kg_memories_for(p_user_id uuid, p_include_inferred boolean, p_kind text, p_person text, p_project text, p_q text, p_group_by text, p_grounding text, p_lane text, p_memory_keys text[]);
drop function if exists public.assumption_policy_ok(c serve_candidates);
drop function if exists public.claim_browse_grounding(c kg_claims, l kg_claim_lifecycle);
drop function if exists public.claim_effective_class(c serve_candidates, l kg_claim_lifecycle);
drop function if exists public.claim_grounding(c kg_claims, l kg_claim_lifecycle);
drop function if exists public.claim_is_latest_correction(c serve_candidates);
drop function if exists public.claim_not_blocked(c serve_candidates);
drop function if exists public.claim_serve_eligible(c serve_candidates, l kg_claim_lifecycle);
drop function if exists public.claims_lifecycle_upsert(p_rows jsonb);
drop function if exists public.kg__mark_portrait_dirty();
drop function if exists public.kg__normalize_label(p_label text);
drop function if exists public.kg_claims_advance_release_lock(p_user_id uuid, p_token timestamp with time zone, p_claims_projected boolean, p_claims_lag_conversations integer);
drop function if exists public.kg_claims_advance_try_lock(p_user_id uuid, p_stale_after_seconds integer);
drop function if exists public.kg_claims_browse(p_user_id uuid, p_include_inferred boolean, p_kind text, p_person text, p_project text, p_q text, p_limit integer, p_order text, p_group_by text, p_grounding text, p_offset integer, p_lane text);
drop function if exists public.kg_claims_by_code_project(p_user_id uuid, p_code_project_ids uuid[], p_include_inferred boolean, p_limit integer);
drop function if exists public.kg_claims_facets(p_user_id uuid, p_include_inferred boolean, p_lane text);
drop function if exists public.kg_edit_archive(p_node_id uuid, p_archived boolean);
drop function if exists public.kg_edit_merge(p_source_id uuid, p_target_id uuid);
drop function if exists public.kg_edit_move(p_node_id uuid, p_new_parent_id uuid);
drop function if exists public.kg_edit_rename(p_node_id uuid, p_label text);
drop function if exists public.kg_edit_set_lock(p_node_id uuid, p_field text, p_locked boolean);
drop function if exists public.kg_edit_undo();
drop function if exists public.kg_memories_browse(p_user_id uuid, p_include_inferred boolean, p_kind text, p_person text, p_project text, p_q text, p_limit integer, p_order text, p_group_by text, p_grounding text, p_offset integer, p_lane text);
drop function if exists public.kg_memories_facets(p_user_id uuid, p_include_inferred boolean, p_lane text);
drop function if exists public.kg_memory_instances_page(p_user_id uuid, p_memory_key text, p_limit integer, p_offset integer, p_include_inferred boolean, p_person text, p_project text, p_q text, p_lane text, p_grounding text);
drop function if exists public.kg_memory_keys_for_claims(p_user_id uuid, p_claim_ids uuid[]);
drop function if exists public.kg_people_list(p_limit integer, p_offset integer, p_sort text);
drop function if exists public.kg_people_scope(p_person_id uuid, p_limit integer, p_offset integer);
drop function if exists public.kg_person_detail(p_person_id uuid);
drop function if exists public.kg_person_set_identity(p_node_id uuid, p_is_self boolean);
drop function if exists public.kg_read_children(p_parent_id uuid);
drop function if exists public.kg_read_map();
drop function if exists public.kg_read_memories(p_kind text, p_limit integer);
drop function if exists public.kg_read_node_sources(p_node_id uuid);
drop function if exists public.kg_read_path(p_node_id uuid);
drop function if exists public.kg_read_pulse();
drop function if exists public.kg_read_tree_node(p_node_id uuid);
drop function if exists public.kg_resolve_entities();
drop function if exists public.kg_search_graph(p_user_id uuid, p_query_text text, p_query_embedding vector, p_limit integer);
drop function if exists public.kg_seed_area_create(p_label text, p_aliases text[]);
drop function if exists public.kg_seed_areas_set(p_areas jsonb);
drop function if exists public.kg_seed_attach_apply(p_area_node_id uuid, p_attach jsonb);
drop function if exists public.mcp_active_projects(p_user_id uuid, p_scope_id uuid);
drop function if exists public.mcp_claims_browse(p_user_id uuid, p_limit integer, p_offset integer);
drop function if exists public.mcp_claims_context(p_user_id uuid, p_query text, p_limit integer, p_include_inferred boolean);
drop function if exists public.mcp_claims_identity(p_user_id uuid, p_include_inferred boolean);
drop function if exists public.mcp_context_for(p_user_id uuid, p_query_embedding vector, p_scope_id uuid, p_seed_limit integer);
drop function if exists public.mcp_life_areas(p_user_id uuid, p_scope_id uuid);
drop function if exists public.mcp_memories_browse(p_user_id uuid, p_limit integer, p_offset integer, p_exclude_kinds text[]);
drop function if exists public.mcp_memories_context(p_user_id uuid, p_query text, p_limit integer, p_include_inferred boolean);
drop function if exists public.mcp_memories_identity(p_user_id uuid, p_include_inferred boolean);
drop function if exists public.mcp_related_conversations(p_user_id uuid, p_query_embedding vector, p_scope_id uuid, p_limit integer);
drop function if exists public.mcp_resolve_scope(p_user_id uuid, p_scope text);
drop function if exists public.mcp_scope_within(p_user_id uuid, p_bound_id uuid, p_candidate_id uuid);
drop function if exists public.mcp_search_conversations(p_user_id uuid, p_query_text text, p_query_embedding vector, p_scope_id uuid, p_limit integer);
drop function if exists public.mcp_who_is_this_user(p_user_id uuid, p_scope_id uuid, p_suppress_global boolean);
drop function if exists public.membral_correct_write(p_user_id uuid, p_correction jsonb, p_lifecycle jsonb);
drop function if exists public.verification_policy_ok(l kg_claim_lifecycle);

-- ---- 3. the last view (typed functions above are gone) ----
drop view if exists public.serve_candidates;

-- ---- 4. policies, tables (children first), enums ----
do $$
declare r record;
begin
  for r in
    select schemaname, tablename, policyname from pg_policies
    where schemaname = 'public' and tablename like 'kg\_%'
  loop
    execute format('drop policy if exists %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

drop table if exists public.kg_edge_history;
drop table if exists public.kg_node_history;
drop table if exists public.kg_edges;
drop table if exists public.kg_stage_a_tree;
drop table if exists public.kg_seeded_areas;
drop table if exists public.kg_nodes;
drop table if exists public.kg_run_metrics;
drop table if exists public.kg_bootstrap_runs;
drop table if exists public.kg_claims;
drop table if exists public.kg_claim_lifecycle;
drop table if exists public.kg_user_claims;
drop table if exists public.kg_claims_advance_state;
drop table if exists public.kg_conv_embeddings;
drop table if exists public.kg_conversations_processed;
drop table if exists public.kg_edit_ops;
drop table if exists public.kg_extraction_rejections;
drop table if exists public.kg_user_portraits;

drop type if exists public.kg_node_type;
drop type if exists public.kg_edge_type;
drop type if exists public.kg_actor_type;
