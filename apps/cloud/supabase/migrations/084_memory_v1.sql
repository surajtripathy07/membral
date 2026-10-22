-- ============================================================
-- 084_memory_v1.sql
-- Memory v1 (docs/design/memory-v1.md, accepted 2026-09-12, D-045),
-- goal 2026-09-13, step 1 (#110 §8 bullet 1).
-- Depends on: 001 (profiles, conversations), 029 (code_sessions,
-- code_projects, code_cross_links), 011 (kg_nodes, read for the one-time
-- backfill below only).
-- ============================================================
--
-- WHAT THIS SHIPS:
--   1. session_memories / memory_recall_events / memory_branch_state — the
--      three tables of §2's SQL block, byte-for-byte (columns, checks,
--      indexes, unique constraint, the hnsw vector index, the gin index on
--      `paths`), RLS with one `own_rows` policy per table.
--   2. retire_session_memory(p_id, p_reason) — sets retired_at on the
--      caller's own row. `supersedes` needs no helper: it is a plain
--      `update session_memories set supersedes = ... where id = ...`,
--      already covered by RLS.
--   3. prune_memory_recall_events() — deletes memory_recall_events rows
--      older than 90 days (§2: "retained 90 days"). No cron wiring here —
--      that is a later goal step's job.
--   4. code_cross_links retarget (§5's named dependency): adds
--      conversation_id, backfills it from kg_nodes.source_conversation_id
--      ONLY for a row whose kg_node_id resolves to a kg_nodes row of
--      type='Conversation' owned by the SAME user (adversarial review
--      review-084.md findings 1 and 7 — source_conversation_id is written
--      on EVERY kg_nodes row regardless of type by GraphWriter.newNodeRow /
--      stage-b.ts, so an unfiltered join would silently re-point a
--      signal-1 name-match link — e.g. to a Person node — at whatever
--      conversation first mentioned that entity, and an unfiltered user_id
--      could mint a cross-user row), drops kg_node_id (and its FK/index),
--      deletes every row that backfills to NULL (a link to nothing a v1
--      reader can open — see the DELETE below for why that is correct here,
--      not just convenient; the deleted count is RAISE NOTICE'd so a
--      `supabase db push`/`migration up` run's log states it), adds a
--      `unique (user_id, code_project_id, conversation_id)` constraint (two
--      kg_nodes rows sharing a source conversation must not produce
--      duplicate links) and the (user_id, code_project_id, conversation_id)
--      index feeding the v1 chat-precontext reader.
--
--      HOSTED PRE-CHECK (run before applying this migration to the hosted
--      DB, to size the blast radius — review-084.md finding 1/3): `select
--      kn.type, count(*) from code_cross_links c join kg_nodes kn on
--      kn.id = c.kg_node_id group by 1;` — every non-'Conversation' type
--      row that count reports is a signal-1 link this migration deletes
--      (see the DELETE's comment for why that is the correct outcome, not
--      merely convenient: cross-links regenerate on the next sync/cross-
--      link run, and there is no v1 reader or column left to keep them
--      pointed at anything once kg_node_id is dropped below).
--
--      SECOND HOSTED PRE-CHECK (review-084.md finding 6, for the new unique
--      constraint added below): the constraint's own column,
--      code_cross_links.conversation_id, does not exist until this
--      migration adds and backfills it, so the duplicate-pair check cannot
--      be phrased against conversation_id and run BEFORE the push — it has
--      to be simulated via the same kg_nodes join the backfill itself uses.
--      Run this before applying: `select c.user_id, c.code_project_id,
--      kn.source_conversation_id, count(*) from code_cross_links c join
--      kg_nodes kn on kn.id = c.kg_node_id where kn.type = 'Conversation'
--      and kn.user_id = c.user_id group by 1,2,3 having count(*) > 1;` — any
--      row this returns is a (user, project, conversation) triple that the
--      backfill would map two-or-more existing code_cross_links rows onto,
--      which the `add constraint ... unique (user_id, code_project_id,
--      conversation_id)` step below would then reject, aborting the whole
--      transaction (a loud failure, not silent corruption — but worth
--      knowing about first). If it returns any rows, resolve the duplicates
--      (dedupe or dismiss) before pushing.
--
-- ATOMICITY: this migration runs as a single transaction (the Supabase CLI
-- wraps every migration file in one `begin`/`commit`; `supabase db push`
-- exposes no flag to disable that, and nothing below uses `create index
-- concurrently` or any other statement that would refuse to run inside a
-- transaction) — a failure at any point rolls the whole file back, so the
-- multi-step code_cross_links retarget below can never be left half-applied
-- on a real environment. Every CREATE is also `if not exists` so a
-- partially-applied run of THIS EXACT FILE (e.g. one manually replayed with
-- `psql -f` outside the CLI's own transaction) can be safely re-run. That
-- idempotency is by index/constraint/table NAME, not by definition or
-- effect: `create index if not exists` matches on the name in the
-- statement, so re-running this file against a database whose equivalent
-- indexes already exist under OTHER names (e.g. Postgres's own
-- auto-generated names from an earlier, differently-written migration)
-- would create duplicate indexes rather than detect and skip them. This bit
-- a local dev DB during review (review-084.md finding 6) — see the driver's
-- hand-fixup notes for how that was reconciled outside this file.
--
-- GRANTS: this repo's convention (checked against every 0xx migration: only
-- FUNCTIONS get explicit `grant execute`; no migration ever issues a
-- table-level `grant ... on table` to anon/authenticated/service_role —
-- e.g. 029_code_sessions.sql, the model named in the goal file, grants
-- nothing beyond RLS) is that Supabase's own platform-level default
-- privileges (`alter default privileges ... grant ... on tables to anon,
-- authenticated, service_role`, applied once outside this repo's migration
-- history) already cover every table in `public`; RLS is what actually
-- restricts access. session_memories/memory_recall_events/memory_branch_state
-- follow that same convention: no table-level GRANT statement here, RLS +
-- the own_rows policy is the access control.
-- ============================================================

-- pgvector lives in `extensions` on hosted Supabase; the CLI login role does not
-- have it on its search_path, so resolve `vector` for this file explicitly.
set search_path = public, extensions;

-- ------------------------------------------------------------
-- session_memories — one row per record (§2). turn_idx is a plain int, NOT
-- an FK: code_session_turns is replaced wholesale on a changed re-import
-- (import.ts:288's replaceTurns), so a cascading composite FK here would
-- silently destroy a session's memories on its next re-import.
-- ------------------------------------------------------------
create table if not exists public.session_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  code_session_id uuid not null references public.code_sessions(id) on delete cascade,
  code_project_id uuid not null references public.code_projects(id) on delete cascade,
  agent_id text,  source text not null check (source in ('hook','agent','extractor')),
  kind text not null check (kind in ('outcome','decision','learning','blocker','preference')),
  text text not null,  quote text,  turn_idx int not null,   -- plain int, no FK: see the receipt row
  turn_role text not null check (turn_role in ('user','assistant')),
  ref text, ref_kind text,            -- any outward URL or artifact path/id; open enum pr|mr|commit|branch|tag|release|deploy|issue|comment|thread|message|doc|sheet|image|file|other
  branch text, head_sha text, thread text, paths text[] not null default '{}',
  verified boolean not null default false,  durable boolean not null default false,
  observed_durable boolean not null default false,
  recurs_of uuid references public.session_memories(id) on delete set null,
  recurrence_count int not null default 1,
  scope text not null default 'project' check (scope in ('project','global')),
  confidence real not null default 0.5,
  supersedes uuid references public.session_memories(id) on delete set null,
  retired_at timestamptz,
  chat_conversation_id uuid references public.conversations(id) on delete set null,
  content_hash text not null,  embedding vector(1536),
  created_at timestamptz not null default now(),
  unique (user_id, code_session_id, content_hash),
  check (kind <> 'outcome'    or ref is not null),      -- an outcome without a ref is a claim
  check (kind <> 'preference' or turn_role = 'user'),   -- a preference is the owner's (#114)
  check (verified = false or quote is not null or kind = 'outcome')
);
create index if not exists session_memories_user_project_kind_created_idx
  on public.session_memories (user_id, code_project_id, kind, created_at desc) where retired_at is null;
create index if not exists session_memories_embedding_hnsw_idx
  on public.session_memories using hnsw (embedding vector_cosine_ops);
create index if not exists session_memories_paths_gin_idx
  on public.session_memories using gin (paths);

-- ------------------------------------------------------------
-- memory_recall_events — the day-one metric's log (§7). Retained 90 days
-- (prune_memory_recall_events below); no cron wiring in this migration.
-- ------------------------------------------------------------
create table if not exists public.memory_recall_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  tool text not null check (tool in ('memory_search','memory_recall','session_summary')),
  recall_token text, query text,      -- token: minted by the push, echoed by the call
  record_ids uuid[] not null default '{}',  served_at timestamptz not null default now(),
  code_session_id uuid references public.code_sessions(id) on delete set null,
  matched_turn_idx int,               -- this and the two below are filled at import
  influenced_edit boolean not null default false, influenced_quote boolean not null default false
);
create index if not exists memory_recall_events_user_served_idx
  on public.memory_recall_events (user_id, served_at desc);

-- ------------------------------------------------------------
-- memory_branch_state — one row per (repo, branch), written only by the
-- session-end hook (§2's "Repo, branch, and merges we never see").
-- ------------------------------------------------------------
create table if not exists public.memory_branch_state (
  user_id uuid not null references public.profiles(id) on delete cascade,
  code_project_id uuid not null references public.code_projects(id) on delete cascade,
  branch text not null,  last_seen_sha text, merged_into text, merged_at timestamptz,
  branch_gone_at timestamptz, last_seen_at timestamptz not null default now(),
  primary key (user_id, code_project_id, branch)
);

alter table public.session_memories     enable row level security;
alter table public.memory_recall_events enable row level security;
alter table public.memory_branch_state  enable row level security;

create policy own_rows on public.session_memories
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_rows on public.memory_recall_events
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_rows on public.memory_branch_state
  for all using (user_id = auth.uid()) with check (user_id = auth.uid());

-- ------------------------------------------------------------
-- retire_session_memory(p_id, p_user_id) — sets retired_at on a row this
-- caller is allowed to touch. SECURITY INVOKER (not DEFINER): RLS's
-- own_rows policy is what actually stops this touching another user's row,
-- not an app-layer `where user_id = ...` this function could get wrong.
--
-- Same dual-caller shape as project_alias_seed (migrations 063/064) and
-- require_session_or_service_role (070): an ordinary end-user session (a
-- cookie-bound Supabase client, dashboard-called, no p_user_id — resolves to
-- auth.uid()) OR a service-role caller (the MCP/API-key surfaces, which
-- authenticate via SUPABASE_SERVICE_ROLE_KEY and have no Supabase session,
-- so auth.uid() is NULL for them — see migration 016's SECURITY MODEL note)
-- passing p_user_id explicitly. review-084.md finding 4: this repo's
-- service-role paths (lib/mcp/*, api-key routes) always pass p_user_id
-- explicitly rather than relying on a session that doesn't exist for them,
-- so p_user_id must be HONOURED for a real service-role caller, not just
-- accepted and ignored — but it must never let an authenticated end-user
-- session retire another user's row by passing someone else's id, hence the
-- guard raising unless the caller is service_role.
--
-- p_reason (previously accepted, discarded) is dropped: v1 has no column or
-- log to persist it in, so keeping an unused parameter only invites a caller
-- to believe it does something.
--
-- Returns the updated row count (0 = no row matched: either it does not
-- exist, is already retired, or is not the resolved caller's — RLS plus the
-- explicit `user_id = v_user` predicate make those indistinguishable, which
-- is the point).
-- ------------------------------------------------------------
drop function if exists public.retire_session_memory(uuid, text);

create or replace function public.retire_session_memory(
  p_id uuid,
  p_user_id uuid default null
) returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_user uuid;
  v_count integer;
begin
  v_user := coalesce(p_user_id, auth.uid());

  if p_user_id is not null and not (
    coalesce(auth.role() = 'service_role', false) or current_user in ('service_role', 'postgres')
  ) then
    raise exception 'retire_session_memory: p_user_id may only be supplied by a service-role caller';
  end if;

  if v_user is null then
    raise exception 'retire_session_memory: no user (service-role caller must pass p_user_id)';
  end if;

  update public.session_memories
  set retired_at = now()
  where id = p_id
    and user_id = v_user
    and retired_at is null;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.retire_session_memory(uuid, uuid) from public;
revoke all on function public.retire_session_memory(uuid, uuid) from anon;
grant execute on function public.retire_session_memory(uuid, uuid) to authenticated, service_role;

-- ------------------------------------------------------------
-- prune_memory_recall_events() — 90-day retention (§2). SECURITY INVOKER,
-- service-role only (like 035's llm_spend_sum): this is a maintenance sweep,
-- not something an ordinary session ever calls, and RLS has no policy that
-- would let `authenticated` delete across users anyway — DEFINER is not
-- needed and would be strictly more ambient authority than this needs.
-- No cron wiring in this migration (goal step 1 scope); a later step points
-- pg_cron or the existing internal-cron route at this.
-- ------------------------------------------------------------
create or replace function public.prune_memory_recall_events() returns integer
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_count integer;
begin
  delete from public.memory_recall_events
  where served_at < now() - interval '90 days';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.prune_memory_recall_events() from public;
revoke all on function public.prune_memory_recall_events() from anon;
revoke all on function public.prune_memory_recall_events() from authenticated;
grant execute on function public.prune_memory_recall_events() to service_role;

-- ============================================================
-- code_cross_links retarget (§5: "v1 changes code_cross_links's target from
-- kg_node_id to conversation_id (backfilled from kg_nodes.source_
-- conversation_id) and retargets the signal at conversations.embedding,
-- populated independently by lib/conversation-embeddings.ts. Without that
-- migration, deleting the chat pipeline silently stops chat pre-context.")
-- ============================================================

alter table public.code_cross_links
  add column if not exists conversation_id uuid references public.conversations(id) on delete cascade;

-- Backfill: a code_cross_links row's kg_node_id only ever pointed at a
-- Conversation-carrying node when kg_nodes.source_conversation_id was set
-- for it (cross-links.ts's old signal 2) AND that node was itself of
-- type='Conversation'. review-084.md finding 1 (BLOCKER): source_
-- conversation_id is written on EVERY kg_nodes row regardless of type
-- (GraphWriter.newNodeRow sets it unconditionally; stage-b.ts passes
-- sourceConversationId on every entity upsert) — an unfiltered join would
-- silently re-point a signal-1 name-match link (e.g. to a Person/Item/
-- LifeArea node) at whatever conversation first mentioned that entity.
-- Locally kg_nodes has 0 rows of type 'Conversation' at all (verified via
-- information_schema + a direct count before writing this migration), so
-- this UPDATE is a no-op here regardless of the type filter — checked by
-- construction: it only ever SETS a value, never requires one, so an empty
-- match set leaves every row's new conversation_id at its default (NULL)
-- rather than erroring. finding 7: also requires kn.user_id = ccl.user_id,
-- so a kg_nodes row belonging to a different profile can never mint a
-- cross-user code_cross_links row.
update public.code_cross_links ccl
set conversation_id = kn.source_conversation_id
from public.kg_nodes kn
where kn.id = ccl.kg_node_id
  and kn.source_conversation_id is not null
  and kn.type = 'Conversation'
  and kn.user_id = ccl.user_id;

-- Every row that did NOT backfill to a conversation_id (locally: all 3
-- existing rows, which were the old signal 1 NAME-match links to
-- Item/LifeArea/Person kg_nodes, never Conversation nodes) is deleted here,
-- not just left with a null conversation_id: post-retarget, a
-- code_cross_links row's only reader-facing purpose is chat pre-context
-- (§5's table: "Chat pre-context and chat_precontext in the tools") — a row
-- with no conversation to open is a link to nothing a v1 reader can ever
-- resolve, and kg_node_id (its only other target) is being dropped in this
-- same migration, so there would be no column left to explain what it used
-- to point at either. See this migration's HOSTED PRE-CHECK note above for
-- the query to run before applying this to hosted to size the blast radius;
-- the deleted count is RAISE NOTICE'd below so a `supabase db push`/
-- `migration up` run's own log states exactly how many rows this removed.
do $$
declare
  v_deleted integer;
begin
  delete from public.code_cross_links where conversation_id is null;
  get diagnostics v_deleted = row_count;
  raise notice 'migration 084: deleted % code_cross_links row(s) with no resolvable conversation_id (old signal-1 name-match links to non-Conversation kg_nodes)', v_deleted;
end $$;

alter table public.code_cross_links
  alter column conversation_id set not null;

-- Two kg_nodes rows sharing a source conversation (or two independent runs
-- of the content matcher) must not be able to produce duplicate links for
-- the same (project, conversation) pair — review-084.md finding 1. Added
-- via a guarded DO block, not `add constraint if not exists` (Postgres has
-- no such clause for constraints), so re-running this migration is a no-op
-- rather than a duplicate-object error.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'code_cross_links_user_project_conversation_key'
      and conrelid = 'public.code_cross_links'::regclass
  ) then
    alter table public.code_cross_links
      add constraint code_cross_links_user_project_conversation_key
      unique (user_id, code_project_id, conversation_id);
  end if;
end $$;

drop index if exists public.idx_code_cross_links_kg_node_id;
alter table public.code_cross_links
  drop constraint if exists code_cross_links_kg_node_id_fkey;
alter table public.code_cross_links
  drop column if exists kg_node_id;

-- No separate lookup index here (review-084.md finding 6): the unique
-- constraint just above already creates a btree on exactly these three
-- columns in this order (user_id, code_project_id, conversation_id) as its
-- implicit backing index — a second, differently-named index over the same
-- columns would only duplicate it, never serve a query the constraint's
-- index can't.
