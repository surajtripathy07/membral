// Equivalence proof for withRoute (G3 step 3A-3) without repointing any route.
// The oracle is each route's committed contract file in __golden__/routes/ —
// the real handler's recorded status, header subset and body under the same
// mocked boundaries — so lib/api never imports app/. For the shell's exits
// (auth failure, 429) the withRoute copy must reproduce the contract byte for
// byte; for request shapes the goldens lock only with an allowed Origin
// (denied / missing Origin on POST), the expected result is the same contract
// with the CORS headers removed, which is what withCors does for those origins.
import { readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("../../../__golden__/routes/boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("../../../__golden__/routes/boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("../../../__golden__/routes/boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("../../../__golden__/routes/boundary")).after,
}));

import { setCookie } from "../../../__golden__/routes/boundary";
import {
  AUTH_COOKIE,
  callRoute,
  type RouteResult,
  setRateLimitAllowed,
  setupRouteGolden,
  USER_ID,
  USER_JWT,
} from "../../../__golden__/routes/harness";
import { userBucket } from "../../rate-limit";
import { withRoute } from "../route";

setupRouteGolden(() => ({}));

const golden = (name: string): RouteResult =>
  JSON.parse(readFileSync(new URL(`../../../__golden__/routes/${name}.json`, import.meta.url), "utf8"));

function withoutCors(r: RouteResult): RouteResult {
  const headers = Object.fromEntries(
    Object.entries(r.headers).filter(([k]) => !k.startsWith("access-control-") && k !== "vary"),
  );
  return { ...r, headers };
}

const MARKER = { reached: "handler" };

// The shell of app/api/sync/route.ts POST: requireBearerUser -> enforceRateLimit("sync",
// userBucket) -> body, every exit through withCors(..., "POST, OPTIONS").
const syncPOST = withRoute(
  {
    auth: { kind: "bearer", missing: "Missing authorization", invalid: "Invalid token" },
    rateLimit: { name: "sync", bucket: ({ user }) => userBucket("sync", user.id) },
    cors: { methods: "POST, OPTIONS" },
  },
  async ({ user }) => NextResponse.json({ ...MARKER, user: user.id }),
);

// The shell of app/api/pulse/route.ts GET: requireSessionUser, no rate limit, no CORS.
const pulseGET = withRoute({ auth: { kind: "session", unauthorized: "unauthorized" } }, async ({ user }) =>
  NextResponse.json({ ...MARKER, user: user.id }),
);

const ORIGIN = { origin: `chrome-extension://${"a".repeat(32)}` };
const post = (headers: Record<string, string>) =>
  callRoute(syncPOST, { method: "POST", path: "/api/sync", headers, body: { conversations: [] } });

describe("withRoute reproduces POST /api/sync's shell", () => {
  const cases: [string, Record<string, string>][] = [
    ["sync.no-auth", {}],
    ["sync.bearer-bogus", { authorization: "Bearer bogus" }],
    ["sync.bearer-lowercase", { authorization: `bearer ${USER_JWT}` }],
    ["sync.bearer-empty", { authorization: "Bearer " }],
    ["sync.auth-basic", { authorization: "Basic x" }],
  ];
  for (const [name, auth] of cases) {
    it(`${name}: allowed origin matches the contract`, async () => {
      expect(await post({ ...ORIGIN, ...auth })).toEqual(golden(name));
    });
    it(`${name}: denied and missing origin match the contract minus CORS`, async () => {
      expect(await post({ origin: "https://evil.example", ...auth })).toEqual(withoutCors(golden(name)));
      expect(await post(auth)).toEqual(withoutCors(golden(name)));
    });
  }
  it("sync.rate-limited: 429 matches the contract, with and without an allowed origin", async () => {
    setRateLimitAllowed(false);
    const authz = { authorization: `Bearer ${USER_JWT}` };
    expect(await post({ ...ORIGIN, ...authz })).toEqual(golden("sync.rate-limited"));
    expect(await post({ origin: "https://evil.example", ...authz })).toEqual(withoutCors(golden("sync.rate-limited")));
    expect(await post(authz)).toEqual(withoutCors(golden("sync.rate-limited")));
  });
  it("an authenticated, allowed request reaches the handler with the contract's CORS headers", async () => {
    const res = await post({ ...ORIGIN, authorization: `Bearer ${USER_JWT}` });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ...MARKER, user: USER_ID });
    const cors = Object.fromEntries(
      Object.entries(golden("sync.rate-limited").headers).filter(
        ([k]) => k.startsWith("access-control-") || k === "vary",
      ),
    );
    expect(Object.fromEntries(Object.entries(res.headers).filter(([k]) => k in cors))).toEqual(cors);
  });
});

describe("withRoute reproduces GET /api/pulse's shell", () => {
  it("pulse.no-auth", async () => {
    expect(await callRoute(pulseGET, { path: "/api/pulse" })).toEqual(golden("pulse.no-auth"));
  });
  it("pulse.expired-cookie", async () => {
    setCookie(AUTH_COOKIE, "expired-session-jwt");
    expect(await callRoute(pulseGET, { path: "/api/pulse" })).toEqual(golden("pulse.expired-cookie"));
  });
  it("an authenticated cookie request reaches the handler", async () => {
    const res = await callRoute(pulseGET, { path: "/api/pulse", as: "cookie" });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ...MARKER, user: USER_ID });
  });
  it("adds no CORS header even for an extension origin", async () => {
    const res = await callRoute(pulseGET, { path: "/api/pulse", headers: ORIGIN });
    expect(res).toEqual(golden("pulse.no-auth"));
  });
});
