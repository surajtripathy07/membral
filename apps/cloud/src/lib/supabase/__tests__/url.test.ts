import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const createClientSpy = vi.fn(() => ({ auth: {} }));
vi.mock("@supabase/supabase-js", () => ({ createClient: createClientSpy }));

describe("serverSupabaseUrl / sessionCookieOptions", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    createClientSpy.mockClear();
    process.env = { ...originalEnv };
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
    delete process.env.SUPABASE_INTERNAL_URL;
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("uses the public URL and no cookie override when SUPABASE_INTERNAL_URL is unset", async () => {
    const { serverSupabaseUrl, sessionCookieOptions } = await import("../url");
    expect(serverSupabaseUrl()).toBe("http://localhost:54321");
    expect(sessionCookieOptions()).toBeUndefined();
  });

  it("treats a blank SUPABASE_INTERNAL_URL as unset", async () => {
    process.env.SUPABASE_INTERNAL_URL = "  ";
    const { serverSupabaseUrl, sessionCookieOptions } = await import("../url");
    expect(serverSupabaseUrl()).toBe("http://localhost:54321");
    expect(sessionCookieOptions()).toBeUndefined();
  });

  it("uses the internal URL and pins the public cookie name when set", async () => {
    process.env.SUPABASE_INTERNAL_URL = "http://gateway:8000";
    const { serverSupabaseUrl, sessionCookieOptions } = await import("../url");
    expect(serverSupabaseUrl()).toBe("http://gateway:8000");
    expect(sessionCookieOptions()).toEqual({ name: "sb-localhost-auth-token" });
  });

  it("service-role client is built on the internal URL when set, public URL otherwise", async () => {
    const { getServiceClient } = await import("@/lib/db/clients");
    getServiceClient();
    expect(createClientSpy).toHaveBeenLastCalledWith("http://localhost:54321", "service-key");

    process.env.SUPABASE_INTERNAL_URL = "http://gateway:8000";
    getServiceClient();
    expect(createClientSpy).toHaveBeenLastCalledWith("http://gateway:8000", "service-key");
  });
});
