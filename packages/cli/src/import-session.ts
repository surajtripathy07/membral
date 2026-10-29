// `membral import-session --transcript <path>` — single-session upload
// (ADR 0021 Q1, P1a). This is the command the P1b Stop/SessionEnd hook will
// call after every Claude Code session.
//
// NON-NEGOTIABLE: this must never exit non-zero and must never throw past
// this function. A hook failing here must not block or interrupt Claude
// Code — every failure mode (missing file, parse error, missing API key,
// network error, auth error, server-side per-session error) is reported as a
// stderr warning and swallowed.
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type CodeSessionParser,
  PARSERS as HARNESS_PARSERS,
  type ParseExtras,
  type RawCodeSession,
  type SessionRef,
} from "@membral/core";
import { createActionRepoCache, settleSessionActionRepos } from "./action-repos.js";
import {
  createRateLimitState,
  createUploadClient,
  resolveUploadConfig,
  UploadDeferredError,
  type UploadFlags,
  uploadBatch,
} from "./code-session-upload.js";
import { resolveGitRemote } from "./git-remote.js";
import { readHookOutcomes, withHookOutcomes } from "./hook-outcomes.js";
import { isQuestionnaireSession } from "./questionnaire.js";
import { readSubAgentFiles } from "./subagents.js";
import { isProjectEnabled, loadSyncAllowlist } from "./sync-allowlist.js";

// The single-transcript (hook) path takes one-file transcripts only: Claude
// Code's `<id>.jsonl`, Copilot CLI's `session-state/<id>/events.jsonl` and
// Codex's `sessions/YYYY/MM/DD/rollout-*.jsonl`. An
// opencode session is an export, not one file, so `--source opencode` stays
// "unknown" here. The parser objects still come from the core registry.
const PARSERS: Record<string, CodeSessionParser> = {
  "claude-code": HARNESS_PARSERS["claude-code"],
  "copilot-cli": HARNESS_PARSERS["copilot-cli"],
  codex: HARNESS_PARSERS.codex,
  agy: HARNESS_PARSERS.agy,
};

export interface ImportSessionOptions extends UploadFlags {
  /** The prompt hook's outcome log (default ~/.membral/hook.log); its per-session counts ride the upload. */
  hookLogPath?: string;
  transcript?: string;
  source?: string;
  /** Overrides ~/.membral/sync.json's default path (tests). */
  syncAllowlistPath?: string;
  /** Sub-agent uploads in flight at once (default 3). */
  childConcurrency?: number;
  /**
   * Epoch ms after which no NEW sub-agent upload starts (the SessionEnd
   * hook's budget); the rest are counted as deferred and left for the sweep.
   */
  childDeadlineAt?: number;
  /**
   * Epoch ms at which an in-flight upload is cut (the SessionEnd hook's
   * `abortAt`, design note §4). Defaults to `childDeadlineAt`.
   */
  uploadAbortAt?: number;
  /** Called once the parent upload has finished (or failed), before any child starts. */
  onParentDone?: () => void;
  /** The session is still open (Stop hook): the server stores turns but queues no paid extraction. */
  open?: boolean;
  /** An `open` parent upload got no `open_supported` ack: the server would run paid extraction on it. */
  onOpenUnsupported?: () => void;
}

/** Sub-agent upload counts — `deferred` were never started (deadline reached). */
export interface ChildUploadSummary {
  total: number;
  uploaded: number;
  failed: number;
  deferred: number;
}

const DEFAULT_CHILD_CONCURRENCY = 3;

/** Resolves with the sub-agent summary when the parent got as far as uploading; never throws. */
export async function importSession(opts: ImportSessionOptions): Promise<ChildUploadSummary | undefined> {
  try {
    return await importSessionInner(opts);
  } catch (err) {
    // Belt-and-suspenders: importSessionInner already catches everything it
    // can, but nothing here may ever propagate to the caller.
    warn(`unexpected error: ${errMessage(err)}`);
    return undefined;
  }
}

