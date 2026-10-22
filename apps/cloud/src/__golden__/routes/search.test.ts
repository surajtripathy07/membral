// Route contract: GET /api/search (BJ; Bearer JWT, same direct getUser(token) shape as /api/memories).
// OPENAI_API_KEY is empty (GOLDEN_ENV), so generateEmbedding always throws and every mode falls back
// to the keyword path — the fake `search_conversations` RPC (fixtures/mcp-rpc-handlers.ts) backs that
// single call site.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { GET } from "@/app/api/search/route";
import { MCP_RPC_HANDLERS } from "./fixtures/mcp-rpc-handlers";
import { callRoute, expectContract, forceError, setRateLimitAllowed, setupRouteGolden, USER_JWT } from "./harness";

setupRouteGolden(() => MCP_RPC_HANDLERS);

const get = (path: string, o: Omit<Parameters<typeof callRoute>[1], "path"> = {}) =>
  callRoute(GET, { method: "GET", path, ...o });

describe("GET /api/search", () => {
  it("401 without authorization", async () => {
    await expectContract("search.no-auth", await get("/api/search?q=login"));
  });
  // 3A-2 adversarial review: authentication edges unlocked, recorded as-is.
  it("401 for an invalid bearer token", async () => {
    await expectContract(
      "search.bearer-bogus",
      await get("/api/search?q=login", { headers: { authorization: "Bearer bogus" } }),
    );
  });
  it("401 for a lowercase bearer scheme (treated as missing)", async () => {
    await expectContract(
      "search.bearer-lowercase",
      await get("/api/search?q=login", { headers: { authorization: `bearer ${USER_JWT}` } }),
    );
  });
  it("401 for a Basic scheme", async () => {
    await expectContract(
      "search.auth-basic",
      await get("/api/search?q=login", { headers: { authorization: "Basic x" } }),
    );
  });
  it("401 for an empty bearer token", async () => {
    await expectContract(
      "search.bearer-empty",
      await get("/api/search?q=login", { headers: { authorization: "Bearer " } }),
    );
  });
  it("400 without a query", async () => {
    await expectContract("search.no-query", await get("/api/search", { as: "jwt" }));
  });
  it("400 for an invalid mode", async () => {
    await expectContract("search.invalid-mode", await get("/api/search?q=login&mode=fuzzy", { as: "jwt" }));
  });
  it("finds the seeded conversation by title", async () => {
    await expectContract("search.happy", await get("/api/search?q=login", { as: "jwt" }));
  });

  // 3A-4 group 2 adversarial review lock-extend: the shared rate_limit_check
  // RPC is driven deterministically via setRateLimitAllowed, same as
  // code-sessions.rate-limited / sync.rate-limited.
  it("429 when the caller's bucket is exhausted", async () => {
    setRateLimitAllowed(false);
    await expectContract("search.rate-limited", await get("/api/search?q=login", { as: "jwt" }));
  });
});

// 3A-4 lock-extend 2b: behaviours the group 2-4 adversarial reviews confirmed
// preserved but left unpinned — recorded as the code does them today.
describe("GET /api/search lock-extend 2b", () => {
  it("400 for an invalid lane", async () => {
    await expectContract("search.invalid-lane", await get("/api/search?q=login&lane=voice", { as: "jwt" }));
  });
  it("500 with detail when the search RPC fails", async () => {
    forceError("search_conversations", "boundary: search rpc failed");
    await expectContract("search.rpc-error", await get("/api/search?q=login&mode=keyword", { as: "jwt" }));
  });
});
