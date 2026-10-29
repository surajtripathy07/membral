// `membral preamble --hook` — invoked directly BY Claude Code as a
// SessionStart hook command (P4, memory-on-prod-new-user goal;
// install-session-hook.ts's configureSessionStartHook writes the entry that
// runs this, mirroring configureSessionEndHook / session-end-hook.ts).
// Reads the hook's JSON off stdin, fetches GET /api/memory/preamble from
// the cloud, and prints Claude Code's SessionStart hook output shape so the
// returned lines are injected as additional context at the start of the
// session.
//
// Verified against the Claude Code hooks reference (code.claude.com/docs/
// en/hooks): SessionStart's stdin JSON has `session_id`, `cwd`,
// `hook_event_name`, `source` (`"startup" | "resume" | "clear" |
// "compact"`); its "add context" output shape is
// `{"hookSpecificOutput":{"hookEventName":"SessionStart",
// "additionalContext":"..."}}` printed to stdout.
//
// `--format copilot` (W6): the same preamble for GitHub Copilot CLI's
// sessionStart hook (~/.copilot/hooks/membral.json, copilot-cli-hooks.ts).
// Its stdin is camelCase (`sessionId`, `timestamp`, `cwd`, `source`) and it
// injects context from a flat `{"additionalContext":"..."}` on stdout. Only
// `cwd` is read, and it has the same name in both shapes.
//
// `--format text` (W9): the plain preamble body on stdout, nothing on empty or
// failure. The opencode plugin (opencode-integration.ts) spawns it and pushes
// the text onto the system prompt itself; stdin is `{cwd, session_id}`.
//
// NON-NEGOTIABLE (mirrors session-end-hook.ts): this must ALWAYS resolve,
// never throw, and never block or slow down session start. A hard
// PREAMBLE_HOOK_TIMEOUT_MS timeout bounds the network call. ANY failure —
// no credentials, network error, non-2xx, malformed/invalid JSON — prints
// NOTHING (Claude Code just starts with no injected context) and stays
// silent on stderr unless MEMBRAL_DEBUG=1.
//
// SELF-RECALL (Claude Code format only): when SessionStart's `source` is
// `compact` or `resume`, the session is being continued, so the hook adds
// `self=<source>` and the route also returns `self_lines`: "This session so
// far (from Membral)" -- the session's own decisions, outcomes and findings
// (apps/cloud lib/memory/self-recall.ts), injected ahead of the preamble. The
// store has them only once the session was uploaded and extracted (about 20
// minutes or more after it ran), so a session continued sooner gets none. One
// `preamble: self-recall …` line goes to hook.log either way.
import {
  appendFileSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createUploadClient, resolveUploadConfig } from "./code-session-upload.js";
import { resolveGitBranch, resolveGitRemote } from "./git-remote.js";
import type { ApiClient } from "./lib/api-client.js";
import { resetInjectedIds } from "./prompt-recall-state.js";
import { isQuestionnaireRun } from "./questionnaire.js";

// 20s (temporary, 2026-09-25): production answered in ~2-3s from a client far from the function region (functions iad1, DB Singapore) and
// a real repo took 18s (sequential DB round trips iad1 -> Singapore); lower
// this once the preamble route is fast. Old 3s silently dropped the preamble.
// Claude Code allows SessionStart hooks 60s.
export const PREAMBLE_HOOK_TIMEOUT_MS = 20_000;
// The route already caps its own `lines` at 13 by construction (see
// apps/cloud's preamble.ts header comment -- line 2 is the always-on routing
// line added 2026-09-25), but this is a second, independent cap — the hook
// must never inject an unbounded amount of context even if the server-side
// contract ever changes.
export const MAX_INJECTED_LINES = 13;
// P10 review finding m5: the server Zod-caps `text` at 500 for extraction
// and truncates quotes, but corrections/pins may not go through that same
// cap — this is a second, independent, cheap per-line ceiling so one
// oversized line can't blow up the injected context.
export const MAX_LINE_CHARS = 300;
/** Self-recall lines: header, at most six records (the route's cap) and the footer; their own cap, beside MAX_INJECTED_LINES. */
export const MAX_SELF_LINES = 8;
/** A self-recall line carries a record's full text plus ref and link, as prompt-recall lines do (prompt-hook.ts MAX_PROMPT_LINE_CHARS). */
export const MAX_SELF_LINE_CHARS = 720;
/**
 * The session's handoff note (`handoff_text`), shown whole up to this many characters: a ceiling above the server's
 * largest inject budget (4,800, resume), so a well-formed note is never cut here; its own cap, not squeezed through
 * MAX_SELF_LINES. A longer string (a misbehaving server) is cut with an ellipsis.
 */
