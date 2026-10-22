// ADR 0032 module B — aggregation correctness, incl. the "$0.00 vs —" rule
// (§3 B6) and tz-explicit day bucketing (§3, open question 5).
import { describe, expect, it } from "vitest";
import { type AgentStatsSessionInput, aggregateAgentStats, computeCumulative, tierLabelForModel } from "../aggregate";

function session(overrides: Partial<AgentStatsSessionInput> = {}): AgentStatsSessionInput {
  return {
    id: "s1",
    started_at: "2026-07-20T12:00:00.000Z",
    turn_count: 10,
    user_turn_count: 4,
    props: null,
    ...overrides,
  };
}

const VALID_USAGE = {
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cacheReadInputTokens: 200_000,
  cacheCreationInputTokens: 50_000,
};

describe("aggregateAgentStats", () => {
  it("sums totals, tokens and cost across priced sessions", () => {
    const rows = [
      session({ id: "a", props: { usage: VALID_USAGE, models: ["claude-sonnet-5"] } }),
      session({ id: "b", props: { usage: VALID_USAGE, models: ["claude-sonnet-5"] } }),
    ];
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" });
    expect(result.totals.sessions).toBe(2);
    expect(result.totals.turns).toBe(20);
    expect(result.totals.user_turns).toBe(8);
    expect(result.totals.tokens.input).toBe(2_000_000);
    expect(result.totals.cost_usd).not.toBeNull();
    expect(result.totals.cost_usd).toBeGreaterThan(0);
    expect(result.coverage).toEqual({ sessions_total: 2, sessions_with_usage: 2 });
  });

  it("a session with no usage counts toward sessions/turns but not coverage.sessions_with_usage or tokens", () => {
    const rows = [
      session({ id: "priced", props: { usage: VALID_USAGE, models: ["claude-sonnet-5"] } }),
      session({ id: "unpriced", props: null }),
    ];
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" });
    expect(result.totals.sessions).toBe(2);
    expect(result.coverage).toEqual({ sessions_total: 2, sessions_with_usage: 1 });
  });

  it("the $0.00-vs-— rule: zero priced sessions yields cost_usd === null, never 0", () => {
    const rows = [session({ props: null }), session({ props: { usage: { inputTokens: "nope" } } })];
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" });
    expect(result.totals.cost_usd).toBeNull();
    expect(result.coverage).toEqual({ sessions_total: 2, sessions_with_usage: 0 });
    expect(result.by_model).toEqual([]);
  });

  it("a malformed/partial usage blob (two-bucket legacy shape) is treated as unpriced, never NaN", () => {
    const rows = [session({ props: { usage: { inputTokens: 100, outputTokens: 50 } } })];
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" });
    expect(result.totals.cost_usd).toBeNull();
    expect(Number.isNaN(result.totals.tokens.input)).toBe(false);
  });

  it("groups by_model in the fixed Fable/Opus/Sonnet/Haiku/Other order, skipping absent tiers", () => {
    const rows = [
      session({ id: "f", props: { usage: VALID_USAGE, models: ["claude-fable-5"] } }),
      session({ id: "o", props: { usage: VALID_USAGE, models: ["claude-opus-4"] } }),
      session({ id: "h", props: { usage: VALID_USAGE, models: ["claude-haiku-4"] } }),
      session({ id: "x", props: { usage: VALID_USAGE, models: ["codehub-model-1"] } }),
    ];
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" });
    expect(result.by_model.map((m) => m.model_tier)).toEqual(["Fable", "Opus", "Haiku", "Other"]);
    for (const m of result.by_model) {
      expect(m.cost_usd).toBeGreaterThan(0);
      expect(m.runs).toBe(1);
    }
  });

  it("zero-filled daily buckets span the full [startDate, endDate] window even with no sessions on some days", () => {
    const rows = [session({ started_at: "2026-07-20T12:00:00.000Z", props: { usage: VALID_USAGE, models: ["s"] } })];
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-18", endDate: "2026-07-21" });
    expect(result.daily.map((d) => d.date)).toEqual(["2026-07-18", "2026-07-19", "2026-07-20", "2026-07-21"]);
    expect(result.daily.find((d) => d.date === "2026-07-20")?.cost_usd).toBeGreaterThan(0);
    expect(result.daily.find((d) => d.date === "2026-07-19")?.cost_usd).toBe(0);
    expect(result.daily.find((d) => d.date === "2026-07-19")?.sessions).toBe(0);
  });

  it("tz bucketing edge: a session just after UTC midnight lands on the previous calendar day in a negative-offset tz", () => {
    // 2026-07-21T02:00:00Z is 2026-07-20T19:00 in America/Los_Angeles (UTC-7 in July, DST).
    const rows = [
      session({ id: "late-utc", started_at: "2026-07-21T02:00:00.000Z", props: { usage: VALID_USAGE, models: ["s"] } }),
    ];
    const utcResult = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-20", endDate: "2026-07-21" });
    const laResult = aggregateAgentStats(rows, {
      tz: "America/Los_Angeles",
      startDate: "2026-07-20",
      endDate: "2026-07-21",
    });
    expect(utcResult.daily.find((d) => d.date === "2026-07-21")?.sessions).toBe(1);
    expect(utcResult.daily.find((d) => d.date === "2026-07-20")?.sessions).toBe(0);
    expect(laResult.daily.find((d) => d.date === "2026-07-20")?.sessions).toBe(1);
    expect(laResult.daily.find((d) => d.date === "2026-07-21")?.sessions).toBe(0);
  });

  it("an invalid tz string degrades to UTC bucketing instead of throwing", () => {
    const rows = [session({ started_at: "2026-07-20T12:00:00.000Z", props: { usage: VALID_USAGE, models: ["s"] } })];
    expect(() =>
      aggregateAgentStats(rows, { tz: "Not/AZone", startDate: "2026-07-19", endDate: "2026-07-21" }),
    ).not.toThrow();
    const result = aggregateAgentStats(rows, { tz: "Not/AZone", startDate: "2026-07-19", endDate: "2026-07-21" });
    expect(result.daily.find((d) => d.date === "2026-07-20")?.sessions).toBe(1);
  });

  it("reconciliation: hero total equals the sum of per-day cost buckets", () => {
    const rows = [
      session({ id: "a", started_at: "2026-07-19T01:00:00.000Z", props: { usage: VALID_USAGE, models: ["s"] } }),
      session({ id: "b", started_at: "2026-07-20T01:00:00.000Z", props: { usage: VALID_USAGE, models: ["s"] } }),
      session({ id: "c", started_at: "2026-07-21T01:00:00.000Z", props: null }),
    ];
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" });
    const dailySum = result.daily.reduce((acc, d) => acc + d.cost_usd, 0);
    expect(Math.round(dailySum * 1e6)).toBe(Math.round((result.totals.cost_usd ?? 0) * 1e6));
  });

  it("returns no daily buckets for an empty/invalid date window", () => {
    const result = aggregateAgentStats([], { tz: "UTC", startDate: "2026-07-21", endDate: "2026-07-19" });
    expect(result.daily).toEqual([]);
    expect(result.totals.sessions).toBe(0);
    expect(result.totals.cost_usd).toBeNull();
  });
});

