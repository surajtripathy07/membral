-- ============================================================
-- 014_search_conversations_lock_down.sql
-- Close cross-user read vulnerability in search_conversations (L2 / INV-5)
--
-- CONFIRMED ROOT CAUSE
-- ---------------------------------------------------------------
-- 1. Migration 008 created search_conversations(text, vector, int, uuid)
--    with `search_user_id uuid default auth.uid()` as a caller-overridable
--    argument. The function is `security definer`, so it bypasses RLS on
--    `conversations` and runs with the function owner's privileges.
--
--    Postgres grants EXECUTE on newly created functions to PUBLIC by
--    default, and Supabase's `anon`/`authenticated` roles inherit that.
--    So this function was directly callable over PostgREST
--    (POST /rest/v1/rpc/search_conversations) by ANY caller holding only
--    the public anon key -- no login required -- who could pass an
--    arbitrary uuid as search_user_id and read another user's
--    conversation titles/summaries. Verified empirically on local
--    Supabase (see bead evidence): an unauthenticated anon-key request
--    supplying another user's id returned that user's conversation.
--
-- 2. Migration 012 attempted a fix by defining
--    `search_conversations(query_text, query_embedding, match_count)` --
--    a *different* 3-argument signature that derives auth.uid()
--    internally. Because Postgres resolves `create or replace function`
--    by exact signature (name + argument types), this created a SECOND,
--    separate overload instead of replacing the vulnerable one. The
--    original 4-arg overload from 008 was never dropped and stayed live
--    in the database (confirmed via `pg_proc`: two overloads coexist).
--    apps/cloud/src/lib/search.ts still calls the RPC with all 4 named
--    params (including search_user_id), which PostgREST/Postgres resolves
--    to the vulnerable 4-arg overload -- so the 012 "fix" was never
--    actually exercised by the app.
--
-- WHY WE KEEP search_user_id AS AN ARGUMENT (rather than auth.uid()-only)
-- ---------------------------------------------------------------
-- Every caller of this RPC in this codebase (src/lib/search.ts,
-- src/lib/mcp/server.ts via src/app/api/mcp/route.ts,
-- src/app/api/search/route.ts) authenticates the caller *out-of-band* --
-- either via a Supabase JWT (auth.getUser(token)) OR via a custom API key
-- (`lls_` prefix, validateApiKey() against profiles.api_key_hash) -- and
-- then talks to Postgres using SUPABASE_SERVICE_ROLE_KEY for every query,
-- including this RPC. This matches the pattern used everywhere else in
-- the codebase for service-role access (e.g. get_conversation and
-- weekly_digest in src/lib/mcp/server.ts, which use
-- `.eq("user_id", userId)` with a server-verified userId rather than RLS).
--
-- The service-role JWT carries no `sub` claim, so auth.uid() always
-- evaluates to NULL for these calls (verified empirically: calling a
-- `select auth.uid()` probe function via the service-role key returns
-- null). API-key-authenticated callers (MCP `lls_` keys) have no
-- Supabase-issued user JWT at all, so there is no JWT for auth.uid() (or
-- RLS) to key off regardless. A pure "derive from auth.uid()" fix would
-- make every one of these calls silently return zero rows -- the search
-- feature would look like it worked but would always come back empty for
-- every user, including the "fixed" 3-arg function 012 already added,
-- which is only reachable by a caller that never actually exists in this
-- codebase's request flow.
--
-- THE FIX
-- ---------------------------------------------------------------
-- search_user_id is trusted because it is only ever populated by our own
-- backend after it has independently verified the caller's identity. The
-- actual vulnerability is that arbitrary third parties (holding nothing
-- but the public anon key) could invoke this SECURITY DEFINER function
-- directly over PostgREST and supply that argument themselves, bypassing
-- our backend's identity check entirely.
--
-- So: drop every existing overload, recreate a single canonical function,
-- pin search_path, and -- the actual fix -- REVOKE EXECUTE from
-- public/anon/authenticated so the function can no longer be invoked
-- directly by any Supabase client role. Only `service_role` (never
-- exposed to end users; a server-only env var, not a NEXT_PUBLIC_ one)
-- may call it. This closes the direct-RPC IDOR path completely while
-- preserving the app's existing, necessary calling convention for both
-- JWT- and API-key-authenticated requests.
--
-- NOTE ON search_path: migration 012 pinned `search_path = public,
-- pg_temp`, omitting the `extensions` schema. `create extension vector
-- with schema extensions;` (001) installs the `<=>` operator in
-- `extensions`, not `public` -- so 012's own function, had it ever been
-- reachable, would have failed at call time with "operator does not
-- exist: vector <=> vector". Verified empirically while testing this
-- migration locally. We include `extensions` in the pinned search_path
-- below to fix this in addition to the access-control fix.
-- ============================================================

-- 1. Drop every existing overload of search_conversations by exact signature.
--    (create or replace does NOT replace a function with a different
--    argument list -- it creates a new overload -- which is exactly how
--    the vulnerable 008 overload survived migration 012. Overloads must
--    be dropped explicitly.)
drop function if exists public.search_conversations(text, vector(1536), int, uuid);
drop function if exists public.search_conversations(text, vector(1536), int);

-- 2. Recreate the single canonical function.
create function public.search_conversations(
  query_text      text,
  query_embedding vector(1536),
  match_count     int default 10,
  search_user_id  uuid default auth.uid()
)
returns table (
  id         uuid,
  source     text,
  title      text,
  created_at timestamptz,
  summary    text,
  similarity float
)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  return query
  select
    c.id,
    c.source,
    c.title,
    c.created_at,
    em.summary,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.conversations c
  left join public.extracted_metadata em on em.conversation_id = c.id
  where c.user_id = search_user_id
    and (
      c.fts @@ plainto_tsquery('english', query_text)
      or 1 - (c.embedding <=> query_embedding) > 0.3
    )
  order by similarity desc nulls last
  limit match_count;
end;
$$;

-- 3. Lock down execution: only the trusted backend (service_role) may call
--    this function directly. Ordinary Supabase roles (anon/authenticated),
--    even a legitimately logged-in end user's own session, can no longer
--    invoke it over PostgREST at all -- closing the direct-RPC IDOR path
--    regardless of what search_user_id they try to pass.
revoke all on function public.search_conversations(text, vector(1536), int, uuid) from public;
revoke all on function public.search_conversations(text, vector(1536), int, uuid) from anon;
revoke all on function public.search_conversations(text, vector(1536), int, uuid) from authenticated;
grant execute on function public.search_conversations(text, vector(1536), int, uuid) to service_role;
