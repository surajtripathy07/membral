import type { ProviderSyncState, SyncState } from "@membral/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

// In-memory store for chrome.storage.local, same pattern as storage.test.ts/settings.test.ts.
const store: Record<string, unknown> = {};
const setBadgeText = vi.fn();
const setBadgeBackgroundColor = vi.fn();

const chromeMock = {
  storage: {
    local: {
      get: vi.fn(async (keys: string | string[]) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        const result: Record<string, unknown> = {};
        for (const k of keyList) if (k in store) result[k] = store[k];
        return result;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      }),
    },
  },
  action: { setBadgeText, setBadgeBackgroundColor },
};

vi.stubGlobal("chrome", chromeMock);

// Import after mocking chrome (module-level top-level await, same convention as storage.test.ts).
const { STORAGE_KEYS } = await import("../common/constants.js");
const { computeBadgeSpec, demoteStaleSyncingProviders, isStaleSyncing, refreshBadge, SYNC_TIMEOUT_MS } = await import(
  "../common/badge.js"
);

function providerState(overrides: Partial<ProviderSyncState> = {}): ProviderSyncState {
  return {
    lastSyncAt: null,
    lastSyncStatus: "never",
    lastError: null,
    conversationCount: 0,
    ...overrides,
  };
}

function syncState(providers: Record<string, ProviderSyncState>): SyncState {
  return { providers, lastFullSyncAt: null };
}

