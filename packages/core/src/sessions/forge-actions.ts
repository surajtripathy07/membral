// Structured forge actions (goal 2026-09-26 W3 / P1, D-051).
//
// Every verb Membral shows about a session comes from a tool call or its
// result, never from the model's narration. This module is the pattern table
// that turns one tool_use (a `git`/`gh`/`glab` Bash command, a forge MCP call,
// a `<command-name>` slash line, a pasted forge URL) into a fixed-shape
// `ForgeAction`. It is pure: no fs, no network, no throwing — a malformed
// command or result degrades to "no action" (B12).
//
// Privacy (B10): the action carries only fixed-shape fields (verb, ref, sha,
// url, state, branch, subject, skill, source), each passed through
// `redactSecrets` and length-capped; the commit subject also loses email
// addresses and phone numbers. The tool result text itself is never stored —
// the parsers still elide it to `[tool_result elided: ok|error]`. The stored
// command digest keeps the verb and ref but replaces message/body/title/
// description values and heredoc bodies with `‹text›`.
//
// Behaviour contract (docs/goals/2026-09-26_open-threads-from-observed-actions_goal.md):
//   B13  the slash line names the ref, never the verb (skill is a label only)
//   B14  every rung is a rule over tool calls; the git table below is exhaustive
//        (delivery / closure / rewrite / checkout / navigation) so nothing git
//        does is "unknown"
//   W3   mechanics: chained commands are split and every segment matched;
//        tool names match case-insensitively. The result text only ENRICHES an
//        action the command itself produced (sha/branch for a commit or push
//        segment, URL for a create, state for a view) or disproves it; it
//        never mints an action of its own.

import { bashActions, finish } from "./forge-actions/assemble.js";
import type { Partial } from "./forge-actions/git.js";
import { mcpAction } from "./forge-actions/mcp.js";
import { primaryAction } from "./forge-actions/ranking.js";
import { findForgeUrl, qualifyNumber, stripHost } from "./forge-actions/refs.js";
import { BARE_ITEM_REF } from "./forge-actions/segment-repo.js";
import type { ForgeAction, ForgeRefKind, ToolActionInput } from "./forge-actions/types.js";
import { redactSecrets } from "./redact.js";

export { createCommitShaBackfill } from "./forge-actions/commit-sha-backfill.js";
export {
  digestBashCommand,
  MAX_DIGEST_CHARS,
  MAX_FORGE_DIGEST_CHARS,
  TEXT_PLACEHOLDER,
} from "./forge-actions/digest.js";
export { primaryAction } from "./forge-actions/ranking.js";
export { findForgeUrl, parseForgeUrl } from "./forge-actions/refs.js";
export { splitShellChain } from "./forge-actions/shell.js";
export type {
  ForgeAction,
  ForgeActionSource,
  ForgeRefKind,
  ForgeVerb,
  ToolActionInput,
} from "./forge-actions/types.js";
export {
  FORGE_ACTION_SOURCES,
  FORGE_COMMAND,
  FORGE_REF_KINDS,
  FORGE_VERBS,
  TEST_COMMAND,
} from "./forge-actions/types.js";

/**
 * Stamped on every parsed session as `RawCodeSession.actionsVersion`: the
 * parser that produced it runs this module, so a session carrying the stamp
 * and no `action` on any turn observably did nothing on a forge — as opposed
 * to a pre-W3 CLI's session, which carries no stamp and no actions because
 * nothing looked. Bump when the action schema changes shape.
 *
 * 2 (D-051 F1): an action's repo is resolved per action from the directory it
 * ran in; `repoUnknown` actions are never uploaded. A v1 session may carry a
 * bare ref for a command that ran in another repo — re-import to correct it.
 */
// COST: bumping this makes every stored session re-upload and re-import
// (#171: /known treats an older stored actions_version as not known, and the
// import bypasses its content_hash skip). The re-import is free; the queued
// memory extraction resumes from its checkpoint, so memories are not rebuilt.
// Re-extracting with the new parser is an ops step (scripts/memory/backfill.ts
// --force, ~$0.009/session). #324 tracks gating that on the extractor's input.
export const FORGE_ACTIONS_VERSION = 2;

/** What the importer found at an action's `dir`, relative to the session's project. */
export type ActionDirVerdict =
  /** The directory is in the session's own project repo. */
  | { kind: "project" }
  /** The directory is in another repo, named `owner/repo`. */
  | { kind: "repo"; repo: string }
  /** Missing, not a repo, or a repo with no name to show (no remote). */
  | { kind: "unknown" };

/**
 * Settle an action's local `dir` (D-051 F1) with the importer's verdict for
 * that directory, and drop the local-only fields. The session's project keeps
 * a bare ref; another repo's item is qualified to it (`owner/repo#N`, shown
 * under that repo, as `-R` would), its branch dropped so it never maps a
 * same-named branch of the project; anything else is `repoUnknown`, unless the
 * command's own result URL named the item's repo. An action with no `dir` is
 * returned unchanged but for `shownRepo`.
 */
