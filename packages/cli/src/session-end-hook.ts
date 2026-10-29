// `membral session-end-hook` — invoked directly BY Claude Code as a
// SessionEnd hook command (ADR 0021 Q1/P1b; `install-session-hook` writes
// the entry that runs this). Reads the hook's JSON off stdin, extracts
// `transcript_path`, and delegates the actual upload to `importSession`
// (import-session.ts) — no parsing/upload logic is duplicated here.
//
// Why SessionEnd is the closing upload: it fires once, when the session actually
// ends, and the one upload of a finished transcript is what queues paid memory
// extraction. Stop (`--stop`, see the Stop hook section at the bottom) fires after
// every turn group while the session is still open; it also uploads, but flagged
// `open`, so the server stores the turns without queueing extraction.
//
// Verified against the Claude Code hooks reference
// (https://code.claude.com/docs/en/hooks, fetched 2026-07-24): SessionEnd's
// stdin JSON has top-level fields `session_id`, `transcript_path`, `cwd`,
// `hook_event_name`, `reason` (why the session ended — `clear` | `resume` |
// `logout` | `prompt_input_exit` | `bypass_permissions_disabled` | `other`),
// and `permission_mode`. We only need `transcript_path`.
//
// CONTRACT (2026-07-26 capture-hardening pass): the periodic sweep
// (the launchd sweep script's `cmd_sweep`) is the PRIMARY capture path — it
// walks every transcript on a timer with a --since cursor and is resilient
// to this hook never running at all. This hook is demoted to an
// OPPORTUNISTIC ACCELERATOR: when it fires and succeeds, a session shows up
// sooner than the next sweep; when it doesn't fire, or fails, the sweep
// still catches the session within one interval. Its failures must
// therefore be silent on the terminal (a hook's stderr can surface directly
// in the user's interactive session) but never silent in aggregate — every
// invocation appends EXACTLY ONE JSON line to ~/.membral/hook.log (outcome:
// ok|skipped|error) so failures are diagnosable without MEMBRAL_DEBUG.
//
// NON-NEGOTIABLE (mirrors import-session.ts): this must ALWAYS resolve
// (never throw, never set a non-zero exit code) — a hook failing here must
// never block or interrupt Claude Code. Terminal output stays SILENT BY
// DEFAULT (nothing printed unless MEMBRAL_DEBUG=1); ~/.membral/hook.log is
// written unconditionally and is where real diagnosis happens. The upload
// itself is capped at HOOK_TIMEOUT_MS total — import-session's client
// already retries on its own, and a hook should never be the reason a
// session takes 30+ seconds to close out.
//
// 2026-07-26 adversarial-review fixes (capture-hardening B1/M1/M2 pass,
// round 2 hardening folded in):
//   - M1: runHook's body is wrapped so ANY throw (e.g. a malformed
//     `transcript_path` that isn't a string, which makes node:path's
//     `basename()` throw) still produces one `error` log line, not zero.
//   - M2/Minor3 (round 2): reason strings are sanitized before they're
//     written — the home directory is collapsed to `~`; any path wrapped in
//     a quote/bracket/angle-bracket delimiter is matched AS A DELIMITED
//     UNIT (not by whitespace) and collapsed to its basename, which is what
//     correctly handles a path containing SPACES (round 1's whitespace-only
//     token pass leaked everything after the first space); a bare
//     undelimited path with no spaces is still caught by the token
//     fallback. A captured upstream error message (import-session.ts
//     happily interpolates full paths) never leaks the user's directory
//     layout into hook.log.
//   - Minor1: a per-invocation `logged` flag guarantees exactly one line is
//     ever written even if the timeout race and a late-resolving runHook
//     both reach for the log at once; the timeout's own line carries the
//     transcript basename when it was already known before the timeout hit.
//   - Minor5/Note4 (round 2/3): a genuine stdin READ ERROR now logs a
//     distinct "stdin read error: ..." reason AND a distinct `error`
//     outcome (round 2 fixed the reason only; round 3 fixed the outcome
//     too) — it's no longer indistinguishable from a normal empty-stdin
//     no-op in either field.
//   - Minor1 (round 3): sanitizeLogReason's collapse-then-homedir ORDER was
//     backwards — see the comment above sanitizeLogReason itself for why
//     that leaked on the dominant real-world case (every transcript path is
//     home-rooted).
//
// Accepted risks (reviewed 2026-07-26, deliberately NOT fixed):
//   - The console.error monkey-patch inside importSessionSilently is
//     restored in a `finally`, so it cannot leak past a SINGLE invocation
//     of this hook — and this file only ever runs as a fresh, short-lived
//     `membral session-end-hook` process (never imported into a long-lived
//     one), so there is no "next call" for a stuck patch to affect. Would
//     matter if this function were ever imported into a persistent process.
//   - ~/.membral/hook.log has no rotation/cap. One line per SessionEnd
//     invocation is small and bounded, but over a very long-lived machine
//     this file only grows. Acceptable for now; revisit if it ever becomes
//     a real disk-usage complaint.
//
// `--source copilot-cli` (W6): the same hook for GitHub Copilot CLI's
// sessionEnd event (~/.copilot/hooks/membral.json, copilot-cli-hooks.ts).
// Its stdin is camelCase (`sessionId`, `timestamp`, `cwd`, `reason`) and
// carries no transcript path, so the path is derived from the session id:
// `${COPILOT_HOME:-~/.copilot}/session-state/<sessionId>/events.jsonl`. A
// `transcriptPath` (present on agentStop-shaped payloads) wins when given.
//
// Copilot CLI runs the sessionEnd hook BEFORE it finishes writing
// events.jsonl: `session.shutdown` (the only usage/cost source) always lands
// after the hook returns, and the tail can still be unflushed. So the hook
// only resolves the path, spawns a detached `--deferred-path` child of the
// same CLI entry, and exits 0. The child polls the file until a
// `session.shutdown` line appears (or DEFERRED_MAX_WAIT_MS passes), waits for
// the size to settle, then imports exactly as the hook used to and writes
// the one hook.log line (with `waited_ms` and `shutdown`).
//
// Deferred-child hardening: the parent stats the transcript at hook time and
// passes `--deferred-offset <bytes>`, so a RESUMED session's earlier
// `session.shutdown` never satisfies the wait (only lines at or after the
// offset count). The parent logs one `{outcome:"deferred"}` line before
// returning. VS Code's embedded engine (`copilotVersion` "0.0.0") never writes
// session.shutdown, so for it only the size-settle wait runs. An O_EXCL lock
// `<membral dir>/deferred/<sessionId>.lock` (stale after 10 min) keeps two
// children from uploading one session. The API key travels to the child via
// env `MEMBRAL_API_KEY`, never argv (visible in `ps`).
//
// Claude Code hand-off (#334): Claude Code gives SessionEnd hooks a shared
// 1.5 s budget on exit unless the entry sets `"timeout"`, and cancels the
// hook ("Hook cancelled") when it runs over, which any real upload does. So
// the Claude Code path also hands off: the hook reads stdin, checks the
// payload as before, spawns a detached `--deferred-path <transcript>` child
// (no `--source`), logs one `{outcome:"deferred"}` line and returns without
// any network I/O. The transcript is complete at SessionEnd, so the child
// imports at once (no shutdown wait, no offset) under the usual 30 s / 20 s
// caps, behind the same O_EXCL lock (`deferred/<sessionId>.lock`), and writes
// the outcome line. A failed spawn imports inline as before. If the child
// dies or fails, the sweep still picks the transcript up. Only an absolute
// transcript_path is handed off (a value starting with `--` would otherwise
// be read as a flag by the child). A resumed session (`claude -r`) that ends
// while an earlier child still holds the lock waits for it (up to
// CHILD_UPLOAD_BUDGET_MS), then imports, so its tail turns are not left to
// the sweep. A lock whose pid is dead is stale at once; a timed-out child
// removes its own lock before exiting.
import { spawn } from "node:child_process";
import { appendFile, mkdir, open, readdir, readFile, stat, unlink, utimes, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { agyInstallRoot } from "./detect.js";
import {
  agyConversationId,
  type ChildUploadSummary,
  type ImportSessionOptions,
  importSession,
  SUB_AGENT_WARN_PREFIX,
} from "./import-session.js";
import { defaultCopilotHome } from "./import-sessions.js";
import {
  isQuestionnaireRun,
  type QuestionnaireChildOptions,
  questionnaireEnabled,
  questionnaireForkRefusal,
  runQuestionnaireChild,
} from "./questionnaire.js";

export const HOOK_TIMEOUT_MS = 30_000;
/**
 * No new sub-agent upload starts after this much of the hook's run: the
 * parent always goes first, children run 3 at a time, and whatever is left
 * at ~20 s is deferred to the sweep so in-flight uploads can finish inside
 * the 30 s cap.
 */
export const CHILD_UPLOAD_BUDGET_MS = 20_000;
/** In-flight uploads are cut this long before the hook's own cap, so the hook still logs its line. */
export const UPLOAD_ABORT_HEADROOM_MS = 2_000;
/** A closing (SessionEnd) child waits for a Stop child's lock this long: the Stop cap plus a margin, so it is not abandoned. */
export const DEFERRED_LOCK_WAIT_MS = HOOK_TIMEOUT_MS + 5_000;

/**
 * The upload phase's two deadlines (design note §4), both anchored at `t0`,
 * the moment the upload phase starts: no new upload, retry or wait begins
 * after `childDeadlineAt` (t0 + 20 s); an in-flight upload is cut at
 * `uploadAbortAt` (t0 + hook timeout − 2 s, 28 s by default), never earlier
 * than `childDeadlineAt`.
 */
export function uploadDeadlines(
  opts: Pick<SessionEndHookOptions, "childBudgetMs" | "timeoutMs">,
  t0: number,
): { childDeadlineAt: number; uploadAbortAt: number } {
  const childDeadlineAt = t0 + (opts.childBudgetMs ?? CHILD_UPLOAD_BUDGET_MS);
  const uploadAbortAt = Math.max(childDeadlineAt, t0 + (opts.timeoutMs ?? HOOK_TIMEOUT_MS) - UPLOAD_ABORT_HEADROOM_MS);
  return { childDeadlineAt, uploadAbortAt };
}

/** Deferred Copilot import: poll interval for the `session.shutdown` line. */
export const DEFERRED_POLL_MS = 500;
/** Deferred Copilot import: give up waiting for `session.shutdown` and import anyway after this long. */
export const DEFERRED_MAX_WAIT_MS = 90_000;
/** Deferred Copilot import: the file size must hold still this long before the import. */
export const DEFERRED_STABLE_MS = 1_000;
/** Deferred Copilot import: cap on the size-settle wait after the shutdown wait. */
const DEFERRED_STABLE_CAP_MS = 10_000;
/** A deferred-upload lock older than this is treated as left by a dead child and taken over. */
export const DEFERRED_LOCK_STALE_MS = 10 * 60 * 1000;
/** `session.start` `copilotVersion` reported by VS Code's embedded engine, which never writes session.shutdown. */
const VSCODE_COPILOT_VERSION = "0.0.0";
/** Bytes read from the end of events.jsonl when looking for `session.shutdown`. */
const SHUTDOWN_TAIL_BYTES = 64 * 1024;

export const DEFAULT_HOOK_LOG_PATH = join(homedir(), ".membral", "hook.log");

export interface SessionEndHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  reason?: string;
  permission_mode?: string;
}

