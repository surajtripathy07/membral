// GET /api/code-sessions/stats — #93 (usage visibility that reconciles).
//
// /code/stats (the Overview tab) reads code_sessions directly from a server
// component (see (dashboard)/code/stats/page.tsx) — it has no JSON API of
// its own. This route exists so scripts/usage-reconcile.mjs (D6's
// verification command) has something to fetch over HTTP: the SAME numbers
// that page renders, computed by the SAME aggregateAgentStats() pricing/
// grouping path (lib/agent-stats/aggregate.ts) — never a second,
// independently-drifting computation of "what did this cost".
//
// AUTH: Bearer Supabase JWT or an unscoped Bearer lls_ key
// (withRoute + CODE_SESSIONS_READ_AUTH, lib/code-sessions/auth.ts) — same
// restriction as the write route in this directory. No cookie-session
// fallback: this is a script-facing endpoint, not something the dashboard
// itself calls.
import { NextResponse } from "next/server";
import { type AgentStatsSessionInput, aggregateAgentStats } from "@/lib/agent-stats/aggregate";
import { withRoute } from "@/lib/api/route";
import { CODE_SESSIONS_READ_AUTH, getCodeSessionsServiceClient } from "@/lib/code-sessions/auth";
import { listSessionsForUsageReconcile } from "@/lib/code-sessions/queries";

const DEFAULT_WINDOW_DAYS = 30;
const MAX_WINDOW_DAYS = 365;

export const GET = withRoute({ auth: CODE_SESSIONS_READ_AUTH }, async ({ req, userId }) => {
  const url = new URL(req.url);
  const daysParam = Number(url.searchParams.get("days"));
  const days =
    Number.isFinite(daysParam) && daysParam > 0
      ? Math.min(Math.trunc(daysParam), MAX_WINDOW_DAYS)
      : DEFAULT_WINDOW_DAYS;

  const now = new Date();
  const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  // authenticateCodeSessionsRead already validated the bearer (JWT or
  // unscoped lls_ key) and resolved it to a userId — this route then reads
  // with the service client, scoped explicitly by .eq("user_id", userId)
  // (same defense-in-depth posture as every other loader in this file's
  // sibling routes; RLS on code_sessions would also block cross-user rows,
  // but the service client bypasses RLS by design, so the explicit filter
  // here is load-bearing, not redundant).
  const supabase = getCodeSessionsServiceClient();
  // Sub-agent sessions (migration 089) are excluded — see the function's chain.
  const { data, error } = await listSessionsForUsageReconcile(supabase, userId, since.toISOString());
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as AgentStatsSessionInput[];
  const aggregate = aggregateAgentStats(rows, {
    tz: "UTC",
    startDate: since.toISOString().slice(0, 10),
    endDate: now.toISOString().slice(0, 10),
  });

  return NextResponse.json({
    days,
    window_start: since.toISOString(),
    window_end: now.toISOString(),
    totals: aggregate.totals,
    by_model: aggregate.by_model,
    coverage: aggregate.coverage,
  });
});
