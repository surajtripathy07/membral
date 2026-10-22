import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../common/constants.js";

// In-memory chrome.storage mock
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
  runtime: { id: "test-extension-id" },
};

vi.stubGlobal("chrome", chromeMock);

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const { fetchCloudManifest, getCloudIdMap } = await import("../sync/cloud-manifest.js");

describe("cloud-manifest", () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) delete store[key];
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe("fetchCloudManifest", () => {
    it("fetches and returns manifest entries", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversations: [
            { source: "claude", source_id: "abc", updated_at: "2024-01-01T00:00:00Z" },
            { source: "chatgpt", source_id: "xyz", updated_at: "2024-01-02T00:00:00Z" },
          ],
        }),
      });

      const entries = await fetchCloudManifest("test-token", "http://localhost:3000");

      expect(entries).toHaveLength(2);
      expect(entries[0]).toEqual({
        source: "claude",
        source_id: "abc",
        updated_at: "2024-01-01T00:00:00Z",
      });
      expect(entries[1]).toEqual({
        source: "chatgpt",
        source_id: "xyz",
        updated_at: "2024-01-02T00:00:00Z",
      });
    });

    it("includes Authorization Bearer header", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ conversations: [] }),
      });

      await fetchCloudManifest("my-secret", "http://localhost:3000");

      const [url, options] = mockFetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
      expect(url).toContain("/api/conversations/manifest");
      expect(options.headers["Authorization"]).toBe("Bearer my-secret");
    });

    it("uses GET method", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ conversations: [] }),
      });

      await fetchCloudManifest("tok", "http://localhost:3000");

      const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(options.method).toBe("GET");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
      });

      await expect(fetchCloudManifest("bad-token", "http://localhost:3000")).rejects.toThrow(
        "Manifest fetch failed: 401",
      );
    });

    it("returns empty array when conversations field is missing", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({}),
      });

      const entries = await fetchCloudManifest("tok", "http://localhost:3000");
      expect(entries).toEqual([]);
    });
  });

  describe("getCloudIdMap", () => {
    it("returns empty map when accessToken is null", async () => {
      const map = await getCloudIdMap(0, null, "http://localhost:3000");
      expect(map.size).toBe(0);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("fetches manifest and returns id map keyed source:source_id", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversations: [
            { source: "claude", source_id: "id1", updated_at: "2024-01-01T00:00:00Z" },
            { source: "chatgpt", source_id: "id2", updated_at: "2024-01-02T00:00:00Z" },
          ],
        }),
      });

      const map = await getCloudIdMap(0, "test-token", "http://localhost:3000");

      expect(map.size).toBe(2);
      expect(map.get("claude:id1")).toBe("2024-01-01T00:00:00Z");
      expect(map.get("chatgpt:id2")).toBe("2024-01-02T00:00:00Z");
    });

    it("uses cache when TTL has not expired and localConvCount > 0", async () => {
      store[STORAGE_KEYS.CLOUD_MANIFEST] = {
        conversations: [{ source: "claude", source_id: "cached-id", updated_at: "2024-01-01T00:00:00Z" }],
        fetchedAt: new Date(Date.now() - 30_000).toISOString(), // 30 s ago (well within the 60 s TTL)
      };

      const map = await getCloudIdMap(5, "test-token", "http://localhost:3000");

      expect(map.size).toBe(1);
      expect(map.get("claude:cached-id")).toBe("2024-01-01T00:00:00Z");
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("force-refetches when localConvCount === 0 (fresh install)", async () => {
      // Cache within TTL, but localConvCount=0 forces a refetch
      store[STORAGE_KEYS.CLOUD_MANIFEST] = {
        conversations: [{ source: "claude", source_id: "old", updated_at: "2024-01-01T00:00:00Z" }],
        fetchedAt: new Date(Date.now() - 30_000).toISOString(),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversations: [{ source: "claude", source_id: "fresh", updated_at: "2024-06-01T00:00:00Z" }],
        }),
      });

      const map = await getCloudIdMap(0, "test-token", "http://localhost:3000");

      expect(map.size).toBe(1);
      expect(map.get("claude:fresh")).toBe("2024-06-01T00:00:00Z");
      expect(map.has("claude:old")).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("refetches when cache is expired (past 5-min TTL)", async () => {
      store[STORAGE_KEYS.CLOUD_MANIFEST] = {
        conversations: [{ source: "claude", source_id: "old", updated_at: "2024-01-01T00:00:00Z" }],
        fetchedAt: new Date(Date.now() - 10 * 60_000).toISOString(), // 10 min ago > 5-min TTL
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversations: [{ source: "claude", source_id: "new-entry", updated_at: "2024-06-01T00:00:00Z" }],
        }),
      });

      const map = await getCloudIdMap(5, "test-token", "http://localhost:3000");

      expect(map.has("claude:new-entry")).toBe(true);
      expect(map.has("claude:old")).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("falls back to stale cache on fetch error", async () => {
      store[STORAGE_KEYS.CLOUD_MANIFEST] = {
        conversations: [{ source: "claude", source_id: "stale", updated_at: "2024-01-01T00:00:00Z" }],
        fetchedAt: new Date(0).toISOString(), // Very old = expired
      };

      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const map = await getCloudIdMap(5, "test-token", "http://localhost:3000");

      expect(map.size).toBe(1);
      expect(map.get("claude:stale")).toBe("2024-01-01T00:00:00Z");
    });

    it("returns empty map when fetch fails and no cache", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const map = await getCloudIdMap(5, "test-token", "http://localhost:3000");

      expect(map.size).toBe(0);
    });

    it("caches fetched manifest to chrome.storage", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversations: [{ source: "claude", source_id: "id1", updated_at: "2024-01-01T00:00:00Z" }],
        }),
      });

      await getCloudIdMap(0, "test-token", "http://localhost:3000");

      const stored = store[STORAGE_KEYS.CLOUD_MANIFEST] as {
        conversations: unknown[];
        fetchedAt: string;
      };
      expect(stored).toBeDefined();
      expect(stored.conversations).toHaveLength(1);
      expect(stored.fetchedAt).toBeDefined();
    });
  });
});
