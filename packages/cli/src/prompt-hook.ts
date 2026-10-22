// `membral prompt-hook` — invoked BY Claude Code as a UserPromptSubmit hook
// (docs/design/prompt-time-recall.md; configure.ts's
// configureUserPromptSubmitHook writes the entry). Reads the hook's JSON off
// stdin, sends the prompt to POST /api/memory/prompt-recall on the user's own
// Membral server, and prints the returned lines as UserPromptSubmit
// additionalContext, so past rulings about the very file or ref the prompt
// names reach the agent before it starts work.
//
// Verified against the Claude Code hooks reference (code.claude.com/docs/en/
// hooks): UserPromptSubmit's stdin JSON has `session_id`, `transcript_path`,
// `cwd`, `permission_mode`, `hook_event_name: "UserPromptSubmit"` and
// `prompt`; its "add context" output is
// `{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"..."}}`
// on stdout with exit 0.
//
// NON-NEGOTIABLE (as preamble-hook.ts): this runs before EVERY prompt, so it
// must never block, slow down or fail the prompt. One PROMPT_HOOK_TIMEOUT_MS
// budget covers the whole call; ANY failure — no credentials, network error,
// timeout, non-2xx, malformed JSON — prints NOTHING and stays silent on
// stderr unless MEMBRAL_DEBUG=1. Slash commands and prompts under
// MIN_PROMPT_WORDS words are never sent.
//
// OUTCOME LOG: every invocation appends exactly one `prompt-recall: …` line to
// ~/.membral/hook.log (served / the server's skip reason / timeout / http
// error, with the round-trip duration), so an empty injection always has a
// reason on disk. Never the prompt text, never the key.
//
// DEDUPE: the record ids a session's earlier prompts already injected are kept in a per-session file
// (prompt-recall-state.ts) and sent as `exclude_record_ids`. The server caps to its top records FIRST, then leaves out
// the already-sent ones WITHOUT refilling their slots (lower ranks were judged not worth showing): the rest print as
// usual plus one "Also relevant, shown earlier this session: …" pointer line, and when all were sent it answers empty
// (skipped "already_sent"). The ids stored are the response's record_ids (fresh only).
// Written only after the output was printed; any state problem reads as "nothing injected yet".
//
// CONTINUATION: a prompt that starts with CONTINUATION_PREFIX (Claude Code's
// compaction summary, auto or `/compact`) is not searched as a topic. The hook
// takes the continued session's id from the summary's transcript path (else
// the hook's own session_id, the same-session compact case) and sends
// `continuation: {source_session_id, harness: "claude-code"}`; the route then
// serves that session's own records first (apps/cloud lib/memory/self-recall.ts).
// Only the summary's next-step/pending/current-work text leaves the machine
// (continuationFocusText, at most CONTINUATION_FOCUS_MAX_CHARS), as the
// topic fallback's query. The log line reads `prompt-recall: continuation …`.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createUploadClient, resolveUploadConfig } from "./code-session-upload.js";
import { resolveGitRemote } from "./git-remote.js";
import type { ApiClient } from "./lib/api-client.js";
import { readStdin } from "./preamble-hook.js";
import { appendInjectedIds, readInjectedIds } from "./prompt-recall-state.js";
import { isQuestionnaireRun } from "./questionnaire.js";

/**
 * The whole call, fallback included. The server answers empty past its own 1.5 s first search, and its second hop and
 * follow-up read stop by about 3.5 s.
 */
export const PROMPT_HOOK_TIMEOUT_MS = 4_000;
/**
 * Header, at most five record lines (the route's cap) each with an optional `  ↳ later that session` line, the
 * re-search note and the open-a-session footer; a second, independent cap.
 */
export const MAX_PROMPT_LINES = 13;
/** Matches the route's PROMPT_RECALL_MIN_WORDS. */
export const MIN_PROMPT_WORDS = 4;
/** The prompt is cut to this before it is sent: the route searches only its first 2,000 chars, so no more leaves the machine. */
export const MAX_PROMPT_CHARS = 2_000;
/**
 * Prompt-recall lines carry a record's full text (≤ 500 chars) plus its prefix, ref and URL, so they get a wider cut
 * than the preamble's MAX_LINE_CHARS. Matches the route's PROMPT_RECALL_LINE_MAX_CHARS.
 */
export const MAX_PROMPT_LINE_CHARS = 720;
const STDIN_DEADLINE_MS = 1_000;

/** How Claude Code opens the first user message after compaction (auto or `/compact`), verbatim. */
export const CONTINUATION_PREFIX =
  "This session is being continued from a previous conversation that ran out of context.";
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** The summary's own pointer: "…read the full transcript at: <dir>/<uuid>.jsonl". */
const TRANSCRIPT_POINTER_RE = new RegExp(`full transcript at:\\s*\\S*?(${UUID})\\.jsonl`, "gi");
const SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,200}$/;

