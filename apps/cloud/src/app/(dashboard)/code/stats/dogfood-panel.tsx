// "Membral on Membral" panel on /code/stats (goal 2026-10-10 recall-precision,
// box 9, §W3b). Pure render half; lib/memory/dogfood-signals.ts defines every
// count and its source. Same card and table shape as the served-and-used block.
import { Card } from "@/components/ui/card";
import { sessionHref } from "@/components/session-title-list";
import type { DogfoodCounts, DogfoodSignals } from "@/lib/memory/dogfood-signals";
import type { DogfoodPanelData } from "./dogfood-load";

const ROWS: Array<{ key: string; label: string; value: (c: DogfoodCounts) => number }> = [
  { key: "served", label: "Records served", value: (c) => c.served },
  { key: "used", label: "Used (quoted or edited after serving)", value: (c) => c.used },
  { key: "ignored", label: "Ignored", value: (c) => c.ignored },
  { key: "pending", label: "Not yet checked (under 24 h)", value: (c) => c.pending },
  { key: "unlinked", label: "Never linked to a session", value: (c) => c.unlinked },
  { key: "confirmed", label: "Confirmed by the session", value: (c) => c.confirmed },
  { key: "contradicted", label: "Contradicted by the session", value: (c) => c.contradicted },
  { key: "empty-searches", label: "Searches that returned nothing", value: (c) => c.empty },
  { key: "below-floor", label: "… below the relevance floor", value: (c) => c.empty_below_floor },
  { key: "hook-calls", label: "Prompt hook calls", value: (c) => c.hook.calls },
  { key: "hook-budget", label: "Prompt hook budget hit or timed out", value: (c) => c.hook.budget_hit + c.hook.timeout },
  { key: "feedback", label: "Feedback about Membral", value: (c) => c.feedback.total },
];

/** True when neither window has any signal: a fresh user. */
export function isDogfoodEmpty(data: DogfoodPanelData | null): boolean {
  if (!data) return true;
  const s: DogfoodSignals = data.month;
  return s.weeks.length === 0 && s.quotes.length === 0;
}

export function DogfoodPanel({ data }: { data: DogfoodPanelData | null }) {
  return (
    <Card padding={6} data-testid="dogfood-panel">
      <h2 className="section-label">Membral on Membral</h2>
      {!data || isDogfoodEmpty(data) ? (
        <p className="mt-3 text-body text-muted" data-testid="dogfood-empty">
          Nothing yet. Once Membral serves records to your sessions, or a session says something about Membral, the
          counts and quotes show here.
        </p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th scope="col" className="py-2 pr-4 pl-4 font-normal">Signal</th>
                  <th scope="col" className="py-2 pr-4 text-right font-normal">7 days</th>
                  <th scope="col" className="py-2 pr-4 text-right font-normal">30 days</th>
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => (
                  <tr key={row.key} className="border-line-soft border-t" data-testid={`dogfood-${row.key}`}>
                    <th scope="row" className="py-2 pr-4 pl-4 text-left font-normal text-ink">
                      {row.label}
                    </th>
                    <td className="py-2 pr-4 text-right tabular-nums text-ink">{row.value(data.week.totals)}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-ink-2">{row.value(data.month.totals)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-micro text-muted">
            Confirmed and contradicted are the extraction pass's reading of each session against what was served to it,
            each with a quote. Feedback is what you or the agent said about Membral in a session.
          </p>
          <h3 className="mt-4 text-label text-muted">Latest feedback</h3>
          {data.month.quotes.length === 0 ? (
            <p className="mt-2 text-body-sm text-muted" data-testid="dogfood-no-quotes">
              No session said anything about Membral in the last 30 days.
            </p>
          ) : (
            <ul className="mt-2 space-y-2" data-testid="dogfood-quotes">
              {data.month.quotes.map((q) => (
                <li key={q.id} className="text-body-sm">
                  <span className="text-label text-muted">{q.sentiment}</span>{" "}
                  <a className="text-ink hover:underline" href={sessionHref(q.code_session_id, q.turn_idx)}>
                    “{q.quote}”
                  </a>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Card>
  );
}
