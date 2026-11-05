// Per-harness copy for the public /claude-code, /opencode and /codex pages. Facts come from README.md
// ("Supported agents") and the CLI's own writers: packages/cli/src/{opencode-integration,codex-setup}.ts and,
// for Claude Code, getMcpConfig (components/mcp-config.tsx, a client module, so its string is mirrored here and
// a test keeps the two equal). Snippets use the local stack's default address and a key placeholder.

export const MCP_URL = "http://localhost:3000/api/mcp";

export interface Harness {
  slug: "claude-code" | "opencode" | "codex";
  name: string;
  description: string;
  intro: string;
  connectHint: string;
  snippet: string;
}

const claudeEntry = JSON.stringify({
  type: "http",
  url: MCP_URL,
  headers: { Authorization: "Bearer YOUR_API_KEY" },
  alwaysLoad: true,
});

export const HARNESSES: Harness[] = [
  {
    slug: "claude-code",
    name: "Claude Code",
    description:
      "Membral saves your Claude Code sessions and lets Claude Code search them over MCP, with each memory tied to the turn it came from.",
    intro:
      "Membral reads Claude Code transcripts, saves the sessions in one store, and extracts decisions, learnings and outcomes, each linked to the exact words and the turn they came from. Claude Code gets capture, sync, MCP search and a session-start preamble.",
    connectHint: "Run in your shell (requires the claude CLI on PATH). `membral setup` does this for you.",
    snippet: `claude mcp add-json membral '${claudeEntry}' --scope user`,
  },
  {
    slug: "opencode",
    name: "opencode",
    description:
      "Membral saves your opencode sessions and lets opencode search them over MCP, with each memory tied to the turn it came from.",
    intro:
      "Membral reads opencode sessions, saves them in one store, and extracts decisions, learnings and outcomes, each linked to its source turn. opencode gets capture, sync, MCP search and a session-start preamble.",
    connectHint:
      "Merge into ~/.config/opencode/opencode.json. `membral setup` writes this entry for you.",
    snippet: JSON.stringify(
      {
        mcp: {
          membral: {
            type: "remote",
            url: MCP_URL,
            headers: { Authorization: "Bearer YOUR_API_KEY" },
            enabled: true,
          },
        },
      },
      null,
      2,
    ),
  },
  {
    slug: "codex",
    name: "Codex",
    description:
      "Membral saves your Codex CLI sessions and lets Codex search them over MCP, with each memory tied to the turn it came from.",
    intro:
      "Membral reads Codex CLI sessions, saves them in one store, and extracts decisions, learnings and outcomes, each linked to its source turn. Codex gets capture, sync, MCP search and a session-start preamble.",
    connectHint:
      "Run this and it writes the [mcp_servers.membral] table into ~/.codex/config.toml. The key stays in ~/.membral and is supplied to Codex by a helper command, never written to the config.",
    snippet: "npx membral setup",
  },
];

export function getHarness(slug: string): Harness | undefined {
  return HARNESSES.find((h) => h.slug === slug);
}