/** True when the prompt is Claude Code's compaction summary. Pure. */
export function isContinuationPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith(CONTINUATION_PREFIX);
}

/**
 * The continued session's id: the uuid in the summary's "full transcript at:" path (the transcript that holds the
 * pre-compaction work), else `fallback` (the hook's own session_id: a same-session compaction names no other). Paths
 * named elsewhere in the summary are NOT used: a summary of work on transcripts names other sessions'. Null when
 * none is id-shaped. Pure.
 */
export function continuationSessionId(prompt: string, fallback?: string | null): string | null {
  // Claude Code's own pointer is the LAST one; an earlier quoted pointer in the body must not win.
  const pointers = [...prompt.matchAll(TRANSCRIPT_POINTER_RE)];
  if (pointers.length > 0) return pointers[pointers.length - 1][1].toLowerCase();
  return typeof fallback === "string" && SESSION_ID_RE.test(fallback) ? fallback : null;
}

/** Matches the route's CONTINUATION_FOCUS_MAX_CHARS (apps/cloud lib/memory/self-recall.ts). */
export const CONTINUATION_FOCUS_MAX_CHARS = 800;
const HEADING_RE =
  /^(?:\d+[.)]\s+([A-Z][^\n]{0,80}?):\s*$|#{1,6}\s+([^\n]{1,80}?)\s*:?\s*$|\*\*([^*\n]{1,80}?):?\*\*:?\s*$)/;
const FOCUS_TITLES: readonly RegExp[] = [/\bnext\b/i, /\bpending\b/i, /\bcurrent work\b/i];
const TRAILER_RE = /full transcript at:|^continue the conversation from where it left off/i;

/**
 * The summary text sent as the topic fallback's query: the "next step", "pending" and "current work" section bodies,
 * in that order, cut to CONTINUATION_FOCUS_MAX_CHARS; with none, the last CONTINUATION_FOCUS_MAX_CHARS characters
 * before Claude Code's closing instructions. Mirrors the route's continuationFocusText (the route re-applies it; it is
 * idempotent on its own output). Pure.
 */
export function continuationFocusText(summary: string): string {
  const lines = summary.split(/\r?\n/);
  // The harness's closing instructions sit at the END; an earlier quoted pointer in the body must not cut it short.
  const lastIndex = (re: RegExp) => {
    for (let i = lines.length - 1; i >= 0; i--) if (re.test(lines[i].trim())) return i;
    return -1;
  };
  const pointerAt = lastIndex(/full transcript at:/i);
  const end = pointerAt >= 0 ? pointerAt : lastIndex(TRAILER_RE);
  const body = end >= 0 ? lines.slice(0, end) : lines;
  const sections: { title: string; text: string[] }[] = [];
  let cur: { title: string; text: string[] } | null = null;
  for (const line of body) {
    const m = HEADING_RE.exec(line);
    if (m) {
      cur = { title: (m[1] ?? m[2] ?? m[3] ?? "").trim(), text: [] };
      sections.push(cur);
    } else if (cur) {
      cur.text.push(line);
    }
  }
  const picked: string[] = [];
  for (const title of FOCUS_TITLES) {
    // The LAST non-empty matching section: a summary can quote an earlier one in its body.
    for (let i = sections.length - 1; i >= 0; i--) {
      if (!title.test(sections[i].title)) continue;
      const text = sections[i].text.join("\n").trim();
      if (!text) continue;
      if (!picked.includes(text)) picked.push(text);
      break;
    }
  }
  if (picked.length > 0) return picked.join("\n").slice(0, CONTINUATION_FOCUS_MAX_CHARS).trim();
  return body.join("\n").trim().slice(-CONTINUATION_FOCUS_MAX_CHARS).trim();
}

export interface UserPromptSubmitHookInput {
  session_id?: string;
  cwd?: string;
  prompt?: string;
  hook_event_name?: string;
}

export interface PromptHookOptions {
  /** Injected in tests; defaults to process.env (the MEMBRAL_QUESTIONNAIRE recursion guard). */
  env?: NodeJS.ProcessEnv;
  apiUrl?: string;
  apiKey?: string;
  stdin?: NodeJS.ReadableStream;
  timeoutMs?: number;
  stdinDeadlineMs?: number;
  fetchImpl?: typeof fetch;
  client?: ApiClient;
  hookLogPath?: string;
  /** Injected in tests; defaults to process.stdout.write. */
  write?: (s: string) => void;
}

/** Why a prompt is not sent: a slash command or fewer than MIN_PROMPT_WORDS words. Pure. */
export function promptSkipReason(prompt: string): "slash_command" | "short_prompt" | null {
  const p = prompt.trim();
  if (p.startsWith("/")) return "slash_command";
  if (p.split(/\s+/).filter(Boolean).length < MIN_PROMPT_WORDS) return "short_prompt";
  return null;
}

