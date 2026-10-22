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
  runtime: {
    id: "test-extension-id",
  },
};

vi.stubGlobal("chrome", chromeMock);

// Mock @supabase/supabase-js before importing auth module
const mockSignInWithPassword = vi.fn();
const mockSignOut = vi.fn();
const mockGetSession = vi.fn();
const mockRefreshSession = vi.fn();
const mockOnAuthStateChange = vi.fn(() => ({
  data: { subscription: { unsubscribe: vi.fn() } },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    auth: {
      signInWithPassword: mockSignInWithPassword,
      signOut: mockSignOut,
      getSession: mockGetSession,
      refreshSession: mockRefreshSession,
      onAuthStateChange: mockOnAuthStateChange,
    },
  })),
}));

const { getAuthState, login, logout, getAccessToken, getSupabaseClient } = await import("../auth/auth.js");

describe("auth", () => {
  beforeEach(() => {
    for (const key of Object.keys(store)) {
      delete store[key];
    }
    vi.clearAllMocks();
  });

  describe("getAuthState", () => {
    it("returns logged out when no auth data stored", async () => {
      const state = await getAuthState();

      expect(state.isLoggedIn).toBe(false);
      expect(state.email).toBeUndefined();
      expect(state.accessToken).toBeUndefined();
    });

    it("returns logged in when valid auth data exists", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "test-jwt-token",
        refreshToken: "test-refresh-token",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
      };

      const state = await getAuthState();

      expect(state.isLoggedIn).toBe(true);
      expect(state.email).toBe("user@example.com");
      expect(state.accessToken).toBe("test-jwt-token");
    });

    it("returns logged out when token is expired", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "expired-token",
        refreshToken: "test-refresh-token",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) - 60, // Expired 1 minute ago
      };

      const state = await getAuthState();

      expect(state.isLoggedIn).toBe(false);
    });
  });

  describe("login", () => {
    it("stores auth data on successful login", async () => {
      const expiresAt = Math.floor(Date.now() / 1000) + 3600;
      mockSignInWithPassword.mockResolvedValue({
        data: {
          session: {
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_at: expiresAt,
            user: { email: "login@example.com" },
          },
        },
        error: null,
      });

      await login("login@example.com", "password123");

      expect(mockSignInWithPassword).toHaveBeenCalledWith({
        email: "login@example.com",
        password: "password123",
      });

      const stored = store[STORAGE_KEYS.AUTH_STATE] as Record<string, unknown>;
      expect(stored.accessToken).toBe("new-access-token");
      expect(stored.refreshToken).toBe("new-refresh-token");
      expect(stored.email).toBe("login@example.com");
      expect(stored.expiresAt).toBe(expiresAt);
    });

    it("throws on login failure", async () => {
      mockSignInWithPassword.mockResolvedValue({
        data: { session: null },
        error: { message: "Invalid credentials" },
      });

      await expect(login("bad@example.com", "wrong")).rejects.toThrow("Invalid credentials");

      // Should not store any auth data
      expect(store[STORAGE_KEYS.AUTH_STATE]).toBeUndefined();
    });
  });

  describe("logout", () => {
    it("clears stored auth data", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "token-to-clear",
        refreshToken: "refresh-to-clear",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      mockSignOut.mockResolvedValue({ error: null });

      await logout();

      expect(store[STORAGE_KEYS.AUTH_STATE]).toBeUndefined();
      expect(mockSignOut).toHaveBeenCalled();
    });

    it("clears stored auth data even if supabase signOut fails", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "token-to-clear",
        refreshToken: "refresh-to-clear",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      mockSignOut.mockResolvedValue({ error: { message: "Network error" } });

      await logout();

      // Auth data should still be cleared locally
      expect(store[STORAGE_KEYS.AUTH_STATE]).toBeUndefined();
    });
  });

  describe("getAccessToken", () => {
    it("returns null when not logged in", async () => {
      const token = await getAccessToken();
      expect(token).toBeNull();
    });

    it("returns access token when logged in", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "my-access-token",
        refreshToken: "my-refresh-token",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
      };

      const token = await getAccessToken();
      expect(token).toBe("my-access-token");
    });

    it("returns null when token is expired", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "expired-token",
        refreshToken: "my-refresh-token",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      };

      const token = await getAccessToken();
      expect(token).toBeNull();
    });
  });

  describe("getSupabaseClient", () => {
    it("returns a supabase client instance", () => {
      const client = getSupabaseClient();
      expect(client).toBeDefined();
      expect(client.auth).toBeDefined();
    });
  });

  describe("token refresh", () => {
    it("refreshes expired token using refreshToken and returns logged in on success", async () => {
      const newExpiresAt = Math.floor(Date.now() / 1000) + 3600;

      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "expired-token",
        refreshToken: "valid-refresh-token",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      };

      mockRefreshSession.mockResolvedValueOnce({
        data: {
          session: {
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_at: newExpiresAt,
            user: { email: "user@example.com" },
          },
        },
        error: null,
      });

      const state = await getAuthState();

      expect(state.isLoggedIn).toBe(true);
      expect(state.accessToken).toBe("new-access-token");
      expect(state.email).toBe("user@example.com");
      expect(mockRefreshSession).toHaveBeenCalledWith({
        refresh_token: "valid-refresh-token",
      });
    });

    it("persists refreshed tokens to chrome.storage", async () => {
      const newExpiresAt = Math.floor(Date.now() / 1000) + 3600;

      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "expired-token",
        refreshToken: "valid-refresh-token",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      };

      mockRefreshSession.mockResolvedValueOnce({
        data: {
          session: {
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_at: newExpiresAt,
            user: { email: "user@example.com" },
          },
        },
        error: null,
      });

      await getAuthState();

      const stored = store[STORAGE_KEYS.AUTH_STATE] as Record<string, unknown>;
      expect(stored.accessToken).toBe("new-access-token");
      expect(stored.refreshToken).toBe("new-refresh-token");
      expect(stored.expiresAt).toBe(newExpiresAt);
    });

    it("returns logged out when refresh fails with error response", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "expired-token",
        refreshToken: "bad-refresh-token",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      };

      mockRefreshSession.mockResolvedValueOnce({
        data: { session: null },
        error: { message: "Refresh token is invalid" },
      });

      const state = await getAuthState();

      expect(state.isLoggedIn).toBe(false);
    });

    it("returns logged out when no refresh token is stored", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "expired-token",
        refreshToken: "",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      };

      const state = await getAuthState();

      expect(state.isLoggedIn).toBe(false);
      expect(mockRefreshSession).not.toHaveBeenCalled();
    });

    it("returns logged out when refresh throws (network error)", async () => {
      store[STORAGE_KEYS.AUTH_STATE] = {
        accessToken: "expired-token",
        refreshToken: "valid-refresh-token",
        email: "user@example.com",
        expiresAt: Math.floor(Date.now() / 1000) - 60,
      };

      mockRefreshSession.mockRejectedValueOnce(new Error("Network timeout"));

      const state = await getAuthState();

      expect(state.isLoggedIn).toBe(false);
    });
  });
});
