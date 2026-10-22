// Route contract: POST /api/mcp/test — the settings page's "test this key" action. It validates
// the key against the fake profiles/api_keys tables (validateApiKey, same lookup /api/mcp itself
// uses) then makes a real `fetch` to this deployment's own /api/mcp with a tools/list JSON-RPC
// call. That self-fetch is the one external-network edge in its happy path; it is stubbed here
// with an SSE-framed response shaped exactly like /api/mcp's real transport (see that route's own
// comment) so the contract locks the parsing of a genuine frame, not a live loopback call.
// UNLOCKED BRANCH: "valid key, MCP reachable" (ok:true, toolCount from the stub).
// #172 (ruling D-067): an invalid key is 401 (was 200 + ok:false; same body), and failed keys count
// against the per-IP keyValidationFail throttle. rate_limit_check here counts per bucket against
// p_limit like the real RPC, so the throttle case below exercises the actual threshold.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { POST } from "@/app/api/mcp/test/route";
import { API_KEY, callRoute, expectContract, setupRouteGolden } from "./harness";

setupRouteGolden(() => {
  const hits = new Map<string, number>();
  return {
    rate_limit_check: (a) => {
      const key = a.p_key as string;
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      const allowed = n <= (a.p_limit as number);
      return {
        data: { allowed, retry_after: allowed ? 0 : (a.p_window_seconds as number), remaining: allowed ? 0 : 0 },
        error: null,
      };
    },
  };
});

const post = (o: Omit<Parameters<typeof callRoute>[1], "path" | "method">) =>
  callRoute(POST, { method: "POST", path: "/api/mcp/test", ...o });

describe("POST /api/mcp/test", () => {
  it("400 without an lls_ key", async () => {
    await expectContract("mcp-test.invalid-body", await post({ body: { apiKey: "not-a-key" } }));
  });
  it("401 ok:false for a key that doesn't validate", async () => {
    await expectContract("mcp-test.bad-key", await post({ body: { apiKey: "lls_not_a_real_key" } }));
  });
  it("429 with Retry-After once failed keys from one IP pass keyValidationFail (5/min)", async () => {
    const headers = { "x-forwarded-for": "203.0.113.9" };
    for (let i = 0; i < 5; i++) {
      const r = await post({ headers, body: { apiKey: `lls_guess_${i}` } });
      if (r.status !== 401) throw new Error(`guess ${i}: expected 401, got ${r.status}`);
    }
    await expectContract("mcp-test.key-throttled", await post({ headers, body: { apiKey: "lls_guess_5" } }));
  });
  it("ok:true, reporting the tool count from a reachable MCP endpoint", async () => {
    const sseFrame = `event: message\ndata: ${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [{ name: "memory_search" }, { name: "who_is_this_user" }] },
    })}\n\n`;
    const fetchMock = vi.fn(async () => new Response(sseFrame, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expectContract("mcp-test.happy", await post({ body: { apiKey: API_KEY } }));
  });
});
