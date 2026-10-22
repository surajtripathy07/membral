import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("getEnv", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when NEXT_PUBLIC_SUPABASE_URL is missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { getEnv } = await import("../env.js");
    expect(() => getEnv()).toThrow("NEXT_PUBLIC_SUPABASE_URL");
  });

  it("throws when NEXT_PUBLIC_SUPABASE_ANON_KEY is missing", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { getEnv } = await import("../env.js");
    expect(() => getEnv()).toThrow("NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });

  it("throws when SUPABASE_SERVICE_ROLE_KEY is missing", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-123";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    const { getEnv } = await import("../env.js");
    expect(() => getEnv()).toThrow("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("returns all env vars when they are set", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-123";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-456";

    const { getEnv } = await import("../env.js");
    const env = getEnv();

    expect(env.supabaseUrl).toBe("https://example.supabase.co");
    expect(env.supabaseAnonKey).toBe("anon-key-123");
    expect(env.supabaseServiceRoleKey).toBe("service-role-key-456");
  });
});

describe("validateEnvAtBoot / findMissingRequiredEnvVars", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllEnvs();
  });

  it("is a no-op outside production even with everything missing", async () => {
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_APP_URL;

    const { validateEnvAtBoot } = await import("../env.js");
    expect(() => validateEnvAtBoot()).not.toThrow();
  });

  it("throws in production naming every missing required var", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-123";
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.NEXT_PUBLIC_APP_URL;

    const { validateEnvAtBoot, findMissingRequiredEnvVars } = await import("../env.js");
    expect(findMissingRequiredEnvVars()).toEqual([
      "NEXT_PUBLIC_SUPABASE_URL",
      "SUPABASE_SERVICE_ROLE_KEY",
      "NEXT_PUBLIC_APP_URL",
    ]);
    expect(() => validateEnvAtBoot()).toThrow("NEXT_PUBLIC_SUPABASE_URL");
    expect(() => validateEnvAtBoot()).toThrow("SUPABASE_SERVICE_ROLE_KEY");
    expect(() => validateEnvAtBoot()).toThrow("NEXT_PUBLIC_APP_URL");
  });

  // #134 adversarial review round 1, minor m4: NEXT_PUBLIC_APP_URL set but
  // schemeless used to only fail once something called `new URL()` on a
  // value built from it (previously /auth/callback on every OAuth
  // sign-in) — validated at boot instead now, so a misconfigured deploy
  // fails loudly at startup.
  it("throws in production when NEXT_PUBLIC_APP_URL is set but not a valid absolute URL", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-123";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-456";
    process.env.NEXT_PUBLIC_APP_URL = "membral.me";

    const { validateEnvAtBoot } = await import("../env.js");
    expect(() => validateEnvAtBoot()).toThrow("NEXT_PUBLIC_APP_URL");
  });

  it("does not throw in production when every required var is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key-123";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key-456";
    process.env.NEXT_PUBLIC_APP_URL = "https://membral.me";

    const { validateEnvAtBoot } = await import("../env.js");
    expect(() => validateEnvAtBoot()).not.toThrow();
  });
});

describe("getAppUrl", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllEnvs();
  });

  it("returns the configured NEXT_PUBLIC_APP_URL with trailing slash stripped", async () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://membral.me/";
    const { getAppUrl } = await import("../env.js");
    expect(getAppUrl()).toBe("https://membral.me");
  });

  it("falls back to localhost outside production when unset", async () => {
    vi.stubEnv("NODE_ENV", "development");
    delete process.env.NEXT_PUBLIC_APP_URL;
    const { getAppUrl } = await import("../env.js");
    expect(getAppUrl()).toBe("http://localhost:3000");
  });

  it("falls back to https://membral.me in production when unset", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.NEXT_PUBLIC_APP_URL;
    const { getAppUrl } = await import("../env.js");
    expect(getAppUrl()).toBe("https://membral.me");
  });
});