/** Copilot CLI's camelCase sessionEnd/agentStop payload (timestamp is unix ms). */
export interface CopilotSessionEndHookInput {
  sessionId?: string;
  timestamp?: number;
  cwd?: string;
  reason?: string;
  transcriptPath?: string;
}

/** Which host invoked the hook: Claude Code (default) or Copilot CLI. */
export type SessionEndHookSource = "claude-code" | "copilot-cli" | "agy";

// A Copilot session id names a directory under session-state/ — never let a
// payload walk out of it.
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The transcript a Copilot CLI hook payload points at: `transcriptPath`
 * when present, else `<copilotHome>/session-state/<sessionId>/events.jsonl`.
 * Undefined when neither is usable.
 */
export function copilotTranscriptPath(
  input: CopilotSessionEndHookInput,
  copilotHome: string = defaultCopilotHome(),
): string | undefined {
  // A payload path is trusted only inside <copilotHome>/session-state/ and
  // only as an events.jsonl; anything else falls through to the id.
  if (typeof input.transcriptPath === "string" && input.transcriptPath) {
    const stateDir = resolve(copilotHome, "session-state") + sep;
    const p = resolve(input.transcriptPath);
    if (p.startsWith(stateDir) && basename(p) === "events.jsonl") return input.transcriptPath;
  }
  const id = input.sessionId;
  if (typeof id !== "string" || !SAFE_SESSION_ID_RE.test(id) || id.includes("..")) return undefined;
  return join(copilotHome, "session-state", id, "events.jsonl");
}

export interface AgyHookInput {
  conversationId?: unknown;
  transcriptPath?: unknown;
}

/**
 * The transcript an Antigravity Stop payload points at, and its conversation id. A payload
 * `transcriptPath` counts only when it is absolute and is `<agyHome>/brain/<id>/.system_generated/
 * logs/transcript[_full].jsonl`; otherwise `conversationId` (a plain id, no separators) names the
 * directory. Either way the uncut `transcript_full.jsonl` is preferred when it exists, so a hook
 * upload and a sweep upload of one conversation carry the same bytes. Undefined when neither
 * yields a usable path.
 */
export async function agyTranscript(
  input: AgyHookInput,
  agyHome: string = agyInstallRoot(),
): Promise<{ path: string; id: string } | undefined> {
  const brain = resolve(agyHome, "brain") + sep;
  let id: string | undefined;
  if (typeof input.transcriptPath === "string" && isAbsolute(input.transcriptPath)) {
    const p = resolve(input.transcriptPath);
    const fromPath = agyConversationId(p);
    if (fromPath && p.startsWith(brain)) id = fromPath;
  }
  if (!id && typeof input.conversationId === "string") id = input.conversationId;
  if (!id || !SAFE_SESSION_ID_RE.test(id) || id.includes("..")) return undefined;
  const logs = join(agyHome, "brain", id, ".system_generated", "logs");
  for (const name of ["transcript_full.jsonl", "transcript.jsonl"]) {
    const path = join(logs, name);
    try {
      if ((await stat(path)).isFile()) return { path, id };
    } catch {
      // not on disk — try the display copy
    }
  }
  return undefined;
}

/** Only sessions touched this recently are candidates for the cwd fallback. */
const COPILOT_CWD_FALLBACK_WINDOW_MS = 6 * 60 * 60 * 1000;

/**
 * No usable sessionId: the newest (by mtime) events.jsonl modified in the last
 * 6 hours whose first `session.start` event's cwd equals `cwd`. Reads only the
 * first few lines of each candidate. Undefined when none match.
 */
export async function findCopilotSessionByCwd(
  cwd: string,
  copilotHome: string = defaultCopilotHome(),
  now: number = Date.now(),
): Promise<string | undefined> {
  const stateDir = join(copilotHome, "session-state");
  let ids: string[];
  try {
    ids = await readdir(stateDir);
  } catch {
    return undefined;
  }
  const candidates: { path: string; mtimeMs: number }[] = [];
  for (const id of ids) {
    const path = join(stateDir, id, "events.jsonl");
    try {
      const st = await stat(path);
      if (st.isFile() && now - st.mtimeMs <= COPILOT_CWD_FALLBACK_WINDOW_MS)
        candidates.push({ path, mtimeMs: st.mtimeMs });
    } catch {
      // no events.jsonl in this dir
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (const c of candidates) {
    if ((await firstSessionStartCwd(c.path)) === cwd) return c.path;
  }
  return undefined;
}

async function firstSessionStartCwd(path: string): Promise<string | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(16 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const lines = buf.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, 5);
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as { type?: unknown; data?: { context?: { cwd?: unknown } } };
        if (ev.type === "session.start") {
          const cwd = ev.data?.context?.cwd;
          return typeof cwd === "string" ? cwd : undefined;
        }
      } catch {
        // partial or non-JSON line (e.g. truncated by the read window)
      }
    }
  } catch {
    // unreadable candidate
  } finally {
    await fh?.close().catch(() => {});
  }
  return undefined;
}

