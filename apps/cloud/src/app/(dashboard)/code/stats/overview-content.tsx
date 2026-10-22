"use client";

// #93 (usage visibility that reconciles) — pure render half of /code/stats'
// Overview tab. Split out of page.tsx (async server component, hard to
// unit test directly) so the per-model breakdown and the main-vs-sub-agent
// split can be exercised with renderToStaticMarkup, same precedent as
// session-facts.tsx / issues-content.tsx.
//
// UX audit B3: "use client" added with the daily chart — this now renders
// ColumnChart (a client component) with function props (formatValue,
// formatDate) directly from page.tsx (a server component); RSC forbids
// passing functions across that boundary unless the parent is itself a
// client component (caught live via the after-capture screenshot, not
// asked for — fixed here rather than shipped broken).
//
// W9 (2026-09-12 refocus goal, D9, priority issue P1): "the differentiator
// is invisible" — the window total used to be a small right-aligned string
// in a card header. It's now the page's first, largest element
// (text-display), with the main/sub-agent split directly beneath it — that
// split is unusual and true and nobody else shows it. Two distinct empty
// states: zero sessions at all in the window (original copy, unchanged) vs.
// sessions exist but none were priceable (tusk-demo's "0 of 2 sessions
// priced" — used to render a bare "−" glyph, now a real named block).
//
// W11/D12 already folds sub-agent usage into `data.totals`/`data.by_model`
// (aggregateAgentStats, lib/agent-stats/aggregate.ts) — this component only
// RENDERS that (already-reconciled) total; it does not recompute anything.
import type { AgentStatsAggregate, AgentStatsTotals } from "@/lib/agent-stats/aggregate";
import { ModelBreakdownTable } from "@/lib/agent-stats/model-breakdown-table";
import { ColumnChart } from "@/components/viz/ColumnChart";
import { formatDayUtc } from "@/lib/format/dates";
import { fmtUsd, fmtUsdEst, SPEND_TRANSCRIPT_NOTE } from "@/lib/format/usd";

// UX audit B3 (docs §2 "/code/stats: Usage, Overview tab"): the daily chart
// moves here from pulse/agent-work-content.tsx (that file stays untouched —
// this reuses the same ColumnChart primitive it renders with, not its own
// unexported fmtDay/deltaFor helpers, so no edit to pulse's file was needed).

interface DeltaInfo {
  text: string;
  tone: "text-warn" | "text-ok" | "text-muted";
  arrow: "▲" | "▼" | "→";
}

/** cost-consistency.md: the "▼37% vs prior 30d" delta the audit asks Today's
 * cost line to carry — built here from the previous window's totals, which
 * page.tsx now fetches the same way it fetches the current window's. */
function deltaFor(current: number | null, previous: number | null, windowDays: number): DeltaInfo | null {
  if (current === null || previous === null || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const tone = pct > 0.5 ? "text-warn" : pct < -0.5 ? "text-ok" : "text-muted";
  const arrow = pct > 0.5 ? "▲" : pct < -0.5 ? "▼" : "→";
  const sign = pct > 0 ? "+" : "";
  return { text: `${sign}${pct.toFixed(0)}% vs prior ${windowDays}d`, tone, arrow };
}

function DeltaChip({ delta }: { delta: DeltaInfo | null }) {
  if (!delta) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-body-sm tabular-nums ${delta.tone}`}>
      <span aria-hidden="true">{delta.arrow}</span>
      {delta.text}
    </span>
  );
}

export function OverviewContent({
  data,
  windowDays,
  previousTotals,
}: {
  data: AgentStatsAggregate | null;
  windowDays: number;
  previousTotals?: AgentStatsTotals | null;
}) {
  if (!data) {
    return <p className="mt-2 text-body text-muted">No agent sessions in the last {windowDays} days.</p>;
  }

  if (data.coverage.sessions_with_usage === 0) {
    const n = data.coverage.sessions_total;
    return (
      <div className="rounded-card border border-line border-dashed bg-surface p-6 text-center">
        <p className="text-h3 font-medium text-ink">No priced usage yet</p>
        <p className="mx-auto mt-1 max-w-md text-body-sm text-muted">
          None of your {n} session{n === 1 ? "" : "s"} in the last {windowDays} days carried token usage Membral
          could price. Sessions imported from an older transcript often lack it; newly captured sessions will have
          it.
        </p>
      </div>
    );
  }

  const mainCostUsd = (data.totals.cost_usd ?? 0) - data.totals.subagent_cost_usd;
  const hasSplit = data.totals.subagent_runs > 0;
  const delta = deltaFor(data.totals.cost_usd, previousTotals?.cost_usd ?? null, windowDays);

  return (
    <div>
      <div className="flex flex-wrap items-baseline gap-3">
        <p className="text-display font-semibold tabular-nums text-ink">{fmtUsdEst(data.totals.cost_usd)}</p>
        <DeltaChip delta={delta} />
      </div>
      {hasSplit ? (
        <p className="mt-1 text-body text-muted">
          main {fmtUsd(mainCostUsd)} · sub-agents ({data.totals.subagent_runs} run
          {data.totals.subagent_runs === 1 ? "" : "s"}) {fmtUsd(data.totals.subagent_cost_usd)}
        </p>
      ) : (
        <p className="mt-1 text-body text-muted">inferred from token usage, main transcript + sub-agent runs</p>
      )}
      <p className="mt-1 max-w-prose text-micro text-muted" data-testid="spend-note">
        {SPEND_TRANSCRIPT_NOTE}
      </p>
      <p className="mt-1 text-micro text-muted">
        {data.coverage.sessions_with_usage} of {data.coverage.sessions_total} sessions priced ·{" "}
        {data.totals.sessions} session{data.totals.sessions === 1 ? "" : "s"}
      </p>

      {data.daily.length > 0 && (
        <div className="mt-5 rounded-card border border-line bg-surface p-4">
          <div className="text-label text-muted">Daily cost</div>
          <div className="mt-2">
            <ColumnChart data={data.daily.map((d) => ({ date: d.date, value: d.cost_usd }))} formatValue={fmtUsd} formatDate={formatDayUtc} ariaLabel="Daily cost" />
          </div>
        </div>
      )}

      {data.by_model.length > 0 && (
        <div className="mt-5">
          <h2 className="mb-2 section-label">Cost by model</h2>
          <ModelBreakdownTable byModel={data.by_model} />
        </div>
      )}
    </div>
  );
}
