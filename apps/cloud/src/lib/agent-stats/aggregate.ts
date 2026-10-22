// ADR 0032 module B — server-side aggregation for /api/agent-stats.
//
// Reads code_sessions.props.usage (the raw four-bucket usage totals) and
// prices with computeCost() from lib/code-sessions/price-table.ts — NEVER
// the code-KG mirror's cached props.est_cost_usd (ADR 0032 §1.3 finding 4:
// that cache may not have been built, and the goal's verification bullet
// requires the displayed numbers to reconcile with the underlying sessions'
// usage rows). This file is pure — no Supabase, no fetch — so it is
// unit-testable with fixture rows; apps/cloud/src/app/api/agent-stats/route.ts
// owns the query + auth and calls aggregateAgentStats with the rows it read.
//
// W11/D12: also reads code_sessions.props.subAgents[] and prices EACH
// sub-agent with its own model (isFork:true entries skipped) — the main
// transcript's props.model/props.models only ever reflect the model(s) that
// produced the main transcript's OWN messages, never a Task/Agent spawn's
// sub-agent transcript, which routinely runs a different model (Sonnet/
// Opus/Haiku) and can carry MORE tokens than the main transcript. Before
// this, `by_model`/`cost_usd` were scoped to the main transcript only —
// see aggregateAgentStats' own doc comment below for the accumulator detail.
import { computeCost, type PricedUsage } from "@/lib/code-sessions/price-table";

export type ModelTier = "Fable" | "Opus" | "Sonnet" | "Haiku" | "Other";

// Fixed display order (ADR 0032 §3 B4): "assigned in fixed order by tier,
// never by rank, so a range change that drops a tier does not repaint the
// survivors." Fable sits above Opus (maintainer product-review feedback,
// membral-k89): fable is the higher tier and, on this repo's founder-1k
// corpus, the majority of recent sessions — rendering it as "Other" in the
// distribution bar was confusing. DISPLAY-tier ordering/grouping only; it
// does not change price-table.ts's pricing tier (see tierForModel there),
// which still prices fable at the Sonnet rate per its own documented choice.
export const MODEL_TIER_ORDER: ModelTier[] = ["Fable", "Opus", "Sonnet", "Haiku", "Other"];

/** Grouping label only — distinct from price-table.ts's pricing tier, which
 * defaults unmatched/unrecognized models (fable included) to the Sonnet
 * rate. Here fable gets its own first-class bucket (rather than falling into
 * "Other") and any other unmatched model is its own bucket ("Other") so the
 * distribution bar shows the tiers users actually recognize, per ADR 0032
 * §3 B4 and the membral-k89 follow-up. */
export function tierLabelForModel(model: string | undefined): ModelTier {
  const m = (model ?? "").toLowerCase();
  if (m.includes("fable")) return "Fable";
  if (m.includes("opus")) return "Opus";
  if (m.includes("haiku")) return "Haiku";
  if (m.includes("sonnet")) return "Sonnet";
  return "Other";
}

function isFiniteNonNegative(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= 0;
}

/** Same four-bucket-present-and-finite gate as price-table.ts's (unexported)
 * isValidUsage — duplicated rather than imported because it isn't part of
 * that module's public surface (mirrors the same duplication already present
 * in lib/code-sessions/view.ts's shapeSessionFacts). Exported (not just
 * module-local) so lib/agent-stats/attribution.ts (goal step 9 slice two —
 * issue attribution) can price the same `code_sessions.props.usage` shape
 * without a second duplicate of this gate. */
export function asRawUsage(raw: unknown): PricedUsage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const u = raw as Record<string, unknown>;
  if (
    !isFiniteNonNegative(u.inputTokens) ||
    !isFiniteNonNegative(u.outputTokens) ||
    !isFiniteNonNegative(u.cacheReadInputTokens) ||
    !isFiniteNonNegative(u.cacheCreationInputTokens)
  ) {
    return undefined;
  }
  return {
    inputTokens: u.inputTokens as number,
    outputTokens: u.outputTokens as number,
    cacheReadInputTokens: u.cacheReadInputTokens as number,
    cacheCreationInputTokens: u.cacheCreationInputTokens as number,
    // Kept so computeCost prices 1-hour cache writes at their own rate (e2e C-8).
    ...(isFiniteNonNegative(u.cacheCreation1hInputTokens)
      ? { cacheCreation1hInputTokens: u.cacheCreation1hInputTokens }
      : {}),
  };
}