export interface SessionEndHookOptions {
  /** `--source copilot-cli`: Copilot CLI's stdin shape and parser. Defaults to Claude Code. */
  source?: SessionEndHookSource;
  /** Injected in tests; defaults to ${COPILOT_HOME:-~/.copilot}. */
  copilotHome?: string;
  /** Injected in tests; defaults to ~/.gemini/antigravity-cli. */
  agyHome?: string;
  apiUrl?: string;
  apiKey?: string;
  /** Injected in tests; defaults to the real process stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Injected in tests to avoid a real 30s wait. */
  timeoutMs?: number;
  /** Injected in tests; defaults to ~/.membral/hook.log. */
  hookLogPath?: string;
  /** Injected in tests; defaults to CHILD_UPLOAD_BUDGET_MS. */
  childBudgetMs?: number;
  /**
   * `--deferred-path`: this process IS the detached child; stdin is skipped.
   * With `source: "copilot-cli"` it waits for `session.shutdown` in this
   * events.jsonl (which must resolve under <copilotHome>/session-state/), then
   * imports. Without a source it is a Claude Code transcript, imported at once.
   */
  deferredPath?: string;
  /**
   * `--deferred-offset` (child only): size of events.jsonl when the hook fired;
   * a `session.shutdown` counts only if it starts at or after this byte.
   */
  deferredOffset?: number;
  /**
   * Injected in tests; defaults to spawning a detached `--deferred-path` child
   * of this CLI. `env` carries secrets (MEMBRAL_API_KEY) that must stay off argv.
   */
  spawnDeferred?: (args: string[], env?: Record<string, string>) => void;
  /** Injected in tests; default DEFERRED_POLL_MS. */
  deferredPollMs?: number;
  /** Injected in tests; default DEFERRED_MAX_WAIT_MS. */
  deferredMaxWaitMs?: number;
  /** Injected in tests; default DEFERRED_STABLE_MS. */
  deferredStableMs?: number;
  /** Injected in tests; Claude Code child: how long to wait for another child's lock (default CHILD_UPLOAD_BUDGET_MS). */
  deferredLockWaitMs?: number;
  /** Injected in tests; how long a missing open ack keeps Stop uploads off (default STOP_DISABLE_MS). */
  stopDisableMs?: number;
  /**
   * `--questionnaire <session_id>` (child only, with `--deferred-path`): this
   * process IS the detached questionnaire child (questionnaire.ts).
   */
  questionnaireSession?: string;
  /** `--cwd` (questionnaire child): the session's cwd, where `claude --resume` finds it. */
  cwd?: string;
  /**
   * `--stop`: this process is Claude Code's Stop hook (fires after every turn group, session still
   * open). It hands a detached `--deferred-path` child the transcript so far and returns; see stopHook.
   */
  stop?: boolean;
  /** Injected in tests; default STOP_THROTTLE_MS. */
  stopThrottleMs?: number;
  /**
   * `--open` (child only, with `--deferred-path`): the Stop hook's child. The session is still running, so the
   * upload is flagged `open` (the server stores turns but queues no paid extraction), the deferred lock is taken
   * without waiting, and a held lock makes it exit silently (and clear the throttle stamp).
   */
  open?: boolean;
  /** Injected in tests; defaults to ~/.membral/config.json. */
  cliConfigPath?: string;
  /** Injected in tests; defaults to process.env (the MEMBRAL_QUESTIONNAIRE recursion guard). */
  env?: NodeJS.ProcessEnv;
  /** Injected in tests: the questionnaire child body. */
  runQuestionnaire?: (o: QuestionnaireChildOptions) => Promise<string>;
}

type HookOutcome = "ok" | "skipped" | "error" | "deferred";

// Guards against writing more than one hook.log line for a single
// invocation — both the timeout branch and runHook's own completion race to
// log, and only the first to reach `appendHookLogOnce` should win.
//
// Round 4 (Minor 4): this used to be a plain boolean flag, set to `true`
// SYNCHRONOUSLY before the write's `await` even started. That closed the
// "two lines" race (good) but opened a "zero lines" one: sessionEndHook's
// timeout branch awaited its OWN call to appendHookLogOnce, which — if
// runHook had already flipped the flag but not yet finished its write —
// returned immediately without anything to await, since there was no way
// to reach the OTHER caller's in-flight promise. sessionEndHook would then
// return, `index.ts` calls `process.exit(0)` right after, and the real
// in-flight write could be killed mid-flight: the flag said "handled" but
// zero bytes had landed. Storing the WRITE PROMISE itself (not just a
// boolean) fixes this — every caller, whichever one actually initiates the
// write, converges on awaiting the exact same promise, so sessionEndHook
// can never return before that one write actually finishes.
interface LogState {
  writePromise: Promise<void> | null;
}

// Filled in by runHookInner as soon as the transcript path is known (before
// the potentially-slow upload), so a timeout that fires mid-upload can still
// log which transcript it was working on.
interface KnownInfo {
  transcript?: string;
  /** Set once the parent upload finished — a timeout during child uploads then logs the parent's outcome. */
  parent?: ImportOutcome;
  /** A deferred child's lock file while held, so the timeout branch can remove it before process.exit. */
  lockPath?: string;
}

export async function sessionEndHook(opts: SessionEndHookOptions = {}): Promise<void> {
  if (opts.questionnaireSession !== undefined && opts.deferredPath !== undefined) {
    await (opts.runQuestionnaire ?? runQuestionnaireChild)({
      sessionId: opts.questionnaireSession,
      transcriptPath: opts.deferredPath,
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.apiUrl ? { apiUrl: opts.apiUrl } : {}),
      ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
      hookLogPath: opts.hookLogPath ?? DEFAULT_HOOK_LOG_PATH,
    });
    return;
  }
  // Recursion guard: the questionnaire's forked claude ends with its own
  // SessionEnd; it must neither upload nor ask again.
  if (isQuestionnaireRun(opts.env)) return;
  if (opts.stop && opts.deferredPath === undefined) return stopHook(opts);
  if (opts.source === "copilot-cli" && opts.deferredPath !== undefined) return deferredCopilotHook(opts);
  const body = opts.deferredPath !== undefined ? runClaudeChild : runHookInner;
  const logPath = opts.hookLogPath ?? DEFAULT_HOOK_LOG_PATH;
  // The Claude Code child may first wait for another child's lock; that wait gets its own headroom.
  const lockWaitMs = opts.deferredPath !== undefined ? lockWaitOf(opts) : 0;
  const timeoutMs = (opts.timeoutMs ?? HOOK_TIMEOUT_MS) + lockWaitMs;
  const logState: LogState = { writePromise: null };
  const known: KnownInfo = {};
  const t0 = Date.now();
  try {
    const timedOut = await withTimeout(runHook(body, opts, logPath, logState, known, t0), timeoutMs);
    if (timedOut) {
      // index.ts exits right after this returns, before the body's `finally` can unlink.
      await releaseLock(known);
      await appendHookLogOnce(
        logState,
        logPath,
        known.parent
          ? {
              outcome: known.parent.outcome,
              parent: known.parent.outcome,
              reason: joinReasons(
                known.parent.reason,
                `timed out after ${timeoutMs}ms during sub-agent uploads — the rest are left for the sweep`,
              ),
              transcript: known.transcript,
            }
          : { outcome: "error", reason: `timed out after ${timeoutMs}ms`, transcript: known.transcript },
      );
    }
  } catch (err) {
    // Last-resort belt-and-suspenders: runHook wraps its own errors (M1) and
    // withTimeout swallows promise rejections internally, so this should be
    // unreachable in practice. If it's ever hit anyway, the hook must still
    // leave exactly one line in hook.log, never zero.
    debug(`unexpected error: ${errMessage(err)}`);
    await appendHookLogOnce(logState, logPath, {
      outcome: "error",
      reason: `unexpected error: ${errMessage(err)}`,
      transcript: known.transcript,
    });
  }
}

// M1: wraps runHookInner so ANY throw from it — including one from a
// malformed hook payload that trips up code we don't otherwise validate
// (e.g. basename() on a non-string transcript_path) — still logs exactly
// one `error` entry instead of leaving hook.log silent for that invocation.
type HookBody = (
  opts: SessionEndHookOptions,
  logPath: string,
  logState: LogState,
  known: KnownInfo,
  /** Upload-phase start (see uploadDeadlines). */
  t0: number,
) => Promise<void>;

async function runHook(
  body: HookBody,
  opts: SessionEndHookOptions,
  logPath: string,
  logState: LogState,
  known: KnownInfo,
  t0: number,
): Promise<void> {
  try {
    await body(opts, logPath, logState, known, t0);
  } catch (err) {
    debug(`unexpected error: ${errMessage(err)}`);
    await appendHookLogOnce(logState, logPath, {
      outcome: "error",
      reason: `unexpected error: ${errMessage(err)}`,
      transcript: known.transcript,
    });
  }
}

