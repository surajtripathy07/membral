// Session-end questionnaire (recall-precision W3b, "verifiable answers only").
//
// TRIGGER: Claude Code's SessionEnd hook (session-end-hook.ts). When
// ~/.membral/config.json has `dogfood.questionnaire: true`, the hook spawns a
// DETACHED `membral session-end-hook --questionnaire <session_id>
// --deferred-path <transcript> [--cwd <dir>]` child and returns at once (the
// spawn is milliseconds; the hook's own ≤ 2 s budget is untouched). The child
// reads the transcript; when no injected context is found there (the
// preamble's or prompt hook's `hook_additional_context` attachments) it stops
// and logs `skipped no_injected_lines`.
// TODO(opencode, copilot-cli, codex): no questionnaire yet; their session-end
// paths do not spawn this child.
//
// The child runs `claude` with QUESTIONNAIRE_CLAUDE_ARGS (`-p --resume <id>
// --fork-session --no-session-persistence`, no tools, no MCP, one turn) in the
// session's cwd: the fork answers from the session's own context, the original
// transcript is not modified, and the fork is never written to disk (so no
// sweep can upload it as a new session; isQuestionnaireSession is the second
// guard on the import side). The lock-down matches the cloud's claude-code
// extraction provider (apps/cloud/src/lib/llm/claude-code-provider.ts): the
// unattended fork gets none of the user's tools, MCP servers or permissions.
// The prompt goes on stdin; the run is killed after QUESTIONNAIRE_TIMEOUT_MS.
// A project disabled in ~/.membral/sync.json (isProjectEnabled on the cwd) is
// skipped before claude runs, with a hook.log line. RECURSION GUARD: that claude runs with
// MEMBRAL_QUESTIONNAIRE=1, and every Membral hook seeing it does nothing (no
// preamble, no prompt recall, no upload, no questionnaire).
//
// Four fixed questions (QUESTIONS; the cloud keeps the same text in
// apps/cloud/src/lib/memory/questionnaire.ts), asked in a random order that is
// recorded. Every item needs a turn pointer (a verbatim excerpt of the turn);
// an item without one is dropped here, and the server drops it again under its
// Zod schema. A reply that is not the expected JSON stores nothing and logs.
// The self-report goes to POST /api/memory/questionnaire; an older server's
// 404 is silent.
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { claudeCodeParser } from "@membral/core";
import { loadCliConfig } from "./cli-config.js";
import { createUploadClient, resolveUploadConfig } from "./code-session-upload.js";
import type { ApiClient } from "./lib/api-client.js";
import { isProjectEnabled, loadSyncAllowlist } from "./sync-allowlist.js";

export const QUESTIONNAIRE_ENV = "MEMBRAL_QUESTIONNAIRE";
export const QUESTIONNAIRE_TIMEOUT_MS = 120_000;
export const QUESTION_IDS = ["q1", "q2", "q3", "q4"] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];

/** Worded neutrally: never the tool's name, never "was it useful". Same text as the cloud's QUESTIONS. */
export const QUESTIONS: Record<QuestionId, string> = {
  q1: "Which of the injected lines did you act on? For each, quote the injected line and point to the turn where you acted on it.",
  q2: "Which of the injected lines were wrong or out of date? For each, quote the injected line and point to the turn that shows it was wrong or out of date.",
  q3: "Which of the injected lines did you ignore? For each, quote the injected line and point to the turn where it was in front of you and you went another way, or the turn it arrived in.",
  q4: "What did you work out during this session that an injected line already stated? For each, quote the injected line, quote what you worked out, and point to the turn where you worked it out.",
};

const MIN_TURN_POINTER_CHARS = 8;
const MAX_TEXT = 600;
const MAX_ITEMS = 20;

export interface QuestionnaireItem {
  line: string;
  turn: string;
  worked_out?: string;
}
export type QuestionnaireAnswers = Record<QuestionId, QuestionnaireItem[]>;

/** True inside the forked claude the questionnaire runs (and anything it spawns). */
export function isQuestionnaireRun(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[QUESTIONNAIRE_ENV] === "1";
}

/** `dogfood.questionnaire: true` in ~/.membral/config.json. Off by default. */
export function questionnaireEnabled(configPath?: string): boolean {
  const d = loadCliConfig(configPath).dogfood;
  return !!d && typeof d === "object" && (d as Record<string, unknown>).questionnaire === true;
}

