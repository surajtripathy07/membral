-- ============================================================
-- 029_code_sessions.sql
-- Code sessions as a first-class, SEPARATE graph dimension (ADR 0021, P1a).
-- Depends on: 001 (profiles), 011 (kg_nodes, for the cross-link FK only).
-- ============================================================
--
-- WHY SEPARATE TABLES (ADR 0021 Q2, the make-or-break decision): coding-agent
-- session transcripts (Claude Code first) must never destabilise the existing
-- conversation graph (kg_nodes/kg_edges). Rather than adding new kg_node_type
-- values + an `origin` partition column (which would require every one of the
-- ~10 pipeline modules — pass1/embeddings/cluster/stage-a/promote/stage-b/
-- portrait/resolve — to carry a permanent `WHERE origin='chat'` guard, making
-- isolation a forever-discipline over a negative), code sessions live in FOUR
-- DEDICATED TABLES below. The conversation pipeline only ever queries
-- kg_nodes/kg_edges, so isolation is a STRUCTURAL invariant: those modules
-- physically cannot select rows that live in a different table. See
-- code-isolation.test.ts for the byte-identical proof this buys.
--
-- code_cross_links is the ONLY bridge to the chat graph, and it is
-- one-directional: it references kg_nodes.id (read-only from that side) but
-- nothing in kg_nodes/kg_edges ever references a code_* table. A code import
-- can therefore never create, move, rename, or delete a chat-derived
-- area/item/person, and the #83 scope RPCs (which recurse `contains` in
-- kg_edges) are automatically blind to everything here.
-- ============================================================

-- ------------------------------------------------------------
-- code_projects: one row per (user, repo). The CodeProject clustering key is
-- repo_identity (ADR Q4) — normalized `host/owner/repo` from the git remote
-- when one exists, else a normalized absolute repo-root path, else the
-- per-user fallback bucket `code-project:unassigned`. repo_identity survives
-- clones/moves/branch switches (branch is a session attribute, never the
-- project key); repo_path is kept alongside for display only.
-- ------------------------------------------------------------
create table public.code_projects (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles(id) on delete cascade,
  repo_identity   text not null,
  repo_path       text,
  remote_url      text,
  display_name    text,
  source          text,
  -- Cross-session rollup (P1c, #6/#42/#81 pattern): summary + structured
  -- props (built/decisions/recurring files+tools/people/open threads) +
  -- locked_fields + a portrait_dirty flag for lazy regen — same shape as
  -- kg_user_portraits. NULL/false until P1c's synthesis pass runs.
  summary         text,
  props           jsonb not null default '{}'::jsonb,
  session_count   int not null default 0,
  last_active_at  timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, repo_identity)
);

-- ------------------------------------------------------------
-- code_sessions: one row per imported transcript. Idempotency key is
-- (user_id, source, source_session_id); content_hash (SHA-256 of the raw
-- transcript, computed by the CLI parser) lets the importer short-circuit a
-- re-run of the hook/backfill with an unchanged hash — see
-- lib/code-sessions/import.ts.
-- ------------------------------------------------------------
create table public.code_sessions (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references public.profiles(id) on delete cascade,
  code_project_id    uuid not null references public.code_projects(id) on delete cascade,
  source             text not null,
  source_session_id  text not null,
  content_hash       text not null,
  cwd                text,
  git_branch         text,
  model              text,
  started_at         timestamptz,
  ended_at           timestamptz,
  duration_seconds   int,
  turn_count         int not null default 0,
  user_turn_count    int not null default 0,
  tool_count         int not null default 0,
  files_touched      text[] not null default '{}',
  title              text,
  -- Per-session "what was done" summary (P1c). NULL in P1a — no LLM calls
  -- happen at import time; this phase leaves summary/rollup columns NULL.
  summary            text,
  props              jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  unique (user_id, source, source_session_id)
);

