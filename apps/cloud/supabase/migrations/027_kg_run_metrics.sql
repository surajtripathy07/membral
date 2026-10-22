-- ============================================================
-- 027_kg_run_metrics.sql
-- Per-run graph-shape metrics + behavior-drift flagging (GitHub issue #62).
-- Depends on: 001 (profiles), 011 (kg_nodes/kg_edges), 017 (kg_bootstrap_runs).
-- ============================================================
--
-- WHY: the KG pipeline's output quality was invisible. Nothing persisted the
-- shape of a run's graph, so a model bump, prompt tweak, or provider-side
-- behavior change could silently degrade extraction and nobody would notice
-- until a human eyeballed the graph in psql (exactly what happened on the
-- founder-1k re-attach: areas=11 and entityHomeRecall=0.60 caught only by eye).
--
-- This adds ONE row per completed bootstrap run (lib/kg/run-metrics.ts), holding
-- a full structural census (life areas, items, orphan rate, entity/edge type
-- histograms, multi-parent items) plus the LLM-health counters (parse fails,
-- empty responses, retries) and cost. A pure drift check compares each run to
-- the user's previous run + absolute guardrails and records violations.
--
-- STALENESS NOTE (issue #62 predates the current schema): the issue says "flag
-- on the kg_jobs row" — there is no kg_jobs table. Drift flags are recorded on
-- public.kg_bootstrap_runs (migration 017), the actual run-record table, via the
-- `drift_flags jsonb` column added below. The metrics row references its run via
-- `run_id` (nullable — CLI / steady-state census has no bootstrap-run row).

-- ------------------------------------------------------------
-- drift_flags on the run record. Array of { code, detail } objects; NULL until
-- the terminal metrics collection runs. Lives here (not on kg_run_metrics) so
-- ops surfaces reading the run row get the flags without a second join, matching
-- the issue's "flag on the run row" intent.
-- ------------------------------------------------------------
alter table public.kg_bootstrap_runs
  add column if not exists drift_flags jsonb;

-- ------------------------------------------------------------
-- kg_run_metrics: one census row per completed graph build.
--
-- All counters are NOT NULL with a 0 / '{}' default so a row is never partially
-- populated — a missing counter reads as a real 0, not "unknown". run_id is
-- nullable because the CLI bootstrap and future steady-state batches census the
-- graph without a kg_bootstrap_runs row to hang off.
-- ------------------------------------------------------------
create table public.kg_run_metrics (
  id                             uuid primary key default gen_random_uuid(),
  run_id                         uuid references public.kg_bootstrap_runs(id) on delete set null,
  user_id                        uuid not null references public.profiles(id) on delete cascade,
  model                          text,
  -- stable hash of the KG prompt surface (pass1 + stage-a naming/consolidation +
  -- stage-b entity extraction). A changed prompt_rev between runs explains a
  -- shape change that would otherwise look like unexplained drift.
  prompt_rev                     text,

  -- corpus / attachment census
  conv_total                     integer not null default 0,
  conv_failed                    integer not null default 0,
  life_areas                     integer not null default 0,
  items                          integer not null default 0,
  max_depth                      integer not null default 0,
  orphan_count                   integer not null default 0,
  orphan_rate                    double precision not null default 0,
  incoherent_top_clusters        integer not null default 0,
  -- PendingExtraction nodes EXCLUDING known Person.kind conflicts (those are a
  -- normal edit-by-exception inbox item, not an extraction failure).
  pending_extraction             integer not null default 0,

  -- shape histograms
  entities_by_type               jsonb not null default '{}',
  edges_by_type                  jsonb not null default '{}',
  multi_parent_items             integer not null default 0,
  transcript_strategy_dist       jsonb not null default '{}',

  -- LLM health (rolled up from lib/kg/llm.ts per-call counters)
  parse_fail_count               integer not null default 0,
  empty_response_count           integer not null default 0,
  retry_count                    integer not null default 0,

  -- stage-failure persistence (issue #62 item 3): counted, not just logged.
  -- Stage-A consolidation fell back to per-theme areas (0/1), and per-conv
  -- Stage-B attach failures (retryable, never orphaned).
  stage_a_consolidation_fallback integer not null default 0,
  stage_b_failed                 integer not null default 0,

  -- cost
  cost_usd_total                 double precision not null default 0,
  cost_usd_per_conv              double precision not null default 0,

  created_at                     timestamptz not null default now()
);

-- Latest-row-per-user lookups (drift check reads the immediately previous row).
create index idx_kg_run_metrics_user_created
  on public.kg_run_metrics (user_id, created_at desc);

-- ============================================================
-- RLS — users may only ever READ their own rows (mirrors kg_bootstrap_runs,
-- migration 017). Every write goes through the server collector using the
-- service-role client, which bypasses RLS. No user-facing insert/update path.
-- ============================================================
alter table public.kg_run_metrics enable row level security;

create policy "kg_run_metrics: users see own rows" on public.kg_run_metrics
  for select using (auth.uid() = user_id);
