import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Issue #126 (ADR 0047); issue #128 (ADR 0047 v2) — createCostGuardedLlm
// gates on checkFeature BEFORE the monthly-ceiling preflight below —
// default enabled/unlimited so every pre-existing test in this file
// (predating the flag) keeps exercising the ceiling/ledger path unchanged;
// the dedicated describe block further down overrides this to prove the
// disabled path short-circuits before any ceiling RPC.
const mockCheckFeature = vi.fn<(...args: unknown[]) => Promise<import("../../feature-flags").CheckFeatureResult>>(() =>
  Promise.resolve({
    allowed: true,
    reason: "ok" as const,
    spentUsd: 0,
    budgetUsd: null,
    dailyUsd: null,
    contact: "support@membral.me",
  }),
);
vi.mock("../../feature-flags", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../feature-flags")>()),
  checkFeature: (...args: unknown[]) => mockCheckFeature(...args),
}));

import { LlmClient } from "../client";
import type { CostRecord } from "../passes";
import {
  _resetProductionCeilingWarningForTest,
  checkMonthlyCeiling,
  createCostGuardedLlm,
  createSpendLedger,
  llmSpendSum,
} from "../spend-ledger";

function makeRecord(overrides: Partial<CostRecord> = {}): CostRecord {
  return {
    conversation_id: "c1",
    pass: "pass1",
    model: "gpt-4o-mini",
    tokens_in: 100,
    tokens_out: 20,
    cost_usd: 0.01,
    latency_ms: 10,
    ...overrides,
  };
}

interface InsertChain {
  insert: (rows: unknown) => Promise<{ data: unknown; error: unknown }>;
}

/**
 * Fake that mocks the llm_spend_sum RPC directly — NOT a `.select()`
 * row-fetch mock. Adversarial review N11: a row-fetch mock would hide
 * exactly the bug B1 caught (PostgREST's 1000-row default cap silently
 * truncating a client-side sum) — the whole point of moving the sum
 * server-side is that no JS code ever sees the individual rows, so the test
 * harness must reflect that shape too.
 */
function makeSupabase(opts: {
  rpcResult?:
    | { data: unknown; error: unknown }
    | ((args: Record<string, unknown>) => { data: unknown; error: unknown });
  onInsert?: (rows: unknown[]) => { error: unknown } | undefined;
}): { supabase: SupabaseClient; inserts: unknown[][]; rpcCalls: Array<{ fn: string; args: unknown }> } {
  const inserts: unknown[][] = [];
  const rpcCalls: Array<{ fn: string; args: unknown }> = [];
  const chain: InsertChain = {
    insert: async (rows: unknown) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      inserts.push(arr);
      const res = opts.onInsert?.(arr);
      return { data: null, error: res?.error ?? null };
    },
  };
  const supabase = {
    from: vi.fn(() => chain),
    rpc: vi.fn((fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      const result =
        typeof opts.rpcResult === "function" ? opts.rpcResult(args) : (opts.rpcResult ?? { data: 0, error: null });
      return Promise.resolve(result);
    }),
  } as unknown as SupabaseClient;
  return { supabase, inserts, rpcCalls };
}

