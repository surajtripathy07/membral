// Claude Code transcript parser (ADR 0021, Q3).
// Reads `~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl` — one JSON event
// per line. `detect()` walks the filesystem; `parse()` is pure (no fs/network).

import { createHash } from "node:crypto";
import {
  actionFromPastedText,
  assignActions,
  createCommitShaBackfill,
  deriveToolActions,
  FORGE_ACTIONS_VERSION,
  FORGE_COMMAND,
  parseSlashCommandMessage,
  toolResultText,
} from "./forge-actions.js";
import { buildInputDigest, type InputDigestConfig } from "./input-digest.js";
import { redactFileSecrets, redactSecrets } from "./redact.js";
import type {
  CodeSessionParser,
  NonOwnerKind,
  ParseExtras,
  RawCodeSession,
  RawSubAgent,
  RawTurn,
  RawUsage,
  SessionRef,
  SubAgentFile,
} from "./types.js";

const META_PREFIXES = [
  "<command-name>",
  "<command-message>",
  "<local-command-stdout>",
  "<task-notification>",
  "<system-reminder>",
];
// A user-role message the owner did not write: shell output echoed into the chat, or a harness caveat.
const SHELL_OUTPUT = /^\s*<(?:bash-stdout|bash-stderr|local-command-stderr)>/;
const COMMAND_CAVEAT = /^\s*<local-command-caveat>/;
/**
 * Claude Code wraps a long paste inline in the prompt string:
 * `<pasted_content id="c71c">…</pasted_content id="c71c">`. The span is text
 * the owner pasted, not wrote (a page, a log, another tool's output).
 */
const PASTED_SPAN = /<pasted_content(?:\s+id="([^"]*)")?\s*>([\s\S]*?)<\/pasted_content(?:\s+id="[^"]*")?\s*>/g;

/**
 * The prompt with every pasted span removed — the owner's own words only — or
 * undefined when the prompt carries no paste (then `text` IS the owner's text).
 * The turn keeps its full text for context; this is what may ground an owner quote.
 */
export function ownerTextOf(content: string): string | undefined {
  let stripped = stripHarnessContext(content);
  if (stripped.includes("<pasted_content")) stripped = stripped.replace(PASTED_SPAN, " ");
  return stripped === content ? undefined : stripped;
}

/** A harness-injected `<system-reminder>` block inside a prompt (hook context, reminders); an unclosed one runs to the end. */
// Review B3 (structural only): a whole block on its own lines, closing tag present. An unclosed tag,
// or a tag quoted inline in the owner's sentence, is the owner's text and stays.
const SYSTEM_REMINDER_SPAN = /(^|\n)[ \t]*<system-reminder>[\s\S]*?<\/system-reminder>[ \t]*(?=\n|$)/g;
/**
 * The Membral context card a harness prepended to the prompt (the bridge-era
 * runner, and any SessionStart context echoed into the prompt): it opens with
 * one of the preamble's own section headings and hands over at a line
 * `User's message:`. Everything before that line is Membral's text.
 */
const MEMBRAL_CARD_HEADING =
  /^\s*## (?:About this user|Relevant memory|Related conversations|Code projects|What Membral knows)\b/;
const MEMBRAL_CARD_HANDOVER = /^User's message:[ \t]*$/m;

/**
 * v4 item 4: the prompt with harness-injected context removed — system
 * reminder blocks (whole blocks on their own lines, closing tag present), and a
 * leading Membral context card up to and including its `User's message:` line
 * (only when that handover line is there).
 * Returns `content` itself when nothing was injected. Never the owner's words:
 * no title and no owner quote may come from what this removes.
 */
export function stripHarnessContext(content: string): string {
  let out = content.includes("<system-reminder>") ? content.replace(SYSTEM_REMINDER_SPAN, "$1") : content;
  // Review B3: the card is stripped only when the injection's whole structure is there — its
  // opening section heading AND the `User's message:` handover. A heading alone is the owner's.
  if (MEMBRAL_CARD_HEADING.test(out)) {
    const m = MEMBRAL_CARD_HANDOVER.exec(out);
    if (m) out = out.slice(m.index + m[0].length).replace(/^\s+/, "");
  }
  return out === content ? content : out.trim() === "" ? "" : out;
}
// Claude Code's compaction summary opens with this line (older transcripts lack `isCompactSummary`).
const CONTINUATION_SUMMARY = /^This session is being continued from a previous conversation/;
// A slash-command message starts with either tag — both orders appear in real transcripts.
const SLASH_MESSAGE = /^<command-(?:name|message)>/;

