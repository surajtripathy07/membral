// W11/D12 — render checks for ProjectCostSection (the code-project page's
// $/model breakdown). renderToStaticMarkup pattern established in
// project-facts.test.tsx.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentStatsAggregate } from "@/lib/agent-stats/aggregate";
import { ProjectCostSection } from "../cost-section";

function aggregate(overrides: Partial<AgentStatsAggregate> = {}): AgentStatsAggregate {
  return {
    totals: {
      cost_usd: 4.5,
      sessions: 3,
      turns: 60,
      user_turns: 20,
      tokens: { input: 10_000, output: 5_000, cache_read: 200_000, cache_creation: 8_000 },
      subagent_cost_usd: 1.5,
      subagent_runs: 4,
    },
    daily: [],
    monthly: [],
    by_model: [
      {
        model_tier: "Fable",
        cost_usd: 3,
        tokens: 150_000,
        runs: 3,
        sessions: 3,
        token_buckets: { input: 100_000, output: 40_000, cache_read: 8_000, cache_creation: 2_000 },
      },
      {
        model_tier: "Sonnet",
        cost_usd: 1.5,
        tokens: 73_000,
        runs: 4,
        sessions: 2,
        token_buckets: { input: 50_000, output: 20_000, cache_read: 2_000, cache_creation: 1_000 },
      },
    ],
    coverage: { sessions_total: 3, sessions_with_usage: 3 },
    ...overrides,
  };
}

describe("ProjectCostSection", () => {
  it("renders nothing when there's no aggregate at all (query failed/degraded)", () => {
    expect(renderToStaticMarkup(<ProjectCostSection aggregate={null} />)).toBe("");
  });

  // Fix pass 2 (after-critique finding #10): this used to short-circuit to
  // `null` BEFORE the honest "No priced usage" branch could run — a project
  // whose 30-day window has zero sessions at all (the common case: most
  // activity sits outside the window) rendered no cost section whatsoever
  // instead of an honest line, which is exactly the "project-tusk-demo.png
  // has no cost section at all" defect the critique caught.
  it("renders the 'No priced usage' message (not nothing) when the project has zero sessions in the window", () => {
    const data = aggregate({ totals: { ...aggregate().totals, sessions: 0 } });
    const html = renderToStaticMarkup(<ProjectCostSection aggregate={data} />);
    expect(html).not.toBe("");
    expect(html).toContain("No priced usage in the last 30 days");
  });

  it("renders a one-line 'no priced usage' message when sessions exist but none are priceable (W9 empty state)", () => {
    const data = aggregate({
      totals: {
        cost_usd: null,
        sessions: 2,
        turns: 10,
        user_turns: 4,
        tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
        subagent_cost_usd: 0,
        subagent_runs: 0,
      },
      by_model: [],
      coverage: { sessions_total: 2, sessions_with_usage: 0 },
    });
    const html = renderToStaticMarkup(<ProjectCostSection aggregate={data} />);
    expect(html).not.toBe("");
    expect(html).toContain("No priced usage in the last 30 days");
  });

  it("renders the header cost, per-model table (model/runs/tokens/cost), and the sub-agent-runs note", () => {
    const html = renderToStaticMarkup(<ProjectCostSection aggregate={aggregate()} />);
    expect(html).toContain("Model usage");
    expect(html).toContain("last 30 days");
    expect(html).toContain("$4.50");
    expect(html).toContain("Fable");
    expect(html).toContain("Sonnet");
    expect(html).toContain("incl. 4 sub-agent runs");
  });

  it("omits the 'incl. N sub-agent runs' clause when subagent_runs is zero", () => {
    const data = aggregate({ totals: { ...aggregate().totals, subagent_cost_usd: 0, subagent_runs: 0 } });
    const html = renderToStaticMarkup(<ProjectCostSection aggregate={data} />);
    expect(html).toContain("main transcript + sub-agent runs");
    expect(html).not.toContain("incl.");
  });
});