describe("createSpendLedger", () => {
  it("buffers rows and flushes them once flushEvery is reached", async () => {
    const { supabase, inserts } = makeSupabase({});
    const ledger = createSpendLedger(supabase, "u1", { flushEvery: 3 });

    ledger.onSpend(makeRecord({ cost_usd: 0.01 }));
    ledger.onSpend(makeRecord({ cost_usd: 0.02 }));
    expect(inserts).toHaveLength(0); // not yet flushed

    ledger.onSpend(makeRecord({ cost_usd: 0.03 }));
    // The auto-flush fires fire-and-forget (void flush()) — let microtasks settle.
    await Promise.resolve();
    await Promise.resolve();

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toHaveLength(3);
    expect(inserts[0][0]).toMatchObject({
      user_id: "u1",
      pass: "pass1",
      model: "gpt-4o-mini",
      cost_usd: 0.01,
      run_id: null,
    });
  });

  it("tags every buffered row with the given runId (issue #21 M5)", async () => {
    const { supabase, inserts } = makeSupabase({});
    const ledger = createSpendLedger(supabase, "u1", { runId: "run-abc" });
    ledger.onSpend(makeRecord());
    await ledger.flush();
    expect(inserts[0][0]).toMatchObject({ run_id: "run-abc" });
  });

  it("flush() at run end flushes whatever is left in the buffer", async () => {
    const { supabase, inserts } = makeSupabase({});
    const ledger = createSpendLedger(supabase, "u1", { flushEvery: 20 });

    ledger.onSpend(makeRecord({ cost_usd: 0.05 }));
    expect(inserts).toHaveLength(0);

    await ledger.flush();
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toHaveLength(1);
  });

  it("flush() is a no-op when the buffer is empty", async () => {
    const { supabase, inserts } = makeSupabase({});
    const ledger = createSpendLedger(supabase, "u1");
    await ledger.flush();
    expect(inserts).toHaveLength(0);
  });

  it("an insert failure is logged and swallowed — never throws, never crashes the run", async () => {
    const { supabase } = makeSupabase({ onInsert: () => ({ error: { message: "db down" } }) });
    const ledger = createSpendLedger(supabase, "u1");
    ledger.onSpend(makeRecord());
    await expect(ledger.flush()).resolves.toBeUndefined();
  });

  it("a thrown insert (not just an error field) is also swallowed", async () => {
    const supabase = {
      from: vi.fn(() => ({
        insert: () => {
          throw new Error("network exploded");
        },
      })),
    } as unknown as SupabaseClient;
    const ledger = createSpendLedger(supabase, "u1");
    ledger.onSpend(makeRecord());
    await expect(ledger.flush()).resolves.toBeUndefined();
  });
});

describe("llmSpendSum (issue #21 B1 — server-side sum via RPC)", () => {
  it("calls the llm_spend_sum RPC with p_user_id/p_since and p_run_id null in the since-window mode", async () => {
    const { supabase, rpcCalls } = makeSupabase({ rpcResult: { data: "1.5", error: null } });
    const since = "2026-06-25T00:00:00.000Z";
    const sum = await llmSpendSum(supabase, "u1", { sinceIso: since });
    expect(sum).toBeCloseTo(1.5, 8);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].fn).toBe("llm_spend_sum");
    expect(rpcCalls[0].args).toMatchObject({ p_user_id: "u1", p_since: since, p_run_id: null });
  });

  it("calls the RPC with p_run_id set in the run-scoped mode", async () => {
    const { supabase, rpcCalls } = makeSupabase({ rpcResult: { data: "0.42", error: null } });
    const sum = await llmSpendSum(supabase, "u1", { runId: "run-1" });
    expect(sum).toBeCloseTo(0.42, 8);
    expect(rpcCalls[0].args).toMatchObject({ p_user_id: "u1", p_run_id: "run-1" });
  });

  it("B1 regression: a sum representing MORE than 1000 rows comes back whole — proves no client-side row cap applies, since no rows are ever fetched", async () => {
    // 1200 rows of $0.001 = $1.20 — the exact shape adversarial review B1
    // found broken by a client-side `.select()` + reduce (PostgREST's
    // default 1000-row cap made that sum $1.00). The RPC returns the true
    // server-computed total directly; there is no row array for a cap to
    // truncate.
    const { supabase } = makeSupabase({ rpcResult: { data: "1.2", error: null } });
    const sum = await llmSpendSum(supabase, "u1", { sinceIso: "2026-01-01T00:00:00.000Z" });
    expect(sum).toBeCloseTo(1.2, 8);
  });

  it("returns 0 and logs on an RPC error — never throws", async () => {
    const { supabase } = makeSupabase({ rpcResult: { data: null, error: { message: "function not found" } } });
    const sum = await llmSpendSum(supabase, "u1", { sinceIso: "2026-01-01T00:00:00.000Z" });
    expect(sum).toBe(0);
  });
});

