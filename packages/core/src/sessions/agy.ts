// Antigravity (agy) CLI parser.
//
// Layout, checked against real captures (Antigravity CLI, 2026-10): one
// directory per conversation, `<root>/brain/<conversationId>/.system_generated/logs/`,
// holding two JSONL files with the same steps:
//   - transcript.jsonl       — display copy; long `content`, `thinking` and tool-call
//                              args are CUT (a `truncated_fields` array names them).
//   - transcript_full.jsonl  — the same steps, uncut.
// The parser reads the uncut file whenever it exists (see agyTranscriptFor), and the
// session-end hook resolves to the same file, so a hook upload and a sweep upload of
// one conversation hash identically.
//
// Step shape (one JSON object per line): `step_index`, `source`, `type`, `status`,
// `created_at` (ISO), and by kind:
//   USER_EXPLICIT/USER_INPUT        content            -> user prose
//   MODEL/PLANNER_RESPONSE          thinking?, content?, tool_calls?[{name,args}],
//                                   input_tokens?, output_tokens?, cache_read_tokens?
//   MODEL/<anything else>           the RESULT of the oldest unanswered tool call
//                                   (GENERIC, RUN_COMMAND, VIEW_FILE, LIST_DIRECTORY,
//                                   CODE_ACTION, GREP_SEARCH, SEARCH_WEB …); may carry `exit_code`
//   SYSTEM/*                        harness bookkeeping (SYSTEM_MESSAGE, EPHEMERAL_MESSAGE,
//                                   CHECKPOINT, CONVERSATION_HISTORY) — not conversation, skipped
// Tool calls carry NO id in the file. Results arrive in call order, so they pair first-in
// first-out; a synthetic id `<step_index>:<n>` ties the two turns together. Verified on six
// real sessions: every result step found a pending call. Assumption not verifiable from
// the data: a call whose result step was never written (a cut-off session) stays unpaired.
import { createHash } from "node:crypto";
import { isSensitiveFilePath, ownerTextOf, SessionRootUnreadableError, WRITTEN_TEXT_MAX_CHARS } from "./claude-code.js";
import { digestBashCommand } from "./forge-actions.js";
import { redactFileSecrets, redactSecrets } from "./redact.js";
import type { CodeSessionParser, RawCodeSession, RawTurn, RawUsage, SessionRef } from "./types.js";

export const AGY_SOURCE = "agy";
export const AGY_TRANSCRIPT = "transcript.jsonl";
export const AGY_TRANSCRIPT_FULL = "transcript_full.jsonl";

/** The file to parse for a conversation: the uncut transcript when it sits beside the display copy. */
export async function agyTranscriptFor(logsDir: string): Promise<string | undefined> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  for (const name of [AGY_TRANSCRIPT_FULL, AGY_TRANSCRIPT]) {
    const p = path.join(logsDir, name);
    try {
      if ((await fs.stat(p)).isFile()) return p;
    } catch {
      // not there — try the next candidate
    }
  }
  return undefined;
}

const FILE_WRITE_TOOLS = new Set(["write_to_file", "replace_file_content", "multi_replace_file_content"]);
const SHELL_TOOL = "run_command";

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * The cloud rejects a turn over 100,000 chars (apps/cloud/src/lib/code-sessions/payload.ts
 * MAX_TURN_TEXT_CHARS, not importable from core; keep in step). Redact first, cap after.
 */
export const AGY_MAX_TURN_TEXT_CHARS = 100_000;
const TURN_CAP_MARK = " …[+N chars]";

function capTurnText(text: string): string {
  const redacted = redactSecrets(text);
  if (redacted.length <= AGY_MAX_TURN_TEXT_CHARS) return redacted;
  const keep = AGY_MAX_TURN_TEXT_CHARS - TURN_CAP_MARK.length - String(redacted.length).length;
  return `${redacted.slice(0, keep)} …[+${redacted.length - keep} chars]`;
}

function capWritten(text: string): string {
  // Redact first, cap after, so a cut never splits a secret open (same order as claude-code.ts).
  const redacted = redactFileSecrets(text);
  if (redacted.length <= WRITTEN_TEXT_MAX_CHARS) return redacted;
  return `${redacted.slice(0, WRITTEN_TEXT_MAX_CHARS)} …[+${redacted.length - WRITTEN_TEXT_MAX_CHARS} chars]`;
}

/** Text the agent wrote to a file (new content only), unless the target looks like a secret store. */
function writtenTextOf(toolName: string, args: Record<string, unknown>): string | undefined {
  const target = str(args.TargetFile);
  if (target && isSensitiveFilePath(target)) return undefined;
  const parts: string[] = [];
  if (toolName === "write_to_file") {
    const c = str(args.CodeContent);
    if (c) parts.push(c);
  } else if (toolName === "replace_file_content") {
    const c = str(args.ReplacementContent);
    if (c) parts.push(c);
  } else if (toolName === "multi_replace_file_content" && Array.isArray(args.ReplacementChunks)) {
    for (const chunk of args.ReplacementChunks) {
      const c = str(obj(chunk)?.ReplacementContent);
      if (c) parts.push(c);
    }
  }
  const joined = parts.join("\n");
  return joined.trim() ? capWritten(joined) : undefined;
}

interface PendingCall {
  turn: RawTurn;
}

