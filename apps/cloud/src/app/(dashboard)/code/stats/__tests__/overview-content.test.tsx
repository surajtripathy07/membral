// #93 — render checks for OverviewContent (the /code/stats "Model usage"
// card's pure render half). renderToStaticMarkup pattern established in
// project-facts.test.tsx.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentStatsAggregate } from "@/lib/agent-stats/aggregate";
import { OverviewContent } from "../overview-content";

function aggregate(overrides: Partial<AgentStatsAggregate> = {}): AgentStatsAggregate {
  return {
    totals: {
      cost_usd: 10,
      sessions: 5,
      turns: 100,
      user_turns: 30,
      tokens: { input: 100_000, output: 50_000, cache_read: 900_000, cache_creation: 40_000 },
      subagent_cost_usd: 0,
      subagent_runs: 0,
    },
    daily: [],
    monthly: [],
    by_model: [
      {
        model_tier: "Sonnet",
        cost_usd: 10,
        tokens: 1_090_000,
        runs: 5,
        sessions: 5,
        token_buckets: { input: 100_000, output: 50_000, cache_read: 900_000, cache_creation: 40_000 },
      },
    ],
    coverage: { sessions_total: 5, sessions_with_usage: 5 },
    ...overrides,
  };
}

describe("OverviewContent", () => {
  it("renders the empty state when there's no data", () => {
    const html = renderToStaticMarkup(<OverviewContent data={null} windowDays={30} />);
    expect(html).toContain("No agent sessions in the last 30 days.");
  });

  it("says the total is counted from session transcripts, not the bill (#410)", () => {
    const html = renderToStaticMarkup(<OverviewContent data={aggregate()} windowDays={30} />);
    expect(html).toContain("Counted from your session transcripts. Your Claude bill can run higher");
    expect(html).toContain("titles, page summaries, context compaction");
  });

  it("does not render a main/sub-agent split when there are no sub-agent runs", () => {
    const html = renderToStaticMarkup(<OverviewContent data={aggregate()} windowDays={30} />);
    expect(html).not.toContain("sub-agents (");
  });

  it("renders a main-vs-sub-agent cost split next to the total when sub-agent runs are present", () => {
    const data = aggregate({
      totals: {
        cost_usd: 10,
        sessions: 5,
        turns: 100,
        user_turns: 30,
        tokens: { input: 100_000, output: 50_000, cache_read: 900_000, cache_creation: 40_000 },
        subagent_cost_usd: 4,
        subagent_runs: 3,
      },
    });
    const html = renderToStaticMarkup(<OverviewContent data={data} windowDays={30} />);
    expect(html).toContain("sub-agents (");
    expect(html).toContain("3 run");
    expect(html).toContain("$4.00");
    expect(html).toContain("$6.00"); // main = 10 - 4
  });

  it("renders per-model columns for sessions and all four token buckets", () => {
    const html = renderToStaticMarkup(<OverviewContent data={aggregate()} windowDays={30} />);
    expect(html).toContain("Sessions");
    expect(html).toContain("Input");
    expect(html).toContain("Output");
    expect(html).toContain("Cache read");
    expect(html).toContain("Cache write");
    expect(html).toContain("Sonnet");
  });

  it("renders the priced-sessions coverage line", () => {
    const html = renderToStaticMarkup(<OverviewContent data={aggregate()} windowDays={30} />);
    expect(html).toContain("5 of 5 sessions priced");
  });

  it("renders the total cost as the largest (text-display) element", () => {
    const html = renderToStaticMarkup(<OverviewContent data={aggregate()} windowDays={30} />);
    expect(html).toMatch(/class="[^"]*text-display[^"]*"[^>]*>\$10\.00/);
  });

  // W9 (2026-09-12 refocus goal, D9): tusk-demo's "0 of 2 sessions priced"
  // used to render an empty card with a bare "−" glyph — this is the named
  // empty-state block replacing it, distinct from the "zero sessions at
  // all" (data === null) case above.
  it("renders the 'No priced usage yet' block when sessions exist but none were priceable", () => {
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
    const html = renderToStaticMarkup(<OverviewContent data={data} windowDays={30} />);
    expect(html).toContain("No priced usage yet");
    expect(html).toContain("None of your 2 sessions in the last 30 days");
    expect(html).not.toContain("−");
  });
});