/** Fisher–Yates over the four ids. `rng` injected in tests. */
export function shuffleOrder(rng: () => number = Math.random): QuestionId[] {
  const out = [...QUESTION_IDS];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j] as QuestionId, out[i] as QuestionId];
  }
  return out;
}

/** Headers of the hook context this CLI injects (preamble, prompt recall, continuation). */
const INJECTED_HEADER_RE = /^(Membral memory for |Membral: |This session so far \(from Membral)/;
/** Lines of an injected block that are boilerplate, not content. */
const BOILERPLATE_RE =
  /^(recall_token:|Tools: |For recent sessions|Open a record's source: |These came from a memory_search|This folder is project |\s*↳ )/;

/**
 * The injected content lines in a Claude Code transcript: the
 * `hook_additional_context` attachments whose block starts with one of this
 * CLI's headers, minus the header and boilerplate lines, deduplicated, in
 * order. Pure; malformed lines are skipped.
 */
export function extractInjectedLines(transcriptText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of transcriptText.split("\n")) {
    if (!raw.includes("hook_additional_context")) continue;
    let row: unknown;
    try {
      row = JSON.parse(raw);
    } catch {
      continue;
    }
    const att = (row as { attachment?: { type?: unknown; content?: unknown } } | null)?.attachment;
    if (!att || att.type !== "hook_additional_context") continue;
    const blocks = Array.isArray(att.content) ? att.content : typeof att.content === "string" ? [att.content] : [];
    for (const block of blocks) {
      if (typeof block !== "string") continue;
      const lines = block.split("\n");
      if (!INJECTED_HEADER_RE.test(lines[0] ?? "")) continue;
      for (const line of lines.slice(1)) {
        const l = line.trim();
        if (!l || BOILERPLATE_RE.test(line) || seen.has(l)) continue;
        seen.add(l);
        out.push(l);
      }
    }
  }
  return out;
}

/** First sentence of every questionnaire prompt: the import side skips any transcript carrying it. */
export const QUESTIONNAIRE_PROMPT_HEAD =
  "Before this session closes, answer four questions about the lines that were injected into it as context";

/**
 * argv for the fork. Never persisted (`--no-session-persistence`), no tools
 * (`--tools ""`), no MCP servers (`--strict-mcp-config` with no
 * `--mcp-config`), one turn. The prompt goes on stdin.
 */
export function questionnaireClaudeArgs(sessionId: string): string[] {
  return [
    "-p",
    "--resume",
    sessionId,
    "--fork-session",
    "--no-session-persistence",
    "--tools",
    "",
    // Load none of the user, project or local settings files (mirrors claude-code-provider buildClaudeArgs).
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--model",
    QUESTIONNAIRE_MODEL,
    "--max-turns",
    "1",
    "--output-format",
    "json",
  ];
}

/** Pinned alias, the same sonnet alias the cloud's claude-code provider takes from MEMBRAL_MODEL=sonnet. */
export const QUESTIONNAIRE_MODEL = "sonnet";

/** Env names the fork may inherit: enough to find the user's login and session store, nothing else. */
const FORK_ENV_ALLOW = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "LANG",
  "TERM",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
]);

/** Variables that would send the fork's calls to a metered or other account; the fork refuses to run with any set. */
const FORK_ENV_REFUSE = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
];

/**
 * Why the fork must not run, or null. Refuses: inside a questionnaire run or
 * any nested child session, in a headless/SDK session (entrypoint other than
 * the interactive `cli`), and whenever the environment would bill an API key
 * or a cloud provider instead of the user's Claude login. Pure.
 */
export function questionnaireForkRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env[QUESTIONNAIRE_ENV] === "1") return "nested_questionnaire";
  if (env.CLAUDE_CODE_CHILD_SESSION) return "nested_session";
  const entry = env.CLAUDE_CODE_ENTRYPOINT;
  if (entry && entry !== "cli") return "headless_session";
  for (const k of FORK_ENV_REFUSE) if (env[k]) return `billing_env_${k.toLowerCase()}`;
  return null;
}

/** The fork's whole environment: the allowlist above plus the recursion guard. Pure. */
export function buildQuestionnaireEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (FORK_ENV_ALLOW.has(k) || k.startsWith("LC_")) out[k] = v;
  out[QUESTIONNAIRE_ENV] = "1";
  return out;
}

