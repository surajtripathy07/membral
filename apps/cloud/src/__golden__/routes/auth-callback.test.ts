// Route contract: GET /auth/callback redirect targets (cookie client via @supabase/ssr + next/headers).
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { GET } from "@/app/auth/callback/route";
import { callRoute, expectContract, GOOD_OAUTH_CODE, setupRouteGolden } from "./harness";

setupRouteGolden();

const cases: Array<[string, string]> = [
  ["provider-cancelled", "/auth/callback?error=access_denied&error_description=User+cancelled"],
  ["provider-error", "/auth/callback?error=server_error&error_description=Database+error+saving+new+user"],
  ["missing-code", "/auth/callback"],
  ["bad-code", "/auth/callback?code=code-expired"],
  ["happy-default-next", `/auth/callback?code=${GOOD_OAUTH_CODE}`],
  ["happy-next", `/auth/callback?code=${GOOD_OAUTH_CODE}&next=%2Fcode%3Ftab%3Dstats`],
  ["unsafe-next", `/auth/callback?code=${GOOD_OAUTH_CODE}&next=%2F%2Fevil.example%2Fx`],
];

describe("GET /auth/callback", () => {
  for (const [name, path] of cases) {
    it(name, async () => {
      await expectContract(`auth-callback.${name}`, await callRoute(GET, { path }));
    });
  }
});