// tool_use.input.file_path is only meaningful for these file-touching tools.
// MultiEdit/NotebookEdit are kept defensively per ADR 0026 D1 even though
// they occur 0 times in the validated corpus.
const FILE_PATH_TOOLS = new Set(["Edit", "Write", "Read", "NotebookEdit", "MultiEdit"]);

// Text the session itself wrote to a file: Write's `content`, Edit's
// `new_string`, each MultiEdit edit's `new_string`. Kept on the tool_use
// turn's `text` so memory extraction sees a ruling or number the agent
// recorded in a doc or note. The cap is by size only (head kept, never a path
// rule); Edit's `old_string` is not kept. tool_RESULT payloads stay elided.
// 8,000 so a long doc (a goal or design file) keeps rulings that sit past the
// first screen; the per-session extraction USD budget bounds the cost.
export const WRITTEN_TEXT_MAX_CHARS = 8_000;

// A safety deny-list, not a semantic rule: a write to a file whose basename
// looks like a secret store keeps no text at all (the tool_use turn and its
// path still land). Redaction below covers the shapes it can see; these files
// hold secrets in shapes it cannot.
// One basename pattern per line (whole basename, case-insensitive).
const SENSITIVE_FILE_BASENAMES: readonly RegExp[] = [
  /^\.env$/i,
  /^\.env\..*$/i,
  /^\.envrc$/i,
  /^.*\.pem$/i,
  /^.*\.key$/i,
  /^.*\.p12$/i,
  /^.*\.pfx$/i,
  /^.*\.jks$/i,
  /^.*\.keystore$/i,
  /^.*\.asc$/i,
  /^.*\.gpg$/i,
  /^.*\.ovpn$/i,
  /^id_rsa.*$/i,
  /^id_ed25519.*$/i,
  /^credentials.*$/i,
  /^secret\..*$/i,
  /^.*secrets.*$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.htpasswd$/i,
  /^\.git-credentials$/i,
  /^.*\.tfvars$/i,
  /^.*\.tfstate$/i,
  /^service-account.*\.json$/i,
  /^.*kubeconfig.*$/i,
];

/** True when the path's basename matches the sensitive-file deny-list. */
export function isSensitiveFilePath(filePath: string): boolean {
  const base = filePath.split(/[\\/]/).pop() ?? "";
  return SENSITIVE_FILE_BASENAMES.some((re) => re.test(base));
}

function writtenTextOf(toolName: string, input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  if (typeof input.file_path === "string" && isSensitiveFilePath(input.file_path)) return undefined;
  let raw: string | undefined;
  if (toolName === "Write") {
    raw = typeof input.content === "string" ? input.content : undefined;
  } else if (toolName === "Edit") {
    raw = typeof input.new_string === "string" ? input.new_string : undefined;
  } else if (toolName === "MultiEdit" && Array.isArray(input.edits)) {
    const parts = input.edits
      .map((e) => (e && typeof e === "object" ? (e as Record<string, unknown>).new_string : undefined))
      .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
    raw = parts.length > 0 ? parts.join("\n") : undefined;
  }
  if (raw === undefined || raw.trim().length === 0) return undefined;
  // redactFileSecrets runs every rule: prose shapes, command shapes (secret CLI
  // flags, `KEY=value` env) and config/dotfile shapes (`client_secret: x`,
  // `_authToken=x`, netrc and pgpass lines), the shapes a written file carries.
  // The cap is applied after redaction, so a cut never splits a secret open.
  const redacted = redactFileSecrets(raw);
  if (redacted.length <= WRITTEN_TEXT_MAX_CHARS) return redacted;
  return `${redacted.slice(0, WRITTEN_TEXT_MAX_CHARS)} …[+${redacted.length - WRITTEN_TEXT_MAX_CHARS} chars]`;
}