export function settleActionDir(action: ForgeAction, verdict: ActionDirVerdict): ForgeAction {
  const { dir, shownRepo, ...rest } = action;
  if (dir === undefined) return rest;
  if (verdict.kind === "project") return rest;
  const item = rest.refKind === "issue" || rest.refKind === "merge_request";
  const bare = item && rest.ref ? BARE_ITEM_REF.exec(rest.ref) : null;
  // v3 item 6: the item's own result URL (step 2) outranks the directory remote's host (step 3)
  // when both name the same owner/repo.
  const repo =
    verdict.kind === "repo"
      ? shownRepo && stripHost(shownRepo) === stripHost(verdict.repo)
        ? shownRepo
        : verdict.repo
      : shownRepo;
  if (bare && repo) {
    const out: ForgeAction = { ...rest, ref: qualifyNumber(rest.refKind as ForgeRefKind, bare[2], repo) };
    delete out.branch;
    return out;
  }
  return { ...rest, repoUnknown: true };
}

// --- public entry points ----------------------------------------------------

/**
 * Every action one tool call observably performed, in command order. Empty
 * for tools that contribute nothing (`Skill`, `Read`, `Edit`, `Agent`, …) and
 * for anything unrecognised or malformed — never throws (B12).
 */
export function deriveToolActions(call: ToolActionInput): ForgeAction[] {
  try {
    const name = call.toolName.toLowerCase();
    const input = call.input && typeof call.input === "object" ? call.input : {};
    const result = typeof call.result === "string" ? call.result : undefined;
    const isError = call.isError === true;

    if (name === "bash") {
      const command = typeof input.command === "string" ? input.command.trim() : "";
      if (!command) return [];
      return bashActions(command, result, isError, input.run_in_background === true, call.cwd);
    }

    const mcpTool = call.mcpTool ?? (name.startsWith("mcp__") ? name.split("__").slice(2).join("__") : undefined);
    if (mcpTool) return mcpAction(mcpTool, input, result, isError);

    return [];
  } catch {
    return [];
  }
}

/** Concatenate a Claude Code tool_result block's `content` (string or text blocks) into one string. */
export function toolResultText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string") {
        parts.push((c as { text: string }).text);
      }
    }
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
}

const COMMAND_NAME = /<command-name>\s*([^<]*?)\s*<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;
const BARE_REF_IN_TEXT = /(?:^|[\s(,])([#!])(\d+)\b/;

/**
 * B13 — a `<command-name>/x</command-name>…<command-args>…</command-args>`
 * user message. Returns the prose text to store (the developer's own words)
 * and the action naming the ref, or null when the args name no ref (then the
 * message is skipped as before). The skill name is a label only.
 */
export function parseSlashCommandMessage(text: string): { text: string; action: ForgeAction } | null {
  try {
    const name = COMMAND_NAME.exec(text);
    if (!name) return null;
    const skill = name[1].replace(/^\//, "").trim();
    const args = (COMMAND_ARGS.exec(text)?.[1] ?? "").trim();
    if (!args) return null;

    let p: (Partial & { skill?: string }) | null = null;
    const url = findForgeUrl(args);
    if (url?.ref) p = { verb: "referenced", ref: url.ref, refKind: url.refKind, url: url.url };
    else {
      const bare = BARE_REF_IN_TEXT.exec(args);
      if (bare) {
        const kind: ForgeRefKind = bare[1] === "!" ? "merge_request" : "issue";
        p = { verb: "referenced", ref: qualifyNumber(kind, bare[2]), refKind: kind };
      }
    }
    if (!p) return null;
    p.skill = skill || undefined;
    return { text: redactSecrets(skill ? `/${skill} ${args}` : args), action: finish(p, "command") };
  } catch {
    return null;
  }
}

/** A forge item URL pasted in user prose → a `referenced` action (source `paste`), else undefined. */
export function actionFromPastedText(text: string): ForgeAction | undefined {
  try {
    const url = findForgeUrl(text);
    if (!url) return undefined;
    return finish(
      { verb: "referenced", ref: url.ref, refKind: url.refKind, url: url.url, sha: url.sha } as Partial & {
        sha?: string;
      },
      "paste",
    );
  } catch {
    return undefined;
  }
}

/** Attach `action`/`actions` to a turn-shaped object: `action` is the primary, `actions` only when there are several. */
export function assignActions<T extends { action?: ForgeAction; actions?: ForgeAction[] }>(
  turn: T,
  actions: ForgeAction[],
): void {
  if (actions.length === 0) {
    delete turn.action;
    delete turn.actions;
    return;
  }
  turn.action = primaryAction(actions);
  if (actions.length > 1) turn.actions = actions;
  else delete turn.actions;
}
