-- ============================================================
-- 102_search_tool_output_weight.sql
-- mcp_search_unified(): a match inside tool output counts half as much as a
-- match in user/assistant prose, and the snippet centres on the match.
-- Depends on: 097 (latest definition, copied here in full; same signature,
-- so plain `create or replace`, no drop). 097's Membral-lookup exclusion and
-- demotion are kept byte for byte.
-- ============================================================
--
-- WHY: a pasted tool output (an MR list, a web-search dump, a code
-- interpreter table) mentions many words once each. A query that hits only
-- that output ranked like a chat that talks about the topic, and in RRF a
-- leg's rank 1 ties the other leg's rank 1, so such hits crowded out the
-- real answers.
--
-- WHAT CHANGES
--   1. Tool output weighs 0.5x. Tool output is still
--      searched -- an error message there can be the real answer -- it only
--      counts less.
--        code leg: a turn of kind 'tool_result' or 'tool_use' (the call's
--          input, e.g. a file body, is tool traffic too) has its ts_rank
--          halved, both when picking a session's best turn and in leg_score.
--        chat leg: chunk text carries Claude.ai / ChatGPT blocks as
--          "[tool_use: x]", "[tool_result]", "[execution_output]" paragraphs
--          (see lib/conversation-view.ts). search_prose_text() below drops
--          those paragraphs; a lexical chunk match whose prose alone does
--          not match the query is a tool-only match. When every lexically
--          matching chunk of a conversation is tool-only, the chunk AND the
--          conversation ts_rank are halved (the conversation-level rank
--          dominates the chunk rank, see chunk_best's comment, so halving
--          the chunk alone would change nothing). Cosine similarity is not
--          touched: it is not a match "inside" any segment.
--   2. Snippets centre on the match: ts_headline gets the query's lexemes
--      OR-ed, not AND-ed. With AND, a query whose terms sit far apart has
--      one long cover that ts_headline splits, and the fragment it keeps can
--      stop before the clause that matters; with OR every occurrence is a
--      cover and the fragment with the most query terms wins, centred on
--      them. When a chat chunk matched in prose, the snippet is cut from the
--      prose (tool blocks removed), so it shows the talk, not the dump.
--      MaxWords/MinWords are unchanged, so the length is today's.
-- ============================================================

-- Hosted Supabase keeps pgvector in `extensions`; the function body pins its
-- own search_path too (see 084's header).
set search_path = public, extensions;

-- search_prose_text(text): the text with its tool-output paragraphs removed.
-- Paragraphs are "\n\n"-separated (claude-export.ts joins blocks that way;
-- conversation_chunks prefix each message with "[user]: " / "[assistant]: ").
-- A tool segment opens at a "[tool_use: x]", "[tool_result]" or
-- "[execution_output]" paragraph and ends at its "[/tool_...]" closer (fresh
-- imports), at the next message, or -- legacy data, no closer -- at the first
-- paragraph that no longer looks like tool output (the same idea as
-- conversation-view.ts's tool_result heuristic: JSON, bracket tags, "===",
-- tables, indented or numbered lines stay inside). Text with no tool marker
-- is returned as is, without splitting.
create or replace function public.search_prose_text(p_text text)
returns text
language plpgsql
immutable
parallel safe
set search_path = public, pg_temp
as $$
declare
  para text;
  body text;
  in_tool boolean := false;
  first boolean := true;
  kept text[] := '{}';
begin
  -- Same test as chunk_match's fast path below; keep the two in step.
  if p_text is null
    or p_text !~ '\[(tool_use|tool_result|execution_output)[]:]|^[a-z_]*(_use|_result|_output)(:[^]\n]*)?\]'
  then
    return p_text;
  end if;
  foreach para in array regexp_split_to_array(p_text, '\n\s*\n') loop
    body := regexp_replace(para, '^\[(user|assistant|system|tool)\]: ', '');
    -- A chunk can start inside a block, its opening marker cut mid-word
    -- ("ool_result]\n{...}"): that leading fragment opens a segment too.
    if body ~ '^\[(tool_use|tool_result|execution_output)(:[^]\n]*)?\]'
      or (first and body ~ '^[a-z_]*(_use|_result|_output)(:[^]\n]*)?\]')
    then
      first := false;
      -- A segment opens. A closer inside the same paragraph ends it; keep
      -- whatever follows the closer.
      in_tool := body !~ '\[/(tool_use|tool_result|execution_output)\]';
      if not in_tool then
        kept := kept || substring(body from '\[/(?:tool_use|tool_result|execution_output)\](.*)$');
      end if;
      continue;
    end if;
    first := false;
    if in_tool then
      if para ~ '^\[(user|assistant|system)\]: ' then
        in_tool := false; -- next message: fall through and keep it
      elsif body ~ '\[/(tool_use|tool_result|execution_output)\]' then
        in_tool := false;
        kept := kept || substring(body from '\[/(?:tool_use|tool_result|execution_output)\](.*)$');
        continue;
      elsif body ~ '^([\s{}"|=<]|\[|\d+[.:)]?\s)' then
        continue; -- still tool-shaped (legacy, no closer)
      else
        in_tool := false; -- legacy: prose resumed
      end if;
    end if;
    kept := kept || para;
  end loop;
  return array_to_string(array_remove(kept, ''), E'\n\n');
end;
$$;

revoke all on function public.search_prose_text(text) from public;
revoke all on function public.search_prose_text(text) from anon;
revoke all on function public.search_prose_text(text) from authenticated;
grant execute on function public.search_prose_text(text) to service_role;

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
      -- of a LifeArea scope -- see 044's SECURITY note.
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
$$;

-- Grants: service_role only, as in 044/093/095 (re-issued; idempotent).
revoke all on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean, timestamptz) from public;
revoke all on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean, timestamptz) from anon;
revoke all on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean, timestamptz) from authenticated;
grant execute on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean, timestamptz) to service_role;
