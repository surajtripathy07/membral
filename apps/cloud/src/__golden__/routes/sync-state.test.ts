// Route contract: GET /api/sync-state (cookie session; the Today page's Sync & Memory State panel).
// Every table/RPC this route reads is individually try/catch'd and degrades to "not available yet"
// (see the route's own header) — nothing here needs new fixtures, the happy path locks whatever that
// graceful degradation produces over the existing seed.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { GET } from "@/app/api/sync-state/route";
import { setCookie } from "./boundary";
import { AUTH_COOKIE, callRoute, expectContract, expectReadLog, setupRouteGolden } from "./harness";

setupRouteGolden();

describe("GET /api/sync-state", () => {
  it("401 without a session", async () => {
    await expectContract("sync-state.no-auth", await callRoute(GET, { path: "/api/sync-state" }));
  });
  // 3A-4 group 1 adversarial review lock-extend: an expired/invalid session
  // cookie (getUser errors), recorded as-is.
  it("401 for an expired/invalid session cookie", async () => {
    setCookie(AUTH_COOKIE, "expired-session-jwt");
    await expectContract("sync-state.expired-cookie", await callRoute(GET, { path: "/api/sync-state" }));
  });
  it("builds the panel for the seeded user", async () => {
    await expectContract("sync-state.happy", await callRoute(GET, { path: "/api/sync-state", as: "cookie" }));
    await expectReadLog("sync-state.happy");
  });
});
