// Route contract: GET/POST /api/memories (BJ; Bearer JWT or lls_ key — this route's own
// authenticateUser calls supabase.auth.getUser(token) directly, so only a real JWT succeeds in the
// fake, same shape as /api/account/delete).
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { GET, POST } from "@/app/api/memories/route";
import {
  callRoute,
  expectContract,
  expectOplog,
  expectReadLog,
  forceError,
  setRateLimitAllowed,
  setupRouteGolden,
  USER_JWT,
} from "./harness";

setupRouteGolden();

const get = (o: Omit<Parameters<typeof callRoute>[1], "path"> & { path?: string }) =>
  callRoute(GET, { method: "GET", path: "/api/memories", ...o });
const post = (o: Omit<Parameters<typeof callRoute>[1], "path">) =>
  callRoute(POST, { method: "POST", path: "/api/memories", ...o });

describe("GET /api/memories", () => {
  it("401 without authorization", async () => {
    await expectContract("memories.no-auth", await get({}));
  });
  // 3A-2 adversarial review: authentication edges unlocked, recorded as-is.
  it("401 for an invalid bearer token", async () => {
    await expectContract("memories.get-bearer-bogus", await get({ headers: { authorization: "Bearer bogus" } }));
  });
  it("401 for a lowercase bearer scheme (treated as missing)", async () => {
    await expectContract(
      "memories.get-bearer-lowercase",
      await get({ headers: { authorization: `bearer ${USER_JWT}` } }),
    );
  });
  it("401 for a Basic scheme", async () => {
    await expectContract("memories.get-auth-basic", await get({ headers: { authorization: "Basic x" } }));
  });
  it("401 for an empty bearer token", async () => {
    await expectContract("memories.get-bearer-empty", await get({ headers: { authorization: "Bearer " } }));
  });
  it("lists the seeded memories, most confident first", async () => {
    await expectContract("memories.happy", await get({ as: "jwt" }));
    await expectReadLog("memories.get-happy");
  });

  // 3A-4 group 2 adversarial review lock-extend: this route is still a plain
  // handler (not yet behind withRoute's `cors` option), so no access-control-*
  // header is added today — pinned so a future CORS addition shows as a diff.
  it("carries no CORS headers", async () => {
    await expectContract("memories.no-cors", await get({ as: "jwt" }));
  });

  // Read-log lock (pre-3B-7a move): the optional type / min_confidence / q
  // filters, recorded against the still-inline chain before it moved into
  // lib/memory/queries.ts's listMemoriesByConfidence.
  it("filters by type", async () => {
    await get({ as: "jwt", path: "/api/memories?type=preference" });
    await expectReadLog("memories.get-type");
  });
  it("filters by min_confidence", async () => {
    await get({ as: "jwt", path: "/api/memories?min_confidence=0.7" });
    await expectReadLog("memories.get-minconf");
  });
  it("filters by q", async () => {
    await get({ as: "jwt", path: "/api/memories?q=ledger" });
    await expectReadLog("memories.get-q");
  });
  it("combines type, min_confidence, q and limit", async () => {
    await get({ as: "jwt", path: "/api/memories?type=preference&min_confidence=0.7&q=ledger&limit=5" });
    await expectReadLog("memories.get-combined");
  });

  // Edge inputs traced by hand during the 3B-7a review.
  it("skips an invalid type, an unparseable min_confidence and an empty q (same chain as happy)", async () => {
    await get({ as: "jwt", path: "/api/memories?type=bogus&min_confidence=abc&q=" });
    await expectReadLog("memories.get-edge-skipped");
  });
  it("applies min_confidence=0 (falsy value, truthy string)", async () => {
    await get({ as: "jwt", path: "/api/memories?min_confidence=0" });
    await expectReadLog("memories.get-minconf-zero");
  });
  it("limit=abc falls back to 50", async () => {
    await get({ as: "jwt", path: "/api/memories?limit=abc" });
    await expectReadLog("memories.get-limit-nan");
  });
});

describe("POST /api/memories", () => {
  // 3A-2 adversarial review: authentication edges unlocked, recorded as-is.
  it("401 for an invalid bearer token", async () => {
    await expectContract(
      "memories.post-bearer-bogus",
      await post({ headers: { authorization: "Bearer bogus" }, body: {} }),
    );
  });
  it("401 for a lowercase bearer scheme (treated as missing)", async () => {
    await expectContract(
      "memories.post-bearer-lowercase",
      await post({ headers: { authorization: `bearer ${USER_JWT}` }, body: {} }),
    );
  });
  it("401 for a Basic scheme", async () => {
    await expectContract("memories.post-auth-basic", await post({ headers: { authorization: "Basic x" }, body: {} }));
  });
  it("401 for an empty bearer token", async () => {
    await expectContract("memories.post-bearer-empty", await post({ headers: { authorization: "Bearer " }, body: {} }));
  });
  it("400 without a memories array", async () => {
    await expectContract("memories.post-invalid-body", await post({ as: "jwt", body: {} }));
  });
  it("stores a new memory", async () => {
    await expectContract(
      "memories.post-happy",
      await post({
        as: "jwt",
        body: { memories: [{ type: "insight", content: "Users skim the header before scrolling.", confidence: 0.7 }] },
      }),
    );
    await expectOplog("memories.post-happy");
  });
});

// 3A-4 lock-extend 2b: behaviours the group 2-4 adversarial reviews confirmed
// preserved but left unpinned — recorded as the code does them today.
describe("/api/memories lock-extend 2b", () => {
  it("GET 429 when the caller's bucket is exhausted", async () => {
    setRateLimitAllowed(false);
    await expectContract("memories.get-rate-limited", await get({ as: "jwt" }));
  });
  it("GET 500 with detail when the memories query fails", async () => {
    forceError("memories", "boundary: memories read failed");
    await expectContract("memories.get-query-error", await get({ as: "jwt" }));
  });
  it("POST 400 for malformed JSON", async () => {
    await expectContract("memories.post-malformed-json", await post({ as: "jwt", body: "{" }));
  });
});
