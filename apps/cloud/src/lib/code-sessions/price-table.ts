// Cost computation for code-session run-metadata (ADR 0023 Q1a / ADR 0026
// D5). `costUSD` is emitted NOWHERE in the transcript corpus (0/42,095
// events at every level, per ADR 0026 §1.1) — this is the industry norm, not
// a Claude Code gap (every surveyed observability platform — Langfuse,
// Braintrust, Weave — computes cost client-side from a maintained price
// table; see ADR 0026 §3.1). So cost is ALWAYS `source: 'inferred'`, never
// provider-emitted, and always carries the price-table version it was priced
// with so a later re-price is auditable.
//
// FOUR BUCKETS, NOT TWO (ADR 0026 D4/§1.4): pricing only input+output
// understates real cost by 6.2x on the validated corpus — cache-read tokens
// outnumber input tokens ~1,000:1. Every price entry below carries all four.
import type { RawUsage } from "@membral/core";

// #104: v1's rates were illustrative placeholders (ADR 0026 §1.4), never
// verified against the actual Anthropic API reference. That undercounted
// Fable (fell through to the Sonnet rate — Fable is 33/61 priced founder-1k
// sessions and 87% of true cost) and overcounted Opus (stale pre-4.8
// $15/$75 rate). v2 rates below are verified against the Anthropic API
// pricing reference, not illustrative — see the FABLE_TIER/OPUS_TIER/
// HAIKU_TIER comments for the source figures.
//
// v3 (e2e C-8): Claude Code writes 1-hour cache entries, which the API bills
// at 2x input (5-minute writes are 1.25x). v2 priced every cache write at the
// 5-minute rate and undercounted current sessions by 12-35%. Rates per tier
// are unchanged; the 1-hour share of cache writes is now priced separately
// when the usage carries it (see PricedUsage).
//
// v4 (e2e review S6, 2026-09-27): per-model rates from the published Anthropic
// pricing (claude-api skill's model table and prompt-caching economics, cached
// 2026-06-24). v3 priced every model of a line at one tier; the current models
// differ: Opus 5.5 is $4/$20 with cache reads at $0.20 (0.05x), Sonnet 5 is
// $2/$10, Fable 5.1 / Mythos 5.1 read cache at $0.25 (0.025x) where Fable 5 /
// Mythos 5 read it at $1.00. The more specific model name is matched first
// (`modelPrice`). Cache writes stay 1.25x input (5-minute) and 2x input
// (1-hour) for every model.
export const PRICE_TABLE_VERSION = "v4";

/**
 * 1-hour cache writes over the input rate, per the Anthropic prompt-caching
 * pricing (5-minute writes are each tier's cacheCreationPerMtok, 1.25x input).
 */
export const CACHE_WRITE_1H_MULTIPLIER = 2;

/**
 * RawUsage plus the optional TTL split of cache writes. Claude Code transcripts
 * carry `usage.cache_creation.ephemeral_1h_input_tokens`; when the importer
 * passes it through, those tokens are priced at the 1-hour rate and the rest
 * of `cacheCreationInputTokens` at the 5-minute rate. Without it (older
 * imports, opencode) every cache write is priced at the 5-minute rate.
 */
export type PricedUsage = RawUsage & {
  cacheCreation1hInputTokens?: number;
};

export interface PriceEntry {
  /** USD per 1,000,000 tokens. */
  inputPerMtok: number;
  outputPerMtok: number;
  cacheReadPerMtok: number;
  cacheCreationPerMtok: number;
}

