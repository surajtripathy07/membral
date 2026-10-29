// A real @supabase/supabase-js client whose fetch is the stub handler: proves the response shapes are what
// @supabase/auth-js parses, with no HTTP server.
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { handleAuthRequest } from "../handler";
import { signJwt } from "../jwt";
import { createWindowLimiter } from "../rate-limit";
import { fakeStore, seedUser } from "./fake-store";

const SECRET = "integration-secret-integration-secret";
const anon = signJwt({ role: "anon", iat: 1 }, SECRET);
const service = signJwt({ role: "service_role", iat: 1 }, SECRET);

function clients() {
  const s = fakeStore();
  const customFetch: typeof fetch = async (input, init) => {
    const req = new Request(input as RequestInfo, init);
    const url = new URL(req.url);
    expect(url.pathname.startsWith("/auth/v1/")).toBe(true);
    const path = url.pathname.slice("/auth/v1/".length).split("/");
    return handleAuthRequest(req, path, {
      store: s.store,
      jwtSecret: SECRET,
      port: "3001",
      emailLimiter: createWindowLimiter(100, 60_000),
      globalLimiter: createWindowLimiter(100, 60_000),
    });
  };
  const opts = { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: customFetch } };
  const url = "http://127.0.0.1:3001";
  return { s, user: createClient(url, anon, opts), admin: createClient(url, service, opts) };
}

describe("supabase-js against the stub", () => {
  it("signInWithPassword, getUser, refreshSession, signOut", async () => {
    const c = clients();
    const seeded = await seedUser(c.s);

    const bad = await c.user.auth.signInWithPassword({ email: "me@codehub.test", password: "nope" });
    expect(bad.error?.code).toBe("invalid_credentials");

    const signed = await c.user.auth.signInWithPassword({ email: "me@codehub.test", password: "correct horse" });
    expect(signed.error).toBeNull();
    const session = signed.data.session;
    expect(session?.access_token).toBeTruthy();
    expect(session?.refresh_token).toBeTruthy();
    expect(session?.token_type).toBe("bearer");
    expect(session?.expires_in).toBe(3600);
    expect(typeof session?.expires_at).toBe("number");
    expect(session?.user.id).toBe(seeded.id);

    const got = await c.user.auth.getUser(session?.access_token);
    expect(got.error).toBeNull();
    expect(got.data.user?.email).toBe("me@codehub.test");

    const refreshed = await c.user.auth.refreshSession({ refresh_token: session?.refresh_token as string });
    expect(refreshed.error).toBeNull();
    expect(refreshed.data.session?.refresh_token).not.toBe(session?.refresh_token);

    // signOut (global scope) revokes everything, including the rotated token; the pre-rotation one was already dead.
    const out = await c.user.auth.signOut();
    expect(out.error).toBeNull();
    const after = await c.user.auth.refreshSession({ refresh_token: refreshed.data.session?.refresh_token as string });
    expect(after.error).not.toBeNull();
    const replay = await c.user.auth.refreshSession({ refresh_token: session?.refresh_token as string });
    expect(replay.error).not.toBeNull();
  });

  it("admin createUser, listUsers, getUserById", async () => {
    const c = clients();
    const made = await c.admin.auth.admin.createUser({
      email: "a@codehub.test",
      password: "pw-12345",
      email_confirm: true,
    });
    expect(made.error).toBeNull();
    const listed = await c.admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
    expect(listed.error).toBeNull();
    expect(listed.data.users.map((u) => u.email)).toEqual(["a@codehub.test"]);
    const one = await c.admin.auth.admin.getUserById(made.data.user?.id as string);
    expect(one.data.user?.email).toBe("a@codehub.test");
    // A user-scoped client cannot use the admin API.
    const denied = await c.user.auth.admin.listUsers();
    expect(denied.error).not.toBeNull();
  });
});