/** Exported for the same reason as asRawUsage above — attribution.ts reuses it. */
export function asModelList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((m): m is string => typeof m === "string");
}

/** One sub-agent record's priceable shape, as stored in `code_sessions.props.subAgents[]`
 * (RawSubAgent, packages/core/src/sessions/types.ts). `props` is unvalidated jsonb, so this
 * reads defensively rather than trusting the core type — same posture as asRawUsage/asModelList
 * above. Only `isFork`/`model`/`usage` are needed here (W11/D12 — sub-agent cost attribution). */
interface SubAgentUsageRecord {
  isFork: boolean;
  model: string | undefined;
  usage: PricedUsage | undefined;
}

/** Exported for the same "duplicated gate, not part of a module's public
 * surface" reason as asRawUsage/asModelList above. `isFork:true` sidecars
 * inherit their parent's context and are not a distinct run — skipped here
 * the same way code-graph.ts:384 skips them for SubAgent nodes (ADR 0026 D3). */
export function asSubAgentList(raw: unknown): SubAgentUsageRecord[] {
  if (!Array.isArray(raw)) return [];
  const out: SubAgentUsageRecord[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.isFork === true) continue;
    out.push({
      isFork: false,
      model: typeof e.model === "string" ? e.model : undefined,
      usage: asRawUsage(e.usage),
    });
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}

export interface AgentStatsSessionInput {
  id: string;
  started_at: string | null;
  turn_count: number | null;
  user_turn_count: number | null;
  /** code_sessions.props — jsonb, unvalidated at the DB boundary. `subAgents`
   * (W11/D12) is the RawSubAgent[] array the parser attaches per session
   * (packages/core/src/sessions/claude-code.ts) — sub-agent runs (Sonnet/
   * Opus/Haiku Task/Agent spawns) that the main transcript's `models`/`usage`
   * never include. */
  props: { usage?: unknown; models?: unknown; subAgents?: unknown } | null | undefined;
}

export interface AgentStatsTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
}

export interface AgentStatsTotals {
  /** null (never 0) when zero sessions in the window carry priceable usage —
   * the "$0.00-vs-—" rule (ADR 0032 §3 B6): a missing measurement must never
   * render as a measured zero. */
  cost_usd: number | null;
  sessions: number;
  turns: number;
  user_turns: number;
  tokens: AgentStatsTokens;
  /** W11/D12 — the slice of `cost_usd` contributed by sub-agent runs (each
   * priced with its OWN model via computeCost, not the session's primary
   * model). 0, never null, when no sub-agent usage was priced in the window —
   * unlike `cost_usd` this is a component of a measured total, not itself a
   * "measured vs absent" signal, so it doesn't need the $0.00-vs-— null gate. */
  subagent_cost_usd: number;
  /** Count of priced sub-agent runs folded into this window's totals
   * (isFork:true sidecars and runs with no priceable usage already excluded). */
  subagent_runs: number;
}

export interface AgentStatsDailyPoint {
  /** YYYY-MM-DD, calendar day in the requested tz. */
  date: string;
  cost_usd: number;
  sessions: number;
}

