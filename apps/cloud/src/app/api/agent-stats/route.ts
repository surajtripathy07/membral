// ADR 0032 module B — GET /api/agent-stats?range=30d&tz=<IANA>[&project_id=<uuid>]
//
// Server-aggregating endpoint for /pulse's "Agent work & cost" module: reads
// code_sessions (started_at, turn_count, user_turn_count, props — which
// includes usage/models/subAgents, W11/D12) for the authenticated user,
// prices via lib/code-sessions/price-table.ts, and returns ONLY aggregates — never raw
// session rows (§1.3 finding 4, §3 B: "Module B must not join [op=pulse]:
// it aggregates over every session in a range, so it gets its own
// server-aggregated endpoint... and never ships raw session rows to the
// browser"). Cookie-auth via requireUserId, same pattern as /api/spike's
// bridged read ops.
//
// W11/D12: optional `project_id` narrows the query to one code_projects row
// (`code_sessions.code_project_id`) — reused by the /code/[projectId] page's
// $/model section and /code/stats, so both share this ONE aggregation path
// rather than duplicating the pricing/grouping logic client- or page-side.
// `sessions_ever`/`previous_totals`/deltas stay global (not project-scoped) —
// they answer "has this user ever synced anything," a user-level question,
// unaffected by which project the caller happens to be viewing.
import { NextResponse } from "next/server";
import { type AgentStatsSessionInput, type AgentStatsTotals, aggregateAgentStats } from "@/lib/agent-stats/aggregate";
import { withRoute } from "@/lib/api/route";
import { PRICE_TABLE_VERSION } from "@/lib/code-sessions/price-table";
import { countSessionsEverForAgentStats, listSessionsForAgentStats } from "@/lib/code-sessions/queries";

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_DAYS: Record<string, number | null> = { "7d": 7, "30d": 30, "90d": 90, all: null };
const DEFAULT_RANGE = "30d";
const DEFAULT_TZ = "UTC";

function isValidTz(tz: string): boolean {
  try {
    // biome-ignore lint/correctness/noUnusedVariables: constructed only to force IANA validation to throw on a bad zone
    const probe = new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function dayString(d: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
    d,
  );
}

export const GET = withRoute(
  { auth: { kind: "session", unauthorized: "unauthorized" } },
  async ({ req, user, supabase }) => {
    const userId = user.id;
    const url = new URL(req.url);
    const rangeParam = url.searchParams.get("range") ?? DEFAULT_RANGE;
    const range = rangeParam in RANGE_DAYS ? rangeParam : DEFAULT_RANGE;
    const tzParam = url.searchParams.get("tz");
    const tz = tzParam && isValidTz(tzParam) ? tzParam : DEFAULT_TZ;
    // W11/D12 — narrows to one project's sessions; still scoped to `userId`
    // below via .eq("user_id", userId), so a project_id belonging to another
    // user simply yields zero rows rather than leaking cross-user data.
    const projectId = url.searchParams.get("project_id");

    const now = new Date();
    const days = RANGE_DAYS[range];

    // Bounded ranges (7d/30d/90d) also fetch one equal-length PRIOR window in
    // the same query, so the hero/tile deltas ("vs prior 30d") never need a
    // second round trip. NOTE (flagged for review): the SQL cutoff below is a
    // rolling N*24h window in UTC, while the display buckets (startDate below)
    // are calendar days in the caller's tz — near a tz boundary this can be
    // off by up to one day at the range edge. Acceptable for slice one; a
    // tz-exact cutoff would compute `since`/`prevSince` from the tz-local
    // day boundary instead of a fixed millisecond offset from `now`.
    let sinceIso: string | undefined;
    let prevSinceIso: string | undefined;
    if (days !== null) {
      const since = new Date(now.getTime() - days * DAY_MS);
      const prevSince = new Date(since.getTime() - days * DAY_MS);
      sinceIso = since.toISOString();
      prevSinceIso = prevSince.toISOString();
    }
    // Paged by keyset (review S5): one PostgREST response caps at 1000 rows ("all" and 90d can pass it).
    let data: AgentStatsSessionInput[];
    let everCountRes: Awaited<ReturnType<typeof countSessionsEverForAgentStats>>;
    try {
      [data, everCountRes] = await Promise.all([
        listSessionsForAgentStats(supabase, userId, projectId, prevSinceIso),
        countSessionsEverForAgentStats(supabase, userId, projectId),
      ]);
    } catch (err) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
    if (everCountRes.error) return NextResponse.json({ error: everCountRes.error.message }, { status: 500 });
    const sessionsEver = everCountRes.count ?? 0;

    const rows = data;
    const currentRows = sinceIso ? rows.filter((r) => r.started_at !== null && r.started_at >= sinceIso!) : rows;
    const previousRows =
      sinceIso && prevSinceIso
        ? rows.filter((r) => r.started_at !== null && r.started_at >= prevSinceIso! && r.started_at < sinceIso!)
        : [];

    const endDate = dayString(now, tz);
    const startDate =
      days !== null
        ? dayString(new Date(now.getTime() - (days - 1) * DAY_MS), tz)
        : currentRows.length > 0 && currentRows[0].started_at
          ? dayString(new Date(currentRows[0].started_at), tz)
          : endDate;

    const aggregate = aggregateAgentStats(currentRows, { tz, startDate, endDate });
    const previous_totals: AgentStatsTotals | null = sinceIso
      ? aggregateAgentStats(previousRows, { tz, startDate, endDate }).totals
      : null;

    // W11/D12 — fraction of this window's cost_usd contributed by sub-agent
    // runs; 0 when cost_usd is null/0 (never divide by a null/zero total).
    const subagentShare =
      aggregate.totals.cost_usd && aggregate.totals.cost_usd > 0
        ? aggregate.totals.subagent_cost_usd / aggregate.totals.cost_usd
        : 0;

    return NextResponse.json({
      range,
      tz,
      totals: aggregate.totals,
      previous_totals,
      daily: aggregate.daily,
      monthly: aggregate.monthly,
      by_model: aggregate.by_model,
      coverage: aggregate.coverage,
      sessions_ever: sessionsEver,
      cost_provenance: {
        source: "inferred" as const,
        price_table_version: PRICE_TABLE_VERSION,
        scope: "main_transcript_plus_subagents" as const,
        subagent_share: subagentShare,
      },
    });
  },
);