export const MAX_HANDOFF_TEXT_CHARS = 6_000;
/**
 * One budget for the whole injected context (handoff, preamble lines and self-recall lines together): Claude Code
 * caps hook `additionalContext` near 10,000 characters and spills or drops anything longer, so stay under it.
 * Filled in priority order: handoff, then preamble lines, then self-recall lines.
 */
export const MAX_RESUME_CONTEXT_CHARS = 9_500;
/** A line cut to fit the remaining budget must keep at least this many characters to be worth showing. */
const MIN_USEFUL_LINE_CHARS = 80;

/**
 * Packs the parts into `budget` characters (newline-joined) in priority order: handoff, preamble lines, self lines.
 * A part that does not fit whole is cut with an ellipsis when enough room remains, and ends that part's turn.
 * The result keeps the display order: handoff, self lines, preamble lines.
 */
export function fitContextBudget(
  handoff: string | null,
  lines: string[],
  selfLines: string[],
  budget: number = MAX_RESUME_CONTEXT_CHARS,
): string {
  let used = 0;
  const take = (parts: string[]): string[] => {
    const out: string[] = [];
    for (const part of parts) {
      const room = budget - used - (used > 0 ? 1 : 0);
      if (part.length <= room) {
        out.push(part);
        used += part.length + (used > 0 ? 1 : 0);
        continue;
      }
      if (room >= MIN_USEFUL_LINE_CHARS) {
        out.push(`${part.slice(0, room - 1)}…`);
        used = budget;
      }
      break;
    }
    return out;
  };
  const fittedHandoff = take(handoff ? [handoff] : []);
  const fittedLines = take(lines);
  const fittedSelf = take(selfLines);
  return [...fittedHandoff, ...fittedSelf, ...fittedLines].join("\n");
}

/**
 * Antigravity (agy) fires PreInvocation on every model call, not once per conversation, so its
 * preamble is served once: the first call per conversation id claims a marker file and serves,
 * later calls print nothing and make no request. Its 5 s hook timeout (configure.ts) bounds the
 * budget, so agy's network budget is clamped below it.
 * Follow-up, not built: PreInvocation carries no prompt text; per-prompt recall for agy would read
 * the last user step from `transcriptPath`.
 */
export const AGY_PREAMBLE_TIMEOUT_MS = 4_000;
export const AGY_PREAMBLE_TIMEOUT_MAX_MS = 4_500;
/** A "claiming" marker older than this belongs to a hook that was killed before it finished; it is re-claimed. */
export const AGY_CLAIM_STALE_MS = 10_000;
/** When this process started, so stdin wait and git lookups count against the agy budget. */
const PROCESS_START_MS = Date.now() - process.uptime() * 1000;

/** The agy network budget: the requested value (default 4 s) clamped to 4.5 s, minus time already spent. */
export function agyTimeoutMs(requestedMs: number | undefined, elapsedMs = 0): number {
  return Math.min(requestedMs ?? AGY_PREAMBLE_TIMEOUT_MS, AGY_PREAMBLE_TIMEOUT_MAX_MS) - Math.max(0, elapsedMs);
}
const AGY_MARKER_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Same id rule as session-end-hook.ts (agyTranscript): the id names a file under hook-state/agy/.
const SAFE_CONVERSATION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface SessionStartHookInput {
  session_id?: string;
  cwd?: string;
  source?: string;
}

/** Copilot CLI's camelCase sessionStart payload (timestamp is unix ms). */
export interface CopilotSessionStartHookInput {
  sessionId?: string;
  timestamp?: number;
  cwd?: string;
  source?: string;
}