async function runHookInner(
  opts: SessionEndHookOptions,
  logPath: string,
  logState: LogState,
  known: KnownInfo,
  t0: number,
): Promise<void> {
  const stdinResult = await readStdin(opts.stdin ?? process.stdin);
  if (stdinResult.errored) {
    // Round 2 (Minor 5) / Round 3 (Note 4): a genuine stdin READ ERROR used
    // to be indistinguishable from a normal empty-stdin no-op (both
    // resolved with whatever partial data had arrived, which is "" for a
    // stream that errors before any 'data' event) — both logged as
    // {outcome:"skipped", reason:"empty stdin"}. That's misleading on two
    // counts: the reason (fixed round 2) AND the outcome itself — this
    // isn't a normal no-op skip, something actually went wrong, so it's
    // classified "error" (round 3), not "skipped".
    debug(`stdin read error: ${stdinResult.errorMessage}`);
    await appendHookLogOnce(logState, logPath, {
      outcome: "error",
      reason: `stdin read error: ${stdinResult.errorMessage}`,
    });
    return;
  }

  if (!stdinResult.data.trim()) {
    debug("no stdin input received — skipping");
    await appendHookLogOnce(logState, logPath, { outcome: "skipped", reason: "empty stdin" });
    return;
  }

  let input: SessionEndHookInput;
  try {
    input = JSON.parse(stdinResult.data);
  } catch (err) {
    debug(`malformed hook JSON on stdin: ${errMessage(err)} — skipping`);
    await appendHookLogOnce(logState, logPath, {
      outcome: "skipped",
      reason: `malformed hook JSON: ${errMessage(err)}`,
    });
    return;
  }

  const copilot = opts.source === "copilot-cli";
  let transcriptPath: string | undefined;
  if (copilot) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      debug("hook input is not a JSON object — skipping");
      await appendHookLogOnce(logState, logPath, { outcome: "skipped", reason: "hook input is not a JSON object" });
      return;
    }
    const cin = input as CopilotSessionEndHookInput;
    transcriptPath = copilotTranscriptPath(cin, opts.copilotHome);
    if (!transcriptPath && typeof cin.cwd === "string" && cin.cwd) {
      transcriptPath = await findCopilotSessionByCwd(cin.cwd, opts.copilotHome);
    }
    if (!transcriptPath) {
      debug("hook input missing a usable sessionId/transcriptPath — skipping");
      await appendHookLogOnce(logState, logPath, { outcome: "skipped", reason: "missing sessionId" });
      return;
    }
    // The child writes the final hook.log line; only a failed spawn imports inline.
    if (await spawnDeferredImport(transcriptPath, opts, logPath)) {
      await appendHookLogOnce(logState, logPath, {
        outcome: "deferred",
        transcript: `${basename(dirname(transcriptPath))}/${basename(transcriptPath)}`,
      });
      return;
    }
  } else if (opts.source === "agy") {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      await appendHookLogOnce(logState, logPath, { outcome: "skipped", reason: "hook input is not a JSON object" });
      return;
    }
    const found = await agyTranscript(input as AgyHookInput, opts.agyHome);
    if (!found) {
      debug("hook input names no usable Antigravity transcript — skipping");
      await appendHookLogOnce(logState, logPath, { outcome: "skipped", reason: "missing transcriptPath" });
      return;
    }
    transcriptPath = found.path;
  } else {
    if (!input.transcript_path) {
      debug("hook input missing transcript_path — skipping");
      await appendHookLogOnce(logState, logPath, { outcome: "skipped", reason: "missing transcript_path" });
      return;
    }
    transcriptPath = input.transcript_path;
  }
  // The child gets the path as `--deferred-path <p>`; a relative or `--`-led
  // value is never a real Claude Code transcript and would misparse as a flag.
  // (isAbsolute throws on a non-string, which runHook logs as an error, as basename did.)
  if (!copilot && !isAbsolute(transcriptPath)) {
    debug("transcript_path is not absolute — skipping");
    await appendHookLogOnce(logState, logPath, { outcome: "skipped", reason: "transcript_path is not absolute" });
    return;
  }

  // Only the basename ever gets logged — never the full path, which would
  // otherwise leak the user's home-directory layout into a log file.
  // basename() throws for a non-string transcript_path (e.g. a hand-crafted
  // payload with a number) — that throw is caught by runHook's wrapper (M1),
  // which still logs exactly one error line. Copilot's file is always
  // events.jsonl, so its log name keeps the session directory too.
  const transcript = copilot
    ? `${basename(dirname(transcriptPath))}/${basename(transcriptPath)}`
    : logName(opts, transcriptPath);
  known.transcript = transcript;

  if (!copilot && (opts.source === undefined || opts.source === "claude-code"))
    maybeSpawnQuestionnaire(input, transcriptPath, opts, logPath);

  // #334: Claude Code cancels a SessionEnd hook after ~1.5 s, so the upload
  // runs in a detached child; only a failed spawn falls through to inline.
  const handOffArgs =
    opts.source === "agy"
      ? ["session-end-hook", "--source", "agy", "--deferred-path", transcriptPath]
      : ["session-end-hook", "--deferred-path", transcriptPath];
  if (!copilot && handOff(handOffArgs, opts, logPath)) {
    await appendHookLogOnce(logState, logPath, { outcome: "deferred", transcript });
    return;
  }

  await importAndLog(opts, transcriptPath, transcript, logPath, logState, known, t0);
}

/**
 * W3b session-end questionnaire (questionnaire.ts): when `dogfood.questionnaire`
 * is on, hand a detached `--questionnaire` child the session id and transcript
 * and return at once. The child itself checks for injected lines. Best effort:
 * a failed spawn is only a debug line.
 */
function maybeSpawnQuestionnaire(
  input: SessionEndHookInput,
  transcriptPath: string,
  opts: SessionEndHookOptions,
  logPath: string,
): void {
  if (!questionnaireEnabled(opts.cliConfigPath)) return;
  // Headless / nested / API-billed sessions never fork (questionnaireForkRefusal).
  if (questionnaireForkRefusal(opts.env ?? process.env)) return;
  const sid = input.session_id;
  if (typeof sid !== "string" || !SAFE_SESSION_ID_RE.test(sid) || sid.includes("..")) return;
  const cwd = typeof input.cwd === "string" && isAbsolute(input.cwd) ? ["--cwd", input.cwd] : [];
  handOff(["session-end-hook", "--questionnaire", sid, "--deferred-path", transcriptPath, ...cwd], opts, logPath);
}

/** What hook.log names: the file, or for Antigravity `<conversation>/<file>` since every file is called transcript. */
function logName(opts: SessionEndHookOptions, transcriptPath: string): string {
  if (opts.source === "agy") {
    const id = agyConversationId(transcriptPath);
    if (id) return `${id}/${basename(transcriptPath)}`;
  }
  return basename(transcriptPath);
}

/** The detached Claude Code or Antigravity child (`--deferred-path`): lock, import now, log once. */
async function runClaudeChild(
  opts: SessionEndHookOptions,
  logPath: string,
  logState: LogState,
  known: KnownInfo,
  _t0: number,
): Promise<void> {
  const transcriptPath = opts.deferredPath as string;
  const agy = opts.source === "agy";
  if (agy && !agyConversationId(transcriptPath)) {
    debug("--deferred-path is not an Antigravity brain transcript — skipping");
    await appendHookLogOnce(logState, logPath, {
      outcome: "skipped",
      reason: "deferred path is not an agy transcript",
    });
    return;
  }
  const transcript = logName(opts, transcriptPath);
  known.transcript = transcript;
  const sessionId = agy ? (agyConversationId(transcriptPath) as string) : basename(transcriptPath, ".jsonl");
  const lockPath =
    SAFE_SESSION_ID_RE.test(sessionId) && !sessionId.includes("..")
      ? join(dirname(logPath), "deferred", `${sessionId}.lock`)
      : undefined;
  // A resumed session can end while the previous child still uploads the same
  // file: wait for that lock to clear, then import the (now longer) transcript.
  let lock = lockPath ? await acquireDeferredLock(lockPath) : "unlocked";
  if (opts.open && lock === "held") {
    // Stop child: never queue behind another upload; stay silent. The parent refreshed the throttle stamp before
    // spawning us, but nothing was uploaded, so clear it and let the next Stop retry instead of waiting a window.
    await clearStopStamp(logPath, sessionId);
    return;
  }
  const waitUntil = Date.now() + lockWaitOf(opts);
  const pollMs = opts.deferredPollMs ?? DEFERRED_POLL_MS;
  while (lock === "held" && lockPath && Date.now() < waitUntil) {
    await delay(Math.max(1, Math.min(pollMs, waitUntil - Date.now())));
    lock = await acquireDeferredLock(lockPath);
  }
  if (lock === "held") {
    debug("another deferred child is still uploading this session — leaving it to the sweep");
    await appendHookLogOnce(logState, logPath, { outcome: "skipped", reason: "already uploading", transcript });
    return;
  }
  if (lock === "acquired") known.lockPath = lockPath;
  // The upload phase starts once this child may upload (after the lock wait), not at spawn.
  const t0 = Date.now();
  try {
    await importAndLog(opts, transcriptPath, transcript, logPath, logState, known, t0);
  } finally {
    await releaseLock(known);
  }
}