async function importSessionInner(opts: ImportSessionOptions): Promise<ChildUploadSummary | undefined> {
  if (!opts.transcript) {
    warn("missing --transcript <path> — skipping");
    return;
  }

  const source = opts.source ?? "claude-code";
  const parser = PARSERS[source];
  if (!parser) {
    warn(`unknown --source "${source}" — skipping`);
    return;
  }

  let raw: string;
  try {
    raw = await readFile(opts.transcript, "utf8");
  } catch (err) {
    warn(`failed to read transcript "${opts.transcript}": ${errMessage(err)} — skipping`);
    return;
  }

  const sourceSessionId = sessionIdFromPath(opts.transcript, source);
  // ADR 0026 D3 — mirror claudeCodeParser.detect()'s sibling-directory shape
  // ourselves, since this single-transcript path never calls detect(). Only
  // set subAgentsDir when the directory actually exists, so a source with no
  // sub-agent sidecar concept never gets a bogus path.
  const candidateSubAgentsDir = join(dirname(opts.transcript), sourceSessionId, "subagents");
  const subAgentsDir = await stat(candidateSubAgentsDir)
    .then((s) => (s.isDirectory() ? candidateSubAgentsDir : undefined))
    .catch(() => undefined);

  const ref: SessionRef = {
    source,
    sourceSessionId,
    path: opts.transcript,
    subAgentsDir,
  };

  let session: RawCodeSession;
  const subAgents = subAgentsDir ? await readSubAgentFiles(subAgentsDir) : [];
  const extras = subAgents.length > 0 ? { subAgents } : undefined;
  try {
    session = parser.parse(ref, raw, extras);
  } catch (err) {
    warn(`failed to parse transcript "${opts.transcript}": ${errMessage(err)} — skipping`);
    return;
  }

  // W3b: a session-end questionnaire fork is never uploaded (questionnaire.ts).
  if (isQuestionnaireSession(session)) {
    warn("session-end questionnaire fork — skipping upload");
    return;
  }

  session.repo.remoteUrl = await resolveGitRemote(session.repo.path);
  // D-051 F1: each action's repo, resolved from the directory it ran in against the project's anchor.
  const actionRepoCache = createActionRepoCache();
  await settleSessionActionRepos(session, [session.repo], actionRepoCache);
  const children = await parseChildSessions(parser, session, extras, undefined, undefined, actionRepoCache);

  // Deliverable 3: same ~/.membral/sync.json check import-sessions.ts's
  // batch walk applies — a project the onboarding wizard marked
  // `enabled: false` is skipped here too, so the SessionEnd hook (which
  // calls this command directly, one transcript at a time) never uploads it.
  if (source === "claude-code" && session.repo.path) {
    const allowlist = loadSyncAllowlist(opts.syncAllowlistPath);
    if (!isProjectEnabled(allowlist, "claude-code", session.repo.path)) {
      warn(`project disabled in ~/.membral/sync.json (${session.repo.path}) — skipping upload`);
      return;
    }
  }

  const config = resolveUploadConfig(opts);
  if (!config.apiKey) {
    warn("missing API key (set MEMBRAL_API_KEY or pass --api-key) — skipping upload");
    return;
  }

  // One client for the parent and all its children: a 429 on one paces the
  // rest, and a stale MEMBRAL_API_KEY falls back to credentials.json once
  // (inside the client) for all of them. Under the SessionEnd hook it carries
  // both deadlines: no attempt or wait starts after `childDeadlineAt`, and an
  // in-flight upload is cut at `uploadAbortAt`; either defers to the sweep.
  const client = createUploadClient(config, {
    log: (line) => console.error(line),
    ...(opts.childDeadlineAt !== undefined ? { startBy: opts.childDeadlineAt } : {}),
    ...(opts.uploadAbortAt !== undefined ? { abortAt: opts.uploadAbortAt } : {}),
  });
  const hookOutcomes = readHookOutcomes(opts.hookLogPath);
  const upload = (s: RawCodeSession, warnPrefix: string, startBy?: number) =>
    uploadBatch(
      config,
      [withHookOutcomes(s, hookOutcomes)],
      createRateLimitState(startBy),
      (msg) => warn(`${warnPrefix}${msg}`),
      false,
      client,
      opts.open === true,
    );

  // Open (Stop) uploads: children go only after the parent proved the server acks `open`.
  // A thrown parent (429/413/5xx/network) or a missing ack leaves them for the next
  // Stop/SessionEnd/sweep, so an old server never queues paid extraction for them.
  let parentOpenOk = true;
  try {
    // The parent goes first and is never skipped for the child budget: it may
    // start (and retry) until the hard cut; children only before childDeadlineAt.
    const outcome = await upload(session, "", opts.uploadAbortAt ?? opts.childDeadlineAt);
    if (opts.open === true && outcome.openSupported !== true) {
      parentOpenOk = false;
      // Only a successful reply without the ack disables Stop; a thrown error must not.
      opts.onOpenUnsupported?.();
    }
    if (outcome.errors.length > 0) {
      for (const e of outcome.errors) {
        warn(`server reported an error for ${e.sourceSessionId}: ${e.error}`);
      }
    }
  } catch (err) {
    parentOpenOk = false;
    warn(`${err instanceof UploadDeferredError ? "upload deferred" : "upload failed"}: ${errMessage(err)}`);
  }

  opts.onParentDone?.();
  if (opts.open === true && !parentOpenOk) {
    return { total: children.length, uploaded: 0, failed: 0, deferred: children.length };
  }

  // Each sub-agent transcript is its own session, one POST each (keeps every
  // body under the route's 4 MB cap; content_hash dedup applies per child),
  // after the parent, up to `childConcurrency` at a time. Past
  // `childDeadlineAt` no new child starts — those are left for the sweep.
  // A child failure never fails the parent: it is reported with
  // SUB_AGENT_WARN_PREFIX (the SessionEnd hook treats those as non-fatal).
  const summary: ChildUploadSummary = { total: children.length, uploaded: 0, failed: 0, deferred: 0 };
  let next = 0;
  let rateDeferred = 0;
  const worker = async () => {
    while (next < children.length) {
      if (opts.childDeadlineAt !== undefined && Date.now() >= opts.childDeadlineAt) return;
      const child = children[next++];
      try {
        const outcome = await upload(child, SUB_AGENT_WARN_PREFIX);
        for (const e of outcome.errors) {
          warn(`${SUB_AGENT_WARN_PREFIX}server reported an error for ${e.sourceSessionId}: ${e.error}`);
        }
        if (outcome.errors.length > 0) summary.failed++;
        else summary.uploaded++;
      } catch (err) {
        if (err instanceof UploadDeferredError) {
          rateDeferred++;
          warn(`${SUB_AGENT_WARN_PREFIX}upload deferred for ${child.sourceSessionId}: ${errMessage(err)}`);
          continue;
        }
        summary.failed++;
        warn(`${SUB_AGENT_WARN_PREFIX}upload failed for ${child.sourceSessionId}: ${errMessage(err)}`);
      }
    }
  };
  const lanes = Math.min(Math.max(1, opts.childConcurrency ?? DEFAULT_CHILD_CONCURRENCY), children.length);
  await Promise.all(Array.from({ length: lanes }, worker));
  summary.deferred = children.length - next + rateDeferred;
  return summary;
}

