// Unit tests for the auth adapters. Same boundary as the route contracts:
// @supabase/supabase-js, @supabase/ssr and next/headers are backed by the
// golden boundary's FakeDb (@membral/test-kit); no internal module is mocked.
import { NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("../../../__golden__/routes/boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("../../../__golden__/routes/boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("../../../__golden__/routes/boundary")).nextHeadersModule());

import * as boundary from "../../../__golden__/routes/boundary";
import { requireBearerOrKeyUser, requireBearerUser, requireCronSecret, requireSessionUser } from "../auth";

const req = (authorization?: string, extra: Record<string, string> = {}) =>
  new Request("http://localhost/api/x", { headers: { ...(authorization ? { authorization } : {}), ...extra } });

async function expectError(res: unknown, status: number, message: string, headers: Record<string, string> = {}) {
  expect(res).toBeInstanceOf(NextResponse);
  const r = res as NextResponse;
  expect(r.status).toBe(status);
  expect(r.headers.get("content-type")).toBe("application/json");
  for (const [k, v] of Object.entries(headers)) expect(r.headers.get(k)).toBe(v);
  expect(await r.json()).toEqual({ error: message });
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://supabase.golden.test");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "golden-anon-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "golden-service-key");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  boundary.reset();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("requireBearerUser", () => {
  const messages = { missing: "M-missing", invalid: "M-invalid" };

  it("401 with the `missing` message when there is no Authorization header", async () => {
    await expectError(await requireBearerUser(req(), messages), 401, "M-missing");
  });
  it("401 `missing` when the scheme is not exactly `Bearer ` (case-sensitive)", async () => {
    await expectError(await requireBearerUser(req(`bearer ${boundary.USER_JWT}`), messages), 401, "M-missing");
  });
  it("401 with the `invalid` message when the token resolves to no user", async () => {
    await expectError(await requireBearerUser(req("Bearer not-a-jwt"), messages), 401, "M-invalid");
  });
  it("carries `init` headers on both 401s", async () => {
    const init = { headers: { "x-request-id": "rid-1" } };
    await expectError(await requireBearerUser(req(), { ...messages, init }), 401, "M-missing", {
      "x-request-id": "rid-1",
    });
    await expectError(await requireBearerUser(req("Bearer nope"), { ...messages, init }), 401, "M-invalid", {
      "x-request-id": "rid-1",
    });
  });
  it("returns the user and a service client for a valid JWT", async () => {
    const out = await requireBearerUser(req(`Bearer ${boundary.USER_JWT}`), messages);
    expect(out).not.toBeInstanceOf(NextResponse);
    const { user, supabase } = out as Exclude<typeof out, NextResponse>;
    expect(user.id).toBe(boundary.USER_ID);
    expect(typeof supabase.from).toBe("function");
  });
});

describe("requireSessionUser", () => {
  it("401 with the `unauthorized` message when there is no session cookie", async () => {
    await expectError(await requireSessionUser({ unauthorized: "S-unauth" }), 401, "S-unauth");
  });
  it("carries `init` headers on the 401", async () => {
    await expectError(
      await requireSessionUser({ unauthorized: "S-unauth", init: { headers: { "x-request-id": "rid-2" } } }),
      401,
      "S-unauth",
      { "x-request-id": "rid-2" },
    );
  });
  it("returns the user and the cookie client for a signed-in session", async () => {
    boundary.setCookie(boundary.AUTH_COOKIE, boundary.USER_JWT);
    const out = await requireSessionUser({ unauthorized: "S-unauth" });
    expect(out).not.toBeInstanceOf(NextResponse);
    expect((out as Exclude<typeof out, NextResponse>).user.id).toBe(boundary.USER_ID);
  });
});

describe("requireCronSecret", () => {
  const messages = { logPrefix: "cron/test", notConfigured: "C-503", forbidden: "C-403" };

  it("503 with the `notConfigured` message when CRON_SECRET is unset, logging the prefix", async () => {
    vi.stubEnv("CRON_SECRET", "");
    await expectError(requireCronSecret(req("Bearer anything"), messages), 503, "C-503");
    expect(JSON.stringify((console.error as ReturnType<typeof vi.fn>).mock.calls)).toContain(
      "cron/test: CRON_SECRET is not configured — refusing (503)",
    );
  });
  it("403 with the `forbidden` message on a missing or mismatched header", async () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    await expectError(requireCronSecret(req(), messages), 403, "C-403");
    await expectError(requireCronSecret(req("Bearer wrong"), messages), 403, "C-403");
    await expectError(requireCronSecret(req("bearer s3cret"), messages), 403, "C-403");
    expect(JSON.stringify((console.warn as ReturnType<typeof vi.fn>).mock.calls)).toContain(
      "cron/test: rejected — missing or mismatched Authorization header",
    );
  });
  it("null when the header is exactly Bearer + CRON_SECRET", () => {
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect(requireCronSecret(req("Bearer s3cret"), messages)).toBeNull();
  });
});

