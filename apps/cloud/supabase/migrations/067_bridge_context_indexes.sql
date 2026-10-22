-- ============================================================
-- 067_bridge_context_indexes.sql
-- Perf task: GET /api/bridge/context's title-only FTS leg
-- (route.ts's `.textSearch("title", query, { type: "plain", config:
-- "english" })`, PostgREST-rendered as
-- `to_tsvector('english', title) @@ plainto_tsquery('english', $1)`) has NO
-- matching index. `idx_conversations_fts` (migration 001, widened by
-- migration 010) is generated from `coalesce(title,'') || ' ' ||
-- conversation_messages_text(messages)` — title + the ENTIRE transcript —
-- so it cannot back a title-ALONE tsvector predicate; every call to the
-- title leg falls back to a sequential scan of `conversations` (confirmed
-- live via EXPLAIN ANALYZE against the founder corpus, 1291 rows: "Seq Scan
-- on conversations ... Rows Removed by Filter: 1290", ~3.7ms at this corpus
-- size but an unindexed full-table scan that only gets slower as the corpus
-- grows).
--
-- Every OTHER read this route makes was already indexed (idx_kg_claims_
-- user_conversation for the claims query, migration 039; idx_conversations_
-- embedding's ivfflat for the semantic leg's ORDER BY ... <=>, migration
-- 001 — though the planner correctly prefers a seq scan over it at this
-- corpus's current ~1.3k-row scale; idx_conversations_fts for
-- mcp_search_unified's chat FTS leg, migration 010) — this is the one gap.
--
-- Additive only: a new expression index alongside the existing generated-
-- column index, nothing dropped or altered. `CREATE INDEX CONCURRENTLY`
-- cannot run inside a migration's implicit transaction, so this is a plain
-- `IF NOT EXISTS` (same convention several prior migrations already use,
-- e.g. 037/039/040/051) — acceptable for a table this size; a much larger
-- corpus would want this applied CONCURRENTLY by hand instead.
-- ============================================================

create index if not exists idx_conversations_title_fts
  on public.conversations
  using gin (to_tsvector('english', title));

comment on index public.idx_conversations_title_fts is
  'GET /api/bridge/context''s title-only FTS leg (route.ts) — idx_conversations_fts (migration 010) indexes title+messages together and cannot back a title-alone tsvector predicate. Migration 067.';
