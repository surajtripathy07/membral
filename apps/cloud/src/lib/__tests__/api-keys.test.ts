import { createHash } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockUpdate = vi.fn();
const mockEqUpdate = vi.fn();
const mockSingle = vi.fn();
const mockEqSelect = vi.fn(() => ({ single: mockSingle }));
const mockSelectFn = vi.fn(() => ({ eq: mockEqSelect }));

// api_keys (migration 052) fall-through chain: select().eq().is().single()
const mockApiKeysSingle = vi.fn();
const mockApiKeysIs = vi.fn(() => ({ single: mockApiKeysSingle }));
const mockApiKeysEq = vi.fn(() => ({ is: mockApiKeysIs }));
const mockApiKeysSelect = vi.fn(() => ({ eq: mockApiKeysEq }));

// api_keys last_used_at fire-and-forget bump: update().eq() -> Promise
const mockApiKeysUpdateEq = vi.fn();
const mockApiKeysUpdate = vi.fn(() => ({ eq: mockApiKeysUpdateEq }));

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: vi.fn((table: string) => {
      if (table === "profiles") {
        return {
          update: mockUpdate,
          select: mockSelectFn,
        };
      }
      if (table === "api_keys") {
        return {
          select: mockApiKeysSelect,
          update: mockApiKeysUpdate,
        };
      }
      return {};
    }),
  })),
}));

// Mock the limiter — validateApiKey's IP throttle calls checkRateLimit.
const mockCheckRateLimit = vi.fn();
vi.mock("../rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../rate-limit")>();
  return {
    ...actual,
    checkRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
  };
});

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import type { Db } from "@/lib/db/types";
import { generateApiKey, getApiKeyProfile, listApiKeys, mintApiKey, revokeApiKey, validateApiKey } from "../api-keys";

