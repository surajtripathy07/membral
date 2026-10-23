import type { Conversation } from "@membral/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEYS } from "../common/constants.js";

const store: Record<string, unknown> = {};

vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: vi.fn(async (keys: string | string[]) => {
        const out: Record<string, unknown> = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) if (k in store) out[k] = store[k];
        return out;
      }),
      set: vi.fn(async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      }),
      remove: vi.fn(async (keys: string | string[]) => {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete store[k];
      }),
    },
  },
  runtime: { id: "test-extension-id" },
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const createClient = vi.fn(() => ({
  auth: { signInWithPassword: vi.fn(), signOut: vi.fn(async () => ({})), getSession: vi.fn(), refreshSession: vi.fn() },
}));
vi.mock("@supabase/supabase-js", () => ({ createClient }));

const { getAuthState, getAccessToken, setApiKey, clearApiKey, getApiKey, isValidApiKeyFormat, logout } = await import(
  "../auth/auth.js"
);
const { pushToCloud, API_KEY_REJECTED_MESSAGE, getCloudSyncStatus } = await import("../sync/cloud-push.js");
const { fetchCloudManifest } = await import("../sync/cloud-manifest.js");

const KEY = "lls_0123456789abcdef0123456789abcdef";

function conv(): Conversation {
  return {
    source: "claude",
    source_id: "conv-1",
    title: "t",
    created_at: "2024-01-01T00:00:00Z",
    updated_at: "2024-01-01T01:00:00Z",
    messages: [],
  } as unknown as Conversation;
}

function res(status: number, body: unknown = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    headers: { get: () => null },
    json: async () => body,
  };
}

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  vi.clearAllMocks();
  mockFetch.mockReset();
});

describe("API key storage", () => {
  it("accepts lls_ keys and rejects anything else", () => {
    expect(isValidApiKeyFormat(KEY)).toBe(true);
    expect(isValidApiKeyFormat("sk-ant-123456789")).toBe(false);
    expect(isValidApiKeyFormat("lls_")).toBe(false);
    expect(isValidApiKeyFormat("lls_has space inside")).toBe(false);
  });

  it("stores the trimmed key under STORAGE_KEYS.API_KEY and clears it", async () => {
    await setApiKey(`  ${KEY}\n`);
    expect(store[STORAGE_KEYS.API_KEY]).toBe(KEY);
    expect(await getApiKey()).toBe(KEY);
    await clearApiKey();
    expect(await getApiKey()).toBeNull();
  });

  it("refuses to store a malformed key", async () => {
    await expect(setApiKey("not-a-key")).rejects.toThrow(/lls_/);
    expect(STORAGE_KEYS.API_KEY in store).toBe(false);
  });
});

describe("auth state with an API key", () => {
  it("is logged in with kind api-key and the key as the token, never touching Supabase", async () => {
    store[STORAGE_KEYS.API_KEY] = KEY;
    expect(await getAuthState()).toEqual({ isLoggedIn: true, accessToken: KEY, kind: "api-key" });
    expect(await getAccessToken()).toBe(KEY);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("wins over a stored Supabase session", async () => {
    store[STORAGE_KEYS.API_KEY] = KEY;
    store[STORAGE_KEYS.AUTH_STATE] = {
      accessToken: "jwt",
      refreshToken: "r",
      email: "a@b.c",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    expect((await getAccessToken()) ?? "").toBe(KEY);
  });

  it("without a key, a Supabase session is still reported as kind password", async () => {
    store[STORAGE_KEYS.AUTH_STATE] = {
      accessToken: "jwt",
      refreshToken: "r",
      email: "a@b.c",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    expect(await getAuthState()).toMatchObject({ isLoggedIn: true, kind: "password", accessToken: "jwt" });
  });

  it("logout does not remove a stored API key (the options page and popup Disconnect do)", async () => {
    store[STORAGE_KEYS.API_KEY] = KEY;
    await logout();
    expect(store[STORAGE_KEYS.API_KEY]).toBe(KEY);
  });
});

describe("cloud sync with an API key", () => {
  it("sends Authorization: Bearer <key> on the manifest call and the sync call", async () => {
    store[STORAGE_KEYS.API_KEY] = KEY;
    mockFetch.mockResolvedValueOnce(res(200, { conversations: [] })).mockResolvedValueOnce(res(200, { synced: 1 }));

    const result = await pushToCloud([conv()]);

    expect(result.pushed).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    for (const call of mockFetch.mock.calls) {
      const [, opts] = call as [string, { headers: Record<string, string> }];
      expect(opts.headers.Authorization).toBe(`Bearer ${KEY}`);
    }
    expect(createClient).not.toHaveBeenCalled();
  });

  it("a 401 with a stored key reports 'API key rejected' once and does not retry", async () => {
    store[STORAGE_KEYS.API_KEY] = KEY;
    mockFetch.mockResolvedValueOnce(res(200, { conversations: [] })).mockResolvedValueOnce(res(401));

    const result = await pushToCloud([conv()]);

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(result.error).toBe(API_KEY_REJECTED_MESSAGE);
    expect(result.error).toContain("API key rejected");
    expect((await getCloudSyncStatus()).state).toBe("error");
  });

  it("a 401 without an API key keeps the generic failure message", async () => {
    store[STORAGE_KEYS.AUTH_STATE] = {
      accessToken: "jwt",
      refreshToken: "r",
      email: "a@b.c",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };
    mockFetch.mockResolvedValueOnce(res(200, { conversations: [] })).mockResolvedValueOnce(res(401));

    const result = await pushToCloud([conv()]);

    expect(result.error).toContain("401");
    expect(result.error).not.toContain("API key");
  });

  it("fetchCloudManifest sends whatever token it is given as a bearer header", async () => {
    mockFetch.mockResolvedValueOnce(res(200, { conversations: [] }));
    await fetchCloudManifest(KEY, "http://localhost:3000");
    const [url, opts] = mockFetch.mock.calls[0] as [string, { headers: Record<string, string> }];
    expect(url).toBe("http://localhost:3000/api/conversations/manifest");
    expect(opts.headers.Authorization).toBe(`Bearer ${KEY}`);
  });
});
