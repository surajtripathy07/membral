import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createClientMock } = vi.hoisted(() => ({
  createClientMock: vi.fn((..._args: unknown[]) => ({ sentinel: Symbol("client") })),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: createClientMock }));

import { getServiceClient, tryServiceClient } from "../clients";

describe("lib/db/clients", () => {
  beforeEach(() => {
    createClientMock.mockClear();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("with env unset", () => {
    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    });

    it("getServiceClient() throws the default message", () => {
      expect(() => getServiceClient()).toThrow(new Error("Missing Supabase env vars"));
      expect(createClientMock).not.toHaveBeenCalled();
    });

    it("getServiceClient({ message }) throws that message", () => {
      expect(() => getServiceClient({ message: "Missing Supabase service-role env vars" })).toThrow(
        new Error("Missing Supabase service-role env vars"),
      );
    });

    it("tryServiceClient() returns null", () => {
      expect(tryServiceClient()).toBeNull();
      expect(createClientMock).not.toHaveBeenCalled();
    });

    it("treats a missing key alone as missing env", () => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
      expect(tryServiceClient()).toBeNull();
      expect(() => getServiceClient()).toThrow("Missing Supabase env vars");
    });
  });

  describe("with env set", () => {
    beforeEach(() => {
      vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
      vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-key");
    });

    it("getServiceClient() returns a fresh client per call, built with exactly (url, key)", () => {
      const a = getServiceClient();
      const b = getServiceClient();
      expect(a).not.toBe(b);
      expect(createClientMock).toHaveBeenCalledTimes(2);
      expect(createClientMock).toHaveBeenNthCalledWith(1, "http://localhost:54321", "service-key");
      expect(createClientMock.mock.calls[0]).toHaveLength(2);
    });

    it("tryServiceClient() returns a fresh client per call, built with exactly (url, key)", () => {
      const a = tryServiceClient();
      const b = tryServiceClient();
      expect(a).not.toBeNull();
      expect(a).not.toBe(b);
      expect(createClientMock).toHaveBeenCalledTimes(2);
      expect(createClientMock).toHaveBeenNthCalledWith(2, "http://localhost:54321", "service-key");
      expect(createClientMock.mock.calls[1]).toHaveLength(2);
    });
  });
});
