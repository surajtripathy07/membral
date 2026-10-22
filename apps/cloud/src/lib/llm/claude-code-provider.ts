// Harness-login LLM provider (`claude-code`), local only (W7 D7, D-072;
// docs/design/w7-one-command-local.md §8).
//
// MEMBRAL_LLM_PROVIDER=claude-code makes LlmClient.callJson run the user's own
// `claude` CLI for one turn with tools off instead of an HTTP API. It is active
// only on a local stack (MEMBRAL_LOCAL=1, never on Vercel) with a
// `claude setup-token` token in CLAUDE_CODE_OAUTH_TOKEN; otherwise it fails
// closed and never falls back to a paid key. Calls are subscription use and
// are recorded at $0 under a `claude-code/<alias>` model label.
//
// The system prompt is written to a file in the temp dir (--system-prompt-file) so it cannot hit the argv size limit; stdout and stderr are capped at 4 MiB each.
//
// Isolation: cwd and HOME are a fresh empty temp dir, CLAUDE_CONFIG_DIR sits
// inside it, no setting sources or MCP servers are loaded, and the child's env
// is an allowlist (no other CLAUDE_CODE_* vars, no API keys). The prompt goes
// on stdin, never argv. The token is never logged.
//
// This module only runs the CLI and reports what happened; client.ts maps a
// rate/usage limit to the same error as an HTTP 429 and a timeout to the
// SDK's timeout error, so callers' existing backoff and classification apply.

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { log } from "../log";

export const CLAUDE_CODE_PROVIDER = "claude-code" as const;
/** Model-label prefix recorded in the spend ledger; every label has an explicit $0 CHAT_PRICING entry. */
export const CLAUDE_CODE_MODEL_PREFIX = "claude-code/";
/** Label used when MEMBRAL_MODEL is unset: `--model` is not passed and the CLI picks its own default. */
export const CLAUDE_CODE_DEFAULT_MODEL = `${CLAUDE_CODE_MODEL_PREFIX}default`;
export const DEFAULT_CLAUDE_CODE_TIMEOUT_MS = 120_000;
/** Cap on each of the child's stdout and stderr; past it the child is killed and the call errors. */
export const CLAUDE_CODE_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

type Env = Record<string, string | undefined>;

export type ClaudeCodeActivation = { ok: true } | { ok: false; reason: string };

/**
 * Whether the claude-code provider may run in this environment. Checked when
 * the config resolves and again before every call. Never includes the token
 * in `reason`.
 */
export const CLAUDE_CODE_UNAVAILABLE_REASON =
  "Claude Code could not be downloaded from npm on this start; retry with `docker restart membral-app-1`.";

export function claudeCodeActivation(env: Env = process.env): ClaudeCodeActivation {
  if (env.VERCEL) {
    return { ok: false, reason: "MEMBRAL_LLM_PROVIDER=claude-code is local only and refuses to run on Vercel." };
  }
  if (env.MEMBRAL_LOCAL !== "1") {
    return { ok: false, reason: "MEMBRAL_LLM_PROVIDER=claude-code needs MEMBRAL_LOCAL=1 (local stack only)." };
  }
  if (!env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) {
    return {
      ok: false,
      reason: "MEMBRAL_LLM_PROVIDER=claude-code needs CLAUDE_CODE_OAUTH_TOKEN (run `claude setup-token`).",
    };
  }
  // Set by the image's entrypoint when the first-start npm download of Claude Code failed
  // (apps/cloud/docker/claude-cli/install.sh); without it every call would fail on a missing binary.
  if (env.MEMBRAL_CLAUDE_UNAVAILABLE === "1") {
    return { ok: false, reason: CLAUDE_CODE_UNAVAILABLE_REASON };
  }
  return { ok: true };
}

/** The `claude-code/<alias>` label for MEMBRAL_MODEL (or the default label when unset). */
export function claudeCodeModelLabel(env: Env = process.env): string {
  const m = env.MEMBRAL_MODEL?.trim();
  if (!m) return CLAUDE_CODE_DEFAULT_MODEL;
  return m.startsWith(CLAUDE_CODE_MODEL_PREFIX) ? m : `${CLAUDE_CODE_MODEL_PREFIX}${m}`;
}

/** The `--model` value for a label, or undefined for the default label. */
export function cliModelFor(label: string): string | undefined {
  const alias = label.startsWith(CLAUDE_CODE_MODEL_PREFIX) ? label.slice(CLAUDE_CODE_MODEL_PREFIX.length) : label;
  return alias && alias !== "default" ? alias : undefined;
}

