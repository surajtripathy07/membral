// Unit tests for withRoute (G3 step 3A-3): order, CORS on every exit, ctx
// forwarding, kind "none", thrown errors. Same external boundary as the route
// contracts (golden boundary FakeDb); no internal module is mocked. The rate
// limiter is observed through its one external call, the rate_limit_check RPC.
import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("../../../__golden__/routes/boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("../../../__golden__/routes/boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("../../../__golden__/routes/boundary")).nextHeadersModule());

import * as boundary from "../../../__golden__/routes/boundary";
import {
  API_KEY,
  AUTH_COOKIE,
  SCOPED_KEY,
  setupRouteGolden,
  USER_ID,
  USER_JWT,
} from "../../../__golden__/routes/harness";
import { keyBucket, userBucket } from "../../rate-limit";
import { withRoute } from "../route";

const ALLOWED = `chrome-extension://${"a".repeat(32)}`;
const METHODS = "POST, OPTIONS";

let rlKeys: string[] = [];
let rlAllowed = true;
setupRouteGolden(() => ({
  rate_limit_check: (a) => {
    rlKeys.push(a.p_key as string);
    return { data: { allowed: rlAllowed, retry_after: rlAllowed ? 0 : 7, remaining: 0 }, error: null };
  },
}));
beforeEach(() => {
  rlKeys = [];
  rlAllowed = true;
});

const req = (headers: Record<string, string> = {}, init: { method?: string; body?: string } = {}) =>
  new NextRequest("http://localhost:3001/api/x", { method: init.method ?? "POST", headers, body: init.body });

const bearer = { kind: "bearer", missing: "Missing authorization", invalid: "Invalid token" } as const;
const rateLimit = {
  name: "sync",
  bucket: ({ user }: { user: { id: string } }) => userBucket("sync", user.id),
} as const;
const ok = async (): Promise<Response> => NextResponse.json({ ok: true });

function acHeaders(res: Response): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of res.headers) if (k.startsWith("access-control-") || k === "vary") out[k] = v;
  return out;
}
const CORS = {
  "access-control-allow-headers": "Authorization, Content-Type",
  "access-control-allow-methods": METHODS,
  "access-control-allow-origin": ALLOWED,
  "access-control-max-age": "86400",
  vary: "Origin",
};

