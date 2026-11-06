#!/usr/bin/env bash
# One product version: the CLI's (packages/cli/package.json). Every manifest that
# advertises a version must equal it, so a bump cannot leave one behind.
# Not covered on purpose: apps/cloud/package.json, packages/core, test-kit and
# extension (private workspace versions, not product-facing).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

REPO_ROOT="$repo_root" node --input-type=module -e '
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.env.REPO_ROOT;
const json = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const src = (p) => readFileSync(join(root, p), "utf8");

const want = json("packages/cli/package.json").version;
const found = {
  "server.json version": json("server.json").version,
  "server.json packages[0].version": json("server.json").packages[0].version,
  "plugins/membral/plugin.json": json("plugins/membral/plugin.json").version,
  "plugins/membral/.claude-plugin/plugin.json": json("plugins/membral/.claude-plugin/plugin.json").version,
  ".claude-plugin/marketplace.json plugins[0]": json(".claude-plugin/marketplace.json").plugins[0].version,
  "apps/cloud/src/lib/mcp/server.ts serverInfo": /name:\s*"membral-cloud",\s*version:\s*"([^"]+)"/.exec(src("apps/cloud/src/lib/mcp/server.ts"))?.[1],
  "apps/cloud/src/__golden__/routes/mcp.initialize.json": /\\"serverInfo\\":\{\\"name\\":\\"membral-cloud\\",\\"version\\":\\"([^"\\]+)\\"/.exec(src("apps/cloud/src/__golden__/routes/mcp.initialize.json"))?.[1],
  "packages/core/src/mcp-tool-manifest.ts MCP_SERVER_INFO": json_from_info(src("packages/core/src/mcp-tool-manifest.ts")),
};

function json_from_info(text) {
  return /MCP_SERVER_INFO = \{[^}]*version:\s*"([^"]+)"/.exec(text)?.[1];
}

let bad = 0;
for (const [where, v] of Object.entries(found)) {
  if (v !== want) {
    console.error(`FAIL ${where}: ${v ?? "<not found>"} != ${want} (packages/cli/package.json)`);
    bad++;
  }
}
if (bad) process.exit(1);
console.log(`ok: ${Object.keys(found).length} manifests at ${want}`);
'