describe("checkMonthlyCeiling", () => {
  it("allows unconditionally, without calling the RPC, when the ceiling is unset", async () => {
    const { supabase, rpcCalls } = makeSupabase({});
    const result = await checkMonthlyCeiling(supabase, "u1", {});
    expect(result).toEqual({ allowed: true, spentUsd: 0, ceilingUsd: null });
    expect(rpcCalls).toHaveLength(0);
  });

  it("allows when spend is under the ceiling", async () => {
    const { supabase } = makeSupabase({ rpcResult: { data: "0.9", error: null } });
    const result = await checkMonthlyCeiling(supabase, "u1", { MEMBRAL_KG_MONTHLY_CEILING_USD: "2" });
    expect(result.allowed).toBe(true);
    expect(result.spentUsd).toBeCloseTo(0.9, 8);
    expect(result.ceilingUsd).toBe(2);
  });

  it("refuses when trailing spend meets or exceeds the ceiling", async () => {
    const { supabase } = makeSupabase({ rpcResult: { data: "2.0", error: null } });
    const result = await checkMonthlyCeiling(supabase, "u1", { MEMBRAL_KG_MONTHLY_CEILING_USD: "2" });
    expect(result.allowed).toBe(false);
    expect(result.spentUsd).toBeCloseTo(2.0, 8);
  });

  it("a configured ceiling of 0 blocks every run (driver decision: 0 is valid and enforcing)", async () => {
    const { supabase } = makeSupabase({ rpcResult: { data: "0", error: null } });
    const result = await checkMonthlyCeiling(supabase, "u1", { MEMBRAL_KG_MONTHLY_CEILING_USD: "0" });
    expect(result.ceilingUsd).toBe(0);
    expect(result.allowed).toBe(false); // spentUsd (0) >= ceiling (0)
  });

  it("fails open (allows) on an RPC error", async () => {
    const { supabase } = makeSupabase({ rpcResult: { data: null, error: { message: "boom" } } });
    const result = await checkMonthlyCeiling(supabase, "u1", { MEMBRAL_KG_MONTHLY_CEILING_USD: "2" });
    expect(result.allowed).toBe(true);
    expect(result.ceilingUsd).toBe(2);
  });

  it("passes a ~30-day-ago timestamp as p_since", async () => {
    const { supabase, rpcCalls } = makeSupabase({ rpcResult: { data: "0", error: null } });
    const before = Date.now();
    await checkMonthlyCeiling(supabase, "u1", { MEMBRAL_KG_MONTHLY_CEILING_USD: "2" });
    const args = rpcCalls[0].args as { p_since: string };
    const sinceMs = new Date(args.p_since).getTime();
    const expectedMs = before - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(sinceMs - expectedMs)).toBeLessThan(5000); // within 5s of "now - 30d"
  });

  describe("issue #126 verification finding — production default when unset", () => {
    beforeEach(() => {
      _resetProductionCeilingWarningForTest();
    });

    it("still does NOT enforce (unset -> null) outside production, even with NODE_ENV unset entirely", async () => {
      const { supabase, rpcCalls } = makeSupabase({});
      const result = await checkMonthlyCeiling(supabase, "u1", {});
      expect(result).toEqual({ allowed: true, spentUsd: 0, ceilingUsd: null });
      expect(rpcCalls).toHaveLength(0);
    });

    it("applies a $25 default ceiling in production when the var is unset", async () => {
      const { supabase } = makeSupabase({ rpcResult: { data: "10", error: null } });
      const result = await checkMonthlyCeiling(supabase, "u1", { NODE_ENV: "production" });
      expect(result.ceilingUsd).toBe(25);
      expect(result.spentUsd).toBeCloseTo(10, 8);
      expect(result.allowed).toBe(true);
    });

    it("the production default is enforcing — blocks a run once trailing spend meets it", async () => {
      const { supabase } = makeSupabase({ rpcResult: { data: "25", error: null } });
      const result = await checkMonthlyCeiling(supabase, "u1", { NODE_ENV: "production" });
      expect(result.allowed).toBe(false);
      expect(result.ceilingUsd).toBe(25);
    });

    it("an explicit MEMBRAL_KG_MONTHLY_CEILING_USD in production overrides the $25 default, not the other way round", async () => {
      const { supabase } = makeSupabase({ rpcResult: { data: "10", error: null } });
      const result = await checkMonthlyCeiling(supabase, "u1", {
        NODE_ENV: "production",
        MEMBRAL_KG_MONTHLY_CEILING_USD: "100",
      });
      expect(result.ceilingUsd).toBe(100);
    });

    it("logs the fallback at most once across repeated calls", async () => {
      const { log } = await import("../../log");
      const warnSpy = vi.spyOn(log, "warn").mockImplementation(() => undefined);
      const { supabase } = makeSupabase({ rpcResult: { data: "0", error: null } });

      await checkMonthlyCeiling(supabase, "u1", { NODE_ENV: "production" });
      await checkMonthlyCeiling(supabase, "u2", { NODE_ENV: "production" });

      const fallbackWarnings = warnSpy.mock.calls.filter(([msg]) =>
        typeof msg === "string" ? msg.includes("applying a conservative built-in default ceiling") : false,
      );
      expect(fallbackWarnings).toHaveLength(1);
      warnSpy.mockRestore();
    });
  });
});

