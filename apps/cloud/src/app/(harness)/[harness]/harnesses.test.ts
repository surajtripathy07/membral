import { describe, expect, it } from "vitest";
import { getMcpConfig } from "@/components/mcp-config";
import { getHarness, HARNESSES, MCP_URL } from "./harnesses";

describe("harness pages data", () => {
  it("has exactly the three slugs", () => {
    expect(HARNESSES.map((h) => h.slug)).toEqual(["claude-code", "opencode", "codex"]);
  });

  it("has non-empty copy and snippets", () => {
    for (const h of HARNESSES) {
      expect(h.name).not.toBe("");
      expect(h.description).not.toBe("");
      expect(h.intro).not.toBe("");
      expect(h.snippet).toContain("/api/mcp");
    }
  });

  it("claude-code snippet matches getMcpConfig", () => {
    expect(getHarness("claude-code")?.snippet).toBe(getMcpConfig("claude-code", undefined, { mcpUrl: MCP_URL }));
  });

  it("returns undefined for unknown slugs", () => {
    expect(getHarness("nope")).toBeUndefined();
  });
});
