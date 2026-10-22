import { beforeEach, describe, expect, it, vi } from "vitest";
import { detectTools } from "../detect.js";

// Mock node:fs/promises
vi.mock("node:fs/promises", () => ({
  stat: vi.fn(),
  readFile: vi.fn(),
}));

// Mock node:os to control homedir
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/mock-home"),
}));

describe("detectTools", () => {
  let mockStat: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const fs = await import("node:fs/promises");
    mockStat = vi.mocked(fs.stat);
    mockStat.mockReset();
  });

  it("detects Claude Desktop when config file exists", async () => {
    mockStat.mockImplementation(async (path: string) => {
      if (path.includes("Application Support/Claude/claude_desktop_config.json")) {
        return {};
      }
      throw new Error("ENOENT");
    });

    const tools = await detectTools();
    const claudeDesktop = tools.find((t) => t.id === "claude-desktop");

    expect(claudeDesktop).toBeDefined();
    expect(claudeDesktop!.detected).toBe(true);
  });

  it("detects Claude Code when .claude directory exists, with no configPath", async () => {
    mockStat.mockImplementation(async (path: string) => {
      if (path.endsWith(".claude")) {
        return {};
      }
      throw new Error("ENOENT");
    });

    const tools = await detectTools();
    const claudeCode = tools.find((t) => t.id === "claude-code");

    expect(claudeCode).toBeDefined();
    expect(claudeCode!.detected).toBe(true);
    // Claude Code has no mcpServers-writable file — its MCP config is
    // applied via `claude mcp add`, not by writing ~/.claude/settings.json.
    expect(claudeCode!.configPath).toBeUndefined();
  });

  it("points Cursor at mcp.json, not settings.json", async () => {
    mockStat.mockImplementation(async (path: string) => {
      if (path.endsWith(".cursor")) {
        return {};
      }
      throw new Error("ENOENT");
    });

    const tools = await detectTools();
    const cursor = tools.find((t) => t.id === "cursor");

    expect(cursor).toBeDefined();
    expect(cursor!.detected).toBe(true);
    expect(cursor!.configPath).toBe("/mock-home/.cursor/mcp.json");
  });

  it("marks tools as not detected when paths do not exist", async () => {
    mockStat.mockRejectedValue(new Error("ENOENT"));

    const tools = await detectTools();

    expect(tools.every((t) => t.detected === false)).toBe(true);
  });

  it("returns all four tool entries", async () => {
    mockStat.mockRejectedValue(new Error("ENOENT"));

    const tools = await detectTools();

    expect(tools).toHaveLength(4);
    expect(tools.map((t) => t.id)).toEqual(["claude-desktop", "agy", "claude-code", "cursor"]);
  });
});
