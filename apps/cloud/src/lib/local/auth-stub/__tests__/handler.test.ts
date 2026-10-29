import { describe, expect, it } from "vitest";
import { type AuthStubDeps, handleAuthRequest } from "../handler";
import { signJwt, verifyJwt } from "../jwt";
import { createWindowLimiter } from "../rate-limit";
import { fakeStore, seedUser } from "./fake-store";

const SECRET = "test-secret-test-secret-test-secret";
const T0 = 1_800_000_000_000;
const sign = (role: string, extra: Record<string, unknown> = {}) =>
  signJwt({ role, iat: T0 / 1000, exp: T0 / 1000 + 10_000, ...extra }, SECRET);
const ANON = sign("anon", { exp: T0 / 1000 + 90 * 86_400 }); // long-lived like the real keys
const SERVICE = sign("service_role", { exp: T0 / 1000 + 90 * 86_400 });

function setup(over: Partial<AuthStubDeps> = {}) {
  const clock = { now: T0 };
  const s = fakeStore(clock);
  const deps: AuthStubDeps = {
    store: s.store,
    jwtSecret: SECRET,
    port: "3001",
    nowMs: () => clock.now,
    emailLimiter: createWindowLimiter(100, 60_000),
    globalLimiter: createWindowLimiter(100, 60_000),
    ...over,
  };
  const call = (
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; bearer?: string; apikey?: string | null } = {},
  ) => {
    const headers: Record<string, string> = {
      host: "127.0.0.1:3001",
      ...(method !== "GET" ? { "content-type": "application/json;charset=UTF-8" } : {}),
      ...(opts.apikey === null ? {} : { apikey: opts.apikey ?? ANON }),
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
      ...opts.headers,
    };
    const [p, q] = path.split("?");
    const req = new Request(`http://127.0.0.1:3001/auth/v1/${p}${q ? `?${q}` : ""}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    return handleAuthRequest(req, (p as string).split("/"), deps);
  };
  return {
    s,
    call,
    advance: (ms: number) => {
      clock.now += ms;
    },
  };
}

const login = (t: ReturnType<typeof setup>, password = "correct horse", email = "me@codehub.test") =>
  t.call("POST", "token?grant_type=password", { body: { email, password } });

describe("password grant", () => {
  it("returns a GoTrue session shape for the right password", async () => {
    const t = setup();
    const user = await seedUser(t.s);
    const res = await login(t);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ token_type: "bearer", expires_in: 3600, expires_at: T0 / 1000 + 3600 });
    expect(typeof body.refresh_token).toBe("string");
    expect(body.user).toMatchObject({ id: user.id, email: "me@codehub.test", aud: "authenticated" });
    const claims = verifyJwt(body.access_token, SECRET, T0 / 1000);
    expect(claims).toMatchObject({ sub: user.id, role: "authenticated", aud: "authenticated" });
    expect(claims?.session_id).toBeTruthy();
  });

  it("rejects a wrong password with GoTrue's invalid_credentials body", async () => {
    const t = setup();
    await seedUser(t.s);
    const res = await login(t, "nope");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error_code: "invalid_credentials", msg: "Invalid login credentials" });
  });

  it("answers an unknown email exactly like a wrong password", async () => {
    const t = setup();
    await seedUser(t.s);
    const a = await login(t, "x", "nobody@codehub.test");
    const b = await login(t, "x");
    expect(a.status).toBe(b.status);
    expect(await a.json()).toEqual(await b.json());
  });

  it("refuses an unconfirmed user", async () => {
    const t = setup();
    await t.s.store.create({
      email: "u@codehub.test",
      passwordHash: (await import("bcryptjs")).default.hashSync("pw", 4),
      userMetadata: {},
      confirmed: false,
    });
    const res = await login(t, "pw", "u@codehub.test");
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe("email_not_confirmed");
  });

  it("rate-limits the password grant per email", async () => {
    const t = setup({ emailLimiter: createWindowLimiter(3, 60_000) });
    await seedUser(t.s);
    for (let i = 0; i < 3; i++) expect((await login(t, "nope")).status).toBe(400);
    const res = await login(t, "correct horse");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    t.advance(61_000);
    expect((await login(t)).status).toBe(200);
  });

  it("rate-limits across emails with the global limiter", async () => {
    const t = setup({ globalLimiter: createWindowLimiter(2, 60_000) });
    await login(t, "x", "a@codehub.test");
    await login(t, "x", "b@codehub.test");
    expect((await login(t, "x", "c@codehub.test")).status).toBe(429);
  });
});

describe("tokens and /user", () => {
  it("GET /user returns the user for a valid access token", async () => {
    const t = setup();
    const user = await seedUser(t.s);
    const { access_token } = await (await login(t)).json();
    const res = await t.call("GET", "user", { bearer: access_token });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: user.id, email: "me@codehub.test" });
  });

  it("rejects an expired access token", async () => {
    const t = setup();
    await seedUser(t.s);
    const { access_token } = await (await login(t)).json();
    t.advance(3601 * 1000);
    const res = await t.call("GET", "user", { bearer: access_token });
    expect(res.status).toBe(401);
  });

  it("rejects a token signed with another secret, alg none, and the anon key", async () => {
    const t = setup();
    const user = await seedUser(t.s);
    const claims = { sub: user.id, role: "authenticated", exp: T0 / 1000 + 100 };
    expect((await t.call("GET", "user", { bearer: signJwt(claims, "other-secret") })).status).toBe(401);
    const none = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.`;
    expect((await t.call("GET", "user", { bearer: none })).status).toBe(401);
    expect((await t.call("GET", "user", { bearer: ANON })).status).toBe(401);
  });

  it("rejects a request whose apikey is missing or not signed by this secret", async () => {
    const t = setup();
    await seedUser(t.s);
    expect((await t.call("POST", "token?grant_type=password", { apikey: null, body: {} })).status).toBe(401);
    expect(
      (await t.call("POST", "token?grant_type=password", { apikey: signJwt({ role: "anon" }, "x"), body: {} })).status,
    ).toBe(401);
  });
});

