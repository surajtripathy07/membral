import { parseFlags, stringFlag } from "../args.js";
import { DEFAULT_API_URL, resolveCredentials } from "../credentials.js";
import { HELP } from "../help.js";
import { runMcpStdio } from "../mcp-stdio.js";
import type { Command } from "./types.js";

export const mcpCommand: Command = {
  name: "mcp",
  // stdio MCP server. stdout is the protocol channel: never console.log here.
  async run(rest) {
    const flags = parseFlags(rest);
    const creds = resolveCredentials({
      flagKey: stringFlag(flags, "api-key"),
      flagUrl: stringFlag(flags, "api-url"),
      envKey: process.env.MEMBRAL_API_KEY,
      envUrl: process.env.MEMBRAL_API_URL,
      defaultUrl: DEFAULT_API_URL,
    });
    // A client that closes our stdout mid-write is a normal shutdown.
    process.stdout.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "EPIPE") process.exit(0);
      process.stderr.write(`membral mcp: ${e.message}\n`);
      process.exit(1);
    });
    await runMcpStdio({
      input: process.stdin,
      write: (line) => process.stdout.write(line),
      log: (msg) => process.stderr.write(`${msg}\n`),
      apiUrl: creds.apiUrl,
      apiKey: creds.apiKey,
    });
  },
  help: HELP.mcp,
};
