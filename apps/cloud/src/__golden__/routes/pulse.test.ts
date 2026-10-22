// Route contract: GET /api/pulse — the /pulse ("Today") page's one read endpoint (W7/W8/UX W5).
// Cookie session, same idiom as /api/agent-stats and /api/sync-state. kg_read_pulse is the one
// graph-backed RPC on this path (lib/kg/read.ts); it has no fake handler in boundary.ts's default
// set, so it is supplied here — per the golden README, modelled only for the empty graph the seed
// actually has (census/recent both empty). Every other field this route assembles
// (recent_code_sessions, freshness, open_threads/recurring_blockers, stats_line, session_titles)
// comes from plain table reads over the existing code_sessions/turns/issues fixtures, no RPC or
// network of its own. GET takes no query/body input, so there is no malformed-input case — same
// shape as /api/agent-stats/issues.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { GET } from "@/app/api/pulse/route";
import { setCookie } from "./boundary";
import { AUTH_COOKIE, callRoute, expectContract, setupRouteGolden } from "./harness";

setupRouteGolden(() => ({
  kg_read_pulse: () => ({ data: { census: {}, recent_rows: [] }, error: null }),
}));

describe("GET /api/pulse", () => {
  it("401 without a session", async () => {
    await expectContract("pulse.no-auth", await callRoute(GET, { path: "/api/pulse" }));
  });
  // 3A-2 adversarial review: an expired/invalid session cookie (getUser errors), recorded as-is.
  it("401 for an expired/invalid session cookie", async () => {
    setCookie(AUTH_COOKIE, "expired-session-jwt");
    await expectContract("pulse.expired-cookie", await callRoute(GET, { path: "/api/pulse" }));
  });
  it("today's payload for the seeded code sessions", async () => {
    await expectContract("pulse.happy", await callRoute(GET, { path: "/api/pulse", as: "cookie" }));
  });

  // 3A-4 group 1 adversarial review lock-extend: withRoute is called here
  // with no `cors` option, so no access-control-* header is ever added —
  // pinned so a future opts.cors addition shows up as a diff, not silently.
  it("carries no CORS headers", async () => {
    const result = await callRoute(GET, { path: "/api/pulse", as: "cookie" });
    await expectContract("pulse.no-cors", result);
  });
});
