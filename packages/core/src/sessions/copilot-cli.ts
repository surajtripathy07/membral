// GitHub Copilot CLI session parser (goal 2026-10-01 W6, D4).
//
// Copilot CLI keeps one directory per session under
// `${COPILOT_HOME:-~/.copilot}/session-state/<session-uuid>/`, and the
// append-only `events.jsonl` in it is the source of truth. GitHub has not
// published a schema for it; the shapes below were reverse-engineered by
// third parties and checked against real captures at copilotVersion
// 1.0.67-1.0.68. Treat every field as optional (ADR 0026 D13): a missing or
// malformed field degrades to undefined, an unknown event type is skipped,
// and nothing here throws on bad input.
//
// Each line is an envelope `{type, id, parentId, timestamp, data}`. The types
// this parser reads:
//   - session.start: data.sessionId, data.context{cwd, branch, ...}. No model.
//   - session.model_change: data.newModel (often the literal "auto") — only a
//     fallback for the session model when no assistant.message names one.
//   - user.message: data.content is the prompt as typed. data.transformedContent
//     adds injected datetime/system reminders and is ignored.
//   - assistant.message: data.model (the real model), data.content,
//     data.reasoningText, data.toolRequests[]. The toolRequests entries mirror
//     the tool.execution_start that follows, so tool turns come from the
//     execution events only (counting both would double every call); a
//     request's arguments fill in when its execution_start carries none.
//   - tool.execution_start / tool.execution_complete: paired on toolCallId.
//     The complete event carries success + result.content (parsed for forge
//     facts, then elided like Claude Code's tool_result) and, for `edit`,
//     result.detailedContent (a unified diff, counted for editHunks).
//   - subagent.started / subagent.completed: thin markers keyed on the `task`
//     tool's toolCallId. The sub-agent's own turns are not in this file, so
//     they become `subAgents[]` metadata only, never child sessions.
//   - session.auto_mode_resolved: data.chosenModel — the model "auto" picked
//     (seen at 1.0.91). Fallback when no assistant.message names a real model.
//   - session.shutdown: modelMetrics{<model>: {usage}} is the only token
//     source. It is absent when the process was killed, and then `usage` is
//     left undefined rather than guessed from per-message outputTokens alone.
//     data.currentModel is the next model fallback after chosenModel.
// Model precedence: last non-"auto" assistant.message model, then
// auto_mode_resolved.chosenModel, then shutdown.currentModel, then a
// non-"auto" session.model_change.newModel.
// system.message, assistant.turn_start/turn_end, session.task_complete,
// hook.start/hook.end, session.usage_checkpoint and anything else are ignored.

import { createHash } from "node:crypto";
import { SessionRootUnreadableError } from "./claude-code.js";
import {
  actionFromPastedText,
  assignActions,
  createCommitShaBackfill,
  deriveToolActions,
  FORGE_ACTIONS_VERSION,
  FORGE_COMMAND,
  MAX_DIGEST_CHARS,
} from "./forge-actions.js";
import { buildInputDigest, type InputDigestConfig } from "./input-digest.js";
import { redactSecrets } from "./redact.js";
import type { CodeSessionParser, RawCodeSession, RawSubAgent, RawTurn, RawUsage, SessionRef } from "./types.js";

export const COPILOT_CLI_SOURCE = "copilot-cli";

/** The per-session transcript file name inside `<root>/session-state/<id>/`. */
export const COPILOT_EVENTS_FILE = "events.jsonl";

interface CopilotEvent {
  type?: unknown;
  timestamp?: unknown;
  agentId?: unknown;
  data?: Record<string, unknown>;
}

interface ToolCallState {
  turn: RawTurn;
  toolName: string;
  input: Record<string, unknown> | undefined;
}

// Copilot's native shell tool is `bash` (`powershell` on Windows). The
// forge-action parser only reads a tool named `bash`, so shell calls are
// handed to it under that name; the turn keeps the real tool name.
const SHELL_TOOLS = new Set(["bash", "powershell", "shell"]);
// Native file tools: `view` reads, `edit` changes, `create` writes a new file.
const FILE_PATH_TOOLS = new Set(["view", "edit", "create"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseLines(text: string): CopilotEvent[] {
  const events: CopilotEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      const o = obj(parsed);
      if (o) events.push(o as CopilotEvent);
    } catch {
      // A truncated last line (killed process) or a corrupt line — skip it.
    }
  }
  return events;
}

/** copilot-cli tool names → digest kind. No webfetch digest; empty descriptions fall through to the prompt. */
export const INPUT_DIGEST_CONFIG: InputDigestConfig = {
  kinds: { bash: "bash", powershell: "bash", shell: "bash", task: "agent" },
  agentSkipEmpty: true,
};

function countDiffHunks(diff: unknown): number | undefined {
  if (typeof diff !== "string" || !diff) return undefined;
  const matches = diff.match(/^@@ /gm);
  return matches ? matches.length : undefined;
}