/** The repo path the Claude Code parser reads from the transcript's own events; undefined when absent or unparsable. */
function transcriptRepoPath(sessionId: string, transcriptPath: string, text: string): string | undefined {
  try {
    const session = claudeCodeParser.parse(
      { source: "claude-code", sourceSessionId: sessionId, path: transcriptPath },
      text,
    );
    return session.repo.path || undefined;
  } catch {
    return undefined;
  }
}

/**
 * True when a parsed transcript is a questionnaire fork (belt and braces with
 * `--no-session-persistence`): its LAST user prose turn starts with the
 * questionnaire prompt and at most one assistant prose turn follows it. A
 * genuine session that merely pasted the prompt earlier, or kept working after
 * it, is not a fork and uploads. Pure.
 */
export function isQuestionnaireSession(session: {
  turns: ReadonlyArray<{ role: string; kind: string; text?: string }>;
}): boolean {
  const turns = session.turns;
  let last = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i] as (typeof turns)[number];
    if (t.role === "user" && t.kind === "prose") {
      last = i;
      break;
    }
  }
  if (last < 0 || !(turns[last]?.text ?? "").trimStart().startsWith(QUESTIONNAIRE_PROMPT_HEAD)) return false;
  return turns.slice(last + 1).filter((t) => t.role === "assistant" && t.kind === "prose").length <= 1;
}

/** The prompt the fork answers. Lists the injected lines, then the questions in `order`. Pure. */
export function buildQuestionnairePrompt(order: readonly QuestionId[], injected: readonly string[]): string {
  return [
    `${QUESTIONNAIRE_PROMPT_HEAD} (at session start or when a prompt was sent). Answer only from what happened in this session; do not run any tools.`,
    "",
    "The injected lines:",
    ...injected.map((l, i) => `${i + 1}. ${l}`),
    "",
    "Questions:",
    ...order.map((q) => `${q}. ${QUESTIONS[q]}`),
    "",
    'For every item: "line" is the injected line copied exactly as listed above (without its number); "turn" is a verbatim excerpt of at least a few words copied from the message in this session the item points at; for q4 also give "worked_out", what you worked out in your own words from that turn. An item without a "turn" is discarded. Leave a list empty when nothing applies.',
    "",
    'Reply with ONLY a JSON object of the exact shape {"q1": [...], "q2": [...], "q3": [...], "q4": [...]} where each item is {"line": "...", "turn": "...", "worked_out": "..."} (worked_out only for q4) — no markdown, no commentary, no code fence.',
  ].join("\n");
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, MAX_TEXT) : null);

/**
 * Validates the fork's answer: null when it is not an object of four lists;
 * otherwise each item without a `line` or a turn pointer of at least
 * MIN_TURN_POINTER_CHARS is dropped alone. Pure.
 */
export function parseAnswers(raw: unknown): QuestionnaireAnswers | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (!QUESTION_IDS.some((q) => q in r)) return null;
  const out: QuestionnaireAnswers = { q1: [], q2: [], q3: [], q4: [] };
  for (const q of QUESTION_IDS) {
    const list = r[q];
    if (list === undefined) continue;
    if (!Array.isArray(list)) return null;
    for (const el of list) {
      if (!el || typeof el !== "object" || out[q].length >= MAX_ITEMS) continue;
      const e = el as Record<string, unknown>;
      const line = str(e.line);
      const turn = str(e.turn);
      if (!line || !turn || turn.length < MIN_TURN_POINTER_CHARS) continue;
      const worked = str(e.worked_out);
      out[q].push({ line, turn, ...(worked ? { worked_out: worked } : {}) });
    }
  }
  return out;
}

