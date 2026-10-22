// Memory v1, source C (tail capture) — the renderer (docs/design/memory-v1.md
// §3 "Shared by all three"). Turns a stored session's rows into the text a
// window's prompt is built from: a short header (repo/branch, start/end,
// models, four-bucket usage + cost, filesTouched, top-10 toolCounts, the
// sub-agent tree, a "delivered" block of outcome hints) plus one line per
// non-thinking turn, in idx order.
//
// Rendering rules (design §3, verbatim):
//   - prose            -> verbatim text, both roles quotable
//   - tool_use         -> collapsed to `[tool: <Name> <path-or-arg>]`
//   - tool_result      -> already elided by the parser at ingest
//     (packages/core/src/sessions/claude-code.ts) — rendered as-is
//   - thinking         -> dropped entirely (no line emitted)
//
// Outcomes are DETECTED, never invented (§3): a session's `gh`/`git` forge
// commands are scanned from `props.inputDigest` (ADR 0026 D10) and surfaced
// to the model as HINTS in the header's "Delivered" block — the model still
// has to point at real transcript text for anything it emits; grounding
// (merge.ts) is the actual verification step.
import type { RawUsage } from "@membral/core";
import { type AttributionTurnInput, parseCommitEvents } from "@/lib/agent-stats/attribution";
import { computeCost, PRICE_TABLE_VERSION } from "@/lib/code-sessions/price-table";
import type { RefKind } from "./schema";

export interface CodeSessionRow {
  id: string;
  user_id: string;
  code_project_id: string;
  source: string;
  source_session_id: string;
  git_branch: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  files_touched: string[];
  props: Record<string, unknown> | null;
  /** code_projects.display_name, when the caller joined it in — falls back to the bare code_project_id in the header. */
  project_display_name?: string | null;
}

export type TurnKind = "prose" | "tool_use" | "tool_result" | "thinking";
export type TurnRole = "user" | "assistant";

export interface TurnRow {
  idx: number;
  role: TurnRole;
  kind: TurnKind;
  text: string | null;
  tool_name: string | null;
  file_path: string | null;
  ts: string | null;
  props: { inputDigest?: unknown; mcpServer?: unknown; mcpTool?: unknown; nonOwner?: unknown } | null;
}

export interface RawSubAgentLike {
  agentId?: string;
  agentType?: string;
  description?: string;
  model?: string;
  isFork?: boolean;
  usage?: RawUsage;
}

export interface RenderedTurn {
  idx: number;
  role: TurnRole;
  kind: TurnKind;
  /** Rendered line, e.g. "[#12 user] fix the flaky test" or "[#13 assistant tool_use] [tool: Edit apps/x.ts]". Empty for dropped (thinking) turns — see renderTurnLines, which never emits those at all. */
  line: string;
  isProse: boolean;
  /** A user-role prose turn the owner did not write (compaction summary, shell output, harness caveat — `props.nonOwner`). Never the owner's words. */
  nonOwner?: boolean;
  /** A tool_use turn carrying the text the session wrote (Write/Edit/MultiEdit): authored text, not tool noise. */
  hasWrittenText?: boolean;
  charLen: number;
}

/** One `gh`/`git`/MCP call the model is nudged to consider as a possible outcome — never inserted into a record directly (§3: "outcomes are detected from tool calls, never invented"). */
export interface OutcomeHint {
  turn_idx: number;
  turn_role: TurnRole;
  ref_kind: RefKind;
  /** Short, human-readable description fed to the model as context — the model still has to quote real transcript text for anything it emits. */
  hint: string;
}

const FORGE_PATTERNS: ReadonlyArray<{ re: RegExp; ref_kind: RefKind }> = [
  { re: /\bgh\s+issue\s+create\b/, ref_kind: "issue" },
  { re: /\bgh\s+issue\s+comment\b/, ref_kind: "comment" },
  { re: /\bgh\s+pr\s+create\b/, ref_kind: "pr" },
  { re: /\bgh\s+pr\s+comment\b/, ref_kind: "comment" },
  { re: /\bgh\s+release\s+create\b/, ref_kind: "release" },
  { re: /\bgit\s+push\b/, ref_kind: "branch" },
  { re: /\bgit\s+tag\b/, ref_kind: "tag" },
];

/**
 * The label a sub-agent session's role-"user" turns carry in the rendered
 * transcript. A sub-agent's "user" turns are the brief and follow-ups from
 * the PARENT agent that launched it, never the human owner — the extraction
 * prompt must not read them as the owner's voice. `RenderedTurn.role` stays
 * "user" (it is the stored role); only the line text changes.
 */