-- ------------------------------------------------------------
-- code_session_turns: the USER SPINE (ADR non-negotiable #5) — full user
-- prose kept verbatim; assistant turns sparse (prose/thinking/tool_use only,
-- tool_result payloads elided by the parser before upload). Replaced
-- wholesale on re-import of a changed session (see import.ts).
-- ------------------------------------------------------------
create table public.code_session_turns (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  session_id  uuid not null references public.code_sessions(id) on delete cascade,
  idx         int not null,
  role        text not null,
  kind        text not null,
  text        text,
  tool_name   text,
  file_path   text,
  ts          timestamptz,
  unique (session_id, idx)
);

-- ------------------------------------------------------------
-- code_cross_links: ONE-DIRECTIONAL bridge to the chat graph (P1c matcher
-- writes these; nothing under lib/code-sessions/ ever writes kg_nodes/
-- kg_edges — see the static gate in code-isolation.test.ts). Cascades on the
-- kg_nodes side too: a cross-link is meaningless once its target chat node is
-- gone, and deleting it can never touch the chat graph itself.
-- ------------------------------------------------------------
create table public.code_cross_links (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.profiles(id) on delete cascade,
  code_project_id  uuid not null references public.code_projects(id) on delete cascade,
  kg_node_id       uuid not null references public.kg_nodes(id) on delete cascade,
  rel_type         text not null default 'relates_to',
  confidence       real,
  dismissed_at     timestamptz,
  created_at       timestamptz not null default now()
);

-- ------------------------------------------------------------
-- profiles.api_key_scope_code_project_id — token scope, code-project flavor
-- (ADR Q7, extends #83's api_key_scope_node_id). NO FK, exactly like
-- api_key_scope_node_id (migration 024): a real FK would need an ON DELETE
-- action, and every option is wrong for the same reasons documented there —
-- a stale/deleted id must fail CLOSED (seed an empty set), never open. The
-- CHECK below encodes the single-scope model decided in Q7 (a key is
-- area-scoped XOR code-project-scoped XOR unscoped) at the schema level;
-- application code (generateApiKey, /api/keys) is responsible for never
-- setting both, and this makes "both set" impossible even under a future bug.
-- ------------------------------------------------------------
alter table public.profiles
  add column if not exists api_key_scope_code_project_id uuid;

comment on column public.profiles.api_key_scope_code_project_id is
  'Code-project scope for this profile''s lls_ API key (ADR 0021 Q7): NULL = not code-project-scoped; else a public.code_projects.id. No FK on purpose — a stale/deleted id fails CLOSED (empty set), never open. Mutually exclusive with api_key_scope_node_id (single-scope model) — see the profiles_api_key_single_scope check.';

alter table public.profiles
  add constraint profiles_api_key_single_scope
  check (num_nonnulls(api_key_scope_node_id, api_key_scope_code_project_id) <= 1);

-- ============================================================
-- indexes
-- ============================================================

create index idx_code_projects_user_id
  on public.code_projects (user_id);

create index idx_code_projects_repo_identity
  on public.code_projects (repo_identity);

create index idx_code_sessions_user_id
  on public.code_sessions (user_id);

create index idx_code_sessions_code_project_id
  on public.code_sessions (code_project_id);

create index idx_code_session_turns_user_id
  on public.code_session_turns (user_id);

create index idx_code_session_turns_session_id
  on public.code_session_turns (session_id, idx);

create index idx_code_cross_links_user_id
  on public.code_cross_links (user_id);

create index idx_code_cross_links_code_project_id
  on public.code_cross_links (code_project_id);

create index idx_code_cross_links_kg_node_id
  on public.code_cross_links (kg_node_id);

-- ============================================================
-- row-level security — same shape as kg_nodes (migration 011): every table
-- is user_id-scoped, four owner-only policies, no cross-user visibility.
-- ============================================================

alter table public.code_projects enable row level security;

create policy "code_projects: users see own rows" on public.code_projects
  for select using (auth.uid() = user_id);
create policy "code_projects: users insert own rows" on public.code_projects
  for insert with check (auth.uid() = user_id);
create policy "code_projects: users update own rows" on public.code_projects
  for update using (auth.uid() = user_id);
create policy "code_projects: users delete own rows" on public.code_projects
  for delete using (auth.uid() = user_id);

alter table public.code_sessions enable row level security;

create policy "code_sessions: users see own rows" on public.code_sessions
  for select using (auth.uid() = user_id);
create policy "code_sessions: users insert own rows" on public.code_sessions
  for insert with check (auth.uid() = user_id);
create policy "code_sessions: users update own rows" on public.code_sessions
  for update using (auth.uid() = user_id);
create policy "code_sessions: users delete own rows" on public.code_sessions
  for delete using (auth.uid() = user_id);

alter table public.code_session_turns enable row level security;

create policy "code_session_turns: users see own rows" on public.code_session_turns
  for select using (auth.uid() = user_id);
create policy "code_session_turns: users insert own rows" on public.code_session_turns
  for insert with check (auth.uid() = user_id);
create policy "code_session_turns: users update own rows" on public.code_session_turns
  for update using (auth.uid() = user_id);
create policy "code_session_turns: users delete own rows" on public.code_session_turns
  for delete using (auth.uid() = user_id);

alter table public.code_cross_links enable row level security;

create policy "code_cross_links: users see own rows" on public.code_cross_links
  for select using (auth.uid() = user_id);
create policy "code_cross_links: users insert own rows" on public.code_cross_links
  for insert with check (auth.uid() = user_id);
create policy "code_cross_links: users update own rows" on public.code_cross_links
  for update using (auth.uid() = user_id);
create policy "code_cross_links: users delete own rows" on public.code_cross_links
  for delete using (auth.uid() = user_id);