export interface AgyPreInvocationHookInput {
  conversationId?: string;
  workspacePaths?: string[];
  transcriptPath?: string;
  modelName?: string;
}

/** Which host's hook protocol to speak: Claude Code's (default), Copilot CLI's, or `text` (plain body, for the opencode plugin). */
export type PreambleHookFormat = "claude-code" | "copilot" | "text" | "agy";

export interface PreambleHookOptions {
  /** Injected in tests; defaults to process.env (the MEMBRAL_QUESTIONNAIRE recursion guard). */
  env?: NodeJS.ProcessEnv;
  apiUrl?: string;
  apiKey?: string;
  /** Injected in tests; defaults to the real process stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Injected in tests to avoid a real 3s wait. */
  timeoutMs?: number;
  /** Injected in tests; defaults to 2s. */
  stdinDeadlineMs?: number;
  /** Injected in tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** `--format copilot`: Copilot CLI's stdin/stdout shapes. Defaults to Claude Code's. */
  format?: PreambleHookFormat;
  /** A policy client to use (tests); default: one built from the resolved config with this hook's budget. */
  client?: ApiClient;
  /** Injected in tests; defaults to ~/.membral/hook.log (the env-key fallback line goes there, never stdout). */
  hookLogPath?: string;
  /** Injected in tests; defaults to ~/.membral/hook-state/agy (the once-per-conversation markers). */
  agyStateDir?: string;
  /** Injected in tests; defaults to this process's start time. */
  startedAtMs?: number;
}

/**
 * Marker for `conversationId` under `dir`: "claimed" (we serve), "taken" (served, or another call is in
 * flight), or "open" (could not create it: serve anyway). The file holds "claiming" until the preamble is
 * written, then "served"; a "claiming" file older than AGY_CLAIM_STALE_MS was left by a killed hook.
 */
function claimAgyMarker(dir: string, conversationId: string, hookLogPath: string): "claimed" | "taken" | "open" {
  const path = join(dir, conversationId);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(path, "claiming", { flag: "wx", mode: 0o600 });
        return "claimed";
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") throw err;
        if (!isStaleMarker(path)) return "taken";
        // Atomic takeover: only one caller's rename of the stale file succeeds.
        const moved = `${path}.stale.${process.pid}`;
        try {
          renameSync(path, moved);
        } catch {
          return "taken"; // someone else took it over (or it vanished): stay silent
        }
        if (!isStaleMarker(moved)) {
          // We moved a fresh marker (another caller re-claimed between our check and rename): put it back.
          try {
            linkSync(moved, path);
          } catch {
            // already re-created; the other claim stands
          }
          try {
            unlinkSync(moved);
          } catch {
            // ignore
          }
          return "taken";
        }
        try {
          unlinkSync(moved);
        } catch {
          // ignore
        }
      }
    }
    return "taken";
  } catch (err) {
    appendPreambleHookLog(
      hookLogPath,
      `preamble: agy marker unavailable (${(err as NodeJS.ErrnoException)?.code ?? "error"}) — serving`,
    );
    return "open";
  }
}

/** A marker left by a killed hook: anything but "served" (empty, "claiming", with or without a newline), and older than AGY_CLAIM_STALE_MS. */
function isStaleMarker(path: string): boolean {
  try {
    const content = readFileSync(path, "utf8");
    return content.trim() !== "served" && Date.now() - statSync(path).mtimeMs > AGY_CLAIM_STALE_MS;
  } catch {
    return false;
  }
}

function markAgyServed(dir: string, conversationId: string): void {
  try {
    writeFileSync(join(dir, conversationId), "served", { mode: 0o600 });
  } catch {
    // the "claiming" marker goes stale and is re-claimed; at worst one repeat
  }
}

function releaseAgyMarker(dir: string, conversationId: string): void {
  try {
    unlinkSync(join(dir, conversationId));
  } catch {
    // best effort
  }
}