export const PARENT_AGENT_ROLE_LABEL = "parent_agent";

export interface RenderTurnOptions {
  /** True for a sub-agent session (`code_sessions.parent_source_session_id` set): role-"user" turns render as `PARENT_AGENT_ROLE_LABEL`. */
  subAgent?: boolean;
}

/** Renders one non-thinking turn to its prompt line. Never throws — a missing text/tool_name degrades to an empty placeholder rather than "undefined". */
export function renderTurnLine(t: TurnRow, opts: RenderTurnOptions = {}): string {
  const role = opts.subAgent && t.role === "user" ? PARENT_AGENT_ROLE_LABEL : t.role;
  if (t.kind === "tool_use") {
    const label = t.file_path ? `${t.tool_name ?? "tool"} ${t.file_path}` : (t.tool_name ?? "tool");
    const tag = `[#${t.idx} ${role} tool_use] [tool: ${label}]`;
    // Write/Edit/MultiEdit: the text the session wrote to that file (parser-capped), under the tag.
    return t.text ? `${tag}\n${t.text}` : tag;
  }
  if (t.kind === "tool_result") {
    return `[#${t.idx} ${role} tool_result] ${t.text ?? "[tool_result elided: unknown]"}`;
  }
  // prose — verbatim, both roles quotable (§3 finding 14).
  return `[#${t.idx} ${role}] ${t.text ?? ""}`;
}

/** Renders every turn EXCEPT `thinking` (dropped entirely, per §3). */
export function renderTurnLines(turns: TurnRow[], opts: RenderTurnOptions = {}): RenderedTurn[] {
  const out: RenderedTurn[] = [];
  for (const t of turns) {
    if (t.kind === "thinking") continue;
    const line = renderTurnLine(t, opts);
    out.push({
      idx: t.idx,
      role: t.role,
      kind: t.kind,
      line,
      isProse: t.kind === "prose",
      ...(t.props?.nonOwner ? { nonOwner: true } : {}),
      ...(t.kind === "tool_use" && t.text?.trim() ? { hasWrittenText: true } : {}),
      charLen: line.length,
    });
  }
  return out;
}

/** `git commit` events (via attribution.ts, never re-implemented) plus every other allowlisted forge command, as outcome hints for the extraction prompt. Best-effort turn_idx: attribution.ts's CommitEvent carries no turn index, only the Bash call's own timestamp (`at`) — matched back to the turn that produced it. A miss (rare — only when timestamps collide or are absent) still yields a hint, just anchored to idx 0; grounding in merge.ts is the real verification step, this is only prompt context. */
export function detectOutcomeHints(turns: TurnRow[]): OutcomeHint[] {
  const hints: OutcomeHint[] = [];

  const attributionInputs: AttributionTurnInput[] = turns.map((t) => ({
    session_id: "session",
    idx: t.idx,
    role: t.role,
    kind: t.kind,
    text: t.text,
    tool_name: t.tool_name,
    ts: t.ts,
    props: t.props,
  }));
  for (const c of parseCommitEvents(attributionInputs)) {
    const matched = turns.find(
      (t) =>
        t.kind === "tool_use" &&
        t.tool_name === "Bash" &&
        t.ts === c.at &&
        /\bgit\s+commit\b/.test(String(t.props?.inputDigest ?? "")),
    );
    hints.push({
      turn_idx: matched?.idx ?? 0,
      turn_role: matched?.role ?? "assistant",
      ref_kind: "commit",
      hint: `commit: ${c.subject}${c.sha ? ` sha=${c.sha}` : ""}`.slice(0, 200),
    });
  }

  for (const t of turns) {
    if (t.kind !== "tool_use") continue;
    if (t.tool_name === "Bash") {
      const digest = typeof t.props?.inputDigest === "string" ? t.props.inputDigest : undefined;
      if (!digest) continue;
      for (const { re, ref_kind } of FORGE_PATTERNS) {
        if (re.test(digest)) {
          hints.push({ turn_idx: t.idx, turn_role: t.role, ref_kind, hint: digest.slice(0, 200) });
          break;
        }
      }
    } else if (t.props?.mcpServer || t.props?.mcpTool) {
      hints.push({
        turn_idx: t.idx,
        turn_role: t.role,
        ref_kind: "other",
        hint: `mcp call: ${String(t.props?.mcpServer ?? "")}/${String(t.props?.mcpTool ?? "")}`,
      });
    }
  }
  return hints;
}

