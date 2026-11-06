import { describe, expect, it } from "vitest";
import { getMcpConfig } from "@/components/mcp-config";
import { HARNESS_LINKS } from "../../_landing/content";
import { capabilityRows, getHarness, HARNESSES, MCP_URL } from "./harnesses";

describe("harness pages data", () => {
  it("has exactly the three slugs", () => {
    expect(HARNESSES.map((h) => h.slug)).toEqual(["claude-code", "opencode", "codex"]);
  });

  it("has non-empty copy and snippets", () => {
    for (const h of HARNESSES) {
      expect(h.name).not.toBe("");
      expect(h.description).not.toBe("");
      expect(h.intro).not.toBe("");
      expect(h.snippet).not.toBe("");
      expect(capabilityRows(h).length).toBe(5);
    }
  });

  it("the two MCP snippets point at the local MCP endpoint", () => {
    expect(getHarness("claude-code")?.snippet).toContain(MCP_URL);
    expect(getHarness("opencode")?.snippet).toContain(MCP_URL);
  });

  it("claude-code snippet matches getMcpConfig", () => {
    expect(getHarness("claude-code")?.snippet).toBe(getMcpConfig("claude-code", undefined, { mcpUrl: MCP_URL }));
  });

  it("the per-prompt lookup is Claude Code only", () => {
    expect(HARNESSES.filter((h) => h.promptLookup).map((h) => h.slug)).toEqual(["claude-code"]);
  });

  it("returns undefined for unknown slugs", () => {
    expect(getHarness("nope")).toBeUndefined();
  });

  it("the landing's harness links cover exactly the pages that exist", () => {
    for (const [name, slug] of Object.entries(HARNESS_LINKS)) {
      expect(getHarness(slug)?.name).toBe(name);
    }
  });

  it("copy has no banned terms", () => {
    const text = JSON.stringify(HARNESSES);
    expect(text).not.toMatch(/graph|seamless|unlock|supercharge|ai-powered|cheaper|faster|savings|\d+%/i);
    expect(text).not.toMatch(/[—!]/);
  });
});
