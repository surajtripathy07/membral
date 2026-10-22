// The short "what we found" report `membral setup` prints after the first import.
// Pure: facts in, lines out. The facts come from importSessions' result, so nothing is parsed twice.
import { harnessDisplayName } from "@membral/core";
import type { SessionFact } from "./import-sessions.js";

export interface FirstRunSummary {
  windowDays: number;
  /** Start of the import window (ISO); span dates never reach before it. */
  windowStart: string;
  sessions: readonly SessionFact[];
}

const DAY_MS = 86_400_000;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Returns the report lines (no indent, no emoji). Sessions count sub-agents too. */
export function renderFirstRunReport(summary: FirstRunSummary): string[] {
  const { sessions, windowDays, windowStart } = summary;
  const windowStartMs = Date.parse(windowStart);
  if (sessions.length === 0) return [`No past sessions found in the last ${windowDays} days.`];

  const perHarness = new Map<string, number>();
  let subAgents = 0;
  let earliest = Number.POSITIVE_INFINITY;
  let latest = Number.NEGATIVE_INFINITY;
  for (const s of sessions) {
    perHarness.set(s.harness, (perHarness.get(s.harness) ?? 0) + 1);
    if (s.isSubAgent) subAgents++;
    let t = Date.parse(s.startedAt);
    if (!Number.isNaN(t) && !Number.isNaN(windowStartMs)) t = Math.max(t, windowStartMs);
    if (!Number.isNaN(t)) {
      earliest = Math.min(earliest, t);
      latest = Math.max(latest, t);
    }
  }

  const harnesses = [...perHarness.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([h, n]) => `${harnessDisplayName(h)} ${n}`)
    .join(", ");
  const pct = Math.round((subAgents / sessions.length) * 100);
  const lines = [
    `Found on this machine, last ${windowDays} days: ${plural(sessions.length, "session")}`,
    `  By harness: ${harnesses}`,
    `  Sub-agents: ${subAgents} of ${sessions.length} (${pct}%)`,
  ];
  if (Number.isFinite(earliest)) {
    const days = Math.max(1, Math.round((latest - earliest) / DAY_MS) + 1);
    lines.push(
      `  Span: ${new Date(earliest).toISOString().slice(0, 10)} to ${new Date(latest).toISOString().slice(0, 10)} (${plural(days, "day")})`,
    );
  }
  return lines;
}
