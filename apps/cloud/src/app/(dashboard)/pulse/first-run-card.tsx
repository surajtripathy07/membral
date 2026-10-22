// "Your history" (W5 D4): what the first import brought in, shown on /pulse for a user's first week.
// Pure presentational, same split as cost-line.tsx / pulse-content.tsx. Tokens only (globals.css).
import type { FirstRunHistory } from "@/lib/code-sessions/first-run";

const DAY_MS = 86_400_000;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const day = (iso: string) => iso.slice(0, 10);

export function FirstRunCard({ history }: { history: FirstRunHistory }) {
  const { total, perHarness, subAgents, earliestStart, latestStart, memoryCount } = history;
  const pct = total > 0 ? Math.round((subAgents / total) * 100) : 0;
  const span =
    earliestStart && latestStart
      ? `${day(earliestStart)} to ${day(latestStart)} (${plural(
          Math.max(1, Math.round((Date.parse(latestStart) - Date.parse(earliestStart)) / DAY_MS) + 1),
          "day",
        )})`
      : null;
  const rows: { label: string; value: string }[] = [
    { label: "Sessions", value: `${total} (${perHarness.map((h) => `${h.label} ${h.count}`).join(", ")})` },
    { label: "Sub-agents", value: `${subAgents} of ${total} (${pct}%)` },
    ...(span ? [{ label: "Span", value: span }] : []),
    {
      label: "Memories",
      value: memoryCount === 0 ? "0 (memories appear as extraction runs)" : memoryCount === 1 ? "1 memory" : `${memoryCount} memories`,
    },
  ];
  return (
    <section className="mt-6" data-testid="first-run-card" aria-labelledby="pulse-first-run">
      <h2 id="pulse-first-run" className="section-label">
        Your history
      </h2>
      <dl className="mt-3 rounded-card border border-line bg-surface">
        {rows.map((r) => (
          <div key={r.label} className="flex gap-3 border-line-soft border-b px-4 py-2 last:border-b-0">
            <dt className="w-24 shrink-0 text-body-sm text-muted">{r.label}</dt>
            <dd className="min-w-0 text-body-sm text-ink">{r.value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
