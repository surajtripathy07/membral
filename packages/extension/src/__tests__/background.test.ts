// Wiring tests for background.ts (goal 2026-07-26 step 2, MAJOR 3 fix —
// round-2 adversarial review: the badge/demotion LOGIC was already correct
// and unit-tested in badge.test.ts, but it was under-wired — onInstalled/
// onStartup only fire on an actual install or full browser restart, not on
// the far more frequent MV3 service-worker wake/kill cycle, so a stuck badge
// could sit wrong for up to the alarm's 24h cadence. These tests isolate
// background.ts's OWN orchestration (call badge.js/storage.js/sync/*
// functions at the right times) by mocking every one of those dependencies
// — the dependencies' own logic is covered by their dedicated test files.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRefreshBadge = vi.fn().mockResolvedValue(undefined);
const mockDemoteStaleSyncingProviders = vi.fn().mockResolvedValue(undefined);
vi.mock("../common/badge.js", () => ({
  refreshBadge: (...args: unknown[]) => mockRefreshBadge(...args),
  demoteStaleSyncingProviders: (...args: unknown[]) => mockDemoteStaleSyncingProviders(...args),
}));

const mockMigrateStorageKeys = vi.fn().mockResolvedValue(undefined);
const mockGetSettings = vi.fn().mockResolvedValue({ syncIntervalMinutes: 60, enabledProviders: [] });
const mockGetSyncState = vi.fn().mockResolvedValue({ providers: {}, lastFullSyncAt: null });
const mockSaveConversationsBatch = vi.fn().mockResolvedValue(undefined);
const mockUpdateProviderSyncState = vi.fn().mockResolvedValue(undefined);
const mockGetAllConversationsForExport = vi.fn().mockResolvedValue([]);
vi.mock("../common/storage.js", () => ({
  migrateStorageKeys: (...args: unknown[]) => mockMigrateStorageKeys(...args),
  getSettings: (...args: unknown[]) => mockGetSettings(...args),
  getSyncState: (...args: unknown[]) => mockGetSyncState(...args),
  saveConversationsBatch: (...args: unknown[]) => mockSaveConversationsBatch(...args),
  updateProviderSyncState: (...args: unknown[]) => mockUpdateProviderSyncState(...args),
  getAllConversationsForExport: (...args: unknown[]) => mockGetAllConversationsForExport(...args),
}));

const mockSyncAll = vi.fn().mockResolvedValue({ results: {} });
const mockSyncOne = vi.fn().mockResolvedValue({ success: true, count: 0 });
vi.mock("../sync/engine.js", () => ({
  syncAll: (...args: unknown[]) => mockSyncAll(...args),
  syncOne: (...args: unknown[]) => mockSyncOne(...args),
}));

const mockPushToCloud = vi.fn().mockResolvedValue({ pushed: false });
const mockGetCloudSyncStatus = vi.fn().mockResolvedValue({ state: "idle" });
vi.mock("../sync/cloud-push.js", () => ({
  pushToCloud: (...args: unknown[]) => mockPushToCloud(...args),
  getCloudSyncStatus: (...args: unknown[]) => mockGetCloudSyncStatus(...args),
}));

const mockAutoExportIfEnabled = vi.fn().mockResolvedValue({ exported: false });
vi.mock("../sync/auto-export.js", () => ({
  autoExportIfEnabled: (...args: unknown[]) => mockAutoExportIfEnabled(...args),
}));

vi.mock("../sync/exporter.js", () => ({
  exportAsJson: vi.fn(),
}));

// --- chrome mock ---

type Listener = (...args: unknown[]) => unknown;

function makeChromeMock() {
  const listeners = {
    onInstalled: [] as Listener[],
    onStartup: [] as Listener[],
    onAlarm: [] as Listener[],
    onMessage: [] as Listener[],
    onChanged: [] as Listener[],
  };
  return {
    listeners,
    chrome: {
      runtime: {
        onInstalled: { addListener: (fn: Listener) => listeners.onInstalled.push(fn) },
        onStartup: { addListener: (fn: Listener) => listeners.onStartup.push(fn) },
        onMessage: { addListener: (fn: Listener) => listeners.onMessage.push(fn) },
        sendMessage: vi.fn().mockResolvedValue(undefined),
      },
      alarms: {
        onAlarm: { addListener: (fn: Listener) => listeners.onAlarm.push(fn) },
        create: vi.fn(),
        clear: vi.fn().mockResolvedValue(undefined),
      },
      storage: {
        onChanged: { addListener: (fn: Listener) => listeners.onChanged.push(fn) },
        local: { get: vi.fn().mockResolvedValue({}), set: vi.fn().mockResolvedValue(undefined) },
      },
      action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn() },
      downloads: { download: vi.fn() },
    },
  };
}

