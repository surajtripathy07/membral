import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../common/constants.js";

// --- In-memory chrome mock ---

const store: Record<string, unknown> = {};
let _downloadCallArgs: chrome.downloads.DownloadOptions | null = null;

const chromeMock = {
  storage: {
    local: {
      get: vi.fn(async (keys: string | string[]) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        const result: Record<string, unknown> = {};
        for (const k of keyList) {
          if (k in store) result[k] = store[k];
        }
        return result;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        const keyList = Array.isArray(keys) ? keys : [keys];
        for (const k of keyList) delete store[k];
      }),
    },
  },
  downloads: {
    download: vi.fn(async (options: chrome.downloads.DownloadOptions) => {
      _downloadCallArgs = options;
      return 42; // fake download id
    }),
  },
};

vi.stubGlobal("chrome", chromeMock);

const { autoExportIfEnabled, DEFAULT_AUTO_EXPORT } = await import("../sync/auto-export.js");

describe("auto-export", () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) {
      delete store[key];
    }
    _downloadCallArgs = null;
    vi.clearAllMocks();
  });

  it("does nothing when auto-export is disabled (default)", async () => {
    // No settings stored — defaults apply (enabled: false)
    const result = await autoExportIfEnabled();

    expect(result.exported).toBe(false);
    expect(result.path).toBeUndefined();
    expect(chromeMock.downloads.download).not.toHaveBeenCalled();
  });

  it("calls chrome.downloads.download when enabled", async () => {
    // Store some conversations so export has data
    store[STORAGE_KEYS.CONVERSATIONS] = {
      "claude:1": {
        id: "claude:1",
        source: "claude",
        source_id: "1",
        title: "Test",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
        model: null,
        messages: [],
        metadata: {},
        synced_at: "2025-01-01T00:00:00.000Z",
      },
    };
    store[STORAGE_KEYS.SYNC_STATE] = {
      providers: {},
      lastFullSyncAt: "2025-01-01T00:00:00.000Z",
    };
    store[STORAGE_KEYS.SETTINGS] = {
      syncIntervalMinutes: 1440,
      enabledProviders: ["claude"],
      autoExport: { enabled: true, filename: "membral/conversations.json" },
    };

    const result = await autoExportIfEnabled();

    expect(result.exported).toBe(true);
    expect(chromeMock.downloads.download).toHaveBeenCalledTimes(1);
  });

  it("uses correct filename from settings", async () => {
    store[STORAGE_KEYS.CONVERSATIONS] = {};
    store[STORAGE_KEYS.SYNC_STATE] = { providers: {}, lastFullSyncAt: null };
    store[STORAGE_KEYS.SETTINGS] = {
      syncIntervalMinutes: 1440,
      enabledProviders: [],
      autoExport: { enabled: true, filename: "custom/path/data.json" },
    };

    await autoExportIfEnabled();

    expect(chromeMock.downloads.download).toHaveBeenCalledTimes(1);
    const callArg = chromeMock.downloads.download.mock.calls[0][0];
    expect(callArg.filename).toBe("custom/path/data.json");
  });

  it("uses conflictAction overwrite", async () => {
    store[STORAGE_KEYS.CONVERSATIONS] = {};
    store[STORAGE_KEYS.SYNC_STATE] = { providers: {}, lastFullSyncAt: null };
    store[STORAGE_KEYS.SETTINGS] = {
      syncIntervalMinutes: 1440,
      enabledProviders: [],
      autoExport: { enabled: true, filename: "membral/conversations.json" },
    };

    await autoExportIfEnabled();

    const callArg = chromeMock.downloads.download.mock.calls[0][0];
    expect(callArg.conflictAction).toBe("overwrite");
  });

  it("returns the filename as path when export succeeds", async () => {
    store[STORAGE_KEYS.CONVERSATIONS] = {};
    store[STORAGE_KEYS.SYNC_STATE] = { providers: {}, lastFullSyncAt: null };
    store[STORAGE_KEYS.SETTINGS] = {
      syncIntervalMinutes: 1440,
      enabledProviders: [],
      autoExport: { enabled: true, filename: "membral/conversations.json" },
    };

    const result = await autoExportIfEnabled();

    expect(result.exported).toBe(true);
    expect(result.path).toBe("membral/conversations.json");
  });

  it("DEFAULT_AUTO_EXPORT has correct defaults", () => {
    expect(DEFAULT_AUTO_EXPORT.enabled).toBe(false);
    expect(DEFAULT_AUTO_EXPORT.filename).toBe("membral/conversations.json");
  });
});