export interface AgentStatsModelTotal {
  model_tier: ModelTier;
  cost_usd: number;
  tokens: number;
  /** W11/D12 — count of priced runs (main-transcript sessions whose primary
   * model landed in this tier, PLUS priced sub-agent runs whose own model
   * landed in this tier) that contributed to this tier's cost_usd/tokens. Not
   * a turn count (code_session_turns has no per-turn model column — session-
   * grained is the fix's documented scope) — "runs" here means "priced units
   * folded into this bucket," the closest available proxy to "how much of
   * this tier's activity happened." */
  runs: number;
  /** #93 (usage visibility that reconciles) — count of DISTINCT sessions that
   * contributed at least one priced run to this tier, whether via their own
   * main-transcript model or one of their sub-agents'. Distinct from `runs`:
   * a session running Fable on the main transcript plus two Sonnet
   * sub-agents adds 1 to Sonnet's `sessions` but 2 to Sonnet's `runs`. */
  sessions: number;
  /** #93 — per-bucket token breakdown for this tier (main-transcript runs
   * plus sub-agent runs whose model landed here), so a per-model table can
   * show input/output/cache-read/cache-write columns instead of only the
   * flat `tokens` sum above. */
  token_buckets: AgentStatsTokens;
}

export interface AgentStatsCoverage {
  sessions_total: number;
  sessions_with_usage: number;
}

/** Monthly breakdown (membral-k89, maintainer product-review feedback:
 * "some type of monthly breakup instead of a together flow"). Calendar
 * months (YYYY-MM) in the requested tz, derived from the SAME rows/pass as
 * `daily` — cheap, no extra query. Deliberately NOT zero-filled the way
 * `daily` is (a 90d/all range can span many empty months; the monthly table
 * is a compact list of months that actually had sessions, not a gapless
 * chart x-axis) — a month with zero sessions is omitted from this array
 * entirely, never emitted as a zero row. `tokens` is the flat four-bucket
 * sum (same definition as AgentStatsModelTotal.tokens), not the broken-out
 * AgentStatsTokens shape — the monthly table renders one token column, not four. */
export interface AgentStatsMonthlyPoint {
  /** YYYY-MM, calendar month in the requested tz. */
  month: string;
  cost_usd: number;
  sessions: number;
  tokens: number;
}

export interface AgentStatsAggregate {
  totals: AgentStatsTotals;
  /** Zero-filled across every day in [startDate, endDate] so the chart's x
   * axis has a stable, gapless domain regardless of which days had sessions. */
  daily: AgentStatsDailyPoint[];
  /** Ascending by month, omitting empty months — see AgentStatsMonthlyPoint. */
  monthly: AgentStatsMonthlyPoint[];
  by_model: AgentStatsModelTotal[];
  coverage: AgentStatsCoverage;
}

export type AgentStatsRange = "7d" | "30d" | "90d" | "all";

export interface AgentStatsCostProvenance {
  source: "inferred";
  price_table_version: string;
  /** W11/D12 — was "main_transcript_only"; aggregateAgentStats now folds each
   * session's props.subAgents[] (own model, own usage, isFork:true skipped)
   * into the same totals/by_model accumulators as the main transcript, so
   * cost/model coverage is no longer main-transcript-scoped. */
  scope: "main_transcript_plus_subagents";
  /** Fraction (0..1) of `totals.cost_usd` contributed by sub-agent runs —
   * totals.subagent_cost_usd / totals.cost_usd, or 0 when cost_usd is null/0.
   * Lets the UI show "N% from sub-agents" without recomputing the ratio. */
  subagent_share: number;
}

/** The full GET /api/agent-stats response shape (ADR 0032 §3 B, endpoint
 * contract) — kept beside the pure aggregator so route.ts and the /pulse
 * client component share one type. `sessions_ever` is one addition beyond
 * the ADR's literal payload sketch: a cheap unbounded head-count needed to
 * tell "zero sessions in this range" (B6 row 1) apart from "zero sessions
 * ever" (B6 row 2) — the two read differently and the range-scoped totals
 * alone can't distinguish them. */
export interface AgentStatsPayload {
  range: AgentStatsRange;
  tz: string;
  totals: AgentStatsTotals;
  previous_totals: AgentStatsTotals | null;
  daily: AgentStatsDailyPoint[];
  monthly: AgentStatsMonthlyPoint[];
  by_model: AgentStatsModelTotal[];
  coverage: AgentStatsCoverage;
  sessions_ever: number;
  cost_provenance: AgentStatsCostProvenance;
}

