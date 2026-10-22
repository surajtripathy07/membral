import { beforeEach, describe, expect, it, vi } from "vitest";
import { PROVIDERS, STORAGE_KEYS } from "../common/constants.js";

// Mock chrome.storage.local
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
        for (const k of keyList) delete store[k];
      }),
    },
  },
};

vi.stubGlobal("chrome", chromeMock);

// Import after mocking chrome
const {
  getSyncState,
  saveConversation,
  getConversations,
  saveConversationsBatch,
  getConversationCountByProvider,
  getKnownUpdatedAtByProvider,
  getSettings,
  updateProviderSyncState,
} = await import("../common/storage.js");

describe("storage", () => {
  beforeEach(() => {
    // Clear store before each test
    for (const key of Object.keys(store)) {
      delete store[key];
    }
    vi.clearAllMocks();
  });

  describe("getSyncState", () => {
    it("returns default state when storage is empty", async () => {
      const state = await getSyncState();

      expect(state).toHaveProperty("providers");
      expect(state).toHaveProperty("lastFullSyncAt", null);

      // Should have an entry for each provider
      for (const id of Object.keys(PROVIDERS)) {
        expect(state.providers[id]).toEqual({
          lastSyncAt: null,
          lastSyncStatus: "never",
          lastError: null,
          conversationCount: 0,
        });
      }
    });

    it("returns stored state when present", async () => {
      const existingState = {
        providers: {
          claude: {
            lastSyncAt: "2025-01-01T00:00:00.000Z",
            lastSyncStatus: "success",
            lastError: null,
            conversationCount: 42,
          },
        },
        lastFullSyncAt: "2025-01-01T00:00:00.000Z",
      };
      store[STORAGE_KEYS.SYNC_STATE] = existingState;

      const state = await getSyncState();
      expect(state).toEqual(existingState);
    });
  });

  describe("saveConversation", () => {
    it("stores a conversation keyed by source:source_id", async () => {
      const conversation = {
        id: "claude:abc-123",
        source: "claude",
        source_id: "abc-123",
        title: "Test conversation",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
        model: "claude-3",
        messages: [],
        metadata: {},
        synced_at: "2025-01-01T00:00:00.000Z",
      };

      await saveConversation(conversation);

      const conversations = await getConversations();
      expect(conversations["claude:abc-123"]).toEqual(conversation);
    });

    it("overwrites existing conversation with same key", async () => {
      const v1 = {
        id: "claude:abc-123",
        source: "claude",
        source_id: "abc-123",
        title: "Version 1",
        created_at: "2025-01-01T00:00:00.000Z",
        updated_at: "2025-01-01T00:00:00.000Z",
        model: null,
        messages: [],
        metadata: {},
        synced_at: "2025-01-01T00:00:00.000Z",
      };
      const v2 = { ...v1, title: "Version 2" };

      await saveConversation(v1);
      await saveConversation(v2);

      const conversations = await getConversations();
      expect(conversations["claude:abc-123"].title).toBe("Version 2");
    });
  });

  describe("saveConversationsBatch", () => {
    it("stores multiple conversations at once", async () => {
      const convos = [
        {
          id: "claude:1",
          source: "claude",
          source_id: "1",
          title: "First",
          created_at: null,
          updated_at: null,
          model: null,
          messages: [],
          metadata: {},
          synced_at: "2025-01-01T00:00:00.000Z",
        },
        {
          id: "chatgpt:2",
          source: "chatgpt",
          source_id: "2",
          title: "Second",
          created_at: null,
          updated_at: null,
          model: null,
          messages: [],
          metadata: {},
          synced_at: "2025-01-01T00:00:00.000Z",
        },
      ];

      await saveConversationsBatch(convos);

      const conversations = await getConversations();
      expect(Object.keys(conversations)).toHaveLength(2);
      expect(conversations["claude:1"].title).toBe("First");
      expect(conversations["chatgpt:2"].title).toBe("Second");
    });
  });

  describe("getConversationCountByProvider", () => {
    it("counts conversations for a specific provider", async () => {
      // Use the new per-key storage format
      await saveConversationsBatch([
        {
          id: "claude:1",
          source: "claude",
          source_id: "1",
          title: "A",
          created_at: null,
          updated_at: null,
          model: null,
          messages: [],
          metadata: {},
          synced_at: "2025-01-01T00:00:00.000Z",
        },
        {
          id: "claude:2",
          source: "claude",
          source_id: "2",
          title: "B",
          created_at: null,
          updated_at: null,
          model: null,
          messages: [],
          metadata: {},
          synced_at: "2025-01-01T00:00:00.000Z",
        },
        {
          id: "chatgpt:1",
          source: "chatgpt",
          source_id: "1",
          title: "C",
          created_at: null,
          updated_at: null,
          model: null,
          messages: [],
          metadata: {},
          synced_at: "2025-01-01T00:00:00.000Z",
        },
      ]);

      expect(await getConversationCountByProvider("claude")).toBe(2);
      expect(await getConversationCountByProvider("chatgpt")).toBe(1);
      expect(await getConversationCountByProvider("grok")).toBe(0);
    });
  });

  describe("getSettings", () => {
    it("returns defaults when no settings stored", async () => {
      const settings = await getSettings();
      expect(settings).toEqual({
        syncIntervalMinutes: 24 * 60,
        enabledProviders: ["claude", "chatgpt"],
      });
    });
  });

  describe("getKnownUpdatedAtByProvider (M2 fix)", () => {
    it("returns a provider-scoped updated_at map built from saveConversationsBatch's maintained index", async () => {
      await saveConversationsBatch([
        {
          id: "claude:1",
          source: "claude",
          source_id: "1",
          title: "A",
          created_at: null,
          updated_at: "2025-01-01T00:00:00.000Z",
          model: null,
          messages: [],
          metadata: {},
          synced_at: "2025-01-01T00:00:00.000Z",
        },
        {
          id: "chatgpt:1",
          source: "chatgpt",
          source_id: "1",
          title: "B",
          created_at: null,
          updated_at: "2025-02-01T00:00:00.000Z",
          model: null,
          messages: [],
          metadata: {},
          synced_at: "2025-01-01T00:00:00.000Z",
        },
      ]);

      const known = await getKnownUpdatedAtByProvider("claude");
      expect([...known.entries()]).toEqual([["1", "2025-01-01T00:00:00.000Z"]]);
    });

    it("lazily builds the index once from the full corpus for pre-existing data written without it (migration path), then persists it so subsequent reads don't need to rebuild", async () => {
      // Simulate a pre-existing install: conversation + conv index written
      // directly, bypassing saveConversationsBatch entirely -- the
      // lightweight updated_at index this test targets was never populated.
      store["conv:claude:legacy"] = {
        id: "claude:legacy",
        source: "claude",
        source_id: "legacy",
        title: "Legacy",
        created_at: null,
        updated_at: "2024-12-01T00:00:00.000Z",
        model: null,
        messages: [],
        metadata: {},
        synced_at: "2024-12-01T00:00:00.000Z",
      };
      store.membral_conv_index = ["claude:legacy"];
      expect(store.membral_updated_at_index).toBeUndefined();

      const known = await getKnownUpdatedAtByProvider("claude");
      expect(known.get("legacy")).toBe("2024-12-01T00:00:00.000Z");

      // The migration persisted the index -- a subsequent call has it ready
      // without needing to re-materialize the full corpus.
      expect(store.membral_updated_at_index).toEqual({ "claude:legacy": "2024-12-01T00:00:00.000Z" });
    });

    it("round-2 follow-up fix: rebuilds when the index exists but is PARTIAL (legacy install whose first incremental write bypassed the normal producers), instead of sealing the gap forever", async () => {
      // Two conversations exist in the full corpus + conv index, but only
      // one made it into the updated_at index -- simulating a legacy corpus
      // whose first write after upgrade went through a path (forceFull
      // re-scrape / JSON import) that wrote the conv index/blob directly
      // without going through saveConversation(s)Batch's index maintenance.
      store["conv:claude:old"] = {
        id: "claude:old",
        source: "claude",
        source_id: "old",
        title: "Old",
        created_at: null,
        updated_at: "2024-01-01T00:00:00.000Z",
        model: null,
        messages: [],
        metadata: {},
        synced_at: "2024-01-01T00:00:00.000Z",
      };
      store["conv:claude:new"] = {
        id: "claude:new",
        source: "claude",
        source_id: "new",
        title: "New",
        created_at: null,
        updated_at: "2024-06-01T00:00:00.000Z",
        model: null,
        messages: [],
        metadata: {},
        synced_at: "2024-06-01T00:00:00.000Z",
      };
      store.membral_conv_index = ["claude:old", "claude:new"];
      // The updated_at index only knows about "new" -- it's PRESENT but
      // incomplete relative to the conv index, which is exactly the state
      // an existence-only check would have wrongly accepted as "done".
      store.membral_updated_at_index = { "claude:new": "2024-06-01T00:00:00.000Z" };

      const known = await getKnownUpdatedAtByProvider("claude");

      expect(known.get("old")).toBe("2024-01-01T00:00:00.000Z");
      expect(known.get("new")).toBe("2024-06-01T00:00:00.000Z");
      // Persisted the completed/merged index so the next read doesn't need
      // to rebuild again.
      expect(store.membral_updated_at_index).toEqual({
        "claude:old": "2024-01-01T00:00:00.000Z",
        "claude:new": "2024-06-01T00:00:00.000Z",
      });
    });
  });

  describe("updateProviderSyncState (M1 fix)", () => {
    it("does not let an explicit `undefined` field wipe an existing stored value", async () => {
      store[STORAGE_KEYS.SYNC_STATE] = {
        providers: {
          claude: {
            lastSyncAt: "2025-01-01T00:00:00.000Z",
            lastSyncStatus: "error",
            lastError: null,
            conversationCount: 3,
            failedIds: ["a", "b"],
          },
        },
        lastFullSyncAt: null,
      };

      await updateProviderSyncState("claude", { lastSyncStatus: "cancelled", failedIds: undefined });

      const state = await getSyncState();
      expect(state.providers.claude.failedIds).toEqual(["a", "b"]);
      expect(state.providers.claude.lastSyncStatus).toBe("cancelled");
    });

    it("still clears a field when explicitly passed `null`", async () => {
      store[STORAGE_KEYS.SYNC_STATE] = {
        providers: {
          claude: {
            lastSyncAt: "2025-01-01T00:00:00.000Z",
            lastSyncStatus: "success",
            lastError: null,
            conversationCount: 3,
            failedIds: ["a", "b"],
          },
        },
        lastFullSyncAt: null,
      };

      await updateProviderSyncState("claude", { failedIds: null });

      const state = await getSyncState();
      expect(state.providers.claude.failedIds).toBeNull();
    });
  });
});