/** Drops markers older than 7 days; one pass per call, errors ignored. */
function pruneAgyMarkers(dir: string): void {
  try {
    const cutoff = Date.now() - AGY_MARKER_MAX_AGE_MS;
    for (const name of readdirSync(dir)) {
      if (name.includes(".stale.")) continue;
      try {
        if (statSync(join(dir, name)).mtimeMs < cutoff) unlinkSync(join(dir, name));
      } catch {
        // ignore this entry
      }
    }
  } catch {
    // ignore
  }
}

/** One JSON line in hook.log for the client's env-key fallback; best effort, never throws. */
function appendPreambleHookLog(path: string, line: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(
      path,
      `${JSON.stringify({ ts: new Date().toISOString(), hook: "preamble", reason: line })}\n`,
      "utf8",
    );
  } catch {
    // never the reason the hook fails
  }
}

interface PreambleResponse {
  lines: string[];
  /** Present only when the request carried `self=`. */
  self_lines?: unknown;
  self_skipped?: unknown;
  /** Present on resume/compact when the session has a handoff note; absent from servers that predate it. */
  handoff_text?: unknown;
  recall_token: string;
  open_blockers: unknown[];
}

// Manual validation, not a Zod schema: packages/cli has no zod dependency
// today (only apps/cloud does) and this brief's scope forbids adding new
// dependencies — this type guard is the dependency-free equivalent for the
// one shape this hook actually reads (`lines`; `recall_token`/
// `open_blockers` are checked for shape but not otherwise used here).
function isPreambleResponse(v: unknown): v is PreambleResponse {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    Array.isArray(r.lines) &&
    r.lines.every((l) => typeof l === "string") &&
    typeof r.recall_token === "string" &&
    Array.isArray(r.open_blockers)
  );
}

export async function preambleHook(opts: PreambleHookOptions = {}): Promise<void> {
  // Recursion guard (questionnaire.ts): the session-end questionnaire's forked claude gets nothing injected.
  if (isQuestionnaireRun(opts.env)) return;
  try {
    await preambleHookInner(opts);
  } catch (err) {
    // Belt-and-suspenders: preambleHookInner already guards every step, but
    // nothing here may ever propagate to the caller or print anything.
    debug(`unexpected error: ${errMessage(err)}`);
  }
}

