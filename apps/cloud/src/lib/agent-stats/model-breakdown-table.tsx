// #93 (usage visibility that reconciles) — the shared per-model breakdown
// table (model, sessions, input/output/cache-read/cache-write tokens, cost)
// rendered on BOTH /code/stats (across every project) and
// /code/session/[id] (scoped to one session, including its sub-agents) —
// one render implementation so the two surfaces can never drift, matching
// this file's own precedent of one pricing/grouping path (aggregateAgentStats)
// for every consumer.
//
// W9 (2026-09-12 refocus goal, D9): tokens instead of raw grays, numeric
// columns right-aligned in tabular-nums monospace, and a Total row summing
// every numeric column — "the one number the user came for" per the design
// critique, now available wherever this table renders.
//
// UX W5: the 7-column table only renders at `md:` and up. Below it (390px
// phone), each model is ONE stacked block — "Model · $cost" then a muted line
// of sessions and token buckets — the same fix as the Issues and Usage
// tables, so nothing scrolls sideways inside its card.
//
// UX W6: costs use the one money formatter (`fmtUsd`), so the Total reads
// "$1,649" exactly as the Usage hero does. The Total row's Sessions cell is
// BLANK: a session that used two models counts once per model above, so the
// column does not sum to a session count, and printing that sum (149)
// beside the hero's distinct count (101) contradicted it.
import type { AgentStatsModelTotal } from "./aggregate";
import { formatTokenCount } from "@/lib/format/numbers";
import { fmtUsd } from "@/lib/format/usd";

export function ModelBreakdownTable({ byModel }: { byModel: AgentStatsModelTotal[] }) {
  if (byModel.length === 0) return null;

  const total = byModel.reduce(
    (acc, m) => ({
      input: acc.input + m.token_buckets.input,
      output: acc.output + m.token_buckets.output,
      cache_read: acc.cache_read + m.token_buckets.cache_read,
      cache_creation: acc.cache_creation + m.token_buckets.cache_creation,
      cost_usd: acc.cost_usd + m.cost_usd,
    }),
    { input: 0, output: 0, cache_read: 0, cache_creation: 0, cost_usd: 0 },
  );

  const rows = [
    ...byModel.map((m) => ({
      key: m.model_tier,
      label: m.model_tier,
      sessions: m.sessions as number | null,
      input: m.token_buckets.input,
      output: m.token_buckets.output,
      cache_read: m.token_buckets.cache_read,
      cache_creation: m.token_buckets.cache_creation,
      cost_usd: m.cost_usd,
      total: false,
    })),
    { key: "__total", label: "Total", sessions: null, ...total, total: true },
  ];

  const NUM = "hidden py-1 pr-4 text-right font-mono tabular-nums md:table-cell";

  return (
    <table className="block w-full text-label md:table" data-testid="model-breakdown">
      <thead className="hidden md:table-header-group">
        <tr className="text-left text-muted">
          <th scope="col" className="py-1 pr-4 font-normal">Model</th>
          <th scope="col" className="py-1 pr-4 text-right font-normal">Sessions</th>
          <th scope="col" className="py-1 pr-4 text-right font-normal">Input</th>
          <th scope="col" className="py-1 pr-4 text-right font-normal">Output</th>
          <th scope="col" className="py-1 pr-4 text-right font-normal">Cache read</th>
          <th scope="col" className="py-1 pr-4 text-right font-normal">Cache write</th>
          <th scope="col" className="py-1 text-right font-normal">Cost</th>
        </tr>
      </thead>
      <tbody className="block md:table-row-group">
        {rows.map((r) => {
          const tone = r.total ? "text-ink-2" : "text-muted";
          return (
            <tr
              key={r.key}
              className={`block border-t md:table-row ${r.total ? "border-line font-medium" : "border-line-soft"}`}
            >
              <td className={`hidden py-1 pr-4 md:table-cell ${r.total ? "text-ink" : "text-ink-2"}`}>{r.label}</td>
              <td className={`${NUM} ${tone}`}>{r.sessions ?? ""}</td>
              <td className={`${NUM} ${tone}`}>{formatTokenCount(r.input)}</td>
              <td className={`${NUM} ${tone}`}>{formatTokenCount(r.output)}</td>
              <td className={`${NUM} ${tone}`}>{formatTokenCount(r.cache_read)}</td>
              <td className={`${NUM} ${tone}`}>{formatTokenCount(r.cache_creation)}</td>
              <td className={`hidden py-1 text-right font-mono tabular-nums md:table-cell ${r.total ? "text-accent" : "text-ink-2"}`}>
                {fmtUsd(r.cost_usd)}
              </td>

              {/* Phone-only stacked block: the same row in two lines. */}
              <td className="block py-1.5 md:hidden">
                <div className="flex items-baseline justify-between gap-3">
                  <span className={r.total ? "text-ink" : "text-ink-2"}>{r.label}</span>
                  <span className={`font-mono tabular-nums ${r.total ? "text-accent" : "text-ink-2"}`}>
                    {fmtUsd(r.cost_usd)}
                  </span>
                </div>
                <div className="mt-0.5 font-mono text-micro text-muted tabular-nums">
                  {r.sessions !== null && `${r.sessions} session${r.sessions === 1 ? "" : "s"} · `}in{" "}
                  {formatTokenCount(r.input)} · out{" "}
                  {formatTokenCount(r.output)} · cache {formatTokenCount(r.cache_read)}/{formatTokenCount(r.cache_creation)}
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
