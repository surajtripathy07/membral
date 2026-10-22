import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTACT_EMAIL_FALLBACK } from "../contact";

// Characterization lock for checkFeature (refactor programme step 1.3, lock-extend).
// One table pins the observable result AND the exact sequence of Supabase calls per
// row, so an internal rewrite of resolveFlags/resolveAllowedFromSpend must keep both.
// Same seam as feature-flags.test.ts: @supabase/supabase-js createClient is faked.

const USER_ID = "00000000-0000-4000-8000-000000000001";
const NOW = new Date("2026-09-28T12:00:00.000Z");
const EPOCH_ISO = new Date(0).toISOString();
const SINCE_24H_ISO = new Date(NOW.getTime() - 24 * 60 * 60 * 1000).toISOString();

type Feature = "llm" | "embeddings" | "memory";
type Reason = "ok" | "disabled" | "budget_exhausted" | "daily_exhausted";

interface Row {
  name: string;
  feature: Feature;
  /** Which of the two service-role env vars are present. */
  env: { url?: boolean; key?: boolean };
  /** app_settings key='mode': a value, null = no row, "error" = query error. */
  mode: "open" | "hosted" | null | "error";
  /** feature_flags row: null = no row, "error" = query error. */
  row: { enabled: boolean; budgetUsd: number | null; dailyUsd: number | null } | null | "error";
  /** MEMBRAL_FEATURE_ALLOWLIST value, when set. */
  allowlist?: string;
  /** auth.admin.getUserById result, when the allowlist lookup reaches it. */
  adminUser?: { email: string; email_confirmed_at: string | null };
  spendTotal: number;
  spendLast24h: number;
  expect: { allowed: boolean; reason: Reason; spentUsd: number; budgetUsd: number | null; dailyUsd: number | null };
  /** Ordered Supabase call log. */
  calls: string[];
}

let current: Row;
let callLog: string[] = [];

const mockFrom = vi.fn((table: string) => {
  callLog.push(`from:${table}`);
  if (table === "feature_flags") {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () => {
              const r = current.row;
              if (r === "error") return Promise.resolve({ data: null, error: { message: "flags boom" } });
              if (r === null) return Promise.resolve({ data: null, error: null });
              return Promise.resolve({
                data: { enabled: r.enabled, budget_usd: r.budgetUsd, daily_usd: r.dailyUsd },
                error: null,
              });
            },
          }),
        }),
      }),
    };
  }
  if (table === "app_settings") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: () => {
            const m = current.mode;
            if (m === "error") return Promise.resolve({ data: null, error: { message: "mode boom" } });
            return Promise.resolve({ data: m === null ? null : { value: m }, error: null });
          },
        }),
      }),
    };
  }
  throw new Error(`unexpected table: ${table}`);
});

const mockGetUserById = vi.fn((_id: string) => {
  callLog.push("auth:getUserById");
  const u = current.adminUser;
  return Promise.resolve(u ? { data: { user: u }, error: null } : { data: { user: null }, error: null });
});

const mockRpc = vi.fn((fn: string, params: Record<string, unknown>) => {
  if (fn !== "llm_spend_sum") throw new Error(`unexpected rpc: ${fn}`);
  const since = params.p_since as string;
  if (since === EPOCH_ISO) {
    callLog.push("rpc:llm_spend_sum:lifetime");
    return Promise.resolve({ data: current.spendTotal, error: null });
  }
  if (since === SINCE_24H_ISO) {
    callLog.push("rpc:llm_spend_sum:24h");
    return Promise.resolve({ data: current.spendLast24h, error: null });
  }
  throw new Error(`unexpected p_since: ${since}`);
});