// The literal sentinel Claude Code emits for internal/synthetic messages —
// never a real model, must be excluded from `models[]` (ADR 0026 §1.1).
const SYNTHETIC_MODEL = "<synthetic>";

// ADR 0026 D10 — tool-input digest is a privacy-relevant surface (shell
// commands can carry secrets/paths/hostnames). Recommended default from the
// validation report's open question 1: restrict to an allowlist of forge
// commands rather than persisting arbitrary Bash input. Length-capped and
// always passed through redactSecrets. The Bash gate and caps live in
// forge-actions.ts (`FORGE_COMMAND` = gh/git/glab at 1200 chars,
// `TEST_COMMAND` at 400) so both harness parsers share one allowlist
// (goal 2026-09-26 W3).

// A hostile/corrupted meta.json can hand back a multi-megabyte string for any
// field — cap the short identifier-shaped fields the same way MAX_DIGEST_CHARS
// bounds tool-input digests (description is already capped downstream by the
// cloud payload schema's MAX_SUBAGENT_TEXT_CHARS; these are the fields it
// doesn't cover).
const MAX_SUBAGENT_ID_FIELD_CHARS = 2_000;

function capString(s: string): string {
  return s.length > MAX_SUBAGENT_ID_FIELD_CHARS ? s.slice(0, MAX_SUBAGENT_ID_FIELD_CHARS) : s;
}

interface CCUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  /** The split of `cache_creation_input_tokens` by cache lifetime. */
  cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number };
}

interface CCContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean | null;
  /** tool_result payload — a string or text blocks. Parsed for forge facts (W3), then elided; never stored. */
  content?: unknown;
}

interface CCMessage {
  id?: string;
  role?: string;
  model?: string;
  content?: string | CCContentBlock[];
  usage?: CCUsage;
}

interface CCToolUseResult {
  // Structured (ADR 0026 D1) — NOT derived from the tool name. 'create' for
  // a Write that made a new file, 'update' for one that overwrote an
  // existing file (Write is 'update' 5.3% of the time in the validated
  // corpus) and for Edit results.
  type?: string;
  // Edit-result hunk array — its length is a real changed-hunk count.
  structuredPatch?: unknown[];
  // Present on an Agent/Task tool_use's result (ADR 0026 D3) — redundant
  // join path to the sub-agent transcript, 100% present parent-side.
  agentId?: string;
}

interface CCEvent {
  type?: string;
  message?: CCMessage;
  cwd?: string;
  gitBranch?: string;
  timestamp?: string;
  isMeta?: boolean | null;
  /** The compaction summary Claude Code writes as a user message after `/compact` or an auto-compact. */
  isCompactSummary?: boolean | null;
  isSidechain?: boolean | null;
  // ADR 0026 D2 — MCP tool attribution, present on ~1,349 events, sibling to `message`.
  attributionMcpServer?: string;
  attributionMcpTool?: string;
  // ADR 0026 D1/D3 — present on the `user` event carrying a tool_result block.
  toolUseResult?: CCToolUseResult;
}

