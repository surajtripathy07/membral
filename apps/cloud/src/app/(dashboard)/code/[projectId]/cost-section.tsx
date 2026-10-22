// W11/D12 — the code-project page's "$" / model-usage section. Was missing
// entirely before this fix (the page had no cost/model breakdown at all);
// root cause of the broader bug this closes: /pulse's "Agent work & cost"
// module (and this page, now that it exists) must show every model that ran
// in a session — main transcript AND its Task/Agent sub-agent spawns — not
// just the main transcript's model. See lib/agent-stats/aggregate.ts's
// aggregateAgentStats doc comment for the accumulator-level fix.
//
// Pure presentational component (same renderToStaticMarkup-testable split as
// project-facts.tsx/session-facts.tsx) — page.tsx does the query + calls
// aggregateAgentStats server-side and passes the result in, so this file has
// no Supabase/fetch of its own.
//
// UX audit B4: the header already shows the project's 30-day total, so this
// section is now a collapsed `Disclosure` ("by model" drill-down) instead of
// its own always-expanded card — the audit's "COLLAPSE behind a <details>
// 'by model', sitting next to the header's $" verdict. Money via
// `fmtUsdEst` only (§3.8/§5: every derived cost keeps its "est." marker).
import { Disclosure } from "@/components/ui/disclosure";
import { formatTokenCount } from "@/lib/format/numbers";
import { fmtUsdEst } from "@/lib/format/usd";
import type { AgentStatsAggregate } from "@/lib/agent-stats/aggregate";

export function ProjectCostSection({ aggregate }: { aggregate: AgentStatsAggregate | null }) {
  // Only a genuine query failure (aggregate itself is null) renders nothing.
  if (!aggregate) return null;
  const { totals, by_model, coverage } = aggregate;
  // W9 (2026-09-12 refocus goal, D9; fix pass 2 finding #10): sessions exist
  // but nothing in the window was priceable, OR the window has zero
  // sessions at all (the common tusk-demo case — most projects' activity
  // sits outside the last 30 days) — render one honest line instead of
  // nothing, so the section never silently disappears. The `sessions === 0`
  // check used to short-circuit to `null` BEFORE this branch could run,
  // which is exactly why `project-tusk-demo.png` had no cost section at all.
  if (totals.sessions === 0 || (coverage.sessions_with_usage === 0 && totals.subagent_runs === 0)) {
    return (
      <section className="rounded-card border border-line bg-surface p-6">
        <h2 className="section-label">Model usage · last 30 days</h2>
        <p className="mt-1 text-body-sm text-muted">No priced usage in the last 30 days.</p>
      </section>
    );
  }

  const subagentNote =
    totals.subagent_runs > 0
      ? ` · incl. ${totals.subagent_runs} sub-agent run${totals.subagent_runs === 1 ? "" : "s"}`
      : "";

  return (
    <Disclosure
      summary={`Model usage · last 30 days · ${fmtUsdEst(totals.cost_usd)}`}
      count={by_model.length}
      className="rounded-card border border-line bg-surface p-4"
    >
      <p className="text-micro text-muted">inferred from token usage, main transcript + sub-agent runs{subagentNote}</p>
      {by_model.length > 0 && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-label">
            <thead>
              <tr className="text-left text-muted">
                <th scope="col" className="py-1 pr-4 font-normal">Model</th>
                <th scope="col" className="py-1 pr-4 font-normal">Runs</th>
                <th scope="col" className="py-1 pr-4 font-normal">Tokens</th>
                <th scope="col" className="py-1 font-normal">Cost</th>
              </tr>
            </thead>
            <tbody>
              {by_model.map((m) => (
                <tr key={m.model_tier} className="border-t border-line-soft">
                  <td className="py-1 pr-4 text-ink-2">{m.model_tier}</td>
                  <td className="py-1 pr-4 tabular-nums text-muted">{m.runs}</td>
                  <td className="py-1 pr-4 tabular-nums text-muted">{formatTokenCount(m.tokens)}</td>
                  <td className="py-1 tabular-nums text-ink-2">{fmtUsdEst(m.cost_usd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Disclosure>
  );
}
