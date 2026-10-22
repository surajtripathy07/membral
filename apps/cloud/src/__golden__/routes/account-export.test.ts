// Route contract: GET /api/account/export (BJ; Bearer JWT, NDJSON stream). The stream is fully
// drained by callRoute's res.text(), so the snapshot body is the complete NDJSON output.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { GET } from "@/app/api/account/export/route";
import { callRoute, expectContract, expectReadLog, setupRouteGolden, USER_JWT } from "./harness";

setupRouteGolden();

const get = (o: Omit<Parameters<typeof callRoute>[1], "path">) =>
  callRoute(GET, { method: "GET", path: "/api/account/export", ...o });

describe("GET /api/account/export", () => {
  it("401 without authorization", async () => {
    await expectContract("account-export.no-auth", await get({}));
  });
  // 3A-2 adversarial review: authentication edges unlocked, recorded as-is.
  it("401 for an invalid bearer token", async () => {
    await expectContract("account-export.bearer-bogus", await get({ headers: { authorization: "Bearer bogus" } }));
  });
  it("401 for a lowercase bearer scheme (treated as missing)", async () => {
    await expectContract(
      "account-export.bearer-lowercase",
      await get({ headers: { authorization: `bearer ${USER_JWT}` } }),
    );
  });
  it("401 for a Basic scheme", async () => {
    await expectContract("account-export.auth-basic", await get({ headers: { authorization: "Basic x" } }));
  });
  it("401 for an empty bearer token", async () => {
    await expectContract("account-export.bearer-empty", await get({ headers: { authorization: "Bearer " } }));
  });
  it("streams the seeded profile and conversations as NDJSON", async () => {
    await expectContract("account-export.happy", await get({ as: "jwt" }));
    await expectReadLog("account-export.happy");
  });
});