function lockWaitOf(opts: SessionEndHookOptions): number {
  if (opts.open) return 0;
  return opts.deferredLockWaitMs ?? DEFERRED_LOCK_WAIT_MS;
}

/** Removes the lock this process holds, once (the timeout branch and the body's finally can both reach here). */
async function releaseLock(known: KnownInfo): Promise<void> {
  const path = known.lockPath;
  if (!path) return;
  known.lockPath = undefined;
  await unlink(path).catch(() => {});
}

async function importAndLog(
  opts: SessionEndHookOptions,
  transcriptPath: string,
  transcript: string,
  logPath: string,
  logState: LogState,
  known: KnownInfo,
  t0: number,
): Promise<void> {
  const copilot = opts.source === "copilot-cli";
  let pendingDisable: Promise<void> | undefined;
  const result = await importSessionSilently(
    {
      transcript: transcriptPath,
      ...(copilot ? { source: "copilot-cli" } : opts.source === "agy" ? { source: "agy" } : {}),
      apiUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      ...(opts.open
        ? {
            open: true,
            onOpenUnsupported: () => {
              pendingDisable = disableStop(logPath, transcript);
            },
          }
        : {}),
      ...uploadDeadlines(opts, t0),
    },
    known,
  );
  await pendingDisable;

  // `outcome` is the PARENT's: children are reported separately and never
  // turn an uploaded parent into an error (deferred ones reach the sweep).
  const children = result.children && result.children.total > 0 ? result.children : undefined;
  const deferredNote =
    children && children.deferred > 0 ? `${children.deferred} sub-agents deferred to sweep` : undefined;
  await appendHookLogOnce(logState, logPath, {
    outcome: result.outcome,
    ...(children ? { parent: result.outcome, children } : {}),
    reason: joinReasons(result.reason, deferredNote),
    transcript,
  });
}

/**
 * Hands the import to a detached `--deferred-path` child and reports whether
 * that worked. The child is the same node binary running the same CLI entry
 * as this process (`process.execPath` + `process.argv[1]`), so it needs no
 * re-resolution of how the CLI was installed.
 */
async function spawnDeferredImport(
  transcriptPath: string,
  opts: SessionEndHookOptions,
  logPath: string,
): Promise<boolean> {
  const offset = Math.max(0, await sizeOf(transcriptPath));
  const args = [
    "session-end-hook",
    "--source",
    "copilot-cli",
    "--deferred-path",
    transcriptPath,
    "--deferred-offset",
    String(offset),
  ];
  return handOff(args, opts, logPath);
}

/**
 * Spawns the detached child with `args` (plus `--api-url` when set) and reports
 * whether that worked. The key goes through the child's env (import-session
 * reads MEMBRAL_API_KEY), never argv, which `ps` shows.
 */
function handOff(args: string[], opts: SessionEndHookOptions, logPath: string): boolean {
  const fullArgs = [...args, ...(opts.apiUrl ? ["--api-url", opts.apiUrl] : [])];
  const env = opts.apiKey ? { MEMBRAL_API_KEY: opts.apiKey } : undefined;
  try {
    (opts.spawnDeferred ?? ((a, e) => spawnDetachedCli(a, e, logPath)))(fullArgs, env);
    debug("deferred the import to a detached child");
    return true;
  } catch (err) {
    debug(`could not spawn the deferred import (${errMessage(err)}) — importing inline`);
    return false;
  }
}

function spawnDetachedCli(args: string[], env: Record<string, string> | undefined, logPath: string): void {
  const entry = process.argv[1];
  if (!entry) throw new Error("no CLI entry in process.argv[1]");
  const child = spawn(process.execPath, [entry, ...args], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  // An async spawn failure must not crash the (already returning) hook; it is
  // logged so a child that never started is not invisible.
  child.on("error", (err) => {
    void appendHookLog(logPath, { outcome: "error", reason: `deferred child failed to start: ${errMessage(err)}` });
  });
  child.unref();
}

/** The detached child: wait for `session.shutdown`, then import and log once. */
async function deferredCopilotHook(opts: SessionEndHookOptions): Promise<void> {
  const logPath = opts.hookLogPath ?? DEFAULT_HOOK_LOG_PATH;
  const logState: LogState = { writePromise: null };
  const known: KnownInfo = {};
  const maxWaitMs = opts.deferredMaxWaitMs ?? DEFERRED_MAX_WAIT_MS;
  const stableMs = opts.deferredStableMs ?? DEFERRED_STABLE_MS;
  const timeoutMs = opts.timeoutMs ?? HOOK_TIMEOUT_MS;
  // The import keeps its usual 30 s cap; the waits get their own on top.
  const totalMs = maxWaitMs + Math.max(stableMs, DEFERRED_STABLE_CAP_MS) + timeoutMs;
  try {
    const timedOut = await withTimeout(
      (async () => {
        try {
          await runDeferred(opts, logPath, logState, known, maxWaitMs, stableMs);
        } catch (err) {
          debug(`unexpected error: ${errMessage(err)}`);
          await appendHookLogOnce(logState, logPath, {
            outcome: "error",
            reason: `unexpected error: ${errMessage(err)}`,
            transcript: known.transcript,
          });
        }
      })(),
      totalMs,
    );
    if (timedOut) {
      await releaseLock(known);
      await appendHookLogOnce(logState, logPath, {
        outcome: known.parent?.outcome ?? "error",
        reason: joinReasons(known.parent?.reason, `timed out after ${totalMs}ms`),
        transcript: known.transcript,
      });
    }
  } catch (err) {
    await appendHookLogOnce(logState, logPath, {
      outcome: "error",
      reason: `unexpected error: ${errMessage(err)}`,
      transcript: known.transcript,
    });
  }
}

async function runDeferred(
  opts: SessionEndHookOptions,
  logPath: string,
  logState: LogState,
  known: KnownInfo,
  maxWaitMs: number,
  stableMs: number,
): Promise<void> {
  // Same guard as a payload transcriptPath: under session-state/, events.jsonl.
  const path = copilotTranscriptPath({ transcriptPath: opts.deferredPath }, opts.copilotHome);
  if (!path) {
    debug("--deferred-path is not an events.jsonl under session-state/ — skipping");
    await appendHookLogOnce(logState, logPath, {
      outcome: "skipped",
      reason: "deferred path outside session-state",
    });
    return;
  }
  const transcript = `${basename(dirname(path))}/${basename(path)}`;
  known.transcript = transcript;

  const sessionId = basename(dirname(path));
  const lockPath = join(dirname(logPath), "deferred", `${sessionId}.lock`);
  const lock = await acquireDeferredLock(lockPath);
  if (lock === "held") {
    debug("another deferred child is already uploading this session — skipping");
    await appendHookLogOnce(logState, logPath, { outcome: "skipped", reason: "already uploading", transcript });
    return;
  }
  if (lock === "acquired") known.lockPath = lockPath;
  try {
    await waitAndImport(opts, path, transcript, logPath, logState, known, maxWaitMs, stableMs);
  } finally {
    await releaseLock(known);
  }
}

/**
 * O_EXCL lock file holding the owner's pid. "held" only when a fresh lock
 * exists whose pid is alive; a lock older than DEFERRED_LOCK_STALE_MS, or
 * whose pid no longer exists, is removed and retaken. Any other failure (unwritable
 * dir) is "unlocked": better a rare duplicate upload (the server dedupes) than a lost one.
 */
async function acquireDeferredLock(lockPath: string): Promise<"acquired" | "held" | "unlocked"> {
  try {
    await mkdir(dirname(lockPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fh = await open(lockPath, "wx");
        await fh.writeFile(String(process.pid)).catch(() => {});
        await fh.close().catch(() => {});
        return "acquired";
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") return "unlocked";
        const st = await stat(lockPath).catch(() => undefined);
        if (st && Date.now() - st.mtimeMs <= DEFERRED_LOCK_STALE_MS && (await lockOwnerAlive(lockPath))) return "held";
        await unlink(lockPath).catch(() => {});
      }
    }
    return "held";
  } catch {
    return "unlocked";
  }
}

/** False only when the lock names a pid that no longer exists; unreadable or pid-less locks count as alive. */
async function lockOwnerAlive(lockPath: string): Promise<boolean> {
  let pid: number;
  try {
    pid = Number((await readFile(lockPath, "utf8")).trim());
  } catch {
    return true;
  }
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitAndImport(
  opts: SessionEndHookOptions,
  path: string,
  transcript: string,
  logPath: string,
  logState: LogState,
  known: KnownInfo,
  maxWaitMs: number,
  stableMs: number,
): Promise<void> {
  const pollMs = opts.deferredPollMs ?? DEFERRED_POLL_MS;
  const offset = opts.deferredOffset ?? 0;
  const started = Date.now();
  let shutdown = false;
  // VS Code's embedded engine never writes session.shutdown: only the settle wait applies.
  if ((await firstSessionStartCopilotVersion(path)) !== VSCODE_COPILOT_VERSION) {
    shutdown = await hasShutdownEvent(path, offset);
    while (!shutdown && Date.now() - started < maxWaitMs) {
      await delay(Math.min(pollMs, Math.max(0, maxWaitMs - (Date.now() - started))));
      shutdown = await hasShutdownEvent(path, offset);
    }
  }
  await waitForStableSize(path, stableMs, Math.min(pollMs, stableMs), Math.max(stableMs, DEFERRED_STABLE_CAP_MS));
  const waitedMs = Date.now() - started;

  const result = await importSessionSilently(
    {
      transcript: path,
      source: "copilot-cli",
      apiUrl: opts.apiUrl,
      apiKey: opts.apiKey,
      // The upload phase starts after the shutdown wait.
      ...uploadDeadlines(opts, Date.now()),
    },
    known,
  );
  const children = result.children && result.children.total > 0 ? result.children : undefined;
  const deferredNote =
    children && children.deferred > 0 ? `${children.deferred} sub-agents deferred to sweep` : undefined;
  await appendHookLogOnce(logState, logPath, {
    outcome: result.outcome,
    ...(children ? { parent: result.outcome, children } : {}),
    reason: joinReasons(result.reason, deferredNote),
    transcript,
    waited_ms: waitedMs,
    shutdown,
  });
}

/** `data.copilotVersion` of the first `session.start` event in the file's head, if any. */
async function firstSessionStartCopilotVersion(path: string): Promise<string | undefined> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path, "r");
    const buf = Buffer.alloc(16 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    for (const line of buf.subarray(0, bytesRead).toString("utf8").split("\n").slice(0, 5)) {
      try {
        const ev = JSON.parse(line) as { type?: unknown; data?: { copilotVersion?: unknown } };
        if (ev.type === "session.start") {
          const v = ev.data?.copilotVersion;
          return typeof v === "string" ? v : undefined;
        }
      } catch {
        // partial or non-JSON line
      }
    }
  } catch {
    // unreadable
  } finally {
    await fh?.close().catch(() => {});
  }
  return undefined;
}

