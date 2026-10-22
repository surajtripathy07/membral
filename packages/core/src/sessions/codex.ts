// OpenAI Codex CLI session parser (goal 2026-10-02 W9, D3, issue #396).
//
// Codex writes one append-only "rollout" per thread at
// `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-<ts>-<thread_id>[_<rollout_id>].jsonl`.
// There is no published schema and no schema version; `session_meta.cli_version`
// is the only marker. Shapes below were read from openai/codex source and
// checked against real 0.120.0 captures. Codex keeps old files readable by
// field presence, so this parser keys on presence too: every field is
// optional (ADR 0026 D13), an unknown line or item type is skipped, a
// malformed line is skipped, and nothing here throws on bad input.
//
// Each line is an envelope `{timestamp, type, payload}` (newer CLIs add
// `ordinal` and `metadata`, ignored). The types this parser reads:
//   - session_meta (first one wins; a resume/fork can append more):
//     payload.id (thread id), payload.session_id (root thread id, newer CLIs),
//     payload.parent_thread_id, cwd, git{branch, repository_url}, cli_version.
//     No model here.
//   - turn_context: payload.model, once per user turn. The last one names the
//     session model (last wins, as claude-code.ts and copilot-cli.ts do); every
//     distinct model goes into `models`.
//   - response_item: the model-visible items, and the ONLY source of turns.
//     event_msg user_message / agent_message / agent_reasoning / *_end events
//     duplicate these one-for-one, so they are never turned into turns
//     (counting both would double every prompt, reply and tool result).
//       message: role user|assistant|developer, content[{type, text}].
//         developer messages are harness instructions — always skipped.
//         Some user-role messages are harness-injected context, not the
//         owner's words — see INJECTED_USER_PREFIXES.
//       reasoning: in practice encrypted_content only (summary empty), so no
//         turn. A readable summary, when enabled, becomes a thinking turn.
//       function_call / custom_tool_call / local_shell_call: tool_use turns,
//         paired with function_call_output / custom_tool_call_output by call_id.
//       web_search_call: a tool_use turn with no paired output.
//   - event_msg token_count: info.total_token_usage is CUMULATIVE for the
//     thread (and repeats), so the last non-null one is the session total —
//     never summed. token_usage_record.thread_token_usage (newer CLIs) wins
//     when present.
//   - event_msg mcp_tool_call_end: invocation{server, tool} back-fills the MCP
//     server name for a call whose function name did not carry it.
// compacted, task_*, turn_aborted and any other line type are ignored.

import { createHash } from "node:crypto";
import { SessionRootUnreadableError } from "./claude-code.js";
import {
  actionFromPastedText,
  assignActions,
  createCommitShaBackfill,
  deriveToolActions,
  digestBashCommand,
  FORGE_ACTIONS_VERSION,
  FORGE_COMMAND,
  toolResultText,
} from "./forge-actions.js";
import { redactSecrets } from "./redact.js";
import type { CodeSessionParser, RawCodeSession, RawTurn, RawUsage, SessionRef } from "./types.js";

export const CODEX_SOURCE = "codex";

/** Rollouts live under `<codex home>/sessions/`, nested YYYY/MM/DD. */
export const CODEX_SESSIONS_DIR = "sessions";

// Deeper than YYYY/MM/DD so a future extra level still walks, bounded so a
// pathological tree cannot hang the import.
const DETECT_MAX_DEPTH = 6;

// Codex injects these as role=user messages at session start or mid-turn
// (codex-rs core/src/context/contextual_user_message.rs, event_mapping.rs).
// They are context the harness wrote, not the owner's prompt, so they never
// become prose turns. A structural prefix check on the known wrappers is
// deliberate here: these are fixed tags Codex itself emits around injected
// blocks, not language heuristics over what a user typed.
const INJECTED_USER_PREFIXES = [
  "<environment_context>",
  "# AGENTS.md instructions",
  "<user_instructions>",
  "<user_shell_command>",
  "<turn_aborted>",
  "<subagent_notification>",
  "<codex_internal_context",
  "<goal_context>",
];

// Codex's shell tools across versions: `exec_command` (0.120, args.cmd),
// `shell` (older, args.command argv), `shell_command` (args.command string).
// forge-actions only reads a tool named `bash`, so they are handed over under
// that name; the turn keeps the real tool name.
const SHELL_TOOLS = new Set(["exec_command", "shell", "shell_command", "local_shell", "container.exec"]);
const PATCH_TOOL = "apply_patch";

