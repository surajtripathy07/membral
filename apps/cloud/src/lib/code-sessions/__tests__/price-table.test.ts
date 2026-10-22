// ADR 0026 D5 — cost is always computed (`costUSD` is emitted nowhere), and
// the four-bucket model must not silently regress to a two-bucket figure.
//
// #104: v1's rates were illustrative placeholders, not verified pricing —
// Fable fell through to the Sonnet tier (undercount) and Opus was priced at
// stale pre-4.8 rates (overcount). These tests pin the v2 rates (verified
// against the Anthropic API pricing reference) so a future edit that
// silently drifts a tier's rate, or reintroduces the fable/mythos
// fallthrough, fails loudly here.
import { describe, expect, it } from "vitest";
import { asRawUsage } from "@/lib/agent-stats/aggregate";
import { RawUsageSchema } from "../payload";
import { computeCost, PRICE_TABLE_VERSION } from "../price-table";

/** Usage with exactly one bucket set to 1,000,000 tokens, the rest zero — isolates a single per-Mtok rate. */
function oneBucketUsage(bucket: "inputTokens" | "outputTokens" | "cacheReadInputTokens" | "cacheCreationInputTokens") {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    [bucket]: 1_000_000,
  };
}

describe("computeCost", () => {
  it("returns undefined when there is no usage to price", () => {
    expect(computeCost(undefined, "codehub-model-1")).toBeUndefined();
  });

  it("always carries source:'inferred' and the price table version — costUSD is never provider-emitted", () => {
    const cost = computeCost(
      { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 10, cacheCreationInputTokens: 5 },
      "codehub-model-1",
    );
    expect(cost?.source).toBe("inferred");
    expect(cost?.currency).toBe("USD");
    expect(cost?.price_table_version).toBe(PRICE_TABLE_VERSION);
  });

  it("price table version is v4 (v2 = #104 rates; v3 prices 1-hour cache writes; v4 per-model rates)", () => {
    expect(PRICE_TABLE_VERSION).toBe("v4");
  });

  it("prices unknown/unmatched models via the Sonnet-tier fallback rather than refusing to price, and flags unknownModel", () => {
    const cost = computeCost(
      { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      "some-future-model",
    );
    expect(cost?.amount).toBeGreaterThan(0);
    expect(cost?.amount).toBeCloseTo(3, 6); // Sonnet-tier input rate: $3/Mtok
    expect(cost?.unknownModel).toBe(true);
  });

  it("unknownModel is false for models with no usage-bucket surprises across all four known tiers", () => {
    const usage = { inputTokens: 1, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    for (const model of [
      "claude-fable-5",
      "claude-mythos-5",
      "claude-opus-4-8",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]) {
      expect(computeCost(usage, model)?.unknownModel).toBe(false);
    }
  });

  it("four-bucket pricing differs from a naive two-bucket (input+output only) figure by a large factor when cache reads dominate (regression guard, ADR 0026 §1.4)", () => {
    // Mirrors the corpus shape: cache-read tokens vastly outnumber input tokens.
    const usage = {
      inputTokens: 10_000,
      outputTokens: 5_000,
      cacheReadInputTokens: 10_000_000,
      cacheCreationInputTokens: 200_000,
    };
    const fourBucket = computeCost(usage, "codehub-opus-model")?.amount ?? 0;
    const twoBucketOnly =
      computeCost(
        {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
        "codehub-opus-model",
      )?.amount ?? 0;
    expect(fourBucket).toBeGreaterThan(twoBucketOnly * 2); // cache buckets must materially move the number
  });

  it("keys pricing tier by substring match on the model name (fable/mythos/opus/haiku/sonnet)", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const fable = computeCost(usage, "claude-fable-5")?.amount ?? 0;
    const mythos = computeCost(usage, "claude-mythos-5")?.amount ?? 0;
    const opus = computeCost(usage, "claude-opus-4")?.amount ?? 0;
    const haiku = computeCost(usage, "claude-haiku-4")?.amount ?? 0;
    const sonnet = computeCost(usage, "claude-sonnet-5")?.amount ?? 0;

    // Fable and Mythos share the same (top) tier.
    expect(fable).toBeCloseTo(mythos, 6);
    expect(fable).toBeGreaterThan(opus);
    expect(opus).toBeGreaterThan(sonnet);
    expect(sonnet).toBeGreaterThan(haiku);
  });

  it("matches fable/mythos BEFORE the sonnet fallthrough — regression guard for #104's headline bug", () => {
    // Fable previously fell through to the Sonnet tier ($3/Mtok input). It must now
    // price at the Fable tier ($10/Mtok input) and never at the Sonnet rate.
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const fable = computeCost(usage, "claude-fable-5");
    const sonnet = computeCost(usage, "claude-sonnet-5");
    expect(fable?.amount).toBeCloseTo(10, 6);
    expect(fable?.amount).not.toBeCloseTo(sonnet?.amount ?? -1, 6);
    expect(fable?.unknownModel).toBe(false);
  });

  describe("exact per-tier rates (verified against the Anthropic API pricing reference, issue #104)", () => {
    it("FABLE_TIER: $10.00 / $50.00 / $1.00 / $12.50 per Mtok (input/output/cache-read/cache-write-5m)", () => {
      const model = "claude-fable-5";
      expect(computeCost(oneBucketUsage("inputTokens"), model)?.amount).toBeCloseTo(10.0, 6);
      expect(computeCost(oneBucketUsage("outputTokens"), model)?.amount).toBeCloseTo(50.0, 6);
      expect(computeCost(oneBucketUsage("cacheReadInputTokens"), model)?.amount).toBeCloseTo(1.0, 6);
      expect(computeCost(oneBucketUsage("cacheCreationInputTokens"), model)?.amount).toBeCloseTo(12.5, 6);
    });

    it("mythos matches the same rates as fable", () => {
      const model = "claude-mythos-5";
      expect(computeCost(oneBucketUsage("inputTokens"), model)?.amount).toBeCloseTo(10.0, 6);
      expect(computeCost(oneBucketUsage("outputTokens"), model)?.amount).toBeCloseTo(50.0, 6);
      expect(computeCost(oneBucketUsage("cacheReadInputTokens"), model)?.amount).toBeCloseTo(1.0, 6);
      expect(computeCost(oneBucketUsage("cacheCreationInputTokens"), model)?.amount).toBeCloseTo(12.5, 6);
    });

    it("OPUS_TIER: $5.00 / $25.00 / $0.50 / $6.25 per Mtok — current Opus 5/4.8/4.7/4.6 rate (was stale $15/$75 pre-4.8)", () => {
      const model = "claude-opus-4-8";
      expect(computeCost(oneBucketUsage("inputTokens"), model)?.amount).toBeCloseTo(5.0, 6);
      expect(computeCost(oneBucketUsage("outputTokens"), model)?.amount).toBeCloseTo(25.0, 6);
      expect(computeCost(oneBucketUsage("cacheReadInputTokens"), model)?.amount).toBeCloseTo(0.5, 6);
      expect(computeCost(oneBucketUsage("cacheCreationInputTokens"), model)?.amount).toBeCloseTo(6.25, 6);
    });

    it("Sonnet 4.6: $3.00 / $15.00 / $0.30 / $3.75 per Mtok — explicit sonnet match", () => {
      const model = "claude-sonnet-4-6";
      expect(computeCost(oneBucketUsage("inputTokens"), model)?.amount).toBeCloseTo(3.0, 6);
      expect(computeCost(oneBucketUsage("outputTokens"), model)?.amount).toBeCloseTo(15.0, 6);
      expect(computeCost(oneBucketUsage("cacheReadInputTokens"), model)?.amount).toBeCloseTo(0.3, 6);
      expect(computeCost(oneBucketUsage("cacheCreationInputTokens"), model)?.amount).toBeCloseTo(3.75, 6);
    });

    it("Sonnet 5 (v4): $2.00 / $10.00 / $0.20 / $2.50 per Mtok, and 1-hour writes at $4.00", () => {
      const model = "claude-sonnet-5";
      expect(computeCost(oneBucketUsage("inputTokens"), model)?.amount).toBeCloseTo(2.0, 6);
      expect(computeCost(oneBucketUsage("outputTokens"), model)?.amount).toBeCloseTo(10.0, 6);
      expect(computeCost(oneBucketUsage("cacheReadInputTokens"), model)?.amount).toBeCloseTo(0.2, 6);
      expect(computeCost(oneBucketUsage("cacheCreationInputTokens"), model)?.amount).toBeCloseTo(2.5, 6);
      const oneHour = { ...oneBucketUsage("cacheCreationInputTokens"), cacheCreation1hInputTokens: 1_000_000 };
      expect(computeCost(oneHour, model)?.amount).toBeCloseTo(4.0, 6);
    });

    it("Opus 5.5 (v4): $4.00 / $20.00 / $0.20 / $5.00 per Mtok, 1-hour writes $8.00 — matched before generic Opus", () => {
      for (const model of ["claude-opus-5-5", "claude-opus-5.5", "claude-opus-5-5[1m]"]) {
        expect(computeCost(oneBucketUsage("inputTokens"), model)?.amount).toBeCloseTo(4.0, 6);
        expect(computeCost(oneBucketUsage("outputTokens"), model)?.amount).toBeCloseTo(20.0, 6);
        expect(computeCost(oneBucketUsage("cacheReadInputTokens"), model)?.amount).toBeCloseTo(0.2, 6);
        expect(computeCost(oneBucketUsage("cacheCreationInputTokens"), model)?.amount).toBeCloseTo(5.0, 6);
        const oneHour = { ...oneBucketUsage("cacheCreationInputTokens"), cacheCreation1hInputTokens: 1_000_000 };
        expect(computeCost(oneHour, model)?.amount).toBeCloseTo(8.0, 6);
      }
      expect(computeCost(oneBucketUsage("inputTokens"), "claude-opus-5")?.amount).toBeCloseTo(5.0, 6);
    });

    it("Fable 5.1 / Mythos 5.1 (v4): cache reads $0.25 (Fable 5 stays $1.00); $10 / $50 / $12.50", () => {
      for (const model of ["claude-fable-5-1", "claude-mythos-5-1"]) {
        expect(computeCost(oneBucketUsage("inputTokens"), model)?.amount).toBeCloseTo(10.0, 6);
        expect(computeCost(oneBucketUsage("outputTokens"), model)?.amount).toBeCloseTo(50.0, 6);
        expect(computeCost(oneBucketUsage("cacheReadInputTokens"), model)?.amount).toBeCloseTo(0.25, 6);
        expect(computeCost(oneBucketUsage("cacheCreationInputTokens"), model)?.amount).toBeCloseTo(12.5, 6);
      }
    });

    it("pins a mixed-bucket Opus 5.5 session total", () => {
      // 100k in, 20k out, 5M cache read, 400k cache write of which 300k 1-hour:
      // 0.4 + 0.4 + 1.0 + 100k*5/1M (0.5) + 300k*8/1M (2.4) = 4.7
      const usage = {
        inputTokens: 100_000,
        outputTokens: 20_000,
        cacheReadInputTokens: 5_000_000,
        cacheCreationInputTokens: 400_000,
        cacheCreation1hInputTokens: 300_000,
      };
      expect(computeCost(usage, "claude-opus-5-5")?.amount).toBeCloseTo(4.7, 6);
    });

    it("HAIKU_TIER: $1.00 / $5.00 / $0.10 / $1.25 per Mtok — current Haiku 4.5 rate (was stale Haiku 3.5 pricing)", () => {
      const model = "claude-haiku-4-5";
      expect(computeCost(oneBucketUsage("inputTokens"), model)?.amount).toBeCloseTo(1.0, 6);
      expect(computeCost(oneBucketUsage("outputTokens"), model)?.amount).toBeCloseTo(5.0, 6);
      expect(computeCost(oneBucketUsage("cacheReadInputTokens"), model)?.amount).toBeCloseTo(0.1, 6);
      expect(computeCost(oneBucketUsage("cacheCreationInputTokens"), model)?.amount).toBeCloseTo(1.25, 6);
    });
  });
});

// e2e C-8: Claude Code writes 1-hour cache entries (2x input), not 5-minute
// ones (1.25x). Fixtures are real e2e session totals (haiku-4-5, every cache
// write 1-hour) with the total_cost_usd Claude Code itself reported.
describe("computeCost — cache-write TTL split", () => {
  const HAIKU = "claude-haiku-4-5-20251001";

  it("reproduces Claude Code's own total for a session whose cache writes are all 1-hour", () => {
    const usage = {
      inputTokens: 886,
      outputTokens: 18_250,
      cacheReadInputTokens: 4_289_365,
      cacheCreationInputTokens: 52_555,
      cacheCreation1hInputTokens: 52_555,
    };
    expect(computeCost(usage, HAIKU)?.amount).toBeCloseTo(0.6261825, 5);
  });

  it("reproduces a second session (reported $0.0281979) and would undercount it by ~23% at the 5-minute rate", () => {
    const split = {
      inputTokens: 20,
      outputTokens: 1_479,
      cacheReadInputTokens: 34_829,
      cacheCreationInputTokens: 8_650,
      cacheCreation1hInputTokens: 8_650,
    };
    const { cacheCreation1hInputTokens: _drop, ...totalOnly } = split;
    expect(computeCost(split, HAIKU)?.amount).toBeCloseTo(0.0281979, 6);
    expect(computeCost(totalOnly, HAIKU)?.amount).toBeCloseTo(0.0217104, 6);
  });

  it("prices a mixed split: 1-hour share at 2x input, the rest at 1.25x", () => {
    const usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheCreation1hInputTokens: 400_000,
    };
    // Sonnet input $3/Mtok: 0.4 * 6 + 0.6 * 3.75
    expect(computeCost(usage, "claude-sonnet-4-5")?.amount).toBeCloseTo(4.65, 6);
  });

  it("keeps the 5-minute rate when only the total exists, and ignores a malformed or oversized split", () => {
    const base = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 1_000_000 };
    expect(computeCost(base, HAIKU)?.amount).toBe(1.25);
    expect(computeCost({ ...base, cacheCreation1hInputTokens: -5 }, HAIKU)?.amount).toBe(1.25);
    expect(computeCost({ ...base, cacheCreation1hInputTokens: Number.NaN }, HAIKU)?.amount).toBe(1.25);
    // A 1-hour count larger than the total is clamped to the total.
    expect(computeCost({ ...base, cacheCreation1hInputTokens: 5_000_000 }, HAIKU)?.amount).toBe(2);
  });
});

describe("cache-write split survives import and the stored-usage reader", () => {
  it("the payload schema keeps cacheCreation1hInputTokens (zod would strip an undeclared key)", () => {
    const parsed = RawUsageSchema.parse({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 3,
      cacheCreationInputTokens: 10,
      cacheCreation1hInputTokens: 7,
    });
    expect(parsed.cacheCreation1hInputTokens).toBe(7);
    expect(
      RawUsageSchema.parse({ ...parsed, cacheCreation1hInputTokens: undefined }).cacheCreation1hInputTokens,
    ).toBeUndefined();
  });

  it("asRawUsage (props.usage reader) passes the split through to computeCost", () => {
    const usage = asRawUsage({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 1_000_000,
      cacheCreation1hInputTokens: 1_000_000,
    });
    expect(computeCost(usage, "claude-haiku-4-5")?.amount).toBe(2);
  });
});