export function claudeCodeTimeoutMs(env: Env = process.env): number {
  const n = Number(env.MEMBRAL_CLAUDE_TIMEOUT_MS?.trim());
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CLAUDE_CODE_TIMEOUT_MS;
}

/**
 * argv for one call. The user prompt is NOT here (stdin). The system prompt is
 * passed as a file path (`--system-prompt-file`), never inline, so its size
 * cannot exceed the OS argv limit.
 */
export function buildClaudeArgs(systemPromptFile: string, cliModel: string | undefined): string[] {
  return [
    "-p",
    "--output-format",
    "json",
    // `claude --help` (2.1.288): 'Use "" to disable all tools'. With no tools the run is one turn.
    "--tools",
    "",
    // Load none of the user, project or local settings files.
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--system-prompt-file",
    systemPromptFile,
    ...(cliModel ? ["--model", cliModel] : []),
  ];
}

/** The child's whole environment: an allowlist, nothing else from the parent. */
export function buildClaudeEnv(tempDir: string, env: Env = process.env): Record<string, string> {
  const out: Record<string, string> = {
    PATH: env.PATH ?? "",
    HOME: tempDir,
    CLAUDE_CONFIG_DIR: join(tempDir, ".claude"),
    CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ?? "",
    DISABLE_AUTOUPDATER: "1",
  };
  if (env.LANG) out.LANG = env.LANG;
  return out;
}

export type ClaudeCodeResult =
  | { kind: "ok"; text: string; tokensIn: number; tokensOut: number; actualModel?: string }
  | { kind: "rate_limited" }
  | { kind: "auth_failed" }
  | { kind: "timeout"; timeoutMs: number }
  | { kind: "refused"; reason: string }
  | { kind: "error"; exitCode: number | null; reason?: string };

/** Usage/rate-limit wording the CLI prints ("Claude AI usage limit reached", "5-hour limit reached", "API Error: 429 ..."). */
const LIMIT_RE = /usage limit|rate[ _-]?limit|limit reached|\b429\b|too many requests|overloaded/i;
/** Auth wording. Seen live on 2.1.288 with no token: exit 0, is_error true, result "Not logged in · Please run /login". */
const AUTH_RE =
  /not logged in|\/login|setup-token|invalid api key|oauth token|authentication|unauthori[sz]ed|\b401\b|\b403\b/i;
/** A terminal_reason that is not a normal completion ("api_error" seen live). */
const ABNORMAL_TERMINAL_RE = /error|fail|abort|timeout|limit|refus|cancel/i;

interface Envelope {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  terminal_reason?: unknown;
  api_error_status?: unknown;
  result?: unknown;
  modelUsage?: Record<string, unknown>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** Parses the CLI's `--output-format json` envelope and classifies it. Exported for tests. */
export function interpretClaudeOutput(stdout: string, stderr: string, exitCode: number | null): ClaudeCodeResult {
  let env: Envelope | null = null;
  try {
    const parsed = JSON.parse(stdout.trim()) as unknown;
    // Some CLI versions print an array of events; the last `result` entry is the envelope.
    if (Array.isArray(parsed)) {
      env = ([...parsed].reverse().find((e) => e && (e as Envelope).type === "result") as Envelope) ?? null;
    } else if (parsed && typeof parsed === "object") {
      env = parsed as Envelope;
    }
  } catch {
    env = null;
  }
  const resultText = typeof env?.result === "string" ? env.result : "";
  // The CLI can exit 0 with subtype "success" and still have failed (is_error true), so
  // is_error and terminal_reason are checked on their own, not only the exit code.
  const terminal = typeof env?.terminal_reason === "string" ? env.terminal_reason : "";
  const failed =
    exitCode !== 0 ||
    env?.is_error === true ||
    ABNORMAL_TERMINAL_RE.test(terminal) ||
    (env?.subtype !== undefined && env.subtype !== "success");
  if (failed) {
    if (env?.api_error_status === 429 || LIMIT_RE.test(resultText) || LIMIT_RE.test(stderr)) {
      return { kind: "rate_limited" };
    }
    if (
      env?.api_error_status === 401 ||
      env?.api_error_status === 403 ||
      AUTH_RE.test(resultText) ||
      AUTH_RE.test(stderr)
    ) {
      return { kind: "auth_failed" };
    }
    return { kind: "error", exitCode };
  }
  if (!env) return { kind: "error", exitCode };
  const u = env.usage ?? {};
  return {
    kind: "ok",
    text: resultText,
    tokensIn: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens),
    tokensOut: num(u.output_tokens),
    ...(actualModelOf(env) ? { actualModel: actualModelOf(env) } : {}),
  };
}

