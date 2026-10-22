// Route contract: middleware.ts redirects (step 0.4c). middleware() reads the
// session straight off `request.cookies` (its own cookie adapter, not
// next/headers), so only @supabase/ssr needs mocking for the auth check; the
// other two mocks are kept for parity with every other route file and because
// they cost nothing here (middleware never calls next/headers or after()).
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { middleware } from "@/middleware";
import { AUTH_COOKIE, callRoute, expectContract, setupRouteGolden, USER_JWT } from "./harness";

setupRouteGolden();

// The mocked cookie session: a real `Cookie` header on the NextRequest, read
// by middleware.ts's own `getAll()` (request.cookies), not the next/headers
// mock `as: "cookie"` feeds elsewhere in this harness.
const cookieHeaders = { cookie: `${AUTH_COOKIE}=${USER_JWT}` };

describe("middleware", () => {
  it("/ unauthenticated renders the landing page directly (issue #127)", async () => {
    await expectContract("middleware.root-unauth", await callRoute(middleware, { path: "/" }));
  });

  it("/pulse unauthenticated redirects to /login?next=%2Fpulse", async () => {
    await expectContract("middleware.pulse-unauth", await callRoute(middleware, { path: "/pulse" }));
  });

  it("/pulse authenticated (mocked cookie session) passes through", async () => {
    await expectContract(
      "middleware.pulse-authed",
      await callRoute(middleware, { path: "/pulse", headers: cookieHeaders }),
    );
  });

  it("/login authenticated redirects to /conversations", async () => {
    await expectContract(
      "middleware.login-authed",
      await callRoute(middleware, { path: "/login", headers: cookieHeaders }),
    );
  });

  // config.matcher (~line 111) keeps Next from ever running this function on
  // api/* in production; middleware() itself has no such exception, so a
  // direct call — as this harness always makes — redirects it like any other
  // unauthenticated protected path. Locking that in documents why the
  // matcher exclusion matters, not a claim about production routing.
  it("/api/health invoked directly (matcher excludes it in prod, this fn does not)", async () => {
    await expectContract("middleware.api-health", await callRoute(middleware, { path: "/api/health" }));
  });

  it("a static asset path invoked directly (matcher excludes it in prod, this fn does not)", async () => {
    await expectContract("middleware.static-asset", await callRoute(middleware, { path: "/logo.png" }));
  });
});
