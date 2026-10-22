// Route contracts: GET /api/agent-stats and GET /api/agent-stats/issues (ADR 0032; cookie session).
// Both aggregate over code_sessions/code_session_turns/code_session_issues via lib/agent-stats/*
// pure functions — no RPC, no new fake surface needed. fixtures/seed.json already carries two
// sessions (started_at 2025-12-20/22, inside the fixed clock's default 30d window) and one issue
// row, so the happy paths lock real aggregation output over the existing fixtures rather than
// requiring new seed rows. /issues takes no query params at all, so it has no malformed-input case.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { GET as issuesGET } from "@/app/api/agent-stats/issues/route";
import { GET } from "@/app/api/agent-stats/route";
import { setCookie } from "./boundary";
import { AUTH_COOKIE, callRoute, expectContract, expectReadLog, setupRouteGolden } from "./harness";

setupRouteGolden();

describe("GET /api/agent-stats", () => {
  it("401 without a session", async () => {
    await expectContract("agent-stats.no-auth", await callRoute(GET, { path: "/api/agent-stats" }));
  });
  it("30d totals for the seeded sessions", async () => {
    await expectContract("agent-stats.happy", await callRoute(GET, { path: "/api/agent-stats", as: "cookie" }));
    await expectReadLog("agent-stats.happy");
  });
  it("falls back to the default range/tz for invalid query values", async () => {
    await expectContract(
      "agent-stats.invalid-query",
      await callRoute(GET, { path: "/api/agent-stats?range=decade&tz=Not/AZone", as: "cookie" }),
    );
  });
});

describe("GET /api/agent-stats/issues", () => {
  it("401 without a session", async () => {
    await expectContract("agent-stats-issues.no-auth", await callRoute(issuesGET, { path: "/api/agent-stats/issues" }));
  });
  // 3A-4 group 1 adversarial review lock-extend: an expired/invalid session
  // cookie (getUser errors), recorded as-is.
  it("401 for an expired/invalid session cookie", async () => {
    setCookie(AUTH_COOKIE, "expired-session-jwt");
    await expectContract(
      "agent-stats-issues.expired-cookie",
      await callRoute(issuesGET, { path: "/api/agent-stats/issues" }),
    );
  });
  it("attributes the seeded issue across the seeded sessions", async () => {
    await expectContract(
      "agent-stats-issues.happy",
      await callRoute(issuesGET, { path: "/api/agent-stats/issues", as: "cookie" }),
    );
    await expectReadLog("agent-stats-issues.happy");
  });
});