interface RolloutLine {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

interface ToolCallState {
  turn: RawTurn;
  toolName: string;
  /** Input as forge-actions reads it (`command` for shell tools). */
  input: Record<string, unknown> | undefined;
  cwd: string | undefined;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseLines(text: string): RolloutLine[] {
  const lines: RolloutLine[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const o = obj(JSON.parse(trimmed));
      if (o) lines.push(o as RolloutLine);
    } catch {
      // A truncated last line (killed process) or a corrupt line — skip it.
    }
  }
  return lines;
}

/** The text of a message's `input_text`/`output_text` blocks, joined. */
function messageText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    const text = str(obj(block)?.text);
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function isInjectedUserMessage(content: unknown): boolean {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.some((block) => {
    const text = typeof block === "string" ? block : str(obj(block)?.text);
    const head = text?.trimStart();
    return head !== undefined && INJECTED_USER_PREFIXES.some((prefix) => head.startsWith(prefix));
  });
}

/** A shell command as one string: argv `["bash","-lc","<script>"]` yields the script, other argv are space-joined. */
function shellCommand(v: unknown): string | undefined {
  if (typeof v === "string") return v.trim() || undefined;
  if (!Array.isArray(v) || !v.every((a) => typeof a === "string")) return undefined;
  const argv = v as string[];
  if (argv.length >= 3 && (argv[1] === "-lc" || argv[1] === "-c")) return argv[argv.length - 1].trim() || undefined;
  return argv.join(" ").trim() || undefined;
}

/** Function-call arguments arrive as a JSON string; a malformed one is treated as no input. */
function parseArguments(v: unknown): Record<string, unknown> | undefined {
  if (typeof v !== "string") return obj(v);
  try {
    return obj(JSON.parse(v));
  } catch {
    return undefined;
  }
}

/** Files an apply_patch envelope names, from its `*** Add/Update/Delete File:` and `*** Move to:` headers. */
function patchFiles(patch: string): { files: string[]; onlyAdds: boolean; hunks: number } {
  const files: string[] = [];
  let onlyAdds = true;
  let hunks = 0;
  for (const line of patch.split("\n")) {
    const header = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trimEnd());
    if (header) {
      if (header[1] !== "Add File") onlyAdds = false;
      const file = header[2].trim();
      if (file && !files.includes(file)) files.push(file);
    } else if (line.startsWith("@@")) {
      hunks++;
    }
  }
  return { files, onlyAdds: onlyAdds && files.length > 0, hunks };
}

/** `mcp__<server>__<tool>`, or a namespace of that shape plus a bare tool name. */
function mcpParts(name: string, namespace: string | undefined): { mcpServer?: string; mcpTool?: string } {
  const qualified = /^mcp__(.+?)__(.+)$/.exec(name);
  if (qualified) return { mcpServer: qualified[1], mcpTool: qualified[2] };
  const ns = namespace ? /^mcp__(.+?)(?:__)?$/.exec(namespace) : null;
  if (ns) return { mcpServer: ns[1], mcpTool: name };
  return {};
}

/** A shell call's output: `Process exited with code N` + `Output:` (0.120 exec_command), or a JSON `{output, metadata.exit_code}`. */
function readToolOutput(output: unknown): { text: string; isError: boolean } {
  const raw = typeof output === "string" ? output : (toolResultText(output) ?? "");
  let text = raw;
  let exitCode: number | undefined;
  try {
    const parsed = obj(JSON.parse(raw));
    if (parsed && ("output" in parsed || "metadata" in parsed)) {
      text = typeof parsed.output === "string" ? parsed.output : "";
      const code = obj(parsed.metadata)?.exit_code;
      if (typeof code === "number") exitCode = code;
    }
  } catch {
    // Plain text output.
  }
  const exited = /Process exited with code (-?\d+)/.exec(text);
  if (exitCode === undefined && exited) exitCode = Number(exited[1]);
  const body = text.indexOf("\nOutput:\n");
  if (body !== -1) text = text.slice(body + "\nOutput:\n".length);
  return { text, isError: exitCode !== undefined && exitCode !== 0 };
}

/**
 * Codex token usage (OpenAI semantics) as Membral's four buckets:
 * `input_tokens` includes the cached part and `output_tokens` includes
 * reasoning (checked: input + output = total_tokens), so cached input is
 * split out of input and reasoning is not added again.
 */
function usageFrom(v: unknown): RawUsage | undefined {
  const u = obj(v);
  if (!u) return undefined;
  const cached = num(u.cached_input_tokens);
  return {
    inputTokens: Math.max(0, num(u.input_tokens) - cached),
    outputTokens: num(u.output_tokens),
    cacheReadInputTokens: cached,
    cacheCreationInputTokens: num(u.cache_write_input_tokens),
  };
}