describe("createCostGuardedLlm", () => {
  // resolveModelConfig() (types.ts) requires a real-looking API key or base
  // URL in env — stub one so these tests exercise the real construction path
  // rather than mocking it away, and restore afterward so it can't leak into
  // other test files' env-parsing assertions.
  beforeEach(() => {
    mockCheckFeature.mockReset();
    mockCheckFeature.mockResolvedValue({
      allowed: true,
      reason: "ok" as const,
      spentUsd: 0,
      budgetUsd: null,
      dailyUsd: null,
      contact: "support@membral.me",
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses cleanly when the ceiling is exceeded — no LlmClient is built", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const { supabase } = makeSupabase({ rpcResult: { data: "5", error: null } });
    vi.stubEnv("MEMBRAL_KG_MONTHLY_CEILING_USD", "2");
    const result = await createCostGuardedLlm(supabase, "u1", {});
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== "monthly_ceiling_exceeded") throw new Error("unexpected result");
    expect(result.reason).toBe("monthly_ceiling_exceeded");
    expect(result.spentUsd).toBeCloseTo(5, 8);
    expect(result.ceilingUsd).toBe(2);
  });

  it("builds an LlmClient with the resolved per-run cap and a working onSpend sink", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const { supabase, inserts } = makeSupabase({});
    const result = await createCostGuardedLlm(supabase, "u1", { runId: "run-9" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.llm).toBeInstanceOf(LlmClient);
    expect(result.llm.overBudget()).toBe(false);
    // Directly exercise the wired-up onSpend by faking a completion through record()'s
    // only public surface: embed() with empty text still routes through record().
    await result.llm.embed({ text: "", pass: "embed", conversationId: "c" });
    await result.flushSpend();
    expect(inserts[0]?.[0]).toMatchObject({ user_id: "u1", run_id: "run-9" });
  });

  it("P10 re-review N2: flushEvery 1 writes each spend row as it lands, with no explicit flush", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    const { supabase, inserts } = makeSupabase({});
    const result = await createCostGuardedLlm(supabase, "u1", {
      runId: "run-1",
      flushEvery: 1,
      timeoutMs: 60_000,
      maxRetries: 1,
    });
    if (!result.ok) throw new Error("expected ok");
    await result.llm.embed({ text: "", pass: "embed", conversationId: "c" });
    await new Promise((r) => setTimeout(r, 0));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.[0]).toMatchObject({ user_id: "u1", run_id: "run-1" });
  });

  describe("issue #335 — global (all users) daily + monthly ceilings", () => {
    // Per-user sum is 0; the global sum answers per window via p_since.
    // Clock pinned mid-month so the day and month windows never coincide.
    const NOW_MONTH_START = "2026-09-01T00:00:00.000Z";
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-25T12:00:00.000Z"));
    });
    afterEach(() => {
      vi.useRealTimers();
    });
    const globalSums = (daily: unknown, monthly: unknown) =>
      makeSupabase({
        rpcResult: (args) =>
          "p_user_id" in args
            ? { data: 0, error: null }
            : { data: args.p_since === NOW_MONTH_START ? monthly : daily, error: null },
      });

    it("allowed under both ceilings: builds the client and reads both windows", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      const { supabase, rpcCalls } = globalSums(0.5, 10);
      const result = await createCostGuardedLlm(supabase, "u1", { bypassFeatureGate: true });
      expect(result.ok).toBe(true);
      expect(rpcCalls.filter((c) => c.fn === "llm_spend_global_sum")).toHaveLength(2);
    });

    it("refuses at the global DAILY ceiling, even with the per-user gate bypassed", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      vi.stubEnv("MEMBRAL_LLM_GLOBAL_DAILY_CEILING_USD", "2");
      const { supabase } = globalSums(2, 2);
      const result = await createCostGuardedLlm(supabase, "u1", { bypassFeatureGate: true });
      expect(result).toEqual({
        ok: false,
        reason: "global_ceiling_exceeded",
        detail: "global_daily_ceiling",
        spentUsd: 2,
        ceilingUsd: 2,
      });
    });

    it("refuses at the global MONTHLY ceiling when the day is under", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      vi.stubEnv("MEMBRAL_LLM_GLOBAL_MONTHLY_CEILING_USD", "30");
      const { supabase } = globalSums(0.1, 30);
      const result = await createCostGuardedLlm(supabase, "u1", {});
      expect(result).toEqual({
        ok: false,
        reason: "global_ceiling_exceeded",
        detail: "global_monthly_ceiling",
        spentUsd: 30,
        ceilingUsd: 30,
      });
    });

    it("review: the run cap is clamped to the tighter window's headroom (seed carried in)", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      // Daily: $1.99 of $2 -> $0.01 left; monthly: $10 of $30 -> $20 left.
      const { supabase } = globalSums(1.99, 10);
      const plain = await createCostGuardedLlm(supabase, "u1", {});
      if (!plain.ok) throw new Error("expected ok");
      expect(plain.llm.remainingUsd()).toBeCloseTo(0.01, 9); // not the $5 per-run default
      const seeded = await createCostGuardedLlm(supabase, "u1", { seedCostUsd: 0.5, capUsdOverride: 3 });
      if (!seeded.ok) throw new Error("expected ok");
      expect(seeded.llm.remainingUsd()).toBeCloseTo(0.01, 9);
      // A smaller explicit cap still wins.
      const small = await createCostGuardedLlm(supabase, "u1", { capUsdOverride: 0.004 });
      if (!small.ok) throw new Error("expected ok");
      expect(small.llm.remainingUsd()).toBeCloseTo(0.004, 9);
    });

    it("review: a null global sum is unreadable, not $0 — fails closed", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      const { supabase } = globalSums(null, null);
      const result = await createCostGuardedLlm(supabase, "u1", {});
      expect(result.ok).toBe(false);
      if (result.ok || result.reason !== "global_ceiling_exceeded") throw new Error("unexpected result");
      expect(result.detail).toBe("global_ceiling_unchecked");
    });

    it("review: an empty-string global sum is unreadable, not $0 — fails closed", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      const { supabase } = globalSums("", "");
      const result = await createCostGuardedLlm(supabase, "u1", {});
      expect(result.ok).toBe(false);
      if (result.ok || result.reason !== "global_ceiling_exceeded") throw new Error("unexpected result");
      expect(result.detail).toBe("global_ceiling_unchecked");
    });

    it("review: reports which global window set the cap, and none when the run cap is tighter", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      const { supabase } = globalSums(1.99, 10);
      const clamped = await createCostGuardedLlm(supabase, "u1", {});
      if (!clamped.ok) throw new Error("expected ok");
      expect(clamped.globalCapWindow).toBe("global_daily_ceiling");
      const runCapWins = await createCostGuardedLlm(supabase, "u1", { capUsdOverride: 0.001 });
      if (!runCapWins.ok) throw new Error("expected ok");
      expect(runCapWins.globalCapWindow).toBeUndefined();
    });

    it("fails closed when the global sum is unreadable", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      const { supabase } = makeSupabase({
        rpcResult: (args) =>
          "p_user_id" in args ? { data: 0, error: null } : { data: null, error: { message: "timeout" } },
      });
      const result = await createCostGuardedLlm(supabase, "u1", {});
      expect(result.ok).toBe(false);
      if (result.ok || result.reason !== "global_ceiling_exceeded") throw new Error("unexpected result");
      expect(result.detail).toBe("global_ceiling_unchecked");
    });
  });

  describe("issue #126 (ADR 0047) — llm feature flag", () => {
    it("refuses cleanly with reason 'feature_disabled' — never calls the ceiling RPC — when the flag is disabled", async () => {
      vi.stubEnv("OPENAI_API_KEY", "sk-test");
      mockCheckFeature.mockResolvedValue({
        allowed: false,
        reason: "disabled" as const,
        spentUsd: 0,
        budgetUsd: null,
        dailyUsd: null,
        contact: "support@membral.me",
      });
      const { supabase } = makeSupabase({ rpcResult: { data: "0", error: null } });

      const result = await createCostGuardedLlm(supabase, "u1", {});

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("feature_disabled");
      expect(supabase.rpc).not.toHaveBeenCalled();
    });
  });
});
