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

describe("serverSupabaseFetch (bare PostgREST, Docker-free local stack)", () => {
  const originalEnv = process.env;
  const fetchSpy = vi.fn(async (..._a: unknown[]) => new Response("{}"));

  beforeEach(() => {
    vi.resetModules();
    fetchSpy.mockClear();
    vi.stubGlobal("fetch", fetchSpy);
    process.env = { ...originalEnv };
    delete process.env.VERCEL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:3400";
    process.env.SUPABASE_INTERNAL_URL = "http://rest:3000";
    process.env.MEMBRAL_LOCAL = "1";
    process.env.MEMBRAL_POSTGREST_DIRECT = "1";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("strips /rest/v1 and keeps the query string", async () => {
    const { serverSupabaseFetch } = await import("../url");
    await serverSupabaseFetch()?.("http://rest:3000/rest/v1/session_memories?select=id&limit=1", { method: "GET" });
    expect(fetchSpy).toHaveBeenCalledWith("http://rest:3000/session_memories?select=id&limit=1", { method: "GET" });
  });

  it("maps /rest/v1/rpc/<fn> to /rpc/<fn>", async () => {
    const { serverSupabaseFetch } = await import("../url");
    await serverSupabaseFetch()?.("http://rest:3000/rest/v1/rpc/local_auth_find_user", { method: "POST" });
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://rest:3000/rpc/local_auth_find_user");
  });

  it("sends /auth/v1 to the app's own origin (the stub), not to PostgREST", async () => {
    const { serverSupabaseFetch } = await import("../url");
    await serverSupabaseFetch()?.("http://rest:3000/auth/v1/user");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://localhost:3400/auth/v1/user");
  });

  it("matches /auth/v1 exactly or as a path prefix, not /auth/v1x", async () => {
    const { serverSupabaseFetch } = await import("../url");
    const f = serverSupabaseFetch();
    await f?.("http://rest:3000/auth/v1");
    await f?.("http://rest:3000/auth/v1x/user");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://localhost:3400/auth/v1");
    expect(fetchSpy.mock.calls[1]?.[0]).toBe("http://rest:3000/auth/v1x/user");
  });

  it("passes any other URL through untouched", async () => {
    const { serverSupabaseFetch } = await import("../url");
    await serverSupabaseFetch()?.("https://example.com/x");
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("https://example.com/x");
  });

  it("is off without the direct flag, outside local mode, and on Vercel", async () => {
    const { serverSupabaseFetch } = await import("../url");
    expect(serverSupabaseFetch()).toBeTypeOf("function");
    delete process.env.MEMBRAL_POSTGREST_DIRECT;
    expect(serverSupabaseFetch()).toBeUndefined();
    process.env.MEMBRAL_POSTGREST_DIRECT = "1";
    delete process.env.MEMBRAL_LOCAL;
    expect(serverSupabaseFetch()).toBeUndefined();
    process.env.MEMBRAL_LOCAL = "1";
    process.env.VERCEL = "1";
    expect(serverSupabaseFetch()).toBeUndefined();
  });

  it("the service-role client gets the rewriting fetch only when it applies", async () => {
    const { getServiceClient } = await import("@/lib/db/clients");
    getServiceClient();
    const call = createClientSpy.mock.calls.at(-1) as unknown as unknown[];
    expect(call[0]).toBe("http://rest:3000");
    expect((call[2] as { global: { fetch: unknown } }).global.fetch).toBeTypeOf("function");
    delete process.env.MEMBRAL_POSTGREST_DIRECT;
    getServiceClient();
    expect((createClientSpy.mock.calls.at(-1) as unknown as unknown[]).length).toBe(2);
  });
});

describe("serverSupabaseFetch (embedded store, rung two)", () => {
  const originalEnv = process.env;
  const fetchSpy = vi.fn(async (..._a: unknown[]) => new Response("net"));
  const shimSpy = vi.fn(async (..._a: unknown[]) => new Response("shim"));
  let store: object | undefined;

  beforeEach(() => {
    vi.resetModules();
    fetchSpy.mockClear();
    shimSpy.mockClear();
    store = { kind: "pglite" };
    vi.stubGlobal("fetch", fetchSpy);
    vi.doMock("@/lib/local/store/registry", () => ({ getStore: () => store }));
    vi.doMock("@/lib/local/store/shim/handler", () => ({ handleRestRequest: shimSpy }));
    process.env = { ...originalEnv };
    delete process.env.VERCEL;
    delete process.env.SUPABASE_INTERNAL_URL;
    delete process.env.MEMBRAL_POSTGREST_DIRECT;
    process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:3400";
    process.env.MEMBRAL_LOCAL = "1";
    process.env.MEMBRAL_STORE = "pglite";
    process.env.SUPABASE_JWT_SECRET = "s".repeat(40);
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-key";
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.doUnmock("@/lib/local/store/registry");
    vi.doUnmock("@/lib/local/store/shim/handler");
  });

  it("sends /rest/v1 to the shim with the registered store and the JWT secret", async () => {
    const { serverSupabaseFetch } = await import("../url");
    const res = await serverSupabaseFetch()?.("http://localhost:3400/rest/v1/profiles?select=id", { method: "GET" });
    expect(await res?.text()).toBe("shim");
    expect(shimSpy).toHaveBeenCalledTimes(1);
    expect(shimSpy.mock.calls[0]?.[1]).toBe(store);
    expect(shimSpy.mock.calls[0]?.[2]).toEqual({ jwtSecret: "s".repeat(40) });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps /auth/v1 on the app origin", async () => {
    const { serverSupabaseFetch } = await import("../url");
    await serverSupabaseFetch()?.("http://x/auth/v1/user");
    expect(shimSpy).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://localhost:3400/auth/v1/user");
  });

  it("takes the shim branch only under all three conditions", async () => {
    const { serverSupabaseFetch } = await import("../url");
    const call = async () => {
      shimSpy.mockClear();
      await serverSupabaseFetch()?.("http://localhost:3400/rest/v1/profiles");
      return shimSpy.mock.calls.length;
    };
    expect(await call()).toBe(1);
    process.env.MEMBRAL_STORE = "";
    expect(serverSupabaseFetch()).toBeUndefined();
    process.env.MEMBRAL_STORE = "pglite";
    delete process.env.MEMBRAL_LOCAL;
    expect(serverSupabaseFetch()).toBeUndefined();
    process.env.MEMBRAL_LOCAL = "1";
    process.env.VERCEL = "1";
    expect(serverSupabaseFetch()).toBeUndefined();
    delete process.env.VERCEL;
    store = undefined;
    expect(await call()).toBe(0); // no registered store: never the shim
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("without a registered store falls back to the rung-one rewrite when it is configured", async () => {
    store = undefined;
    process.env.SUPABASE_INTERNAL_URL = "http://rest:3000";
    process.env.MEMBRAL_POSTGREST_DIRECT = "1";
    const { serverSupabaseFetch } = await import("../url");
    await serverSupabaseFetch()?.("http://x/rest/v1/profiles?select=id");
    expect(shimSpy).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://rest:3000/profiles?select=id");
  });

  it("with the store set, rung-one still never hits the shim when MEMBRAL_STORE is off", async () => {
    process.env.MEMBRAL_STORE = "";
    process.env.SUPABASE_INTERNAL_URL = "http://rest:3000";
    process.env.MEMBRAL_POSTGREST_DIRECT = "1";
    const { serverSupabaseFetch } = await import("../url");
    await serverSupabaseFetch()?.("http://x/rest/v1/profiles");
    expect(shimSpy).not.toHaveBeenCalled();
    expect(fetchSpy.mock.calls[0]?.[0]).toBe("http://rest:3000/profiles");
  });

  it("no route file serves /rest/v1", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const root = path.resolve(__dirname, "../../../app");
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (p.split(path.sep).join("/").endsWith("rest/v1") || p.split(path.sep).join("/").includes("rest/v1/"))
            hits.push(p);
          walk(p);
        }
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
