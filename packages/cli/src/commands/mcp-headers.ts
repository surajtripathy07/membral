import { parseFlags, stringFlag } from "../args.js";
import { HELP } from "../help.js";
import { buildMcpHeaders } from "../mcp-headers.js";
import type { Command } from "./types.js";

export const mcpHeadersCommand: Command = {
  name: "mcp-headers",
  // Run by Codex as `http_headers_helper` (codex-setup.ts). stdout must be
  // exactly one JSON object; nothing else is ever printed there.
  run(rest) {
    const flags = parseFlags(rest);
    const out = buildMcpHeaders(stringFlag(flags, "api-url"));
    if (!out) process.exit(1);
    process.stdout.write(out);
  },
  help: HELP["mcp-headers"],
};