describe("computeBadgeSpec (pure)", () => {
  it("fresh install (every enabled provider 'never', no lastSyncAt): empty badge — nothing to warn about yet", () => {
    const state = syncState({ claude: providerState(), chatgpt: providerState() });
    expect(computeBadgeSpec(state, ["claude", "chatgpt"])).toEqual({ text: "", color: "" });
  });

  it("all healthy (recent success): empty badge", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const state = syncState({
      claude: providerState({ lastSyncStatus: "success", lastSyncAt: new Date(now.getTime() - 60_000).toISOString() }),
    });
    expect(computeBadgeSpec(state, ["claude"], now)).toEqual({ text: "", color: "" });
  });

  it("any enabled provider FRESHLY mid-sync (syncStartedAt just now): '…' blue, even if another enabled provider is also unhealthy", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const state = syncState({
      claude: providerState({ lastSyncStatus: "syncing", syncStartedAt: now.toISOString() }),
      chatgpt: providerState({ lastSyncStatus: "error" }),
    });
    expect(computeBadgeSpec(state, ["claude", "chatgpt"], now)).toEqual({ text: "…", color: "#60a5fa" });
  });

  // ---- MAJOR 4 fix (adversarial review): a stuck "syncing" must not mask the error badge forever ----

  it("a STALE syncing provider (syncStartedAt past SYNC_TIMEOUT_MS) with no other problem: falls through to the health check, not '…'", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const staleStart = new Date(now.getTime() - (SYNC_TIMEOUT_MS + 60_000)).toISOString();
    // lastSyncAt is recent (healthy by the ordinary staleness bar), so the
    // fallen-through health check finds nothing else wrong — empty badge,
    // NOT "…" (the whole point: it stops claiming to be actively syncing).
    const state = syncState({
      claude: providerState({
        lastSyncStatus: "syncing",
        syncStartedAt: staleStart,
        lastSyncAt: new Date(now.getTime() - 60_000).toISOString(),
      }),
    });
    expect(computeBadgeSpec(state, ["claude"], now)).toEqual({ text: "", color: "" });
  });

  it("a STALE syncing provider whose own lastSyncAt (from a previous real sync) is also past STALE_SYNC_MS: '!' red (coordinator's own acceptance case — stale syncing WITH an unhealthy signal)", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const staleSyncStart = new Date(now.getTime() - (SYNC_TIMEOUT_MS + 60_000)).toISOString();
    const staleLastSyncAt = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
    const state = syncState({
      claude: providerState({ lastSyncStatus: "syncing", syncStartedAt: staleSyncStart, lastSyncAt: staleLastSyncAt }),
    });
    expect(computeBadgeSpec(state, ["claude"], now)).toEqual({ text: "!", color: "#f87171" });
  });

  it("a STALE syncing provider alongside a DIFFERENT enabled provider that's genuinely errored: '!' red", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const staleStart = new Date(now.getTime() - (SYNC_TIMEOUT_MS + 60_000)).toISOString();
    const state = syncState({
      claude: providerState({ lastSyncStatus: "syncing", syncStartedAt: staleStart }),
      chatgpt: providerState({ lastSyncStatus: "error", lastError: "boom" }),
    });
    expect(computeBadgeSpec(state, ["claude", "chatgpt"], now)).toEqual({ text: "!", color: "#f87171" });
  });

  it("just under SYNC_TIMEOUT_MS: still counts as actively syncing", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const almostStale = new Date(now.getTime() - (SYNC_TIMEOUT_MS - 60_000)).toISOString();
    const state = syncState({ claude: providerState({ lastSyncStatus: "syncing", syncStartedAt: almostStale }) });
    expect(computeBadgeSpec(state, ["claude"], now)).toEqual({ text: "…", color: "#60a5fa" });
  });

  it("a 'syncing' status with NO syncStartedAt at all (pre-migration stored state) is NOT treated as actively syncing — falls through, and with no lastSyncAt either, reads as healthy (empty), not '…'", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const state = syncState({ claude: providerState({ lastSyncStatus: "syncing", syncStartedAt: undefined }) });
    expect(computeBadgeSpec(state, ["claude"], now)).toEqual({ text: "", color: "" });
  });

  it("an enabled provider with lastSyncStatus 'error': '!' red", () => {
    const state = syncState({ claude: providerState({ lastSyncStatus: "error", lastError: "boom" }) });
    expect(computeBadgeSpec(state, ["claude"])).toEqual({ text: "!", color: "#f87171" });
  });

  it("an enabled provider whose last successful sync is older than 24h: '!' red", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const staleAt = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
    const state = syncState({ claude: providerState({ lastSyncStatus: "success", lastSyncAt: staleAt }) });
    expect(computeBadgeSpec(state, ["claude"], now)).toEqual({ text: "!", color: "#f87171" });
  });

  it("just under the 24h threshold: still healthy", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const freshAt = new Date(now.getTime() - 23 * 60 * 60 * 1000).toISOString();
    const state = syncState({ claude: providerState({ lastSyncStatus: "success", lastSyncAt: freshAt }) });
    expect(computeBadgeSpec(state, ["claude"], now)).toEqual({ text: "", color: "" });
  });

  it("a disabled provider's stale/error state never triggers the badge", () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const staleAt = new Date(now.getTime() - 48 * 60 * 60 * 1000).toISOString();
    const state = syncState({
      claude: providerState({ lastSyncStatus: "success", lastSyncAt: new Date(now.getTime() - 60_000).toISOString() }),
      chatgpt: providerState({ lastSyncStatus: "error", lastSyncAt: staleAt }), // disabled below
    });
    expect(computeBadgeSpec(state, ["claude"], now)).toEqual({ text: "", color: "" });
    // sanity: if chatgpt were enabled too, it WOULD trigger red.
    expect(computeBadgeSpec(state, ["claude", "chatgpt"], now).text).toBe("!");
  });

  it("an unknown/never-configured enabled provider id (missing from state.providers) is ignored, not a crash", () => {
    const state = syncState({
      claude: providerState({ lastSyncStatus: "success", lastSyncAt: new Date().toISOString() }),
    });
    expect(() => computeBadgeSpec(state, ["claude", "grok"])).not.toThrow();
    expect(computeBadgeSpec(state, ["claude", "grok"])).toEqual({ text: "", color: "" });
  });
});

