-- ============================================================
-- 104_user_stats.sql
-- One row per (user, UTC day) of personal stats derived nightly from what
-- the user's coding sessions and Membral MCP calls already recorded. Feeds
-- the one rotating line on Today (/api/pulse) and `npm run mcp:audit`.
-- Goal 2026-09-26 P8 (open threads from observed actions).
-- Depends on: 029 (code_sessions, code_session_turns), 098 (mcp_tool_calls),
-- 099 (code_session_issues).
-- ============================================================
--
-- WHY a table and not profiles.props.stats (goal open question 2): profiles
-- has no props column, and a table keeps the RLS story the same as every
-- neighbouring derived table — one select-own policy, service role writes.
-- It also keeps a day's history, so "usual start hour" and "most-edited
-- file this month" are read as a mode/max over rows instead of rewriting a
-- blob.
--
-- WHO WRITES: apps/cloud/src/lib/stats/derive-user-stats.ts, service-role
-- client, from /api/internal/cron/memory-extraction once a day (yesterday's
-- row, upsert on (user_id, day)). No insert/update/delete policy exists, so
-- only the service role can write. A day with no top-level sessions writes
-- no row.
-- WHO READS: the owner (select policy below) via /api/pulse, and
-- scripts/mcp-audit.mjs (service role).
--
-- Sessions are attributed to the UTC day of started_at. Cost is the session's
-- priced usage (lib/code-sessions/price-table.ts, same as /code/stats) and is
-- an ESTIMATE (B11) — the UI labels it "est." Sub-agent sessions
-- (parent_source_session_id not null) are counted in sub_agent_sessions and
-- fold into their parent's turns/tool counts; they are not priced twice.

create table if not exists public.user_stats (
  user_id                 uuid not null references public.profiles(id) on delete cascade,
  day                     date not null,
  -- volume
  sessions                int not null default 0,
  sub_agent_sessions      int not null default 0,
  turns                   int not null default 0,
  user_turns              int not null default 0,
  tool_calls              int not null default 0,
  -- cost (estimate, USD)
  cost_usd                numeric(12,6) not null default 0,
  -- observed actions (counts only, from code_session_turns.props.action and tool names)
  edits                   int not null default 0,
  reads                   int not null default 0,
  tests                   int not null default 0,
  commits                 int not null default 0,
  pushes                  int not null default 0,
  verb_counts             jsonb not null default '{}'::jsonb,   -- {"committed": 3, "reviewed": 1}
  -- refs (code_session_issues)
  refs                    int not null default 0,                -- distinct refs touched that day
  ref_counts              jsonb not null default '{}'::jsonb,   -- {"worked_on": 2, "referenced": 5}
  -- tools
  tool_counts             jsonb not null default '{}'::jsonb,   -- {"Edit": 14, "Bash": 30}
  mcp_calls               int not null default 0,
  mcp_errors              int not null default 0,
  mcp_tool_counts         jsonb not null default '{}'::jsonb,   -- {"memory_search": 4}
  -- personal stats
  longest_session_seconds int,
  longest_session_id      uuid references public.code_sessions(id) on delete set null,
  busiest_repo            text check (busiest_repo is null or char_length(busiest_repo) <= 500),
  most_edited_file        text check (most_edited_file is null or char_length(most_edited_file) <= 1000),
  start_hour              smallint check (start_hour is null or start_hour between 0 and 23),
  first_session_at        timestamptz,                          -- the user's first session ever, as of computed_at
  computed_at             timestamptz not null default now(),
  primary key (user_id, day)
);

comment on table public.user_stats is
  'Per-user, per-UTC-day derived stats (goal 2026-09-26 P8). Written nightly by the cron; cost_usd is an estimate.';
comment on column public.user_stats.cost_usd is
  'Sum of the day''s priced session usage (price-table estimate, B11). Label as est. in any UI.';
comment on column public.user_stats.start_hour is
  'Median UTC hour the day''s top-level sessions started; the usual start hour is the mode over rows.';

create index if not exists user_stats_user_day_idx
  on public.user_stats (user_id, day desc);

alter table public.user_stats enable row level security;

drop policy if exists "user_stats_select_own" on public.user_stats;
create policy "user_stats_select_own"
  on public.user_stats for select
  to authenticated
  using (user_id = auth.uid());

revoke all on public.user_stats from anon;
revoke insert, update, delete on public.user_stats from authenticated;