/**
 * True when the last ~64 KB of `path` holds a complete `session.shutdown` event
 * line that starts at or after byte `fromOffset` (a resumed session's earlier
 * shutdown must not count).
 */
export async function hasShutdownEvent(path: string, fromOffset = 0): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof open>> | undefined;
  try {
    fh = await open(path, "r");
    const { size } = await fh.stat();
    const start = Math.max(0, fromOffset, size - SHUTDOWN_TAIL_BYTES);
    if (start >= size) return false;
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    for (const line of buf.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (!line.includes('"session.shutdown"')) continue;
      try {
        if ((JSON.parse(line) as { type?: unknown }).type === "session.shutdown") return true;
      } catch {
        // partial line at the read window's edge, or one still being written
      }
    }
  } catch {
    // not there yet, or unreadable — keep polling
  } finally {
    await fh?.close().catch(() => {});
  }
  return false;
}

/** Resolves once the file size has held still for `stableMs` (or after `capMs`). */
async function waitForStableSize(path: string, stableMs: number, pollMs: number, capMs: number): Promise<void> {
  const started = Date.now();
  let last = await sizeOf(path);
  let since = Date.now();
  while (Date.now() - since < stableMs && Date.now() - started < capMs) {
    await delay(Math.max(1, pollMs));
    const now = await sizeOf(path);
    if (now !== last) {
      last = now;
      since = Date.now();
    }
  }
}

async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return -1;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function joinReasons(...parts: Array<string | undefined>): string | undefined {
  const present = parts.filter((p): p is string => Boolean(p));
  return present.length > 0 ? present.join(" | ") : undefined;
}

interface ImportOutcome {
  outcome: "ok" | "skipped" | "error";
  reason?: string;
  children?: ChildUploadSummary;
}

// Q2 (P6 local rehearsal): a SessionEnd hook can fire for something that was
// never a capturable session at all — observed case: `claude mcp list` (a
// plain CLI invocation, not an interactive session) still triggered
// SessionEnd with a transcript_path that was never written, so
// import-session.ts's readFile failed with ENOENT and this used to log
// outcome:"error" — noise indistinguishable from a genuine capture failure.
// import-session.ts's warn() message for exactly that failure is always
// `membral import-session: failed to read transcript "<path>": <errMessage>`,
// and Node's fs ENOENT errMessage always starts with "ENOENT" — matching
// narrowly on that shape (not on "failed to parse"/upload-failure/etc.,
// which stay "error") is what distinguishes "there was never a session
// here" from "there was a session and we failed to capture it". Not
// anchored to the start of the string — the "membral import-session: "
// prefix (warn()'s own prefix) comes first.
const MISSING_TRANSCRIPT_RE = /failed to read transcript ".*": ENOENT\b/;

function isMissingTranscript(reason: string): boolean {
  return MISSING_TRANSCRIPT_RE.test(reason);
}

// import-session.ts warns to console.error unconditionally (it's also used
// interactively via `import-session`/`sessions`, where that's the
// right behavior). The hook path needs those same warnings suppressed on
// the terminal unless MEMBRAL_DEBUG=1, without forking import-session.ts's
// logging — so we intercept console.error for the duration of the call,
// both to keep the terminal quiet AND to capture the reason for hook.log.
async function importSessionSilently(options: ImportSessionOptions, known?: KnownInfo): Promise<ImportOutcome> {
  const messages: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    messages.push(args.map((a) => String(a)).join(" "));
    if (process.env.MEMBRAL_DEBUG === "1") {
      original(...args);
    }
  };
  let children: ChildUploadSummary | undefined;
  try {
    children = await importSession({
      ...options,
      onParentDone: () => {
        if (known) known.parent = classifyMessages([...messages]);
      },
    });
  } finally {
    console.error = original;
  }
  return { ...classifyMessages(messages), children };
}

function classifyMessages(messages: string[]): ImportOutcome {
  // A sub-agent child upload failing never fails the parent's capture: those
  // warnings (SUB_AGENT_WARN_PREFIX) are kept as the reason on an "ok" line,
  // not turned into an "error" outcome.
  const childPrefix = `membral import-session: ${SUB_AGENT_WARN_PREFIX}`;
  const childMessages = messages.filter((m) => m.startsWith(childPrefix));
  const parentMessages = messages.filter((m) => !m.startsWith(childPrefix));

  if (parentMessages.length === 0) {
    return childMessages.length === 0 ? { outcome: "ok" } : { outcome: "ok", reason: childMessages.join(" | ") };
  }
  if (parentMessages.length === 1 && isMissingTranscript(parentMessages[0])) {
    return { outcome: "skipped", reason: parentMessages[0] };
  }
  return { outcome: "error", reason: messages.join(" | ") };
}

interface HookLogFields {
  outcome: HookOutcome;
  /** Present when the session had sub-agents: the parent's own outcome, logged apart from theirs. */
  parent?: HookOutcome;
  children?: ChildUploadSummary;
  reason?: string;
  transcript?: string;
  /** Deferred Copilot import only: time spent waiting before the import. */
  waited_ms?: number;
  /** Deferred Copilot import only: whether `session.shutdown` was seen before importing. */
  shutdown?: boolean;
}

// Ensures at most one hook.log WRITE is ever initiated per invocation, and
// that every caller — whichever one actually triggers it — awaits the
// SAME promise for that write (round 4, Minor 4; see the LogState comment
// above for why a boolean flag alone wasn't enough). The check-then-set is
// synchronous, so no other call can interleave in between on Node's
// single-threaded event loop — exactly one write is ever initiated.
function appendHookLogOnce(state: LogState, logPath: string, fields: HookLogFields): Promise<void> {
  if (state.writePromise) return state.writePromise;
  state.writePromise = appendHookLog(logPath, fields);
  return state.writePromise;
}

