import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DetectedTool {
  name: string;
  id: string;
  /**
   * Only set for clients configured by writing a JSON file directly (Claude
   * Desktop, Cursor). Claude Code has no `mcpServers` key in
   * `~/.claude/settings.json` — that file is hooks/permissions only — so its
   * MCP config is applied via the `claude` CLI instead (see
   * configureClaudeCodeCli in configure.ts), and this is left undefined.
   */
  configPath?: string;
  detected: boolean;
}

/** Antigravity CLI's install root: sessions live in `brain/`, state beside it. */
export function agyInstallRoot(home: string = homedir()): string {
  return join(home, ".gemini", "antigravity-cli");
}

/** Where Antigravity reads global MCP servers and lifecycle hooks (its docs: `~/.gemini/config/`). */
export function agyMcpConfigPath(home: string = homedir()): string {
  return join(home, ".gemini", "config", "mcp_config.json");
}

export function agyHooksConfigPath(home: string = homedir()): string {
  return join(home, ".gemini", "config", "hooks.json");
}

export async function detectTools(): Promise<DetectedTool[]> {
  const home = homedir();
  const tools: DetectedTool[] = [];

  // Claude Desktop
  const claudeDesktopConfig = join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  tools.push({
    name: "Claude Desktop",
    id: "claude-desktop",
    configPath: claudeDesktopConfig,
    detected: await fileExists(claudeDesktopConfig),
  });

  // Antigravity CLI (agy). `~/.gemini/config` is NOT a signal: Gemini CLI shares the
  // `~/.gemini` tree. Only agy's own install root counts.
  tools.push({
    name: "Antigravity",
    id: "agy",
    configPath: agyMcpConfigPath(home),
    detected: await fileExists(agyInstallRoot(home)),
  });

  // Claude Code — detection only; see the configPath doc comment above.
  const claudeCodeDir = join(home, ".claude");
  tools.push({
    name: "Claude Code",
    id: "claude-code",
    detected: await fileExists(claudeCodeDir),
  });

  // Cursor — mcp.json, NOT settings.json (settings.json has no mcpServers key)
  const cursorDir = join(home, ".cursor");
  tools.push({
    name: "Cursor",
    id: "cursor",
    configPath: join(cursorDir, "mcp.json"),
    detected: await fileExists(cursorDir),
  });

  return tools;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