describe("refresh and logout", () => {
  it("rotates the refresh token and rejects the old one after use", async () => {
    const t = setup();
    await seedUser(t.s);
    const first = await (await login(t)).json();
    const res = await t.call("POST", "token?grant_type=refresh_token", {
      body: { refresh_token: first.refresh_token },
    });
    expect(res.status).toBe(200);
    const second = await res.json();
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(verifyJwt(second.access_token, SECRET, T0 / 1000)?.session_id).toBe(
      verifyJwt(first.access_token, SECRET, T0 / 1000)?.session_id,
    );
    t.advance(11_000); // past the 10 s reuse interval
    const replay = await t.call("POST", "token?grant_type=refresh_token", {
      body: { refresh_token: first.refresh_token },
    });
    expect(replay.status).toBe(400);
    expect((await replay.json()).error_code).toBe("refresh_token_not_found");
  });

  it("parallel refreshes with one cookie share a session instead of logging the user out (reuse interval)", async () => {
    const t = setup();
    await seedUser(t.s);
    const first = await (await login(t)).json();
    const refresh = () =>
      t.call("POST", "token?grant_type=refresh_token", { body: { refresh_token: first.refresh_token } });
    const [a, b, c] = await Promise.all([refresh(), refresh(), refresh()]);
    for (const r of [a, b, c]) expect(r.status).toBe(200);
    const bodies = await Promise.all([a.json(), b.json(), c.json()]);
    expect(new Set(bodies.map((x) => x.refresh_token)).size).toBe(1);
    expect(bodies[0].refresh_token).not.toBe(first.refresh_token);
    // Still inside the interval, and again just before its end.
    t.advance(9_000);
    expect((await refresh()).status).toBe(200);
  });

  it("reusing a spent token after the interval is rejected and revokes the whole family", async () => {
    const t = setup();
    await seedUser(t.s);
    const first = await (await login(t)).json();
    const child = await (
      await t.call("POST", "token?grant_type=refresh_token", { body: { refresh_token: first.refresh_token } })
    ).json();
    t.advance(11_000);
    const replay = await t.call("POST", "token?grant_type=refresh_token", {
      body: { refresh_token: first.refresh_token },
    });
    expect(replay.status).toBe(400);
    // The child (the live token of the same session) died with the family.
    const after = await t.call("POST", "token?grant_type=refresh_token", {
      body: { refresh_token: child.refresh_token },
    });
    expect(after.status).toBe(400);
  });

  it("refresh tokens expire after 30 days", async () => {
    const t = setup();
    await seedUser(t.s);
    const first = await (await login(t)).json();
    t.advance(31 * 24 * 3_600_000);
    const res = await t.call("POST", "token?grant_type=refresh_token", {
      body: { refresh_token: first.refresh_token },
    });
    expect(res.status).toBe(400);
  });

  it("refuses a banned user on password and refresh grants and GET /user", async () => {
    const t = setup();
    const u = await seedUser(t.s);
    const session = await (await login(t)).json();
    t.s.users.set(u.id, {
      ...(t.s.users.get(u.id) as object),
      banned_until: new Date(T0 + 3_600_000).toISOString(),
    } as never);
    expect((await login(t)).status).toBe(400);
    expect(
      (await t.call("POST", "token?grant_type=refresh_token", { body: { refresh_token: session.refresh_token } }))
        .status,
    ).toBe(400);
    expect((await t.call("GET", "user", { bearer: session.access_token })).status).toBe(403);
    t.advance(2 * 3_600_000);
    expect((await login(t)).status).toBe(200);
  });

  it("rejects an unknown refresh token", async () => {
    const t = setup();
    const res = await t.call("POST", "token?grant_type=refresh_token", { body: { refresh_token: "nope" } });
    expect(res.status).toBe(400);
  });

  it("logout (scope=global) revokes the user's refresh tokens", async () => {
    const t = setup();
    await seedUser(t.s);
    const a = await (await login(t)).json();
    const b = await (await login(t)).json();
    const out = await t.call("POST", "logout?scope=global", { bearer: a.access_token });
    expect(out.status).toBe(204);
    for (const s of [a, b]) {
      const r = await t.call("POST", "token?grant_type=refresh_token", { body: { refresh_token: s.refresh_token } });
      expect(r.status).toBe(400);
    }
  });

  it("logout scope=local revokes only that session", async () => {
    const t = setup();
    await seedUser(t.s);
    const a = await (await login(t)).json();
    const b = await (await login(t)).json();
    await t.call("POST", "logout?scope=local", { bearer: a.access_token });
    expect(
      (await t.call("POST", "token?grant_type=refresh_token", { body: { refresh_token: a.refresh_token } })).status,
    ).toBe(400);
    expect(
      (await t.call("POST", "token?grant_type=refresh_token", { body: { refresh_token: b.refresh_token } })).status,
    ).toBe(200);
  });

  it("logout requires a valid user JWT", async () => {
    const t = setup();
    expect((await t.call("POST", "logout?scope=global", {})).status).toBe(401);
  });
});

