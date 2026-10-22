import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---
//
// hasFeature's query shape is `.from("feature_flags").select("enabled").eq("user_id", ...).eq("feature", ...).maybeSingle()`
// for the row check, and `.auth.admin.getUserById(...)` for BOTH the allowlist's email lookup
// AND its confirmation check (issue #126 finding 1 — profiles.email is deliberately not used
// any more, see feature-flags.ts's resolveUser).

let featureFlagRow: { enabled: boolean; budget_usd?: number | null; daily_usd?: number | null } | null = null;
let featureFlagError: { message: string } | null = null;
let adminUser: { email: string | null; email_confirmed_at: string | null } | null = null;
let adminUserThrows = false;
/** issue #128 — the lifetime/24h spend RPC (llm_spend_sum). Two calls happen in the "budget exhausted, check daily" path: the first (no p_since window, sinceIso=epoch) reads `rpcLifetimeSpend`, the second (24h window) reads `rpcDailySpend`. Tests that never exceed budget_usd only ever need the first. */
let rpcLifetimeSpend = 0;
let rpcDailySpend = 0;
/**
 * issue #127 self-hosting decision — app_settings row key='mode'. Defaults
 * to "hosted" here (NOT the DB's real "no row = open" default) so every
 * PRE-EXISTING test in this file keeps exercising hosted-mode resolution
 * exactly as before, explicitly rather than by accident. Open-mode tests
 * set this to null (no row) or "open" themselves.
 */
let appSettingsModeValue: string | null = "hosted";
let appSettingsModeError: { message: string } | null = null;

function maybeSingleFeatureFlags() {
  return Promise.resolve(
    featureFlagError ? { data: null, error: featureFlagError } : { data: featureFlagRow, error: null },
  );
}

function maybeSingleAppSettingsMode() {
  return Promise.resolve(
    appSettingsModeError
      ? { data: null, error: appSettingsModeError }
      : { data: appSettingsModeValue === null ? null : { value: appSettingsModeValue }, error: null },
  );
}

const mockFrom = vi.fn((table: string) => {
  if (table === "feature_flags") {
    return {
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: maybeSingleFeatureFlags,
          }),
        }),
      }),
    };
  }
  if (table === "app_settings") {
    return {
      select: () => ({
        eq: () => ({
          maybeSingle: maybeSingleAppSettingsMode,
        }),
      }),
    };
  }
  throw new Error(`unexpected table: ${table}`);
});

const mockGetUserById = vi.fn(() => {
  if (adminUserThrows) throw new Error("admin API boom");
  return Promise.resolve(
    adminUser ? { data: { user: adminUser }, error: null } : { data: { user: null }, error: null },
  );
});

/** issue #128 — llm_spend_sum RPC double. A 24h-scoped call (p_since within the last day, approximated by "not epoch") returns rpcDailySpend; anything else (the lifetime epoch-since call) returns rpcLifetimeSpend. */
const mockRpc = vi.fn((fn: string, params: Record<string, unknown>) => {
  if (fn !== "llm_spend_sum") throw new Error(`unexpected rpc: ${fn}`);
  const since = new Date(params.p_since as string).getTime();
  const isLifetimeWindow = since <= new Date(0).getTime() + 1000;
  return Promise.resolve({ data: isLifetimeWindow ? rpcLifetimeSpend : rpcDailySpend, error: null });
});