const ROLLOUT_NAME = /^rollout-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2})-([^_]+?)(?:_([^_]+))?\.jsonl$/;

/** The thread id in a rollout file name (`rollout-<ts>-<thread_id>[_<rollout_id>].jsonl`), else the bare name. */
export function codexThreadIdFromFileName(fileName: string): string {
  const m = ROLLOUT_NAME.exec(fileName);
  return m ? m[2] : fileName.replace(/\.jsonl$/, "");
}

/**
 * Sort key for "newest rollout of a thread", as Codex picks it
 * (rollout/src/list.rs `find_thread_path_by_id_from_filenames`): the
 * file-name timestamp, then the rollout id (a UUIDv7; without a
 * `_<rollout_id>` suffix it equals the thread id). Not mtime.
 */
function rolloutOrderKey(fileName: string): string {
  const m = ROLLOUT_NAME.exec(fileName);
  return m ? `${m[1]} ${(m[3] ?? m[2]).toLowerCase()}` : "";
}

/**
 * `thread/revert` keeps the thread id and writes a new immutable
 * `rollout-<ts>-<thread>_<rollout>.jsonl` (rollout/src/recorder.rs). Every
 * file of one thread parses to the same sourceSessionId, so keep only the
 * newest one; otherwise uploads alternate between them.
 */
export function newestRolloutPerThread(refs: SessionRef[]): SessionRef[] {
  const best = new Map<string, { ref: SessionRef; key: string }>();
  for (const ref of refs) {
    const key = rolloutOrderKey(ref.path.split(/[\\/]/).pop() ?? "");
    const cur = best.get(ref.sourceSessionId);
    if (!cur || key > cur.key) best.set(ref.sourceSessionId, { ref, key });
  }
  const keep = new Set([...best.values()].map((b) => b.ref));
  return refs.filter((r) => keep.has(r));
}

/** A git remote without credentials: `https://user:pass@host/x` becomes `https://host/x`; scp-style `git@host:x` is kept. */
export function stripRemoteCredentials(remote: string): string {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(remote)) return remote;
  try {
    const url = new URL(remote);
    if (!url.username && !url.password) return remote;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    // Unparseable: drop everything up to the LAST "@" before the path.
    return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/]*@/i, "$1");
  }
}

