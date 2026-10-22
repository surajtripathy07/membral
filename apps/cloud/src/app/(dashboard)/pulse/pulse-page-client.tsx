"use client";

/**
 * Pulse — the home / "Today" (brief §6.2).
 *
 * The living front door: a freshness strip (module A), agent work & cost
 * (module B), and "Your record" (module D, ADR 0032 §3 / Addendum 2) — the
 * merged, time-ordered list of recent conversations and code sessions. Reads
 * /api/pulse — a small dedicated route (commit 12ce038 deleted the old
 * /api/spike catch-all this used to hit wholesale, including its always-on
 * `op=pulse` branch alongside the throwaway dev tooling it was actually
 * aimed at). Calm, editorial, single column — NOT a SaaS analytics
 * dashboard.
 *
 * There is no bootstrap wiring here any more: ADR 0032 §1.2 deleted the
 * full-page bootstrap takeover and the inline bootstrap CTA outright —
 * claims-first retired the paid cluster-tree build both used to offer, so
 * /pulse has no relationship to `useSecondBrainBootstrap` (that hook had no
 * remaining caller once D9 removed the graph pages it served).
 *
 * This file owns only fetching/state; the actual render lives in
 * pulse-content.tsx, split out so it's renderToStaticMarkup-testable without
 * mocking fetch/useState — same precedent as portrait-content.tsx.
 *
 * Extracted out of page.tsx (issue #132 item 3): page.tsx is now the async
 * Server Component that computes `granted` (hasFeature) and mounts
 * <SelfAdvance> — a "use client" file can't do either directly, so this
 * client-only half moved here unchanged, just renamed PulsePage ->
 * PulsePageClient.
 */
import { useCallback, useEffect, useState } from "react";
import type { FirstRunHistory } from "@/lib/code-sessions/first-run";
import type { FreshnessMap } from "@/lib/freshness";
import type { PulseRecentCodeSession } from "./code-activity-strip";
import type { RecurringBlocker, Thread } from "@/lib/threads/open-threads";
import { type PulseRecent, PulseContent } from "./pulse-content";
import type { ThreadGrouping } from "@/lib/threads/view";
import type { PulseThreads } from "./threads-panel";

export interface PulseFetchResult {
  recent: PulseRecent[];
  recentCode: PulseRecentCodeSession[];
  freshness: FreshnessMap | null;
  /** Goal 2026-09-26 W8 / P7: the thread blocks' data; each field defaults to empty/null on a bare 200. */
  threads: PulseThreads;
  /** W5 D4: the "Your history" card's data, null when hidden. */
  firstRun: FirstRunHistory | null;
}

/** `session_titles` as a string → string map; anything else (missing, malformed) is `{}`. */
export function parseSessionTitles(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [id, title] of Object.entries(raw as Record<string, unknown>)) if (typeof title === "string") out[id] = title;
  return out;
}

/**
 * Turns a fetch Response into the shape PulsePageClient's state wants, or
 * throws a plain, renderable Error. Pulled out as a pure function (no
 * React) so the "non-JSON body" path is unit-testable without mocking
 * fetch/useState — same reasoning pulse-content.tsx's own split gives.
 *
 * Parses as text first: a 404/500 from an unrelated layer (e.g. a deleted
 * route, or a proxy error page) comes back as HTML, not JSON, and
 * `res.json()` on that throws "Unexpected token <" — a parse error that
 * hides the real status behind a useless message. Surface the HTTP status
 * instead whenever the body isn't valid JSON.
 */
export async function parsePulseResponse(res: Response): Promise<PulseFetchResult> {
  const text = await res.text();
  let data: {
    error?: string;
    recent?: unknown;
    recent_code_sessions?: unknown;
    freshness?: unknown;
    open_threads?: unknown;
    recent_threads?: unknown;
    recurring_blockers?: unknown;
    stats_line?: unknown;
    session_titles?: unknown;
    first_run?: unknown;
  };
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`failed to load (status ${res.status})`);
  }
  if (!res.ok) throw new Error(data.error ?? `failed to load (status ${res.status})`);
  const recentCode = Array.isArray(data.recent_code_sessions)
    ? (data.recent_code_sessions as PulseRecentCodeSession[])
    : [];
  return {
    recent: (data.recent as PulseRecent[]) ?? [],
    recentCode,
    firstRun:
      data.first_run && typeof data.first_run === "object" && !Array.isArray(data.first_run)
        ? (data.first_run as FirstRunHistory)
        : null,
    freshness: (data.freshness as { corpus_current_through?: FreshnessMap })?.corpus_current_through ?? null,
    threads: {
      // /api/pulse sends null (not []) when the threads read failed (F9).
      threadsError: data.open_threads === null || data.recent_threads === null,
      openThreads: Array.isArray(data.open_threads) ? (data.open_threads as Thread[]) : [],
      recentThreads: Array.isArray(data.recent_threads) ? (data.recent_threads as Thread[]) : [],
      recurringBlockers: Array.isArray(data.recurring_blockers) ? (data.recurring_blockers as RecurringBlocker[]) : [],
      statsLine: typeof data.stats_line === "string" && data.stats_line.trim() ? data.stats_line : null,
      hasSessions: recentCode.length > 0,
      sessionTitles: parseSessionTitles(data.session_titles),
    },
  };
}

/** Open threads grouping: latest session by default, `?group=repo` by repo (page.tsx passes the search param). */
export function PulsePageClient({
  grouping = "session",
  day = null,
}: { grouping?: ThreadGrouping; day?: string | null } = {}) {
  const [recent, setRecent] = useState<PulseRecent[]>([]);
  const [recentCode, setRecentCode] = useState<PulseRecentCodeSession[]>([]);
  const [freshness, setFreshness] = useState<FreshnessMap | null>(null);
  const [threads, setThreads] = useState<PulseThreads | null>(null);
  const [firstRun, setFirstRun] = useState<FirstRunHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadPulse = useCallback(async () => {
    try {
      const res = await fetch("/api/pulse");
      const parsed = await parsePulseResponse(res);
      setRecent(parsed.recent);
      setRecentCode(parsed.recentCode);
      setFreshness(parsed.freshness);
      setThreads(parsed.threads);
      setFirstRun(parsed.firstRun);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPulse();
  }, [loadPulse]);

  return (
    <PulseContent
      threadGrouping={grouping}
      threadDay={day}
      loading={loading}
      error={error}
      recent={recent}
      recentCode={recentCode}
      freshness={freshness}
      threads={threads}
      firstRun={firstRun}
    />
  );
}