async function preambleHookInner(opts: PreambleHookOptions): Promise<void> {
  const raw = await readStdin(opts.stdin ?? process.stdin, opts.stdinDeadlineMs ?? STDIN_DEADLINE_MS);
  if (!raw.trim()) {
    debug("no stdin input received — skipping");
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    debug(`malformed hook JSON on stdin: ${errMessage(err)} — skipping`);
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    debug("hook input is not a JSON object — skipping");
    return;
  }
  // `cwd` is the only field read, and both hosts name it the same.
  const input = parsed as SessionStartHookInput & CopilotSessionStartHookInput & AgyPreInvocationHookInput;
  if ("workspacePaths" in input && Array.isArray(input.workspacePaths) && input.workspacePaths.length > 0) {
    input.cwd = input.workspacePaths[0];
  }
  if (input.cwd !== undefined && typeof input.cwd !== "string") {
    debug("hook input cwd is not a string — skipping");
    return;
  }

  // DEDUPE RESET: after `/compact` or `/clear` the records prompt-hook injected are gone from the context, so the
  // session may be served them again. Local disk only: done before the credentials and network steps.
  const startSource = (input as { source?: unknown }).source;
  const startSessionId = (input as { session_id?: unknown }).session_id;
  if (
    (opts.format ?? "claude-code") === "claude-code" &&
    (startSource === "compact" || startSource === "clear") &&
    typeof startSessionId === "string" &&
    startSessionId.length > 0 &&
    startSessionId.length <= 200
  ) {
    resetInjectedIds(opts.hookLogPath ?? join(homedir(), ".membral", "hook.log"), startSessionId);
  }

  // Same shared credential resolver every other command uses (flags > env >
  // ~/.membral/credentials.json > default URL, no default key) — see
  // credentials.ts's header comment (issue #136).
  const config = resolveUploadConfig({ apiUrl: opts.apiUrl, apiKey: opts.apiKey });
  if (!config.apiKey) {
    debug("no API key available — skipping");
    return;
  }

  // Same repo-identity derivation as the SessionEnd capture path
  // (import-session.ts): resolve the raw `origin` remote URL locally by
  // reading .git/config (no shell-out); the cloud's normalizeRepoIdentity
  // falls back to path identity when there's no remote, so cwd is a valid
  // fallback here too.
  const remote = await resolveGitRemote(input.cwd);
  const branch = await resolveGitBranch(input.cwd);
  const repo = remote ?? input.cwd;
  if (!repo) {
    debug("no repo identity (no git remote, no cwd) — skipping");
    return;
  }

  const params = new URLSearchParams({ repo });
  if (branch) params.set("branch", branch);
  // #361: the harness session id lets the cloud tie this preamble's recall
  // event to the session once its transcript is imported. Optional: the
  // route ignores a missing or malformed value.
  // Copilot CLI sends camelCase `sessionId`, the same id its parser stores.
  // agy sends `conversationId` (its transcript directory name); safe-id checked like agyTranscript.
  const ids = input as { session_id?: unknown; sessionId?: unknown; conversationId?: unknown };
  const isAgy = opts.format === "agy";
  const agyConversationId =
    isAgy &&
    typeof ids.conversationId === "string" &&
    ids.conversationId.length <= 200 &&
    SAFE_CONVERSATION_ID_RE.test(ids.conversationId) &&
    !ids.conversationId.includes("..")
      ? ids.conversationId
      : undefined;
  if (isAgy && !agyConversationId) {
    // agy always sends a conversationId; without a usable one there is no once-guard, so serve nothing.
    debug("agy payload has no usable conversationId — skipping");
    return;
  }
  const sessionId = ids.sessionId ?? ids.session_id ?? agyConversationId;
  if (typeof sessionId === "string" && sessionId.length > 0 && sessionId.length <= 200) {
    params.set("session", sessionId);
  }
  // SELF-RECALL: Claude Code's own source values; Copilot's and the text format's are not asked.
  const source = (input as { source?: unknown }).source;
  const selfSource =
    (opts.format ?? "claude-code") === "claude-code" &&
    (source === "compact" || source === "resume") &&
    params.has("session")
      ? source
      : null;
  if (selfSource) {
    params.set("self", selfSource);
    params.set("line_max", String(MAX_SELF_LINE_CHARS));
    // Capability flag: this CLI shows `handoff_text`. The server serves (and logs) a handoff note only when it is set.
    params.set("handoff", "1");
  }

  // Design note §4: one budget for the whole call, fallback included —
  // startBy = abortAt = start + timeout. The signal stays attached through
  // the body read (P10 m1), inside the client.
  const timeoutMs = isAgy
    ? agyTimeoutMs(opts.timeoutMs, Date.now() - (opts.startedAtMs ?? PROCESS_START_MS))
    : (opts.timeoutMs ?? PREAMBLE_HOOK_TIMEOUT_MS);
  if (isAgy && timeoutMs <= 0) {
    debug("agy budget already spent — skipping");
    return;
  }
  const deadline = Date.now() + timeoutMs;
  const hookLogPath = opts.hookLogPath ?? join(homedir(), ".membral", "hook.log");
  // agy: claim the conversation's marker BEFORE the call so concurrent PreInvocations race safely.
  const agyDir = opts.agyStateDir ?? join(homedir(), ".membral", "hook-state", "agy");
  let claimed = false;
  if (agyConversationId) {
    pruneAgyMarkers(agyDir);
    const claim = claimAgyMarker(agyDir, agyConversationId, hookLogPath);
    if (claim === "taken") {
      debug("agy conversation already served — skipping");
      return;
    }
    claimed = claim === "claimed";
  }
  let served = false;
  try {
    const client =
      opts.client ??
      createUploadClient(config, {
        log: (line) => appendPreambleHookLog(hookLogPath, line),
        startBy: deadline,
        abortAt: deadline,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    {
      const started = Date.now();
      const result = await client.call<unknown>("preamble", { query: params });
      const ms = Date.now() - started;
      if (!result.ok) {
        debug(`preamble request failed (${result.kind}${"status" in result ? ` ${result.status}` : ""}) — skipping`);
        if (selfSource) appendPreambleHookLog(hookLogPath, `preamble: self-recall ${selfSource} failed ${result.kind}`);
        return;
      }
      const body = result.data;
      const selfLines = isPreambleResponse(body) ? selfRecallLines(body) : [];
      if (selfSource) {
        const skipped = isPreambleResponse(body) && typeof body.self_skipped === "string" ? body.self_skipped : "none";
        const outcome =
          selfLines.length > 0 ? `served ${selfLines.length} lines` : /^[a-z_]{1,40}$/.test(skipped) ? skipped : "none";
        appendPreambleHookLog(hookLogPath, `preamble: self-recall ${selfSource} ${outcome} in ${ms} ms`);
      }
      const handoff = isPreambleResponse(body) ? handoffText(body) : null;
      if (!isPreambleResponse(body) || (body.lines.length === 0 && selfLines.length === 0 && !handoff)) {
        debug("response failed validation — skipping");
        return;
      }

      const lines = body.lines
        .slice(0, MAX_INJECTED_LINES)
        .map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS - 1)}…` : l));
      // The handoff note is this session's own summary: it covers the self-recall records, so those lines are dropped.
      const context = fitContextBudget(handoff, lines, handoff ? [] : selfLines);
      if (opts.format === "text") {
        process.stdout.write(`${context}\n`);
        return;
      }
      process.stdout.write(`${JSON.stringify(buildHookOutput(context, opts.format))}\n`);
      served = true;
      if (claimed && agyConversationId) markAgyServed(agyDir, agyConversationId);
    }
  } finally {
    // A call that served nothing (failure, empty body, throw) must not suppress later retries.
    if (claimed && !served && agyConversationId) releaseAgyMarker(agyDir, agyConversationId);
  }
}

/** The response's `handoff_text`: a non-blank string, capped at MAX_HANDOFF_TEXT_CHARS; null when absent or not a string. */
function handoffText(body: PreambleResponse): string | null {
  if (typeof body.handoff_text !== "string" || body.handoff_text.trim().length === 0) return null;
  const t = body.handoff_text.trim();
  return t.length > MAX_HANDOFF_TEXT_CHARS ? `${t.slice(0, MAX_HANDOFF_TEXT_CHARS - 1)}…` : t;
}

/** The response's `self_lines`, string-checked and capped (MAX_SELF_LINES, MAX_SELF_LINE_CHARS); [] when absent. */
function selfRecallLines(body: PreambleResponse): string[] {
  if (!Array.isArray(body.self_lines) || !body.self_lines.every((l) => typeof l === "string")) return [];
  return (body.self_lines as string[])
    .slice(0, MAX_SELF_LINES)
    .map((l) => (l.length > MAX_SELF_LINE_CHARS ? `${l.slice(0, MAX_SELF_LINE_CHARS - 1)}…` : l));
}

/** The stdout JSON each host reads injected context from. */
export function buildHookOutput(additionalContext: string, format: PreambleHookFormat = "claude-code"): unknown {
  if (format === "agy") return { injectSteps: [{ ephemeralMessage: additionalContext }] };
  if (format === "copilot") return { additionalContext };
  return {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
}

/** If stdin has not closed by then, proceed with whatever was read. */
const STDIN_DEADLINE_MS = 2_000;

/** Reads a hook payload off stdin; resolves with what arrived by `deadlineMs`, never rejects. Shared with prompt-hook.ts. */
export function readStdin(stream: NodeJS.ReadableStream, deadlineMs: number): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(data);
    }, deadlineMs);
    deadline.unref?.();
    try {
      stream.setEncoding?.("utf8");
    } catch {
      // ignore — not all streams support setEncoding
    }
    stream.on("data", (chunk) => {
      data += chunk;
    });
    stream.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(data);
    });
    stream.on("error", () => {
      // A stdin read error degrades to "no input" — never throws, matching
      // this hook's never-block contract.
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(data);
    });
  });
}

function debug(message: string): void {
  if (process.env.MEMBRAL_DEBUG === "1") {
    console.error(`membral preamble --hook: ${message}`);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