// Appends one stable JSON-lines entry to ~/.membral/hook.log (or the
// injected test path). This is the ONLY place hook outcomes become visible
// when MEMBRAL_DEBUG isn't set — so it must never throw, and a failure to
// write the log itself must never surface either.
async function appendHookLog(logPath: string, fields: HookLogFields): Promise<void> {
  try {
    await mkdir(dirname(logPath), { recursive: true });
    const entry = {
      ts: new Date().toISOString(),
      outcome: fields.outcome,
      ...(fields.parent ? { parent: fields.parent } : {}),
      ...(fields.children ? { children: fields.children } : {}),
      ...(fields.reason ? { reason: sanitizeLogReason(fields.reason) } : {}),
      ...(fields.transcript ? { transcript: fields.transcript } : {}),
      ...(fields.waited_ms !== undefined ? { waited_ms: fields.waited_ms } : {}),
      ...(fields.shutdown !== undefined ? { shutdown: fields.shutdown } : {}),
    };
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // The log write itself must never be the reason this hook fails.
  }
}

// M2/Minor3/Minor1(round3): strips absolute filesystem paths out of a
// captured reason string before it's written to hook.log.
//   1. Any path wrapped in a delimiter pair ("...", '...', [...], <...>)
//      is collapsed to just its final path segment (basename) — this is
//      the pass that handles paths CONTAINING SPACES (round 2, Minor 3:
//      the previous whitespace-token-only approach split a spaced path
//      like `"/private/var/Secret Co/Client Alpha/nope.jsonl"` into
//      multiple tokens at each space, and only the FIRST token looked like
//      an absolute path — everything after the first space leaked
//      unmodified). import-session.ts's own messages always quote a path
//      (`"${opts.transcript}"`); Node's fs errors single-quote theirs
//      (`ENOENT: ... open '/path'`) — matching by delimiter, not
//      whitespace, handles both regardless of spaces inside the path.
//   2. A FALLBACK token-by-token pass (whitespace-split) still catches a
//      bare, undelimited absolute path with no spaces in it (the common
//      case, and what round 1's fix covered).
//   3. ONLY THEN does the exact home directory, wherever it still appears,
//      become "~" — a cheap backstop for any leftover literal homedir text
//      that wasn't inside a shape passes 1/2 recognized.
// Every pass skips a match containing "://" so a URL is never mangled.
//
// Round 3 (Minor 1) — ORDER MATTERS, and round 1/2 had it backwards: the
// homedir->~ pass used to run FIRST. Every REAL Claude Code transcript path
// lives under the home directory
// (~/.claude/projects/<slugified-cwd>/<sessionId>.jsonl, where the
// slugified-cwd segment is the ENTIRE original cwd with "/" replaced by
// "-" — so a project at "/Users/me/dev/Secret Co/Client Alpha" becomes the
// literal directory name "-Users-me-dev-Secret Co-Client Alpha", carrying
// any client/company name right into the path). Running homedir->~ first
// turned the leading "/Users/me" into "~", so BOTH collapse passes below —
// which only recognized a candidate starting with "/" — silently skipped
// the now-"~"-prefixed string entirely. That leaked the slugified segment
// (and therefore the client name) on literally the dominant real-world
// case, since almost every transcript path IS home-rooted. Collapsing
// against the raw, still fully "/"-rooted path FIRST fixes this outright;
// both collapse passes also now recognize an already-"~/"-prefixed
// candidate (defense in depth, e.g. if some future caller hands this
// function an already-tildified string directly).
// Round 4 (Minor 3): "(" / ")" added — import-sessions.ts (and other call
// sites) format a wrapped cause as `(${errMessage(cause)})`, and a path
// containing spaces inside plain parens was NOT caught by the token
// fallback (which splits on whitespace) the same way a quoted/bracketed
// spaced path wasn't in round 2 — verified as a partial leak.
const DELIMITER_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['"', '"'],
  ["'", "'"],
  ["[", "]"],
  ["<", ">"],
  ["(", ")"],
];

// Real http(s) URLs are the ONLY thing this sanitizer must never mangle.
// Round 4 (Minor 2): round 1-3 exempted ANYTHING containing "://", which is
// a blanket bypass — a "file:///private/var/Secret Co/nope.jsonl" URI
// contains "://" too, and its path portion is exactly as sensitive as a
// bare filesystem path, but used to sail through completely unsanitized.
const URL_EXEMPT_SCHEMES = ["http://", "https://"];
const FILE_URI_SCHEME = "file://";

// Exported for direct unit testing (round 2 adversarial review, Minor 3) —
// constructing real end-to-end reason strings for every delimiter shape
// (quoted-with-spaces, bracketed, angle-bracketed) would mean fabricating
// upstream error message formats import-session.ts doesn't actually
// produce; testing the sanitizer as a pure function is more honest about
// what's covered. session-end-hook.test.ts still keeps true end-to-end
// cases (a transcript path containing a space, and a home-rooted real
// Claude Code project path) alongside these.
export function sanitizeLogReason(reason: string): string {
  let out = reason;
  for (const [open, close] of DELIMITER_PAIRS) {
    out = collapseDelimitedPaths(out, open, close);
  }
  out = out
    .split(/(\s+)/)
    .map((token) => sanitizePathToken(token))
    .join("");
  return out.replaceAll(homedir(), "~");
}

// Reduces an absolute (or already home-relative "~/...") path down to just
// its final segment, preserving a leading "~/" (harmless — it reveals
// nothing beyond "this is under the user's home") and a trailing slash if
// the original had one. Minor (round 3): a trailing-slash DIRECTORY
// reference used to bail out entirely (the naive last `split("/")` element
// is "" for a trailing slash), leaving BOTH of its last two segments
// exposed instead of collapsing down to one.
function reduceToLastSegment(path: string): string | undefined {
  const tildePrefix = path.startsWith("~/") ? "~/" : "";
  const rest = tildePrefix ? path.slice(tildePrefix.length) : path;
  const hadTrailingSlash = rest.length > 1 && rest.endsWith("/");
  const segments = rest.split("/").filter((s) => s.length > 0);
  const base = segments[segments.length - 1];
  if (!base) return undefined; // e.g. "/" or "~/" alone — nothing to reduce to
  return `${tildePrefix}${base}${hadTrailingSlash ? "/" : ""}`;
}

// The single decision point both collapse passes share for "is this
// path-shaped, and if so what does it reduce to" (round 4, Minor 2):
//   - a real http(s) URL is left completely untouched (returns undefined);
//   - a "file://" URI has its PATH PORTION reduced just like a bare path,
//     since that's exactly what it is (round 1-3's blanket "://" exemption
//     let this sail through unsanitized);
//   - a bare "/" or "~/"-rooted candidate is reduced directly;
//   - anything else isn't a recognized path shape (returns undefined, and
//     the caller keeps the original text unchanged).
function reducePathCandidate(candidate: string): string | undefined {
  if (URL_EXEMPT_SCHEMES.some((scheme) => candidate.startsWith(scheme))) {
    return undefined;
  }
  if (candidate.startsWith(FILE_URI_SCHEME)) {
    const afterScheme = candidate.slice(FILE_URI_SCHEME.length);
    // "file:///abs/path" (3 slashes) leaves afterScheme already "/"-rooted;
    // tolerate the 2-slash form ("file://abs/path") too, just in case.
    const pathPart = afterScheme.startsWith("/") || afterScheme.startsWith("~/") ? afterScheme : `/${afterScheme}`;
    const reduced = reduceToLastSegment(pathPart);
    return reduced ? `${FILE_URI_SCHEME}${reduced}` : undefined;
  }
  if (candidate.startsWith("/") || candidate.startsWith("~/")) {
    return reduceToLastSegment(candidate);
  }
  return undefined;
}

function collapseDelimitedPaths(str: string, open: string, close: string): string {
  const re = new RegExp(
    `${escapeRegExp(open)}((?:${FILE_URI_SCHEME})?(?:~/|/)[^${escapeRegExp(close)}]*)${escapeRegExp(close)}`,
    "g",
  );
  return str.replace(re, (whole: string, pathPart: string) => {
    const reduced = reducePathCandidate(pathPart);
    return reduced ? `${open}${reduced}${close}` : whole;
  });
}

