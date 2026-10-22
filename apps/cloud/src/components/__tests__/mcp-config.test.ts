import { describe, expect, it } from "vitest";
import { getMcpConfig, MCP_CLIENTS } from "../mcp-config";

describe("MCP config data", () => {
  it("includes all client types", () => {
    const ids = MCP_CLIENTS.map((c) => c.id);
    expect(ids).toContain("claude-desktop");
    expect(ids).toContain("claude-code");
    expect(ids).toContain("cursor");
  });

  it("no longer advertises the deleted mcp-local self-hosted binary", () => {
    // #40: packages/mcp-local (the stdio-only @membral/mcp binary) was
    // removed — /api/mcp is the only MCP surface now.
    const ids = MCP_CLIENTS.map((c) => c.id);
    expect(ids).not.toContain("self-hosted");
  });

  describe("claude-desktop — mcp-remote bridge (destructive-shape regression)", () => {
    it("emits a command+args+env entry, never a bare url-shape entry", () => {
      const config = getMcpConfig("claude-desktop", "lls_test-123");
      const parsed = JSON.parse(config);
      const entry = parsed.mcpServers.membral;

      expect(entry.command).toBe("npx");
      expect(entry.args).toContain("mcp-remote");
      expect(entry.args).toContain("--header");
      // #40 adversarial review: Claude Desktop silently drops the whole
      // mcpServers key when it sees a shape it doesn't recognize — a bare
      // `url` key here is the regression this test pins against.
      expect(entry.url).toBeUndefined();
    });

    it("puts the literal mcp-remote env-var-expansion syntax in the header arg", () => {
      const config = getMcpConfig("claude-desktop", "lls_test-123");
      expect(config).toContain(`Authorization:\${MEMBRAL_AUTH_HEADER}`);
    });

    it("puts the real Bearer value in the env block, keyed MEMBRAL_AUTH_HEADER", () => {
      const config = getMcpConfig("claude-desktop", "lls_test-123");
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.membral.env).toEqual({ MEMBRAL_AUTH_HEADER: "Bearer lls_test-123" });
    });

    it("masks the key on request without touching the unmasked config", () => {
      const masked = getMcpConfig("claude-desktop", "lls_test-123456789", { mask: true });
      const unmasked = getMcpConfig("claude-desktop", "lls_test-123456789");
      expect(masked).not.toContain("lls_test-123456789");
      expect(unmasked).toContain("lls_test-123456789");
    });
  });

  describe("claude-code — CLI one-liner, not a file", () => {
    it("renders a `claude mcp add-json` command, not JSON", () => {
      const config = getMcpConfig("claude-code", "lls_test-123");
      expect(config.startsWith("claude mcp add-json")).toBe(true);
      expect(() => JSON.parse(config)).toThrow();
    });

    it("includes http transport, the Bearer header and alwaysLoad", () => {
      const config = getMcpConfig("claude-code", "lls_test-123");
      expect(config).toContain('"type":"http"');
      expect(config).toContain('"Authorization":"Bearer lls_test-123"');
      expect(config).toContain('"alwaysLoad":true');
    });

    it("never references settings.json", () => {
      const config = getMcpConfig("claude-code", "lls_test-123");
      expect(config).not.toContain("settings.json");
    });

    it("passes --scope user (claude mcp add defaults to project-local scope)", () => {
      const config = getMcpConfig("claude-code", "lls_test-123");
      expect(config).toContain("--scope user");
    });
  });

  describe("cursor — url+headers, mcp.json (not settings.json)", () => {
    it("emits a url+headers entry with the key inline", () => {
      const config = getMcpConfig("cursor", "lls_test-123");
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.membral.url).toContain("/api/mcp");
      expect(parsed.mcpServers.membral.headers.Authorization).toBe("Bearer lls_test-123");
    });

    it("hints at ~/.cursor/mcp.json as the file to add to", () => {
      const cursor = MCP_CLIENTS.find((c) => c.id === "cursor")!;
      expect(cursor.hint).toContain("Add to ~/.cursor/mcp.json");
    });
  });

  it("API key placeholder is present when no key provided", () => {
    const config = getMcpConfig("cursor");
    expect(config).toContain("YOUR_API_KEY");
  });

  it("API key is injected when provided", () => {
    const config = getMcpConfig("cursor", "sk-test-123");
    expect(config).toContain("sk-test-123");
    expect(config).not.toContain("YOUR_API_KEY");
  });

  describe("mcpUrl option (browser-verify finding — server-resolved URL, never window.location)", () => {
    it("uses the passed mcpUrl verbatim instead of the internal fallback resolver", () => {
      const config = getMcpConfig("cursor", "lls_test-123", { mcpUrl: "https://membral.me/api/mcp" });
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.membral.url).toBe("https://membral.me/api/mcp");
    });

    it("threads mcpUrl through the claude-code one-liner too", () => {
      const config = getMcpConfig("claude-code", "lls_test-123", { mcpUrl: "https://membral.me/api/mcp" });
      expect(config).toContain("https://membral.me/api/mcp");
    });

    it("threads mcpUrl through the claude-desktop mcp-remote args too", () => {
      const config = getMcpConfig("claude-desktop", "lls_test-123", { mcpUrl: "https://membral.me/api/mcp" });
      const parsed = JSON.parse(config);
      expect(parsed.mcpServers.membral.args).toContain("https://membral.me/api/mcp");
    });
  });
});
