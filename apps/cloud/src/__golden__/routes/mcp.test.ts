// Route contract: /api/mcp (JWT or any lls_ key). initialize, tools/list, and one tools/call per tool
// over the shared seed, for the tools listed in fixtures/mcp-tool-calls.ts; RPC-backed tools use the
// seed-derived handlers in fixtures/mcp-rpc-handlers.ts.
import { describe, it, vi } from "vitest";

vi.mock("@supabase/supabase-js", async () => (await import("./boundary")).supabaseJsModule());
vi.mock("@supabase/ssr", async () => (await import("./boundary")).supabaseSsrModule());
vi.mock("next/headers", async () => (await import("./boundary")).nextHeadersModule());
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (await import("./boundary")).after,
}));

import { DELETE, GET, POST } from "@/app/api/mcp/route";
import { MCP_RPC_HANDLERS } from "./fixtures/mcp-rpc-handlers";
import { EXTENDED_TOOLS, TOOL_CALLS } from "./fixtures/mcp-tool-calls";
import { callRoute, expectContract, setupRouteGolden } from "./harness";

setupRouteGolden(() => MCP_RPC_HANDLERS);

const MCP_HEADERS = { accept: "application/json, text/event-stream" };
const rpc = (id: number, method: string, params: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id,
  method,
  params,
});
const post = (o: Omit<Parameters<typeof callRoute>[1], "path">) =>
  callRoute(POST, { method: "POST", path: "/api/mcp", ...o, headers: { ...MCP_HEADERS, ...(o.headers ?? {}) } });

describe("/api/mcp auth", () => {
  it("401 without authorization", async () => {
    await expectContract("mcp.no-auth", await post({ body: rpc(1, "tools/list") }));
  });
  it("401 for an unknown key", async () => {
    await expectContract("mcp.bad-key", await post({ as: "bad-key", body: rpc(1, "tools/list") }));
  });
  it("401 for an invalid JWT", async () => {
    await expectContract("mcp.bad-jwt", await post({ as: "bad-jwt", body: rpc(1, "tools/list") }));
  });
  it("GET 401 without authorization", async () => {
    await expectContract("mcp.get-no-auth", await callRoute(GET, { path: "/api/mcp" }));
  });
  it("DELETE acknowledges", async () => {
    await expectContract("mcp.delete", await callRoute(DELETE, { method: "DELETE", path: "/api/mcp" }));
  });
  it("400 for a malformed JSON-RPC body", async () => {
    await expectContract("mcp.malformed-json", await post({ as: "key", body: "{" }));
  });
});

describe("/api/mcp protocol", () => {
  it("initialize", async () => {
    const body = rpc(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "golden-client", version: "0.0.0" },
    });
    await expectContract("mcp.initialize", await post({ as: "key", body }));
  });
  it("tools/list (unscoped key)", async () => {
    await expectContract("mcp-tools-list", await post({ as: "key", body: rpc(2, "tools/list") }));
  });
  it("tools/list (code-project-scoped key)", async () => {
    await expectContract("mcp-tools-list.scoped-key", await post({ as: "scoped-key", body: rpc(2, "tools/list") }));
  });
  it("tools/list (unscoped key, MEMBRAL_MCP_EXTENDED_TOOLS=1)", async () => {
    vi.stubEnv("MEMBRAL_MCP_EXTENDED_TOOLS", "1");
    await expectContract("mcp-tools-list.extended", await post({ as: "key", body: rpc(2, "tools/list") }));
  });
  for (const [tool, args] of Object.entries(TOOL_CALLS)) {
    it(`tools/call ${tool}`, async () => {
      if (EXTENDED_TOOLS.has(tool)) vi.stubEnv("MEMBRAL_MCP_EXTENDED_TOOLS", "1");
      // W7 D3: pinned with NO embedding provider (keyword-only search), whatever the dev shell exports.
      for (const k of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "MEMBRAL_EMBEDDINGS_BASE_URL", "MEMBRAL_MODEL_BASE_URL"])
        vi.stubEnv(k, "");
      await expectContract(
        `mcp-tools-call.${tool}`,
        await post({ as: "key", body: rpc(3, "tools/call", { name: tool, arguments: args }) }),
      );
    });
  }
});