describe("admin endpoints", () => {
  it("reject a user JWT and the anon key, accept a service-role JWT", async () => {
    const t = setup();
    await seedUser(t.s);
    const { access_token } = await (await login(t)).json();
    expect((await t.call("GET", "admin/users", { bearer: access_token })).status).toBe(403);
    expect((await t.call("GET", "admin/users", { bearer: ANON })).status).toBe(403);
    expect((await t.call("GET", "admin/users", {})).status).toBe(403);
    expect(
      (await t.call("POST", "admin/users", { bearer: access_token, body: { email: "x@codehub.test", password: "p" } }))
        .status,
    ).toBe(403);
    expect((await t.call("GET", "admin/users", { bearer: SERVICE })).status).toBe(200);
  });

  it("creates a user whose bcrypt hash then signs in", async () => {
    const t = setup();
    const res = await t.call("POST", "admin/users", {
      bearer: SERVICE,
      body: { email: "New@CodeHub.test", password: "pw-12345", email_confirm: true },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: "new@codehub.test" });
    expect((await login(t, "pw-12345", "new@codehub.test")).status).toBe(200);
    const dup = await t.call("POST", "admin/users", {
      bearer: SERVICE,
      body: { email: "new@codehub.test", password: "x", email_confirm: true },
    });
    expect(dup.status).toBe(422);
  });

  it("lists with x-total-count and gets a user by id", async () => {
    const t = setup();
    const u = await seedUser(t.s);
    const list = await t.call("GET", "admin/users?page=1&per_page=50", { bearer: SERVICE });
    expect(list.headers.get("x-total-count")).toBe("1");
    expect((await list.json()).users).toHaveLength(1);
    const one = await t.call("GET", `admin/users/${u.id}`, { bearer: SERVICE });
    expect(await one.json()).toMatchObject({ id: u.id });
    expect((await t.call("GET", "admin/users/00000000-0000-4000-8000-0000000000ff", { bearer: SERVICE })).status).toBe(
      404,
    );
  });

  it("does not support deleteUser", async () => {
    const t = setup();
    const u = await seedUser(t.s);
    const res = await t.call("DELETE", `admin/users/${u.id}`, { bearer: SERVICE });
    expect(res.status).toBe(404);
    expect((await res.json()).msg).toContain(`/auth/v1/admin/users/${u.id}`);
  });
});

