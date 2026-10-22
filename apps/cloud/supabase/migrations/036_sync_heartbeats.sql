-- ============================================================
-- 036_sync_heartbeats.sql
-- Per-source sync heartbeats + freshness RPC (goal: recenter on the verified
-- record, step 2 — GitHub #63 silent-breakage class, #58 adjacent).
-- Depends on: 001 (profiles), 029 (code_sessions/code_projects).
-- ============================================================
--
-- WHY: the chat corpus went silently stale for ~12 weeks (#63) and nobody
-- noticed — there was no per-source signal anywhere (MCP responses, /pulse,
-- the extension) that said "this is how current your data is." This
-- migration adds the durable heartbeat a writer records on every successful
-- ingest, plus a read RPC that combines it with the content itself (so
-- freshness is never solely dependent on the heartbeat writer having run —
-- see mcp_freshness below).
--
-- TABLE DESIGN: one row per (user, source) — 'claude'/'chatgpt'/'grok' (chat,
-- written by /api/sync and /api/import) and 'code' (written by
-- POST /api/code-sessions). last_run_at is "when an ingest for this source
-- last completed successfully"; last_item_at is "the newest content
-- timestamp seen in that ingest batch" (nullable — a batch can be all-skip/
-- all-error and still worth recording the run). meta is an open jsonb bag
-- for whatever a writer wants to attach later (batch size, error counts) —
-- never load-bearing for the freshness computation itself.
--
-- RLS: owner-only, same four-policy shape as migration 029's code_* tables
-- (auth.uid() = user_id) — a heartbeat is user-visible data, not a
-- service-role secret, and a future dashboard surface may want to read it
-- directly. WRITES in practice only ever come from the service-role ingest
-- routes (which bypass RLS), but the policies exist so an owner's own
-- cookie-bound session could read/write its own rows too, consistent with
-- 029's rationale.
--
-- RPC: mcp_freshness(p_user_id uuid) follows migration 016/030's convention
-- exactly, NOT migration 015's auth.uid()-based one — every mcp_* RPC that
-- backs /api/mcp takes an explicit p_user_id because that route authenticates
-- via a service-role connection with no Supabase session (auth.uid() is NULL
-- there, per 016's header). SECURITY INVOKER, EXECUTE revoked from
-- public/anon/authenticated, granted only to service_role — the 016 pattern.
-- The /pulse route (cookie-bound session) also calls this same RPC through a
-- short-lived service-role client with its own server-verified userId
-- (mirroring how lib/mcp/graph-tools.ts already does this for the chat
-- tools) rather than a second auth.uid()-based RPC — one freshness
-- computation, two callers.
-- ------------------------------------------------------------

create table if not exists public.sync_heartbeats (
  user_id       uuid not null references public.profiles(id) on delete cascade,
  source        text not null,
  last_run_at   timestamptz not null,
  last_item_at  timestamptz,
  meta          jsonb not null default '{}'::jsonb,
  updated_at    timestamptz not null default now(),
  primary key (user_id, source)
);

comment on table public.sync_heartbeats is
  'One row per (user, source) — source in (''claude'',''chatgpt'',''grok'',''code''). Upserted by the ingest routes (POST /api/sync, /api/import, /api/code-sessions) on every successful batch. Backs mcp_freshness() below — the per-source freshness stamp on every MCP tool response, /pulse, and the extension badge (goal 2026-07-26, #63/#58).';

alter table public.sync_heartbeats enable row level security;

drop policy if exists "sync_heartbeats: users see own rows" on public.sync_heartbeats;
create policy "sync_heartbeats: users see own rows" on public.sync_heartbeats
  for select using (auth.uid() = user_id);

drop policy if exists "sync_heartbeats: users insert own rows" on public.sync_heartbeats;
create policy "sync_heartbeats: users insert own rows" on public.sync_heartbeats
  for insert with check (auth.uid() = user_id);

drop policy if exists "sync_heartbeats: users update own rows" on public.sync_heartbeats;
create policy "sync_heartbeats: users update own rows" on public.sync_heartbeats
  for update using (auth.uid() = user_id);

drop policy if exists "sync_heartbeats: users delete own rows" on public.sync_heartbeats;
create policy "sync_heartbeats: users delete own rows" on public.sync_heartbeats
  for delete using (auth.uid() = user_id);

-- ------------------------------------------------------------
-- mcp_freshness(): per-source freshness combining the heartbeat with the
-- content watermarks, so a source with real data but no heartbeat yet
-- (pre-existing rows synced before this migration shipped) still reports
-- something instead of silently vanishing from the stamp. GREATEST/LEAST
-- ignore NULL arguments in Postgres (only all-NULL yields NULL), which is
-- exactly the "take whichever signal is more current, or the only one that
-- exists" behaviour wanted here.
--
--   chat sources ('claude'/'chatgpt'/'grok'): last_item_at = greatest(the
--     heartbeat's recorded last_item_at, max(conversations.updated_at));
--     last_synced_at = coalesce(the heartbeat's last_run_at,
--     max(conversations.synced_at)) — the heartbeat's own run time is
--     preferred (it is exactly "when we last successfully ingested this
--     source"); the content's synced_at column is the fallback for rows
--     that predate the heartbeat writer.
--   'code': last_item_at = greatest(max(code_sessions.created_at),
--     max(code_projects.last_active_at)); last_synced_at = the heartbeat's
--     last_run_at (code has no per-row synced_at column — the sweep/hook
--     writer's own run time IS the sync signal).
--
-- A source with neither a heartbeat nor any content is omitted entirely
-- (never a null-filled placeholder row) — the caller (lib/freshness.ts)
-- relies on this to implement "sources with no data are omitted".
-- ------------------------------------------------------------
create or replace function public.mcp_freshness(p_user_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with heartbeats as (
    select source, last_run_at, last_item_at
    from public.sync_heartbeats
    where user_id = p_user_id
  ),
  chat_heartbeats as (
    select * from heartbeats where source <> 'code'
  ),
  code_heartbeat as (
    select * from heartbeats where source = 'code'
  ),
  chat_content as (
    select source, max(updated_at) as content_item_at, max(synced_at) as content_synced_at
    from public.conversations
    where user_id = p_user_id
    group by source
  ),
  code_content as (
    select
      (select max(created_at) from public.code_sessions where user_id = p_user_id) as sessions_at,
      (select max(last_active_at) from public.code_projects where user_id = p_user_id) as projects_at
  ),
  chat_sources as (
    select
      coalesce(h.source, c.source) as source,
      greatest(h.last_item_at, c.content_item_at) as last_item_at,
      coalesce(h.last_run_at, c.content_synced_at) as last_synced_at
    from chat_heartbeats h
    full outer join chat_content c on c.source = h.source
  ),
  code_source as (
    select
      'code'::text as source,
      greatest(ch.last_item_at, cc.sessions_at, cc.projects_at) as last_item_at,
      ch.last_run_at as last_synced_at
    from code_content cc
    left join code_heartbeat ch on true
    where ch.last_run_at is not null or cc.sessions_at is not null or cc.projects_at is not null
  ),
  combined as (
    select * from chat_sources
    union all
    select * from code_source
  )
  select coalesce(
    jsonb_object_agg(source, jsonb_build_object(
      'last_item_at', last_item_at,
      'last_synced_at', last_synced_at
    )),
    '{}'::jsonb
  )
  from combined
  where last_item_at is not null or last_synced_at is not null;
$$;

revoke all on function public.mcp_freshness(uuid) from public;
revoke all on function public.mcp_freshness(uuid) from anon;
revoke all on function public.mcp_freshness(uuid) from authenticated;
grant execute on function public.mcp_freshness(uuid) to service_role;
