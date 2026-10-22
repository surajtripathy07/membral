// Source-agnostic code-session parser interface (ADR 0021, Q3; extended per
// ADR 0023/0026 P2a — code-session knowledge graph, deterministic tier).
// Zero fs/network dependencies in the interface itself — `detect()` implementations
// may use node:fs, but `parse()` only ever operates on bytes already in memory.
//
// SOURCE-OPTIONAL (ADR 0026 D13): every field added below is OPTIONAL. They
// were validated against Claude Code transcripts only (`packages/core/src/
// sessions/` has no opencode/codex parser yet) — a source that cannot fill a
// field must leave it undefined, and every consumer (Stage-1 extractor) must
// produce a valid, smaller graph rather than fail. Never assume any of these
// are universal across sources or across Claude Code versions.

import type { ForgeAction } from "./forge-actions.js";

export interface SessionRef {
  /** Parser source id, e.g. 'claude-code' | 'opencode' | 'codex'. */
  source: string;
  /** Stable id for the session within its source (e.g. Claude Code's sessionId). */
  sourceSessionId: string;
  /** Filesystem path (or source-specific locator) the raw bytes/text can be read from. */
  path: string;
  /**
   * Directory containing this session's sub-agent sidecars
   * (`agent-<id>.jsonl` + `agent-<id>.meta.json`), if the source lays them
   * out this way (ADR 0026 D3 — Claude Code only, `<session-id>/subagents/`).
   * Undefined for sources with no sub-agent sidecar concept. `detect()` may
   * set this (it's allowed fs access); `parse()` never reads the filesystem
   * itself — the caller reads this directory and passes the bytes via
   * `ParseExtras.subAgents`.
   */
  subAgentsDir?: string;
}

/** One sub-agent sidecar's raw bytes, read by the caller (CLI) and handed to `parse()`. */
export interface SubAgentFile {
  /** The agent id parsed from the sidecar filename (`agent-<agentId>.jsonl`). */
  agentId: string;
  /** Raw bytes of `agent-<agentId>.meta.json`. */
  meta: string | Buffer;
  /** Raw bytes of `agent-<agentId>.jsonl`, when present on disk (ADR 0026: ~1.7% of spawns have no file). */
  transcript?: string | Buffer;
}

export interface ParseExtras {
  /** Sub-agent sidecars for this session, pre-read by the caller (ADR 0026 D3). */
  subAgents?: SubAgentFile[];
}

export interface CodeSessionParser {
  /** 'claude-code' | 'opencode' | 'codex' */
  readonly source: string;
  /**
   * Discover session files/records under `root`. `root` itself being
   * missing/unreadable is a hard failure (implementations should throw,
   * e.g. claudeCodeParser's `SessionRootUnreadableError` — see
   * claude-code.ts) — that's "capture is broken", never the same as "found
   * nothing". A single unreadable SUBDIRECTORY under `root` is expected to
   * be swallowed and skipped rather than failing the whole walk (one
   * corrupted project folder shouldn't block every other project), but
   * that skip should not be silent: `onWarn`, when passed, is called once
   * per skipped subdirectory with a human-readable reason, so a caller
   * (e.g. the CLI's `import-sessions`) can surface it instead of losing the
   * diagnostic entirely (round 3 adversarial review, Minor 2).
   */
  detect(root: string, onWarn?: (message: string) => void): Promise<SessionRef[]>;
  /** Parse one session's raw bytes (+ optional pre-read sidecars) into a normalized RawCodeSession. */
  parse(ref: SessionRef, raw: string | Buffer, extras?: ParseExtras): RawCodeSession;
  /**
   * Turn each pre-read sub-agent transcript into its OWN child session
   * (`parentSessionId` = `parent.sourceSessionId`), so its turns reach
   * memory extraction and the session view instead of only a usage summary.
   * Optional: a source whose sub-agents are discovered as ordinary sessions
   * (opencode — child rows carry `parent_id`) leaves this undefined. `parent`
   * is the already-parsed parent session; a child with no cwd/branch of its
   * own inherits the parent's repo so it resolves to the same project.
   */
  parseSubAgentSessions?(parent: RawCodeSession, extras?: ParseExtras): RawCodeSession[];
}

/** Four-bucket token usage (ADR 0026 D4 — two buckets understate cost 6.2x; named to match OTel `gen_ai.usage.*` for a future rename-only export). */
export interface RawUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /**
   * The part of `cacheCreationInputTokens` written to the 1-hour cache (priced at 2x input, not the
   * 5-minute 1.25x). Present only when the transcript reports the split (Claude Code `usage.cache_creation`).
   */
  cacheCreation1hInputTokens?: number;
}

/** A discovered sub-agent spawn (ADR 0026 D3). All fields but `usage` optional — a spawn with no transcript on disk still yields a node with null tokens. */
export interface RawSubAgent {
  /** meta.json's `toolUseId` — the primary join key to the spawning Agent/Task tool_use in the parent transcript (98.3% coverage). */
  toolUseId?: string;
  /** Redundant join path: the parent tool_use's `toolUseResult.agentId` (100% parent-side coverage). */
  agentId?: string;
  /** meta.json's `agentType` (100% present): 'general-purpose' | 'Explore' | 'fork' | 'Plan' | a named agent. */
  agentType?: string;
  description?: string;
  /** meta.json's `spawnDepth` (100% present); depth 2 = nested spawn, join via `parentAgentId`. */
  spawnDepth?: number;
  /** From the sub-agent transcript's `message.model` — NOT `meta.model` (only 42% present, override-only). */
  model?: string;
  /** Nested-spawn parent, when `spawnDepth > 1`. */
  parentAgentId?: string;
  /** `isFork:true` sidecars inherit their parent's context and must not become a distinct SubAgent node — the extractor filters these, the parser only reports the fact. */
  isFork?: boolean;
  /** Summed across the sub-agent transcript's own `usage`, four buckets — undefined when no transcript is on disk. */
  usage?: RawUsage;
}