describe("browser exposure", () => {
  it("refuses a non-loopback Host", async () => {
    const t = setup();
    await seedUser(t.s);
    for (const host of ["evil.example:3001", "127.0.0.1.evil.example:3001", "127.0.0.1:9999"]) {
      const res = await t.call("POST", "token?grant_type=password", {
        headers: { host },
        body: { email: "me@codehub.test", password: "correct horse" },
      });
      expect(res.status, host).toBe(403);
    }
    expect((await t.call("GET", "user", { headers: { host: "localhost:3001" }, bearer: ANON })).status).toBe(401);
  });

  it("refuses a non-JSON content type on writes", async () => {
    const t = setup();
    await seedUser(t.s);
    const res = await t.call("POST", "token?grant_type=password", {
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: { email: "me@codehub.test", password: "correct horse" },
    });
    expect(res.status).toBe(415);
  });

  it("answers 404 naming any other path", async () => {
    const t = setup();
    for (const [m, p] of [
      ["POST", "otp"],
      ["GET", "authorize"],
      ["GET", "settings"],
    ] as const) {
      const res = await t.call(m, p, { body: m === "POST" ? {} : undefined });
      expect(res.status, p).toBe(404);
      expect((await res.json()).msg).toContain(`/auth/v1/${p}`);
    }
    expect((await t.call("POST", "token?grant_type=pkce", { body: {} })).status).toBe(400);
  });

  it("checks the Host is loopback even when PORT is unset (any loopback port passes)", async () => {
    const t = setup({ port: undefined });
    await seedUser(t.s);
    const ok = await t.call("POST", "token?grant_type=password", {
      headers: { host: "127.0.0.1:9999" },
      body: { email: "me@codehub.test", password: "correct horse" },
    });
    expect(ok.status).toBe(200);
    const bad = await t.call("POST", "token?grant_type=password", {
      headers: { host: "evil.example:3001" },
      body: { email: "me@codehub.test", password: "correct horse" },
    });
    expect(bad.status).toBe(403);
  });

  it("answers a GoTrue-shaped JSON error when the store throws (never a bare 500)", async () => {
    const t = setup();
    await seedUser(t.s);
    t.s.store.findByEmail = async () => {
      throw new Error("local_auth_find_user: connection refused");
    };
    const res = await login(t);
    expect(res.status).toBe(500);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ code: 500, error_code: "unexpected_failure", msg: expect.any(String) });
  });

  it("fails closed when no JWT secret is configured", async () => {
    const t = setup({ jwtSecret: undefined });
    expect((await login(t)).status).toBe(500);
  });
});
