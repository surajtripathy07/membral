-- ============================================================
-- 098_mcp_tool_calls.sql
-- One row per Membral MCP tool call, so the maintainer can see how often
-- each tool is used and whether it helped.
-- Depends on: nothing new (auth.users only).
-- ============================================================
--
-- WHO WRITES: apps/cloud/src/lib/mcp/telemetry.ts, with the service-role
-- client, after the tool has answered (never blocks the response). No
-- insert/update/delete policy exists, so only the service role can write.
-- WHO READS: the owner (select policy below) and
-- apps/cloud/scripts/metrics/mcp-usage.ts (service role).
--
-- args is a sanitized copy: numbers/booleans, short structured strings,
-- id-like params, and the free-text query/topic cut to 200 chars. Secret-
-- looking params (recall_token included) are never stored.
-- result_ids holds the first 20 ids a search/list tool returned, so a later
-- get_conversation/get_code_session on one of them reads as follow-through.

create table if not exists public.mcp_tool_calls (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  api_key_id uuid null,
  client_name text,
  client_version text,
  tool text not null,
  ok boolean not null,
  error text check (error is null or char_length(error) <= 300),
  latency_ms int,
  result_chars int,
  result_count int null,
  result_ids text[] null,
  degraded boolean not null default false,
  paged boolean not null default false,
  args jsonb,
  created_at timestamptz not null default now()
);

create index if not exists mcp_tool_calls_user_created_idx
  on public.mcp_tool_calls (user_id, created_at desc);
create index if not exists mcp_tool_calls_tool_created_idx
  on public.mcp_tool_calls (tool, created_at desc);

alter table public.mcp_tool_calls enable row level security;

drop policy if exists "mcp_tool_calls_select_own" on public.mcp_tool_calls;
create policy "mcp_tool_calls_select_own"
  on public.mcp_tool_calls for select
  to authenticated
  using (user_id = auth.uid());

revoke all on public.mcp_tool_calls from anon;
revoke insert, update, delete on public.mcp_tool_calls from authenticated;

-- Daily rollup per user and tool. security_invoker so the caller's RLS on
-- mcp_tool_calls applies: a signed-in user sees only their own days.
create or replace view public.mcp_usage_daily
with (security_invoker = true) as
select
  date_trunc('day', created_at at time zone 'utc')::date as day,
  user_id,
  tool,
  count(*)::int as calls,
  count(*) filter (where not ok)::int as errors,
  count(*) filter (where degraded)::int as degraded,
  count(*) filter (where paged)::int as paged,
  percentile_cont(0.5) within group (order by latency_ms) as p50_latency_ms,
  percentile_cont(0.95) within group (order by latency_ms) as p95_latency_ms,
  round(avg(result_chars))::int as avg_result_chars
from public.mcp_tool_calls
group by 1, 2, 3;

revoke all on public.mcp_usage_daily from anon;
