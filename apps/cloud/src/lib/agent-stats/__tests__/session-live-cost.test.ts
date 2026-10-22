// UX W5: sessionLiveCostUsd is the session header's own pricing path
// (aggregateAgentStats on one session) — main transcript plus sub-agents.
import { describe, expect, it } from "vitest";
import { aggregateAgentStats, sessionLiveCostUsd } from "../aggregate";

const USAGE = { inputTokens: 1000, outputTokens: 500, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

describe("sessionLiveCostUsd", () => {
  it("equals the session header's one-day aggregate, sub-agents included", () => {
    const row = {
      id: "s-1",
      started_at: "2026-09-20T10:00:00Z",
      turn_count: 4,
      user_turn_count: 2,
      props: {
        usage: USAGE,
        models: ["claude-sonnet-5"],
        subAgents: [{ model: "claude-haiku-4-5", usage: USAGE, isFork: false }],
      },
    };
    const header = aggregateAgentStats([row], { tz: "UTC", startDate: "2026-09-20", endDate: "2026-09-20" }).totals
      .cost_usd;
    const mainOnly = sessionLiveCostUsd({ ...row, props: { usage: USAGE, models: ["claude-sonnet-5"] } });
    expect(sessionLiveCostUsd(row)).toBe(header);
    expect(header ?? 0).toBeGreaterThan(mainOnly ?? 0);
  });

  it("is null for a session with no priceable usage", () => {
    expect(
      sessionLiveCostUsd({ id: "s", started_at: null, turn_count: 0, user_turn_count: 0, props: null }),
    ).toBeNull();
  });
});
