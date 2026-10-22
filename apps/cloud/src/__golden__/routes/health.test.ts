// Route contract: GET /api/health — no auth, a liveness probe (issue #72). Its Supabase check goes
// through tryServiceClient() (lib/db/clients, backed by @supabase/supabase-js like every other
// route) against the seeded `conversations` table. SUPABASE_SERVICE_ROLE_KEY is always set in
// GOLDEN_ENV, so the degraded case unstubs it to "" instead of asking the fake to model a DB-level
// error — tryServiceClient() then returns null the same way a real deploy missing that env var
// would. No body/query params exist on this route, so there is no malformed-input case; the
// x-request-id passthrough is this route's only other branch worth locking.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { GET } from "@/app/api/health/route";
import { callRoute, expectContract, expectReadLog, setupRouteGolden } from "./harness";

setupRouteGolden();

describe("GET /api/health", () => {
  it("200 ok when supabase answers", async () => {
    await expectContract("health.happy", await callRoute(GET, { path: "/api/health" }));
    await expectReadLog("health.happy");
  });
  it("503 degraded when the service client has no env to build from", async () => {
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "");
    await expectContract("health.degraded", await callRoute(GET, { path: "/api/health" }));
  });
  it("passes through an inbound x-request-id", async () => {
    await expectContract(
      "health.request-id",
      await callRoute(GET, { path: "/api/health", headers: { "x-request-id": "golden-rid-1" } }),
    );
  });
});
