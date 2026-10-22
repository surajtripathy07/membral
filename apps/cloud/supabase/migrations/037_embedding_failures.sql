-- ============================================================
-- 037_embedding_failures.sql
-- Retires deterministically-unembeddable conversations (GitHub issue #90).
-- Depends on: 001 (profiles/conversations)
-- ============================================================
--
-- WHY: prepareTextForEmbedding's char budget can still leave a Devanagari/
-- CJK-dense conversation over text-embedding-3-small's 8192-token hard limit
-- even after the script-aware shrink + reactive halving (lib/embeddings.ts)
-- both do their best. The `embedding is null` selection in
-- conversation-embeddings.ts is the idempotency mechanism AND, without this
-- column, the permanent-retry trap: a row that always 400s sits at the head
-- of every future batch (ordered synced_at desc) forever, burning one failing
-- API call per run and never letting genuinely-new rows catch up.
--
-- embedding_failed_at is set once generateEmbedding exhausts its halving
-- budget and throws EmbeddingTokenOverflowError (conversation-embeddings.ts).
-- Nullable, no default: NULL means "never permanently failed" (the vast
-- majority of rows); this column is a soft, reversible marker, not a hard
-- delete. It IS cleared automatically — migration 038's trigger resets it to
-- NULL whenever a retired row's content is resynced with a newer
-- `updated_at`, since the app-layer upsert paths (POST /api/sync, POST
-- /api/import) don't include this column in their update payload and would
-- otherwise leave it set forever. See 038's header for the full write-order
-- reasoning.
--
-- Idempotent: `add column if not exists` is safe to re-run. No RLS changes —
-- this is a plain column on an existing table already governed by
-- conversations' own RLS policies (migration 001); nothing here grants or
-- restricts access differently.

alter table public.conversations
  add column if not exists embedding_failed_at timestamptz;

-- Serves conversation-embeddings.ts's `.is("embedding", null).is("embedding_failed_at", null)`
-- selection, ordered by synced_at desc — a partial index scoped to exactly
-- the rows that query ever matches (still-missing, not-yet-retired), rather
-- than indexing the whole table.
create index if not exists idx_conversations_embedding_pending
  on public.conversations (user_id, synced_at desc)
  where embedding is null and embedding_failed_at is null;
