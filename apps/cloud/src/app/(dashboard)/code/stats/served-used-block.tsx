// "Served and used (last 7 days)" block on /code/stats (goal 2026-10-10
// recall-precision, L7). Pure render half; the numbers come from
// lib/memory/served-used.ts, whose header defines every column.
//
// WORDING. "used" is co-occurrence (a served quote appeared in an assistant
// turn, or a served record's path was edited after serving), not proof the
// record helped — the copy says so and never claims causation.
import { Card } from "@/components/ui/card";
import type { ServedUsedSummary } from "@/lib/memory/served-used";

const SURFACE_LABEL: Record<string, string> = {
  mcp: "Search and recall (MCP)",
  preamble: "Session start",
  prompt_hook: "Prompt hook",
};

export function ServedUsedBlock({ summary }: { summary: ServedUsedSummary | null }) {
  const heading = `Served and used (last ${summary?.days ?? 7} days)`;
  return (
    <Card padding={6} data-testid="served-used">
      <h2 className="section-label">{heading}</h2>
      {!summary || summary.surfaces.length === 0 ? (
        <p className="mt-3 text-body text-muted" data-testid="served-used-empty">
          No memory records were served to your sessions in this window.
        </p>
      ) : (
        <>
          <div className="mt-3 overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full text-body-sm">
              <thead>
                <tr className="text-left text-muted">
                  <th scope="col" className="py-2 pr-4 pl-4 font-normal">Surface</th>
                  <th scope="col" className="py-2 pr-4 text-right font-normal">Served</th>
                  <th scope="col" className="py-2 pr-4 text-right font-normal">Used</th>
                  <th scope="col" className="py-2 pr-4 text-right font-normal">Ignored</th>
                  <th scope="col" className="py-2 pr-4 text-right font-normal">Pending</th>
                  <th scope="col" className="py-2 pr-4 text-right font-normal">Unlinked</th>
                </tr>
              </thead>
              <tbody>
                {summary.surfaces.map((row) => (
                  <tr key={row.surface} className="border-line-soft border-t" data-testid={`served-used-${row.surface}`}>
                    <th scope="row" className="py-2 pr-4 pl-4 text-left font-normal text-ink">
                      {SURFACE_LABEL[row.surface] ?? row.surface}
                    </th>
                    <td className="py-2 pr-4 text-right tabular-nums text-ink">{row.served}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-ink">{row.used}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-ink-2">{row.ignored}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-muted">{row.pending}</td>
                    <td className="py-2 pr-4 text-right tabular-nums text-muted">{row.unlinked}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-micro text-muted">
            Counts are records, not calls. Used means quoted or edited after serving; it shows the record appeared in the work, not that it caused it.
            Ignored: the session was checked and neither happened. Pending: under 24 hours old, the session may still be uploaded and checked. Unlinked: not linked to an uploaded session.
          </p>
        </>
      )}
    </Card>
  );
}
