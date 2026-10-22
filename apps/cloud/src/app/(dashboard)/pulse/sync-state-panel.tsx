"use client";

// Fetch/state half of the Sync & Memory State panel — mirrors the
// page.tsx ÷ *-content.tsx split at module grain (agent-work-panel.tsx ÷
// agent-work-content.tsx): this file owns the GET /api/sync-state fetch and
// the 15s auto-refresh; sync-state-content.tsx is pure and
// renderToStaticMarkup-testable.
//
// Auto-refresh: every 15s while the document tab is VISIBLE (per this
// task's spec) — paused via the Page Visibility API rather than a bare
// setInterval, so a backgrounded tab doesn't keep polling, and a refresh
// fires immediately on becoming visible again (a user tabbing back in
// shouldn't wait up to 15s to see current state).
import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncStateResponse } from "@/lib/sync-state-shape";
import { SyncStateContent } from "./sync-state-content";

const REFRESH_MS = 15_000;

export function SyncStatePanel({ freshnessTitle }: { freshnessTitle?: string } = {}) {
  const [data, setData] = useState<SyncStateResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const load = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/sync-state");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "failed to load sync state");
      setData(json as SyncStateResponse);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load]);

  return <SyncStateContent loading={loading} error={error} data={data} freshnessTitle={freshnessTitle} />;
}
