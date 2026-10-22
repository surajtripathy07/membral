"use client";

// W9 (2026-09-12 refocus goal, D9): a small segmented control for the
// window /code/stats aggregates over — 7/30/90 days, matching
// GET /api/code-sessions/stats' own `?days=` param (default 30). Plain
// links (not a client fetch) so the page stays a server component and the
// URL stays the single source of truth for the selected window.
import Link from "next/link";
import { STATS_WINDOW_OPTIONS } from "./stats-window";

export function DaysControl({ days }: { days: number }) {
  return (
    <div role="group" aria-label="Time window" className="inline-flex items-center rounded-sm border border-line p-0.5">
      {STATS_WINDOW_OPTIONS.map((n) => {
        const active = n === days;
        return (
          <Link
            key={n}
            href={`/code/stats?days=${n}`}
            aria-current={active ? "true" : undefined}
            className={`rounded-xs px-2.5 py-1 text-label transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${
              active ? "bg-accent-soft text-accent" : "text-muted hover:text-ink-2"
            }`}
          >
            {n}d
          </Link>
        );
      })}
    </div>
  );
}