function escapeRegExp(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sanitizePathToken(token: string): string {
  const leadingMatch = token.match(/^[("']*/);
  const trailingMatch = token.match(/[)"'.,:;]*$/);
  const leading = leadingMatch?.[0] ?? "";
  const trailing = trailingMatch?.[0] ?? "";
  const core = token.slice(leading.length, token.length - trailing.length);

  const reduced = reducePathCandidate(core);
  return reduced ? `${leading}${reduced}${trailing}` : token;
}

interface StdinResult {
  data: string;
  errored: boolean;
  errorMessage?: string;
}

// Never throws — a stdin error still resolves (never rejects), but now
// carries `errored`/`errorMessage` so the caller can log something more
// useful than "empty stdin" for a genuine read failure (Minor 5).
function readStdin(stream: NodeJS.ReadableStream): Promise<StdinResult> {
  return new Promise((resolve) => {
    let data = "";
    let settled = false;
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
      resolve({ data, errored: false });
    });
    stream.on("error", (err) => {
      if (settled) return;
      settled = true;
      resolve({ data, errored: true, errorMessage: errMessage(err) });
    });
  });
}

// Resolves `true` if `ms` elapsed before `promise` settled, `false`
// otherwise. Never rejects — any rejection from `promise` is swallowed
// (matching the hook's never-throw contract) and reported as `false`
// (i.e. not a timeout) since it settled on its own.
function withTimeout(promise: Promise<void>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      debug(`timed out after ${ms}ms — exiting hook early`);
      resolve(true);
    }, ms);
    // Don't let this timer keep the process alive on its own.
    timer.unref?.();

    promise
      .then(() => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(false);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        debug(`unexpected error: ${errMessage(err)}`);
        resolve(false);
      });
  });
}

function debug(message: string): void {
  if (process.env.MEMBRAL_DEBUG === "1") {
    console.error(`membral session-end-hook: ${message}`);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- Stop hook (Lever 2, goal 2026-10-25 box 2.1) -----------------------------------------------
//
// Claude Code fires `Stop` after every turn group while the session is still open. The sweep and
// SessionEnd upload only finished transcripts, so a parallel session cannot find what an open one
// has learned. This hook uploads "the transcript so far" by handing a detached
// `--deferred-path <transcript> --open` child (the SessionEnd child's lock, 30 s cap, hook.log line)
// the current file.
//
// No paid work for an unfinished session: `--open` makes the upload carry `open: true`. The server
// stores the turns and the raw units (so the session is searchable) but queues no memory extraction
// and runs no synthesis (apps/cloud route.ts). It stamps code_sessions.props.open_upload; the
// closing upload (SessionEnd or sweep) of identical content therefore re-imports once instead of
// short-circuiting on the content hash (import.ts), which queues extraction as usual. A changed
// hash replaces the turns wholesale, so a later longer upload never duplicates them.
//
// Safety: stdout stays empty (Stop output can block the stop); `stop_hook_active` payloads exit at
// once (loop guard); always exits 0; the parent only reads stdin, checks a throttle file and spawns,
// under STOP_HOOK_TIMEOUT_MS. The transcript's file name must equal session_id.
//
// Throttle: at most one hand-off per session per STOP_THROTTLE_MS, via the mtime of
// `<hook.log dir>/hook-state/stop/<session>` (a leading throttle: the first Stop uploads at once).
// ACCEPTED TRADE-OFF: there is no trailing pass, so a Stop swallowed by the throttle is not retried; an
// idle open session can be up to ~60 s behind until the next Stop, the SessionEnd upload or the sweep.
// The parent stamps before spawning (it cannot know whether the child gets the lock), so a child that
// finds the lock held deletes the stamp again, letting the next Stop retry.
//
// ACCEPTED TRADE-OFF: against an old server that ignores `open`, N sessions already open each send one
// probe before the disable marker exists (bounded: one per session, then once per 24 h after the marker
// ages). A marker write failure is covered by the parent's stamp, which already throttles that session.
//
// Locks: the Stop child takes `deferred/<session>.lock` without waiting and exits silently if it is
// held, so it never queues behind (or ahead of) the SessionEnd child, which still waits for the lock
// as before. Stop uploads hold it at most the 30 s cap. State files older than 7 days are pruned
// opportunistically.
export const STOP_HOOK_TIMEOUT_MS = 5_000;
export const STOP_THROTTLE_MS = 60_000;
const STOP_STATE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** After a server fails to ack `open`, Stop uploads are off this long; then one probe upload is allowed. */
export const STOP_DISABLE_MS = 24 * 60 * 60 * 1000;

function stopDisabledPath(logPath: string): string {
  return join(dirname(logPath), "hook-state", "stop-disabled");
}

/** Child side: the server ignored `open` (it predates it), so Stop uploads would run paid extraction. */
async function disableStop(logPath: string, transcript: string): Promise<void> {
  try {
    await mkdir(dirname(stopDisabledPath(logPath)), { recursive: true });
    await writeFile(stopDisabledPath(logPath), `${new Date().toISOString()}\n`);
  } catch {
    // unwritable state dir: nothing more to do
  }
  await appendHookLog(logPath, {
    outcome: "skipped",
    reason: "server does not acknowledge open uploads; Stop uploads disabled for 24 h",
    transcript,
  });
}

function stopStateDir(logPath: string): string {
  return join(dirname(logPath), "hook-state", "stop");
}

async function clearStopStamp(logPath: string, sessionId: string): Promise<void> {
  if (!SAFE_SESSION_ID_RE.test(sessionId) || sessionId.includes("..")) return;
  await unlink(join(stopStateDir(logPath), sessionId)).catch(() => {});
}

async function pruneStopState(dir: string): Promise<void> {
  try {
    for (const name of await readdir(dir)) {
      const st = await stat(join(dir, name)).catch(() => undefined);
      if (st && Date.now() - st.mtimeMs > STOP_STATE_MAX_AGE_MS) await unlink(join(dir, name)).catch(() => {});
    }
  } catch {
    // no state dir yet
  }
}

async function stopHook(opts: SessionEndHookOptions): Promise<void> {
  const logPath = opts.hookLogPath ?? DEFAULT_HOOK_LOG_PATH;
  const logState: LogState = { writePromise: null };
  try {
    const timedOut = await withTimeout(runStop(opts, logPath, logState), opts.timeoutMs ?? STOP_HOOK_TIMEOUT_MS);
    if (timedOut) await appendHookLogOnce(logState, logPath, { outcome: "error", reason: "stop hook timed out" });
  } catch (err) {
    await appendHookLogOnce(logState, logPath, { outcome: "error", reason: `unexpected error: ${errMessage(err)}` });
  }
}

async function runStop(opts: SessionEndHookOptions, logPath: string, logState: LogState): Promise<void> {
  try {
    const stdinResult = await readStdin(opts.stdin ?? process.stdin);
    if (stdinResult.errored || !stdinResult.data.trim()) return;
    let input: SessionEndHookInput & { stop_hook_active?: unknown };
    try {
      input = JSON.parse(stdinResult.data);
    } catch {
      return;
    }
    if (!input || typeof input !== "object" || Array.isArray(input)) return;
    if (input.stop_hook_active === true) return; // Claude is already continuing because of a Stop hook
    const transcriptPath = input.transcript_path;
    const sid = input.session_id;
    if (typeof transcriptPath !== "string" || !isAbsolute(transcriptPath)) return;
    if (typeof sid !== "string" || !SAFE_SESSION_ID_RE.test(sid) || sid.includes("..")) return;
    if (basename(transcriptPath, ".jsonl") !== sid) return; // the child derives the session from the file name

    const disabledAt = await stat(stopDisabledPath(logPath)).then(
      (st) => st.mtimeMs,
      () => undefined,
    );
    if (disabledAt !== undefined && Date.now() - disabledAt < (opts.stopDisableMs ?? STOP_DISABLE_MS)) return;

    const stateDir = stopStateDir(logPath);
    const stamp = join(stateDir, sid);
    const throttleMs = opts.stopThrottleMs ?? STOP_THROTTLE_MS;
    const last = await stat(stamp).then(
      (st) => st.mtimeMs,
      () => undefined,
    );
    if (last !== undefined && Date.now() - last < throttleMs) return;
    try {
      await mkdir(stateDir, { recursive: true });
      if (last === undefined) await writeFile(stamp, "");
      else await utimes(stamp, new Date(), new Date());
      await pruneStopState(stateDir);
    } catch (err) {
      // Fail closed: without a stamp the throttle (and so the cost bound) cannot hold.
      await appendHookLogOnce(logState, logPath, {
        outcome: "skipped",
        reason: `stop throttle stamp not writable: ${errMessage(err)}`,
        transcript: logName(opts, transcriptPath),
      });
      return;
    }

    if (handOff(["session-end-hook", "--deferred-path", transcriptPath, "--open"], opts, logPath)) {
      await appendHookLogOnce(logState, logPath, {
        outcome: "deferred",
        reason: "stop",
        transcript: logName(opts, transcriptPath),
      });
    }
  } catch (err) {
    debug(`stop hook error: ${errMessage(err)}`);
    await appendHookLogOnce(logState, logPath, { outcome: "error", reason: `unexpected error: ${errMessage(err)}` });
  }
}
