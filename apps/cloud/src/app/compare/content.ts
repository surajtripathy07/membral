// /compare copy. Verbatim from docs/COMPARISON.md on the public repo (merged as public #40), apart from link
// targets: the README link points at github.com, and the table's inline `code` spans are kept as backtick pairs that
// compare-parts.tsx renders. Change a sentence only together with that file. No product or vendor is named; the
// Membral column states only what the README documents.

import { REPO_URL } from "../_landing/content";

export const README_URL = `${REPO_URL}/blob/main/README.md`;

export const COMPARE_PAGE = {
  kicker: "Compare",
  heading: "How Membral compares",
  lede: "Membral is one of several ways to give a coding agent a past. This page compares it with the common approaches by category, not by product, so every row describes how the approach works rather than any one tool's features.",
  figLabel: "approaches compared by category",
  caption: "The Membral column states only what the",
  captionLink: "README",
  captionEnd: "documents.",
  cta: "Run it locally",
};

export const APPROACHES = [
  "Hand-kept notes (`CLAUDE.md`, `AGENTS.md`, rules files)",
  "Each agent's own transcript history",
  "Hosted memory service",
  "Membral",
] as const;

export const COMPARE_ROWS: { label: string; cells: [string, string, string, string] }[] = [
  {
    label: "Where it lives",
    cells: [
      "Files in your repo or home directory",
      "Per-agent folders on disk",
      "The vendor's servers",
      "Docker on your machine (Postgres + pgvector)",
    ],
  },
  {
    label: "Who writes it",
    cells: [
      "You",
      "The agent, automatically, as raw transcripts",
      "Usually an extraction model the service runs",
      "An extraction model you choose (Claude login, Ollama 7B+, or an API key)",
    ],
  },
  {
    label: "Covers several agents",
    cells: [
      "Only if you copy it between files",
      "No, one store per agent",
      "Depends on the service",
      "Yes: Claude Code, Codex CLI, opencode, GitHub Copilot, Antigravity",
    ],
  },
  {
    label: "Keeps the original words",
    cells: [
      "Whatever you wrote",
      "Yes, it is the transcript",
      "Depends on the service",
      "Yes: each decision and learning keeps its verbatim quote and links to the session turn",
    ],
  },
  {
    label: "Search",
    cells: [
      "Read the file, or `grep`",
      "Per-agent resume or search, if offered",
      "Depends on the service",
      "By meaning (needs an embedder), keyword fallback, over MCP",
    ],
  },
  {
    label: "Check a recalled fact against its source",
    cells: [
      "You remember where it came from",
      "Open the transcript yourself",
      "Depends on the service",
      "`get_code_session` with a `turn` shows the turns around the quote",
    ],
  },
  {
    label: "Where session text goes",
    cells: [
      "Stays where the file is",
      "Stays on disk",
      "To the service",
      "Stays on your machine, except model calls: an API key sends session text to that provider, a Claude login sends it to Anthropic through Claude Code",
    ],
  },
  {
    label: "Effort to keep current",
    cells: [
      "Manual",
      "None",
      "Depends on the service",
      "None after setup (end-of-session hooks plus a 20-minute sweep)",
    ],
  },
];

export const FITS = {
  heading: "When each fits",
  items: [
    {
      lead: "Hand-kept notes",
      text: " are the right place for rules every session must follow. Membral does not replace them; it records what happened and what was decided, not the standing rules you want applied.",
    },
    {
      lead: "Per-agent history",
      text: " is enough if you use one agent and only need to resume a recent session.",
    },
    {
      lead: "A hosted service",
      text: " suits you if you would rather not run containers and are fine with session text leaving your machine. Check each service's own documentation for what it stores and whether quotes are kept.",
    },
    {
      lead: "Membral",
      text: " suits you if you use more than one agent, want recalled facts to carry their source, and want the store local.",
    },
  ],
};

export const LIMITS = {
  heading: "Limits of Membral",
  items: [
    "One store per person; no team or admin controls yet.",
    "It is not live state: whether a PR is merged or what is deployed is checked in your forge.",
    "You run Docker (Compose 2.23+) and need one extraction model.",
    "Prompt-time lookup works in Claude Code only; the other agents get the session-start preamble and MCP search.",
    "Without an embedder, search is keyword-only.",
  ],
};