/** Prefix on every warning about a sub-agent child upload — never a parent failure. */
export const SUB_AGENT_WARN_PREFIX = "sub-agent ";

/**
 * Sub-agent transcripts as their own child sessions (parser-provided; empty
 * for a parser without sub-agent sidecars). Never throws — a child that
 * can't be parsed is dropped with a warning, the parent still uploads.
 * A child whose cwd differs from the parent's gets its own git remote.
 */
export async function parseChildSessions(
  parser: CodeSessionParser,
  parent: RawCodeSession,
  extras: ParseExtras | undefined,
  gitCache?: Map<string, string | null>,
  onWarn: (message: string) => void = warn,
  actionRepoCache = createActionRepoCache(),
): Promise<RawCodeSession[]> {
  if (!parser.parseSubAgentSessions || !extras?.subAgents?.length) return [];
  let children: RawCodeSession[];
  try {
    children = parser.parseSubAgentSessions(parent, extras);
  } catch (err) {
    onWarn(`${SUB_AGENT_WARN_PREFIX}parse failed for ${parent.sourceSessionId}: ${errMessage(err)}`);
    return [];
  }
  for (const child of children) {
    if (child.repo.path && child.repo.path !== parent.repo.path) {
      child.repo.remoteUrl = await resolveGitRemote(child.repo.path, gitCache);
    } else {
      child.repo.remoteUrl = parent.repo.remoteUrl;
    }
    // D-051 B2: the parent folds its children's actions into its own profile, so a child's
    // action keeps a bare ref only when it is BOTH the child's and the parent's project.
    await settleSessionActionRepos(child, [child.repo, parent.repo], actionRepoCache);
  }
  return children;
}

/**
 * Antigravity keeps one directory per conversation:
 * `<root>/brain/<id>/.system_generated/logs/transcript[_full].jsonl`. The id is that directory's name.
 * Undefined for any other path.
 */
export function agyConversationId(path: string): string | undefined {
  const m = /[\\/]brain[\\/]([^\\/]+)[\\/]\.system_generated[\\/]logs[\\/]transcript(?:_full)?\.jsonl$/.exec(path);
  return m?.[1];
}

function sessionIdFromPath(path: string, source?: string): string {
  if (source === "agy") {
    const id = agyConversationId(path);
    if (id) return id;
  }
  const base = basename(path);
  // Copilot CLI keeps one directory per session: session-state/<id>/events.jsonl.
  if (base === "events.jsonl") return basename(dirname(path));
  return base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
}

function warn(message: string): void {
  console.error(`membral import-session: ${message}`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