describe("requireBearerOrKeyUser (withRoute dual/key, R4 4.11)", () => {
  const dual = {
    missing: "D-missing",
    invalidToken: "D-invalid-token",
    invalidKey: "D-invalid-key",
    scoped: { reject: "D-scoped" },
  } as const;
  const keyOnly = { missing: "K-missing", notKey: "K-not-key", invalidKey: "K-invalid-key", scoped: "allow" } as const;

  it("401 `missing` without an Authorization header, or with a non-`Bearer ` scheme", async () => {
    await expectError(await requireBearerOrKeyUser(req(), dual, "dual"), 401, "D-missing");
    await expectError(await requireBearerOrKeyUser(req(`bearer ${boundary.API_KEY}`), dual, "dual"), 401, "D-missing");
    await expectError(await requireBearerOrKeyUser(req("Basic x"), dual, "dual"), 401, "D-missing");
  });
  it("JWT: resolves the user with no key principal", async () => {
    const out = await requireBearerOrKeyUser(req(`Bearer ${boundary.USER_JWT}`), dual, "dual");
    expect(out).toEqual({ userId: boundary.USER_ID, key: null });
  });
  it("JWT: 401 `invalidToken` when the token resolves to no user", async () => {
    await expectError(await requireBearerOrKeyUser(req("Bearer not-a-jwt"), dual, "dual"), 401, "D-invalid-token");
  });
  it("unscoped lls_ key: resolves the owner and an unscoped key principal", async () => {
    const out = await requireBearerOrKeyUser(req(`Bearer ${boundary.API_KEY}`), dual, "dual");
    expect(out).toEqual({
      userId: boundary.USER_ID,
      key: { prefix: boundary.API_KEY.slice(0, 8), scopeNodeId: null, scopeCodeProjectId: null, apiKeyId: null },
    });
  });
  it("scoped lls_ key: 403 with the reject message when scoped keys are rejected", async () => {
    await expectError(
      await requireBearerOrKeyUser(req(`Bearer ${boundary.SCOPED_KEY}`), dual, "dual"),
      403,
      "D-scoped",
    );
  });
  it("scoped lls_ key: passes with its scope when scoped keys are allowed", async () => {
    const out = await requireBearerOrKeyUser(
      req(`Bearer ${boundary.SCOPED_KEY}`),
      { ...dual, scoped: "allow" },
      "dual",
    );
    expect(out).toEqual({
      userId: boundary.USER_ID,
      key: {
        prefix: boundary.SCOPED_KEY.slice(0, 8),
        scopeNodeId: null,
        scopeCodeProjectId: boundary.PROJECT_ID,
        apiKeyId: boundary.SCOPED_KEY_ID,
      },
    });
  });
  it("bad lls_ key: 401 `invalidKey`", async () => {
    await expectError(
      await requireBearerOrKeyUser(req("Bearer lls_not_a_real_key"), dual, "dual"),
      401,
      "D-invalid-key",
    );
  });
  it("key mode: a JWT is 401 `notKey` and never resolved; a key still works", async () => {
    await expectError(
      await requireBearerOrKeyUser(req(`Bearer ${boundary.USER_JWT}`), keyOnly, "key"),
      401,
      "K-not-key",
    );
    const out = await requireBearerOrKeyUser(req(`Bearer ${boundary.SCOPED_KEY}`), keyOnly, "key");
    expect(out).toMatchObject({ userId: boundary.USER_ID, key: { scopeCodeProjectId: boundary.PROJECT_ID } });
  });
  it("carries `init` headers on 401 and 403", async () => {
    const init = { headers: { "x-request-id": "rid-3" } };
    await expectError(await requireBearerOrKeyUser(req(), { ...dual, init }, "dual"), 401, "D-missing", {
      "x-request-id": "rid-3",
    });
    await expectError(
      await requireBearerOrKeyUser(req(`Bearer ${boundary.SCOPED_KEY}`), { ...dual, init }, "dual"),
      403,
      "D-scoped",
      { "x-request-id": "rid-3" },
    );
  });
  it("threads the client IP: failed keys from one IP hit keyValidationFail (5/min) -> 429 + Retry-After", async () => {
    const hits = new Map<string, number>();
    const buckets: string[] = [];
    boundary.reset({
      rate_limit_check: (a) => {
        const k = a.p_key as string;
        buckets.push(k);
        const n = (hits.get(k) ?? 0) + 1;
        hits.set(k, n);
        const allowed = n <= (a.p_limit as number);
        return { data: { allowed, retry_after: allowed ? 0 : 60, remaining: 0 }, error: null };
      },
    });
    const ip = { "x-forwarded-for": "198.51.100.4" };
    for (let i = 0; i < 5; i++) {
      await expectError(
        await requireBearerOrKeyUser(req(`Bearer lls_guess_${i}`, ip), dual, "dual"),
        401,
        "D-invalid-key",
      );
    }
    const res = await requireBearerOrKeyUser(req("Bearer lls_guess_5", ip), dual, "dual");
    expect(res).toBeInstanceOf(NextResponse);
    const r = res as NextResponse;
    expect(r.status).toBe(429);
    expect(r.headers.get("retry-after")).toBe("60");
    expect(new Set(buckets)).toEqual(new Set(["keyfail:ip:198.51.100.4"]));
    // A valid key from the same IP is never throttled (successes are not counted).
    expect(await requireBearerOrKeyUser(req(`Bearer ${boundary.API_KEY}`, ip), dual, "dual")).toMatchObject({
      userId: boundary.USER_ID,
    });
  });
});