export const agyParser: CodeSessionParser = {
  source: AGY_SOURCE,

  async detect(root: string, onWarn?: (message: string) => void): Promise<SessionRef[]> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const refs: SessionRef[] = [];

    let dirs: string[];
    try {
      dirs = (await fs.readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (err) {
      throw new SessionRootUnreadableError(root, err);
    }

    for (const dir of dirs) {
      try {
        const transcript = await agyTranscriptFor(path.join(root, dir, ".system_generated", "logs"));
        if (transcript) refs.push({ source: AGY_SOURCE, sourceSessionId: dir, path: transcript });
      } catch (err) {
        onWarn?.(`skipped ${dir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return refs;
  },

  parse(ref: SessionRef, raw: string | Buffer): RawCodeSession {
    const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
    const contentHash = createHash("sha256").update(bytes).digest("hex");

    // Malformed or non-object lines (a half-written last line) are skipped, never fatal.
    const steps: Record<string, unknown>[] = [];
    for (const line of bytes.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = obj(JSON.parse(line));
        if (parsed) steps.push(parsed);
      } catch {
        // truncated or corrupt line
      }
    }

    const timestamps = steps.map((s) => str(s.created_at)).filter((t): t is string => t !== undefined);
    const startedAt = timestamps.length > 0 ? timestamps.reduce((a, b) => (a < b ? a : b)) : "";
    const endedAt = timestamps.length > 0 ? timestamps.reduce((a, b) => (a > b ? a : b)) : "";
    // A step without created_at inherits the previous step's time; before any, the first one's.
    // A file with no timestamps at all gets the epoch rather than "", which downstream cannot parse.
    let lastTs = startedAt || new Date(0).toISOString();

    const turns: RawTurn[] = [];
    const filesTouched = new Set<string>();
    const toolCounts: Record<string, number> = {};
    const usage: RawUsage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const pending: PendingCall[] = [];
    let cwd: string | undefined;

    steps.forEach((step, lineNo) => {
      const ts = str(step.created_at) ?? lastTs;
      lastTs = ts;
      const source = str(step.source);
      const type = str(step.type);
      const stepIndex = typeof step.step_index === "number" ? step.step_index : lineNo;

      if (source === "USER_EXPLICIT") {
        const content = str(step.content);
        if (!content) return;
        const turn: RawTurn = { idx: turns.length, role: "user", kind: "prose", text: capTurnText(content), ts };
        const ownerText = ownerTextOf(content);
        if (ownerText !== undefined) {
          turn.ownerText = capTurnText(ownerText);
          if (ownerText.trim() === "") turn.nonOwner = "compact_summary";
        }
        turns.push(turn);
        return;
      }

      if (source !== "MODEL") return; // SYSTEM/* and unknown sources are bookkeeping

      if (type === "PLANNER_RESPONSE") {
        usage.inputTokens += num(step.input_tokens);
        usage.outputTokens += num(step.output_tokens);
        usage.cacheReadInputTokens += num(step.cache_read_tokens);

        const thinking = str(step.thinking);
        if (thinking) {
          turns.push({ idx: turns.length, role: "assistant", kind: "thinking", text: capTurnText(thinking), ts });
        }
        const content = str(step.content);
        if (content) {
          turns.push({ idx: turns.length, role: "assistant", kind: "prose", text: capTurnText(content), ts });
        }
        const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        calls.forEach((rawCall, n) => {
          const call = obj(rawCall);
          const name = str(call?.name) ?? "unknown";
          const args = obj(call?.args) ?? {};
          toolCounts[name] = (toolCounts[name] ?? 0) + 1;
          const turn: RawTurn = {
            idx: turns.length,
            role: "assistant",
            kind: "tool_use",
            toolName: name,
            ts,
            toolUseId: `${stepIndex}:${n}`,
          };
          if (name === SHELL_TOOL) {
            const command = str(args.CommandLine);
            if (command) turn.inputDigest = digestBashCommand(command);
            cwd = cwd ?? str(args.Cwd);
          }
          if (FILE_WRITE_TOOLS.has(name)) {
            const target = str(args.TargetFile);
            if (target) {
              filesTouched.add(target);
              turn.filePath = target;
            }
            if (name === "write_to_file") turn.resultType = args.Overwrite === true ? "update" : "create";
            else turn.resultType = "update";
            const written = writtenTextOf(name, args);
            if (written) turn.text = written;
          }
          turns.push(turn);
          pending.push({ turn });
        });
        return;
      }

      // Any other MODEL step is the result of the oldest unanswered call. The output itself is
      // elided like every other harness (it can hold file contents and secrets); only ok/error stays.
      const call = pending.shift();
      const failed = step.status === "ERROR" || (typeof step.exit_code === "number" && step.exit_code !== 0);
      turns.push({
        idx: turns.length,
        role: "user",
        kind: "tool_result",
        toolName: call?.turn.toolName,
        text: `[tool_result elided: ${failed ? "error" : "ok"}]`,
        ts,
      });
    });

    return {
      source: AGY_SOURCE,
      sourceSessionId: ref.sourceSessionId,
      contentHash,
      repo: { path: cwd },
      startedAt,
      endedAt,
      turns,
      filesTouched: [...filesTouched],
      toolCounts,
      usage,
    };
  },
};
