// `membral import-sessions` — backfill command (ADR 0021 Q1, P1a).
//
// Walks a code-agent session directory (default `~/.claude/projects`),
// parses every session with the matching `CodeSessionParser`, resolves each
// session's git remote locally (git-remote.ts — the cloud can't do this),
// groups sessions by project, and POSTs them in per-project batches to
// `POST /api/code-sessions`. Prints a per-project summary table + totals.
import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  type CodeSessionParser,
  PARSERS,
  type ParseExtras,
  type RawCodeSession,
  type SessionRef,
  SessionRootUnreadableError,
} from "@membral/core";
import { createActionRepoCache, settleSessionActionRepos } from "./action-repos.js";
import {
  createRateLimitState,
  createUploadClient,
  describeKeyRejected,
  resolveUploadConfig,
  SCOPED_KEY_403,
  splitIntoBatches,
  UploadAuthError,
  type UploadFlags,
  uploadBatch,
} from "./code-session-upload.js";
import { createGitRemoteCache, resolveGitRemote } from "./git-remote.js";
import type { HarnessId } from "./harness-scan.js";
import { readHookOutcomes, withHookOutcomes } from "./hook-outcomes.js";
import {
  formatElapsed,
  formatParseLine,
  formatRateLimitLine,
  formatUploadLine,
  ProgressEmitter,
  RateTracker,
} from "./import-progress.js";
import { parseChildSessions } from "./import-session.js";
import { parseSince } from "./import-window.js";
import { fetchKnownSessions } from "./known-sessions.js";
import type { ApiClient } from "./lib/api-client.js";
import { discoverOpencodeSessions } from "./opencode-export.js";
import { isQuestionnaireSession } from "./questionnaire.js";
import { readSubAgentFiles } from "./subagents.js";
import { isProjectEnabled, loadSyncAllowlist } from "./sync-allowlist.js";

/**
 * The harnesses `membral sessions` (and `membral setup`'s first-import
 * step) walk by default when no explicit `--source` is given. Both call
 * sites share this single list so `membral setup` advertises exactly what
 * `membral sessions` would import (2026-09-12 review, finding 11) — insertion
 * order of `PARSERS` is guaranteed for string keys, so this is stable.
 */
export const DEFAULT_IMPORT_SOURCES: readonly string[] = Object.keys(PARSERS);

export const DEFAULT_ROOT = join(homedir(), ".claude", "projects");
const DEFAULT_OPENCODE_ROOT = join(homedir(), ".local", "share", "opencode");

/** Copilot CLI's home: `$COPILOT_HOME` replaces the whole `~/.copilot` root (sessions live under `session-state/`). */
export function defaultCopilotHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.COPILOT_HOME || join(homedir(), ".copilot");
}

/** Codex's home: `$CODEX_HOME` replaces the whole `~/.codex` root (rollouts live under `sessions/`). */
export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME || join(homedir(), ".codex");
}

/**
 * Every harness is optional (a machine may run only one): a missing DEFAULT root means
 * "not installed", so a plain `membral sessions` (every source) stays silent
 * and ok for them. A missing root still fails loudly when the run names the
 * source (`--source X`, opts.explicitSource) or passes --root.
 */
const OPTIONAL_DEFAULT_SOURCES = new Set(["claude-code", "copilot-cli", "codex", "agy"]);

/** Per-source default session root — `--root` (and DEFAULT_ROOT) has always meant "the claude-code projects dir"; opencode gets its own default (goal 2026-09-12 W6/D5), Copilot CLI its home (W6 2026-10-01), Codex its home (W9 2026-10-02). */
function defaultRootFor(source: string): string {
  if (source === "opencode") return DEFAULT_OPENCODE_ROOT;
  if (source === "copilot-cli") return defaultCopilotHome();
  if (source === "codex") return defaultCodexHome();
  if (source === "agy") return join(homedir(), ".gemini", "antigravity-cli", "brain");
  // Resolved live (not the module-load DEFAULT_ROOT constant) so $HOME overrides in tests/sandboxes apply.
  return join(homedir(), ".claude", "projects");
}

