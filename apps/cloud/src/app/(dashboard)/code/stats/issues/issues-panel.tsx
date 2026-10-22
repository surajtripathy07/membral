"use client";

// Fetch/state half of the Issues tab (goal 2026-07-26 step 9 slice two) —
// mirrors pulse/agent-work-panel.tsx's split: this owns the GET
// /api/agent-stats/issues fetch, issues-content.tsx owns every render
// decision.
import { useEffect, useState } from "react";
import { type IssuesApiPayload, IssuesContent } from "./issues-content";

export function IssuesPanel() {
  const [data, setData] = useState<IssuesApiPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const res = await fetch("/api/agent-stats/issues");
        const json = await res.json();
        if (!res.ok) throw new Error(json.error ?? "failed to load issue attribution");
        if (!cancelled) {
          setData(json as IssuesApiPayload);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  return <IssuesContent loading={loading} error={error} data={data} />;
}
