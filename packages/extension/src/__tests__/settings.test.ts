import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../common/constants.js";

// In-memory store for chrome.storage.local mock
const store: Record<string, unknown> = {};

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
        for (const k of keyList) {
          delete store[k];
        }
      }),
    },
  },
};

vi.stubGlobal("chrome", chromeMock);

const { getSettings, saveSettings } = await import("../common/storage.js");

describe("settings", () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) {
      delete store[key];
    }
    vi.clearAllMocks();
  });

  describe("default settings", () => {
    it("returns correct default values when nothing is stored", async () => {
      const settings = await getSettings();

      expect(settings.syncIntervalMinutes).toBe(24 * 60);
      expect(settings.enabledProviders).toEqual(["claude", "chatgpt"]);
      expect(settings.autoExport).toBeUndefined();
      // #120: syncWindowDays is left undefined by getSettings() itself (no
      // key backfilled) -- every consumer resolves it via
      // common/constants.ts's resolveSyncWindowDays() instead (NEVER a bare
      // `?? DEFAULT_SYNC_WINDOW_DAYS`, which would collapse an explicit
      // "All history" `null` into the default), so a pre-#120 stored
      // settings blob missing the key still gets the default applied at the
      // point of use rather than here.
      expect(settings.syncWindowDays).toBeUndefined();
    });
  });

  describe("sync window (#120)", () => {
    it("round-trips a saved syncWindowDays value", async () => {
      await saveSettings({
        syncIntervalMinutes: 1440,
        enabledProviders: ["claude"],
        syncWindowDays: 90,
      });

      const settings = await getSettings();
      expect(settings.syncWindowDays).toBe(90);
    });

    it("round-trips 'All history' (null)", async () => {
      await saveSettings({
        syncIntervalMinutes: 1440,
        enabledProviders: ["claude"],
        syncWindowDays: null,
      });

      const settings = await getSettings();
      expect(settings.syncWindowDays).toBeNull();
    });
  });

  describe("saving settings", () => {
    it("persists settings to chrome.storage", async () => {
      const settings = {
        syncIntervalMinutes: 360,
        enabledProviders: ["claude", "chatgpt", "grok"],
        autoExport: { enabled: true, filename: "my-export.json" },
      };

      await saveSettings(settings);

      expect(chromeMock.storage.local.set).toHaveBeenCalledWith({
        [STORAGE_KEYS.SETTINGS]: settings,
      });

      // Verify it's actually in the store
      const stored = store[STORAGE_KEYS.SETTINGS] as typeof settings;
      expect(stored.syncIntervalMinutes).toBe(360);
      expect(stored.enabledProviders).toContain("grok");
      expect(stored.autoExport?.enabled).toBe(true);
    });
  });

  describe("loading settings", () => {
    it("returns previously saved values", async () => {
      const saved = {
        syncIntervalMinutes: 720,
        enabledProviders: ["chatgpt"],
        autoExport: { enabled: false, filename: "custom.json" },
      };
      store[STORAGE_KEYS.SETTINGS] = saved;

      const settings = await getSettings();

      expect(settings.syncIntervalMinutes).toBe(720);
      expect(settings.enabledProviders).toEqual(["chatgpt"]);
      expect(settings.autoExport).toEqual({ enabled: false, filename: "custom.json" });
    });
  });

  describe("partial settings update", () => {
    it("merges partial updates with existing settings", async () => {
      // Save initial settings
      const initial = {
        syncIntervalMinutes: 360,
        enabledProviders: ["claude", "chatgpt"],
        autoExport: { enabled: false, filename: "membral/conversations.json" },
      };
      await saveSettings(initial);

      // Load, modify one field, save back (this is how the options page will work)
      const current = await getSettings();
      const updated = { ...current, syncIntervalMinutes: 2880 };
      await saveSettings(updated);

      // Verify the merge: interval changed, rest preserved
      const final = await getSettings();
      expect(final.syncIntervalMinutes).toBe(2880);
      expect(final.enabledProviders).toEqual(["claude", "chatgpt"]);
      expect(final.autoExport).toEqual({ enabled: false, filename: "membral/conversations.json" });
    });

    it("can update just autoExport without losing other fields", async () => {
      const initial = {
        syncIntervalMinutes: 720,
        enabledProviders: ["claude"],
      };
      await saveSettings(initial);

      const current = await getSettings();
      const updated = {
        ...current,
        autoExport: { enabled: true, filename: "export.json" },
      };
      await saveSettings(updated);

      const final = await getSettings();
      expect(final.syncIntervalMinutes).toBe(720);
      expect(final.enabledProviders).toEqual(["claude"]);
      expect(final.autoExport).toEqual({ enabled: true, filename: "export.json" });
    });
  });
});