export interface ImportSessionsOptions extends UploadFlags {
  /** The prompt hook's outcome log (default ~/.membral/hook.log); its per-session counts ride the upload. */
  hookLogPath?: string;
  root?: string;
  since?: string;
  dryRun?: boolean;
  source?: string;
  /** The user named this source (`membral sessions --source X`): a missing root fails loudly even when it is the default. */
  explicitSource?: boolean;
  /** Backfill escape hatch (issue #91): re-import every session even when its
   * content_hash is unchanged, so code_sessions.props.usage gets populated on
   * rows imported before ADR 0026 D3/D4 landed. Off by default — ordinary
   * incremental syncs never need it. */
  force?: boolean;
  /**
   * Resume/skip-unchanged escape hatch (the crash-at-900/1166 report): skips
   * the POST /api/code-sessions/known check and re-uploads every session in
   * scope. Off by default — ordinary runs ask the server which sessions it
   * already has unchanged and skip those; `--full` is the explicit
   * re-send-everything override.
   */
  full?: boolean;
  /** Overrides ~/.membral/sync.json's default path (tests). */
  syncAllowlistPath?: string;
  /**
   * Default `true`. When this run finds zero sessions to upload, it sends
   * an empty-batch heartbeat ping so `/pulse` doesn't read as stale (see the
   * zero-upload branch below). Set `false` to suppress that ping for THIS
   * call specifically — used by a multi-source caller (index.ts's `sessions`
   * command loops over every harness) so the whole run sends exactly one
   * heartbeat instead of one per source (2026-09-12 review, finding 12);
   * the caller is responsible for calling `sendHeartbeatPing` itself once,
   * after confirming every source came back empty.
   */
  heartbeat?: boolean;
  /**
   * Issue #137: `membral agent`'s sweep runs this function in-process and
   * its output lands verbatim in ~/.membral/agent.log (launchd's
   * StandardOutPath/StandardErrorPath), which needs every line dated. The
   * standalone interactive `membral import-sessions` command wants the
   * opposite — a clean, human-scannable summary table with no per-line
   * noise. So these are injectable (defaulting to plain
   * console.log/warn/error, unchanged for interactive use) rather than
   * hard-wired: sweep.ts passes log.ts's timestamped log/logWarn/logError
   * here when calling this from the agent's sweep leg.
   */
  log?: (message: string) => void;
  logWarn?: (message: string) => void;
  logError?: (message: string) => void;
  /**
   * The sweep sets this: a harness whose session root doesn't exist
   * (opencode-only user, no ~/.claude/projects) or whose store needs a
   * runtime this Node lacks (no node:sqlite) counts as "not installed" —
   * ok with zero sessions — instead of failing the whole sweep forever. An
   * interactive `membral sessions` keeps failing loudly.
   */
  missingHarnessOk?: boolean;
}

/**
 * Machine-readable summary of a run, returned in addition to the existing
 * console output / `process.exitCode` side effects (unchanged, so the CLI
 * entry point in index.ts and every existing test keep working untouched).
 * Added so in-process callers — the `membral agent` sweep — can log a count
 * without scraping stdout or child-processing this command.
 */
export interface ImportSessionsResult {
  /** Mirrors whether this run would have exited 0. */
  ok: boolean;
  totalImported: number;
  totalErrored: number;
  /** Sessions that were in scope for upload (post --since filtering, pre dry-run/heartbeat short-circuits). */
  totalSessions: number;
  /**
   * One entry per session that passed the allowlist and --since filters (sub-agents included),
   * whether or not the server already had it. Feeds the first-run report in setup.
   */
  sessionFacts?: SessionFact[];
  /** The server rejected the API key (401/403): every other source in the run would fail the same way. */
  authRejected?: boolean;
}

/** The per-session facts the first-run report needs, taken from the parse already done. */
export interface SessionFact {
  harness: string;
  startedAt: string;
  isSubAgent: boolean;
}

function failureResult(): ImportSessionsResult {
  return { ok: false, totalImported: 0, totalErrored: 0, totalSessions: 0 };
}

interface ProjectStats {
  toImport: number; // sessions parsed + within --since that will be (or were) uploaded
  imported: number;
  skipped: number;
  errored: number;
  skippedOld: number;
  /** Excluded by ~/.membral/sync.json (deliverable 3) — a project explicitly disabled by the onboarding wizard. */
  skippedDisabled: number;
}

function emptyStats(): ProjectStats {
  return { toImport: 0, imported: 0, skipped: 0, errored: 0, skippedOld: 0, skippedDisabled: 0 };
}

function projectKeyFor(session: RawCodeSession): string {
  return session.repo.remoteUrl ?? session.repo.path ?? "(unassigned)";
}

/**
 * Maintainer ask (2026-09-25): upload newest-first, across every project —
 * so the server's extraction chain (which processes uploaded sessions in
 * upload order) reaches the sessions most likely to be wanted first, on a
 * backlog that can take tens of minutes to fully drain.
 *
 * A project's session list is only ever built by pushing a top-level
 * session and then its sub-agent children immediately after it (see the
 * claude-code and opencode branches above — `parentSessionId` is set ONLY
 * on a child, never a top-level session), so a "cluster" here is just a
 * maximal run starting at a parentSessionId-less session and continuing
 * through however many parentSessionId-having entries follow it. Sorting
 * whole clusters by their leading (parent) session's `endedAt`, instead of
 * sorting sessions individually, keeps every sub-agent transcript directly
 * after the parent it belongs to — a child uploading before its own parent
 * would be a strange thing for the extractor to read.
 */
function sortSessionsNewestFirst(sessions: RawCodeSession[]): RawCodeSession[] {
  const clusters: RawCodeSession[][] = [];
  for (const session of sessions) {
    if (session.parentSessionId === undefined || clusters.length === 0) {
      clusters.push([session]);
    } else {
      clusters[clusters.length - 1].push(session);
    }
  }
  clusters.sort((a, b) => Date.parse(b[0].endedAt) - Date.parse(a[0].endedAt));
  return clusters.flat();
}