describe("isStaleSyncing (pure)", () => {
  const now = new Date("2026-07-26T12:00:00.000Z");

  it("false for a non-syncing provider regardless of syncStartedAt", () => {
    expect(
      isStaleSyncing(providerState({ lastSyncStatus: "success", syncStartedAt: "2020-01-01T00:00:00.000Z" }), now),
    ).toBe(false);
  });

  it("true when syncing with no syncStartedAt at all", () => {
    expect(isStaleSyncing(providerState({ lastSyncStatus: "syncing" }), now)).toBe(true);
  });

  it("false when syncing and syncStartedAt is recent", () => {
    const started = new Date(now.getTime() - 60_000).toISOString();
    expect(isStaleSyncing(providerState({ lastSyncStatus: "syncing", syncStartedAt: started }), now)).toBe(false);
  });

  it("true when syncing and syncStartedAt is older than SYNC_TIMEOUT_MS", () => {
    const started = new Date(now.getTime() - (SYNC_TIMEOUT_MS + 1)).toISOString();
    expect(isStaleSyncing(providerState({ lastSyncStatus: "syncing", syncStartedAt: started }), now)).toBe(true);
  });
});

describe("demoteStaleSyncingProviders", () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
  });

  it("demotes a stale-syncing provider to 'error' and clears syncStartedAt", async () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const staleStart = new Date(now.getTime() - (SYNC_TIMEOUT_MS + 60_000)).toISOString();
    store[STORAGE_KEYS.SYNC_STATE] = {
      providers: {
        claude: {
          lastSyncAt: null,
          lastSyncStatus: "syncing",
          lastError: null,
          conversationCount: 0,
          syncStartedAt: staleStart,
        },
      },
      lastFullSyncAt: null,
    };

    await demoteStaleSyncingProviders(now);

    const stored = store[STORAGE_KEYS.SYNC_STATE] as {
      providers: Record<string, { lastSyncStatus: string; syncStartedAt: string | null; lastError: string | null }>;
    };
    expect(stored.providers.claude.lastSyncStatus).toBe("error");
    expect(stored.providers.claude.syncStartedAt).toBeNull();
    expect(stored.providers.claude.lastError).toBeTruthy();
  });

  it("leaves a freshly-syncing provider untouched", async () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    const freshStart = new Date(now.getTime() - 60_000).toISOString();
    store[STORAGE_KEYS.SYNC_STATE] = {
      providers: {
        claude: {
          lastSyncAt: null,
          lastSyncStatus: "syncing",
          lastError: null,
          conversationCount: 0,
          syncStartedAt: freshStart,
        },
      },
      lastFullSyncAt: null,
    };

    await demoteStaleSyncingProviders(now);

    const stored = store[STORAGE_KEYS.SYNC_STATE] as { providers: Record<string, { lastSyncStatus: string }> };
    expect(stored.providers.claude.lastSyncStatus).toBe("syncing");
  });

  it("leaves a non-syncing provider untouched", async () => {
    const now = new Date("2026-07-26T12:00:00.000Z");
    store[STORAGE_KEYS.SYNC_STATE] = {
      providers: { claude: { lastSyncAt: null, lastSyncStatus: "success", lastError: null, conversationCount: 3 } },
      lastFullSyncAt: null,
    };

    await demoteStaleSyncingProviders(now);

    const stored = store[STORAGE_KEYS.SYNC_STATE] as { providers: Record<string, { lastSyncStatus: string }> };
    expect(stored.providers.claude.lastSyncStatus).toBe("success");
  });
});

