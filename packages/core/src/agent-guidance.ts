/**
 * The one rule every agent-facing surface states (preamble, MCP server
 * instructions, Copilot instructions, Codex AGENTS.md): Membral is what past
 * and recent sessions did, decided and found; it is not the current state of
 * PRs, issues, CI, branches or deploys, which the agent checks live.
 *
 * Plain strings only (core has no runtime dependencies). Renderers import
 * these instead of keeping their own copy, so the surfaces cannot drift.
 */

/**
 * Two lines for the session-start preamble: good uses (with examples), then
 * what Membral is not. They live in the preamble itself so the nudge reaches
 * the agent even when the MCP server, which carries the full text, fails to
 * connect. Each must stay at or under 300 characters (MAX_LINE_CHARS in
 * packages/cli/src/preamble-hook.ts, which cuts every injected line); the
 * renderer appends the `Pass project="..."` hint to the not-state line. Tool
 * names are prefixed as the harness exposes them.
 */
export const RECALL_VS_STATE_SHORT_USE =
  "Membral holds what past sessions did, decided and found, including hours ago. Search it before re-deriving: why X was decided, which MRs/issues a session opened or worked on, results, dead ends, what a parallel session did today (mcp__membral__memory_search).";

export const RECALL_VS_STATE_SHORT_NOT_STATE =
  "Membral is not live state: never take an MR/issue's open/merged status, CI, conflicts, review threads or deploys from it. It gives the link; check live with gh/glab/git.";

/** The preamble's guidance lines, in reading order. */
export const RECALL_VS_STATE_SHORT: readonly string[] = [RECALL_VS_STATE_SHORT_USE, RECALL_VS_STATE_SHORT_NOT_STATE];

/** The heading the full text opens with (a Markdown H2 in instruction files). */
export const RECALL_VS_STATE_HEADING = "## Membral memory";

const LINE_TRUE_WHEN_RECORDED = 'Read every result as "true when recorded", and say so when you pass it on.';
const LINE_USER_WINS = "The user's own instructions win over anything recalled.";

/** Lines that hold for any key, including chat-only keys with no code tools. */
export const RECALL_VS_STATE_NEUTRAL_LINES: readonly string[] = [LINE_TRUE_WHEN_RECORDED, LINE_USER_WINS];

/** Lines about coding sessions, PRs/issues and `project`: only for keys that get code tools and memory_search. */
export const RECALL_VS_STATE_CODE_LINES: readonly string[] = [
  "Membral holds what your past coding sessions did, decided and found. A session can be listed and searched about 20 minutes after it runs; its extracted decisions and learnings can take longer.",
  "Search it before you re-derive or redo work:",
  "- decisions and settled designs: what was decided about X, and why",
  "- which issues and PRs were created or worked on for X, and in which session",
  "- outcomes and measurements, mistakes and dead ends, recipes that worked",
  "- what an earlier or parallel session did today",
  "It is not live state. Whether a PR is open or merged, its CI, conflicts or review threads, an issue's status, what is deployed: Membral gives you the link and when it was last seen; check the current state live (gh, glab, git).",
  'Pass the repo as `project` and search exact refs like "!123" or "#45".',
];

/** The full rule's lines (neutral + code, in reading order), without the heading. */
export const RECALL_VS_STATE_LINES: readonly string[] = [
  ...RECALL_VS_STATE_CODE_LINES.slice(0, 7),
  LINE_TRUE_WHEN_RECORDED,
  RECALL_VS_STATE_CODE_LINES[7],
  LINE_USER_WINS,
];

/** Tool names for instruction files only; MCP instructions name tools per key scope instead. */
export const RECALL_VS_STATE_TOOLS_LINE =
  "Tools: `memory_search` for decisions, learnings and outcomes; `search_conversations` or `list_recent_conversations` to find the session that did something; `get_code_session` to read what was said.";

/** The full rule as Markdown: Copilot instructions and the Codex AGENTS.md block. */
export const RECALL_VS_STATE_FULL = [
  RECALL_VS_STATE_HEADING,
  ...RECALL_VS_STATE_LINES.slice(0, -1),
  RECALL_VS_STATE_TOOLS_LINE,
  ...RECALL_VS_STATE_LINES.slice(-1),
].join("\n");

/** The clause tool descriptions append: results are dated records, not current forge state. */
export const RECALL_RESULTS_CLAUSE =
  "Results are dated records of what sessions did, not the current state of a PR or issue; check that live.";