function addUsage(acc: RawUsage | undefined, u: CCUsage | undefined): RawUsage | undefined {
  if (!u) return acc;
  const out: RawUsage = {
    inputTokens: (acc?.inputTokens ?? 0) + (u.input_tokens ?? 0),
    outputTokens: (acc?.outputTokens ?? 0) + (u.output_tokens ?? 0),
    cacheReadInputTokens: (acc?.cacheReadInputTokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    cacheCreationInputTokens: (acc?.cacheCreationInputTokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
  };
  const oneHour = u.cache_creation?.ephemeral_1h_input_tokens;
  if (acc?.cacheCreation1hInputTokens !== undefined || typeof oneHour === "number") {
    out.cacheCreation1hInputTokens =
      (acc?.cacheCreation1hInputTokens ?? 0) + (typeof oneHour === "number" ? oneHour : 0);
  }
  return out;
}

/** Claude Code tool names → digest kind. `Bash` matches any casing. */
export const INPUT_DIGEST_CONFIG: InputDigestConfig = {
  kinds: { Agent: "agent", Task: "agent", WebFetch: "webfetch" },
  bashAnyCase: true,
};

/** Sum usage + take the last non-synthetic model across one sub-agent transcript's assistant messages (ADR 0026 D3 — model comes from message.model, never the 42%-populated meta.model). */
function summarizeSubAgentTranscript(raw: string | Buffer): { model?: string; usage?: RawUsage } {
  const text = typeof raw === "string" ? raw : raw.toString("utf8");
  let usage: RawUsage | undefined;
  let model: string | undefined;
  // Same dedup rule as the main transcript: usage repeats on every line of a
  // multi-block message.id — count it once per distinct id.
  const countedMessageIds = new Set<string>();

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let event: CCEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type !== "assistant" || !event.message) continue;
    if (typeof event.message.model === "string" && event.message.model && event.message.model !== SYNTHETIC_MODEL) {
      model = event.message.model;
    }
    const messageId = event.message.id;
    if (!messageId || !countedMessageIds.has(messageId)) {
      usage = addUsage(usage, event.message.usage);
      if (messageId) countedMessageIds.add(messageId);
    }
  }

  return { model, usage };
}

function parseSubAgentFile(file: SubAgentFile): RawSubAgent {
  let meta: Record<string, unknown> = {};
  try {
    const metaText = typeof file.meta === "string" ? file.meta : file.meta.toString("utf8");
    const parsed: unknown = JSON.parse(metaText);
    // JSON.parse succeeds (does not throw) for `null`, arrays, numbers,
    // strings, and booleans — none of those are usable as a field bag. Only
    // a genuine plain object gets treated as meta; anything else degrades to
    // {} the same way a JSON.parse failure already does (best-effort, never
    // throws — matches readSubAgentFiles' documented contract and ADR 0026
    // D13's "degrade to field-absent rather than throw").
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      meta = parsed as Record<string, unknown>;
    }
  } catch {
    meta = {};
  }

  const subAgent: RawSubAgent = {
    agentId: capString(file.agentId),
    toolUseId: typeof meta.toolUseId === "string" ? capString(meta.toolUseId) : undefined,
    agentType: typeof meta.agentType === "string" ? capString(meta.agentType) : undefined,
    description: typeof meta.description === "string" ? redactSecrets(meta.description) : undefined,
    spawnDepth: typeof meta.spawnDepth === "number" ? meta.spawnDepth : undefined,
    parentAgentId: typeof meta.parentAgentId === "string" ? capString(meta.parentAgentId) : undefined,
    isFork: meta.isFork === true,
  };

  if (file.transcript) {
    const { model, usage } = summarizeSubAgentTranscript(file.transcript);
    subAgent.model = model;
    subAgent.usage = usage;
  }

  return subAgent;
}

// Thrown by claudeCodeParser.detect() when `root` ITSELF can't be listed —
// missing, permission-denied, not-a-directory, etc. — as opposed to a root
// that exists, is readable, and simply has zero project subdirectories in
// it (a legitimate "nothing here yet" state, which still returns `[]`).
//
// 2026-07-26 adversarial review (round 2, M1/Minor2): detect() used to
// swallow BOTH cases into `[]`, indistinguishable to the caller. That made
// `import-sessions` treat "the session root is gone/unreadable" (capture
// actually broken — e.g. `~/.claude/projects` renamed, permissions
// changed, a bad --root) exactly the same as "nothing new since last time"
// (healthy idle state): zero HTTP calls, exit 0, cursor/heartbeat still
// advance, and the failure is invisible. Per-project-directory failures
// below are still swallowed on purpose (`continue`) — one corrupted
// project folder among many good ones shouldn't kill the whole walk; only
// the root itself being unreadable is a "capture is broken" signal.
export class SessionRootUnreadableError extends Error {
  readonly root: string;
  readonly cause?: unknown;

  constructor(root: string, cause?: unknown) {
    super(`Session root not found or unreadable: ${root}`);
    this.name = "SessionRootUnreadableError";
    this.root = root;
    this.cause = cause;
  }
}