export interface ComputedCost {
  amount: number; // USD, sub-cent precision (numeric(12,6) in storage)
  currency: "USD";
  source: "inferred";
  price_table_version: string;
  // F7 (adversarial verify of d753f7c): `usage` here is ALWAYS the
  // main-transcript total (code-graph.ts feeds computeCost only
  // `session.props.usage`, never folding in the SubAgent nodes' own `tokens`
  // — ADR 0026 §1.3 measured sub-agents at 25.4% of output tokens / 40.7% of
  // cache reads on the validated corpus, so this amount can undercount a
  // session with heavy sub-agent use by roughly a quarter). Explicit rather
  // than silent, per D13: a consumer that wants the sub-agent-inclusive
  // total must sum SPAWNED children's `tokens` itself — P2a doesn't do it.
  scope: "main_transcript_only";
  // #104: true when tierForModel() couldn't match `primaryModel` against any
  // known model and priced it at the Sonnet 4.6 fallback rate. Exposed (rather
  // than silently mispricing) so a future new model shows up as a flagged
  // approximation instead of a silent Fable-style undercount. See
  // tierForModel()'s own comment for the matching order.
  unknownModel: boolean;
}

// Per-model rates per the Anthropic API pricing (v4; see PRICE_TABLE_VERSION).
// Cache-write (5m TTL) is 1.25x input for every model; cache-read is 0.1x
// input except where a model's published rate says otherwise (Opus 5.5,
// Fable 5.1 / Mythos 5.1). Matched against the model name in modelPrice()
// below, most specific name first. Unmatched/unknown models fall back to the
// Sonnet 4.6 rate rather than refusing to price at all, but the fallback is
// flagged via ComputedCost.unknownModel — see computeCost().
function rates(inputPerMtok: number, outputPerMtok: number, cacheReadPerMtok = inputPerMtok * 0.1): PriceEntry {
  return { inputPerMtok, outputPerMtok, cacheReadPerMtok, cacheCreationPerMtok: inputPerMtok * 1.25 };
}

// Fable 5.1 / Mythos 5.1: $10/$50, cache reads $0.25 (0.025x).
const FABLE_5_1: PriceEntry = rates(10, 50, 0.25);
// Fable 5 / Mythos 5: $10/$50, cache reads $1.00.
const FABLE_5: PriceEntry = rates(10, 50);
// Opus 5.5: $4/$20, cache reads $0.20 (0.05x).
const OPUS_5_5: PriceEntry = rates(4, 20, 0.2);
// Opus 5 / 4.8 / 4.7 / 4.6: $5/$25. Pre-4.5 Opus (retired or deprecated) is
// approximated at this rate rather than a separate legacy entry.
const OPUS: PriceEntry = rates(5, 25);
// Sonnet 5: $2/$10.
const SONNET_5: PriceEntry = rates(2, 10);
// Sonnet 4.6 (and older Sonnet): $3/$15.
const SONNET: PriceEntry = rates(3, 15);
// Haiku 4.5: $1/$5.
const HAIKU: PriceEntry = rates(1, 5);

/**
 * Most specific first: a model name matching an earlier row never reaches a
 * later one. Names are compared lower-cased with `.`/`_` read as `-`, so
 * `claude-opus-5-5`, `claude-opus-5.5` and `opus-5-5[1m]` all match Opus 5.5;
 * the trailing `(?!\d)` keeps `sonnet-5` from matching a future `sonnet-50`.
 */
const MODEL_PRICES: ReadonlyArray<{ match: RegExp; price: PriceEntry }> = [
  { match: /(fable|mythos)-5-1(?!\d)/, price: FABLE_5_1 },
  { match: /fable|mythos/, price: FABLE_5 },
  { match: /opus-5-5(?!\d)/, price: OPUS_5_5 },
  { match: /opus/, price: OPUS },
  { match: /sonnet-5(?!\d)/, price: SONNET_5 },
  { match: /sonnet/, price: SONNET },
  { match: /haiku/, price: HAIKU },
];

// `usage` ultimately comes from code_sessions.props (a jsonb column) cast to
// RawUsage at the call site, not validated — a partial/legacy/hand-edited
// two-bucket blob would otherwise flow straight into arithmetic and produce
// `amount: NaN`, which then serializes to `null` over the wire (silently
// dropping a cost object's provenance metadata along with it). Require all
// four buckets to be present, finite numbers before pricing anything;
// anything else degrades to "no cost", per ADR 0026 D13 (F8).
function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

