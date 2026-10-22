import type { Conversation } from "@membral/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../common/constants.js";

// Round-2 review MED 9: cloud-push.ts's quota-backoff storage key isn't
// part of STORAGE_KEYS (it's local to that module) — literal copy, kept in
// sync by the string value, not an import (no export exists for it and
// adding one purely for a test constant isn't worth the extra surface).
const QUOTA_BACKOFF_UNTIL_STORAGE_KEY = "membral_cloud_quota_backoff_until";

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
  runtime: {
    id: "test-extension-id",
  },
};

vi.stubGlobal("chrome", chromeMock);

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: {
      signInWithPassword: vi.fn(),
      signOut: vi.fn(),
      getSession: vi.fn(),
      refreshSession: vi.fn(),
      onAuthStateChange: vi.fn(() => ({
        data: { subscription: { unsubscribe: vi.fn() } },
      })),
    },
  })),
}));

const {
  pushToCloud,
  getCloudUrl,
  getCloudSyncStatus,
  setCloudSyncStatus,
  formatCloudSyncStatus,
  MAX_SYNC_BATCH_SIZE,
  QUOTA_BACKOFF_MS,
} = await import("../sync/cloud-push.js");

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: { get: (name: string) => headers[name] ?? null },
    json: async () => body,
  };
}

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    source: "claude",
    source_id: "conv-1",
    title: "Test conversation",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T01:00:00Z",
    messages: [],
    ...overrides,
  } as Conversation;
}

function mockManifestThenSync(syncResponse: unknown): void {
  mockFetch
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({ conversations: [] }),
    })
    .mockResolvedValueOnce(syncResponse);
}