export const codexParser: CodeSessionParser = {
  source: CODEX_SOURCE,

  /**
   * Walks `<root>/sessions/**\/rollout-*.jsonl`. `root` is the Codex home
   * (`$CODEX_HOME` or `~/.codex`). An unreadable root throws, like
   * claude-code's; a root with no `sessions/` yet is an empty result; an
   * unreadable subdirectory is skipped with a warning. zstd-compressed
   * rollouts (`.jsonl.zst`, written only behind Codex's off-by-default
   * `local_thread_store_compression` flag) are not read yet: skipped, with
   * one warning naming the count.
   */
  async detect(root: string, onWarn?: (message: string) => void): Promise<SessionRef[]> {
    const { readdir } = await import("node:fs/promises");
    const path = await import("node:path");

    try {
      await readdir(root);
    } catch (err) {
      throw new SessionRootUnreadableError(root, err);
    }

    const refs: SessionRef[] = [];
    let compressed = 0;
    const walk = async (dir: string, remaining: number): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
          onWarn?.(`skipping unreadable session directory "${dir}": ${errMessage(err)}`);
        }
        return;
      }
      entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (remaining > 0) await walk(full, remaining - 1);
        } else if (entry.isFile() && entry.name.startsWith("rollout-")) {
          if (entry.name.endsWith(".jsonl")) {
            refs.push({ source: CODEX_SOURCE, sourceSessionId: codexThreadIdFromFileName(entry.name), path: full });
          } else if (entry.name.endsWith(".jsonl.zst")) {
            compressed++;
          }
        }
      }
    };
    await walk(path.join(root, CODEX_SESSIONS_DIR), DETECT_MAX_DEPTH);
    if (compressed > 0) {
      onWarn?.(`skipping ${compressed} compressed Codex rollout(s) (.jsonl.zst) — not supported yet`);
    }
    return newestRolloutPerThread(refs);
  },

  parse(ref: SessionRef, raw: string | Buffer): RawCodeSession {
    const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
    const contentHash = createHash("sha256").update(bytes).digest("hex");
    const lines = parseLines(bytes.toString("utf8"));

    let metaSeen = false;
    let threadId: string | undefined;
    let parentThreadId: string | undefined;
    let cwd: string | undefined;
    let branch: string | undefined;
    let remoteUrl: string | undefined;
    let model: string | undefined;
    let tokenCountUsage: RawUsage | undefined;
    let recordUsage: RawUsage | undefined;
    const modelsSeen = new Set<string>();
    const turns: RawTurn[] = [];
    const timestamps: string[] = [];
    const filesTouched = new Set<string>();
    const toolCounts: Record<string, number> = {};
    const toolCalls = new Map<string, ToolCallState>();
    // F2 — a quiet commit's sha from a later `git rev-parse HEAD` / `git log`.
    const shaBackfill = createCommitShaBackfill();

    const pushToolUse = (
      toolName: string,
      ts: string,
      callId: string | undefined,
      input: Record<string, unknown> | undefined,
      callCwd: string | undefined,
      extra: Partial<RawTurn> = {},
    ): RawTurn => {
      toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
      const turn: RawTurn = {
        idx: turns.length,
        role: "assistant",
        kind: "tool_use",
        toolName,
        ts,
        toolUseId: callId,
        ...extra,
      };
      // W3 — actions from the command alone; the output re-derives them with the result.
      assignActions(turn, deriveToolActions(actionCall(toolName, input, callCwd, turn.mcpTool)));
      turns.push(turn);
      if (callId) toolCalls.set(callId, { turn, toolName, input, cwd: callCwd });
      return turn;
    };

    const pushShell = (name: string, args: Record<string, unknown> | undefined, ts: string, callId?: string) => {
      const command = shellCommand(args?.cmd ?? args?.command);
      const callCwd = str(args?.workdir) ?? str(args?.working_directory) ?? cwd;
      const input = command ? { command } : undefined;
      pushToolUse(name, ts, callId, input, callCwd, { inputDigest: digestBashCommand(command) });
    };

    const pushPatch = (patch: string | undefined, ts: string, callId: string | undefined) => {
      const { files, onlyAdds, hunks } = patchFiles(patch ?? "");
      for (const f of files) filesTouched.add(f);
      pushToolUse(PATCH_TOOL, ts, callId, undefined, cwd, {
        filePath: files[0],
        resultType: files.length === 0 ? undefined : onlyAdds ? "create" : "update",
        ...(hunks > 0 ? { editHunks: hunks } : {}),
      });
    };

    const pushOutput = (callId: string | undefined, output: unknown, ts: string) => {
      const call = callId ? toolCalls.get(callId) : undefined;
      const { text, isError } = readToolOutput(output);
      if (call) {
        const observed = {
          ...actionCall(call.toolName, call.input, call.cwd, call.turn.mcpTool),
          result: text,
          isError,
        };
        const actions = deriveToolActions(observed);
        assignActions(call.turn, actions);
        shaBackfill.observe(observed, actions);
        // R-5/R-3 (see claude-code.ts): an errored git/gh/glab call with no
        // derived action did nothing; drop its now-misleading digest.
        const command = call.input?.command;
        if (
          actions.length === 0 &&
          isError &&
          call.turn.inputDigest !== undefined &&
          SHELL_TOOLS.has(call.toolName) &&
          typeof command === "string" &&
          FORGE_COMMAND.test(command)
        ) {
          delete call.turn.inputDigest;
        }
      }
      turns.push({
        idx: turns.length,
        role: "user",
        kind: "tool_result",
        toolName: call?.toolName,
        text: `[tool_result elided: ${isError ? "error" : "ok"}]`,
        ts,
      });
    };

    for (const line of lines) {
      const type = str(line.type);
      const payload = obj(line.payload) ?? {};
      const ts = str(line.timestamp) ?? "";
      if (!type) continue; // pre-envelope lines (very old rollouts) carry no type
      if (ts) timestamps.push(ts);

      switch (type) {
        case "session_meta": {
          if (metaSeen) break;
          metaSeen = true;
          threadId = str(payload.id) ?? str(payload.session_id);
          const parent = str(payload.parent_thread_id);
          if (parent && parent !== threadId) parentThreadId = parent;
          cwd = str(payload.cwd);
          const git = obj(payload.git);
          branch = str(git?.branch);
          // A remote URL can embed credentials (`https://user:token@host/...`); keep host and path only.
          const repo = str(git?.repository_url);
          remoteUrl = repo === undefined ? undefined : stripRemoteCredentials(repo);
          break;
        }

        case "turn_context": {
          const m = str(payload.model);
          if (m) {
            model = m;
            modelsSeen.add(m);
          }
          break;
        }

        case "event_msg": {
          const kind = str(payload.type);
          if (kind === "token_count") {
            const usage = usageFrom(obj(payload.info)?.total_token_usage);
            if (usage) tokenCountUsage = usage;
          } else if (kind === "mcp_tool_call_end") {
            const call = toolCalls.get(str(payload.call_id) ?? "");
            const invocation = obj(payload.invocation);
            if (call && !call.turn.mcpServer && str(invocation?.server)) {
              call.turn.mcpServer = str(invocation?.server);
              call.turn.mcpTool = call.turn.mcpTool ?? str(invocation?.tool);
            }
          }
          // user_message / agent_message / *_end duplicate response_items — never turns.
          break;
        }

        case "token_usage_record": {
          const usage = usageFrom(payload.thread_token_usage);
          if (usage) recordUsage = usage;
          break;
        }

        case "response_item": {
          const item = str(payload.type);
          if (item === "message") {
            const role = str(payload.role);
            if (role !== "user" && role !== "assistant") break; // developer = harness instructions
            if (role === "user" && isInjectedUserMessage(payload.content)) break;
            const text = messageText(payload.content);
            if (!text?.trim()) break;
            const turn: RawTurn = { idx: turns.length, role, kind: "prose", text: redactSecrets(text), ts };
            if (role === "user") {
              // W3 — a pasted forge URL names a ref (source `paste`).
              const pasted = actionFromPastedText(text);
              if (pasted) turn.action = pasted;
            }
            turns.push(turn);
          } else if (item === "reasoning") {
            const summary = messageText(payload.summary);
            if (summary?.trim()) {
              turns.push({ idx: turns.length, role: "assistant", kind: "thinking", text: redactSecrets(summary), ts });
            }
          } else if (item === "function_call") {
            const name = str(payload.name) ?? "unknown";
            const callId = str(payload.call_id);
            const args = parseArguments(payload.arguments);
            if (SHELL_TOOLS.has(name)) {
              pushShell(name, args, ts, callId);
            } else if (name === PATCH_TOOL) {
              pushPatch(str(args?.input) ?? str(args?.patch), ts, callId);
            } else {
              const mcp = mcpParts(name, str(payload.namespace));
              pushToolUse(name, ts, callId, args, cwd, mcp);
            }
          } else if (item === "custom_tool_call") {
            const name = str(payload.name) ?? "unknown";
            const callId = str(payload.call_id);
            if (name === PATCH_TOOL) pushPatch(str(payload.input), ts, callId);
            else pushToolUse(name, ts, callId, undefined, cwd);
          } else if (item === "local_shell_call") {
            const action = obj(payload.action);
            pushShell(
              "local_shell",
              { command: action?.command, workdir: action?.working_directory },
              ts,
              str(payload.call_id),
            );
          } else if (item === "web_search_call") {
            pushToolUse("web_search", ts, undefined, undefined, cwd);
          } else if (item === "function_call_output" || item === "custom_tool_call_output") {
            pushOutput(str(payload.call_id), payload.output, ts);
          }
          // tool_search_*, image_generation_call, compaction and unknown items — ignored.
          break;
        }

        default:
          // compacted, world_state, inter_agent_* and any line type this parser does not know.
          break;
      }
    }

    const startedAt = timestamps.length > 0 ? timestamps.reduce((a, b) => (a < b ? a : b)) : "";
    const endedAt = timestamps.length > 0 ? timestamps.reduce((a, b) => (a > b ? a : b)) : "";

    const session: RawCodeSession = {
      source: CODEX_SOURCE,
      sourceSessionId: threadId ?? ref.sourceSessionId,
      contentHash,
      repo: { path: cwd, remoteUrl, branch },
      startedAt,
      endedAt,
      model,
      turns,
      filesTouched: [...filesTouched],
      toolCounts,
      usage: recordUsage ?? tokenCountUsage,
      models: modelsSeen.size > 0 ? [...modelsSeen] : undefined,
      actionsVersion: FORGE_ACTIONS_VERSION,
    };
    if (parentThreadId) session.parentSessionId = parentThreadId;
    return session;
  },
};

/** The forge-action input for one tool call: shell tools go in as `bash`, the only shell name forge-actions reads. */
function actionCall(
  toolName: string,
  input: Record<string, unknown> | undefined,
  cwd: string | undefined,
  mcpTool: string | undefined,
) {
  return { toolName: SHELL_TOOLS.has(toolName) ? "bash" : toolName, mcpTool, input, cwd };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
