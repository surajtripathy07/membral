import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("createClient (browser)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("throws when env vars are missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const { createClient } = await import("../supabase/client.js");
    expect(() => createClient()).toThrow("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  });

  it("creates a client without throwing when env vars are set", async () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRlc3QiLCJyb2xlIjoiYW5vbiIsImlhdCI6MTYxNjQ1MjAwMCwiZXhwIjoxOTMyMDI4MDAwfQ.abc123";

    const { createClient } = await import("../supabase/client.js");
    const client = createClient();
    expect(client).toBeDefined();
    expect(client.auth).toBeDefined();
  });
});