describe("refreshBadge", () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    setBadgeText.mockClear();
    setBadgeBackgroundColor.mockClear();
  });

  it("clears the badge (empty text, no color call) when all enabled providers are healthy", async () => {
    store[STORAGE_KEYS.SYNC_STATE] = {
      providers: {
        claude: {
          lastSyncAt: new Date().toISOString(),
          lastSyncStatus: "success",
          lastError: null,
          conversationCount: 3,
        },
      },
      lastFullSyncAt: null,
    };
    store[STORAGE_KEYS.SETTINGS] = { syncIntervalMinutes: 60, enabledProviders: ["claude"] };

    await refreshBadge();

    expect(setBadgeText).toHaveBeenCalledWith({ text: "" });
    expect(setBadgeBackgroundColor).not.toHaveBeenCalled();
  });

  it("sets the '!' red badge when an enabled provider errored", async () => {
    store[STORAGE_KEYS.SYNC_STATE] = {
      providers: { claude: { lastSyncAt: null, lastSyncStatus: "error", lastError: "boom", conversationCount: 0 } },
      lastFullSyncAt: null,
    };
    store[STORAGE_KEYS.SETTINGS] = { syncIntervalMinutes: 60, enabledProviders: ["claude"] };

    await refreshBadge();

    expect(setBadgeText).toHaveBeenCalledWith({ text: "!" });
    expect(setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#f87171" });
  });

  it("sets the '…' blue badge while an enabled provider is freshly syncing", async () => {
    store[STORAGE_KEYS.SYNC_STATE] = {
      providers: {
        claude: {
          lastSyncAt: null,
          lastSyncStatus: "syncing",
          lastError: null,
          conversationCount: 0,
          syncStartedAt: new Date().toISOString(),
        },
      },
      lastFullSyncAt: null,
    };
    store[STORAGE_KEYS.SETTINGS] = { syncIntervalMinutes: 60, enabledProviders: ["claude"] };

    await refreshBadge();

    expect(setBadgeText).toHaveBeenCalledWith({ text: "…" });
    expect(setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#60a5fa" });
  });

  it("sets the '!' red badge (not '…') when an enabled provider's syncing is stale AND its last real sync is also stale — MAJOR 4 fix", async () => {
    const staleStart = new Date(Date.now() - (SYNC_TIMEOUT_MS + 60_000)).toISOString();
    const staleLastSyncAt = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    store[STORAGE_KEYS.SYNC_STATE] = {
      providers: {
        claude: {
          lastSyncAt: staleLastSyncAt,
          lastSyncStatus: "syncing",
          lastError: null,
          conversationCount: 0,
          syncStartedAt: staleStart,
        },
      },
      lastFullSyncAt: null,
    };
    store[STORAGE_KEYS.SETTINGS] = { syncIntervalMinutes: 60, enabledProviders: ["claude"] };

    await refreshBadge();

    expect(setBadgeText).toHaveBeenCalledWith({ text: "!" });
    expect(setBadgeBackgroundColor).toHaveBeenCalledWith({ color: "#f87171" });
  });

  it("clears the badge (not '!', not '…') when an enabled provider's syncing is stale but its last real sync was recent", async () => {
    const staleStart = new Date(Date.now() - (SYNC_TIMEOUT_MS + 60_000)).toISOString();
    store[STORAGE_KEYS.SYNC_STATE] = {
      providers: {
        claude: {
          lastSyncAt: new Date(Date.now() - 60_000).toISOString(),
          lastSyncStatus: "syncing",
          lastError: null,
          conversationCount: 3,
          syncStartedAt: staleStart,
        },
      },
      lastFullSyncAt: null,
    };
    store[STORAGE_KEYS.SETTINGS] = { syncIntervalMinutes: 60, enabledProviders: ["claude"] };

    await refreshBadge();

    expect(setBadgeText).toHaveBeenCalledWith({ text: "" });
    expect(setBadgeBackgroundColor).not.toHaveBeenCalled();
  });

  it("defaults to no enabled providers (empty badge) when settings are unset", async () => {
    await refreshBadge();
    expect(setBadgeText).toHaveBeenCalledWith({ text: "" });
  });

  // ---- MINOR 3 fix (adversarial review): guard chrome.action absence ----

  it("does nothing (no throw) when chrome.action is absent", async () => {
    const originalAction = chromeMock.action;
    // @ts-expect-error — deliberately simulating a context without chrome.action
    chromeMock.action = undefined;
    try {
      await expect(refreshBadge()).resolves.toBeUndefined();
      expect(setBadgeText).not.toHaveBeenCalled();
    } finally {
      chromeMock.action = originalAction;
    }
  });
});