describe("order: auth -> rate limit -> handler", () => {
  it("an auth failure never calls the rate limiter or the handler", async () => {
    const handler = vi.fn(ok);
    const route = withRoute({ auth: bearer, rateLimit }, handler);
    for (const h of [{}, { authorization: "Bearer bogus" }, { authorization: `bearer ${USER_JWT}` }] as Record<
      string,
      string
    >[]) {
      const res = await route(req(h));
      expect(res.status).toBe(401);
    }
    expect(handler).not.toHaveBeenCalled();
    expect(rlKeys).toEqual([]);
  });
  it("a rate-limited request never calls the handler and returns rateLimited()", async () => {
    rlAllowed = false;
    const handler = vi.fn(ok);
    const res = await withRoute({ auth: bearer, rateLimit }, handler)(req({ authorization: `Bearer ${USER_JWT}` }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("7");
    expect(await res.json()).toEqual({ error: "Rate limit exceeded", retry_after: 7 });
    expect(handler).not.toHaveBeenCalled();
    expect(rlKeys).toEqual([`sync:user:${USER_ID}`]);
  });
  it("a passing request reaches the handler with the authenticated user and client, once", async () => {
    const handler = vi.fn(async ({ user, supabase }: { user: { id: string }; supabase: unknown }) => {
      expect(supabase).toBeDefined();
      return NextResponse.json({ id: user.id });
    });
    const res = await withRoute({ auth: bearer, rateLimit }, handler)(req({ authorization: `Bearer ${USER_JWT}` }));
    expect(await res.json()).toEqual({ id: USER_ID });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(rlKeys).toEqual([`sync:user:${USER_ID}`]);
  });
  it("no rateLimit option means no limiter call", async () => {
    await withRoute({ auth: bearer }, ok)(req({ authorization: `Bearer ${USER_JWT}` }));
    expect(rlKeys).toEqual([]);
  });
});

describe("CORS on every exit", () => {
  const route = (handler = ok) => withRoute({ auth: bearer, rateLimit, cors: { methods: METHODS } }, handler);
  it("auth failure, 429 and the handler's response all carry CORS for an allowed origin", async () => {
    expect(acHeaders(await route()(req({ origin: ALLOWED })))).toEqual(CORS);
    rlAllowed = false;
    expect(acHeaders(await route()(req({ origin: ALLOWED, authorization: `Bearer ${USER_JWT}` })))).toEqual(CORS);
    rlAllowed = true;
    expect(acHeaders(await route()(req({ origin: ALLOWED, authorization: `Bearer ${USER_JWT}` })))).toEqual(CORS);
  });
  it("adds nothing for a denied or missing origin", async () => {
    for (const h of [{ origin: "https://evil.example" }, {}] as Record<string, string>[]) {
      expect(acHeaders(await route()(req(h)))).toEqual({});
      expect(acHeaders(await route()(req({ ...h, authorization: `Bearer ${USER_JWT}` })))).toEqual({});
    }
  });
  it("adds nothing on any exit when cors is unset, even for an allowed origin", async () => {
    const r = withRoute({ auth: bearer, rateLimit }, ok);
    expect(acHeaders(await r(req({ origin: ALLOWED })))).toEqual({});
    expect(acHeaders(await r(req({ origin: ALLOWED, authorization: `Bearer ${USER_JWT}` })))).toEqual({});
  });
  it("passes the request Origin to the handler", async () => {
    const handler = vi.fn(async ({ origin }: { origin: string | null }) => NextResponse.json({ origin }));
    const res = await route(handler as never)(req({ origin: ALLOWED, authorization: `Bearer ${USER_JWT}` }));
    expect(await res.json()).toEqual({ origin: ALLOWED });
  });
});

describe("ctx forwarding", () => {
  it("forwards Next's ctx object and its params promise untouched", async () => {
    const params = Promise.resolve({ id: "x" });
    const ctx = { params };
    let seen: unknown;
    const route = withRoute<{ kind: "none" }, typeof ctx>({ auth: { kind: "none" } }, async (input) => {
      seen = input.ctx;
      expect(input.ctx.params).toBe(params);
      return ok();
    });
    await route(req(), ctx);
    expect(seen).toBe(ctx);
  });
  it("runs with ctx === undefined when the caller omits it (a route with no dynamic segment)", async () => {
    let seen: unknown = "not called";
    const route = withRoute({ auth: { kind: "none" } }, async (input) => {
      seen = input.ctx;
      return ok();
    });
    const res = await route(req());
    expect(res.status).toBe(200);
    expect(seen).toBeUndefined();
  });
});

describe("auth kinds", () => {
  it('"none": handler runs with no user or client; a rate limit can key on the request', async () => {
    const handler = vi.fn(async (input: { user?: unknown; supabase?: unknown }) => {
      expect(input.user).toBeUndefined();
      expect(input.supabase).toBeUndefined();
      return ok();
    });
    const r = withRoute(
      { auth: { kind: "none" }, rateLimit: { name: "sync", bucket: ({ req: q }) => `ip:${q.headers.get("x-ip")}` } },
      handler,
    );
    expect((await r(req({ "x-ip": "1.2.3.4" }))).status).toBe(200);
    expect(rlKeys).toEqual(["ip:1.2.3.4"]);
  });
  it('"session": 401 without a cookie, handler with the cookie user', async () => {
    const handler = vi.fn(async ({ user }: { user: { id: string } }) => NextResponse.json({ id: user.id }));
    const r = withRoute({ auth: { kind: "session", unauthorized: "unauthorized" } }, handler);
    const denied = await r(req());
    expect(denied.status).toBe(401);
    expect(await denied.json()).toEqual({ error: "unauthorized" });
    expect(handler).not.toHaveBeenCalled();
    boundary.setCookie(AUTH_COOKIE, USER_JWT);
    expect(await (await r(req())).json()).toEqual({ id: USER_ID });
  });
  it('"cron": 503 unset, 403 mismatch, handler on the exact secret', async () => {
    const handler = vi.fn(ok);
    const r = withRoute({ auth: { kind: "cron", logPrefix: "cron/x", notConfigured: "nc", forbidden: "fb" } }, handler);
    vi.stubEnv("CRON_SECRET", "");
    expect((await r(req({ authorization: "Bearer s3" }))).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "s3");
    expect((await r(req({ authorization: "Bearer nope" }))).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
    expect((await r(req({ authorization: "Bearer s3" }))).status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('"dual" / "key" kinds and requestId (R4 4.11)', () => {
  const dual = {
    kind: "dual",
    missing: "Missing authorization",
    invalidToken: "Invalid token",
    invalidKey: "Invalid API key",
    scoped: { reject: "no scoped" },
  } as const;
  const dualRl = {
    name: "mcp",
    bucket: ({ userId, key }: { userId: string; key: { prefix: string } | null }) =>
      key ? keyBucket("mcp", key.prefix) : userBucket("mcp", userId),
  } as const;

  it("JWT -> handler with userId and key null; bucket keyed on the user", async () => {
    const handler = vi.fn(async ({ userId, key }: { userId: string; key: unknown }) =>
      NextResponse.json({ userId, key }),
    );
    const r = withRoute({ auth: dual, rateLimit: dualRl }, handler);
    expect(await (await r(req({ authorization: `Bearer ${USER_JWT}` }))).json()).toEqual({
      userId: USER_ID,
      key: null,
    });
    expect(rlKeys).toEqual([userBucket("mcp", USER_ID)]);
  });
  it("unscoped lls_ key -> handler with userId and the key; bucket keyed on the key prefix", async () => {
    const handler = vi.fn(async ({ userId, key }: { userId: string; key: { prefix: string } | null }) =>
      NextResponse.json({ userId, prefix: key?.prefix }),
    );
    const r = withRoute({ auth: dual, rateLimit: dualRl }, handler);
    expect(await (await r(req({ authorization: `Bearer ${API_KEY}` }))).json()).toEqual({
      userId: USER_ID,
      prefix: API_KEY.slice(0, 8),
    });
    expect(rlKeys).toEqual([keyBucket("mcp", API_KEY.slice(0, 8))]);
  });
  it("scoped key 403, bad key 401, missing 401: none reach the limiter or the handler", async () => {
    const handler = vi.fn(ok);
    const r = withRoute({ auth: dual, rateLimit: dualRl }, handler);
    const scoped = await r(req({ authorization: `Bearer ${SCOPED_KEY}` }));
    expect([scoped.status, await scoped.json()]).toEqual([403, { error: "no scoped" }]);
    const bad = await r(req({ authorization: "Bearer lls_not_a_real_key" }));
    expect([bad.status, await bad.json()]).toEqual([401, { error: "Invalid API key" }]);
    const missing = await r(req());
    expect([missing.status, await missing.json()]).toEqual([401, { error: "Missing authorization" }]);
    expect(handler).not.toHaveBeenCalled();
    // The only limiter calls are the failed-key throttle (clientIp threaded), never the route bucket.
    expect(rlKeys.every((k) => k.startsWith("keyfail:ip:"))).toBe(true);
  });
  it('"key": a JWT is 401 notKey and never reaches the handler', async () => {
    const handler = vi.fn(ok);
    const r = withRoute(
      { auth: { kind: "key", missing: "m", notKey: "Provide an lls_ API key", invalidKey: "bad", scoped: "allow" } },
      handler,
    );
    const res = await r(req({ authorization: `Bearer ${USER_JWT}` }));
    expect([res.status, await res.json()]).toEqual([401, { error: "Provide an lls_ API key" }]);
    expect(handler).not.toHaveBeenCalled();
    expect((await r(req({ authorization: `Bearer ${SCOPED_KEY}` }))).status).toBe(200);
  });
  it("requestId: one id per request, stamped on auth failures and handed to the handler; not on a 429", async () => {
    const handler = vi.fn(async ({ rid }: { rid?: string }) => NextResponse.json({ rid }));
    const r = withRoute({ auth: dual, requestId: true, rateLimit: dualRl }, handler);
    const denied = await r(req({ "x-request-id": "rid-in" }));
    expect(denied.headers.get("x-request-id")).toBe("rid-in");
    const scoped = await r(req({ authorization: `Bearer ${SCOPED_KEY}`, "x-request-id": "rid-s" }));
    expect(scoped.headers.get("x-request-id")).toBe("rid-s");
    expect(await (await r(req({ authorization: `Bearer ${API_KEY}`, "x-request-id": "rid-ok" }))).json()).toEqual({
      rid: "rid-ok",
    });
    rlAllowed = false;
    const limited = await r(req({ authorization: `Bearer ${API_KEY}`, "x-request-id": "rid-429" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("7");
  });
  it("without requestId the handler gets no rid and auth failures carry no x-request-id", async () => {
    const handler = vi.fn(async ({ rid }: { rid?: string }) => NextResponse.json({ rid: rid ?? null }));
    const r = withRoute({ auth: dual }, handler);
    expect((await r(req({ "x-request-id": "x" }))).headers.get("x-request-id")).toBeNull();
    expect(await (await r(req({ authorization: `Bearer ${USER_JWT}` }))).json()).toEqual({ rid: null });
  });
  it("type level: dual buckets get userId + nullable key; key buckets a non-null key", () => {
    withRoute(
      {
        auth: dual,
        // @ts-expect-error -- `user` does not exist on a dual-auth bucket input
        rateLimit: { name: "mcp", bucket: (input) => input.user.id },
      },
      ok,
    );
    withRoute(
      {
        auth: dual,
        // @ts-expect-error -- `key` may be null for a JWT caller
        rateLimit: { name: "mcp", bucket: ({ key }) => key.prefix },
      },
      ok,
    );
    withRoute(
      {
        auth: { kind: "key", missing: "m", notKey: "n", invalidKey: "i", scoped: "allow" },
        rateLimit: { name: "mcp", bucket: ({ key }) => key.prefix },
      },
      ok,
    );
  });
});

describe("fail closed and bucket typing (3A-3 adversarial review)", () => {
  it("an unknown auth kind rejects and never runs the handler or the limiter", async () => {
    const h = vi.fn(ok);
    const r = withRoute({ auth: { kind: "Bearer" } as never, rateLimit: rateLimit as never }, h);
    await expect(r(req({ authorization: `Bearer ${USER_JWT}` }))).rejects.toThrow("withRoute: unknown auth kind");
    expect(h).not.toHaveBeenCalled();
    expect(rlKeys).toEqual([]);
  });
  it('"none" passes the bucket exactly { req }', async () => {
    const bucket = vi.fn((_input: { req: Request }) => "k");
    const q = req();
    await withRoute({ auth: { kind: "none" }, rateLimit: { name: "sync", bucket } }, ok)(q);
    expect(bucket).toHaveBeenCalledTimes(1);
    const input = bucket.mock.calls[0][0];
    expect(Object.keys(input)).toEqual(["req"]);
    expect(input.req).toBe(q);
  });
  it("type level: no user in a none/cron bucket, a required user in bearer/session", () => {
    withRoute(
      {
        auth: { kind: "none" },
        rateLimit: {
          name: "sync",
          // @ts-expect-error -- `user` does not exist on a none-auth bucket input
          bucket: (input) => userBucket("sync", input.user.id),
        },
      },
      ok,
    );
    withRoute(
      {
        auth: { kind: "cron", logPrefix: "p", notConfigured: "n", forbidden: "f" },
        // @ts-expect-error -- `user` does not exist on a cron-auth bucket input
        rateLimit: { name: "sync", bucket: (input) => userBucket("sync", input.user.id) },
      },
      ok,
    );
    withRoute(
      { auth: { kind: "session", unauthorized: "u" }, rateLimit: { name: "sync", bucket: ({ user }) => user.id } },
      ok,
    );
  });
});

describe("what the wrapper does not do", () => {
  it("does not catch a handler's thrown error", async () => {
    const r = withRoute({ auth: { kind: "none" }, cors: { methods: METHODS } }, async () => {
      throw new Error("boom");
    });
    await expect(r(req({ origin: ALLOWED }))).rejects.toThrow("boom");
  });
  it("does not read the request body", async () => {
    const q = req({ authorization: `Bearer ${USER_JWT}` }, { body: '{"a":1}' });
    let usedBeforeHandler: boolean | undefined;
    await withRoute({ auth: bearer, rateLimit }, async ({ req: r }) => {
      usedBeforeHandler = r.bodyUsed;
      return NextResponse.json(await r.json());
    })(q);
    expect(usedBeforeHandler).toBe(false);
  });
});
