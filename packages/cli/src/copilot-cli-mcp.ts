/**
 * Membral MCP server entry for GitHub Copilot CLI: `<copilotHome>/mcp-config.json`.
 * Only `mcpServers.membral` is touched; other servers and top-level keys survive.
 * A user-level file (like ~/.claude.json), so the literal key is stored, mode 0600.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isEnoent, writeFileAtomic } from "./configure.js";
import { defaultCopilotHome } from "./import-sessions.js";

export type CopilotMcpOutcome = "created" | "updated" | "unchanged" | "would-write" | "invalid-json";

export interface CopilotCliMcpOptions {
  apiUrl: string;
  apiKey: string;
  /** Defaults to ${COPILOT_HOME:-~/.copilot}. */
  copilotHome?: string;
  dryRun?: boolean;
}

export interface CopilotCliMcpResult {
  path: string;
  outcome: CopilotMcpOutcome;
  /** For invalid-json: the `copilot mcp add` equivalent, key masked. */
  manualCommand?: string;
}

export function copilotMcpConfigPath(copilotHome: string = defaultCopilotHome()): string {
  return join(copilotHome, "mcp-config.json");
}

function maskKey(key: string): string {
  return key.length > 8 ? `${key.slice(0, 4)}…${key.slice(-2)}` : "****";
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function installCopilotCliMcp(opts: CopilotCliMcpOptions): Promise<CopilotCliMcpResult> {
  const path = copilotMcpConfigPath(opts.copilotHome);
  const url = `${opts.apiUrl.replace(/\/+$/, "")}/api/mcp`;
  const entry = {
    type: "http",
    url,
    headers: { Authorization: `Bearer ${opts.apiKey}` },
    tools: ["*"],
  };

  let existing: string | undefined;
  try {
    existing = await readFile(path, "utf-8");
  } catch (err) {
    if (!isEnoent(err)) throw err;
  }

  let config: Record<string, unknown> = {};
  let servers: Record<string, unknown> = {};
  if (existing !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      parsed = undefined;
    }
    if (!isObject(parsed) || (parsed.mcpServers !== undefined && !isObject(parsed.mcpServers))) {
      return {
        path,
        outcome: "invalid-json",
        manualCommand: `copilot mcp add --transport http --header "Authorization: Bearer ${maskKey(opts.apiKey)}" membral ${url}`,
      };
    }
    config = parsed;
    servers = (parsed.mcpServers as Record<string, unknown> | undefined) ?? {};
  }

  const next = `${JSON.stringify({ ...config, mcpServers: { ...servers, membral: entry } }, null, 2)}\n`;
  if (existing === next) return { path, outcome: "unchanged" };
  if (opts.dryRun) return { path, outcome: "would-write" };

  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, next, 0o600);
  return { path, outcome: existing === undefined ? "created" : "updated" };
}