/** The stdout JSON Claude Code reads UserPromptSubmit context from. */
export function buildPromptHookOutput(additionalContext: string): unknown {
  return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext } };
}

// Manual validation, as preamble-hook.ts: packages/cli has no zod dependency.
function isPromptRecallResponse(
  v: unknown,
): v is { lines: string[]; record_ids?: unknown; skipped?: unknown; mode?: unknown; self_skipped?: unknown } {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return Array.isArray(r.lines) && r.lines.every((l) => typeof l === "string");
}

/** The route's footer line (lib/memory/prompt-recall.ts PROMPT_RECALL_FOOTER_PREFIX); not a record. */
const PROMPT_RECALL_FOOTER_PREFIX = "Open a record's source: get_code_session ";
/** The route's re-search note and follow-up lines (PROMPT_RECALL_RESEARCH_NOTE, PROMPT_RECALL_FOLLOW_UP_PREFIX); not records. */
const PROMPT_RECALL_NOT_RECORD_PREFIXES = [
  PROMPT_RECALL_FOOTER_PREFIX,
  "These came from a memory_search on this prompt",
  // The route's already-sent pointer (PROMPT_RECALL_ALREADY_SENT_PREFIX): names records this session already has.
  "Also relevant, shown earlier this session: ",
  "  ↳ ",
];

/** A server skip reason is logged only when it is a short snake_case token, never free text. */
const SKIP_REASON_RE = /^[a-z_]{1,40}$/;

function appendHookLog(path: string, line: string, session?: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    // `session` (recall-precision W3b): lets the upload fold outcomes per session (hook-outcomes.ts).
    const row = { ts: new Date().toISOString(), hook: "prompt", reason: line, ...(session ? { session } : {}) };
    appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
  } catch {
    // never the reason the hook fails
  }
}

export async function promptHook(opts: PromptHookOptions = {}): Promise<void> {
  // Recursion guard (questionnaire.ts): the session-end questionnaire's forked claude gets nothing injected.
  if (isQuestionnaireRun(opts.env)) return;
  const hookLogPath = opts.hookLogPath ?? join(homedir(), ".membral", "hook.log");
  let outcome = "prompt-recall: error unexpected";
  const seen: { session?: string } = {};
  try {
    outcome = await promptHookInner(opts, hookLogPath, seen);
  } catch (err) {
    debug(`unexpected error: ${err instanceof Error ? err.message : String(err)}`);
  }
  appendHookLog(hookLogPath, outcome, seen.session);
}