const mockCreateClient = vi.fn((..._args: unknown[]) => ({
  from: mockFrom,
  auth: { admin: { getUserById: mockGetUserById } },
  rpc: mockRpc,
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: (...args: unknown[]) => mockCreateClient(...args),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import {
  _cacheSizeForTest,
  _clearAppModeCacheForTest,
  _clearFeatureFlagCache,
  _setMaxCacheEntriesForTest,
  assertFeature,
  checkFeature,
  DEFAULT_MEMORY_MONTHLY_BUDGET_USD_PER_USER,
  FeatureDisabledError,
  featureDisabledResponse,
  formatUsdSpend,
  getAppMode,
  hasFeature,
} from "../feature-flags";

describe("feature-flags", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _clearFeatureFlagCache();
    _clearAppModeCacheForTest();
    _setMaxCacheEntriesForTest(10_000);
    featureFlagRow = null;
    featureFlagError = null;
    adminUser = null;
    adminUserThrows = false;
    rpcLifetimeSpend = 0;
    rpcDailySpend = 0;
    appSettingsModeValue = "hosted";
    appSettingsModeError = null;
    delete process.env.MEMBRAL_FEATURE_ALLOWLIST;
    delete process.env.MEMBRAL_EMBED_DEFAULT_BUDGET_USD;
    delete process.env.MEMBRAL_EMBED_DEFAULT_DAILY_USD;
    // issue #151, maintainer decision 2026-09-13: the code default for an
    // UNSET MEMBRAL_LLM_DEFAULT_BUDGET_USD is 0 (disabled) — no LLM
    // allowance until a pricing review. Pinned to "0" here explicitly
    // (rather than relying on the bare default) so every PRE-EXISTING test
    // in this file keeps exercising the "llm disabled by default"
    // resolution exactly as before. The dedicated test below deletes it to
    // exercise the bare (unset) default directly.
    process.env.MEMBRAL_LLM_DEFAULT_BUDGET_USD = "0";
    delete process.env.MEMBRAL_CONTACT_EMAIL;
  });

  describe("hasFeature", () => {
    it("returns true for an enabled row", async () => {
      featureFlagRow = { enabled: true };
      expect(await hasFeature("user-1", "llm")).toBe(true);
    });

    it("returns false for a row with enabled=false", async () => {
      featureFlagRow = { enabled: false };
      expect(await hasFeature("user-1", "llm")).toBe(false);
    });

    it("returns false when no row exists (fail-closed)", async () => {
      featureFlagRow = null;
      expect(await hasFeature("user-1", "llm")).toBe(false);
    });

    it("fails closed on a query error", async () => {
      featureFlagError = { message: "connection refused" };
      expect(await hasFeature("user-1", "llm")).toBe(false);
    });

    it("round-2 review LOW 12: a query error does NOT fall through to the allowlist — a revoked user stays revoked during an outage", async () => {
      // Simulates the exact scenario the finding describes: the user's row
      // IS enabled=false (an explicit revoke) but the query to fetch it
      // transiently errors, AND their email is still allowlisted.
      process.env.MEMBRAL_FEATURE_ALLOWLIST = "llm:revoked@example.com";
      featureFlagError = { message: "connection refused" };
      adminUser = { email: "revoked@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
      expect(await hasFeature("user-1", "llm")).toBe(false);
      // Proves the allowlist path was never even consulted, not just that
      // it happened to also return false.
      expect(mockGetUserById).not.toHaveBeenCalled();
    });

    describe("MEMBRAL_FEATURE_ALLOWLIST — email entries (issue #126 finding 1)", () => {
      it("enables for a CONFIRMED email on the allowlist", async () => {
        process.env.MEMBRAL_FEATURE_ALLOWLIST = "llm:founder@example.com,other@example.com";
        featureFlagRow = null;
        adminUser = { email: "founder@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
        expect(await hasFeature("user-1", "llm")).toBe(true);
        expect(mockGetUserById).toHaveBeenCalled();
      });

      it("does NOT enable for an allowlisted email that is unconfirmed (finding 1 — the attack this closes)", async () => {
        process.env.MEMBRAL_FEATURE_ALLOWLIST = "llm:founder@example.com";
        featureFlagRow = null;
        adminUser = { email: "founder@example.com", email_confirmed_at: null };
        expect(await hasFeature("user-1", "llm")).toBe(false);
      });

      it("is case-insensitive on both the feature key and the email", async () => {
        process.env.MEMBRAL_FEATURE_ALLOWLIST = "LLM:Founder@Example.com";
        featureFlagRow = null;
        adminUser = { email: "founder@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
        expect(await hasFeature("user-1", "llm")).toBe(true);
      });

      it("does not enable for an email not on the allowlist", async () => {
        process.env.MEMBRAL_FEATURE_ALLOWLIST = "llm:someone-else@example.com";
        featureFlagRow = null;
        adminUser = { email: "founder@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
        expect(await hasFeature("user-1", "llm")).toBe(false);
      });

      it("tolerates a trailing separator and stray commas without throwing", async () => {
        process.env.MEMBRAL_FEATURE_ALLOWLIST = "llm:founder@example.com,,;";
        featureFlagRow = null;
        adminUser = { email: "founder@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
        expect(await hasFeature("user-1", "llm")).toBe(true);
      });
    });

    describe("MEMBRAL_FEATURE_ALLOWLIST — user-id entries (issue #126 finding 1 fix (b))", () => {
      it("enables for a user id on the allowlist, with no admin API call and no confirmation requirement", async () => {
        process.env.MEMBRAL_FEATURE_ALLOWLIST = "llm:11111111-1111-1111-1111-111111111111";
        featureFlagRow = null;
        expect(await hasFeature("11111111-1111-1111-1111-111111111111", "llm")).toBe(true);
        expect(mockGetUserById).not.toHaveBeenCalled();
      });

      it("is case-insensitive on the user id", async () => {
        process.env.MEMBRAL_FEATURE_ALLOWLIST = "llm:AAAAAAAA-1111-1111-1111-111111111111";
        featureFlagRow = null;
        expect(await hasFeature("aaaaaaaa-1111-1111-1111-111111111111", "llm")).toBe(true);
      });

      it("a non-matching user id falls through to the (empty) email set", async () => {
        process.env.MEMBRAL_FEATURE_ALLOWLIST = "llm:11111111-1111-1111-1111-111111111111";
        featureFlagRow = null;
        expect(await hasFeature("user-1", "llm")).toBe(false);
      });
    });

    describe("issue #126 finding 4 — an explicit row wins over the allowlist", () => {
      it("enabled=false row is NOT overridden by an allowlisted email (revoke actually revokes)", async () => {
        process.env.MEMBRAL_FEATURE_ALLOWLIST = "llm:founder@example.com";
        featureFlagRow = { enabled: false };
        adminUser = { email: "founder@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
        expect(await hasFeature("user-1", "llm")).toBe(false);
        expect(mockGetUserById).not.toHaveBeenCalled();
      });

      it("enabled=false row is NOT overridden by an allowlisted user id either", async () => {
        process.env.MEMBRAL_FEATURE_ALLOWLIST = "llm:11111111-1111-1111-1111-111111111111";
        featureFlagRow = { enabled: false };
        expect(await hasFeature("11111111-1111-1111-1111-111111111111", "llm")).toBe(false);
      });

      it("no row at all still falls through to the allowlist", async () => {
        process.env.MEMBRAL_FEATURE_ALLOWLIST = "llm:founder@example.com";
        featureFlagRow = null;
        adminUser = { email: "founder@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
        expect(await hasFeature("user-1", "llm")).toBe(true);
      });
    });

    describe("issue #126 finding 3 — hasFeature never throws", () => {
      it("fails closed (does not reject) when the admin API throws during the allowlist check", async () => {
        process.env.MEMBRAL_FEATURE_ALLOWLIST = "llm:founder@example.com";
        featureFlagRow = null;
        adminUserThrows = true;
        await expect(hasFeature("user-1", "llm")).resolves.toBe(false);
      });
    });

    it("caches the result — a second call within the TTL does not re-query", async () => {
      featureFlagRow = { enabled: true };
      expect(await hasFeature("user-1", "llm")).toBe(true);
      const callsAfterFirst = mockFrom.mock.calls.length;
      // Change the underlying data — the cached value should still win.
      featureFlagRow = { enabled: false };
      expect(await hasFeature("user-1", "llm")).toBe(true);
      expect(mockFrom.mock.calls.length).toBe(callsAfterFirst);
    });

    it("caches per (userId, feature) independently", async () => {
      featureFlagRow = { enabled: true };
      expect(await hasFeature("user-1", "llm")).toBe(true);
      featureFlagRow = null;
      expect(await hasFeature("user-2", "llm")).toBe(false);
    });

    it("issue #126 finding 13 — evicts the oldest cache entry once the (test-lowered) cap is hit", async () => {
      _setMaxCacheEntriesForTest(2);
      featureFlagRow = { enabled: true };
      await hasFeature("user-1", "llm");
      await hasFeature("user-2", "llm");
      expect(_cacheSizeForTest()).toBe(2);
      await hasFeature("user-3", "llm");
      expect(_cacheSizeForTest()).toBe(2);

      // user-1's entry was evicted — asking again re-queries rather than
      // reading a stale cached value.
      featureFlagRow = { enabled: false };
      expect(await hasFeature("user-1", "llm")).toBe(false);
    });

    it("issue #126 finding 13 — reuses one SupabaseClient across cache misses (never re-constructs one per call)", async () => {
      // The client is memoized at module scope, so a EARLIER test in this
      // file may already have populated it — clearAllMocks() (beforeEach)
      // resets the call COUNT either way. What must hold regardless of test
      // order is: three distinct cache-missing hasFeature calls never
      // produce more than one createClient call.
      featureFlagRow = { enabled: true };
      await hasFeature("user-1", "llm");
      await hasFeature("user-2", "llm");
      await hasFeature("user-3", "llm");
      expect(mockCreateClient.mock.calls.length).toBeLessThanOrEqual(1);
    });
  });

  describe("assertFeature / FeatureDisabledError / featureDisabledResponse", () => {
    it("assertFeature resolves silently when enabled", async () => {
      featureFlagRow = { enabled: true };
      await expect(assertFeature("user-1", "llm")).resolves.toBeUndefined();
    });

    it("assertFeature throws FeatureDisabledError when disabled", async () => {
      featureFlagRow = null;
      await expect(assertFeature("user-1", "llm")).rejects.toBeInstanceOf(FeatureDisabledError);
    });

    it("FeatureDisabledError carries the feature name and a 403 status", async () => {
      featureFlagRow = null;
      try {
        await assertFeature("user-1", "llm");
        throw new Error("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(FeatureDisabledError);
        expect((err as FeatureDisabledError).feature).toBe("llm");
        expect((err as FeatureDisabledError).status).toBe(403);
      }
    });

    it("featureDisabledResponse returns a 403 JSON body with reason/message/contact (issue #128)", async () => {
      const err = new FeatureDisabledError("llm", "disabled", "support@membral.me");
      const response = featureDisabledResponse(err);
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body).toEqual({
        error: "feature_disabled",
        feature: "llm",
        reason: "disabled",
        message:
          "Memory features are not enabled for this account. Extracting memories from your conversations costs real money — email support@membral.me to enable it.",
        contact: "support@membral.me",
      });
    });

    it("featureDisabledResponse's message differs per reason (budget_exhausted / daily_exhausted)", async () => {
      const budgetBody = await featureDisabledResponse(
        new FeatureDisabledError("embeddings", "budget_exhausted", "ops@x.com"),
      ).json();
      expect(budgetBody.message).toBe("Your embeddings allowance is used up — email ops@x.com to extend it.");

      const dailyBody = await featureDisabledResponse(
        new FeatureDisabledError("llm", "daily_exhausted", "ops@x.com"),
      ).json();
      expect(dailyBody.message).toBe("Daily llm allowance reached; try again tomorrow or email ops@x.com.");
    });
  });

  // ---------------------------------------------------------------------
  // checkFeature — issue #128 (ADR 0047 v2) budget/teaser resolution.
  // ---------------------------------------------------------------------
  describe("checkFeature", () => {
    it("no row, no allowlist: embeddings defaults to enabled with the $0.50/$0.01 defaults", async () => {
      featureFlagRow = null;
      const result = await checkFeature("user-1", "embeddings");
      expect(result).toMatchObject({ allowed: true, reason: "ok", budgetUsd: 0.5, dailyUsd: 0.01, spentUsd: 0 });
    });

    it("no row, no allowlist, MEMBRAL_LLM_DEFAULT_BUDGET_USD=0: llm defaults to disabled", async () => {
      featureFlagRow = null;
      const result = await checkFeature("user-1", "llm");
      expect(result).toMatchObject({ allowed: false, reason: "disabled", budgetUsd: null, dailyUsd: null });
    });

    it("no row, no allowlist, MEMBRAL_LLM_DEFAULT_BUDGET_USD UNSET: llm defaults to disabled (maintainer decision 2026-09-13, issue #151; restored by goal 2026-09-24 review M1)", async () => {
      delete process.env.MEMBRAL_LLM_DEFAULT_BUDGET_USD;
      featureFlagRow = null;
      rpcLifetimeSpend = 0;
      const result = await checkFeature("user-1", "llm");
      expect(result).toMatchObject({ allowed: false, reason: "disabled", budgetUsd: null, dailyUsd: null });
    });

    it("an invalid or negative MEMBRAL_LLM_DEFAULT_BUDGET_USD resolves to disabled, never a default-on budget (review m2)", async () => {
      featureFlagRow = null;
      for (const raw of ["off", "-1"]) {
        process.env.MEMBRAL_LLM_DEFAULT_BUDGET_USD = raw;
        _clearFeatureFlagCache();
        const result = await checkFeature("user-1", "llm");
        expect(result).toMatchObject({ allowed: false, reason: "disabled" });
      }
      delete process.env.MEMBRAL_LLM_DEFAULT_BUDGET_USD;
    });

    it("no row, no allowlist: memory defaults to ENABLED with no lifetime budget, while llm stays disabled (goal 2026-09-24 review M1)", async () => {
      delete process.env.MEMBRAL_LLM_DEFAULT_BUDGET_USD;
      delete process.env.MEMBRAL_MEMORY_MONTHLY_BUDGET_USD;
      featureFlagRow = null;
      expect(DEFAULT_MEMORY_MONTHLY_BUDGET_USD_PER_USER).toBe(2);
      expect(await checkFeature("user-1", "memory")).toMatchObject({ allowed: true, reason: "ok", budgetUsd: null });
      expect(await checkFeature("user-1", "llm")).toMatchObject({ allowed: false, reason: "disabled" });
    });

    it("MEMBRAL_MEMORY_MONTHLY_BUDGET_USD=0 (or invalid) switches memory off by default", async () => {
      featureFlagRow = null;
      for (const raw of ["0", "nope"]) {
        process.env.MEMBRAL_MEMORY_MONTHLY_BUDGET_USD = raw;
        _clearFeatureFlagCache();
        expect(await checkFeature("user-1", "memory")).toMatchObject({ allowed: false, reason: "disabled" });
      }
      delete process.env.MEMBRAL_MEMORY_MONTHLY_BUDGET_USD;
    });

    it("MEMBRAL_LLM_DEFAULT_BUDGET_USD > 0 enables llm by default with that budget", async () => {
      process.env.MEMBRAL_LLM_DEFAULT_BUDGET_USD = "2.5";
      featureFlagRow = null;
      rpcLifetimeSpend = 0;
      const result = await checkFeature("user-1", "llm");
      expect(result).toMatchObject({ allowed: true, reason: "ok", budgetUsd: 2.5, dailyUsd: null });
    });

    it("allowlist match is enabled AND unlimited (budget/daily both null) — pre-#128 semantics preserved", async () => {
      process.env.MEMBRAL_FEATURE_ALLOWLIST = "llm:founder@example.com";
      featureFlagRow = null;
      adminUser = { email: "founder@example.com", email_confirmed_at: "2026-01-01T00:00:00Z" };
      const result = await checkFeature("user-1", "llm");
      expect(result).toMatchObject({ allowed: true, reason: "ok", budgetUsd: null, dailyUsd: null });
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it("row under budget: allowed, reason ok", async () => {
      featureFlagRow = { enabled: true, budget_usd: 0.5, daily_usd: null };
      rpcLifetimeSpend = 0.2;
      const result = await checkFeature("user-1", "embeddings");
      expect(result).toMatchObject({ allowed: true, reason: "ok", spentUsd: 0.2, budgetUsd: 0.5 });
    });

    it("row over budget, no daily configured: budget_exhausted", async () => {
      featureFlagRow = { enabled: true, budget_usd: 0.5, daily_usd: null };
      rpcLifetimeSpend = 0.5; // spent === budget -> exhausted (< is the "still allowed" boundary)
      const result = await checkFeature("user-1", "embeddings");
      expect(result).toMatchObject({ allowed: false, reason: "budget_exhausted", spentUsd: 0.5 });
    });

    it("row over lifetime budget but under the daily trickle: still allowed (the teaser-then-delta shape)", async () => {
      featureFlagRow = { enabled: true, budget_usd: 0.5, daily_usd: 0.01 };
      rpcLifetimeSpend = 1.0; // well over budget_usd
      rpcDailySpend = 0.002; // under daily_usd
      const result = await checkFeature("user-1", "embeddings");
      expect(result).toMatchObject({ allowed: true, reason: "ok", spentUsd: 1.0 });
    });

    it("row over lifetime budget AND over the daily trickle: daily_exhausted", async () => {
      featureFlagRow = { enabled: true, budget_usd: 0.5, daily_usd: 0.01 };
      rpcLifetimeSpend = 1.0;
      rpcDailySpend = 0.01; // === daily_usd -> exhausted
      const result = await checkFeature("user-1", "embeddings");
      expect(result).toMatchObject({ allowed: false, reason: "daily_exhausted", spentUsd: 1.0 });
    });

    it("disabled row short-circuits before any spend query", async () => {
      featureFlagRow = { enabled: false, budget_usd: 0.5, daily_usd: 0.01 };
      const result = await checkFeature("user-1", "embeddings");
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("disabled");
      expect(mockRpc).not.toHaveBeenCalled();
    });

    it("contact defaults to support@membral.me when MEMBRAL_CONTACT_EMAIL is unset", async () => {
      featureFlagRow = null;
      const result = await checkFeature("user-1", "llm");
      expect(result.contact).toBe("support@membral.me");
    });

    it("contact reads MEMBRAL_CONTACT_EMAIL when set", async () => {
      process.env.MEMBRAL_CONTACT_EMAIL = "ops@membral.example";
      featureFlagRow = null;
      const result = await checkFeature("user-1", "llm");
      expect(result.contact).toBe("ops@membral.example");
    });

    it("hasFeature stays a boolean wrapper over checkFeature", async () => {
      featureFlagRow = { enabled: true, budget_usd: 0.5, daily_usd: null };
      rpcLifetimeSpend = 0.5; // exhausted, no daily fallback
      expect(await hasFeature("user-1", "embeddings")).toBe(false);
    });

    // round-3 review A-1 BLOCKER: `daily_usd` set with `budget_usd` NULL used
    // to be silently unenforced (unlimited spend) because the old code
    // treated `budget_usd === null` as "within lifetime budget" on its own
    // and returned `allowed: true` before ever evaluating the daily window.
    // Table-driven over all four null/non-null combinations of
    // (budget_usd, daily_usd) x (under, over) so this regression — and any
    // future one shaped like it — cannot re-land silently.
    describe("budget formula — table-driven over all (budget_usd, daily_usd) null combinations (round-3 review A-1)", () => {
      const cases: Array<{
        name: string;
        budget: number | null;
        daily: number | null;
        lifetimeSpend: number;
        dailySpend: number;
        expectAllowed: boolean;
        expectReason: string;
      }> = [
        {
          name: "budget=null, daily=null: unconditionally allowed (unlimited)",
          budget: null,
          daily: null,
          lifetimeSpend: 999, // must not matter — no RPC issued
          dailySpend: 999,
          expectAllowed: true,
          expectReason: "ok",
        },
        {
          name: "budget=set, daily=null, under budget: allowed",
          budget: 0.5,
          daily: null,
          lifetimeSpend: 0.2,
          dailySpend: 0,
          expectAllowed: true,
          expectReason: "ok",
        },
        {
          name: "budget=set, daily=null, over budget: budget_exhausted",
          budget: 0.5,
          daily: null,
          lifetimeSpend: 0.5,
          dailySpend: 0,
          expectAllowed: false,
          expectReason: "budget_exhausted",
        },
        {
          name: "budget=null, daily=set, UNDER daily: allowed — THE F1 REGRESSION CASE",
          budget: null,
          daily: 0.01,
          lifetimeSpend: 0, // must not matter — no lifetime RPC issued
          dailySpend: 0.002,
          expectAllowed: true,
          expectReason: "ok",
        },
        {
          name: "budget=null, daily=set, OVER daily: daily_exhausted — THE F1 REGRESSION CASE",
          budget: null,
          daily: 0.01,
          lifetimeSpend: 0,
          dailySpend: 0.01, // === daily -> exhausted (< is the allowed boundary)
          expectAllowed: false,
          expectReason: "daily_exhausted",
        },
        {
          name: "budget=set, daily=set, under budget (daily never checked): allowed",
          budget: 0.5,
          daily: 0.01,
          lifetimeSpend: 0.2,
          dailySpend: 999, // must not matter — budget arm short-circuits
          expectAllowed: true,
          expectReason: "ok",
        },
        {
          name: "budget=set, daily=set, over budget, under daily trickle: allowed",
          budget: 0.5,
          daily: 0.01,
          lifetimeSpend: 1.0,
          dailySpend: 0.002,
          expectAllowed: true,
          expectReason: "ok",
        },
        {
          name: "budget=set, daily=set, over budget, over daily trickle: daily_exhausted",
          budget: 0.5,
          daily: 0.01,
          lifetimeSpend: 1.0,
          dailySpend: 0.01,
          expectAllowed: false,
          expectReason: "daily_exhausted",
        },
      ];

      for (const c of cases) {
        it(c.name, async () => {
          featureFlagRow = { enabled: true, budget_usd: c.budget, daily_usd: c.daily };
          rpcLifetimeSpend = c.lifetimeSpend;
          rpcDailySpend = c.dailySpend;
          const result = await checkFeature("user-1", "embeddings");
          expect(result.allowed).toBe(c.expectAllowed);
          expect(result.reason).toBe(c.expectReason);
        });
      }
    });

    describe("round-3 review A-4 — spend is summed LIVE, never cached (only the enabled/budget/daily row is cached)", () => {
      it("a second checkFeature call within the cache TTL sees updated spend, not a stale sum", async () => {
        featureFlagRow = { enabled: true, budget_usd: 0.5, daily_usd: null };
        rpcLifetimeSpend = 0.1;
        const first = await checkFeature("user-1", "embeddings");
        expect(first).toMatchObject({ allowed: true, reason: "ok" });
        const rowCallsAfterFirst = mockFrom.mock.calls.length;

        // Spend grows past budget between the two calls (e.g. a concurrent
        // batch's llm_spend rows landed) — the row itself is unchanged, so
        // this must NOT re-query feature_flags, but MUST re-query spend.
        rpcLifetimeSpend = 0.6;
        const second = await checkFeature("user-1", "embeddings");
        expect(second).toMatchObject({ allowed: false, reason: "budget_exhausted", spentUsd: 0.6 });
        expect(mockFrom.mock.calls.length).toBe(rowCallsAfterFirst); // row still cached
      });
    });

    describe("round-3 review MED 4 — an unparseable budget_usd/daily_usd fails CLOSED, not open", () => {
      it("budget_usd = 'NaN' is treated as 0 (strictest budget), not null (unlimited)", async () => {
        featureFlagRow = { enabled: true, budget_usd: "NaN" as unknown as number, daily_usd: null };
        rpcLifetimeSpend = 0; // even $0 spent must not be "under" a corrupt budget
        const result = await checkFeature("user-1", "embeddings");
        expect(result).toMatchObject({ allowed: false, reason: "budget_exhausted", budgetUsd: 0 });
      });
    });

    // -------------------------------------------------------------------
    // issue #127 self-hosting decision (2026-09-08, migration 081) — open
    // vs hosted app mode. Every test above runs with appSettingsModeValue
    // defaulted to "hosted" (see the module-level default and beforeEach),
    // so this block is the ONLY place "open" mode is exercised.
    // -------------------------------------------------------------------
    describe("app mode (issue #127 self-hosting decision)", () => {
      it("open mode, no feature_flags row: llm is allowed and unlimited (no product constraints)", async () => {
        appSettingsModeValue = null; // no app_settings row = open
        featureFlagRow = null;
        const result = await checkFeature("user-1", "llm");
        expect(result).toMatchObject({ allowed: true, reason: "ok", budgetUsd: null, dailyUsd: null, spentUsd: 0 });
        // Open mode short-circuits before ever consulting the allowlist.
        expect(mockGetUserById).not.toHaveBeenCalled();
      });

      it("open mode, no feature_flags row: embeddings is also allowed and unlimited", async () => {
        appSettingsModeValue = "open";
        featureFlagRow = null;
        const result = await checkFeature("user-1", "embeddings");
        expect(result).toMatchObject({ allowed: true, reason: "ok", budgetUsd: null, dailyUsd: null });
      });

      it("open mode: an explicit disabled row still wins (mode never overrides an explicit row)", async () => {
        appSettingsModeValue = null;
        featureFlagRow = { enabled: false };
        const result = await checkFeature("user-1", "llm");
        expect(result).toMatchObject({ allowed: false, reason: "disabled" });
      });

      it("open mode: an explicit budgeted row is still enforced (mode never overrides an explicit row)", async () => {
        appSettingsModeValue = null;
        featureFlagRow = { enabled: true, budget_usd: 0.1, daily_usd: null };
        rpcLifetimeSpend = 0.5; // over budget
        const result = await checkFeature("user-1", "llm");
        expect(result).toMatchObject({ allowed: false, reason: "budget_exhausted", spentUsd: 0.5 });
      });

      it("an app_settings query ERROR fails closed to hosted (not open) — money-safety", async () => {
        appSettingsModeError = { message: "connection refused" };
        featureFlagRow = null;
        // MEMBRAL_LLM_DEFAULT_BUDGET_USD pinned to "0" in beforeEach — hosted-mode default for llm is disabled.
        const result = await checkFeature("user-1", "llm");
        expect(result).toMatchObject({ allowed: false, reason: "disabled" });
      });

      it("getAppMode(): no row resolves to 'open'", async () => {
        appSettingsModeValue = null;
        expect(await getAppMode()).toBe("open");
      });

      it("getAppMode(): an explicit 'hosted' row resolves to 'hosted'", async () => {
        appSettingsModeValue = "hosted";
        expect(await getAppMode()).toBe("hosted");
      });

      it("getAppMode(): a query error fails closed to 'hosted'", async () => {
        appSettingsModeError = { message: "boom" };
        expect(await getAppMode()).toBe("hosted");
      });

      it("getAppMode() is cached — a second call within the TTL does not re-query app_settings", async () => {
        appSettingsModeValue = null;
        await getAppMode();
        const callsAfterFirst = mockFrom.mock.calls.filter((c) => c[0] === "app_settings").length;
        appSettingsModeValue = "hosted"; // change underlying data — cached value should still win
        expect(await getAppMode()).toBe("open");
        expect(mockFrom.mock.calls.filter((c) => c[0] === "app_settings").length).toBe(callsAfterFirst);
      });

      it("the mode cache is shared across (userId, feature) pairs — only one app_settings query for two checkFeature calls", async () => {
        appSettingsModeValue = null;
        featureFlagRow = null;
        await checkFeature("user-1", "llm");
        await checkFeature("user-2", "embeddings");
        expect(mockFrom.mock.calls.filter((c) => c[0] === "app_settings").length).toBe(1);
      });
    });

    // -------------------------------------------------------------------
    // Round-5 verification F6 — per-user spend RATE on hosted: a "full"
    // llm grant (explicit row, budget_usd AND daily_usd both null) is
    // otherwise genuinely unlimited even in hosted mode. In hosted mode
    // only, apply MEMBRAL_LLM_DEFAULT_DAILY_USD (default $2) as the daily
    // cap — unless the operator explicitly wrote the DAILY_UNLIMITED
    // sentinel (`--daily-usd none`), or mode is `open` (no product
    // constraints, issue #127).
    // -------------------------------------------------------------------
    describe("hosted-mode daily default for full llm grants (round-5 verification F6)", () => {
      afterEach(() => {
        delete process.env.MEMBRAL_LLM_DEFAULT_DAILY_USD;
      });

      it("hosted mode, full llm grant (budget/daily both null): the $2 default daily cap applies", async () => {
        appSettingsModeValue = "hosted";
        featureFlagRow = { enabled: true, budget_usd: null, daily_usd: null };
        rpcDailySpend = 0;
        const result = await checkFeature("user-1", "llm");
        expect(result).toMatchObject({ allowed: true, reason: "ok", budgetUsd: null, dailyUsd: 2 });
      });

      it("hosted mode, full llm grant, spend at/over the default daily cap: daily_exhausted", async () => {
        appSettingsModeValue = "hosted";
        featureFlagRow = { enabled: true, budget_usd: null, daily_usd: null };
        rpcDailySpend = 2; // === default daily cap -> exhausted
        const result = await checkFeature("user-1", "llm");
        expect(result).toMatchObject({ allowed: false, reason: "daily_exhausted", dailyUsd: 2 });
      });

      it("MEMBRAL_LLM_DEFAULT_DAILY_USD overrides the $2 default", async () => {
        process.env.MEMBRAL_LLM_DEFAULT_DAILY_USD = "5";
        appSettingsModeValue = "hosted";
        featureFlagRow = { enabled: true, budget_usd: null, daily_usd: null };
        const result = await checkFeature("user-1", "llm");
        expect(result.dailyUsd).toBe(5);
      });

      it("explicit --daily-usd none (sentinel -1) stays unlimited even in hosted mode", async () => {
        appSettingsModeValue = "hosted";
        featureFlagRow = { enabled: true, budget_usd: null, daily_usd: -1 };
        const result = await checkFeature("user-1", "llm");
        expect(result).toMatchObject({ allowed: true, reason: "ok", budgetUsd: null, dailyUsd: null });
        expect(mockRpc).not.toHaveBeenCalled();
      });

      it("open mode: a full llm grant stays unlimited — the hosted-only default never applies", async () => {
        appSettingsModeValue = null; // no app_settings row = open
        featureFlagRow = { enabled: true, budget_usd: null, daily_usd: null };
        const result = await checkFeature("user-1", "llm");
        expect(result).toMatchObject({ allowed: true, reason: "ok", budgetUsd: null, dailyUsd: null });
        expect(mockRpc).not.toHaveBeenCalled();
      });

      it("does not apply to the 'embeddings' feature — only llm", async () => {
        appSettingsModeValue = "hosted";
        featureFlagRow = { enabled: true, budget_usd: null, daily_usd: null };
        const result = await checkFeature("user-1", "embeddings");
        expect(result).toMatchObject({ allowed: true, reason: "ok", budgetUsd: null, dailyUsd: null });
      });

      it("a budgeted grant (budget_usd set, daily_usd null) is untouched — the default only fills in a TRULY full grant", async () => {
        appSettingsModeValue = "hosted";
        featureFlagRow = { enabled: true, budget_usd: 0.5, daily_usd: null };
        rpcLifetimeSpend = 0.2;
        const result = await checkFeature("user-1", "llm");
        expect(result).toMatchObject({ allowed: true, reason: "ok", budgetUsd: 0.5, dailyUsd: null });
      });

      it("a disabled full-shaped row is not given a daily cap (short-circuits on enabled=false regardless)", async () => {
        appSettingsModeValue = "hosted";
        featureFlagRow = { enabled: false, budget_usd: null, daily_usd: null };
        const result = await checkFeature("user-1", "llm");
        expect(result).toMatchObject({ allowed: false, reason: "disabled" });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// formatUsdSpend (liveflow phase B defect 2, 2026-09-08): the settings AI-
// features card and FeatureDisabledNotice both used to render spentUsd via a
// flat .toFixed(2) — real sub-cent LLM spend (e.g. $0.0032, typical for a
// gpt-4o-mini pass-1 call over a few short conversations) rounded straight to
// "$0.00", making a granted account that HAD spent money look identical to
// one that hadn't. Below one cent: 4 decimals (shows a nonzero digit). At or
// above one cent: the pre-existing 2 decimals.
// ---------------------------------------------------------------------------
describe("formatUsdSpend", () => {
  it("shows 2 decimals for exactly $0.00 (no spend yet)", () => {
    expect(formatUsdSpend(0)).toBe("0.00");
  });

  it("shows 4 decimals for real sub-cent spend", () => {
    expect(formatUsdSpend(0.0032)).toBe("0.0032");
  });

  it("shows 4 decimals right up to (but not including) one cent", () => {
    expect(formatUsdSpend(0.0099)).toBe("0.0099");
  });

  it("shows 2 decimals once spend reaches one cent", () => {
    expect(formatUsdSpend(0.01)).toBe("0.01");
  });

  it("shows 2 decimals for spend well above one cent", () => {
    expect(formatUsdSpend(0.15)).toBe("0.15");
    expect(formatUsdSpend(1.5)).toBe("1.50");
  });
});
