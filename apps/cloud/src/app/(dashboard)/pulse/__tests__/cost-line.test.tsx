// CostLine (UX audit B2): Today's one-line 30-day spend, replacing the
// AgentWorkPanel charts. Pure half only — renderToStaticMarkup, no fetch.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AgentStatsTotals } from "@/lib/agent-stats/aggregate";
import { CostLineContent, type CostLineContentProps, costDelta, USAGE_HREF } from "../cost-line";

function totals(overrides: Partial<AgentStatsTotals> = {}): AgentStatsTotals {
  return {
    cost_usd: 1577.12,
    sessions: 101,
    turns: 0,
    user_turns: 0,
    tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
    subagent_cost_usd: 0,
    subagent_runs: 0,
    ...overrides,
  } as AgentStatsTotals;
}

function data(overrides: Partial<NonNullable<CostLineContentProps["data"]>> = {}): CostLineContentProps["data"] {
  return {
    totals: totals(),
    previous_totals: totals({ cost_usd: 2503.4 }),
    coverage: { sessions_total: 101, sessions_with_usage: 87 },
    ...overrides,
  };
}

function render(props: Partial<CostLineContentProps> = {}) {
  return renderToStaticMarkup(<CostLineContent loading={false} error={null} data={data()} {...props} />);
}

describe("CostLineContent", () => {
  it("one line: fmtUsd total, window, delta, sessions with priced coverage, and a link to Usage", () => {
    const html = render();
    expect(html).toContain("$1,577");
    expect(html).toContain("spent · 30d");
    expect(html).toContain("▼37% vs prior 30d");
    expect(html).toContain("101 sessions (87 of 101 priced)");
    expect(html).toContain(`href="${USAGE_HREF}"`);
    expect(html).toContain("Usage →");
    expect(html).toContain('data-testid="cost-line"');
  });

  it("an unpriced window reads — (never $0.00) and drops the delta", () => {
    const html = render({ data: data({ totals: totals({ cost_usd: null }) }) });
    expect(html).toContain("—");
    expect(html).not.toContain("$0.00");
    expect(html).not.toContain("vs prior");
  });

  it("omits the coverage note when every session is priced", () => {
    const html = render({ data: data({ coverage: { sessions_total: 101, sessions_with_usage: 101 } }) });
    expect(html).toContain("101 sessions");
    expect(html).not.toContain("priced");
  });

  it("loading is a one-line placeholder; an error still links to Usage", () => {
    expect(render({ loading: true, data: null })).toContain("animate-pulse");
    const err = render({ error: "boom", data: null });
    expect(err).toContain("30-day cost unavailable");
    expect(err).toContain(`href="${USAGE_HREF}"`);
  });

  it("costDelta: arrows by direction, null without a priced prior window", () => {
    expect(costDelta(150, 100)).toEqual({ text: "▲50% vs prior 30d", direction: "up" });
    expect(costDelta(100, 100)?.direction).toBe("flat");
    expect(costDelta(100, 0)).toBeNull();
    expect(costDelta(null, 100)).toBeNull();
    expect(costDelta(100, null)).toBeNull();
  });

  it("uses tokens only", () => {
    const src = readFileSync(join(__dirname, "..", "cost-line.tsx"), "utf8");
    expect(src).not.toMatch(/(bg|text|border)-(gray|slate|blue|indigo|emerald|amber|rose)-\d+/);
    expect(src).not.toMatch(/text-\[\d/);
  });
});
