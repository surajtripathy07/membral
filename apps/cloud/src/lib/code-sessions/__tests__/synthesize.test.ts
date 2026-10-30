import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callOrder: string[] = [];

vi.mock("../summarize", () => ({
  summarizeCodeSessions: vi.fn(async () => {
    callOrder.push("summarize");
    return { processed: 2, llmCalls: 1, heuristicCount: 1, costUsd: 0.01, capped: false };
  }),
}));

vi.mock("../rollup", () => ({
  rollupCodeProjects: vi.fn(async () => {
    callOrder.push("rollup");
    return { processed: 1, llmCalls: 1, costUsd: 0.02, capped: false, rolledUpIds: ["p1"] };
  }),
}));

vi.mock("../cross-links", () => ({
  matchCodeProjectCrossLinks: vi.fn(async () => {
    callOrder.push("cross-links");
    return { evaluated: 1, created: 1, matches: [] };
  }),
}));

vi.mock("../code-graph", () => ({
  buildCodeGraphForUser: vi.fn(async () => {
    callOrder.push("code-graph");
    return [{ codeProjectId: "p1", nodesWritten: 3, edgesWritten: 2, nodeCountsByType: {}, edgeCountsByType: {} }];
  }),
}));

// Issue #126 (ADR 0047); issue #128 (ADR 0047 v2): synthesizeCodeDimensionForUser's
// own client factory (createCodeSessionClients) mints a fresh service-role
// client and gates on checkFeature — mocked here so the disabled-path test
// below never touches a real Supabase client or the monthly-ceiling RPC.
const mockCheckFeature = vi.fn<(...args: unknown[]) => Promise<import("@/lib/feature-flags").CheckFeatureResult>>(() =>
  Promise.resolve({
    allowed: true,
    reason: "ok" as const,
    spentUsd: 0,
    budgetUsd: null,
    dailyUsd: null,
    contact: "support@membral.me",
  }),
);
vi.mock("@/lib/feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/feature-flags")>()),
  checkFeature: (...args: unknown[]) => mockCheckFeature(...args),
}));

const mockRpc = vi.fn(() => Promise.resolve({ data: "0", error: null }));
vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    rpc: mockRpc,
    from: vi.fn(() => ({ insert: vi.fn(async () => ({ data: null, error: null })) })),
  })),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { log } from "@/lib/log";
import { buildCodeGraphForUser } from "../code-graph";
import { matchCodeProjectCrossLinks } from "../cross-links";
import { rollupCodeProjects } from "../rollup";
import { summarizeCodeSessions } from "../summarize";
import { synthesizeCodeDimension, synthesizeCodeDimensionForUser } from "../synthesize";

describe("synthesizeCodeDimension", () => {
  beforeEach(() => {
    callOrder.length = 0;
    vi.clearAllMocks();
  });

  it("ORCHESTRATOR ORDERING: runs summarize -> rollup -> cross-links -> code-graph, in that order", async () => {
    const deps = { supabase: {} as never, llm: {} as never, userId: "user-1" };
    const result = await synthesizeCodeDimension(deps);

    expect(callOrder).toEqual(["summarize", "rollup", "cross-links", "code-graph"]);
    expect(summarizeCodeSessions).toHaveBeenCalledWith(deps);
    expect(rollupCodeProjects).toHaveBeenCalledWith(deps);
    // Content matching is limited to the projects whose rollup was rewritten this run.
    expect(matchCodeProjectCrossLinks).toHaveBeenCalledWith({ ...deps, projectIds: ["p1"] });
    expect(buildCodeGraphForUser).toHaveBeenCalledWith(deps.supabase, deps.userId);

    expect(result.summarize.processed).toBe(2);
    expect(result.rollup.processed).toBe(1);
    expect(result.crossLinks.created).toBe(1);
    expect(result.codeGraph).toHaveLength(1);
    expect(result.costUsd).toBeCloseTo(0.03);
  });

  it("rolls up, cross-links, and builds the code graph even when summarize finds nothing to do", async () => {
    vi.mocked(summarizeCodeSessions).mockImplementationOnce(async () => {
      callOrder.push("summarize");
      return { processed: 0, llmCalls: 0, heuristicCount: 0, costUsd: 0, capped: false };
    });
    const deps = { supabase: {} as never, llm: {} as never, userId: "user-1" };
    await synthesizeCodeDimension(deps);

    expect(callOrder).toEqual(["summarize", "rollup", "cross-links", "code-graph"]);
  });
});