describe("cloud-push", () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) {
      delete store[key];
    }
    vi.clearAllMocks();
    mockFetch.mockReset();
  });

  describe("pushToCloud", () => {
    it("returns { pushed: false } when not logged in", async () => {
      const result = await pushToCloud([makeConversation()]);

      expect(result.pushed).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("sends correct request to cloud API when logged in", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      mockManifestThenSync({
        ok: true,
        json: async () => ({ synced: 1, total: 1, errors: [], atLimit: false }),
      });

      const conversations = [makeConversation()];
      const result = await pushToCloud(conversations);

      expect(result.pushed).toBe(true);
      expect(result.synced).toBe(1);
      expect(result.atLimit).toBe(false);

      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [manifestUrl] = mockFetch.mock.calls[0] as [string];
      expect(manifestUrl).toContain("/api/conversations/manifest");
      const [syncUrl, syncOpts] = mockFetch.mock.calls[1] as [
        string,
        RequestInit & { headers: Record<string, string>; body: string },
      ];
      expect(syncUrl).toContain("/api/sync");
      expect(syncOpts.method).toBe("POST");

      const body = JSON.parse(syncOpts.body);
      expect(body.conversations).toHaveLength(1);
      expect(body.conversations[0].source_id).toBe("conv-1");
    });

    it("includes Authorization header with bearer token on sync call", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "my-secret-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      mockManifestThenSync({
        ok: true,
        json: async () => ({ synced: 1, total: 1, errors: [], atLimit: false }),
      });

      await pushToCloud([makeConversation()]);

      const [, syncOpts] = mockFetch.mock.calls[1] as [string, RequestInit & { headers: Record<string, string> }];
      expect(syncOpts.headers["Authorization"]).toBe("Bearer my-secret-jwt");
      expect(syncOpts.headers["Content-Type"]).toBe("application/json");
    });

    it("handles API error gracefully", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      const result = await pushToCloud([makeConversation()]);

      expect(result.pushed).toBe(false);
      expect(result.error).toContain("500");
    });

    it("handles network error gracefully", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      mockFetch.mockRejectedValue(new Error("Failed to fetch"));

      const result = await pushToCloud([makeConversation()]);

      expect(result.pushed).toBe(false);
      expect(result.error).toContain("Failed to fetch");
    });

    it("skips push when conversations array is empty", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      const result = await pushToCloud([]);

      expect(result.pushed).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("skips conversations already present in cloud manifest (dedup)", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      const cloudUpdatedAt = "2024-01-01T01:00:00Z";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversations: [{ source: "claude", source_id: "conv-1", updated_at: cloudUpdatedAt }],
        }),
      });

      const conv = makeConversation({ updated_at: cloudUpdatedAt });
      const result = await pushToCloud([conv]);

      expect(result.pushed).toBe(false);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("does not re-upload a conversation another device already pushed to the cloud (membral-4mr)", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      // This "device" has never pushed locally (no lastCloudPushAt cursor) — simulating
      // a second device/fresh install — but "device A" already synced conv-1 to the cloud.
      const cloudUpdatedAt = "2024-01-01T01:00:00Z";
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversations: [{ source: "claude", source_id: "conv-1", updated_at: cloudUpdatedAt }],
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ synced: 1, total: 1, atLimit: false }),
      });

      const alreadySynced = makeConversation({ source_id: "conv-1", updated_at: cloudUpdatedAt });
      const localOnly = makeConversation({ source_id: "conv-2", updated_at: "2024-06-01T00:00:00Z" });
      const result = await pushToCloud([alreadySynced, localOnly]);

      expect(result.pushed).toBe(true);
      const [, syncOpts] = mockFetch.mock.calls[1] as [string, RequestInit & { body: string }];
      const body = JSON.parse(syncOpts.body);
      expect(body.conversations.map((c: { source_id: string }) => c.source_id)).toEqual(["conv-2"]);
    });

    it("pushes conversation that is newer locally than in cloud", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          conversations: [{ source: "claude", source_id: "conv-1", updated_at: "2024-01-01T00:00:00Z" }],
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ synced: 1, atLimit: false }),
      });

      const conv = makeConversation({ updated_at: "2024-06-01T00:00:00Z" });
      const result = await pushToCloud([conv]);

      expect(result.pushed).toBe(true);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("sets CloudSyncStatus to synced on successful push", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      mockManifestThenSync({
        ok: true,
        json: async () => ({ synced: 3, atLimit: false }),
      });

      await pushToCloud([makeConversation()]);

      const status = await getCloudSyncStatus();
      expect(status.state).toBe("synced");
      expect(status.count).toBe(3);
    });

    it("re-attempts network-failed conversations on the next sync (membral-4mr)", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      const conv = makeConversation({ synced_at: "2024-01-01T00:00:00Z" });

      // First sync: network throws.
      mockManifestThenSync(Promise.reject(new Error("Failed to fetch")));
      const first = await pushToCloud([conv]);
      expect(first.pushed).toBe(false);

      // Second sync: succeeds. The same conversation must still be in the request body —
      // a network failure must never advance the local push cursor.
      mockFetch.mockReset();
      delete store[STORAGE_KEYS.CLOUD_MANIFEST];
      mockManifestThenSync({
        ok: true,
        json: async () => ({ synced: 1, total: 1, atLimit: false }),
      });
      const second = await pushToCloud([conv]);

      expect(second.pushed).toBe(true);
      const [, syncOpts] = mockFetch.mock.calls[1] as [string, RequestInit & { body: string }];
      const body = JSON.parse(syncOpts.body);
      expect(body.conversations).toHaveLength(1);
      expect(body.conversations[0].source_id).toBe(conv.source_id);
    });

    it("leaves the unsynced remainder queued after a partial (atLimit) push instead of dropping it (membral-4mr)", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      const convs = [
        makeConversation({ source_id: "conv-1", synced_at: "2024-01-01T00:00:00Z" }),
        makeConversation({ source_id: "conv-2", synced_at: "2024-01-01T00:00:01Z" }),
        makeConversation({ source_id: "conv-3", synced_at: "2024-01-01T00:00:02Z" }),
      ];

      // First sync: server reports plan-limit truncation — only 1 of 3 actually persisted.
      mockManifestThenSync({
        ok: true,
        json: async () => ({ synced: 1, total: 3, atLimit: true }),
      });
      const first = await pushToCloud(convs);
      expect(first.pushed).toBe(true);
      expect(first.atLimit).toBe(true);

      // Second sync (same local conversations, nothing new synced locally): the 2
      // conversations the server never confirmed must still be re-sent, not silently
      // dropped because the push cursor advanced past their synced_at.
      // Round-2 review MED 9: an atLimit push now sets a 1-hour retry backoff
      // (see QUOTA_BACKOFF_MS, and the dedicated backoff describe block
      // below for the immediate-retry-is-skipped case) so a
      // permanently-capped account doesn't resend the same doomed batch
      // every sync cycle — simulate that backoff having already expired
      // (an hour later) by clearing the stored marker directly.
      delete store[QUOTA_BACKOFF_UNTIL_STORAGE_KEY];
      mockFetch.mockReset();
      delete store[STORAGE_KEYS.CLOUD_MANIFEST];
      mockManifestThenSync({
        ok: true,
        json: async () => ({ synced: 2, total: 2, atLimit: false }),
      });
      const second = await pushToCloud(convs);

      expect(second.pushed).toBe(true);
      const [, syncOpts] = mockFetch.mock.calls[1] as [string, RequestInit & { body: string }];
      const body = JSON.parse(syncOpts.body);
      expect(body.conversations.map((c: { source_id: string }) => c.source_id).sort()).toEqual([
        "conv-1",
        "conv-2",
        "conv-3",
      ]);
    });

    it("sets CloudSyncStatus to error on API failure", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      mockManifestThenSync({
        ok: false,
        status: 502,
        statusText: "Bad Gateway",
      });

      await pushToCloud([makeConversation()]);

      const status = await getCloudSyncStatus();
      expect(status.state).toBe("error");
      expect(status.error).toContain("502");
    });
  });

  // ---- syncedProviderIds (goal 2026-07-26 step 2, MAJOR 2 fix; MINOR 4 — round-2 adversarial review) ----

  describe("pushToCloud — syncedProviderIds", () => {
    beforeEach(() => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    });

    it("posts to /api/sync with sources on a quiet successful cycle (zero new conversations) — the early-return does NOT skip the ping", async () => {
      mockManifestThenSync({
        ok: true,
        json: async () => ({ synced: 0, total: 0, errors: [] }),
      });

      const result = await pushToCloud([], ["claude"]);

      expect(mockFetch).toHaveBeenCalledTimes(2); // manifest fetch + the sync POST
      const syncCall = mockFetch.mock.calls[1];
      expect(syncCall[0]).toContain("/api/sync");
      const body = JSON.parse(syncCall[1].body);
      expect(body).toEqual({ conversations: [], sources: ["claude"] });
      expect(result.pushed).toBe(true);
    });

    it("still skips (no network call at all) when both conversations and syncedProviderIds are empty — old behavior preserved", async () => {
      const result = await pushToCloud([], []);

      expect(result.pushed).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("still skips when syncedProviderIds is omitted entirely (backward-compatible default)", async () => {
      const result = await pushToCloud([]);

      expect(result.pushed).toBe(false);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("includes sources alongside real new conversations in the same request", async () => {
      mockManifestThenSync({
        ok: true,
        json: async () => ({ synced: 1, total: 1, errors: [] }),
      });

      await pushToCloud([makeConversation()], ["claude", "chatgpt"]);

      const syncCall = mockFetch.mock.calls[1];
      const body = JSON.parse(syncCall[1].body);
      expect(body.sources).toEqual(["claude", "chatgpt"]);
      expect(body.conversations).toHaveLength(1);
    });

    it("forwards exactly the array it's given — filtering out a failed provider is the CALLER's job (background.ts), not pushToCloud's", async () => {
      mockManifestThenSync({
        ok: true,
        json: async () => ({ synced: 0, total: 0, errors: [] }),
      });

      // background.ts is responsible for excluding a failed provider BEFORE
      // calling pushToCloud (see background.test.ts) — this just confirms
      // pushToCloud itself doesn't re-derive or second-guess the list.
      await pushToCloud([], ["claude"]);

      const syncCall = mockFetch.mock.calls[1];
      const body = JSON.parse(syncCall[1].body);
      expect(body.sources).toEqual(["claude"]);
    });
  });

  describe("getCloudSyncStatus / setCloudSyncStatus", () => {
    it("returns idle state when nothing stored", async () => {
      const status = await getCloudSyncStatus();
      expect(status.state).toBe("idle");
    });

    it("persists and retrieves status", async () => {
      await setCloudSyncStatus({ state: "synced", count: 5, at: "2024-01-01T00:00:00Z" });
      const status = await getCloudSyncStatus();
      expect(status.state).toBe("synced");
      expect(status.count).toBe(5);
    });

    it("persists error status with message", async () => {
      await setCloudSyncStatus({ state: "error", error: "Connection refused", at: "2024-01-01T00:00:00Z" });
      const status = await getCloudSyncStatus();
      expect(status.state).toBe("error");
      expect(status.error).toBe("Connection refused");
    });
  });

  describe("formatCloudSyncStatus (membral-4mr — popup n/N display)", () => {
    it("shows a plain synced count when the full batch was accepted", () => {
      const { text, color } = formatCloudSyncStatus({ state: "synced", count: 5, atLimit: false });
      expect(text).toBe("Synced 5 to cloud");
      expect(color).toBe("#4ade80");
    });

    it("shows n/N plus a plan-limit note when atLimit is true", () => {
      const { text, color } = formatCloudSyncStatus({ state: "synced", count: 5, total: 50, atLimit: true });
      expect(text).toBe("Synced 5/50 (plan limit / rate limited)");
      expect(color).toBe("#fbbf24");
    });
  });

  describe("getCloudUrl", () => {
    it("returns default URL when no override is set", async () => {
      const url = await getCloudUrl();
      expect(url).toBeTruthy();
      expect(typeof url).toBe("string");
    });

    it("returns stored URL when override is set", async () => {
      store[STORAGE_KEYS.CLOUD_URL] = "https://custom.example.com";
      const url = await getCloudUrl();
      expect(url).toBe("https://custom.example.com");
    });
  });

  // ---- Issue #127: MAX_SYNC_BATCH_SIZE batching, 429 backoff, 402 quota ----

  describe("batching (issue #127 — server enforces a per-request conversations[] cap)", () => {
    beforeEach(() => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    });

    it("splits a push larger than MAX_SYNC_BATCH_SIZE into multiple sequential POSTs, sources only on the last", async () => {
      const many = Array.from({ length: MAX_SYNC_BATCH_SIZE + 1 }, (_, i) =>
        makeConversation({ source_id: `conv-${i}` }),
      );

      mockFetch
        .mockResolvedValueOnce(jsonResponse(200, { conversations: [] })) // manifest
        .mockResolvedValueOnce(jsonResponse(200, { synced: MAX_SYNC_BATCH_SIZE, total: MAX_SYNC_BATCH_SIZE }))
        .mockResolvedValueOnce(jsonResponse(200, { synced: 1, total: 1 }));

      const result = await pushToCloud(many, ["claude"]);

      expect(mockFetch).toHaveBeenCalledTimes(3); // manifest + 2 sync batches
      const firstBatchBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      const secondBatchBody = JSON.parse(mockFetch.mock.calls[2][1].body);
      expect(firstBatchBody.conversations).toHaveLength(MAX_SYNC_BATCH_SIZE);
      expect(secondBatchBody.conversations).toHaveLength(1);
      // sources only on the last batch — no reason to repeat it.
      expect(firstBatchBody.sources).toEqual([]);
      expect(secondBatchBody.sources).toEqual(["claude"]);

      expect(result.pushed).toBe(true);
      expect(result.synced).toBe(MAX_SYNC_BATCH_SIZE + 1);
      expect(result.total).toBe(MAX_SYNC_BATCH_SIZE + 1);
      expect(result.atLimit).toBe(false);
    });

    it("stops sending further batches once one reports atLimit, and never advances the cursor", async () => {
      const many = Array.from({ length: MAX_SYNC_BATCH_SIZE + 1 }, (_, i) =>
        makeConversation({ source_id: `conv-${i}`, synced_at: "2024-01-01T00:00:00Z" }),
      );

      mockFetch
        .mockResolvedValueOnce(jsonResponse(200, { conversations: [] })) // manifest
        .mockResolvedValueOnce(jsonResponse(200, { synced: 10, total: MAX_SYNC_BATCH_SIZE, atLimit: true }));

      const result = await pushToCloud(many, ["claude"]);

      // Only ONE sync batch was sent — the second never fires once the
      // first comes back atLimit.
      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result.pushed).toBe(true);
      expect(result.synced).toBe(10);
      expect(result.atLimit).toBe(true);

      // Cursor didn't advance: re-running with the same corpus resends
      // everything (no delta filtering kicked in) — but round-2 review
      // MED 9's backoff means that resend doesn't happen until
      // QUOTA_BACKOFF_MS later (see the dedicated backoff describe block
      // below for the immediate-retry-is-skipped case); simulate it having
      // already expired.
      delete store[QUOTA_BACKOFF_UNTIL_STORAGE_KEY];
      mockFetch.mockReset();
      delete store[STORAGE_KEYS.CLOUD_MANIFEST];
      mockFetch
        .mockResolvedValueOnce(jsonResponse(200, { conversations: [] }))
        .mockResolvedValueOnce(jsonResponse(200, { synced: MAX_SYNC_BATCH_SIZE, total: MAX_SYNC_BATCH_SIZE }))
        .mockResolvedValueOnce(jsonResponse(200, { synced: 1, total: 1 }));
      await pushToCloud(many, ["claude"]);
      const resentBody = JSON.parse(mockFetch.mock.calls[1][1].body);
      expect(resentBody.conversations).toHaveLength(MAX_SYNC_BATCH_SIZE);
    });
  });

  describe("round-2 review MED 9: quota backoff — a permanently over-quota account doesn't resend every cycle", () => {
    beforeEach(() => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    });

    it("skips the sync cycle entirely (no network call at all) while backed off from a recent quota rejection", async () => {
      const convs = [makeConversation({ source_id: "conv-1", synced_at: "2024-01-01T00:00:00Z" })];

      mockManifestThenSync({
        ok: true,
        json: async () => ({ synced: 0, total: 1, atLimit: false, error: "conversation_limit" }),
        status: 402,
      });
      const first = await pushToCloud(convs);
      expect(first.atLimit).toBe(true);

      // The stored marker is roughly now + QUOTA_BACKOFF_MS (1 hour), not
      // some arbitrary/short value.
      const storedUntil = new Date(store[QUOTA_BACKOFF_UNTIL_STORAGE_KEY] as string).getTime();
      expect(storedUntil).toBeGreaterThan(Date.now() + QUOTA_BACKOFF_MS - 5000);
      expect(storedUntil).toBeLessThanOrEqual(Date.now() + QUOTA_BACKOFF_MS + 5000);

      // Immediately re-run (same "cycle a few minutes later" the extension's
      // own SYNC_INTERVAL_MINUTES would trigger) — must be a pure no-op:
      // zero network calls, not even the manifest fetch.
      mockFetch.mockReset();
      const second = await pushToCloud(convs);
      expect(mockFetch).not.toHaveBeenCalled();
      expect(second.pushed).toBe(false);
      expect(second.atLimit).toBe(true);
    });

    it("clears the backoff and retries normally once it has expired", async () => {
      const convs = [makeConversation({ source_id: "conv-1", synced_at: "2024-01-01T00:00:00Z" })];

      mockManifestThenSync({
        ok: true,
        json: async () => ({ synced: 0, total: 1, atLimit: false, error: "conversation_limit" }),
        status: 402,
      });
      await pushToCloud(convs);

      // Simulate the 1-hour backoff having already expired.
      delete store[QUOTA_BACKOFF_UNTIL_STORAGE_KEY];
      mockFetch.mockReset();
      delete store[STORAGE_KEYS.CLOUD_MANIFEST];
      mockManifestThenSync({ ok: true, json: async () => ({ synced: 1, total: 1, atLimit: false }) });
      const second = await pushToCloud(convs);

      expect(mockFetch).toHaveBeenCalled();
      expect(second.pushed).toBe(true);
      expect(second.atLimit).toBe(false);
    });

    it("expires the backoff naturally after QUOTA_BACKOFF_MS via a stale-but-still-present marker", async () => {
      // Directly seed an EXPIRED marker (rather than a happy-path "already
      // cleared" one) to prove getQuotaBackoffUntil() treats a past
      // timestamp as expired, not just a missing key.
      store[QUOTA_BACKOFF_UNTIL_STORAGE_KEY] = new Date(Date.now() - 1000).toISOString();
      mockManifestThenSync({ ok: true, json: async () => ({ synced: 1, total: 1, atLimit: false }) });

      const result = await pushToCloud([makeConversation({ source_id: "conv-1" })]);

      expect(mockFetch).toHaveBeenCalled();
      expect(result.pushed).toBe(true);
    });
  });

  describe("429 retry (issue #127 — CLAUDE.md rate-limit conventions)", () => {
    beforeEach(() => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    });

    it("waits at least as long as the server's Retry-After header, then retries and succeeds", async () => {
      vi.useFakeTimers();
      try {
        mockFetch
          .mockResolvedValueOnce(jsonResponse(200, { conversations: [] })) // manifest
          .mockResolvedValueOnce(jsonResponse(429, {}, { "Retry-After": "3" }))
          .mockResolvedValueOnce(jsonResponse(200, { synced: 1, total: 1 }));

        const pending = pushToCloud([makeConversation()]);
        // Let the manifest fetch + first (429) sync attempt resolve.
        await vi.advanceTimersByTimeAsync(0);
        // Must not have retried before at least the 3s Retry-After elapsed.
        expect(mockFetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(3000);

        const result = await pending;
        expect(mockFetch).toHaveBeenCalledTimes(3);
        expect(result.pushed).toBe(true);
        expect(result.synced).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("402 conversation_limit (issue #127)", () => {
    beforeEach(() => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt",
        refreshToken: "test-refresh",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };
    });

    it("surfaces a specific, friendly message (not '402 Payment Required') and does not advance the cursor", async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResponse(200, { conversations: [] })) // manifest
        .mockResolvedValueOnce(jsonResponse(402, { error: "conversation_limit", limit: 100, count: 100 }));

      const result = await pushToCloud([makeConversation()]);

      expect(result.pushed).toBe(false);
      expect(result.atLimit).toBe(true);
      expect(result.error).toContain("100/100");
      expect(result.error).not.toContain("402");

      const status = await getCloudSyncStatus();
      expect(status.state).toBe("error");
      expect(status.error).toContain("100/100");
    });
  });
});