/** The model the CLI actually used: the modelUsage key with the most output tokens, if any. */
function actualModelOf(env: Envelope): string | undefined {
  const entries = Object.entries(env.modelUsage ?? {}).filter(([k]) => /^[\w.:@/-]{1,100}$/.test(k));
  if (entries.length === 0) return undefined;
  const out = (v: unknown) => num((v as { outputTokens?: unknown } | null)?.outputTokens);
  return entries.reduce((best, cur) => (out(cur[1]) > out(best[1]) ? cur : best))[0];
}

/**
 * Pulls the model's JSON answer out of the result text: the text itself, a
 * fenced ```json block, or the span from the first `{` to the last `}`.
 * Returns the trimmed text unchanged when none applies, so JSON.parse fails
 * on it and the caller's existing parse-failure path runs.
 */
export function extractJsonText(text: string): string {
  const t = text.trim();
  if (!t || t.startsWith("{") || t.startsWith("[")) return t;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence?.[1]?.trim()) return fence[1].trim();
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  return start >= 0 && end > start ? t.slice(start, end + 1) : t;
}

// Concurrency 1: one claude child at a time per process.
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

/**
 * Runs one `claude -p` turn. Re-checks activation against the live process
 * env first (hosted refusal at call time, not only at resolve time). Never
 * throws for a CLI failure; returns a classified result instead.
 */
export function runClaudeCode(
  opts: { systemPrompt: string; userPrompt: string; model: string },
  env: Env = process.env,
): Promise<ClaudeCodeResult> {
  return serialize(async () => {
    const r = await runOnce(opts, env);
    // client.ts maps every `error` to one generic provider error, so the reason is logged here.
    if (r.kind === "error" && r.reason) log.warn("claude-code call failed", { reason: r.reason });
    return r;
  });
}

async function runOnce(
  opts: { systemPrompt: string; userPrompt: string; model: string },
  env: Env,
): Promise<ClaudeCodeResult> {
  const active = claudeCodeActivation(env);
  if (!active.ok) return { kind: "refused", reason: active.reason };
  const bin = env.MEMBRAL_CLAUDE_BIN?.trim() || "claude";
  const timeoutMs = claudeCodeTimeoutMs(env);
  let tempDir: string;
  try {
    tempDir = await mkdtemp(join(tmpdir(), "membral-claude-"));
  } catch {
    return { kind: "error", exitCode: null, reason: "could not create the temp dir for the claude call" };
  }
  try {
    const systemPromptFile = join(tempDir, "system-prompt.txt");
    try {
      await writeFile(systemPromptFile, opts.systemPrompt, { mode: 0o600 });
    } catch {
      return { kind: "error", exitCode: null, reason: "could not write the system prompt file" };
    }
    return await new Promise<ClaudeCodeResult>((resolve) => {
      // Chunks stay as Buffers and are decoded once at close, so a multi-byte char split across chunks survives.
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let settled = false;
      const done = (r: ClaudeCodeResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(r);
      };
      const child = spawn(bin, buildClaudeArgs(systemPromptFile, cliModelFor(opts.model)), {
        cwd: tempDir,
        // Cast only for Next's ProcessEnv augmentation (required NODE_ENV); the allowlist is the whole env on purpose.
        env: buildClaudeEnv(tempDir, env) as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        done({ kind: "timeout", timeoutMs });
      }, timeoutMs);
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const overflow = () => {
        child.kill("SIGKILL");
        done({
          kind: "error",
          exitCode: null,
          reason: `claude output exceeded ${CLAUDE_CODE_MAX_OUTPUT_BYTES} bytes; child killed`,
        });
      };
      child.stdout?.on("data", (d: Buffer | string) => {
        if (settled) return;
        stdoutBytes += Buffer.byteLength(d);
        if (stdoutBytes > CLAUDE_CODE_MAX_OUTPUT_BYTES) return overflow();
        stdoutChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
      });
      child.stderr?.on("data", (d: Buffer | string) => {
        if (settled) return;
        stderrBytes += Buffer.byteLength(d);
        if (stderrBytes > CLAUDE_CODE_MAX_OUTPUT_BYTES) return overflow();
        stderrChunks.push(Buffer.isBuffer(d) ? d : Buffer.from(d));
      });
      // A missing binary (ENOENT) and other spawn failures land here.
      child.on("error", () => done({ kind: "error", exitCode: null, reason: "could not start the claude CLI" }));
      child.on("close", (code: number | null) =>
        done(
          interpretClaudeOutput(
            Buffer.concat(stdoutChunks).toString("utf8"),
            Buffer.concat(stderrChunks).toString("utf8"),
            code,
          ),
        ),
      );
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(opts.userPrompt);
    });
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
