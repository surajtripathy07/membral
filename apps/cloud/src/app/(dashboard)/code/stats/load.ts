// /code/stats data loading (G3 step 3D-4): the page's load section moved
// verbatim into a named loader — the awaits AND the synchronous work between
// them, in the same order, with the same `.catch` handlers. The awaits stay
// sequential on purpose (programme defect 10 is fixed separately, not here).

import {
  type AgentStatsAggregate,
  type AgentStatsSessionInput,
  aggregateAgentStats,
} from "@/lib/agent-stats/aggregate";
import {
  emptySessionOutcome,
  groupCommitEventsBySession,
  parseCommitEvents,
  type SessionIssueRow,
} from "@/lib/agent-stats/attribution";
import {
  getRecentSessionsForStats,
  getSessionTurnsForOutcomes,
  listSessionIssuesForSessions,
  listSessionsForStatsPriorWindow,
  listSessionsForStatsWindow,
  type RecentSessionForStatsRow,
} from "@/lib/code-sessions/queries";
import { getSessionTitles, type SessionTitleInfo } from "@/lib/code-sessions/session-titles";
import { createClient } from "@/lib/supabase/server";
import type { SessionOutcomeRowData } from "./sessions-outcome-table";

export const RECENT_SESSIONS_LIMIT = 15;

export interface CodeStatsPageData {
  data: AgentStatsAggregate | null;
  previousTotals: AgentStatsAggregate["totals"] | null;
  outcomeRows: SessionOutcomeRowData[];
}

/** The page's data for a `windowDays` window; `null` when there is no signed-in user. */
export async function loadCodeStatsPage(windowDays: number): Promise<CodeStatsPageData | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return null;
  }

  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const priorSince = new Date(since.getTime() - windowDays * 24 * 60 * 60 * 1000);
  // Never let a query/aggregation failure break the page — degrades to the
  // "no data yet" empty state below, same posture as the other /code pages'
  // best-effort reads (project-facts, memory claims).
  let aggregate: AgentStatsAggregate | null = null;
  // UX audit B3: sessions in this window, kept around (rather than re-queried)
  // so the per-session cost map below can reuse the SAME rows/props it
  // already paid for, instead of a second query.
  let windowRows: AgentStatsSessionInput[] = [];
  try {
    // Paged: one PostgREST response caps at 1000 rows (a 90-day window can pass it).
    windowRows = await listSessionsForStatsWindow(supabase, user.id, since.toISOString());
    aggregate = aggregateAgentStats(windowRows, {
      tz: "UTC",
      startDate: since.toISOString().slice(0, 10),
      endDate: new Date().toISOString().slice(0, 10),
    });
  } catch {
    aggregate = null;
  }

  // Narrowed once into its own const (rather than re-testing `aggregate &&`
  // at every JSX use site below) so TS can track non-nullness through the
  // whole ternary — `aggregate` itself stays `AgentStatsAggregate | null`.
  const data = aggregate && aggregate.totals.sessions > 0 ? aggregate : null;

  // UX audit B3 ("▼37% vs prior 30d" delta) — same window shifted back one
  // period, same aggregation call; a failure here just drops the delta, it
  // never breaks the page.
  let previousTotals: AgentStatsAggregate["totals"] | null = null;
  try {
    const prevRows = await listSessionsForStatsPriorWindow(
      supabase,
      user.id,
      priorSince.toISOString(),
      since.toISOString(),
    );
    previousTotals = aggregateAgentStats(prevRows, {
      tz: "UTC",
      startDate: priorSince.toISOString().slice(0, 10),
      endDate: since.toISOString().slice(0, 10),
    }).totals;
  } catch {
    previousTotals = null;
  }

  // #93 — recent-sessions outcome link: reuses the SAME parseCommitEvents/
  // groupCommitEventsBySession pure functions /code/stats/issues already
  // uses, scoped to a bounded recent batch (not the user's full history —
  // see getSessionTurnsForOutcomes' own comment). Never let this break the
  // page — degrades to an empty list, same posture as the cost card above.
  let outcomeRows: SessionOutcomeRowData[] = [];
  try {
    const recentSessions: RecentSessionForStatsRow[] = await getRecentSessionsForStats(
      supabase,
      user.id,
      since.toISOString(),
      RECENT_SESSIONS_LIMIT,
    );
    const turns = await getSessionTurnsForOutcomes(
      supabase,
      user.id,
      recentSessions.map((s) => s.id),
    );
    // Issues each session worked on, as memory extraction recorded them (migration 099).
    const issueRows = await listSessionIssuesForSessions(
      supabase,
      user.id,
      recentSessions.map((s) => s.id),
    ).catch(() => [] as SessionIssueRow[]);
    const outcomesBySession = groupCommitEventsBySession(parseCommitEvents(turns), issueRows);
    // UX audit B3 ("the outcome table has a cost column") — costed from the
    // SAME windowRows/props the page's own hero total already aggregated
    // above, one session at a time (aggregateAgentStats accepts any subset
    // of rows), never a new query or a new pricing path.
    const windowRowsById = new Map(windowRows.map((r) => [r.id, r] as const));
    // UX W5: every row's session by title — ONE batched lookup for the whole
    // table (lib/code-sessions/session-titles.ts); a failure drops to the date.
    const titles = await getSessionTitles(
      supabase,
      user.id,
      recentSessions.map((s) => s.id),
    ).catch(() => new Map<string, SessionTitleInfo>());
    outcomeRows = recentSessions.map((session) => {
      const row = windowRowsById.get(session.id);
      const costUsd = row
        ? aggregateAgentStats([row], {
            tz: "UTC",
            startDate: since.toISOString().slice(0, 10),
            endDate: new Date().toISOString().slice(0, 10),
          }).totals.cost_usd
        : null;
      return {
        session,
        outcome: outcomesBySession.get(session.id) ?? emptySessionOutcome(),
        costUsd,
        title: titles.get(session.id)?.title ?? null,
      };
    });
  } catch {
    outcomeRows = [];
  }

  return { data, previousTotals, outcomeRows };
}
