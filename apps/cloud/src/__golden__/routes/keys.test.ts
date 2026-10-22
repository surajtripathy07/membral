// Route contract: POST/DELETE /api/keys (BJ1; dashboard caller only). Key bytes come from a deterministic node crypto.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));
vi.mock("crypto", async (orig) =>
  (await import("./crypto-mock")).deterministicCrypto(await orig<Record<string, unknown>>()),
);

import { DELETE as DELETE_DEVICE } from "@/app/api/keys/devices/[id]/route";
import { DELETE, POST } from "@/app/api/keys/route";
import { SCOPED_KEY_ID } from "./boundary";
import {
  callRoute,
  db,
  expectContract,
  expectOplog,
  expectReadLog,
  forceError,
  PROJECT_ID,
  setRateLimitAllowed,
  setupRouteGolden,
  USER_JWT,
} from "./harness";

setupRouteGolden();

const post = (o: Omit<Parameters<typeof callRoute>[1], "path">) =>
  callRoute(POST, { method: "POST", path: "/api/keys", ...o });

describe("/api/keys", () => {
  it("POST 401 without authorization", async () => {
    await expectContract("keys.no-auth", await post({}));
  });
  // 3A-2 adversarial review: authentication edges unlocked, recorded as-is.
  it("POST 401 for an invalid bearer token", async () => {
    await expectContract("keys.post-bearer-bogus", await post({ headers: { authorization: "Bearer bogus" } }));
  });
  it("POST 401 for a lowercase bearer scheme (treated as missing)", async () => {
    await expectContract(
      "keys.post-bearer-lowercase",
      await post({ headers: { authorization: `bearer ${USER_JWT}` } }),
    );
  });
  it("POST 401 for a Basic scheme", async () => {
    await expectContract("keys.post-auth-basic", await post({ headers: { authorization: "Basic x" } }));
  });
  it("POST 401 for an empty bearer token", async () => {
    await expectContract("keys.post-bearer-empty", await post({ headers: { authorization: "Bearer " } }));
  });
  it("POST 401 for an lls_ key (JWT-only route)", async () => {
    await expectContract("keys.key", await post({ as: "key" }));
  });
  it("POST 400 for a non-string scope", async () => {
    await expectContract("keys.bad-scope-type", await post({ as: "jwt", body: { scope_code_project_id: 7 } }));
  });
  it("POST 400 for two scopes", async () => {
    await expectContract(
      "keys.two-scopes",
      await post({ as: "jwt", body: { scope_node_id: "n1", scope_code_project_id: PROJECT_ID } }),
    );
  });
  it("POST 400 for a project that is not the user's", async () => {
    await expectContract(
      "keys.foreign-project",
      await post({ as: "jwt", body: { scope_code_project_id: "5eed0000-0000-4000-8000-00000000ffff" } }),
    );
  });
  it("POST mints an unscoped key", async () => {
    await expectContract("keys.happy-unscoped", await post({ as: "jwt" }));
    await expectOplog("keys.happy-unscoped");
  });
  it("POST mints a code-project-scoped key", async () => {
    await expectContract(
      "keys.happy-project-scoped",
      await post({ as: "jwt", body: { scope_code_project_id: PROJECT_ID } }),
    );
    await expectOplog("keys.happy-project-scoped");
  });
  it("DELETE 401 without authorization", async () => {
    await expectContract("keys.delete-no-auth", await callRoute(DELETE, { method: "DELETE", path: "/api/keys" }));
  });
  // 3A-2 adversarial review: authentication edges unlocked, recorded as-is.
  it("DELETE 401 for an invalid bearer token", async () => {
    await expectContract(
      "keys.delete-bearer-bogus",
      await callRoute(DELETE, {
        method: "DELETE",
        path: "/api/keys",
        headers: { authorization: "Bearer bogus" },
      }),
    );
  });
  it("DELETE 401 for a lowercase bearer scheme (treated as missing)", async () => {
    await expectContract(
      "keys.delete-bearer-lowercase",
      await callRoute(DELETE, {
        method: "DELETE",
        path: "/api/keys",
        headers: { authorization: `bearer ${USER_JWT}` },
      }),
    );
  });
  it("DELETE 401 for a Basic scheme", async () => {
    await expectContract(
      "keys.delete-auth-basic",
      await callRoute(DELETE, { method: "DELETE", path: "/api/keys", headers: { authorization: "Basic x" } }),
    );
  });
  it("DELETE 401 for an empty bearer token", async () => {
    await expectContract(
      "keys.delete-bearer-empty",
      await callRoute(DELETE, { method: "DELETE", path: "/api/keys", headers: { authorization: "Bearer " } }),
    );
  });
  it("DELETE revokes the profile key", async () => {
    await expectContract(
      "keys.delete-happy",
      await callRoute(DELETE, { method: "DELETE", path: "/api/keys", as: "jwt" }),
    );
    await expectOplog("keys.delete-happy");
  });
});

