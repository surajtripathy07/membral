-- ============================================================
-- 017_kg_bootstrap_runs.sql
-- Run-record for the user-triggered "Build my Second Brain" bootstrap
-- (handoff 0015 §6.4)
-- Depends on: 001 (profiles)
-- ============================================================
--
-- WHY A RUN TABLE (vs. deriving everything from kg_conversations_processed /
-- kg_stage_a_tree / kg_nodes):
--
-- `processed` / `total` progress IS derived live from existing tables (see
-- lib/kg/bootstrap-runs.ts) — no columns for that live here. But two things
-- cannot be recovered from the existing pipeline tables at all:
--
--   1. A run-level FAILURE. Pass 1 tolerates per-conversation failures (rows
--      land with status='failed' and the batch continues) — that is normal,
--      not a run error. The real failure mode this table exists for is the
--      pipeline PROCESS crashing (e.g. an unhandled exception in stage_a
--      clustering, promote, or stage_b) with NO partial write anywhere to
--      point to. Without a row that says "a run started and never finished
--      cleanly," a crashed run and a slow-but-healthy run are indistinguishable
--      from outside — the UI would poll forever with no way to show an error.
--   2. `startedAt` and an in-flight concurrency guard that survive a dev-server
--      reload. In-memory state (a Map in the route module) is wiped by any
--      restart, which would both forget when a run started AND let a
--      duplicate run start right after — even though the first run's DB
--      writes (kg_conversations_processed etc.) are still landing in the
--      background. A DB row is the one thing both the pre- and post-restart
--      process agree on.
--
-- So: one row per bootstrap run, `status` + `stage` (last-reported pipeline
-- stage; precise sub-stage boundaries like promote-vs-stage_b aren't reliably
-- inferable from table shape alone) + `error` are authoritative here. A
-- partial unique index enforces at most one 'running' row per user — the
-- DB-level half of the duplicate-run guard (the route also checks first, to
-- return the active run's status instead of a bare unique-violation error).

create table public.kg_bootstrap_runs (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references public.profiles(id) on delete cascade,
  status       text not null default 'running',  -- running | done | error
  stage        text,                              -- last BootstrapStage reported (pass1|embeddings|stage_a|promote|stage_b|done)
  error        text,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- At most one active run per user — DB-level duplicate-run guard.
create unique index idx_kg_bootstrap_runs_active_per_user
  on public.kg_bootstrap_runs (user_id)
  where status = 'running';

-- Latest-run lookups (status endpoint reads the most recent row per user).
create index idx_kg_bootstrap_runs_user_started
  on public.kg_bootstrap_runs (user_id, started_at desc);

-- ============================================================
-- RLS — users may only ever READ their own rows. Every write (insert on
-- start, update on stage/terminal transitions) goes through the server route
-- using the service-role client, same as runBootstrapForUser's own writes.
-- ============================================================

alter table public.kg_bootstrap_runs enable row level security;

create policy "kg_bootstrap_runs: users see own rows" on public.kg_bootstrap_runs
  for select using (auth.uid() = user_id);