async function flushMicrotasks() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("background.ts wiring (MAJOR 3 fix)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("calls refreshBadge at TOP-LEVEL module init — runs on every service-worker wake, not just onInstalled/onStartup", async () => {
    const { chrome } = makeChromeMock();
    vi.stubGlobal("chrome", chrome);

    await import("../background.js");
    await flushMicrotasks();

    expect(mockRefreshBadge).toHaveBeenCalled();
  });

  it("onStartup calls demoteStaleSyncingProviders before refreshBadge", async () => {
    const { chrome, listeners } = makeChromeMock();
    vi.stubGlobal("chrome", chrome);

    await import("../background.js");
    mockRefreshBadge.mockClear();
    mockDemoteStaleSyncingProviders.mockClear();

    for (const fn of listeners.onStartup) await fn();
    await flushMicrotasks();

    expect(mockDemoteStaleSyncingProviders).toHaveBeenCalled();
    expect(mockRefreshBadge).toHaveBeenCalled();
  });

  it("the alarm handler calls demoteStaleSyncingProviders before starting a new sync cycle", async () => {
    const { chrome, listeners } = makeChromeMock();
    vi.stubGlobal("chrome", chrome);

    await import("../background.js");
    mockDemoteStaleSyncingProviders.mockClear();
    mockSyncAll.mockClear();

    for (const fn of listeners.onAlarm) await fn({ name: "membral-sync-daily" });
    await flushMicrotasks();

    expect(mockDemoteStaleSyncingProviders).toHaveBeenCalled();
    expect(mockSyncAll).toHaveBeenCalled();
    // demotion runs BEFORE the sync cycle starts.
    const demoteOrder = mockDemoteStaleSyncingProviders.mock.invocationCallOrder[0];
    const syncOrder = mockSyncAll.mock.invocationCallOrder[0];
    expect(demoteOrder).toBeLessThan(syncOrder);
  });

  it("a stale-syncing demotion failure never blocks the alarm's sync cycle from starting", async () => {
    const { chrome, listeners } = makeChromeMock();
    vi.stubGlobal("chrome", chrome);
    mockDemoteStaleSyncingProviders.mockRejectedValueOnce(new Error("boom"));

    await import("../background.js");
    mockSyncAll.mockClear();

    for (const fn of listeners.onAlarm) await fn({ name: "membral-sync-daily" });
    await flushMicrotasks();

    expect(mockSyncAll).toHaveBeenCalled();
  });

  // ---- MINOR 4 (round-2 adversarial review): a failed provider must never be reported as a source ----

  it("the alarm handler excludes a failed provider from pushToCloud's syncedProviderIds, even when another provider succeeded with zero new items", async () => {
    const { chrome, listeners } = makeChromeMock();
    vi.stubGlobal("chrome", chrome);
    mockSyncAll.mockResolvedValueOnce({
      results: {
        claude: { success: true, count: 0 },
        chatgpt: { success: false, count: 0, error: "network error" },
      },
    });

    await import("../background.js");
    mockPushToCloud.mockClear();

    for (const fn of listeners.onAlarm) await fn({ name: "membral-sync-daily" });
    await flushMicrotasks();

    expect(mockPushToCloud).toHaveBeenCalledTimes(1);
    const [, syncedProviderIds] = mockPushToCloud.mock.calls[0];
    expect(syncedProviderIds).toEqual(["claude"]);
  });

  it("the alarm handler still pings pushToCloud when totalSynced is 0 but a provider succeeded (the MAJOR 2 quiet-cycle case)", async () => {
    const { chrome, listeners } = makeChromeMock();
    vi.stubGlobal("chrome", chrome);
    mockSyncAll.mockResolvedValueOnce({ results: { claude: { success: true, count: 0 } } });

    await import("../background.js");
    mockPushToCloud.mockClear();

    for (const fn of listeners.onAlarm) await fn({ name: "membral-sync-daily" });
    await flushMicrotasks();

    expect(mockPushToCloud).toHaveBeenCalledTimes(1);
  });

  it("the alarm handler does NOT ping pushToCloud when every provider failed (nothing succeeded, nothing to report)", async () => {
    const { chrome, listeners } = makeChromeMock();
    vi.stubGlobal("chrome", chrome);
    mockSyncAll.mockResolvedValueOnce({ results: { claude: { success: false, count: 0, error: "boom" } } });

    await import("../background.js");
    mockPushToCloud.mockClear();

    for (const fn of listeners.onAlarm) await fn({ name: "membral-sync-daily" });
    await flushMicrotasks();

    expect(mockPushToCloud).not.toHaveBeenCalled();
  });

  it("the syncAll message handler also excludes a failed provider from syncedProviderIds", async () => {
    const { chrome, listeners } = makeChromeMock();
    vi.stubGlobal("chrome", chrome);
    mockSyncAll.mockResolvedValueOnce({
      results: {
        claude: { success: true, count: 2 },
        chatgpt: { success: false, count: 0, error: "network error" },
      },
    });

    await import("../background.js");
    mockPushToCloud.mockClear();

    const messageListener = listeners.onMessage[0];
    await new Promise<void>((resolve) => {
      messageListener({ action: "syncAll" }, {}, () => resolve());
    });

    expect(mockPushToCloud).toHaveBeenCalledTimes(1);
    const [, syncedProviderIds] = mockPushToCloud.mock.calls[0];
    expect(syncedProviderIds).toEqual(["claude"]);
  });

  it("registers a chrome.storage.onChanged listener that refreshes the badge on a sync-state change", async () => {
    const { chrome, listeners } = makeChromeMock();
    vi.stubGlobal("chrome", chrome);

    await import("../background.js");
    mockRefreshBadge.mockClear();

    const { STORAGE_KEYS } = await import("../common/constants.js");
    for (const fn of listeners.onChanged) {
      fn({ [STORAGE_KEYS.SYNC_STATE]: { newValue: {} } }, "local");
    }
    await flushMicrotasks();

    expect(mockRefreshBadge).toHaveBeenCalled();
  });
});