/** Runs the hook and returns its one outcome line for hook.log. */
async function promptHookInner(
  opts: PromptHookOptions,
  hookLogPath: string,
  seen: { session?: string } = {},
): Promise<string> {
  // The budget starts now: stdin, the git read and the request all fit inside it.
  const budgetMs = opts.timeoutMs ?? PROMPT_HOOK_TIMEOUT_MS;
  const hookStart = Date.now();
  const deadline = hookStart + budgetMs;
  const raw = await readStdin(opts.stdin ?? process.stdin, opts.stdinDeadlineMs ?? STDIN_DEADLINE_MS);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    debug("no or malformed hook JSON on stdin — skipping");
    return "prompt-recall: skipped bad_input";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "prompt-recall: skipped bad_input";
  const input = parsed as UserPromptSubmitHookInput;
  if (typeof input.session_id === "string" && input.session_id.length > 0 && input.session_id.length <= 200) {
    seen.session = input.session_id;
  }
  if (typeof input.prompt !== "string") {
    debug("hook input has no prompt — skipping");
    return "prompt-recall: skipped no_prompt";
  }
  const continuation = isContinuationPrompt(input.prompt);
  const continuedId = continuation ? continuationSessionId(input.prompt, input.session_id) : null;
  const tag = continuation ? "prompt-recall: continuation" : "prompt-recall:";
  const skip = continuation ? (continuedId ? null : "no_session_id") : promptSkipReason(input.prompt);
  if (skip) {
    debug(`${skip} — skipping`);
    return `${tag} skipped ${skip}`;
  }
  if (input.cwd !== undefined && typeof input.cwd !== "string") return "prompt-recall: skipped bad_input";

  const config = resolveUploadConfig({ apiUrl: opts.apiUrl, apiKey: opts.apiKey });
  if (!config.apiKey) {
    debug("no API key available — skipping");
    return "prompt-recall: skipped no_api_key";
  }
  const repo = (await resolveGitRemote(input.cwd)) ?? input.cwd;
  if (!repo) {
    debug("no repo identity — skipping");
    return "prompt-recall: skipped no_repo";
  }

  // budget_ms tells the route this client waits PROMPT_HOOK_TIMEOUT_MS and shows MAX_PROMPT_LINES: without it the
  // route answers in the legacy 5-line shape an older CLI expects.
  const json: Record<string, unknown> = {
    // A continuation sends only its next-step text (the topic fallback's query), never the whole summary.
    prompt: continuation ? continuationFocusText(input.prompt) : input.prompt.slice(0, MAX_PROMPT_CHARS),
    repo,
    // The route accepts 500..10,000.
    budget_ms: Math.min(Math.max(Math.round(budgetMs), 500), 10_000),
    // The longest line this CLI shows whole: the route fits lines to it (an older CLI sends none and gets 420).
    line_max: MAX_PROMPT_LINE_CHARS,
  };
  if (typeof input.session_id === "string" && input.session_id.length > 0 && input.session_id.length <= 200) {
    json.session = input.session_id;
  }
  // A new CLI against an old server: the unknown field is stripped by the route's zod object, as today's answer.
  const sessionKey =
    typeof input.session_id === "string" && input.session_id.length > 0 && input.session_id.length <= 200
      ? input.session_id
      : null;
  const alreadyInjected = sessionKey ? readInjectedIds(hookLogPath, sessionKey) : [];
  if (alreadyInjected.length > 0) json.exclude_record_ids = alreadyInjected;
  if (continuedId) json.continuation = { source_session_id: continuedId, harness: "claude-code" };

  const client =
    opts.client ??
    createUploadClient(config, {
      log: (line) => appendHookLog(hookLogPath, line),
      startBy: deadline,
      abortAt: deadline,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  const started = Date.now();
  const result = await client.call<unknown>("promptRecall", { json, startBy: deadline, abortAt: deadline });
  const ms = Date.now() - started;
  if (!result.ok) {
    debug(`prompt-recall request failed (${result.kind}) — skipping`);
    // `timeout`: the request went out and the per-attempt timeout cut it. `deferred`: the hook's deadline came first,
    // either mid-request (sent=true) or before any request started (sent=false: stdin or the git read used the budget).
    // Both elapsed values run from hook start, not from the request.
    if (result.kind === "timeout") {
      return `${tag} timeout in ${Date.now() - hookStart} ms (request sent, no response)`;
    }
    if (result.kind === "deferred") {
      return `${tag} deferred after ${Date.now() - hookStart} ms (budget ${budgetMs} ms, sent=${result.sent})`;
    }
    if (result.kind === "http" || result.kind === "auth" || result.kind === "bad_json") {
      return `${tag} http ${result.status} in ${ms} ms`;
    }
    if (result.kind === "rate_limited") return `${tag} http 429 in ${ms} ms`;
    return `${tag} network error in ${ms} ms`;
  }
  if (!isPromptRecallResponse(result.data)) {
    debug("malformed prompt-recall response");
    return `${tag} bad_response in ${ms} ms`;
  }
  const data = result.data;
  if (data.lines.length === 0) {
    debug("nothing to inject");
    const reason = typeof data.skipped === "string" && SKIP_REASON_RE.test(data.skipped) ? data.skipped : "no_match";
    const selfNote =
      typeof data.self_skipped === "string" && SKIP_REASON_RE.test(data.self_skipped) && data.self_skipped !== reason
        ? ` (self ${data.self_skipped})`
        : "";
    return `${tag} ${reason}${selfNote} in ${ms} ms`;
  }
  const context = data.lines
    .slice(0, MAX_PROMPT_LINES)
    .map((l) => (l.length > MAX_PROMPT_LINE_CHARS ? `${l.slice(0, MAX_PROMPT_LINE_CHARS - 1)}…` : l))
    .join("\n");
  (opts.write ?? ((s: string) => process.stdout.write(s)))(`${JSON.stringify(buildPromptHookOutput(context))}\n`);
  if (sessionKey && Array.isArray(data.record_ids)) {
    appendInjectedIds(
      hookLogPath,
      sessionKey,
      data.record_ids.filter((i): i is string => typeof i === "string"),
    );
  }
  // Without record_ids: lines minus the header, the follow-up lines, the re-search note and the footer.
  const notRecords = data.lines.filter((l) => PROMPT_RECALL_NOT_RECORD_PREFIXES.some((p) => l.startsWith(p))).length;
  const served =
    Array.isArray(data.record_ids) && data.record_ids.length > 0
      ? data.record_ids.length
      : Math.max(data.lines.length - 1 - notRecords, 0);
  const selfNote =
    typeof data.self_skipped === "string" && SKIP_REASON_RE.test(data.self_skipped)
      ? ` (self ${data.self_skipped})`
      : "";
  return `${tag} served ${served} record${served === 1 ? "" : "s"}${selfNote} in ${ms} ms`;
}

function debug(message: string): void {
  if (process.env.MEMBRAL_DEBUG === "1") console.error(`membral prompt-hook: ${message}`);
}