function isValidUsage(usage: unknown): usage is PricedUsage {
  if (!usage || typeof usage !== "object") return false;
  const u = usage as Record<string, unknown>;
  return (
    isFiniteNonNegative(u.inputTokens) &&
    isFiniteNonNegative(u.outputTokens) &&
    isFiniteNonNegative(u.cacheReadInputTokens) &&
    isFiniteNonNegative(u.cacheCreationInputTokens)
  );
}

// #104: fable/mythos matched FIRST, before opus/haiku/sonnet and before the
// fallthrough. unknownModel is true only on the final fallthrough — a model
// that explicitly matches "sonnet" is a known-priced Sonnet model, not an
// unknown one. Display tiers live in lib/agent-stats/aggregate.ts's ModelTier,
// a separate grouping from pricing.
function tierForModel(model: string | undefined): { tier: PriceEntry; unknownModel: boolean } {
  const m = (model ?? "").toLowerCase().replace(/[._]/g, "-");
  for (const row of MODEL_PRICES) if (row.match.test(m)) return { tier: row.price, unknownModel: false };
  return { tier: SONNET, unknownModel: true };
}

/** The rates one model name is priced at (exported for tests and display). */
export function modelPrice(model: string | undefined): PriceEntry {
  return tierForModel(model).tier;
}

// Log each distinct unrecognized model once (not per-session) — aggregate.ts
// and attribution.ts call computeCost() per session in batches that can
// number in the hundreds, so an unconditional per-call warn would flood
// logs without adding signal beyond the first sighting.
const warnedUnknownModels = new Set<string>();
function warnUnknownModelOnce(model: string | undefined): void {
  const key = model ?? "(no model)";
  if (warnedUnknownModels.has(key)) return;
  warnedUnknownModels.add(key);
  console.warn(
    `[price-table] unrecognized model "${key}" — priced at the Sonnet 4.6 fallback rate. Add a row to MODEL_PRICES (price-table.ts) if this is a new Anthropic model line.`,
  );
}

/**
 * Compute cost for one usage total, priced against the model that produced
 * it. KNOWN LIMITATION (documented, not silently wrong): `usage` is a
 * SESSION-TOTAL, not broken out per model — a session that ran two models
 * (9.8% of founder-1k sessions per ADR 0026 §1.4) is priced entirely at the
 * primary model's rate. Exact per-model costing needs per-message usage,
 * which is out of P2a's scope; this is a documented approximation, not a
 * silent one — callers should treat `amount` as directional for multi-model
 * sessions.
 */
export function computeCost(
  usage: PricedUsage | undefined,
  primaryModel: string | undefined,
): ComputedCost | undefined {
  if (!isValidUsage(usage)) return undefined;
  const { tier, unknownModel } = tierForModel(primaryModel);
  if (unknownModel) warnUnknownModelOnce(primaryModel);
  // The 1-hour share can never exceed the total cache writes it is part of;
  // a missing or malformed split prices everything at the 5-minute rate.
  const oneHour = isFiniteNonNegative(usage.cacheCreation1hInputTokens)
    ? Math.min(usage.cacheCreation1hInputTokens, usage.cacheCreationInputTokens)
    : 0;
  const fiveMinute = usage.cacheCreationInputTokens - oneHour;
  const amount =
    (usage.inputTokens / 1_000_000) * tier.inputPerMtok +
    (usage.outputTokens / 1_000_000) * tier.outputPerMtok +
    (usage.cacheReadInputTokens / 1_000_000) * tier.cacheReadPerMtok +
    (fiveMinute / 1_000_000) * tier.cacheCreationPerMtok +
    (oneHour / 1_000_000) * tier.inputPerMtok * CACHE_WRITE_1H_MULTIPLIER;

  return {
    amount: Math.round(amount * 1_000_000) / 1_000_000, // keep sub-cent precision, avoid float noise
    currency: "USD",
    source: "inferred",
    price_table_version: PRICE_TABLE_VERSION,
    scope: "main_transcript_only",
    unknownModel,
  };
}
