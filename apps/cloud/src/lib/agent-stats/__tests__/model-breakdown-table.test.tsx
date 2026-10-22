// UX W5: at phone width the model table is stacked blocks, not a 7-column table.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentStatsModelTotal } from "../aggregate";
import { ModelBreakdownTable } from "../model-breakdown-table";

const row = (model_tier: AgentStatsModelTotal["model_tier"], cost_usd: number): AgentStatsModelTotal => ({
  model_tier,
  cost_usd,
  tokens: 3000,
  runs: 1,
  sessions: 1,
  token_buckets: { input: 1000, output: 1000, cache_read: 500, cache_creation: 500 },
});

describe("ModelBreakdownTable", () => {
  it("renders the 7-column table only from md: up and one stacked block per model (plus Total) below it", () => {
    const html = renderToStaticMarkup(<ModelBreakdownTable byModel={[row("Opus", 3), row("Sonnet", 1)]} />);
    expect(html).toContain("hidden md:table-header-group");
    expect(html).not.toContain("overflow-x-auto");
    expect(html.match(/md:hidden/g)).toHaveLength(3);
    expect(html).toContain("Total");
  });

  it("formats cost with fmtUsd, so the Total reads like the Usage hero", () => {
    const html = renderToStaticMarkup(<ModelBreakdownTable byModel={[row("Opus", 1200.4), row("Sonnet", 448.25)]} />);
    expect(html).toContain("$1,649");
    expect(html).not.toContain("$1648.65");
  });

  it("leaves the Total row's Sessions cell blank: per-model session counts do not sum to distinct sessions", () => {
    const html = renderToStaticMarkup(<ModelBreakdownTable byModel={[row("Opus", 3), row("Sonnet", 1)]} />);
    const totalRow = html.slice(html.lastIndexOf("<tr"));
    expect(totalRow).not.toMatch(/>2</);
    expect(totalRow).not.toContain("session");
  });

  it("renders nothing for no models", () => {
    expect(renderToStaticMarkup(<ModelBreakdownTable byModel={[]} />)).toBe("");
  });
});
