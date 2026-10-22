// Route contract: POST /api/account/delete (BJ; Bearer JWT, same getUser(token) shape as /api/keys).
// deleteUser is faked in boundary.ts's dataClient (auth.admin.deleteUser) — no real cascade, just
// enough to lock this route's own {deleted:true} contract.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { POST } from "@/app/api/account/delete/route";
import { callRoute, expectContract, forceError, setupRouteGolden, USER_JWT } from "./harness";

setupRouteGolden();

const post = (o: Omit<Parameters<typeof callRoute>[1], "path">) =>
  callRoute(POST, { method: "POST", path: "/api/account/delete", ...o });

describe("POST /api/account/delete", () => {
  it("401 without authorization", async () => {
    await expectContract("account-delete.no-auth", await post({ body: { confirmation: "DELETE" } }));
  });
  // 3A-2 adversarial review: authentication edges unlocked, recorded as-is.
  it("401 for an invalid bearer token", async () => {
    await expectContract(
      "account-delete.bearer-bogus",
      await post({ headers: { authorization: "Bearer bogus" }, body: { confirmation: "DELETE" } }),
    );
  });
  it("401 for a lowercase bearer scheme (treated as missing)", async () => {
    await expectContract(
      "account-delete.bearer-lowercase",
      await post({ headers: { authorization: `bearer ${USER_JWT}` }, body: { confirmation: "DELETE" } }),
    );
  });
  it("401 for a Basic scheme", async () => {
    await expectContract(
      "account-delete.auth-basic",
      await post({ headers: { authorization: "Basic x" }, body: { confirmation: "DELETE" } }),
    );
  });
  it("401 for an empty bearer token", async () => {
    await expectContract(
      "account-delete.bearer-empty",
      await post({ headers: { authorization: "Bearer " }, body: { confirmation: "DELETE" } }),
    );
  });
  it("400 without the typed confirmation", async () => {
    await expectContract("account-delete.no-confirmation", await post({ as: "jwt", body: {} }));
  });
  // 3A-4 group 2 adversarial review lock-extend: the route's own catch treats a
  // body that fails to JSON-parse the same as no body at all — confirmation
  // stays undefined, so this 400s identically to no-confirmation.
  it("400 for a malformed JSON body", async () => {
    await expectContract("account-delete.malformed-json", await post({ as: "jwt", body: "{not json" }));
  });
  it("400 for an empty body", async () => {
    await expectContract("account-delete.empty-body", await post({ as: "jwt", body: "" }));
  });
  // deleteUser's own error is never surfaced verbatim (no schema/driver detail
  // reaches the caller) — always this one generic message.
  it("500 when deleteUser fails", async () => {
    forceError("auth.admin.deleteUser", "boundary: forced deleteUser failure");
    await expectContract(
      "account-delete.delete-user-error",
      await post({ as: "jwt", body: { confirmation: "DELETE" } }),
    );
  });
  it("deletes the account when confirmed", async () => {
    await expectContract("account-delete.happy", await post({ as: "jwt", body: { confirmation: "DELETE" } }));
  });
});
