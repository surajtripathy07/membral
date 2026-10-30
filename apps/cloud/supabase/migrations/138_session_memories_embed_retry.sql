-- ============================================================
-- 138_session_memories_embed_retry.sql
-- Issue #598: a failed embedding batch during memory extraction left session_memories.embedding NULL for good (those
-- rows answered keyword search only, and nothing repaired them). This adds the same backoff marker the raw units have
-- (migration 130) and the three functions the retry needs. The TypeScript side is lib/memory/embed-retry.ts, kicked by
-- the same trigger as extraction (the hosted cron and the local in-process loop).
-- Depends on: the session_memories table (embedding, embedding_model), 121-style service_role-only grants.
--
--   1. session_memories.embedding_failed_at: set to now() when an embed batch FAILED at extraction (never when
--      embeddings are simply unconfigured or the store holds another family), bumped on every failed retry, cleared on
--      success. NULL with a NULL embedding means "never failed" (handoff rows, unconfigured stores): not retried here.
--   2. memory_embed_retry_users(p_retry_seconds, p_limit): users that have a due row, oldest marker first.
--   3. memory_embed_retry_batch(p_user_id, p_retry_seconds, p_limit): up to p_limit due rows of ONE user (id, text),
--      oldest marker first. Due = embedding NULL, marker older than p_retry_seconds on the DATABASE clock, non-empty text.
--   4. memory_embed_retry_apply(p_user_id, p_rows, p_embedding_model): p_rows is [{id, embedding|null}]. A vector sets
--      embedding + embedding_model and clears the marker; null bumps the marker to now(). Only rows of p_user_id that
--      still have a NULL embedding are touched, so a row embedded meanwhile (a re-extraction) is never overwritten.
-- Security as 121/130: SECURITY INVOKER, revoked from public/anon/authenticated, service_role only.
-- Additive: one nullable column, one partial index, three functions. Rollback: drop function
-- public.memory_embed_retry_apply(uuid, jsonb, text); drop function public.memory_embed_retry_batch(uuid, integer, integer);
-- drop function public.memory_embed_retry_users(integer, integer); drop index public.session_memories_embed_retry_idx;
-- alter table public.session_memories drop column embedding_failed_at; (the writer omits the column until it exists in
-- the types, so an older app keeps working against the new schema).
-- ============================================================

set search_path = public, extensions;

alter table public.session_memories add column if not exists embedding_failed_at timestamptz;

-- Only the retry reads this: rows whose embedding failed and has not been repaired. Tiny next to the table.
create index if not exists session_memories_embed_retry_idx
  on public.session_memories (user_id, embedding_failed_at)
  where embedding is null and embedding_failed_at is not null;

create or replace function public.memory_embed_retry_users(p_retry_seconds integer, p_limit integer)
returns setof uuid
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  select m.user_id
    from public.session_memories m
   where m.embedding is null
     and m.embedding_failed_at is not null
     and m.embedding_failed_at <= now() - make_interval(secs => p_retry_seconds)
     and btrim(m.text) <> ''
   group by m.user_id
   order by min(m.embedding_failed_at), m.user_id
   limit greatest(p_limit, 0)
$$;

create or replace function public.memory_embed_retry_batch(p_user_id uuid, p_retry_seconds integer, p_limit integer)
returns table (id uuid, text text)
language sql
stable
security invoker
set search_path = public, extensions, pg_temp
as $$
  select m.id, m.text
    from public.session_memories m
   where m.user_id = p_user_id
     and m.embedding is null
     and m.embedding_failed_at is not null
     and m.embedding_failed_at <= now() - make_interval(secs => p_retry_seconds)
     and btrim(m.text) <> ''
   order by m.embedding_failed_at, m.id
   limit greatest(p_limit, 0)
$$;

create or replace function public.memory_embed_retry_apply(p_user_id uuid, p_rows jsonb, p_embedding_model text)
returns integer
language plpgsql
volatile
security invoker
set search_path = public, extensions, pg_temp
as $$
declare
  n integer;
begin
  update public.session_memories m
     set embedding = r.embedding::vector(1536),
         embedding_model = case when r.embedding is null then m.embedding_model else p_embedding_model end,
         embedding_failed_at = case when r.embedding is null then now() end
    from jsonb_to_recordset(p_rows) as r(id uuid, embedding text)
   where m.id = r.id
     and m.user_id = p_user_id
     and m.embedding is null;
  get diagnostics n = row_count;
  return n;
end
$$;

revoke all on function public.memory_embed_retry_users(integer, integer) from public;
revoke all on function public.memory_embed_retry_users(integer, integer) from anon;
revoke all on function public.memory_embed_retry_users(integer, integer) from authenticated;
grant execute on function public.memory_embed_retry_users(integer, integer) to service_role;
revoke all on function public.memory_embed_retry_batch(uuid, integer, integer) from public;
revoke all on function public.memory_embed_retry_batch(uuid, integer, integer) from anon;
revoke all on function public.memory_embed_retry_batch(uuid, integer, integer) from authenticated;
grant execute on function public.memory_embed_retry_batch(uuid, integer, integer) to service_role;
revoke all on function public.memory_embed_retry_apply(uuid, jsonb, text) from public;
revoke all on function public.memory_embed_retry_apply(uuid, jsonb, text) from anon;
revoke all on function public.memory_embed_retry_apply(uuid, jsonb, text) from authenticated;
grant execute on function public.memory_embed_retry_apply(uuid, jsonb, text) to service_role;
