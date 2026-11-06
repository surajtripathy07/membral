// Per-harness copy for the public /claude-code, /opencode and /codex pages. Every sentence traces to README.md
// ("Supported agents", "What it does", "How it fits together"); the MCP snippets come from the CLI's own writers
// (packages/cli/src/opencode-integration.ts) and, for Claude Code, from getMcpConfig (components/mcp-config.tsx,
// a "use client" module, so its string is mirrored here and a test keeps the two equal). Snippets use the local stack's default address and a key placeholder.
// Dropped from the first draft of these pages (public PR #39) because the README does not say them: that
// `membral setup` writes the MCP entry, that the key stays in ~/.membral behind a helper command, and `npx membral
// setup` (the package name is not claimed on npm).

export const MCP_URL = "http://localhost:3000/api/mcp";
export const SELF_HOSTING_PLUGIN_URL =
  "https://github.com/surajtripathy07/membral/blob/main/docs/SELF-HOSTING.md#claude-code-plugin";

export interface Harness {
  slug: "claude-code" | "opencode" | "codex";
  name: string;
  description: string;
  intro: string;
  /** README "Supported agents" row: the per-prompt lookup is Claude Code only. */
  promptLookup: boolean;
  connectHint: string;
  snippet: string;
}

const claudeEntry = JSON.stringify({
  type: "http",
  url: MCP_URL,
  headers: { Authorization: "Bearer YOUR_API_KEY" },
  alwaysLoad: true,
});

const opencodeEntry = JSON.stringify(
  {
    mcp: {
      membral: { type: "remote", url: MCP_URL, headers: { Authorization: "Bearer YOUR_API_KEY" }, enabled: true },
    },
  },
  null,
  2,
);

export const HARNESSES: Harness[] = [
  {
    slug: "claude-code",
    name: "Claude Code",
    description:
      "Membral keeps your Claude Code sessions in one store on your machine and lets Claude Code search them over MCP, with each record linked to its session.",
    intro:
      "Membral reads Claude Code's transcripts from disk, keeps the sessions in one store on your machine, and extracts decisions, learnings and outcomes, each with its quote and a link to the session. Claude Code searches the store over MCP.",
    promptLookup: true,
    connectHint:
      "Run in your shell with the claude CLI on your PATH. Replace YOUR_API_KEY with the key membral local up printed.",
    snippet: `claude mcp add-json membral '${claudeEntry}' --scope user`,
  },
  {
    slug: "opencode",
    name: "opencode",
    description:
      "Membral keeps your opencode sessions in one store on your machine and lets opencode search them over MCP, with each record linked to its session.",
    intro:
      "Membral reads opencode's transcripts from disk, keeps the sessions in one store on your machine, and extracts decisions, learnings and outcomes, each with its quote and a link to the session. opencode searches the store over MCP.",
    promptLookup: false,
    connectHint:
      "Merge into ~/.config/opencode/opencode.json. Replace YOUR_API_KEY with the key membral local up printed.",
    snippet: opencodeEntry,
  },
  {
    slug: "codex",
    name: "Codex",
    description:
      "Membral keeps your Codex CLI sessions in one store on your machine and lets Codex search them over MCP, with each record linked to its session.",
    intro:
      "Membral reads Codex CLI's transcripts from disk, keeps the sessions in one store on your machine, and extracts decisions, learnings and outcomes, each with its quote and a link to the session. Codex searches the store over MCP.",
    promptLookup: false,
    connectHint: "With the stack running, run the CLI's setup command. It is listed under Commands in the README.",
    snippet: "membral setup",
  },
];

export function getHarness(slug: string): Harness | undefined {
  return HARNESSES.find((h) => h.slug === slug);
}

/** The rows of the "what it does for this agent" figure: README "Supported agents" and "How it fits together". */
export function capabilityRows(h: Harness): { k: string; v: string }[] {
  return [
    { k: "Capture", v: `Reads ${h.name}'s transcripts from disk, with end-of-session hooks` },
    { k: "Sync", v: "membral sessions, plus a 20-minute sweep" },
    { k: "MCP", v: `${h.name} searches with memory_search, memory_recall and get_code_session` },
    { k: "Preamble", v: "Added at session start" },
    {
      k: "Prompt lookup",
      v: h.promptLookup
        ? "Matching records arrive with each prompt, in Claude Code only"
        : "Not available here: the per-prompt lookup is Claude Code only",
    },
  ];
}