const mockCreateClient = vi.fn((..._args: unknown[]) => ({
  from: mockFrom,
  auth: { admin: { getUserById: mockGetUserById } },
  rpc: mockRpc,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

vi.mock("../log", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "MEMBRAL_FEATURE_ALLOWLIST",
  "MEMBRAL_LLM_DEFAULT_BUDGET_USD",
  "MEMBRAL_LLM_DEFAULT_DAILY_USD",
  "MEMBRAL_EMBED_DEFAULT_BUDGET_USD",
  "MEMBRAL_EMBED_DEFAULT_DAILY_USD",
  "MEMBRAL_MEMORY_MONTHLY_BUDGET_USD",
  "MEMBRAL_CONTACT_EMAIL",
] as const;
const savedEnv: Record<string, string | undefined> = {};

const BOTH_ENV = { url: true, key: true };
const ZERO_SPEND = { spendTotal: 0, spendLast24h: 0 };
const DENIED_NULL = { allowed: false, reason: "disabled" as const, spentUsd: 0, budgetUsd: null, dailyUsd: null };
const OPEN_UNLIMITED = { allowed: true, reason: "ok" as const, spentUsd: 0, budgetUsd: null, dailyUsd: null };
const FF = "from:feature_flags";
const MODE = "from:app_settings";
const LIFETIME = "rpc:llm_spend_sum:lifetime";
const DAY = "rpc:llm_spend_sum:24h";

const rows: Row[] = [
  // --- null client: env missing, one row per feature -------------------------
  ...(["llm", "embeddings", "memory"] as const).flatMap((feature): Row[] => [
    {
      name: `null client (url missing) -> disabled [${feature}]`,
      feature,
      env: { key: true },
      mode: "open",
      row: { enabled: true, budgetUsd: null, dailyUsd: null },
      ...ZERO_SPEND,
      expect: DENIED_NULL,
      calls: [],
    },
    {
      name: `null client (key missing) -> disabled [${feature}]`,
      feature,
      env: { url: true },
      mode: "open",
      row: { enabled: true, budgetUsd: null, dailyUsd: null },
      ...ZERO_SPEND,
      expect: DENIED_NULL,
      calls: [],
    },
  ]),
  // --- explicit row --------------------------------------------------------
  {
    name: "row enabled=false -> disabled, row budgets echoed, no spend query",
    feature: "embeddings",
    env: BOTH_ENV,
    mode: "hosted",
    row: { enabled: false, budgetUsd: 5, dailyUsd: 1 },
    spendTotal: 99,
    spendLast24h: 99,
    expect: { allowed: false, reason: "disabled", spentUsd: 0, budgetUsd: 5, dailyUsd: 1 },
    calls: [FF],
  },
  {
    name: "feature_flags query error -> disabled, no mode/allowlist/defaults",
    feature: "embeddings",
    env: BOTH_ENV,
    mode: "open",
    row: "error",
    ...ZERO_SPEND,
    expect: DENIED_NULL,
    calls: [FF],
  },
  {
    name: "row enabled, both budgets null (embeddings) -> ok, no spend query",
    feature: "embeddings",
    env: BOTH_ENV,
    mode: "hosted",
    row: { enabled: true, budgetUsd: null, dailyUsd: null },
    spendTotal: 99,
    spendLast24h: 99,
    expect: OPEN_UNLIMITED,
    calls: [FF],
  },
  {
    name: "llm full grant in open mode -> ok unlimited, no spend query",
    feature: "llm",
    env: BOTH_ENV,
    mode: "open",
    row: { enabled: true, budgetUsd: null, dailyUsd: null },
    spendTotal: 99,
    spendLast24h: 99,
    expect: OPEN_UNLIMITED,
    calls: [FF, MODE],
  },
  {
    name: "llm full grant in hosted mode -> default daily 2, only 24h query, under -> ok",
    feature: "llm",
    env: BOTH_ENV,
    mode: "hosted",
    row: { enabled: true, budgetUsd: null, dailyUsd: null },
    spendTotal: 99,
    spendLast24h: 1.5,
    expect: { allowed: true, reason: "ok", spentUsd: 0, budgetUsd: null, dailyUsd: 2 },
    calls: [FF, MODE, DAY],
  },
  {
    name: "llm grant with daily sentinel -1 in hosted mode -> unlimited, no spend query",
    feature: "llm",
    env: BOTH_ENV,
    mode: "hosted",
    row: { enabled: true, budgetUsd: null, dailyUsd: -1 },
    spendTotal: 99,
    spendLast24h: 99,
    expect: OPEN_UNLIMITED,
    calls: [FF],
  },
  {
    name: "lifetime under budget -> ok, lifetime query only",
    feature: "llm",
    env: BOTH_ENV,
    mode: "hosted",
    row: { enabled: true, budgetUsd: 1, dailyUsd: null },
    spendTotal: 0.5,
    spendLast24h: 99,
    expect: { allowed: true, reason: "ok", spentUsd: 0.5, budgetUsd: 1, dailyUsd: null },
    calls: [FF, LIFETIME],
  },
  {
    name: "lifetime at budget (spent === budget), daily null -> budget_exhausted",
    feature: "llm",
    env: BOTH_ENV,
    mode: "hosted",
    row: { enabled: true, budgetUsd: 1, dailyUsd: null },
    spendTotal: 1,
    spendLast24h: 0,
    expect: { allowed: false, reason: "budget_exhausted", spentUsd: 1, budgetUsd: 1, dailyUsd: null },
    calls: [FF, LIFETIME],
  },
  {
    name: "lifetime over budget, daily null -> budget_exhausted",
    feature: "embeddings",
    env: BOTH_ENV,
    mode: "hosted",
    row: { enabled: true, budgetUsd: 1, dailyUsd: null },
    spendTotal: 1.5,
    spendLast24h: 0,
    expect: { allowed: false, reason: "budget_exhausted", spentUsd: 1.5, budgetUsd: 1, dailyUsd: null },
    calls: [FF, LIFETIME],
  },
  {
    name: "lifetime exhausted, daily under -> ok",
    feature: "llm",
    env: BOTH_ENV,
    mode: "hosted",
    row: { enabled: true, budgetUsd: 1, dailyUsd: 0.1 },
    spendTotal: 2,
    spendLast24h: 0.05,
    expect: { allowed: true, reason: "ok", spentUsd: 2, budgetUsd: 1, dailyUsd: 0.1 },
    calls: [FF, LIFETIME, DAY],
  },
  {
    name: "lifetime exhausted, daily at (spent24h === daily) -> daily_exhausted",
    feature: "llm",
    env: BOTH_ENV,
    mode: "hosted",
    row: { enabled: true, budgetUsd: 1, dailyUsd: 0.1 },
    spendTotal: 2,
    spendLast24h: 0.1,
    expect: { allowed: false, reason: "daily_exhausted", spentUsd: 2, budgetUsd: 1, dailyUsd: 0.1 },
    calls: [FF, LIFETIME, DAY],
  },
  {
    name: "lifetime exhausted, daily over -> daily_exhausted",
    feature: "memory",
    env: BOTH_ENV,
    mode: "hosted",
    row: { enabled: true, budgetUsd: 1, dailyUsd: 0.1 },
    spendTotal: 2,
    spendLast24h: 0.3,
    expect: { allowed: false, reason: "daily_exhausted", spentUsd: 2, budgetUsd: 1, dailyUsd: 0.1 },
    calls: [FF, LIFETIME, DAY],
  },
  {
    name: "daily-only row (budget null), under -> ok, 24h query only",
    feature: "embeddings",
    env: BOTH_ENV,
    mode: "hosted",
    row: { enabled: true, budgetUsd: null, dailyUsd: 0.1 },
    spendTotal: 99,
    spendLast24h: 0.05,
    expect: { allowed: true, reason: "ok", spentUsd: 0, budgetUsd: null, dailyUsd: 0.1 },
    calls: [FF, DAY],
  },
  // --- no row: open mode (explicit "open" and no app_settings row) ----------
  ...(["llm", "embeddings", "memory"] as const).flatMap((feature): Row[] =>
    (["open", null] as const).map(
      (mode): Row => ({
        name: `no row, mode ${mode === null ? "row missing (=open)" : "open"} -> ok unlimited [${feature}]`,
        feature,
        env: BOTH_ENV,
        mode,
        row: null,
        spendTotal: 99,
        spendLast24h: 99,
        expect: OPEN_UNLIMITED,
        calls: [FF, MODE],
      }),
    ),
  ),
  // --- no row: hosted mode defaults (env defaults unset) -------------------
  {
    name: "no row, hosted -> llm default (budget 0 = disabled)",
    feature: "llm",
    env: BOTH_ENV,
    mode: "hosted",
    row: null,
    ...ZERO_SPEND,
    expect: DENIED_NULL,
    calls: [FF, MODE],
  },
  {
    name: "no row, hosted -> embeddings default budget 0.5 / daily 0.01, under -> ok",
    feature: "embeddings",
    env: BOTH_ENV,
    mode: "hosted",
    row: null,
    spendTotal: 0.1,
    spendLast24h: 99,
    expect: { allowed: true, reason: "ok", spentUsd: 0.1, budgetUsd: 0.5, dailyUsd: 0.01 },
    calls: [FF, MODE, LIFETIME],
  },
  {
    name: "no row, hosted -> memory default enabled, unlimited",
    feature: "memory",
    env: BOTH_ENV,
    mode: "hosted",
    row: null,
    spendTotal: 99,
    spendLast24h: 99,
    expect: OPEN_UNLIMITED,
    calls: [FF, MODE],
  },
  // --- allowlist (hosted, no row) ------------------------------------------
  {
    name: "allowlist email hit (confirmed) -> ok unlimited",
    feature: "llm",
    env: BOTH_ENV,
    mode: "hosted",
    row: null,
    allowlist: "llm:alice@example.com",
    adminUser: { email: "Alice@Example.com", email_confirmed_at: "2026-01-01T00:00:00Z" },
    spendTotal: 99,
    spendLast24h: 99,
    expect: OPEN_UNLIMITED,
    calls: [FF, MODE, "auth:getUserById"],
  },
  {
    name: "allowlist user-id hit -> ok unlimited, no auth lookup",
    feature: "llm",
    env: BOTH_ENV,
    mode: "hosted",
    row: null,
    allowlist: `llm:${USER_ID}`,
    spendTotal: 99,
    spendLast24h: 99,
    expect: OPEN_UNLIMITED,
    calls: [FF, MODE],
  },
  {
    name: "allowlist email present but unconfirmed -> falls to hosted default",
    feature: "llm",
    env: BOTH_ENV,
    mode: "hosted",
    row: null,
    allowlist: "llm:alice@example.com",
    adminUser: { email: "alice@example.com", email_confirmed_at: null },
    ...ZERO_SPEND,
    expect: DENIED_NULL,
    calls: [FF, MODE, "auth:getUserById"],
  },
  // --- app-mode query error fails closed to hosted --------------------------
  {
    name: "app-mode query error, no row -> hosted defaults (embeddings)",
    feature: "embeddings",
    env: BOTH_ENV,
    mode: "error",
    row: null,
    spendTotal: 0.6,
    spendLast24h: 0.02,
    expect: { allowed: false, reason: "daily_exhausted", spentUsd: 0.6, budgetUsd: 0.5, dailyUsd: 0.01 },
    calls: [FF, MODE, LIFETIME, DAY],
  },
  {
    name: "app-mode query error, no row -> hosted defaults (llm disabled)",
    feature: "llm",
    env: BOTH_ENV,
    mode: "error",
    row: null,
    ...ZERO_SPEND,
    expect: DENIED_NULL,
    calls: [FF, MODE],
  },
];

describe("checkFeature characterization (step 1.3 lock)", () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) {
      savedEnv[k] = process.env[k];
      delete process.env[k];
    }
    vi.clearAllMocks();
    // Fresh module per row: getServiceSupabase memoizes its client at module
    // level, so the null-client rows need an import that has never built one.
    vi.resetModules();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    callLog = [];
  });

  afterEach(() => {
    vi.useRealTimers();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  });

  it.each(rows)("$name", async (r) => {
    current = r;
    if (r.env.url) process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
    if (r.env.key) process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
    if (r.allowlist) process.env.MEMBRAL_FEATURE_ALLOWLIST = r.allowlist;

    const mod = await import("../feature-flags");
    mod._clearFeatureFlagCache();
    mod._clearAppModeCacheForTest();

    const result = await mod.checkFeature(USER_ID, r.feature);

    expect(result).toEqual({ ...r.expect, contact: CONTACT_EMAIL_FALLBACK });
    expect(callLog).toEqual(r.calls);
    expect(mockCreateClient).toHaveBeenCalledTimes(r.env.url && r.env.key ? 1 : 0);
  });

  it.each([
    [
      "llm",
      null,
      [
        "chunk_embedding",
        "conversation_embedding",
        "query_embedding",
        "memory_embedding",
        "memory_backfill",
        "session_assoc",
      ],
    ],
    ["embeddings", ["chunk_embedding", "conversation_embedding", "query_embedding", "memory_embedding"], null],
    ["memory", ["memory_backfill", "session_assoc"], null],
  ] as const)("spend RPC pass-group params [%s]", async (feature, include, exclude) => {
    current = {
      name: "pass group",
      feature,
      env: BOTH_ENV,
      mode: "hosted",
      row: { enabled: true, budgetUsd: 1, dailyUsd: 0.1 },
      spendTotal: 2,
      spendLast24h: 0,
      expect: DENIED_NULL,
      calls: [],
    };
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
    const mod = await import("../feature-flags");
    mod._clearFeatureFlagCache();
    mod._clearAppModeCacheForTest();

    await mod.checkFeature(USER_ID, feature);

    expect(mockRpc.mock.calls).toEqual([
      [
        "llm_spend_sum",
        {
          p_user_id: USER_ID,
          p_since: EPOCH_ISO,
          p_run_id: null,
          p_include_passes: include,
          p_exclude_passes: exclude,
        },
      ],
      [
        "llm_spend_sum",
        {
          p_user_id: USER_ID,
          p_since: SINCE_24H_ISO,
          p_run_id: null,
          p_include_passes: include,
          p_exclude_passes: exclude,
        },
      ],
    ]);
  });
});
