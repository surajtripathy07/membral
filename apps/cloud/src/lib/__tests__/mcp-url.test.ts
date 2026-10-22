// lib/mcp-url.ts — browser-verify finding (2026-09-06): the MCP URL used to
// be computed client-side from window.location.origin inside mcp-config.tsx,
// mismatching the server-rendered "/api/mcp" fallback (a hydration error on
// every Settings page load). resolveMcpUrl is now pure, window-free, and
// called once by the server-rendered settings page.
import { afterEach, describe, expect, it } from "vitest";
import { resolveMcpUrl } from "../mcp-url";

describe("resolveMcpUrl", () => {
  const originalOverride = process.env.NEXT_PUBLIC_MCP_URL;

  afterEach(() => {
    process.env.NEXT_PUBLIC_MCP_URL = originalOverride;
  });

  it("derives /api/mcp from the given app URL when no override is set", () => {
    delete process.env.NEXT_PUBLIC_MCP_URL;
    expect(resolveMcpUrl("https://membral.me")).toBe("https://membral.me/api/mcp");
  });

  it("strips a trailing slash from the app URL before appending /api/mcp", () => {
    delete process.env.NEXT_PUBLIC_MCP_URL;
    expect(resolveMcpUrl("https://membral.me/")).toBe("https://membral.me/api/mcp");
  });

  it("prefers NEXT_PUBLIC_MCP_URL verbatim when set, ignoring the app URL entirely", () => {
    process.env.NEXT_PUBLIC_MCP_URL = "https://mcp.membral.me/api/mcp";
    expect(resolveMcpUrl("https://membral.me")).toBe("https://mcp.membral.me/api/mcp");
  });

  it("never touches window — safe to call from any environment (server, client, test)", () => {
    delete process.env.NEXT_PUBLIC_MCP_URL;
    expect(() => resolveMcpUrl("http://localhost:3001")).not.toThrow();
    expect(resolveMcpUrl("http://localhost:3001")).toBe("http://localhost:3001/api/mcp");
  });
});