export interface RawCodeSession {
  source: string;
  sourceSessionId: string;
  contentHash: string;
  repo: { path?: string; remoteUrl?: string; branch?: string };
  startedAt: string; // ISO
  endedAt: string; // ISO (normalize opencode epoch-ms)
  model?: string;
  turns: RawTurn[]; // ordered
  filesTouched: string[];
  toolCounts: Record<string, number>;
  /** Session-total token usage, summed across main-transcript assistant messages (ADR 0026 D4). */
  usage?: RawUsage;
  /** Distinct models used in this session, excluding the literal `<synthetic>` sentinel (ADR 0026 D4 — 9.8% of sessions run more than one). */
  models?: string[];
  /** Sub-agents spawned in this session (ADR 0026 D3). Empty/undefined when the source has no sub-agent sidecar or none were spawned. */
  subAgents?: RawSubAgent[];
  /**
   * Set only on a sub-agent's own session: the `sourceSessionId` of the
   * session that spawned it (same source). Claude Code child ids are
   * `${parentSessionId}:agent-${agentId}`; opencode children keep their own
   * `ses_…` id.
   */
  parentSessionId?: string;
  /**
   * The forge-action parser version (`FORGE_ACTIONS_VERSION`) that parsed
   * this session's turns. Present => turns' `action`/`actions` were looked
   * for, so none means none happened; absent => a pre-W3 CLI (no action data).
   */
  actionsVersion?: number;
  /** Set only on a sub-agent's own session: the spawn's metadata (agentType, description, toolUseId, model, …), same shape as the parent's `subAgents[]` entry. */
  subAgent?: RawSubAgent;
  /**
   * Recall-precision W3b: the CLI prompt hook's outcomes for this session,
   * summed from the client-only outcome log. Absent from older CLIs and when
   * the hook never ran for the session. Stored as code_sessions.props.hook_outcomes.
   */
  hookOutcomes?: HookOutcomeSummary;
}

/** Per-session prompt-hook outcome counts (recall-precision W3b). `calls` = every other field summed. */
export interface HookOutcomeSummary {
  calls: number;
  injected: number;
  empty: number;
  budget_hit: number;
  timeout: number;
  errors: number;
}

export interface RawTurn {
  idx: number;
  role: "user" | "assistant";
  kind: "prose" | "tool_use" | "tool_result" | "thinking";
  text?: string;
  toolName?: string;
  filePath?: string;
  ts: string;
  /** The tool_use block's own id (assistant tool_use turns only) — join key for SubAgent correlation and for backfilling `resultType`/`editHunks` from the later tool_result event. */
  toolUseId?: string;
  /** File-touching tool_use turns only (ADR 0026 D1): from `toolUseResult.type`, NOT the tool name — `Write` produces `update` 5.3% of the time. */
  resultType?: "create" | "update";
  /** `Edit` tool_use turns only (ADR 0026 D1): hunk count from `toolUseResult.structuredPatch`, a truer edit-size signal than a bare call count. */
  editHunks?: number;
  /** MCP tool_use turns only (ADR 0026 D2): from `attributionMcpServer`/`attributionMcpTool` — turns `mcp__foo__bar` into a structured (server, tool) pair. */
  mcpServer?: string;
  mcpTool?: string;
  /** Redacted, length-capped digest of the tool's input for an allowlisted subset of tools (ADR 0026 D10 — `gh`/`git` Bash commands, Agent description, WebFetch url). Never raw/unredacted; never populated for non-allowlisted tools. */
  inputDigest?: string;
  /**
   * Goal 2026-09-26 W3 (D-051): the structured forge action this turn
   * observably performed — parsed by `forge-actions.ts` from a `git`/`gh`/
   * `glab` Bash command and its result, a forge MCP call, a slash line
   * (`<command-name>`, source `command`) or a pasted forge URL (source
   * `paste`). Fixed-shape fields only, each redacted and capped; the result
   * text itself stays elided (B10). When a chained command yields several
   * actions this is the highest-ranked one and `actions` carries them all.
   */
  action?: ForgeAction;
  /** Every action of a chained command (`git commit … && git push`), in command order — only set when there is more than one. */
  actions?: ForgeAction[];
  /**
   * Set on a `role: "user"` prose turn the owner did not write: the harness's compaction summary
   * (`compact_summary`, Claude Code `isCompactSummary`), shell output echoed into the chat
   * (`shell_output`, `<bash-stdout>`/`<bash-stderr>`/`<local-command-stdout>`), or a harness caveat
   * (`caveat`, `<local-command-caveat>`). The text is kept for context; consumers must not treat it as
   * the owner's words (user-named refs, owner quotes, priority). Absent on the owner's own prose.
   */
  nonOwner?: NonOwnerKind;
  /**
   * Set on a user prose turn whose prompt carries pasted spans (Claude Code
   * `<pasted_content id="…">…</pasted_content id="…">`): the prompt with those
   * spans removed — the owner's own words. `text` keeps the paste for context;
   * owner quotes and named refs ground only on this. Absent when nothing was pasted.
   */
  ownerText?: string;
}

/** `agent_brief` (D-051 F2): a sub-agent session's user-role line — the parent agent's brief, never the owner's words. */
export const NON_OWNER_KINDS = ["compact_summary", "shell_output", "caveat", "agent_brief"] as const;
export type NonOwnerKind = (typeof NON_OWNER_KINDS)[number];
