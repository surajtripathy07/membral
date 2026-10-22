-- ============================================================
-- 048_bridge_demo.sql
-- Bridge demo (stopgap): lets the web UI (and CLI) create "bridge sessions"
-- that continue a previously-synced AI conversation inside Claude Code on
-- the user's own machine. The web app enqueues commands into
-- `agent_commands`; a local daemon (outside this repo's cloud app) polls
-- GET /api/bridge/agent/next, runs the prompt through Claude Code, and posts
-- the result back via POST /api/bridge/agent/result.
--
-- Three tables, same shape as code_sessions (migration 029): user_id-scoped,
-- RLS enabled with owner-only policies, but every route talks through the
-- service-role client (SUPABASE_SERVICE_ROLE_KEY) exactly like
-- code-sessions/sync/memories, scoping every query by an explicit
-- `user_id` derived from an authenticated request (cookie session OR
-- Bearer JWT / lls_ key) — RLS here is defense-in-depth, not the enforcement
-- path (service_role bypasses RLS in Supabase, same as every other
-- service-role route in this codebase).
--
-- bridge_claim_next_command() follows migration 016's header pattern for a
-- service-role-only RPC: SECURITY INVOKER (not DEFINER — the "belt" is the
-- explicit p_user_id predicate, the "suspenders" is the service_role-only
-- grant, same rationale 016 documents at length), revoked from
-- public/anon/authenticated, granted to service_role only.
-- ============================================================

-- ------------------------------------------------------------
-- bridge_sessions: one row per bridge conversation. `source_conversation_id`
-- is the previously-synced chat conversation being continued (nullable — a
-- bridge session can also start from nothing); `cli_session_id`/`cli_cwd`
-- are populated once the local daemon's first Claude Code turn reports back
-- a real CLI session id (see POST /api/bridge/agent/result).
--
-- `backend` picks which engine runs a session's turns: 'claude_code' (the
-- original design — queued through agent_commands to the local daemon) or
-- 'openrouter' (added mid-build: runs INLINE in the request handler via
-- lib/bridge/openrouter.ts, no daemon involved). `model` is the OpenRouter
-- model id (e.g. 'anthropic/claude-sonnet-4.5') — required by the API route
-- when backend='openrouter', meaningless/unused for 'claude_code'.
--
-- `context_preamble` is rendered ONCE, at session creation, from
-- source_conversation_id (lib/bridge/context.ts renderConversationContext)
-- and stored here — both backends read it from this column on a session's
-- first turn rather than re-rendering it per message.
-- ------------------------------------------------------------
create table public.bridge_sessions (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references public.profiles(id) on delete cascade,
  source_conversation_id   uuid references public.conversations(id) on delete set null,
  cli_session_id           uuid,
  cli_cwd                  text,
  title                    text not null default 'Bridge session',
  origin                   text not null default 'web' check (origin in ('web', 'cli')),
  backend                  text not null default 'claude_code' check (backend in ('claude_code', 'openrouter')),
  model                    text,
  context_preamble         text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- ------------------------------------------------------------
-- bridge_messages: the chat transcript for one bridge session — both the
-- user's prompts and the assistant's (Claude Code's) responses, plus a
-- 'system' role for surfaced errors (see POST /api/bridge/agent/result).
-- ------------------------------------------------------------
create table public.bridge_messages (
  id           uuid primary key default gen_random_uuid(),
  session_id   uuid not null references public.bridge_sessions(id) on delete cascade,
  user_id      uuid not null references public.profiles(id) on delete cascade,
  role         text not null check (role in ('user', 'assistant', 'system')),
  content      text not null,
  created_at   timestamptz not null default now()
);

-- ------------------------------------------------------------
-- agent_commands: the work queue between the web app and the local daemon.
-- One row per turn the daemon needs to execute: 'start_session' (no
-- cli_session_id yet — the daemon starts a fresh Claude Code session,
-- optionally seeded with a contextPreamble) or 'continue_session' (resumes
-- an existing cli_session_id in its cwd).
-- ------------------------------------------------------------
create table public.agent_commands (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.profiles(id) on delete cascade,
  bridge_session_id   uuid not null references public.bridge_sessions(id) on delete cascade,
  type                text not null check (type in ('start_session', 'continue_session')),
  payload             jsonb not null default '{}'::jsonb,
  status              text not null default 'pending' check (status in ('pending', 'claimed', 'done', 'error')),
  result              jsonb,
  created_at          timestamptz not null default now(),
  claimed_at          timestamptz,
  completed_at        timestamptz
);

-- ============================================================
-- indexes
-- ============================================================

create index idx_bridge_sessions_user_created
  on public.bridge_sessions (user_id, created_at);

create index idx_bridge_messages_user_created
  on public.bridge_messages (user_id, created_at);

-- Ordered per-session transcript reads (GET /api/bridge/sessions/[id]).
create index idx_bridge_messages_session_created
  on public.bridge_messages (session_id, created_at);

create index idx_agent_commands_user_status_created
  on public.agent_commands (user_id, status, created_at);

-- Latest-command-for-a-session lookup (GET /api/bridge/sessions/[id]).
create index idx_agent_commands_session_created
  on public.agent_commands (bridge_session_id, created_at);

-- ============================================================
-- bridge_claim_next_command: atomically claim the oldest pending command
-- for a user. FOR UPDATE SKIP LOCKED so two daemon polls (or a poll racing
-- a retry) never double-claim the same row. Requires VOLATILE (the default
-- for a `language sql` function whose body is a data-modifying statement) —
-- unlike 016's read-only RPCs, this one both reads and writes.
-- ------------------------------------------------------------
create function public.bridge_claim_next_command(p_user_id uuid)
returns setof public.agent_commands
language sql
security invoker
set search_path = public, pg_temp
as $$
  update public.agent_commands
     set status = 'claimed',
         claimed_at = now()
   where id = (
     select id
       from public.agent_commands
      where user_id = p_user_id
        and status = 'pending'
      order by created_at
      limit 1
      for update skip locked
   )
  returning *;
$$;

comment on function public.bridge_claim_next_command(uuid) is
  'Bridge demo: atomically claims the oldest pending agent_commands row for p_user_id (FOR UPDATE SKIP LOCKED avoids double-claiming across concurrent daemon polls). Migration-016-shaped: security invoker, explicit p_user_id, EXECUTE service_role only — see this migration''s header.';

revoke all on function public.bridge_claim_next_command(uuid) from public;
revoke all on function public.bridge_claim_next_command(uuid) from anon;
revoke all on function public.bridge_claim_next_command(uuid) from authenticated;
grant execute on function public.bridge_claim_next_command(uuid) to service_role;

-- ------------------------------------------------------------
-- profiles.openrouter_api_key: per-user OpenRouter key, so the 'openrouter'
-- backend routes through the cloud using the USER's own key rather than a
-- shared server key (lib/bridge/openrouter.ts falls back to
-- process.env.OPENROUTER_API_KEY only when this is unset). Managed via
-- PUT/GET /api/bridge/openrouter-key.
--
-- STOPGAP: stored in PLAINTEXT. This whole feature is a deliberate demo
-- build (see this migration's header) — encryption-at-rest for this column
-- is deferred to the later security pass, not skipped by oversight. Never
-- returned in full by any route (GET /api/bridge/openrouter-key returns a
-- masked 'sk-or-…last4' string, never the raw value).
-- ------------------------------------------------------------
alter table public.profiles
  add column if not exists openrouter_api_key text;

-- ============================================================
-- row-level security — same shape as code_sessions (migration 029): every
-- table is user_id-scoped, four owner-only policies. Every route in this
-- feature talks through the service-role client (which bypasses RLS), so
-- this is defense-in-depth, not the enforcement path — see this migration's
-- header.
-- ============================================================

alter table public.bridge_sessions enable row level security;

create policy "bridge_sessions: users see own rows" on public.bridge_sessions
  for select using (auth.uid() = user_id);
create policy "bridge_sessions: users insert own rows" on public.bridge_sessions
  for insert with check (auth.uid() = user_id);
create policy "bridge_sessions: users update own rows" on public.bridge_sessions
  for update using (auth.uid() = user_id);
create policy "bridge_sessions: users delete own rows" on public.bridge_sessions
  for delete using (auth.uid() = user_id);

alter table public.bridge_messages enable row level security;

create policy "bridge_messages: users see own rows" on public.bridge_messages
  for select using (auth.uid() = user_id);
create policy "bridge_messages: users insert own rows" on public.bridge_messages
  for insert with check (auth.uid() = user_id);
create policy "bridge_messages: users update own rows" on public.bridge_messages
  for update using (auth.uid() = user_id);
create policy "bridge_messages: users delete own rows" on public.bridge_messages
  for delete using (auth.uid() = user_id);

alter table public.agent_commands enable row level security;

create policy "agent_commands: users see own rows" on public.agent_commands
  for select using (auth.uid() = user_id);
create policy "agent_commands: users insert own rows" on public.agent_commands
  for insert with check (auth.uid() = user_id);
create policy "agent_commands: users update own rows" on public.agent_commands
  for update using (auth.uid() = user_id);
create policy "agent_commands: users delete own rows" on public.agent_commands
  for delete using (auth.uid() = user_id);
