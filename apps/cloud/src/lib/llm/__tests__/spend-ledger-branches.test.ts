import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";

const checkGlobalCeilingsMock = vi.hoisted(() => vi.fn());
vi.mock("../../memory/global-ceiling", async (orig) => ({
  ...(await orig<typeof import("../../memory/global-ceiling")>()),
  checkGlobalCeilings: checkGlobalCeilingsMock,
}));

import { createCostGuardedLlm, llmSpendSum } from "../spend-ledger";

// Issue #188 / R5 5.11: llmSpendSum's non-finite sum and createCostGuardedLlm's
// fallback detail when the global check refuses without naming a reason.

const supabaseWithRpc = (data: unknown) =>
  ({ rpc: vi.fn(() => Promise.resolve({ data, error: null })) }) as unknown as SupabaseClient;

afterEach(() => {
  vi.unstubAllEnvs();
  checkGlobalCeilingsMock.mockReset();
});

describe("llmSpendSum", () => {
  it.each([["not-a-number"], [Number.POSITIVE_INFINITY], [{}]])("a non-finite RPC value (%s) sums to 0", async (v) => {
    expect(await llmSpendSum(supabaseWithRpc(v), "u1", { sinceIso: new Date().toISOString() })).toBe(0);
  });

  it("a numeric string is read as a number", async () => {
    expect(await llmSpendSum(supabaseWithRpc("1.25"), "u1", { sinceIso: new Date().toISOString() })).toBe(1.25);
  });
});

describe("createCostGuardedLlm: global refusal without a reason", () => {
  it("falls back to detail 'global_ceiling_unchecked' and passes the spend figures through", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    checkGlobalCeilingsMock.mockResolvedValue({ allowed: false, spentUsd: 3, ceilingUsd: 2 });
    const result = await createCostGuardedLlm(supabaseWithRpc(0), "u1", { bypassFeatureGate: true });
    expect(result).toMatchObject({
      ok: false,
      reason: "global_ceiling_exceeded",
      detail: "global_ceiling_unchecked",
      spentUsd: 3,
      ceilingUsd: 2,
    });
  });
});