export const claudeCodeParser: CodeSessionParser = {
  source: "claude-code",

  async detect(root: string, onWarn?: (message: string) => void): Promise<SessionRef[]> {
    const { readdir } = await import("node:fs/promises");
    const path = await import("node:path");
    const refs: SessionRef[] = [];

    let projectDirs: string[];
    try {
      projectDirs = (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (err) {
      throw new SessionRootUnreadableError(root, err);
    }

    for (const dir of projectDirs) {
      const dirPath = path.join(root, dir);
      let files: string[];
      try {
        files = (await readdir(dirPath, { withFileTypes: true }))
          .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
          .map((entry) => entry.name);
      } catch (err) {
        // Round 3 (Minor 2): this used to be silent — round 2's MAJOR 1 fix
        // made a fully-unreadable ROOT loud, but a single unreadable
        // PROJECT subdirectory one level down had zero diagnostics at all.
        // Still swallowed on purpose (one bad folder shouldn't fail the
        // whole walk) — but the caller can now hear about it via onWarn.
        onWarn?.(`skipping unreadable project directory "${dirPath}": ${errMessage(err)}`);
        continue;
      }
      for (const name of files) {
        const sourceSessionId = name.slice(0, -".jsonl".length);
        // ADR 0026 D3 — sub-agent sidecars live in a sibling directory named
        // after the session id, one level below the project dir:
        // <project>/<sessionId>/subagents/agent-*.jsonl(+.meta.json). This is
        // the actual reason sub-agents were invisible (a discovery gap, not
        // the `isSidechain` filtering the old comment blamed).
        const subAgentsDir = path.join(dirPath, sourceSessionId, "subagents");
        let hasSubAgentsDir = false;
        try {
          const stat = await import("node:fs/promises").then((fs) => fs.stat(subAgentsDir));
          hasSubAgentsDir = stat.isDirectory();
        } catch {
          hasSubAgentsDir = false;
        }

        refs.push({
          source: "claude-code",
          sourceSessionId,
          path: path.join(dirPath, name),
          subAgentsDir: hasSubAgentsDir ? subAgentsDir : undefined,
        });
      }
    }
    return refs;
  },

  parse(ref: SessionRef, raw: string | Buffer, extras?: ParseExtras): RawCodeSession {
    // The main transcript drops isSidechain:true lines — sub-agent traffic
    // is not the human's session; each sub-agent becomes its own child
    // session via parseSubAgentSessions below instead.
    const session = parseTranscript(ref.sourceSessionId, raw, { keepSidechain: false });
    const subAgents = (extras?.subAgents ?? []).map(parseSubAgentFile);
    if (subAgents.length > 0) session.subAgents = subAgents;
    return session;
  },

  parseSubAgentSessions(parent: RawCodeSession, extras?: ParseExtras): RawCodeSession[] {
    const children: RawCodeSession[] = [];
    for (const file of extras?.subAgents ?? []) {
      // ~1.7% of spawns have no transcript on disk — nothing to ingest; the
      // parent's subAgents[] metadata still records the spawn.
      if (!file.transcript) continue;
      const meta = parseSubAgentFile(file);
      // Every line of a sub-agent transcript is isSidechain:true — keep them
      // all here (the main-file filter would drop the whole transcript).
      const child = parseTranscript(
        subAgentSessionId(parent.sourceSessionId, meta.agentId ?? file.agentId),
        file.transcript,
        {
          keepSidechain: true,
        },
      );
      child.parentSessionId = parent.sourceSessionId;
      child.subAgent = meta;
      // A child with no cwd/branch of its own resolves to the parent's
      // project (same repo identity) rather than "Unassigned".
      child.repo = {
        path: child.repo.path ?? parent.repo.path,
        branch: child.repo.branch ?? parent.repo.branch,
        remoteUrl: child.repo.path && child.repo.path !== parent.repo.path ? undefined : parent.repo.remoteUrl,
      };
      children.push(child);
    }
    return children;
  },
};

/** Child session id for a Claude Code sub-agent: unique per parent, stable across re-uploads (content_hash dedup applies per child). */
export function subAgentSessionId(parentSessionId: string, agentId: string): string {
  return `${parentSessionId}:agent-${agentId}`;
}

/**
 * Parse one Claude Code JSONL transcript (a main session file or a
 * sub-agent's agent-<id>.jsonl) into a RawCodeSession without subAgents.
 * `keepSidechain` is false for the main file (sub-agent lines echoed there
 * are not the human's session) and true for a sub-agent's own file, where
 * every line is a sidechain line.
 */
function parseTranscript(
  sourceSessionId: string,
  raw: string | Buffer,
  opts: { keepSidechain: boolean },
): RawCodeSession {
  const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  const contentHash = createHash("sha256").update(bytes).digest("hex");
  const text = bytes.toString("utf8");

  const turns: RawTurn[] = [];
  const filesTouchedSet = new Set<string>();
  const toolCounts: Record<string, number> = {};
  const toolNameById = new Map<string, string>();
  // tool_use.id -> the call's input + MCP attribution, kept in memory only so
  // the later tool_result can be parsed against the command that produced it
  // (W3: result-proven verbs, sha/branch/url/state enrichment). Never stored.
  const toolCallById = new Map<
    string,
    { toolName: string; mcpTool?: string; input?: Record<string, unknown>; cwd?: string }
  >();
  // tool_use.id -> the RawTurn object already pushed for it, so a LATER
  // tool_result event's structured toolUseResult can backfill
  // resultType/editHunks onto the earlier turn in place (ADR 0026 D1).
  const toolUseTurnById = new Map<string, RawTurn>();
  // F2 — a quiet commit's sha from a later `git rev-parse HEAD` / `git log`.
  const shaBackfill = createCommitShaBackfill();
  const timestamps: string[] = [];
  let cwd: string | undefined;
  let gitBranch: string | undefined;
  let model: string | undefined;
  let sessionUsage: RawUsage | undefined;
  const modelsSeen = new Set<string>();
  // usage is carried on EVERY JSONL line of a given assistant message.id
  // (one line per content block) — count it once per distinct message.id,
  // never once per line, or a multi-block message inflates its own totals.
  const usageCountedMessageIds = new Set<string>();

  // Assistant messages are split across JSONL lines that share message.id
  // (one line per content block). Reassemble consecutive same-kind
  // thinking/text blocks into a single turn; tool_use is never merged.
  let currentMessageId: string | undefined;
  let pendingKind: "prose" | "thinking" | undefined;
  let pendingParts: string[] = [];
  let pendingTs: string | undefined;

  const flushPending = () => {
    if (pendingKind && pendingParts.length > 0) {
      const joined = pendingParts.join("\n\n").trim();
      if (joined.length > 0) {
        turns.push({
          idx: turns.length,
          role: "assistant",
          kind: pendingKind,
          // Assistant prose/thinking routinely echoes .env snippets,
          // connection strings, and generated tokens — redact it the same
          // as the user spine.
          text: redactSecrets(joined),
          ts: pendingTs ?? "",
        });
      }
    }
    pendingKind = undefined;
    pendingParts = [];
    pendingTs = undefined;
  };

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let event: CCEvent;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue; // malformed line — skip defensively
    }

    // Sub-agent traffic (isSidechain:true) is not the human's session — skip
    // entirely, for both roles, in the main transcript. A sub-agent's own
    // transcript keeps it (keepSidechain) — every line there is sidechain.
    if (event.isSidechain === true && !opts.keepSidechain) continue;

    if (typeof event.cwd === "string" && event.cwd) cwd = event.cwd;
    if (typeof event.gitBranch === "string" && event.gitBranch) gitBranch = event.gitBranch;
    if (typeof event.timestamp === "string" && event.timestamp) timestamps.push(event.timestamp);

    if (event.type === "assistant") {
      const message = event.message;
      if (!message) continue;
      if (typeof message.model === "string" && message.model && message.model !== SYNTHETIC_MODEL) {
        model = message.model;
        modelsSeen.add(message.model);
      }
      if (!message.id || !usageCountedMessageIds.has(message.id)) {
        sessionUsage = addUsage(sessionUsage, message.usage);
        if (message.id) usageCountedMessageIds.add(message.id);
      }

      if (message.id !== currentMessageId) {
        flushPending();
        currentMessageId = message.id;
      }

      const blocks: CCContentBlock[] = Array.isArray(message.content)
        ? message.content
        : typeof message.content === "string"
          ? [{ type: "text", text: message.content }]
          : [];

      for (const block of blocks) {
        if (block.type === "text" || block.type === "thinking") {
          const kind: "prose" | "thinking" = block.type === "text" ? "prose" : "thinking";
          const blockText = block.type === "text" ? block.text : block.thinking;
          if (kind !== pendingKind) {
            flushPending();
            pendingKind = kind;
          }
          if (typeof blockText === "string" && blockText.length > 0) {
            pendingParts.push(blockText);
          }
          pendingTs = pendingTs ?? event.timestamp;
        } else if (block.type === "tool_use") {
          flushPending();
          const toolName = typeof block.name === "string" && block.name ? block.name : "unknown";
          toolCounts[toolName] = (toolCounts[toolName] ?? 0) + 1;
          if (block.id) toolNameById.set(block.id, toolName);

          let filePath: string | undefined;
          if (FILE_PATH_TOOLS.has(toolName)) {
            const fp = block.input?.file_path;
            if (typeof fp === "string" && fp) {
              filePath = fp;
              filesTouchedSet.add(fp);
            }
          }

          const turn: RawTurn = {
            idx: turns.length,
            role: "assistant",
            kind: "tool_use",
            toolName,
            text: writtenTextOf(toolName, block.input),
            filePath,
            ts: event.timestamp ?? "",
            toolUseId: block.id,
            mcpServer: event.attributionMcpServer,
            mcpTool: event.attributionMcpTool,
            inputDigest: buildInputDigest(INPUT_DIGEST_CONFIG, toolName, block.input),
          };
          // W3 — actions from the command alone; the tool_result (if it ever
          // arrives) re-derives them with the result text below.
          // D-051 F1: the call's own cwd — each action's directory is tracked from it and resolved
          // to a repo at import, the same way the session's project is.
          const call = { toolName, mcpTool: event.attributionMcpTool, input: block.input, cwd };
          assignActions(turn, deriveToolActions(call));
          turns.push(turn);
          if (block.id) {
            toolUseTurnById.set(block.id, turn);
            toolCallById.set(block.id, call);
          }
        }
        // Unknown content block types are ignored defensively.
      }
      continue;
    }

    if (event.type === "user") {
      flushPending();
      currentMessageId = undefined;

      const content = event.message?.content;

      if (typeof content === "string") {
        if (event.isMeta === true) continue;
        // B13 — a slash line whose args name a forge ref is the developer's
        // own statement of what the session is about: emit one prose turn
        // carrying the ref (source `command`, skill as a label only). Any
        // other meta-wrapped message is still skipped as before.
        if (SLASH_MESSAGE.test(content)) {
          const slash = parseSlashCommandMessage(content);
          if (slash) {
            turns.push({
              idx: turns.length,
              role: "user",
              kind: "prose",
              text: slash.text,
              ts: event.timestamp ?? "",
              action: slash.action,
            });
          }
          continue;
        }
        if (META_PREFIXES.some((prefix) => content.startsWith(prefix))) continue;
        // Not the owner's words: kept as context, marked so no consumer reads them as the owner's prose.
        const nonOwner: NonOwnerKind | undefined =
          event.isCompactSummary === true || CONTINUATION_SUMMARY.test(content)
            ? "compact_summary"
            : SHELL_OUTPUT.test(content)
              ? "shell_output"
              : COMMAND_CAVEAT.test(content)
                ? "caveat"
                : undefined;
        const proseTurn: RawTurn = {
          idx: turns.length,
          role: "user",
          kind: "prose",
          text: redactSecrets(content),
          ts: event.timestamp ?? "",
        };
        if (nonOwner) proseTurn.nonOwner = nonOwner;
        // A `<pasted_content>` span is text the owner pasted, not wrote: the turn keeps
        // it for context (one turn per entry, idx unchanged); `ownerText` is the rest.
        const ownerText = nonOwner ? undefined : ownerTextOf(content);
        if (ownerText !== undefined) proseTurn.ownerText = redactSecrets(ownerText);
        // W3 — a pasted forge URL names a ref (source `paste`); only the owner's own prose does.
        const pasted = nonOwner ? undefined : actionFromPastedText(ownerText ?? content);
        if (pasted) proseTurn.action = pasted;
        turns.push(proseTurn);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== "tool_result") continue; // ignore other block types defensively
          const toolName = block.tool_use_id ? toolNameById.get(block.tool_use_id) : undefined;
          const status = block.is_error ? "error" : "ok";
          // W3 — parse the result text for fixed-shape forge facts BEFORE it
          // is elided: the sha in `[branch sha]`, the branch in `X -> X`, the
          // MR url, the item state. The text itself is never stored (B10).
          const call = block.tool_use_id ? toolCallById.get(block.tool_use_id) : undefined;
          const resultTurn = block.tool_use_id ? toolUseTurnById.get(block.tool_use_id) : undefined;
          if (call && resultTurn) {
            // The result arrived: an empty or non-text content is still "returned" (`git commit -q` prints nothing).
            const observed = { ...call, result: toolResultText(block.content) ?? "", isError: block.is_error === true };
            const actions = deriveToolActions(observed);
            assignActions(resultTurn, actions);
            shaBackfill.observe(observed, actions);
            // R-5/R-3: a git/gh/glab Bash call that errored and produced no
            // action (`nothing to commit`, a pre-commit hook rejection, …) is
            // proven to have done nothing — its `inputDigest` would otherwise
            // be the only trace left, and a consumer scanning digest text
            // alone (with no action data to check) can mistake it for
            // evidence the command succeeded. Clear it once the result proves
            // it didn't.
            if (
              actions.length === 0 &&
              observed.isError &&
              resultTurn.inputDigest !== undefined &&
              call.toolName.toLowerCase() === "bash" &&
              typeof call.input?.command === "string" &&
              FORGE_COMMAND.test(call.input.command)
            ) {
              delete resultTurn.inputDigest;
            }
          }
          turns.push({
            idx: turns.length,
            role: "user",
            kind: "tool_result",
            toolName,
            text: `[tool_result elided: ${status}]`,
            ts: event.timestamp ?? "",
          });

          // ADR 0026 D1 — backfill the EARLIER tool_use turn's
          // created/edited signal from this result's structured
          // toolUseResult, never from the tool name. One tool_result per
          // event is the observed shape; if an event ever carries more
          // than one, applying the event's single toolUseResult to each
          // matched block is the same defensive best-effort the rest of
          // this parser uses for unseen shapes.
          const sourceTurn = block.tool_use_id ? toolUseTurnById.get(block.tool_use_id) : undefined;
          if (sourceTurn && event.toolUseResult) {
            const rt = event.toolUseResult.type;
            if (rt === "create" || rt === "update") sourceTurn.resultType = rt;
            if (Array.isArray(event.toolUseResult.structuredPatch)) {
              sourceTurn.editHunks = event.toolUseResult.structuredPatch.length;
            }
          }
        }
      }
    }

    // Any other type — system, file-history-snapshot, queue-operation, mode,
    // permission-mode, last-prompt, ai-title, summary (legacy compaction),
    // attachment, ... — is ignored defensively. cwd/gitBranch/timestamp
    // above are already captured from any event that carries them.
  }
  flushPending();

  const startedAt = timestamps.length > 0 ? timestamps.reduce((a, b) => (a < b ? a : b)) : "";
  const endedAt = timestamps.length > 0 ? timestamps.reduce((a, b) => (a > b ? a : b)) : "";

  return {
    source: "claude-code",
    sourceSessionId,
    contentHash,
    repo: { path: cwd, branch: gitBranch },
    startedAt,
    endedAt,
    model,
    turns,
    filesTouched: [...filesTouchedSet],
    toolCounts,
    usage: sessionUsage,
    models: modelsSeen.size > 0 ? [...modelsSeen] : undefined,
    actionsVersion: FORGE_ACTIONS_VERSION,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
