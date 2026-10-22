/**
 * Every forge verb, as a runtime list — the one source of truth: `ForgeVerb` is built from it, and the
 * cloud's upload schema (apps/cloud/src/lib/code-sessions/payload.ts) validates against it (#209).
 */
export const FORGE_VERBS = [
  // review ladder
  "viewed",
  "checked_out",
  "commented",
  "approved",
  // build ladder
  "committed",
  "pushed",
  "opened_mr",
  // closure class (B6's strongest evidence)
  "merged",
  "closed",
  // reopen: supersedes an earlier `closed` on the same ref (state `opened`)
  "reopened",
  // stand-alone
  "triaged",
  // `gh/glab issue create` whose own result line printed the new issue's URL: the item was filed
  // here — observed, but neither a review nor a build rung (filing is not working on it)
  "opened",
  "tested",
  // rewrite class: moves which sha the closure check looks at, never a rung
  "rewrote",
  // navigation class: recorded, contributes no ladder verb
  "navigated",
  // a slash line or pasted URL naming a ref, no verb of its own
  "referenced",
] as const;
export type ForgeVerb = (typeof FORGE_VERBS)[number];

export const FORGE_REF_KINDS = ["issue", "merge_request", "commit", "branch"] as const;
export type ForgeRefKind = (typeof FORGE_REF_KINDS)[number];

export const FORGE_ACTION_SOURCES = ["cli", "mcp", "command", "paste"] as const;
export type ForgeActionSource = (typeof FORGE_ACTION_SOURCES)[number];

export interface ForgeAction {
  verb: ForgeVerb;
  /** `owner/repo!N` / `owner/repo#N` when the project is known, else `!N` / `#N`; a branch name for branch-kind actions. */
  ref?: string;
  refKind?: ForgeRefKind;
  /** Commit sha parsed from a `[branch sha] subject` result line, or from a pasted commit URL. */
  sha?: string;
  /** Forge URL of the item (from `mr/pr create` results, MCP `web_url`, a pasted or slash-line URL). */
  url?: string;
  /** The forge's own word for the item's state when the result showed it: `opened`, `merged`, `closed`, `locked`, `draft`. */
  state?: string;
  /**
   * Branch a commit landed on / a push updated / a checkout moved to (from the result where possible, else the args).
   * For `opened_mr`: the MR's head branch (`--head`/`-H`, `--source-branch`/`-s`, glab's `(branch)` result line, or
   * the branch pushed earlier in the session); unset when unknown — never the session's starting branch.
   * For `viewed`: the item's source/head branch, read off the result only when it is unambiguously tied to
   * this action's ref, same rule as `title` — gh/glab view output (`source_branch:`/`Source branch:`/`head:`
   * text field, glab's `(branch)` header line, JSON `source_branch`/`headRefName`) or an MCP `get_*`'s JSON
   * `source_branch`/`head.ref`.
   */
  branch?: string;
  /**
   * W3 D9: on a `navigated` branch action (checkout/switch/worktree add), the name is known to be a
   * branch — named by a create flag (`-b`/`-B`/`-c`/`-C`/`--orphan`), or, for a plain
   * `git checkout|switch <name>`, by git's own `Switched to [a new] branch '<name>'` line. Without it
   * the name may be a path or a sha; `ref`/`branch` are kept either way (D-055 lineage reads them).
   */
  branchConfirmed?: true;
  /** Redacted, capped commit subject from the `[branch sha] subject` line. */
  subject?: string;
  /** Slash-command skill name (`/review-mr` → `review-mr`) — a display label only, never consulted for a verb (B13). */
  skill?: string;
  /** The item's title, read off the result only when it is unambiguously tied to this action's ref (gh/glab view output, or an MCP `get_*`'s JSON `title`) — redacted and capped like a commit subject. */
  title?: string;
  source: ForgeActionSource;
  /**
   * Set when nothing observable ties the action to the session's own repo (D-051 F1): the command
   * ran in a directory that is not the project's repo (or one this parser could not follow), or
   * named `-R/--repo`/`GH_REPO` with a value that cannot be read (`-R "$R"`), and neither a readable
   * repo flag nor the command's own result URL for the same item named the repo. A consumer must
   * never qualify such an action's ref to the session's project, nor let it count for that project.
   */
  repoUnknown?: true;
  /**
   * LOCAL ONLY, never uploaded (D-051 F1): the absolute directory the command ran in, when this
   * parser could follow it. The importer resolves it to a repo with `settleActionDir`, which
   * removes it; the uploader drops any it finds unsettled (treating the repo as unknown).
   */
  dir?: string;
  /** LOCAL ONLY, never uploaded (D-051 S3): the `owner/repo` the command's own result URL shows for this item. */
  shownRepo?: string;
}

// A test-runner invocation (after any `VAR=x` prefixes). Package managers
// count only for their `test` script; `npm i`, `npx supabase`, `npx vercel`
// are not tests.
export const TEST_RUNNER_SOURCE =
  "(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*(?:" +
  "(?:npm|pnpm|yarn|bun)\\s+(?:run\\s+)?test\\b" +
  "|npm\\s+t\\b" +
  "|(?:npx|bunx|pnpm\\s+(?:exec|dlx)|yarn)\\s+(?:-y\\s+)?(?:vitest|jest|mocha|ava|playwright\\s+test|cypress\\s+run)\\b" +
  "|(?:npx\\s+|pnpm\\s+(?:exec\\s+)?|yarn\\s+)?turbo\\s+(?:run\\s+)?test\\b" +
  "|vitest\\b|jest\\b|pytest\\b|python3?\\s+-m\\s+pytest\\b|go\\s+test\\b|cargo\\s+test\\b" +
  "|(?:bundle\\s+exec\\s+)?(?:rspec|rails\\s+test)\\b|mix\\s+test\\b|dotnet\\s+test\\b|mvn\\s+test\\b|(?:\\.\\/)?gradlew?\\s+test\\b|make\\s+test\\b" +
  ")";
export const TEST_SEGMENT = new RegExp(`^${TEST_RUNNER_SOURCE}`);

/** Bash commands whose input is digested (ADR 0026 D10 allowlist, widened by W3 to glab). A leading `cd <dir> &&` is tolerated. */
export const FORGE_COMMAND = /^(?:cd\s+\S+\s*&&\s*)?(gh|git|glab)\b/;
/** Test runners: digest kept (400-char cap), verb `tested`. */
export const TEST_COMMAND = new RegExp(`^(?:cd\\s+\\S+\\s*&&\\s*)?${TEST_RUNNER_SOURCE}`);

export interface ToolActionInput {
  /** The harness's tool name (`Bash`, `bash`, `mcp__gitlab__get_merge_request`, `Skill`, …) — matched case-insensitively. */
  toolName: string;
  /** Structured MCP tool name when the harness attributes one (Claude Code's `attributionMcpTool`, opencode's split). */
  mcpTool?: string;
  input?: Record<string, unknown>;
  /** Result text: Claude Code's `tool_result` block content or opencode's `part.state.output`. Parsed, never stored. */
  result?: string;
  isError?: boolean;
  /** D-051 F1: the absolute directory the call started in (Claude Code's per-event `cwd`); each action's `dir` is tracked from it. */
  cwd?: string;
}