describe("aggregateAgentStats — sub-agent cost attribution (W11/D12)", () => {
  it("folds a sub-agent's own model+usage into by_model, distinct from the main transcript's tier", () => {
    const rows = [
      session({
        id: "a",
        props: {
          usage: VALID_USAGE,
          models: ["claude-fable-5"],
          subAgents: [{ model: "claude-sonnet-5", usage: VALID_USAGE, isFork: false }],
        },
      }),
    ];
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" });
    const tiers = result.by_model.map((m) => m.model_tier);
    expect(tiers).toEqual(["Fable", "Sonnet"]);
    // Both priced from the SAME VALID_USAGE, so equal cost per tier — proves
    // the sub-agent's usage was actually priced, not just counted.
    const fable = result.by_model.find((m) => m.model_tier === "Fable")!;
    const sonnet = result.by_model.find((m) => m.model_tier === "Sonnet")!;
    expect(sonnet.cost_usd).toBeGreaterThan(0);
    expect(fable.cost_usd).toBeGreaterThan(0);
    expect(fable.runs).toBe(1); // the one main-transcript session
    expect(sonnet.runs).toBe(1); // the one sub-agent run
  });

  it("adds sub-agent cost/tokens into totals.cost_usd and totals.tokens, not just by_model", () => {
    const mainOnly = aggregateAgentStats(
      [session({ id: "a", props: { usage: VALID_USAGE, models: ["claude-fable-5"] } })],
      { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" },
    );
    const withSub = aggregateAgentStats(
      [
        session({
          id: "a",
          props: {
            usage: VALID_USAGE,
            models: ["claude-fable-5"],
            subAgents: [{ model: "claude-sonnet-5", usage: VALID_USAGE, isFork: false }],
          },
        }),
      ],
      { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" },
    );
    expect(withSub.totals.cost_usd).toBeGreaterThan(mainOnly.totals.cost_usd ?? 0);
    expect(withSub.totals.tokens.input).toBe((mainOnly.totals.tokens.input ?? 0) * 2);
    expect(withSub.totals.subagent_cost_usd).toBeGreaterThan(0);
    expect(withSub.totals.subagent_runs).toBe(1);
    expect(mainOnly.totals.subagent_cost_usd).toBe(0);
    expect(mainOnly.totals.subagent_runs).toBe(0);
  });

  it("skips isFork:true sub-agent sidecars (ADR 0026 D3) — they inherit the parent's context, not a distinct run", () => {
    const rows = [
      session({
        id: "a",
        props: {
          usage: VALID_USAGE,
          models: ["claude-fable-5"],
          subAgents: [{ model: "claude-opus-5", usage: VALID_USAGE, isFork: true }],
        },
      }),
    ];
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" });
    expect(result.by_model.map((m) => m.model_tier)).toEqual(["Fable"]);
    expect(result.totals.subagent_runs).toBe(0);
  });

  it("skips a sub-agent entry with no priceable usage (e.g. no transcript on disk) rather than throwing", () => {
    const rows = [
      session({
        id: "a",
        props: {
          usage: VALID_USAGE,
          models: ["claude-fable-5"],
          subAgents: [{ model: "claude-sonnet-5", isFork: false }],
        },
      }),
    ];
    expect(() =>
      aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" }),
    ).not.toThrow();
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" });
    expect(result.by_model.map((m) => m.model_tier)).toEqual(["Fable"]);
    expect(result.totals.subagent_runs).toBe(0);
  });

  it("a session whose main transcript has no priceable usage but DOES have priced sub-agents still yields a non-null cost_usd", () => {
    const rows = [
      session({
        id: "a",
        props: { usage: null, subAgents: [{ model: "claude-sonnet-5", usage: VALID_USAGE, isFork: false }] },
      }),
    ];
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" });
    expect(result.totals.cost_usd).not.toBeNull();
    expect(result.totals.cost_usd).toBeGreaterThan(0);
    expect(result.totals.subagent_runs).toBe(1);
  });

  it("reconciliation still holds: hero total equals the sum of per-day cost buckets when sub-agent cost is included", () => {
    const rows = [
      session({
        id: "a",
        started_at: "2026-07-19T01:00:00.000Z",
        props: {
          usage: VALID_USAGE,
          models: ["claude-fable-5"],
          subAgents: [{ model: "claude-sonnet-5", usage: VALID_USAGE, isFork: false }],
        },
      }),
      session({
        id: "b",
        started_at: "2026-07-20T01:00:00.000Z",
        props: { usage: VALID_USAGE, models: ["claude-fable-5"] },
      }),
    ];
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" });
    const dailySum = result.daily.reduce((acc, d) => acc + d.cost_usd, 0);
    expect(Math.round(dailySum * 1e6)).toBe(Math.round((result.totals.cost_usd ?? 0) * 1e6));
  });

  it("#93 by_model carries a distinct-sessions count and a per-bucket token breakdown, main + sub-agent folded together", () => {
    const rows = [
      session({
        id: "a",
        props: {
          usage: VALID_USAGE,
          models: ["claude-fable-5"],
          subAgents: [
            { model: "claude-sonnet-5", usage: VALID_USAGE, isFork: false },
            { model: "claude-sonnet-5", usage: VALID_USAGE, isFork: false },
          ],
        },
      }),
      session({ id: "b", props: { usage: VALID_USAGE, models: ["claude-sonnet-5"] } }),
    ];
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" });

    const fable = result.by_model.find((m) => m.model_tier === "Fable")!;
    expect(fable.sessions).toBe(1);
    expect(fable.runs).toBe(1);
    expect(fable.token_buckets).toEqual({
      input: VALID_USAGE.inputTokens,
      output: VALID_USAGE.outputTokens,
      cache_read: VALID_USAGE.cacheReadInputTokens,
      cache_creation: VALID_USAGE.cacheCreationInputTokens,
    });

    const sonnet = result.by_model.find((m) => m.model_tier === "Sonnet")!;
    // 2 sub-agent runs on session "a" (both same tier — sessions counted once)
    // + session "b"'s own main-transcript run = 2 distinct sessions, 3 runs.
    expect(sonnet.sessions).toBe(2);
    expect(sonnet.runs).toBe(3);
    expect(sonnet.token_buckets.input).toBe(VALID_USAGE.inputTokens * 3);
    expect(sonnet.token_buckets.output).toBe(VALID_USAGE.outputTokens * 3);
    expect(sonnet.token_buckets.cache_read).toBe(VALID_USAGE.cacheReadInputTokens * 3);
    expect(sonnet.token_buckets.cache_creation).toBe(VALID_USAGE.cacheCreationInputTokens * 3);
    // Sum of the four buckets must equal the flat `tokens` total already tested elsewhere.
    const bucketSum =
      sonnet.token_buckets.input +
      sonnet.token_buckets.output +
      sonnet.token_buckets.cache_read +
      sonnet.token_buckets.cache_creation;
    expect(bucketSum).toBe(sonnet.tokens);
  });

  it("an unparseable subAgents blob (not an array) degrades to zero sub-agent contribution, never throws", () => {
    const rows = [
      session({ id: "a", props: { usage: VALID_USAGE, models: ["claude-fable-5"], subAgents: "not-an-array" } }),
    ];
    expect(() =>
      aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" }),
    ).not.toThrow();
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-19", endDate: "2026-07-21" });
    expect(result.totals.subagent_runs).toBe(0);
  });
});

describe("aggregateAgentStats monthly breakdown", () => {
  it("groups sessions into calendar-month buckets, summing cost/sessions/tokens per month", () => {
    const rows = [
      session({ id: "a", started_at: "2026-07-05T01:00:00.000Z", props: { usage: VALID_USAGE, models: ["s"] } }),
      session({ id: "b", started_at: "2026-07-20T01:00:00.000Z", props: { usage: VALID_USAGE, models: ["s"] } }),
      session({ id: "c", started_at: "2026-06-10T01:00:00.000Z", props: { usage: VALID_USAGE, models: ["s"] } }),
    ];
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-06-01", endDate: "2026-07-31" });
    expect(result.monthly.map((m) => m.month)).toEqual(["2026-06", "2026-07"]);
    const july = result.monthly.find((m) => m.month === "2026-07");
    expect(july?.sessions).toBe(2);
    expect(july?.cost_usd).toBeGreaterThan(0);
    expect(july?.tokens).toBeGreaterThan(0);
    // Reconciles with the two-session sum, same shape as the daily reconciliation test above.
    const june = result.monthly.find((m) => m.month === "2026-06");
    expect(june?.sessions).toBe(1);
    expect(Math.round((july!.cost_usd + june!.cost_usd) * 1e6)).toBe(Math.round((result.totals.cost_usd ?? 0) * 1e6));
  });

  it("empty months are omitted entirely, never emitted as a zero row (unlike the zero-filled daily series)", () => {
    const rows = [
      session({ id: "a", started_at: "2026-05-05T01:00:00.000Z", props: { usage: VALID_USAGE, models: ["s"] } }),
      session({ id: "b", started_at: "2026-07-05T01:00:00.000Z", props: { usage: VALID_USAGE, models: ["s"] } }),
    ];
    // June has zero sessions in between May and July.
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-05-01", endDate: "2026-07-31" });
    expect(result.monthly.map((m) => m.month)).toEqual(["2026-05", "2026-07"]);
    expect(result.monthly.find((m) => m.month === "2026-06")).toBeUndefined();
  });

  it("a session with no priceable usage still counts toward its month's `sessions`, with cost_usd 0 for that month", () => {
    const rows = [session({ id: "unpriced", started_at: "2026-07-05T01:00:00.000Z", props: null })];
    const result = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-01", endDate: "2026-07-31" });
    expect(result.monthly).toEqual([{ month: "2026-07", cost_usd: 0, sessions: 1, tokens: 0 }]);
  });

  it("tz boundary: a session just after UTC midnight on the 1st can land in the PREVIOUS month in a negative-offset tz", () => {
    // 2026-08-01T02:00:00Z is 2026-07-31T19:00 in America/Los_Angeles (UTC-7 in August, DST).
    const rows = [
      session({ id: "edge", started_at: "2026-08-01T02:00:00.000Z", props: { usage: VALID_USAGE, models: ["s"] } }),
    ];
    const utcResult = aggregateAgentStats(rows, { tz: "UTC", startDate: "2026-07-01", endDate: "2026-08-31" });
    const laResult = aggregateAgentStats(rows, {
      tz: "America/Los_Angeles",
      startDate: "2026-07-01",
      endDate: "2026-08-31",
    });
    expect(utcResult.monthly.map((m) => m.month)).toEqual(["2026-08"]);
    expect(laResult.monthly.map((m) => m.month)).toEqual(["2026-07"]);
  });

  it("range interaction: monthly reflects only the rows passed in, so narrowing the caller's range narrows the months", () => {
    const allRows = [
      session({ id: "a", started_at: "2026-05-01T01:00:00.000Z", props: { usage: VALID_USAGE, models: ["s"] } }),
      session({ id: "b", started_at: "2026-06-01T01:00:00.000Z", props: { usage: VALID_USAGE, models: ["s"] } }),
      session({ id: "c", started_at: "2026-07-01T01:00:00.000Z", props: { usage: VALID_USAGE, models: ["s"] } }),
    ];
    // "all" range: the route passes every row.
    const allResult = aggregateAgentStats(allRows, { tz: "UTC", startDate: "2026-05-01", endDate: "2026-07-31" });
    expect(allResult.monthly.map((m) => m.month)).toEqual(["2026-05", "2026-06", "2026-07"]);

    // A bounded range (e.g. 30d): the route pre-filters rows before calling
    // aggregateAgentStats (see route.ts's currentRows), so a narrower window
    // yields fewer months without any change to this function.
    const narrowRows = allRows.filter((r) => r.started_at! >= "2026-06-01");
    const narrowResult = aggregateAgentStats(narrowRows, { tz: "UTC", startDate: "2026-06-01", endDate: "2026-07-31" });
    expect(narrowResult.monthly.map((m) => m.month)).toEqual(["2026-06", "2026-07"]);
  });

  it("returns no monthly buckets for an empty input", () => {
    const result = aggregateAgentStats([], { tz: "UTC", startDate: "2026-07-01", endDate: "2026-07-31" });
    expect(result.monthly).toEqual([]);
  });
});

describe("tierLabelForModel", () => {
  it("matches opus/sonnet/haiku by substring, case-insensitively, and falls back to Other", () => {
    expect(tierLabelForModel("claude-opus-4")).toBe("Opus");
    expect(tierLabelForModel("CLAUDE-SONNET-5")).toBe("Sonnet");
    expect(tierLabelForModel("claude-haiku-4")).toBe("Haiku");
    expect(tierLabelForModel("codehub-model-1")).toBe("Other");
    expect(tierLabelForModel(undefined)).toBe("Other");
  });

  it("matches fable as its own first-class tier, not Other (membral-k89)", () => {
    expect(tierLabelForModel("claude-fable-5")).toBe("Fable");
  });

  it("matches fable case-insensitively and by substring in a longer model string", () => {
    expect(tierLabelForModel("CLAUDE-FABLE-5")).toBe("Fable");
    expect(tierLabelForModel("anthropic/Fable-preview")).toBe("Fable");
  });

  it("still falls back to Other for unrecognized models, unrelated to the new fable bucket", () => {
    expect(tierLabelForModel("gpt-4o-mini")).toBe("Other");
    expect(tierLabelForModel("")).toBe("Other");
  });
});

describe("computeCumulative", () => {
  it("is monotonic non-decreasing and matches the running sum", () => {
    const daily = [
      { date: "2026-07-19", cost_usd: 1, sessions: 1 },
      { date: "2026-07-20", cost_usd: 0, sessions: 0 },
      { date: "2026-07-21", cost_usd: 2.5, sessions: 3 },
    ];
    const cumulative = computeCumulative(daily);
    expect(cumulative.map((d) => d.cumulative_cost_usd)).toEqual([1, 1, 3.5]);
    for (let i = 1; i < cumulative.length; i++) {
      expect(cumulative[i].cumulative_cost_usd).toBeGreaterThanOrEqual(cumulative[i - 1].cumulative_cost_usd);
    }
  });

  it("empty input yields empty output", () => {
    expect(computeCumulative([])).toEqual([]);
  });
});
