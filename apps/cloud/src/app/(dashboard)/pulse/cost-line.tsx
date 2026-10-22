"use client";

// Today's one-line 30-day spend (UX audit B2): replaces the AgentWorkPanel
// charts on /pulse. The charts, tiles and model breakdown live on Usage
// (/code/stats), which this line links to. Same data source as the panel it
// replaces — GET /api/agent-stats?range=30d — so the number here and on Usage
// come from one aggregate, formatted by the one money formatter (`fmtUsd`).
//
// `CostLineContent` is the pure, renderToStaticMarkup-testable half;
// `CostLine` owns the fetch.
import Link from "next/link";
import { useEffect, useState } from "react";
import type { AgentStatsPayload } from "@/lib/agent-stats/aggregate";
import { fmtUsdEst, SPEND_TRANSCRIPT_TITLE } from "@/lib/format/usd";
import { detectBrowserTimeZone } from "@/lib/util/timezone";

export const USAGE_HREF = "/code/stats";

export interface CostDelta {
  text: string;
  direction: "up" | "down" | "flat";
}

/** `▼37% vs prior 30d` — null when there is no prior window to compare against (or it was $0 / unpriced). */
export function costDelta(current: number | null, previous: number | null | undefined): CostDelta | null {
  if (current === null || previous === null || previous === undefined || previous === 0) return null;
  const pct = ((current - previous) / previous) * 100;
  const direction: CostDelta["direction"] = pct > 0.5 ? "up" : pct < -0.5 ? "down" : "flat";
  const arrow = direction === "up" ? "▲" : direction === "down" ? "▼" : "→";
  return { text: `${arrow}${Math.abs(pct).toFixed(0)}% vs prior 30d`, direction };
}

export interface CostLineContentProps {
  loading: boolean;
  error: string | null;
  data: Pick<AgentStatsPayload, "totals" | "previous_totals" | "coverage"> | null;
}

const LINE_CLASS = "flex flex-wrap items-baseline gap-x-2 gap-y-1 text-body-sm text-muted tabular-nums";

function UsageLink() {
  return (
    <Link href={USAGE_HREF} className="text-accent hover:underline">
      Usage →
    </Link>
  );
}

export function CostLineContent({ loading, error, data }: CostLineContentProps) {
  if (loading && !data) {
    return <div className="h-5 w-72 max-w-full animate-pulse rounded-xs bg-surface" data-testid="cost-line" />;
  }
  if (error || !data) {
    return (
      <p className={LINE_CLASS} data-testid="cost-line">
        <span>30-day cost unavailable</span>
        <span aria-hidden="true">·</span>
        <UsageLink />
      </p>
    );
  }
  const { totals, previous_totals, coverage } = data;
  const delta = costDelta(totals.cost_usd, previous_totals?.cost_usd);
  const tone = delta?.direction === "up" ? "text-warn" : delta?.direction === "down" ? "text-ok" : "text-muted";
  const sessionsWord = totals.sessions === 1 ? "session" : "sessions";
  return (
    <p className={LINE_CLASS} data-testid="cost-line">
      <span className="font-medium text-ink" title={SPEND_TRANSCRIPT_TITLE}>{fmtUsdEst(totals.cost_usd)}</span>
      <span>spent · 30d</span>
      {delta && (
        <>
          <span aria-hidden="true">·</span>
          <span className={tone}>{delta.text}</span>
        </>
      )}
      <span aria-hidden="true">·</span>
      <span>
        {totals.sessions.toLocaleString("en-US")} {sessionsWord}
        {coverage.sessions_total > 0 && coverage.sessions_with_usage < coverage.sessions_total
          ? ` (${coverage.sessions_with_usage.toLocaleString("en-US")} of ${coverage.sessions_total.toLocaleString("en-US")} priced)`
          : ""}
      </span>
      <span aria-hidden="true">·</span>
      <UsageLink />
    </p>
  );
}

export function CostLine() {
  const [data, setData] = useState<AgentStatsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const params = new URLSearchParams({ range: "30d", tz: detectBrowserTimeZone() });
    fetch(`/api/agent-stats?${params.toString()}`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "failed to load agent stats");
        if (!cancelled) {
          setData(json as AgentStatsPayload);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return <CostLineContent loading={loading} error={error} data={data} />;
}
