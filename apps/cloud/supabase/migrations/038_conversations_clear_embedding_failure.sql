-- ============================================================
-- 038_conversations_clear_embedding_failure.sql
-- Clears conversations.embedding_failed_at (migration 037) automatically
-- when a row's content is resynced with a newer updated_at — GitHub issue
-- #90 adversarial review finding M2 ("nothing ever clears
-- embedding_failed_at despite migration + header comments promising it").
-- Depends on: 037 (embedding_failed_at column)
-- ============================================================
--
-- WHY A TRIGGER, NOT AN APPLICATION-LAYER HOOK: the natural hook is the
-- conversations upsert in POST /api/sync and POST /api/import
-- (apps/cloud/src/app/api/{sync,import}/route.ts) — both build a
-- ConversationInsert row (title/created_at/updated_at/model/messages/
-- metadata/synced_at — no embedding or embedding_failed_at field) and call
-- `.from("conversations").upsert(rows, {onConflict: "user_id,source,source_id"})`.
-- Supabase/PostgREST's generated `ON CONFLICT DO UPDATE` only assigns the
-- COLUMNS PRESENT in the payload, so embedding_failed_at (and embedding) are
-- silently left untouched on every resync, forever — exactly the bug this
-- migration closes. At the time this was written, both route files were
-- owned by a concurrent work stream (freshness-stamp instrumentation, goal
-- step 2 — see docs/goals/2026-07-26_recenter-verified-record_goal.md) and
-- off-limits to edit concurrently. A BEFORE UPDATE trigger reaches the exact
-- same outcome without touching either route, and is arguably more robust:
-- it fires for ANY current or future write path to `conversations` (a
-- script, a bulk backfill, a future route), not just the two that exist
-- today. If the two routes later grow a shared upsert helper, an
-- application-layer clear could be added there too — this trigger stays
-- correct either way, it would simply become redundant, never wrong.
--
-- SEMANTICS: conversation-embeddings.ts's `.is("embedding_failed_at", null)`
-- selection filter treats a NULL embedding_failed_at as "eligible to embed
-- (again)". This trigger clears it whenever a row that was previously
-- retired (`old.embedding_failed_at is not null`) is updated with a
-- STRICTLY NEWER `updated_at` — the same "can't cheaply know if content
-- actually changed, so key off updated_at" fallback the issue's own fix note
-- allows (an exact diff of `messages` would be the precise signal, but that
-- is not available cheaply at the row-upsert boundary). A provider that
-- sends a monotonically increasing `updated_at` on every real edit (the
-- normal case for ChatGPT/Claude/Grok's own conversation metadata) gives a
-- permanently-failed row a fresh shot the next time its source content
-- changes; a resync with an unchanged/older `updated_at` leaves the
-- retirement in place (still deterministically un-embeddable, still
-- correctly skipped by the selection filter). This intentionally does NOT
-- clear `embedding` itself — a stale-but-present embedding for genuinely
-- changed content is a pre-existing, separate gap (not introduced or
-- widened by #90) and out of scope here.
create or replace function public.conversations_clear_embedding_failure()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
begin
  if old.embedding_failed_at is not null
     and new.updated_at is not null
     and (old.updated_at is null or new.updated_at > old.updated_at)
  then
    new.embedding_failed_at := null;
  end if;
  return new;
end;
$$;

-- WHEN clause (adversarial review m-trigger): the vast majority of updates
-- to `conversations` are ordinary syncs of rows that were NEVER retired
-- (embedding_failed_at is null already — the overwhelmingly common case).
-- Postgres evaluates a trigger's WHEN condition in the executor BEFORE
-- invoking the plpgsql function at all, so this skips the function-call
-- overhead entirely for every such row instead of paying for a
-- function invocation whose body immediately no-ops. The function body
-- keeps its own `old.embedding_failed_at is not null` check too (harmless,
-- since the WHEN clause already guarantees it here) — that keeps the
-- function correct in isolation if it were ever reused by another trigger
-- without this WHEN guard. Idempotent: `drop ... if exists` + `create`.
drop trigger if exists trg_conversations_clear_embedding_failure on public.conversations;
create trigger trg_conversations_clear_embedding_failure
  before update on public.conversations
  for each row
  when (old.embedding_failed_at is not null)
  execute function public.conversations_clear_embedding_failure();