export interface AggregateAgentStatsOptions {
  /** IANA zone; caller (the route) validates and falls back to "UTC" before
   * calling this function, but dayKey() below also degrades safely if an
   * invalid zone slips through, so this module has no hidden dependency on
   * the caller's validation. */
  tz: string;
  /** Calendar day (YYYY-MM-DD, in `tz`), inclusive — the first bucket. */
  startDate: string;
  /** Calendar day (YYYY-MM-DD, in `tz`), inclusive — the last bucket. */
  endDate: string;
}

/** Format an ISO timestamp as a YYYY-MM-DD calendar day in `tz`. en-CA is a
 * locale trick, not a locale choice — it's the one built-in Intl locale that
 * formats as YYYY-MM-DD, so no manual reassembly of y/m/d parts is needed. */
function dayKey(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      new Date(iso),
    );
  } catch {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date(iso));
  }
}

/** Every calendar-day string from startDate to endDate inclusive. Pure
 * date-string arithmetic (both bounds are already tz-local calendar days, so
 * no further tz conversion is needed to walk between them). */
function enumerateDays(startDate: string, endDate: string): string[] {
  const days: string[] = [];
  if (!startDate || !endDate || startDate > endDate) return days;
  let cur = startDate;
  // Bounded by construction (routes cap range at 90d/all); belt-and-braces
  // ceiling so a malformed date string can never spin this loop forever.
  for (let i = 0; i < 3660 && cur <= endDate; i++) {
    days.push(cur);
    const d = new Date(`${cur}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    cur = d.toISOString().slice(0, 10);
  }
  return days;
}

/**
 * Aggregate a window of code_sessions rows into module B's payload shape.
 * Sessions without priceable usage (isValidUsage fails, or props/usage is
 * absent) still count toward `sessions`/`turns`/`coverage.sessions_total` —
 * only `coverage.sessions_with_usage`, `tokens`, `cost_usd`, `by_model`, and
 * a day's `cost_usd` bucket require valid, priced usage.
 *
 * W11/D12: each session's `props.subAgents[]` (sub-agent Task/Agent spawns,
 * `isFork:true` skipped) is priced separately — each with ITS OWN model, via
 * the same computeCost() call — and folded into the SAME tokens/cost_usd/
 * by_model/daily/monthly accumulators as the main transcript, so a session
 * that ran e.g. Fable on the main transcript plus Sonnet/Opus/Haiku
 * sub-agents contributes to all four of those model buckets, not just
 * Fable's. `coverage.sessions_with_usage` still reflects only main-transcript
 * priced usage (unchanged) — see AgentStatsTotals.subagent_cost_usd/
 * subagent_runs for the sub-agent-specific slice.
 */
export function aggregateAgentStats(
  sessions: AgentStatsSessionInput[],
  opts: AggregateAgentStatsOptions,
): AgentStatsAggregate {
  const tz = opts.tz || "UTC";

  let sessionsCount = 0;
  let turns = 0;
  let userTurns = 0;
  let pricedCostSum = 0;
  let pricedCount = 0;
  let subagentCostSum = 0;
  let subagentRunsCount = 0;
  const tokens: AgentStatsTokens = { input: 0, output: 0, cache_read: 0, cache_creation: 0 };
  const dailyCostByDay = new Map<string, number>();
  const dailySessionsByDay = new Map<string, number>();
  const modelTotals = new Map<
    ModelTier,
    { cost: number; tokens: number; runs: number; sessionIds: Set<string>; buckets: AgentStatsTokens }
  >();
  // Monthly maps, keyed by YYYY-MM (day.slice(0, 7) — day is already the
  // tz-local calendar day, so no extra Intl call is needed to derive month).
  const monthlyCostByMonth = new Map<string, number>();
  const monthlySessionsByMonth = new Map<string, number>();
  const monthlyTokensByMonth = new Map<string, number>();

  for (const s of sessions) {
    sessionsCount++;
    turns += s.turn_count ?? 0;
    userTurns += s.user_turn_count ?? 0;

    const day = s.started_at ? dayKey(s.started_at, tz) : null;
    const month = day ? day.slice(0, 7) : null;
    if (day) dailySessionsByDay.set(day, (dailySessionsByDay.get(day) ?? 0) + 1);
    if (month) monthlySessionsByMonth.set(month, (monthlySessionsByMonth.get(month) ?? 0) + 1);

    // Accumulate this session's OWN contribution to the day/month cost+token
    // buckets across BOTH the main transcript and its sub-agent runs below,
    // then apply once — day/month buckets don't distinguish main vs sub-agent
    // cost, only the per-tier by_model split and the top-level
    // subagent_cost_usd/subagent_runs totals do.
    let sessionCostAdded = 0;
    let sessionTokensAdded = 0;

    const usage = asRawUsage(s.props?.usage);
    if (usage) {
      const models = asModelList(s.props?.models);
      const primaryModel = models[0];
      const cost = computeCost(usage, primaryModel);
      if (cost) {
        // defensive — computeCost only returns undefined for invalid usage, already excluded above
        pricedCostSum += cost.amount;
        pricedCount++;
        tokens.input += usage.inputTokens;
        tokens.output += usage.outputTokens;
        tokens.cache_read += usage.cacheReadInputTokens;
        tokens.cache_creation += usage.cacheCreationInputTokens;

        const sessionTokenTotal =
          usage.inputTokens + usage.outputTokens + usage.cacheReadInputTokens + usage.cacheCreationInputTokens;
        sessionCostAdded += cost.amount;
        sessionTokensAdded += sessionTokenTotal;

        const tier = tierLabelForModel(primaryModel);
        const entry = modelTotals.get(tier) ?? {
          cost: 0,
          tokens: 0,
          runs: 0,
          sessionIds: new Set<string>(),
          buckets: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
        };
        entry.cost += cost.amount;
        entry.tokens += sessionTokenTotal;
        entry.runs += 1;
        entry.sessionIds.add(s.id);
        entry.buckets.input += usage.inputTokens;
        entry.buckets.output += usage.outputTokens;
        entry.buckets.cache_read += usage.cacheReadInputTokens;
        entry.buckets.cache_creation += usage.cacheCreationInputTokens;
        modelTotals.set(tier, entry);
      }
    }

    // W11/D12 — sub-agent runs (Sonnet/Opus/Haiku Task/Agent spawns) execute
    // real, separately-priced model calls that the main transcript's own
    // usage/models never include (root cause of "$ shows only Fable"). Price
    // EACH sub-agent with its OWN model via computeCost and fold into the
    // SAME accumulators as the main transcript above, so by_model/totals
    // reflect every model that actually ran, not just the main transcript's.
    // isFork:true sidecars already filtered out by asSubAgentList (D3).
    for (const sub of asSubAgentList(s.props?.subAgents)) {
      if (!sub.usage) continue;
      const subCost = computeCost(sub.usage, sub.model);
      if (!subCost) continue;

      pricedCostSum += subCost.amount;
      subagentCostSum += subCost.amount;
      subagentRunsCount++;
      tokens.input += sub.usage.inputTokens;
      tokens.output += sub.usage.outputTokens;
      tokens.cache_read += sub.usage.cacheReadInputTokens;
      tokens.cache_creation += sub.usage.cacheCreationInputTokens;

      const subTokenTotal =
        sub.usage.inputTokens +
        sub.usage.outputTokens +
        sub.usage.cacheReadInputTokens +
        sub.usage.cacheCreationInputTokens;
      sessionCostAdded += subCost.amount;
      sessionTokensAdded += subTokenTotal;

      const tier = tierLabelForModel(sub.model);
      const entry = modelTotals.get(tier) ?? {
        cost: 0,
        tokens: 0,
        runs: 0,
        sessionIds: new Set<string>(),
        buckets: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
      };
      entry.cost += subCost.amount;
      entry.tokens += subTokenTotal;
      entry.runs += 1;
      entry.sessionIds.add(s.id);
      entry.buckets.input += sub.usage.inputTokens;
      entry.buckets.output += sub.usage.outputTokens;
      entry.buckets.cache_read += sub.usage.cacheReadInputTokens;
      entry.buckets.cache_creation += sub.usage.cacheCreationInputTokens;
      modelTotals.set(tier, entry);
    }

    if (sessionCostAdded > 0) {
      if (day) dailyCostByDay.set(day, (dailyCostByDay.get(day) ?? 0) + sessionCostAdded);
      if (month) {
        monthlyCostByMonth.set(month, (monthlyCostByMonth.get(month) ?? 0) + sessionCostAdded);
        monthlyTokensByMonth.set(month, (monthlyTokensByMonth.get(month) ?? 0) + sessionTokensAdded);
      }
    }
  }

  const daily: AgentStatsDailyPoint[] = enumerateDays(opts.startDate, opts.endDate).map((date) => ({
    date,
    cost_usd: round(dailyCostByDay.get(date) ?? 0),
    sessions: dailySessionsByDay.get(date) ?? 0,
  }));

  // NOT zero-filled (unlike `daily` above) — only months that actually had a
  // session appear, sorted ascending by the YYYY-MM key (lexicographic sort
  // is chronological for this key shape).
  const monthly: AgentStatsMonthlyPoint[] = Array.from(monthlySessionsByMonth.keys())
    .sort()
    .map((month) => ({
      month,
      cost_usd: round(monthlyCostByMonth.get(month) ?? 0),
      sessions: monthlySessionsByMonth.get(month) ?? 0,
      tokens: monthlyTokensByMonth.get(month) ?? 0,
    }));

  const by_model: AgentStatsModelTotal[] = MODEL_TIER_ORDER.filter((t) => modelTotals.has(t)).map((t) => {
    const entry = modelTotals.get(t);
    return {
      model_tier: t,
      cost_usd: round(entry?.cost ?? 0),
      tokens: entry?.tokens ?? 0,
      runs: entry?.runs ?? 0,
      sessions: entry?.sessionIds.size ?? 0,
      token_buckets: entry?.buckets ?? { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
    };
  });

  return {
    totals: {
      // Gate on EITHER main-transcript or sub-agent priced usage — a session
      // whose main transcript has no priceable usage but does have priced
      // sub-agent runs must still surface a measured (non-null) cost_usd
      // (the $0.00-vs-— rule cares about "was anything priced", not "was
      // the MAIN transcript specifically priced").
      cost_usd: pricedCount > 0 || subagentRunsCount > 0 ? round(pricedCostSum) : null,
      sessions: sessionsCount,
      turns,
      user_turns: userTurns,
      tokens,
      subagent_cost_usd: round(subagentCostSum),
      subagent_runs: subagentRunsCount,
    },
    daily,
    monthly,
    by_model,
    coverage: { sessions_total: sessionsCount, sessions_with_usage: pricedCount },
  };
}

/** Running total over a daily series — panel 2 (cumulative cost) is a pure
 * client-side transform of panel 1's data, so the API payload doesn't carry
 * a redundant second series (matches the endpoint shape in ADR 0032 §3 B3).
 * Monotonic non-decreasing by construction (cost is never negative). */
export function computeCumulative(daily: AgentStatsDailyPoint[]): { date: string; cumulative_cost_usd: number }[] {
  let running = 0;
  return daily.map((d) => {
    running = round(running + d.cost_usd);
    return { date: d.date, cumulative_cost_usd: running };
  });
}

/**
 * UX W5: one session's whole cost — main transcript plus every sub-agent
 * run, each at its own model, live price table — through the SAME
 * aggregateAgentStats call the session page header makes (a one-day window
 * on the session's own UTC start day). Null when nothing was priceable.
 */
export function sessionLiveCostUsd(row: AgentStatsSessionInput): number | null {
  const day = (row.started_at ?? new Date().toISOString()).slice(0, 10);
  return aggregateAgentStats([row], { tz: "UTC", startDate: day, endDate: day }).totals.cost_usd;
}
