// /code/stats (Overview tab). The FULL agent-stats board (top projects by
// cost, plan-vs-API savings, activity patterns, sub-agent/error breakdowns —
// ADR 0032 §4's table) is step 9 SLICE ONE's remainder, tracked separately
// (issue #93) — deliberately NOT built here in full: pulse/agent-work-panel.tsx
// + pulse/pulse-content.tsx stay off-limits to this change (concurrent
// agent).
//
// W9 (2026-09-12 refocus goal, D9, priority issue P2): the roadmap
// paragraph that used to close this page ("The full agent-stats board ...
// lands here in a later slice") is gone — shipping a to-do list to users
// was the single most "generated" artifact in the app. Also new: a ?days=
// window (7/30/90, default 30 — matching GET /api/code-sessions/stats'
// own default) via days-control.tsx.
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { DaysControl } from "./days-control";
import { DogfoodPanel } from "./dogfood-panel";
import { loadDogfood } from "./dogfood-load";
import { OverviewContent } from "./overview-content";
import { loadCodeStatsPage, RECENT_SESSIONS_LIMIT } from "./load";
import { ServedUsedBlock } from "./served-used-block";
import { loadServedUsed } from "./served-used-load";
import { SessionsOutcomeTable } from "./sessions-outcome-table";
import { STATS_WINDOW_OPTIONS } from "./stats-window";

const DEFAULT_WINDOW_DAYS = 30;

function resolveWindowDays(raw: string | undefined): number {
  const n = Number(raw);
  return (STATS_WINDOW_OPTIONS as readonly number[]).includes(n) ? n : DEFAULT_WINDOW_DAYS;
}

export default async function CodeStatsOverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const sp = await searchParams;
  const windowDays = resolveWindowDays(sp.days);

  const [loaded, servedUsed, dogfood] = await Promise.all([
    loadCodeStatsPage(windowDays),
    loadServedUsed(),
    loadDogfood(),
  ]);
  if (!loaded) {
    return (
      <Card padding={6} className="text-body text-ink-2">
        Sign in to see usage.
      </Card>
    );
  }
  const { data, previousTotals, outcomeRows } = loaded;

  // UX W6: an empty window is ONE line (plus the window control), not two
  // nested empty cards.
  if (!data) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-3" data-testid="usage-empty">
        <p className="text-body text-muted">
          No coding sessions in the last {windowDays} days.{" "}
          <Link href="/setup" className="text-accent hover:underline">
            Set up →
          </Link>
        </p>
        <DaysControl days={windowDays} />
      </div>
    );
  }

  // UX W6: the list is capped at RECENT_SESSIONS_LIMIT, so when the cap bites
  // the label says so ("15 most recent") and links to every session —
  // otherwise "Recent sessions · last 30 days" read as the whole window.
  const capped = outcomeRows.length >= RECENT_SESSIONS_LIMIT;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-body-sm text-muted">Last {windowDays} days</p>
        <DaysControl days={windowDays} />
      </div>

      <Card padding={6}>
        <OverviewContent data={data} windowDays={windowDays} previousTotals={previousTotals} />
      </Card>

      <Card padding={6}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="section-label" data-testid="recent-sessions-label">
            {capped ? `${RECENT_SESSIONS_LIMIT} most recent` : "Recent sessions"} · last {windowDays} days
          </h2>
          <Link href="/code" className="text-body-sm text-accent hover:underline">
            All sessions →
          </Link>
        </div>
        <div className="mt-3">
          <SessionsOutcomeTable rows={outcomeRows} />
        </div>
      </Card>

      <ServedUsedBlock summary={servedUsed} />

      <DogfoodPanel data={dogfood} />
    </div>
  );
}