/** `claude -p --output-format json` stdout -> the answer object, or null. Pure. */
export function parseClaudeOutput(stdout: string): unknown {
  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  const e = envelope as { is_error?: unknown; result?: unknown } | null;
  if (!e || e.is_error === true || typeof e.result !== "string") return null;
  const body = e.result
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

/** The real reason a run stored nothing: no output (e.g. --resume found no session), an error envelope, or a malformed reply. Pure. */
export function diagnoseNoAnswer(stdout: string): string {
  const t = stdout.trim();
  if (!t) return "error claude no_output (session not resumable from this cwd?)";
  try {
    const e = JSON.parse(t) as { is_error?: unknown; result?: unknown } | null;
    if (e && e.is_error === true) {
      const msg = typeof e.result === "string" ? e.result.replace(/\s+/g, " ").slice(0, 80) : "unknown";
      return `error claude ${msg}`;
    }
  } catch {
    return "error claude unparsable_output";
  }
  return "malformed answer — nothing stored";
}

export type ClaudeRunner = (
  args: string[],
  input: string,
  cwd: string | undefined,
  timeoutMs: number,
) => Promise<string>;

/** Runs `claude` with an allowlisted env and the recursion guard set; kills it at the timeout. */
export const defaultClaudeRunner: ClaudeRunner = (args, input, cwd, timeoutMs) =>
  new Promise((resolve, reject) => {
    const env = buildQuestionnaireEnv(process.env);
    const child = spawn("claude", args, { cwd, env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    let out = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      resolve(out);
    });
    child.stdin.end(input);
  });

export interface QuestionnaireChildOptions {
  sessionId: string;
  transcriptPath: string;
  cwd?: string;
  apiUrl?: string;
  apiKey?: string;
  hookLogPath: string;
  /** Tests. */
  runClaude?: ClaudeRunner;
  client?: ApiClient;
  rng?: () => number;
  timeoutMs?: number;
  /** ~/.membral/sync.json (tests). */
  syncAllowlistPath?: string;
  /** The environment the refusal check reads (tests); default process.env. */
  env?: NodeJS.ProcessEnv;
}

function logLine(path: string, reason: string, session: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({ ts: new Date().toISOString(), hook: "questionnaire", reason, session })}\n`,
    );
  } catch {
    // best effort
  }
}

/**
 * The detached child: injected lines -> fork -> validate -> upload. Logs one
 * hook.log line (`hook: "questionnaire"`) and returns that reason. Never throws.
 */
export async function runQuestionnaireChild(opts: QuestionnaireChildOptions): Promise<string> {
  const reason = await (async (): Promise<string> => {
    const refusal = questionnaireForkRefusal(opts.env ?? process.env);
    if (refusal) return `skipped ${refusal}`;
    let text: string;
    try {
      text = readFileSync(opts.transcriptPath, "utf8");
    } catch {
      return "skipped unreadable_transcript";
    }
    const injected = extractInjectedLines(text);
    if (injected.length === 0) return "skipped no_injected_lines";
    // The allowlist must not fail open: check the hook's cwd and the transcript's own repo path; with neither, skip.
    const dirs = [opts.cwd, transcriptRepoPath(opts.sessionId, opts.transcriptPath, text)].filter(
      (d): d is string => typeof d === "string" && d.length > 0,
    );
    if (dirs.length === 0) return "skipped no_cwd";
    const allow = loadSyncAllowlist(opts.syncAllowlistPath);
    if (dirs.some((d) => !isProjectEnabled(allow, "claude-code", d))) return "skipped project_disabled";
    const order = shuffleOrder(opts.rng);
    let stdout: string;
    try {
      stdout = await (opts.runClaude ?? defaultClaudeRunner)(
        questionnaireClaudeArgs(opts.sessionId),
        buildQuestionnairePrompt(order, injected),
        opts.cwd,
        opts.timeoutMs ?? QUESTIONNAIRE_TIMEOUT_MS,
      );
    } catch (err) {
      return `error claude ${err instanceof Error ? err.message : String(err)}`;
    }
    const answers = parseAnswers(parseClaudeOutput(stdout));
    if (!answers) return diagnoseNoAnswer(stdout);
    const client =
      opts.client ??
      createUploadClient(resolveUploadConfig({ apiUrl: opts.apiUrl, apiKey: opts.apiKey }), { log: () => {} });
    const result = await client.call<unknown>("questionnaire", {
      json: { session: opts.sessionId, harness: "claude-code", order, answers },
    });
    const items = QUESTION_IDS.reduce((n, q) => n + answers[q].length, 0);
    if (result.ok) return `stored ${items} item(s) order ${order.join(",")}`;
    // An older server has no route: say nothing anywhere but this log.
    if (result.kind === "http" && result.status === 404) return "skipped server_has_no_route";
    return `upload failed ${result.kind}`;
  })().catch((err: unknown) => `error ${err instanceof Error ? err.message : String(err)}`);
  logLine(opts.hookLogPath, reason, opts.sessionId);
  return reason;
}