describe("DELETE /api/keys/devices/[id]", () => {
  const del = (id: string, o: Omit<Parameters<typeof callRoute>[1], "path" | "ctx">) =>
    callRoute(DELETE_DEVICE, {
      method: "DELETE",
      path: `/api/keys/devices/${id}`,
      ctx: { params: Promise.resolve({ id }) },
      ...o,
    });

  it("401 without authorization", async () => {
    await expectContract("keys.devices-delete-no-auth", await del(SCOPED_KEY_ID, {}));
  });
  // 3A-2 adversarial review: authentication edges unlocked, recorded as-is.
  it("401 for an invalid bearer token", async () => {
    await expectContract(
      "keys.devices-delete-bearer-bogus",
      await del(SCOPED_KEY_ID, { headers: { authorization: "Bearer bogus" } }),
    );
  });
  it("401 for a lowercase bearer scheme (treated as missing)", async () => {
    await expectContract(
      "keys.devices-delete-bearer-lowercase",
      await del(SCOPED_KEY_ID, { headers: { authorization: `bearer ${USER_JWT}` } }),
    );
  });
  it("401 for a Basic scheme", async () => {
    await expectContract(
      "keys.devices-delete-auth-basic",
      await del(SCOPED_KEY_ID, { headers: { authorization: "Basic x" } }),
    );
  });
  it("401 for an empty bearer token", async () => {
    await expectContract(
      "keys.devices-delete-bearer-empty",
      await del(SCOPED_KEY_ID, { headers: { authorization: "Bearer " } }),
    );
  });
  it("404 for an unknown id", async () => {
    await expectContract(
      "keys.devices-delete-not-found",
      await del("5eed0000-0000-4000-8000-00000000ffff", { as: "jwt" }),
    );
    await expectReadLog("keys.devices-delete-not-found");
  });

  // 3A-4 group 2 adversarial review lock-extend: an id that exists but belongs
  // to another user. The route's own header says the `.eq("user_id", ...)`
  // predicate IS the enforcement (service client bypasses RLS) — this pins
  // that a real row a caller doesn't own 404s identically to an unknown id,
  // never a 403 or a leak of whose key it is.
  it("404 for an id that exists but belongs to another user", async () => {
    const FOREIGN_KEY_ID = "5eed0000-0000-4000-8000-000000000301";
    db().seed("api_keys", [
      {
        id: FOREIGN_KEY_ID,
        user_id: "00000000-0000-4000-8000-00000000fee1",
        key_hash: "not-this-users-key",
        scope_node_id: null,
        scope_code_project_id: null,
        device_id: null,
        revoked_at: null,
        last_used_at: null,
      },
    ]);
    await expectContract("keys.devices-delete-foreign-user", await del(FOREIGN_KEY_ID, { as: "jwt" }));
  });
  it("revokes the seeded device key", async () => {
    await expectContract("keys.devices-delete-happy", await del(SCOPED_KEY_ID, { as: "jwt" }));
    await expectOplog("keys.devices-delete-happy");
    await expectReadLog("keys.devices-delete-happy");
  });
});

// 3A-4 lock-extend 2b: behaviours the group 2-4 adversarial reviews confirmed
// preserved but left unpinned — recorded as the code does them today.
describe("/api/keys lock-extend 2b", () => {
  it("POST 429 when the caller's bucket is exhausted", async () => {
    setRateLimitAllowed(false);
    await expectContract("keys.post-rate-limited", await post({ as: "jwt" }));
  });
  it("POST 500 when storing the key fails", async () => {
    forceError("profiles", "boundary: profiles update failed");
    await expectContract("keys.post-store-error", await post({ as: "jwt" }));
  });
  it("POST malformed JSON falls back to an unscoped key", async () => {
    await expectContract("keys.post-malformed-json", await post({ as: "jwt", body: "{" }));
  });
  it("DELETE 500 when the profile update fails", async () => {
    forceError("profiles", "boundary: profiles update failed");
    await expectContract(
      "keys.delete-update-error",
      await callRoute(DELETE, { method: "DELETE", path: "/api/keys", as: "jwt" }),
    );
  });
  it("DELETE /devices/[id] 500 when the api_keys update fails", async () => {
    forceError("api_keys", "boundary: api_keys update failed");
    await expectContract(
      "keys.devices-delete-update-error",
      await callRoute(DELETE_DEVICE, {
        method: "DELETE",
        path: `/api/keys/devices/${SCOPED_KEY_ID}`,
        ctx: { params: Promise.resolve({ id: SCOPED_KEY_ID }) },
        as: "jwt",
      }),
    );
  });
});
