// #93 / D6 — tests for scripts/usage-reconcile.mjs's pure aggregation and
// its price-table sourcing. Imported by relative path from the repo root
// script (a plain Node ESM file, not part of this workspace's TS build) —
// Vite/vitest transforms whatever that script itself dynamically imports
// (including the real price-table.ts), so these run the exact same code
// path the standalone `node scripts/usage-reconcile.mjs` CLI does.
import { describe, expect, it } from "vitest";
import type { ComputedCost } from "@/lib/code-sessions/price-table";
import {
  PRICE_TABLE_VERSION as APP_PRICE_TABLE_VERSION,
  computeCost as appComputeCost,
} from "@/lib/code-sessions/price-table";
import { loadPriceTable, reconcileSessions } from "../../../../../../scripts/usage-reconcile.mjs";

const VALID_USAGE = {
  inputTokens: 1_000_000,
  outputTokens: 500_000,
  cacheReadInputTokens: 200_000,
  cacheCreationInputTokens: 50_000,
};

describe("scripts/usage-reconcile.mjs — reconcileSessions", () => {
  it("sums one main run + two sub-agent runs across two models into per-model totals and a grand total", async () => {
    const sessions = [
      {
        id: "s1",
        props: {
          usage: VALID_USAGE,
          models: ["claude-fable-5"],
          subAgents: [
            { model: "claude-sonnet-5", usage: VALID_USAGE, isFork: false },
            { model: "claude-sonnet-5", usage: VALID_USAGE, isFork: false },
          ],
        },
      },
    ];

    const result = await reconcileSessions(sessions);

    expect(result.sessionsCounted).toBe(1);
    expect(result.sessionsPriced).toBe(1);
    // 3 priceable usage blobs (1 main + 2 sub-agents), each the same VALID_USAGE.
    expect(result.tokens.inputTokens).toBe(VALID_USAGE.inputTokens * 3);
    expect(result.tokens.outputTokens).toBe(VALID_USAGE.outputTokens * 3);
    expect(result.tokens.cacheReadInputTokens).toBe(VALID_USAGE.cacheReadInputTokens * 3);
    expect(result.tokens.cacheCreationInputTokens).toBe(VALID_USAGE.cacheCreationInputTokens * 3);

    expect([...result.perModel.keys()].sort()).toEqual(["claude-fable-5", "claude-sonnet-5"]);
    const fable = result.perModel.get("claude-fable-5")!;
    const sonnet = result.perModel.get("claude-sonnet-5")!;
    expect(fable.runs).toBe(1);
    expect(sonnet.runs).toBe(2);
    expect(fable.cost).toBeGreaterThan(0);
    expect(sonnet.cost).toBeGreaterThan(0);

    // Grand total is the sum of every priced entry — proves sub-agent usage
    // is folded in, not dropped (the whole point of #93/D6).
    const sumOfModelCosts = fable.cost + sonnet.cost;
    expect(Math.abs(result.totalCost - sumOfModelCosts)).toBeLessThan(1e-6);
    expect(result.totalCost).toBeGreaterThan(fable.cost); // sub-agent cost is not zero
  });

  it("skips isFork:true sub-agent sidecars and entries with no priceable usage, same as the app's own gate", async () => {
    const sessions = [
      {
        id: "s1",
        props: {
          usage: VALID_USAGE,
          models: ["claude-sonnet-5"],
          subAgents: [
            { model: "claude-opus-5", usage: VALID_USAGE, isFork: true },
            { model: "claude-haiku-4", isFork: false }, // no usage on disk
          ],
        },
      },
    ];
    const result = await reconcileSessions(sessions);
    expect([...result.perModel.keys()]).toEqual(["claude-sonnet-5"]);
  });

  it("a session with no priceable usage anywhere contributes zero cost, never throws", async () => {
    const sessions = [
      { id: "s1", props: null },
      { id: "s2", props: { usage: { inputTokens: "nope" } } },
    ];
    const result = await reconcileSessions(sessions);
    expect(result.totalCost).toBe(0);
    expect(result.sessionsPriced).toBe(0);
    expect(result.sessionsCounted).toBe(2);
  });
});

describe("scripts/usage-reconcile.mjs — price table sourcing (D6: 'same price table the app uses')", () => {
  it("loadPriceTable() resolves to the SAME module the app imports (identical exports, not a reimplementation)", async () => {
    const scriptMod = await loadPriceTable();
    // Native-import path (this repo's Node supports type-stripping — see
    // the script's own header comment) resolves the real exports directly.
    expect(scriptMod.PRICE_TABLE_VERSION).toBe(APP_PRICE_TABLE_VERSION);
    expect(typeof scriptMod.computeCost).toBe("function");
  });

  it("computes byte-identical costs across every price tier as the app's own computeCost", async () => {
    const scriptMod = await loadPriceTable();
    const models = ["claude-fable-5", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5", "some-unknown-model"];
    for (const model of models) {
      const appCost = appComputeCost(VALID_USAGE, model) as ComputedCost;
      const scriptCost = scriptMod.computeCost(VALID_USAGE, model);
      expect(scriptCost.amount).toBe(appCost.amount);
      expect(scriptCost.price_table_version).toBe(appCost.price_table_version);
      expect(scriptCost.unknownModel).toBe(appCost.unknownModel);
    }
  });
});
