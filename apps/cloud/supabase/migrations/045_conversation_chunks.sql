-- ============================================================
-- 045_conversation_chunks.sql
-- Chunk-level chat index (goal 2026-07-26 step 11, GitHub issue #39 folded
-- in). Depends on: 001 (conversations, profiles), 044 (mcp_search_unified,
-- which this migration upgrades).
--
-- WHY THIS EXISTS (run-log 2026-07-26): the 2026-07-26 recall-eval run traced
-- misses to "whole-conversation embeddings can't rank sub-topics buried
-- inside long threads and head-truncation drops thread endings" (see
-- lib/embeddings.ts's MAX_CHAR_BUDGET truncation) -- a fact stated near the
-- end of a long conversation is invisible to both FTS (diluted by the rest of
-- the document) and the single whole-conversation embedding (which averages
-- over everything, including the truncated-away tail). `conversation_chunks`
-- gives each conversation a set of message-aligned sub-documents that can be
-- matched and cited individually.
--
-- REVISION (fresh adversarial review, 2026-07-26, NOT SOLID: 3 BLOCKER/7
-- MAJOR/5 MINOR) -- three structural fixes over the original version:
--
-- 1. FTS CONFIG: `conversation_chunks.fts` now uses 'english' (was 'simple'),
--    matching migration 044's revised code_session_turns.fts and the
--    pre-existing conversations.fts -- one search surface (natural-language
--    chat prose), one config. See 044's header for the full FTS CONFIG note
--    (kg_claims.claim_text stays 'simple' -- a different, short/structured
--    surface, migration 039/040's own convention, untouched by this).
--
-- 2. CHUNK_BEST PRE-FILTERS TO MATCHING CHUNKS (fixes BLOCKER B3 / MAJOR M1 /
--    MAJOR M6): the original `chunk_best` picked its DISTINCT ON winner over
--    ALL of a conversation's chunks with no match predicate at all, so (a) a
--    sub-threshold cosine sibling could shadow a real FTS-matching chunk and
--    drop the conversation's resolution entirely (M1), (b) it necessarily
--    sequential-scanned every chunk row per query with the GIN index unused
--    (M6 -- EXPLAIN showed a 3101-row Seq Scan), and (c) a chunk-resolved
--    row's score (bare `ts_rank(...,32)`, no length normalization) always
--    lost to the whole-conversation score, so a resolved row could never
--    outrank its own fallback -- live-proven: first resolved row at position
--    106/200 at the corpus's global minimum score; no organic query ever
--    produced `resolved: true`. Fixed by filtering to chunks that actually
--    MATCH this query's predicate (fts hit OR cosine>0.3) BEFORE the
--    DISTINCT ON, using `ts_rank(..., 33)` (normalization bitmask 1|32:
--    length-normalized AND squashed into [0,1)) so a chunk's score is
--    comparable to the whole-document score it competes against, and taking
--    GREATEST(chunk score, conversation score) as the resolved row's leg
--    score (see the RANK-THEN-FUSE note below) so resolution can only ever
--    IMPROVE a row's rank, never bury it. Because every row chunk_best now
--    produces already matched the query, "has a best matching chunk"
--    (`chunk_best` join is non-null) and "is resolved" become the same
--    condition -- no separate has-coverage-but-no-match state needs tracking
--    inside this RPC (see COVERAGE-AWARE FALLBACK below for what still does
--    need it: chunkMissingConversations' backfill scan, a different
--    question -- "has this conversation been chunked at all", answered
--    outside this RPC).
--
-- 3. ZERO-TEXT CHUNKS EXCLUDED FROM MATCHING (MAJOR M3's SQL half): a
--    zero-message conversation is chunked to a single SENTINEL row
--    (chunk_idx 0, text '', message_start/end_idx -1) by
--    lib/conversation-chunks.ts so the TS-side coverage probe stops
--    re-selecting it forever (see that file's header). This sentinel must
--    never be treated as a match -- `chunk_best`'s WHERE clause explicitly
--    excludes `cc.text = ''`.
--
-- RETRIEVAL SURFACE CHOICE (goal's "extend the unified RPC OR a second RPC
-- mcp_search_chunks -- pick the cleaner, justify"): this migration EXTENDS
-- mcp_search_unified (044) in place via `create or replace`, rather than
-- adding a second RPC. Reasoning: chunk resolution is a per-conversation
-- REFINEMENT of the same chat leg 044 already computes (same predicate, same
-- LifeArea scope CTE, same candidate conversations) -- a second RPC would
-- either duplicate that whole CTE chain or force the TS tool layer to call
-- two RPCs and merge their conversation-id sets itself, reintroducing in
-- application code exactly the coverage-aware fallback logic that reads far
-- more simply as one extra JOIN inside the existing chat leg. The search
-- tool's call site (lib/mcp/graph-tools.ts searchConversationsScoped) does
-- not change at all -- it already calls mcp_search_unified; it now just
-- receives richer chat rows.
--
-- COVERAGE-AWARE FALLBACK ("no cliff", per the goal's instruction): a chat
-- row is chunk-RESOLVED when `conversation_chunks` has at least one chunk for
-- that conversation whose own match (FTS hit, or cosine>0.3 against its own
-- embedding when one exists) actually matches THIS query (point 2 above --
-- `chunk_best` already only contains such chunks). A conversation that is
-- chunked but has no chunk matching this particular query (e.g. a term that
-- only appears when title + every message are concatenated together) falls
-- back to the exact pre-045 conversation-level rendering (title/summary/
-- whole-doc headline) -- never dropped, never left with a broken/empty
-- snippet, and (per fix 2) never ranked worse than it would have been
-- without chunking at all. A conversation with NO coverage at all (chunking
-- hasn't backfilled it yet, or embed-backfill is mid-flight) behaves
-- byte-identically to 044.
--
-- CANDIDATE POOL WIDENING: a conversation can now match via ITS CHUNKS even
-- when the whole-conversation-level predicate (044's FTS-or-cosine over the
-- concatenated doc) does not match at all -- this is the whole point (a
-- sub-topic buried in a long thread). The WHERE clause below is therefore the
-- 044 predicate OR "this conversation has a matching chunk".
--
-- ROUND-2 (fresh adversarial re-verification, 2026-07-26, SOLID with precise
-- follow-ups): three more fixes applied directly inline (see each site's own
-- comment for the full reasoning) --
--   * DOC FIX: fix 2 above overstated `ts_rank(...,33)`'s scale-comparability
--     to `ts_rank(...,32)` -- corrected in `chunk_best`'s own comment. The
--     BLOCKER-B3 fix (resolution never demotes) still holds; true cross-scale
--     comparability (chunk score actually competing on rank, not just
--     span/snippet) is deferred to the eval-informed ranking pass.
--   * MAJOR-2: `code_matches` now de-dupes to one row PER SESSION
--     (`distinct on (t.session_id)`, mirroring `chunk_best`'s own pattern) --
--     the prior version returned one row per matching TURN, so a single
--     chatty session could occupy several of the caller's limit slots and the
--     unified result carried duplicate `id`s (a code hit's `id` IS
--     `session_id` -- see graph-tools.ts). Applied identically in 044's
--     function body (see that file) so the two migrations' function text
--     doesn't silently diverge on a leg 045's header calls "unchanged from
--     044".
--   * MINOR-3: `code_matches` also now selects `s.summary`, surfaced as the
--     code leg's `summary` output field (previously hard-`null`) -- lets the
--     MCP consumer render a code hit's title via the same title-or-summary
--     fallback code-sessions/view.ts's sessionDisplayTitle() already applies
--     dashboard-side, instead of `title: null` for an untitled session.
-- ============================================================

-- ------------------------------------------------------------
-- conversation_chunks: deterministic (zero-LLM), message-boundary-aligned
-- segments of a conversation's messages (see lib/conversation-chunks.ts for
-- the chunker). Replaced wholesale per conversation on re-chunk (mirrors
-- code_session_turns' replaceTurns pattern, migration 029) -- `unique
-- (conversation_id, chunk_idx)` is the idempotency key a delete+insert by
-- conversation_id relies on, not a de-dup guard on its own.
--
-- embedding_failed_at mirrors conversations.embedding_failed_at (migration
-- 037, issue #90's permanent-failure retirement pattern): set once a chunk's
-- embedding exhausts generateEmbedding's halving budget (token-overflow
-- class only, NEVER on a transient/429 failure -- see
-- lib/conversation-chunks.ts's embedMissingChunks), so the
-- `embedding is null` backfill scan stops re-selecting a chunk that can
-- never succeed. Added directly to the CREATE TABLE here (rather than a
-- follow-up ALTER, migration 037/038's two-step shape for the conversations
-- table) because this table has no rows yet at migration-authoring time --
-- there is no existing-row backfill concern 037/038 had to solve for.
-- ------------------------------------------------------------
create table public.conversation_chunks (
  id                   uuid primary key default gen_random_uuid(),
  user_id              uuid not null references public.profiles(id) on delete cascade,
  conversation_id      uuid not null references public.conversations(id) on delete cascade,
  chunk_idx            int not null,
  message_start_idx    int not null,
  message_end_idx      int not null,
  text                 text not null,
  fts                  tsvector generated always as (to_tsvector('english', coalesce(text, ''))) stored,
  embedding            vector(1536),
  embedding_failed_at  timestamptz,
  created_at           timestamptz not null default now(),
  unique (conversation_id, chunk_idx)
);

create index idx_conversation_chunks_user_id
  on public.conversation_chunks (user_id);

create index idx_conversation_chunks_conversation_id
  on public.conversation_chunks (conversation_id, chunk_idx);

create index idx_conversation_chunks_fts
  on public.conversation_chunks using gin (fts);

-- HNSW, partial `where embedding is not null` -- matches migration 011's
-- kg_nodes.embedding index convention (nullable vector column: chunks are
-- inserted by the zero-LLM chunker first, embedded by a separate backfill
-- pass second, so `embedding is null` is the normal, expected state of a
-- freshly-chunked row, not an error state -- same shape as
-- conversations.embedding/kg_nodes.embedding). NOT ivfflat (migration 001's
-- older convention): hnsw is the newer index migration 011 already
-- established for a nullable embedding column in this codebase, and doesn't
-- need a pre-chosen `lists` parameter tuned to corpus size the way ivfflat
-- does -- appropriate for a table whose row count is unknown/growing at
-- migration time.
create index idx_conversation_chunks_embedding
  on public.conversation_chunks using hnsw (embedding vector_cosine_ops)
  where embedding is not null;

alter table public.conversation_chunks enable row level security;

create policy "conversation_chunks: users see own rows" on public.conversation_chunks
  for select using (auth.uid() = user_id);
create policy "conversation_chunks: users insert own rows" on public.conversation_chunks
  for insert with check (auth.uid() = user_id);
create policy "conversation_chunks: users update own rows" on public.conversation_chunks
  for update using (auth.uid() = user_id);
create policy "conversation_chunks: users delete own rows" on public.conversation_chunks
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- mcp_search_unified(): upgraded chat leg (see header). Signature is
-- byte-identical to 044's -- this is a `create or replace`, not a new
-- overload -- so every existing caller (lib/mcp/graph-tools.ts) keeps working
-- unchanged; it just starts receiving `chunk_idx`/`message_start_idx`/
-- `message_end_idx`/`resolved` on chat rows once chunk coverage exists. The
-- code leg (code_matches/code_ranked) is unchanged from 044 -- reproduced
-- here in full because `create or replace function` replaces the whole body.
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
  -- Single shared tsquery: conversations.fts, code_session_turns.fts, and
  -- conversation_chunks.fts all use 'english' now -- see 044's FTS CONFIG note.
  q as (
    select plainto_tsquery('english', p_query) as tsq
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
      cb.chunk_similarity
    from public.conversations c
    cross join q
    left join public.extracted_metadata em on em.conversation_id = c.id
    left join chunk_best cb on cb.conversation_id = c.id
    where c.user_id = p_user_id
      and (p_scope_id is null or c.id in (select cid from allowed_convs))
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
    order by t.session_id, ts_rank(t.fts, q.tsq, 32) desc, t.idx
  ),
  -- RANK-THEN-FUSE (B2/B3): chat leg score is GREATEST(chunk score,
  -- conversation score) when resolved -- so a chunk hit can only ever
  -- IMPROVE a row's rank over the pre-chunking baseline, never bury it below
  -- the fallback rendering's own score -- else the plain conversation score
  -- (044's original formula, unchanged for a non-resolved row).
  chat_ranked as (
    select
      cp.*,
      case when cp.resolved
        then greatest(
          coalesce(cp.chunk_fts_rank, 0), coalesce(cp.chunk_similarity, 0),
          coalesce(cp.conv_fts_rank, 0), coalesce(cp.conv_similarity, 0)
        )
        else greatest(coalesce(cp.conv_fts_rank, 0), coalesce(cp.conv_similarity, 0))
      end as leg_score,
      row_number() over (
        order by
          case when cp.resolved
            then greatest(
              coalesce(cp.chunk_fts_rank, 0), coalesce(cp.chunk_similarity, 0),
              coalesce(cp.conv_fts_rank, 0), coalesce(cp.conv_similarity, 0)
            )
            else greatest(coalesce(cp.conv_fts_rank, 0), coalesce(cp.conv_similarity, 0))
          end desc,
          cp.updated_at desc nulls last,
          cp.id
      ) as leg_rank
    from chat_pool cp
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

-- Grants: unchanged from 044 (create or replace preserves existing grants in
-- Postgres when the signature is unchanged) -- re-asserted explicitly anyway,
-- same convention migration 042 followed re-replacing 040's functions, so a
-- reader never has to go verify that claim against Postgres semantics by hand.
revoke all on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean) from public;
revoke all on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean) from anon;
revoke all on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean) from authenticated;
grant execute on function public.mcp_search_unified(uuid, text, vector(1536), int, uuid, boolean) to service_role;