describe("api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUpdate.mockReturnValue({ eq: mockEqUpdate });
    mockEqUpdate.mockResolvedValue({ error: null });
    // Default: api_keys fall-through misses (profiles-path tests never reach
    // it anyway, since a profiles hit short-circuits before this is queried).
    mockApiKeysSingle.mockResolvedValue({ data: null, error: { message: "No rows" } });
    mockApiKeysUpdateEq.mockResolvedValue({ error: null });
  });

  describe("generateApiKey", () => {
    it("returns a string starting with lls_", async () => {
      const key = await generateApiKey("user-123");
      expect(typeof key).toBe("string");
      expect(key.startsWith("lls_")).toBe(true);
      expect(key.length).toBeGreaterThan(10);
    });

    it("uses the canonical lls_ + base64url shape", async () => {
      const key = await generateApiKey("user-123");
      expect(key).toMatch(/^lls_[A-Za-z0-9_-]+$/);
    });

    it("stores the hash plus a display prefix in profiles table", async () => {
      const key = await generateApiKey("user-123");
      const expectedHash = createHash("sha256").update(key).digest("hex");

      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          api_key_hash: expectedHash,
          api_key_prefix: key.slice(0, 8),
          updated_at: expect.any(String),
        }),
      );
      expect(mockEqUpdate).toHaveBeenCalledWith("id", "user-123");
    });

    it("defaults to an unscoped key (api_key_scope_node_id null) when no scope given", async () => {
      await generateApiKey("user-123");
      expect(mockUpdate).toHaveBeenCalledWith(expect.objectContaining({ api_key_scope_node_id: null }));
    });

    it("persists the area scope node id when one is supplied (issue #83)", async () => {
      await generateApiKey("user-123", "area-abc");
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ api_key_scope_node_id: "area-abc", api_key_scope_code_project_id: null }),
      );
    });

    it("persists the code-project scope id when one is supplied (ADR 0021 Q7)", async () => {
      await generateApiKey("user-123", null, "proj-abc");
      expect(mockUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ api_key_scope_node_id: null, api_key_scope_code_project_id: "proj-abc" }),
      );
    });

    it("ATTACK: throws (never persists) when BOTH scopes are supplied — single-scope XOR", async () => {
      await expect(generateApiKey("user-123", "area-abc", "proj-abc")).rejects.toThrow(/not both/);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it("throws when database update fails", async () => {
      mockEqUpdate.mockResolvedValueOnce({
        error: { message: "DB error" },
      });

      await expect(generateApiKey("user-123")).rejects.toThrow("Failed to store API key");
    });
  });

  describe("mintApiKey (migration 052 — device-auth building block)", () => {
    it("returns the same lls_ + base64url shape as generateApiKey's raw key", () => {
      const { raw } = mintApiKey();
      expect(raw).toMatch(/^lls_[A-Za-z0-9_-]+$/);
    });

    it("prefix is the first 8 chars of the raw key", () => {
      const { raw, prefix } = mintApiKey();
      expect(prefix).toBe(raw.slice(0, 8));
    });

    it("hash is the SHA-256 of the raw key — same function validateApiKey hashes with", () => {
      const { raw, hash } = mintApiKey();
      expect(hash).toBe(createHash("sha256").update(raw).digest("hex"));
    });

    it("mints a fresh key on every call", () => {
      const a = mintApiKey();
      const b = mintApiKey();
      expect(a.raw).not.toBe(b.raw);
    });
  });

  describe("validateApiKey", () => {
    it("returns valid + null scope for a matching unscoped key", async () => {
      const rawKey = "lls_abc123";
      const hash = createHash("sha256").update(rawKey).digest("hex");

      mockSingle.mockResolvedValueOnce({
        data: { id: "user-456", api_key_scope_node_id: null },
        error: null,
      });

      const result = await validateApiKey(rawKey);

      expect(mockSelectFn).toHaveBeenCalledWith("id, api_key_scope_node_id, api_key_scope_code_project_id");
      expect(mockEqSelect).toHaveBeenCalledWith("api_key_hash", hash);
      expect(result).toEqual({ valid: true, userId: "user-456", scopeNodeId: null, scopeCodeProjectId: null });
      // A profiles hit short-circuits — the api_keys fall-through is never queried.
      expect(mockApiKeysSelect).not.toHaveBeenCalled();
    });

    it("returns the area scope node id for a scoped key (issue #83)", async () => {
      mockSingle.mockResolvedValueOnce({
        data: { id: "user-456", api_key_scope_node_id: "area-work" },
        error: null,
      });

      const result = await validateApiKey("lls_scoped");

      expect(result).toEqual({
        valid: true,
        userId: "user-456",
        scopeNodeId: "area-work",
        scopeCodeProjectId: null,
      });
    });

    it("returns the code-project scope id for a code-project-scoped key (ADR 0021 Q7)", async () => {
      mockSingle.mockResolvedValueOnce({
        data: { id: "user-456", api_key_scope_node_id: null, api_key_scope_code_project_id: "proj-abc" },
        error: null,
      });

      const result = await validateApiKey("lls_code_scoped");

      expect(result).toEqual({
        valid: true,
        userId: "user-456",
        scopeNodeId: null,
        scopeCodeProjectId: "proj-abc",
      });
    });

    it("returns invalid for a wrong key (miss on BOTH profiles and api_keys)", async () => {
      mockSingle.mockResolvedValueOnce({
        data: null,
        error: { message: "No rows" },
      });

      const result = await validateApiKey("lls_wrong_key");

      expect(result).toEqual({ valid: false });
      // Falls through to the api_keys table after the profiles miss.
      expect(mockApiKeysSelect).toHaveBeenCalled();
    });
  });

  describe("validateApiKey — api_keys fall-through (migration 052, device-code sign-in)", () => {
    beforeEach(() => {
      // Every test in this block starts from a profiles miss, so the code
      // falls through to the api_keys table under test.
      mockSingle.mockResolvedValue({ data: null, error: { message: "No rows" } });
    });

    it("validates a device-issued key not present in profiles", async () => {
      const rawKey = "lls_device_key";
      const hash = createHash("sha256").update(rawKey).digest("hex");
      mockApiKeysSingle.mockResolvedValueOnce({
        data: {
          id: "key-1",
          user_id: "user-789",
          scope_node_id: null,
          scope_code_project_id: null,
          device_id: "dev-1",
        },
        error: null,
      });

      const result = await validateApiKey(rawKey);

      expect(mockApiKeysSelect).toHaveBeenCalledWith("id, user_id, scope_node_id, scope_code_project_id, device_id");
      expect(mockApiKeysEq).toHaveBeenCalledWith("key_hash", hash);
      expect(mockApiKeysIs).toHaveBeenCalledWith("revoked_at", null);
      expect(result).toEqual({
        valid: true,
        userId: "user-789",
        scopeNodeId: null,
        scopeCodeProjectId: null,
        deviceId: "dev-1",
        apiKeyId: "key-1",
      });
    });

    it("carries an area/code-project scope through from the api_keys row", async () => {
      mockApiKeysSingle.mockResolvedValueOnce({
        data: {
          id: "key-1",
          user_id: "user-789",
          scope_node_id: "area-x",
          scope_code_project_id: null,
          device_id: null,
        },
        error: null,
      });

      const result = await validateApiKey("lls_device_scoped");

      expect(result).toEqual({
        valid: true,
        userId: "user-789",
        scopeNodeId: "area-x",
        scopeCodeProjectId: null,
        deviceId: null,
        apiKeyId: "key-1",
      });
    });

    it("excludes revoked keys via .is('revoked_at', null) — the query itself never sees them", async () => {
      // Simulates the DB-level exclusion: a revoked row simply never matches
      // the `.is("revoked_at", null)` predicate, so .single() reports a miss.
      mockApiKeysSingle.mockResolvedValueOnce({ data: null, error: { message: "No rows" } });

      const result = await validateApiKey("lls_revoked_key");

      expect(mockApiKeysIs).toHaveBeenCalledWith("revoked_at", null);
      expect(result).toEqual({ valid: false });
    });

    it("bumps last_used_at fire-and-forget on a hit, without blocking the result", async () => {
      mockApiKeysSingle.mockResolvedValueOnce({
        data: { id: "key-77", user_id: "user-1", scope_node_id: null, scope_code_project_id: null, device_id: null },
        error: null,
      });
      // Never resolves — proves the bump isn't awaited before returning.
      mockApiKeysUpdateEq.mockReturnValueOnce(new Promise(() => {}));

      const result = await validateApiKey("lls_bump_test");

      expect(result.valid).toBe(true);
      expect(mockApiKeysUpdate).toHaveBeenCalledWith({ last_used_at: expect.any(String) });
      expect(mockApiKeysUpdateEq).toHaveBeenCalledWith("id", "key-77");
    });

    it("a failed bump write never surfaces as a validation error", async () => {
      mockApiKeysSingle.mockResolvedValueOnce({
        data: { id: "key-77", user_id: "user-1", scope_node_id: null, scope_code_project_id: null, device_id: null },
        error: null,
      });
      mockApiKeysUpdateEq.mockRejectedValueOnce(new Error("db down"));

      const result = await validateApiKey("lls_bump_fail");
      expect(result).toEqual({
        valid: true,
        userId: "user-1",
        scopeNodeId: null,
        scopeCodeProjectId: null,
        deviceId: null,
        apiKeyId: "key-77",
      });
    });
  });

  describe("validateApiKey — failed-attempt IP throttle (issue #67)", () => {
    it("does NOT touch the limiter when no client IP is threaded", async () => {
      mockSingle.mockResolvedValueOnce({ data: null, error: { message: "No rows" } });
      const result = await validateApiKey("lls_wrong");
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
      expect(result).toEqual({ valid: false });
    });

    it("a SUCCESSFUL validation is never counted against the IP", async () => {
      mockSingle.mockResolvedValueOnce({ data: { id: "u-1", api_key_scope_node_id: null }, error: null });
      const result = await validateApiKey("lls_ok", "1.2.3.4");
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
      expect(result).toEqual({ valid: true, userId: "u-1", scopeNodeId: null, scopeCodeProjectId: null });
    });

    it("a SUCCESSFUL api_keys fall-through validation is also never counted against the IP", async () => {
      mockSingle.mockResolvedValueOnce({ data: null, error: { message: "No rows" } });
      mockApiKeysSingle.mockResolvedValueOnce({
        data: { id: "key-1", user_id: "u-2", scope_node_id: null, scope_code_project_id: null, device_id: null },
        error: null,
      });
      const result = await validateApiKey("lls_device_ok", "1.2.3.4");
      expect(mockCheckRateLimit).not.toHaveBeenCalled();
      expect(result.valid).toBe(true);
    });

    it("records a failed attempt keyed by IP and stays valid:false while under the limit", async () => {
      mockSingle.mockResolvedValueOnce({ data: null, error: { message: "No rows" } });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, retryAfter: 0, remaining: 4 });
      const result = await validateApiKey("lls_wrong", "1.2.3.4");
      expect(mockCheckRateLimit).toHaveBeenCalledWith(
        expect.objectContaining({ bucket: "keyfail:ip:1.2.3.4", limit: 5, windowSeconds: 60 }),
      );
      expect(result).toEqual({ valid: false });
    });

    it("N failed attempts from one IP then throttled -> rateLimited signal with retryAfter", async () => {
      // First 5 attempts allowed-through failures, 6th blocked.
      for (let i = 0; i < 5; i++) {
        mockSingle.mockResolvedValueOnce({ data: null, error: { message: "No rows" } });
        mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, retryAfter: 0, remaining: 4 - i });
        const r = await validateApiKey("lls_wrong", "9.9.9.9");
        expect(r).toEqual({ valid: false });
      }
      mockSingle.mockResolvedValueOnce({ data: null, error: { message: "No rows" } });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, retryAfter: 37, remaining: 0 });
      const blocked = await validateApiKey("lls_wrong", "9.9.9.9");
      expect(blocked).toEqual({ valid: false, rateLimited: true, retryAfter: 37 });
    });

    it("a DIFFERENT IP is unaffected (separate bucket)", async () => {
      mockSingle.mockResolvedValueOnce({ data: null, error: { message: "No rows" } });
      mockCheckRateLimit.mockResolvedValueOnce({ allowed: true, retryAfter: 0, remaining: 4 });
      await validateApiKey("lls_wrong", "8.8.8.8");
      expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.objectContaining({ bucket: "keyfail:ip:8.8.8.8" }));
    });
  });

  describe("revokeApiKey (DELETE /api/keys/devices/[id])", () => {
    it("runs update().eq(id).eq(user_id).is(revoked_at,null).select(id) on api_keys and returns the raw result", async () => {
      const result = { data: [{ id: "key-1" }], error: null };
      const select = vi.fn().mockResolvedValue(result);
      const is = vi.fn(() => ({ select }));
      const eqUser = vi.fn(() => ({ is }));
      const eqId = vi.fn(() => ({ eq: eqUser }));
      const update = vi.fn(() => ({ eq: eqId }));
      const from = vi.fn(() => ({ update }));

      const out = await revokeApiKey({ from } as unknown as Db, "user-1", "key-1");

      expect(out).toBe(result);
      expect(from).toHaveBeenCalledWith("api_keys");
      expect(update).toHaveBeenCalledWith({ revoked_at: expect.any(String) });
      expect(eqId).toHaveBeenCalledWith("id", "key-1");
      expect(eqUser).toHaveBeenCalledWith("user_id", "user-1");
      expect(is).toHaveBeenCalledWith("revoked_at", null);
      expect(select).toHaveBeenCalledWith("id");
    });
  });

  describe("getApiKeyProfile (/settings)", () => {
    it("runs select(cols).eq(id).single() on profiles with the passed client and returns the raw result", async () => {
      const result = {
        data: { api_key_prefix: "lls_x", api_key_scope_node_id: null, api_key_scope_code_project_id: null },
        error: null,
      };
      const single = vi.fn().mockResolvedValue(result);
      const eq = vi.fn(() => ({ single }));
      const select = vi.fn(() => ({ eq }));
      const from = vi.fn(() => ({ select }));

      const out = await getApiKeyProfile({ from } as unknown as Db, "user-1");

      expect(out).toBe(result);
      expect(from).toHaveBeenCalledWith("profiles");
      expect(select).toHaveBeenCalledWith("api_key_prefix, api_key_scope_node_id, api_key_scope_code_project_id");
      expect(eq).toHaveBeenCalledWith("id", "user-1");
    });
  });

  describe("listApiKeys (/settings device keys)", () => {
    it("runs select(cols).order(created_at desc) on api_keys and returns the raw result", async () => {
      const result = { data: [], error: null };
      const order = vi.fn().mockResolvedValue(result);
      const select = vi.fn(() => ({ order }));
      const from = vi.fn(() => ({ select }));

      const out = await listApiKeys({ from } as unknown as Db);

      expect(out).toBe(result);
      expect(from).toHaveBeenCalledWith("api_keys");
      expect(select).toHaveBeenCalledWith("id, key_prefix, label, created_at, last_used_at, revoked_at");
      expect(order).toHaveBeenCalledWith("created_at", { ascending: false });
    });
  });
});