/** Session usage from `session.shutdown.data.modelMetrics`, summed across models; reasoning tokens fold into output (as opencode.ts does). */
function usageFromShutdown(data: Record<string, unknown>): { usage?: RawUsage; models: string[] } {
  const metrics = obj(data.modelMetrics);
  if (!metrics) return { models: [] };
  const total: RawUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  let any = false;
  const models: string[] = [];
  for (const [modelName, entry] of Object.entries(metrics)) {
    if (modelName) models.push(modelName);
    const usage = obj(obj(entry)?.usage);
    if (!usage) continue;
    any = true;
    total.inputTokens += num(usage.inputTokens);
    total.outputTokens += num(usage.outputTokens) + num(usage.reasoningTokens);
    total.cacheReadInputTokens += num(usage.cacheReadTokens);
    total.cacheCreationInputTokens += num(usage.cacheWriteTokens);
  }
  return { usage: any ? total : undefined, models };
}

export const copilotCliParser: CodeSessionParser = {
  source: COPILOT_CLI_SOURCE,

  /**
   * Walks `<root>/session-state/<id>/events.jsonl`. `root` is the Copilot home
   * (`$COPILOT_HOME` or `~/.copilot`). An unreadable root throws, like
   * claude-code's; a root with no `session-state/` yet (Copilot installed,
   * never used) is an empty result, and an unreadable session directory is
   * skipped with a warning.
   */
  async detect(root: string, onWarn?: (message: string) => void): Promise<SessionRef[]> {
    const { readdir, stat } = await import("node:fs/promises");
    const path = await import("node:path");

    try {
      await readdir(root);
    } catch (err) {
      throw new SessionRootUnreadableError(root, err);
    }

    const stateDir = path.join(root, "session-state");
    let sessionDirs: string[];
    try {
      sessionDirs = (await readdir(stateDir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return [];
      onWarn?.(`skipping unreadable session directory "${stateDir}": ${errMessage(err)}`);
      return [];
    }

    const refs: SessionRef[] = [];
    for (const dir of sessionDirs) {
      const eventsPath = path.join(stateDir, dir, COPILOT_EVENTS_FILE);
      try {
        if (!(await stat(eventsPath)).isFile()) continue;
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          onWarn?.(`skipping unreadable session "${eventsPath}": ${errMessage(err)}`);
        }
        continue;
      }
      refs.push({ source: COPILOT_CLI_SOURCE, sourceSessionId: dir, path: eventsPath });
    }
    return refs;
  },

  parse(ref: SessionRef, raw: string | Buffer): RawCodeSession {
    const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const events = parseLines(bytes.toString("utf8"));

    let sessionId: string | undefined;
    let cwd: string | undefined;
    let branch: string | undefined;
    let model: string | undefined;
    let fallbackModel: string | undefined;
    let autoResolvedModel: string | undefined;
    let shutdownModel: string | undefined;
    let usage: RawUsage | undefined;
    const modelsSeen = new Set<string>();
    const turns: RawTurn[] = [];
    const timestamps: string[] = [];
    const filesTouched = new Set<string>();
    const toolCounts: Record<string, number> = {};
    const requestArgs = new Map<string, Record<string, unknown>>();
    const toolCalls = new Map<string, ToolCallState>();
    const subAgents = new Map<string, RawSubAgent>();
    // F2 — a quiet commit's sha from a later `git rev-parse HEAD` / `git log`.
    const shaBackfill = createCommitShaBackfill();

    for (const event of events) {
      const type = str(event.type);
      const data = obj(event.data) ?? {};
      const ts = str(event.timestamp) ?? "";
      if (ts) timestamps.push(ts);

      switch (type) {
        case "session.start": {
          sessionId = sessionId ?? str(data.sessionId);
          const context = obj(data.context);
          cwd = cwd ?? str(context?.cwd);
          branch = branch ?? str(context?.branch);
          break;
        }

        case "session.model_change": {
          const m = str(data.newModel);
          if (m && m !== "auto") fallbackModel = m;
          break;
        }

        case "user.message": {
          const content = str(data.content);
          if (!content?.trim()) break;
          const turn: RawTurn = { idx: turns.length, role: "user", kind: "prose", text: redactSecrets(content), ts };
          // W3 — a pasted forge URL names a ref (source `paste`).
          const pasted = actionFromPastedText(content);
          if (pasted) turn.action = pasted;
          turns.push(turn);
          break;
        }

        case "assistant.message": {
          const m = str(data.model);
          if (m && m !== "auto") {
            // Last assistant model wins, as claude-code.ts and opencode.ts do.
            model = m;
            modelsSeen.add(m);
          }
          const reasoning = str(data.reasoningText);
          if (reasoning?.trim()) {
            turns.push({ idx: turns.length, role: "assistant", kind: "thinking", text: redactSecrets(reasoning), ts });
          }
          const content = str(data.content);
          if (content?.trim()) {
            turns.push({ idx: turns.length, role: "assistant", kind: "prose", text: redactSecrets(content), ts });
          }
          if (Array.isArray(data.toolRequests)) {
            for (const req of data.toolRequests) {
              const r = obj(req);
              const id = str(r?.toolCallId);
              const args = obj(r?.arguments);
              if (id && args) requestArgs.set(id, args);
            }
          }
          break;
        }

        case "tool.execution_start": {
          const toolName = str(data.toolName) ?? "unknown";
          const toolCallId = str(data.toolCallId);
          const input = obj(data.arguments) ?? (toolCallId ? requestArgs.get(toolCallId) : undefined);
          toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;

          let filePath: string | undefined;
          if (FILE_PATH_TOOLS.has(toolName)) {
            const p = str(input?.path);
            if (p) {
              filePath = p;
              filesTouched.add(p);
            }
          }

          const turn: RawTurn = {
            idx: turns.length,
            role: "assistant",
            kind: "tool_use",
            toolName,
            filePath,
            ts,
            toolUseId: toolCallId,
            resultType: toolName === "create" ? "create" : toolName === "edit" ? "update" : undefined,
            inputDigest: buildInputDigest(INPUT_DIGEST_CONFIG, toolName, input),
          };
          // W3 — actions from the command alone; the completion re-derives them with the result.
          assignActions(turn, deriveToolActions(actionCall(toolName, input, cwd)));
          turns.push(turn);
          if (toolCallId) toolCalls.set(toolCallId, { turn, toolName, input });
          break;
        }

        case "tool.execution_complete": {
          const toolCallId = str(data.toolCallId);
          const call = toolCallId ? toolCalls.get(toolCallId) : undefined;
          const isError = data.success === false;
          const result = obj(data.result);
          if (call) {
            const observed = {
              ...actionCall(call.toolName, call.input, cwd),
              result: str(result?.content) ?? "",
              isError,
            };
            const actions = deriveToolActions(observed);
            assignActions(call.turn, actions);
            shaBackfill.observe(observed, actions);
            // R-5/R-3 (see claude-code.ts): an errored git/gh/glab call with no
            // derived action did nothing; drop its now-misleading digest.
            if (
              actions.length === 0 &&
              isError &&
              call.turn.inputDigest !== undefined &&
              SHELL_TOOLS.has(call.toolName) &&
              typeof call.input?.command === "string" &&
              FORGE_COMMAND.test(call.input.command)
            ) {
              delete call.turn.inputDigest;
            }
            if (call.toolName === "edit") {
              const hunks = countDiffHunks(result?.detailedContent);
              if (hunks !== undefined) call.turn.editHunks = hunks;
            }
          }
          turns.push({
            idx: turns.length,
            role: "user",
            kind: "tool_result",
            toolName: call?.toolName ?? str(data.toolName),
            text: `[tool_result elided: ${isError ? "error" : "ok"}]`,
            ts,
          });
          break;
        }

        case "subagent.started":
        case "subagent.completed": {
          const toolCallId = str(data.toolCallId) ?? str(event.agentId);
          if (!toolCallId) break;
          const existing = subAgents.get(toolCallId) ?? {
            toolUseId: toolCallId,
            agentId: str(event.agentId) ?? toolCallId,
            spawnDepth: 1,
          };
          existing.agentType = existing.agentType ?? str(data.agentName);
          const desc = str(data.agentDescription);
          if (desc && !existing.description) existing.description = redactSecrets(desc).slice(0, MAX_DIGEST_CHARS);
          existing.model = existing.model ?? str(data.model);
          subAgents.set(toolCallId, existing);
          break;
        }

        case "session.auto_mode_resolved": {
          const m = str(data.chosenModel);
          if (m && m !== "auto") autoResolvedModel = m;
          break;
        }

        case "session.shutdown": {
          const current = str(data.currentModel);
          if (current && current !== "auto") shutdownModel = current;
          const fromShutdown = usageFromShutdown(data);
          if (fromShutdown.usage) usage = fromShutdown.usage;
          for (const m of fromShutdown.models) modelsSeen.add(m);
          break;
        }

        default:
          // system.message, assistant.turn_*, session.task_complete and any
          // event type this parser does not know — ignored defensively.
          break;
      }
    }

    if (!model) {
      const fallback = autoResolvedModel ?? shutdownModel ?? fallbackModel;
      if (fallback) {
        model = fallback;
        modelsSeen.add(fallback);
      }
    }

    const startedAt = timestamps.length > 0 ? timestamps.reduce((a, b) => (a < b ? a : b)) : "";
    const endedAt = timestamps.length > 0 ? timestamps.reduce((a, b) => (a > b ? a : b)) : "";

    return {
      source: COPILOT_CLI_SOURCE,
      sourceSessionId: sessionId ?? ref.sourceSessionId,
      contentHash,
      repo: { path: cwd, branch },
      startedAt,
      endedAt,
      model,
      turns,
      filesTouched: [...filesTouched],
      toolCounts,
      usage,
      models: modelsSeen.size > 0 ? [...modelsSeen] : undefined,
      subAgents: subAgents.size > 0 ? [...subAgents.values()] : undefined,
      actionsVersion: FORGE_ACTIONS_VERSION,
    };
  },
};

/** The forge-action input for one tool call: shell tools go in as `bash`, the only shell name forge-actions reads. */
function actionCall(toolName: string, input: Record<string, unknown> | undefined, cwd: string | undefined) {
  return { toolName: SHELL_TOOLS.has(toolName) ? "bash" : toolName, input, cwd };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