// A generic repo-relative-path shape: "some/thing.ext" or "some/thing" with
// at least one path separator — deliberately loose (this only decides
// whether to add a "be strict" note to the prompt, never whether to keep or
// drop a record; the grounding check is what actually verifies anything).
const PATH_LIKE = /\b[\w.-]+(?:\/[\w.-]+)+(?:\.[A-Za-z0-9]{1,8})?\b/;

/**
 * Finding B's deterministic companion (step2b): true when this session
 * shows no sign of touching the repo at all — `files_touched` is empty AND
 * no prose turn (either role) names anything path-shaped. Off-repo work
 * (an advisor/life session that merely happened to run with the repo as
 * cwd) is the profile this flags; extraction still runs, but extract.ts
 * adds a "be strict" note to the prompt rather than skipping the session
 * outright, since a real off-repo DECISION about how the owner works with
 * this repo is still fair game (design §2's `scope: "global"`).
 */
export function isOffRepoStrict(filesTouched: string[], turns: TurnRow[]): boolean {
  if (filesTouched.length > 0) return false;
  return !turns.some((t) => t.kind === "prose" && t.text && PATH_LIKE.test(t.text));
}

/** Top-10 tool_use counts by tool name, descending. */
export function topToolCounts(turns: TurnRow[], limit = 10): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const t of turns) {
    if (t.kind !== "tool_use" || !t.tool_name) continue;
    counts.set(t.tool_name, (counts.get(t.tool_name) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
}

function formatUsageLine(usage: RawUsage | undefined, model: string | null): string {
  if (!usage) return "Usage: (none recorded)";
  const cost = computeCost(usage, model ?? undefined);
  const costStr = cost ? `$${cost.amount.toFixed(4)} (price-table ${PRICE_TABLE_VERSION})` : "unpriced";
  return `Usage: in=${usage.inputTokens} out=${usage.outputTokens} cache_read=${usage.cacheReadInputTokens} cache_creation=${usage.cacheCreationInputTokens} cost=${costStr}`;
}

function renderSubAgentTree(props: Record<string, unknown> | null): string[] {
  const raw = props?.subAgents;
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const lines: string[] = ["Sub-agents:"];
  for (const a of raw as RawSubAgentLike[]) {
    if (a.isFork) continue; // forks inherit the parent's context — not a distinct agent (parser contract)
    const usage = a.usage ? ` tokens(in=${a.usage.inputTokens},out=${a.usage.outputTokens})` : "";
    lines.push(`  - ${a.agentType ?? "agent"}${a.model ? ` (${a.model})` : ""}${usage}`);
  }
  return lines.length > 1 ? lines : [];
}

function renderDeliveredBlock(hints: OutcomeHint[]): string[] {
  if (hints.length === 0) return ["Delivered: (no gh/git/MCP outcome signals detected)"];
  const lines = ["Delivered (detected, unverified — the model must ground any it uses):"];
  for (const h of hints.slice(0, 20)) lines.push(`  - [#${h.turn_idx}] ${h.ref_kind}: ${h.hint}`);
  return lines;
}

export interface SessionHeader {
  text: string;
  outcomeHints: OutcomeHint[];
  /** Finding B's deterministic companion — see `isOffRepoStrict`. */
  offRepoStrict: boolean;
}

/** Builds the ~350-token header block shared by every window of a session (design §3). `allTurns` should be the FULL session's turns (not just the uncovered tail) — usage/files/tools are whole-session facts. */
export function renderSessionHeader(session: CodeSessionRow, allTurns: TurnRow[]): SessionHeader {
  const usage = session.props?.usage as RawUsage | undefined;
  const models = Array.isArray(session.props?.models) ? (session.props?.models as string[]) : undefined;
  const hints = detectOutcomeHints(allTurns);

  const lines: string[] = [
    `Repo: ${session.project_display_name ?? session.code_project_id} branch=${session.git_branch ?? "(unknown)"}`,
    `Start: ${session.started_at ?? "?"} End: ${session.ended_at ?? "?"}${session.duration_seconds != null ? ` (${session.duration_seconds}s)` : ""}`,
    `Models: ${models && models.length > 0 ? models.join(", ") : (session.model ?? "(unknown)")}`,
    formatUsageLine(usage, session.model),
    `Files touched (${session.files_touched.length}): ${session.files_touched.slice(0, 30).join(", ") || "(none)"}`,
    `Top tools: ${
      topToolCounts(allTurns)
        .map(([name, n]) => `${name}(${n})`)
        .join(", ") || "(none)"
    }`,
    ...renderSubAgentTree(session.props),
    ...renderDeliveredBlock(hints),
  ];
  return {
    text: lines.join("\n"),
    outcomeHints: hints,
    offRepoStrict: isOffRepoStrict(session.files_touched, allTurns),
  };
}