/**
 * ADR 0026 D3 — read the sub-agent sidecars discovered by `detect()`'s
 * `subAgentsDir` so `parser.parse()` can fold them into
 * `RawCodeSession.subAgents`. Best-effort: readSubAgentFiles never throws.
 */
async function parseSessionWithSubAgents(
  parser: CodeSessionParser,
  ref: SessionRef,
  raw: string,
): Promise<{ session: RawCodeSession; extras?: ParseExtras }> {
  if (!ref.subAgentsDir) return { session: parser.parse(ref, raw) };
  const subAgents = await readSubAgentFiles(ref.subAgentsDir);
  const extras = subAgents.length > 0 ? { subAgents } : undefined;
  return { session: parser.parse(ref, raw, extras), extras };
}

async function mtimeMs(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * --since prefilter: true when a Claude Code transcript AND its
 * `<id>/subagents/` dir (and every file in it) were last written before
 * `sinceMs`. A session's endedAt is never later than its last write, so
 * such a session would be dropped by the endedAt check anyway — skipping it
 * here saves reading and parsing it. Any stat failure answers "not old".
 */
async function untouchedSince(ref: SessionRef, sinceMs: number): Promise<boolean> {
  const transcriptMtime = await mtimeMs(ref.path);
  if (transcriptMtime === undefined || transcriptMtime >= sinceMs) return false;
  const subDir = ref.subAgentsDir ?? join(dirname(ref.path), basename(ref.path, ".jsonl"), "subagents");
  const dirMtime = await mtimeMs(subDir);
  if (dirMtime === undefined) return true; // no sub-agents dir
  if (dirMtime >= sinceMs) return false;
  let names: string[];
  try {
    names = await readdir(subDir);
  } catch {
    return false;
  }
  for (const name of names) {
    const m = await mtimeMs(join(subDir, name));
    if (m === undefined || m >= sinceMs) return false;
  }
  return true;
}

export async function importSessions(opts: ImportSessionsOptions, client?: ApiClient): Promise<ImportSessionsResult> {
  const log = opts.log ?? console.log;
  const logWarn = opts.logWarn ?? console.warn;
  const logError = opts.logError ?? console.error;

  // Live progress (the real report this fixes: ~40 minutes of silence
  // during a paced ~1,166-session upload). Only for the default logger —
  // a caller that injects its own `log` (the launchd sweep — see
  // sweep-command.ts, which stamps every line for agent.log) already made a
  // deliberate choice about its own output shape, and stays exactly as
  // quiet as before; the session-end hook doesn't call this function at
  // all (it uses import-session.ts's single-session path). Interactive
  // callers — `membral setup` step 5 and `membral sessions` — pass no
  // `log` override, so they get it.
  const startedAtMs = Date.now();
  const progress =
    opts.log === undefined
      ? new ProgressEmitter({
          isTTY: Boolean(process.stdout.isTTY),
          write: (chunk) => process.stdout.write(chunk),
          log,
        })
      : undefined;

  const source = opts.source ?? "claude-code";
  const parser = (PARSERS as Readonly<Record<string, CodeSessionParser | undefined>>)[source];
  if (!parser) {
    logError(`Unknown --source "${source}". Supported: ${Object.keys(PARSERS).join(", ")}`);
    process.exitCode = 1;
    return failureResult();
  }

  let sinceMs: number | undefined;
  if (opts.since) {
    sinceMs = parseSince(opts.since);
    if (Number.isNaN(sinceMs)) {
      logError(
        `Invalid --since date: "${opts.since}" (expected an ISO date such as 2026-01-01, or a relative value such as 7d, 12h or 2w)`,
      );
      process.exitCode = 1;
      return failureResult();
    }
  }

  const root = opts.root ?? defaultRootFor(source);
  const optionalDefault = OPTIONAL_DEFAULT_SOURCES.has(source) && opts.root === undefined && !opts.explicitSource;
  // An absent optional default in an all-sources run stays silent: no "Scanning" line either.
  if (!(optionalDefault && !existsSync(root))) {
    log(`Scanning ${root} for ${source} sessions...`);
  }
  if (opts.force) {
    log(
      "--force: re-parsing and re-uploading every session in scope, even unchanged ones " +
        "(server overwrites; re-queues memory extraction).",
    );
  }

  const gitCache = createGitRemoteCache();
  const actionRepoCache = createActionRepoCache();
  const stats = new Map<string, ProjectStats>();
  const byProject = new Map<string, RawCodeSession[]>();
  const sessionFacts: SessionFact[] = [];

  // Deliverable 3: honor ~/.membral/sync.json — a project the onboarding
  // wizard (or a later `membral setup` re-run) marked `enabled: false` is
  // skipped here, which means the agent sweep and the SessionEnd hook (both
  // of which route through this function or import-session.ts's own check)
  // never upload it either. Missing/corrupt file degrades to "no
  // restrictions" (loadSyncAllowlist never throws) — every project syncs,
  // matching pre-allowlist behavior.
  //
  // 2026-09-12 review, finding 2 (BLOCKER): this used to be gated on
  // `source === "claude-code"` and then hard-coded "claude-code" as the
  // harness id passed to `isProjectEnabled` below — which meant a user who
  // excluded an opencode project in the onboarding wizard (harness-scan.ts
  // now lists opencode as importable, so it appears in that prompt) had it
  // uploaded anyway on every `membral sessions` run: the consent control the
  // wizard advertises did not exist for opencode. Load unconditionally and
  // pass the REAL harness id (every `PARSERS` key is a valid `HarnessId`).
  const syncAllowlist = loadSyncAllowlist(opts.syncAllowlistPath);

  // Shared by both discovery paths below — registers one parsed session
  // into the per-project stats/upload buckets (allowlist + --since
  // filtering apply identically regardless of source).
  function registerSession(session: RawCodeSession, opts2: { ignoreSince?: boolean } = {}): boolean {
    const key = projectKeyFor(session);
    // W3b: a session-end questionnaire fork is never a session of its own
    // (questionnaire.ts runs it with --no-session-persistence; this is the
    // second guard). Not counted anywhere.
    if (isQuestionnaireSession(session)) return false;
    const projectStats = stats.get(key) ?? emptyStats();
    stats.set(key, projectStats);

    if (
      syncAllowlist &&
      session.repo.path &&
      !isProjectEnabled(syncAllowlist, source as HarnessId, session.repo.path)
    ) {
      projectStats.skippedDisabled++;
      return false;
    }

    if (sinceMs !== undefined && !opts2.ignoreSince) {
      const endedMs = Date.parse(session.endedAt);
      if (!Number.isNaN(endedMs) && endedMs < sinceMs) {
        projectStats.skippedOld++;
        return false;
      }
    }

    const list = byProject.get(key) ?? [];
    list.push(session);
    byProject.set(key, list);
    projectStats.toImport++;
    sessionFacts.push({
      harness: source,
      startedAt: session.startedAt,
      isSubAgent: session.parentSessionId !== undefined,
    });
    return true;
  }

  // opencode has no filesystem `detect()`/per-file `readFile()` — its
  // sessions live in a SQLite database that core cannot touch (no runtime
  // dependencies), so `packages/cli/src/opencode-export.ts` queries it
  // directly and hands back ready-to-parse `{ ref, raw }` pairs, one at a
  // time, via an async generator (see that module's doc comment).
  if (source === "opencode") {
    const handle = await discoverOpencodeSessions(root, (message) => logWarn(`  ! ${message}`), {
      updatedSinceMs: sinceMs,
    });

    if (handle.sqliteUnavailable && opts.missingHarnessOk) {
      log("opencode: node:sqlite unavailable (needs Node >= 22.5) — treating opencode as not installed.");
      return { ok: true, totalImported: 0, totalErrored: 0, totalSessions: 0 };
    }

    // 2026-09-12 review, finding 5 (SHOULD-FIX) and finding 1 (BLOCKER):
    // an unreadable/corrupt database, or a Node runtime with no
    // `node:sqlite`, must NEVER look identical to "healthy, nothing new" —
    // mirrors claude-code.ts's `SessionRootUnreadableError` handling below
    // exactly: exit non-zero, make no HTTP calls at all (not even the
    // heartbeat — we don't know capture is working), never advance any
    // freshness cursor.
    if (handle.unreadable || handle.sqliteUnavailable) {
      if (handle.sqliteUnavailable) {
        logError("opencode import needs Node >= 22.5 (node:sqlite unavailable) — skipping.");
      } else {
        logError(`Session root not found or unreadable: ${root}`);
      }
      process.exitCode = 1;
      return failureResult();
    }

    // No upfront "Found N session(s)" count here (unlike claude-code below)
    // — the generator reads one session's messages/parts at a time rather
    // than materializing the whole corpus first (2026-09-12 review, finding
    // 4: the old array-building version peaked at 523MB RSS against a
    // 208MB database), so the total isn't known until the loop finishes.
    let parsedCount = 0;
    // Sub-agent sessions are yielded right after their parent (depth-first);
    // a child whose parent was accepted follows the parent's --since decision.
    const acceptedIds = new Set<string>();
    const opencodeRepos = new Map<string, RawCodeSession["repo"]>();
    for await (const { ref, raw } of handle.sessions) {
      let session: RawCodeSession;
      try {
        session = parser.parse(ref, raw);
      } catch (err) {
        logWarn(`  ! failed to parse opencode session ${ref.sourceSessionId}: ${errMessage(err)}`);
        continue;
      }
      parsedCount++;
      // Total isn't known until the generator finishes (see the "No upfront
      // count" comment above), so this omits `/total` — formatParseLine's
      // `total` param stays undefined.
      progress?.update(formatParseLine(source, parsedCount));
      session.repo.remoteUrl = await resolveGitRemote(session.repo.path, gitCache);
      // D-051 F1/B2: each action's repo from the directory it ran in; an opencode child (yielded
      // after its parent) is judged against its parent's project too, as the parent folds it.
      const parentRepo = session.parentSessionId ? opencodeRepos.get(session.parentSessionId) : undefined;
      await settleSessionActionRepos(
        session,
        parentRepo ? [session.repo, parentRepo] : [session.repo],
        actionRepoCache,
      );
      opencodeRepos.set(session.sourceSessionId, session.repo);
      const ignoreSince = session.parentSessionId !== undefined && acceptedIds.has(session.parentSessionId);
      if (registerSession(session, { ignoreSince })) acceptedIds.add(session.sourceSessionId);
    }
    progress?.finish();
    const skipped = handle.skippedCount();
    if (skipped > 0) logWarn(`  ! skipped ${skipped} malformed opencode session row(s)`);
    log(parsedCount === 0 ? "No sessions found." : `Parsed ${parsedCount} session(s).`);
  } else {
    // Every harness is optional on some machine: a missing default
    // home means "not installed", so a plain `membral sessions` (every
    // source) does not fail for them. An explicit --root or --source that
    // is missing still fails loudly.
    if ((opts.missingHarnessOk || optionalDefault) && !existsSync(root)) {
      // Silent for the optional default: machines without that harness see no new output.
      if (!optionalDefault) log(`${source}: ${root} does not exist — treating ${source} as not installed.`);
      return { ok: true, totalImported: 0, totalErrored: 0, totalSessions: 0 };
    }
    let refs: SessionRef[];
    try {
      // Round 3 (Minor 2): a single unreadable PROJECT subdirectory under
      // `root` is still swallowed by detect() (one bad folder shouldn't fail
      // the whole walk), but it's no longer silent — onWarn routes it through
      // logWarn, same as every other per-session diagnostic below, so it
      // lands in the sweep log instead of vanishing.
      refs = await parser.detect(root, (message) => logWarn(`  ! ${message}`));
    } catch (err) {
      // Round-2 adversarial review (MAJOR 1 / Minor 2): detect() now throws
      // SessionRootUnreadableError instead of swallowing a missing/unreadable
      // root into `[]` — a root that's genuinely gone (renamed, permissions
      // changed, a bad --root) means capture is actually broken, which must
      // NEVER look identical to "healthy, nothing new". Exit non-zero with a
      // clear message and make no HTTP calls at all — the sweep script's
      // last_success_at is success-gated on this exit code, so a stale cursor
      // here correctly does NOT advance, and the next sweep retries.
      if (err instanceof SessionRootUnreadableError) {
        logError(`Session root not found or unreadable: ${root}`);
        if (err.cause !== undefined) {
          logError(`  (${errMessage(err.cause)})`);
        }
        process.exitCode = 1;
        return failureResult();
      }
      throw err;
    }

    if (refs.length === 0) {
      log("No sessions found.");
    } else {
      log(`Found ${refs.length} transcript file(s). Parsing...`);
    }

    let untouched = 0;
    let parsedSoFar = 0;
    for (const ref of refs) {
      parsedSoFar++;
      progress?.update(formatParseLine(source, parsedSoFar, refs.length), (parsedSoFar / refs.length) * 100);
      if (sinceMs !== undefined && (await untouchedSince(ref, sinceMs))) {
        untouched++;
        continue;
      }
      let raw: string;
      try {
        raw = await readFile(ref.path, "utf8");
      } catch (err) {
        logWarn(`  ! failed to read ${ref.path}: ${errMessage(err)}`);
        continue;
      }

      let session: RawCodeSession;
      let extras: ParseExtras | undefined;
      try {
        ({ session, extras } = await parseSessionWithSubAgents(parser, ref, raw));
      } catch (err) {
        logWarn(`  ! failed to parse ${ref.path}: ${errMessage(err)}`);
        continue;
      }

      session.repo.remoteUrl = await resolveGitRemote(session.repo.path, gitCache);
      // D-051 F1: each action's repo, resolved from the directory it ran in against the project's anchor.
      await settleSessionActionRepos(session, [session.repo], actionRepoCache);
      if (!registerSession(session)) continue;
      // Each sub-agent transcript uploads as its own session right after its
      // parent (same batches; the server reports per-session errors, so a
      // failing child never fails its parent). Children follow the parent's
      // --since decision rather than their own endedAt.
      const children = await parseChildSessions(
        parser,
        session,
        extras,
        gitCache,
        (m) => logWarn(`  ! ${m}`),
        actionRepoCache,
      );
      for (const child of children) registerSession(child, { ignoreSince: true });
    }
    progress?.finish();
    if (untouched > 0) log(`Skipped ${untouched} session file(s) not modified since ${opts.since}.`);
  }

  let totalToUpload = [...byProject.values()].reduce((sum, list) => sum + list.length, 0);
  log(`Ready to import ${totalToUpload} session(s) (incl. sub-agents) across ${byProject.size} project(s).`);
  if (opts.force) {
    const narrowClause = opts.since ? "." : "; pass --since to narrow.";
    log(
      `--force: ${totalToUpload} session(s) will be re-uploaded and re-queued for memory extraction ` +
        `(server-side daily caps apply)${narrowClause}`,
    );
  }

  if (opts.dryRun) {
    log("");
    log("Dry run — no network calls made.");
    printSummaryTable(stats, log);
    return { ok: true, totalImported: 0, totalErrored: 0, totalSessions: totalToUpload, sessionFacts };
  }

  const config = resolveUploadConfig(opts);
  if (!config.apiKey) {
    logError("Missing API key. Pass --api-key or set MEMBRAL_API_KEY.");
    process.exitCode = 1;
    return failureResult();
  }

  let authFailed = false;

  // One client for every request in this run (/known and every upload):
  // shared backoff state, and the env-key fallback runs once inside it.
  const api = client ?? createUploadClient(config, { log: logWarn });

  // Resume/skip-unchanged (the crash-at-900/1166 report): ask the server
  // which sessions (children included) it already stores with the same turn
  // count and end time, and drop those — the database is the single source
  // of truth for "already uploaded". --full skips the check, and --force
  // implies --full (F-005/#171): forcing a re-upload of "unchanged" sessions
  // is meaningless if the known-sessions probe has already dropped them
  // client-side before force:true ever reaches the server. Any failure (old
  // server without the endpoint, network, 5xx) warns once and uploads
  // everything: the check may save time, never block an import.
  if (opts.full) {
    log("--full: skipping the already-uploaded check, re-uploading every session in scope.");
  } else if (opts.force) {
    log("--force implies --full: skipping the already-uploaded check.");
  } else if (totalToUpload > 0) {
    const all = [...byProject.values()].flat();
    let known: Set<RawCodeSession> | undefined;
    try {
      known = await fetchKnownSessions(config, all, {}, api);
    } catch (err) {
      if (err instanceof UploadAuthError) {
        // The uploads share this client and key (its env-key fallback has
        // already run), so they would fail the same way: stop here, say why,
        // and say how much was left unsent instead of 401ing batch one and
        // silently dropping the rest.
        logError(
          err.status === 401 ? `  ! ${err.message} — ${describeKeyRejected(config, api)}` : `  ! ${SCOPED_KEY_403}`,
        );
        logError(`  ! Stopped: ${totalToUpload} session(s) not uploaded (not counted in the table below).`);
        log("");
        printSummaryTable(stats, log);
        process.exitCode = 1;
        return {
          ok: false,
          totalImported: 0,
          totalErrored: 0,
          totalSessions: totalToUpload,
          sessionFacts,
          authRejected: true,
        };
      }
      logWarn(`Could not check which sessions are already uploaded (${errMessage(err)}) — uploading all of them.`);
    }
    if (known && known.size > 0) {
      for (const [key, sessions] of byProject) {
        const kept = sessions.filter((session) => !known.has(session));
        const projectStats = stats.get(key) ?? emptyStats();
        projectStats.toImport = Math.max(0, projectStats.toImport - (sessions.length - kept.length));
        stats.set(key, projectStats);
        byProject.set(key, kept);
      }
      totalToUpload = [...byProject.values()].reduce((sum, list) => sum + list.length, 0);
      log(`Skipped ${known.size} unchanged (already uploaded).`);
    }
  }

  const upload = (batch: RawCodeSession[], batchLogFn: (msg: string) => void, force?: boolean) =>
    uploadBatch(config, batch, createRateLimitState(), batchLogFn, force, api);

  // B1 (2026-07-26 adversarial review, round 1+2): a delta (--since) sweep
  // that finds nothing new never enters the loop below, which means it
  // never makes a single HTTP call — and the server only records the code
  // freshness heartbeat on an actual POST /api/code-sessions. A perfectly
  // healthy, idle sweep would therefore look "code stale" on /pulse. Ping
  // the server with an explicit empty batch so the heartbeat still advances
  // even when there's truly nothing to upload. Round 2 (MAJOR 1 / Minor 2):
  // this check used to be unreachable when detect() found zero refs at all
  // (the old `if (refs.length === 0) return` above short-circuited before
  // getting here) — that early return is gone now, so `refs.length === 0`
  // flows through to `totalToUpload === 0` exactly like "found refs but
  // --since filtered all of them out" does, and the ping fires either way.
  // Round 4 (Minor 1): gate on `totalToUpload === 0` ALONE, not also
  // `sinceMs !== undefined` — a zero-upload FULL walk (no --since at all,
  // e.g. every session already imported and short-circuited server-side)
  // used to skip the ping too, for the same reason: zero HTTP calls, stale
  // heartbeat. A root that's missing/unreadable still exits 1 with zero
  // HTTP calls regardless — that path returns above, long before reaching
  // this point, so it's unaffected by this gate.
  if (totalToUpload === 0) {
    log("");
    // 2026-09-12 review, finding 12: a multi-source caller (index.ts's
    // `sessions` command) passes `heartbeat: false` here for every
    // per-source call and sends exactly one heartbeat itself afterward —
    // see `sendHeartbeatPing` below — so an idle machine with N harnesses
    // doesn't send N pings.
    if (opts.heartbeat === false) {
      log("No sessions to upload for this source (heartbeat deferred to the end of the run).");
      printSummaryTable(stats, log);
      return { ok: true, totalImported: 0, totalErrored: 0, totalSessions: 0, sessionFacts };
    }
    if (opts.since) {
      log(`No new sessions since ${opts.since} — sending an empty-batch heartbeat ping.`);
    } else {
      log("No sessions to upload — sending an empty-batch heartbeat ping.");
    }
    let heartbeatOk = true;
    try {
      await upload([], (msg) => logWarn(`  [heartbeat] ${msg}`));
      log("Heartbeat ping sent (0 sessions).");
    } catch (err) {
      logError(`  ! heartbeat ping failed: ${errMessage(err)}`);
      process.exitCode = 1;
      heartbeatOk = false;
    }
    log("");
    printSummaryTable(stats, log);
    return { ok: heartbeatOk, totalImported: 0, totalErrored: 0, totalSessions: 0, sessionFacts };
  }

  // Upload-phase progress: a moving-window rate (RateTracker) plus a running
  // done/error count, updated after every batch — this is the fix for the
  // ~40-minutes-of-silence report (the pacing sleep in uploadBatch's retry
  // loop has no log call of its own; between-batch progress is the only
  // thing that makes a long paced run look alive). `rateLimitLog` intercepts
  // uploadBatch's own "rate limited ... waiting Nms" line (code-session-
  // upload.ts) and re-shows it as `formatRateLimitLine` through the
  // progress writer instead of a raw logWarn line, so a 429 pause reads as
  // "waiting 12s", not silence and not log noise; any other message from
  // uploadBatch (network errors, non-429 retries) still goes to logWarn
  // exactly as before.
  const rateTracker = new RateTracker();
  const RATE_LIMIT_WAIT_RE = /^rate limited .*waiting (\d+)ms/;
  let uploadedSoFar = 0;
  let uploadErrorsSoFar = 0;
  function batchLog(key: string): (msg: string) => void {
    return (msg: string) => {
      const match = progress ? RATE_LIMIT_WAIT_RE.exec(msg) : null;
      if (match) {
        progress?.interrupt(formatRateLimitLine(source, Number(match[1])));
        return;
      }
      logWarn(`  [${key}] ${msg}`);
    };
  }

  // Build the whole run's batch plan up front (per project: sort sessions
  // newest-first, then split into upload batches — splitIntoBatches only
  // ever reorders by packing, never by content, so each batch stays sorted
  // internally), then flatten every project's batches into ONE global
  // queue ordered by each batch's most-recent session (its first, since the
  // project's list feeding it was already sorted descending) — newest
  // batch, from any project, goes first.
  const pending: { key: string; batch: RawCodeSession[]; newestMs: number }[] = [];
  // Recall-precision W3b: each session carries its prompt-hook outcome counts (hook-outcomes.ts).
  const hookOutcomes = readHookOutcomes(opts.hookLogPath);
  for (const [key, sessions] of byProject) {
    const withHooks = sessions.map((s) => withHookOutcomes(s, hookOutcomes));
    for (const batch of splitIntoBatches(sortSessionsNewestFirst(withHooks))) {
      pending.push({ key, batch, newestMs: Date.parse(batch[0].endedAt) });
    }
  }
  pending.sort((a, b) => b.newestMs - a.newestMs);

  let attempted = 0;
  for (const { key, batch } of pending) {
    attempted += batch.length;
    const projectStats = stats.get(key) ?? emptyStats();
    stats.set(key, projectStats);
    try {
      const outcome = await upload(batch, batchLog(key), opts.force);
      projectStats.imported += outcome.imported;
      projectStats.skipped += outcome.skipped;
      projectStats.errored += outcome.errors.length;
      for (const e of outcome.errors) {
        logWarn(`  ! ${key} — ${e.sourceSessionId}: ${e.error}`);
      }
      uploadErrorsSoFar += outcome.errors.length;
      rateTracker.record(Date.now(), batch.length);
    } catch (err) {
      projectStats.errored += batch.length;
      uploadErrorsSoFar += batch.length;
      logError(`  ! [${key}] batch upload failed (${batch.length} session(s)): ${errMessage(err)}`);
      if (err instanceof UploadAuthError) {
        authFailed = true;
        break; // the same key fails for every remaining batch, across every project — same API key
      }
    } finally {
      uploadedSoFar += batch.length;
      const nowMs = Date.now();
      progress?.update(
        formatUploadLine({
          harness: source,
          done: uploadedSoFar,
          total: totalToUpload,
          ratePerMinute: rateTracker.ratePerMinute(nowMs),
          etaMs: rateTracker.etaMs(nowMs, totalToUpload - uploadedSoFar),
          errors: uploadErrorsSoFar,
        }),
        (uploadedSoFar / totalToUpload) * 100,
      );
    }
  }
  // Item 4: end the in-place line (TTY) with a real newline, then the
  // existing blank-line + summary-table finish, plus how long this source's
  // run took — gated on `progress` (interactive default-log callers only)
  // so the sweep's stamped log and every existing test's expected output
  // are untouched.
  progress?.finish();
  if (authFailed && attempted < totalToUpload) {
    logError(
      `  ! Stopped after the API key was rejected: ${totalToUpload - attempted} more session(s) not uploaded (not counted in the table below).`,
    );
  }
  log("");
  if (progress) log(`${source}: imported in ${formatElapsed(Date.now() - startedAtMs)}.`);
  printSummaryTable(stats, log);

  const totalImported = [...stats.values()].reduce((sum, s) => sum + s.imported, 0);
  const totalErrored = [...stats.values()].reduce((sum, s) => sum + s.errored, 0);

  if (authFailed) {
    process.exitCode = 1;
    return { ok: false, totalImported, totalErrored, totalSessions: totalToUpload, sessionFacts, authRejected: true };
  }
  if (totalErrored > 0) {
    process.exitCode = 1;
    return { ok: false, totalImported, totalErrored, totalSessions: totalToUpload, sessionFacts };
  }
  return { ok: true, totalImported, totalErrored, totalSessions: totalToUpload, sessionFacts };
}

/**
 * `log` defaults to console.log for direct callers (none left in this file
 * — importSessions always passes its own resolved `log`, see
 * ImportSessionsOptions.log's doc comment) so this stays independently
 * usable if ever called standalone.
 */
function printSummaryTable(stats: Map<string, ProjectStats>, log: (message: string) => void = console.log): void {
  const rows = [...stats.entries()];
  if (rows.length === 0) {
    log("Nothing to report.");
    return;
  }

  const projectWidth = Math.max(7, ...rows.map(([key]) => key.length));
  const header = [
    "PROJECT".padEnd(projectWidth),
    "TO IMPORT".padStart(9),
    "IMPORTED".padStart(8),
    "SKIPPED".padStart(8),
    "ERRORED".padStart(8),
    "TOO OLD".padStart(8),
    "DISABLED".padStart(8),
  ].join("  ");
  log(header);
  log("-".repeat(header.length));

  const totals = emptyStats();
  let hiddenCount = 0;

  for (const [key, s] of rows) {
    totals.toImport += s.toImport;
    totals.imported += s.imported;
    totals.skipped += s.skipped;
    totals.errored += s.errored;
    totals.skippedOld += s.skippedOld;
    totals.skippedDisabled += s.skippedDisabled;

    // F-007: a project with nothing to do (every numeric column 0 — nothing
    // to import, nothing skipped/errored/too-old/disabled) is noise in a
    // multi-project run; hide the row and say how many were hidden instead.
    if (
      s.toImport === 0 &&
      s.imported === 0 &&
      s.skipped === 0 &&
      s.errored === 0 &&
      s.skippedOld === 0 &&
      s.skippedDisabled === 0
    ) {
      hiddenCount++;
      continue;
    }

    log(
      [
        key.padEnd(projectWidth),
        String(s.toImport).padStart(9),
        String(s.imported).padStart(8),
        String(s.skipped).padStart(8),
        String(s.errored).padStart(8),
        String(s.skippedOld).padStart(8),
        String(s.skippedDisabled).padStart(8),
      ].join("  "),
    );
  }

  log("-".repeat(header.length));
  log(
    [
      "TOTAL".padEnd(projectWidth),
      String(totals.toImport).padStart(9),
      String(totals.imported).padStart(8),
      String(totals.skipped).padStart(8),
      String(totals.errored).padStart(8),
      String(totals.skippedOld).padStart(8),
      String(totals.skippedDisabled).padStart(8),
    ].join("  "),
  );
  if (hiddenCount > 0) {
    log(`${hiddenCount} project(s) with nothing to do hidden`);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Sends one empty-batch heartbeat ping (same mechanism as the zero-upload
 * branch above — see its comment for why the ping exists at all). Exported
 * so a multi-source caller can send exactly ONE heartbeat for a whole
 * `membral sessions` run instead of one per source: pass `heartbeat: false`
 * to every per-source `importSessions()` call, then call this once
 * afterward if every source's result had `totalSessions === 0`
 * (2026-09-12 review, finding 12). Never throws — returns `false` on
 * failure so the caller can set `process.exitCode`, same contract as
 * `ImportSessionsResult.ok`.
 */
export async function sendHeartbeatPing(
  opts: UploadFlags,
  logWarn: (message: string) => void = console.warn,
  logError: (message: string) => void = console.error,
  client?: ApiClient,
): Promise<boolean> {
  const config = resolveUploadConfig(opts);
  if (!config.apiKey) return true; // nothing to ping without a key — not this call's failure to report
  // The env-key fallback happens inside the client.
  const api = client ?? createUploadClient(config, { log: logWarn });
  try {
    await uploadBatch(config, [], createRateLimitState(), (msg) => logWarn(`  [heartbeat] ${msg}`), false, api);
    return true;
  } catch (err) {
    logError(`  ! heartbeat ping failed: ${errMessage(err)}`);
    return false;
  }
}