describe("synthesizeCodeDimensionForUser — issue #126 (ADR 0047) llm feature flag", () => {
  beforeEach(() => {
    callOrder.length = 0;
    vi.clearAllMocks();
    mockCheckFeature.mockResolvedValue({
      allowed: true,
      reason: "ok" as const,
      spentUsd: 0,
      budgetUsd: null,
      dailyUsd: null,
      contact: "support@membral.me",
    });
    mockRpc.mockResolvedValue({ data: "0", error: null });
  });

  it("refuses with reason 'feature_disabled' and never runs any synthesis step (no provider call) when the flag is disabled", async () => {
    mockCheckFeature.mockResolvedValue({
      allowed: false,
      reason: "disabled" as const,
      spentUsd: 0,
      budgetUsd: null,
      dailyUsd: null,
      contact: "support@membral.me",
    });

    const result = await synthesizeCodeDimensionForUser("user-1");

    expect(result).toEqual({
      refused: true,
      reason: "feature_disabled",
      detail: "disabled",
      contact: "support@membral.me",
    });
    expect(summarizeCodeSessions).not.toHaveBeenCalled();
    expect(rollupCodeProjects).not.toHaveBeenCalled();
    expect(matchCodeProjectCrossLinks).not.toHaveBeenCalled();
    expect(mockRpc).not.toHaveBeenCalled(); // the ceiling RPC is never even reached
  });

  it("issue #335: refuses with 'global_ceiling_exceeded' when the all-users daily ceiling is reached — no synthesis step runs", async () => {
    mockRpc.mockImplementation(((fn: string) =>
      Promise.resolve(
        fn === "llm_spend_global_sum" ? { data: "2", error: null } : { data: "0", error: null },
      )) as never);

    const errorSpy = vi.spyOn(log, "error");

    const result = await synthesizeCodeDimensionForUser("user-1");

    expect(result).toEqual({ refused: true, reason: "global_ceiling_exceeded", detail: "global_daily_ceiling" });
    expect(summarizeCodeSessions).not.toHaveBeenCalled();
    // The fire-and-forget route ignores the result: this error line is the only trace.
    expect(errorSpy).toHaveBeenCalledWith(
      "code dimension synthesis refused: global LLM spend ceiling",
      expect.objectContaining({ user_id: "user-1", detail: "global_daily_ceiling" }),
    );
    errorSpy.mockRestore();
  });

  it("issue #335 review: the run cap is clamped to the global headroom left", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    // $1.99 of the $2 daily default spent: $0.01 left, below the $5 per-run cap.
    mockRpc.mockImplementation(((fn: string) =>
      Promise.resolve(
        fn === "llm_spend_global_sum" ? { data: "1.99", error: null } : { data: "0", error: null },
      )) as never);

    await synthesizeCodeDimensionForUser("user-1");

    const deps = vi.mocked(summarizeCodeSessions).mock.calls[0]?.[0] as unknown as {
      llm: { remainingUsd(): number };
    };
    expect(deps.llm.remainingUsd()).toBeCloseTo(0.01, 9);
    vi.unstubAllEnvs();
  });

  it("issue #335: an unreadable global sum fails closed", async () => {
    mockRpc.mockImplementation(((fn: string) =>
      Promise.resolve(
        fn === "llm_spend_global_sum" ? { data: null, error: { message: "boom" } } : { data: "0", error: null },
      )) as never);

    const result = await synthesizeCodeDimensionForUser("user-1");

    expect(result).toEqual({ refused: true, reason: "global_ceiling_exceeded", detail: "global_ceiling_unchecked" });
    expect(summarizeCodeSessions).not.toHaveBeenCalled();
  });
});

describe("synthesizeCodeDimensionForUser — single-flight per user", () => {
  const defaultSummarize = vi.mocked(summarizeCodeSessions).getMockImplementation();
  beforeEach(() => {
    callOrder.length = 0;
    vi.clearAllMocks();
    if (defaultSummarize) vi.mocked(summarizeCodeSessions).mockImplementation(defaultSummarize);
    mockCheckFeature.mockResolvedValue({
      allowed: true,
      reason: "ok" as const,
      spentUsd: 0,
      budgetUsd: null,
      dailyUsd: null,
      contact: "support@membral.me",
    });
    mockRpc.mockResolvedValue({ data: "0", error: null });
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("a trigger that arrives while a run is in flight does not start a second concurrent run; it coalesces into ONE follow-up pass", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let active = 0;
    let maxActive = 0;
    vi.mocked(summarizeCodeSessions).mockImplementation((async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
      return { processed: 0, llmCalls: 0, heuristicCount: 0, costUsd: 0, capped: false };
    }) as never);

    const first = synthesizeCodeDimensionForUser("user-sf");
    await vi.waitFor(() => expect(summarizeCodeSessions).toHaveBeenCalledTimes(1));

    // Three more triggers while the first is blocked: all dropped into the same single follow-up.
    const dropped = await Promise.all([
      synthesizeCodeDimensionForUser("user-sf"),
      synthesizeCodeDimensionForUser("user-sf"),
      synthesizeCodeDimensionForUser("user-sf"),
    ]);
    expect(dropped).toEqual(Array(3).fill({ refused: true, reason: "already_running" }));
    expect(summarizeCodeSessions).toHaveBeenCalledTimes(1);

    release();
    const result = await first;
    expect("refused" in result).toBe(false);
    expect(summarizeCodeSessions).toHaveBeenCalledTimes(2); // original run + exactly one follow-up
    expect(maxActive).toBe(1); // never two runs at once

    // The guard is released afterwards: a later trigger runs normally.
    await synthesizeCodeDimensionForUser("user-sf");
    expect(summarizeCodeSessions).toHaveBeenCalledTimes(3);
  });

  it("a run for a different user is not blocked by one in flight", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(summarizeCodeSessions).mockImplementationOnce((async () => {
      await gate;
      return { processed: 0, llmCalls: 0, heuristicCount: 0, costUsd: 0, capped: false };
    }) as never);
    const slow = synthesizeCodeDimensionForUser("user-a");
    await vi.waitFor(() => expect(summarizeCodeSessions).toHaveBeenCalledTimes(1));

    const other = await synthesizeCodeDimensionForUser("user-b");
    expect("refused" in other).toBe(false);
    release();
    await slow;
  });
});
