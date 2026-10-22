-- ============================================================
-- 071_search_fts_fix.sql
-- Fix search_conversations() so /search returns the SAME top-10 conversations
-- a plainto_tsquery/ts_rank truth query returns (goal 2026-08-27 D6, #106).
--
-- REVISION 2 (fresh adversarial review round 1, scratchpad/W2_adv_round1.md,
-- NOT SOLID -- 2 blocking findings F1/F2, 3 minor F3/F4/F5): the first
-- version of this migration replaced 014's pure-cosine ordering with RRF
-- (reciprocal rank fusion) between the FTS and embedding legs -- a genuine
-- improvement over 014, but MEASURED to still fail D6 on 3 of 4 probe
-- queries (a known-title query 10/10 lane=all but 7/10 lane=chat at match_count=10;
-- routines 4/10; pronunciation 9/10). D6's actual criterion, per the
-- maintainer's decision recorded in the goal file, is SET EQUALITY with a
-- ts_rank-ordered FTS-only truth query -- RRF cannot satisfy that whenever
-- the embedding leg has candidates, because RRF is a blend of two orderings
-- and a blend equals neither input order. Algebra + live-data proof in the
-- adversarial review's F1: an FTS-only row at leg rank k scores 1/(60+k); a
-- COSINE-ONLY row (fts_hit = false) at embed-leg rank r scores 1/(60+r) and
-- wins whenever r < k -- so up to 9 text-irrelevant rows can eject true FTS
-- matches from a limit-10 result. Confirmed live: for a query for a known chat title,
-- position 3 of the RRF result was an unrelated chat (fts_hit =
-- false) ejecting the true rank-10 FTS match; for another such query, position 1
-- was an unrelated chat (fts_hit = false) ranked ABOVE every
-- true keyword match.
--
-- THIS REVISION drops RRF and makes the FTS leg (ranked by ts_rank, exactly
-- the truth query's own ordering) STRICTLY DOMINANT: every fts_hit row sorts
-- ahead of every non-fts_hit row, ordered by ts_rank among themselves; the
-- embedding leg only fills whatever slots are left once every FTS match that
-- fits has been placed. `ts_rank(fts, tsq, 32) = rank/(rank+1)` is strictly
-- monotonic in the truth query's own `ts_rank(fts, tsq)` (norm 0), so within
-- the FTS-hit group this ORDER BY reproduces the truth query's order exactly
-- -- not just its set. Re-measured with real embeddings inside the same
-- BEGIN/ROLLBACK transaction used for the first version: 10/10, 10/10, 9/9,
-- 10/10 against the (unlaned, D6-literal) truth query on all four probes --
-- full D6 set equality, not just improvement. Semantic recall is not lost:
-- once every FTS match that fits within match_count is placed, remaining
-- slots are still filled by embedding-only rows in similarity order (the
-- 014 behavior, unchanged for the case fts_hit is false everywhere -- see
-- SEMANTIC-MODE COMPATIBILITY below). This is a real product trade-off
-- (hybrid search's semantic blend no longer competes with a true keyword
-- match for a slot that keyword match would win outright) and is deliberate
-- per the maintainer's D6 wording, not an oversight -- if the maintainer's
-- eventual 3 queries (goal file W0) want blended ranking instead, D6's own
-- truth-query wording needs to change, not this function.
--
-- F2 (lane pushed into the RPC, BLOCKING): 014/rev-1 had no lane/source
-- awareness at all -- lib/search.ts filtered post-hoc in TS, AFTER the RPC's
-- own LIMIT had already run. Because /search defaults to lane='chat'
-- (excludes source='claude-code', ADR 0039 W6/D7), a query whose raw top-N
-- included code-lane rows came back SHORT of match_count once those rows
-- were dropped post-limit (measured: a known-title query returned only 7 of 10
-- requested rows in chat lane at match_count=10) -- a short page can never
-- satisfy set equality against a 10-row truth query regardless of ranking.
-- Fixed by adding a trailing p_lane parameter (default 'all', so every
-- existing call site that doesn't pass it keeps 014/rev-1's unfiltered
-- behavior) and applying it in the WHERE clause, BEFORE the LIMIT, so lane
-- filtering can never under-fill a page again. Reviewer confirmed
-- search_conversations has exactly one caller in this codebase
-- (lib/search.ts) -- mcp_search_unified (migration 044/045) is a SEPARATE
-- function used by the MCP "search_conversations" tool and
-- /api/bridge/context, never this one -- so the old 4-arg overload is
-- dropped outright rather than kept as a second overload (which is exactly
-- how migration 014's own predecessor bug -- two coexisting overloads --
-- happened; see 014's header).
--
-- F3 (P3, `greatest(match_count, 1)`): rev-1 silently changed match_count=0
-- from 014's "0 rows" to "1 row" and match_count<0 from an ERROR to "1 row".
-- Neither is reachable from the app (route.ts clamps limit to [1,50] before
-- it ever reaches this function), but the change was undocumented. THIS
-- REVISION drops `greatest()` entirely and passes match_count straight to
-- LIMIT, restoring 014's exact behavior for both edge cases (0 -> 0 rows,
-- negative -> "ERROR: LIMIT must not be negative") -- simpler than
-- documenting a new behavior nothing exercises.
--
-- F5 (P4, positive, now stated): 95 of 1,286 founder conversations (7.4%)
-- have embedding IS NULL. Under 014, `similarity` was NULL for these and
-- `order by similarity desc nulls last` sorted them dead last -- so even an
-- EXACT TITLE MATCH on one of these rows was effectively unreachable via
-- /search once the corpus had 10+ higher-similarity rows for any query.
-- Both this revision and rev-1 fix this as a side effect of ranking FTS
-- matches by ts_rank instead of cosine: a null-embedding row with a true FTS
-- hit now ranks by its ts_rank like any other FTS match, embedding-null or
-- not (the CASE in the `matches` CTE makes similarity NULL for these rows
-- specifically so they never enter the embed leg, but fts_hit/fts_rank are
-- computed from `conversations.fts`, which does not depend on `embedding`
-- at all). Real recall recovery, not a comment-only note -- worth citing on
-- #106.
--
-- SCOPE / BLAST RADIUS: unchanged from rev-1's note -- search_conversations
-- is called from exactly one application code path (lib/search.ts, both the
-- hybrid/semantic branch and, as of this revision, keywordSearch()'s
-- relevance-ordered fallback -- see lib/search.ts's own comments for why
-- that's safe). Return columns (id, source, title, created_at, summary,
-- similarity) are UNCHANGED. Only the identity signature grows a trailing
-- defaulted parameter, so this migration must DROP the old 4-arg overload
-- first (create-or-replace does not change a function's argument list --
-- see 014's header for the exact overload-coexistence bug this avoids).
--
-- SEMANTIC-MODE COMPATIBILITY: /search's semantic mode calls this RPC with
-- query_text = "" (lib/search.ts). plainto_tsquery('english', '') matches no
-- row, so fts_hit is false for every candidate and ordering collapses to
-- `similarity desc nulls last, id` -- the embedding-only ranking semantic
-- mode always had, unchanged by this migration.
-- ============================================================

drop function if exists public.search_conversations(text, vector(1536), int, uuid);

create function public.search_conversations(
  query_text      text,
  query_embedding vector(1536),
  match_count     int default 10,
  search_user_id  uuid default auth.uid(),
  p_lane          text default 'all'
)
returns table (
  id         uuid,
  source     text,
  title      text,
  created_at timestamptz,
  summary    text,
  similarity float
)
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  with q as (
    select plainto_tsquery('english', query_text) as tsq
  ),
  matches as (
    select
      c.id,
      c.source,
      c.title,
      c.created_at,
      em.summary,
      case
        when query_embedding is not null then 1 - (c.embedding <=> query_embedding)
        else null
      end as similarity,
      ts_rank(c.fts, q.tsq, 32)::float8 as fts_rank,
      (c.fts @@ q.tsq) as fts_hit
    from public.conversations c
    left join public.extracted_metadata em on em.conversation_id = c.id
    cross join q
    where c.user_id = search_user_id
      and (p_lane = 'all' or (p_lane = 'chat' and c.source <> 'claude-code') or (p_lane = 'code' and c.source = 'claude-code'))
      and (
        c.fts @@ q.tsq
        or (query_embedding is not null and 1 - (c.embedding <=> query_embedding) > 0.3)
      )
  )
  -- STRICT FTS DOMINANCE (F1): every fts_hit row sorts ahead of every
  -- non-hit row, ordered by ts_rank (== truth query's own order) among
  -- themselves; embedding-only rows fill whatever slots remain, by
  -- similarity. This is what makes the FTS-hit group's ORDER, not just its
  -- membership, identical to the D6 truth query's own ts_rank ordering.
  select id, source, title, created_at, summary, similarity
  from matches
  order by fts_hit desc, fts_rank desc, similarity desc nulls last, id
  limit match_count;
$$;

-- Access control unchanged from 014 -- service_role only.
revoke all on function public.search_conversations(text, vector(1536), int, uuid, text) from public;
revoke all on function public.search_conversations(text, vector(1536), int, uuid, text) from anon;
revoke all on function public.search_conversations(text, vector(1536), int, uuid, text) from authenticated;
grant execute on function public.search_conversations(text, vector(1536), int, uuid, text) to service_role;

-- PostgREST caches RPC signatures; the signature changed (p_lane added), so ask it to reload.
notify pgrst, 'reload schema';
