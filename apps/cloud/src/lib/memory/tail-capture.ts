// Memory v1, source C — tail capture orchestration (docs/design/memory-v1.md
// §3 "C — tail capture, the last line of defence" and §8 bullet 2/7).
//
// `runTailCaptureForSession` is the reusable core: given a (supabase, llm)
// pair, it renders one session, windows the UNCOVERED tail (checkpoint
// arithmetic — `props.memory_checkpoint_turn_idx`, null today since no
// check-in has ever run, so C covers the whole session), extracts within
// budget, grounds + merges + embeds, writes records, runs the supersede
// pass, and stamps `props.memory_extraction`. Both the backfill script
// (scripts/memory/backfill.ts) and the upload path's queue worker
// (extraction-queue.ts, one session per invocation — goal 2026-09-24 review
// B1) call this one function — it is the ONLY place any of this logic lives.
//
// step2d (docs/goals/2026-09-13_memory-v1-build_goal.md; issue #151,
// scratchpad/reports/review-tail-capture.md) landed several fixes here:
//   - finding 3: a per-session lease lock (write.ts's
//     setMemoryExtractionLock/isMemoryExtractionLockHeld) skips a run that
//     lands while another is already in flight for the same session, rather
//     than both independently paying for and writing an extraction. NOTE:
//     the review's OTHER half of finding 3 — one shared LlmClient/cost-guard
//     per UPLOAD REQUEST (a batch of sessions), so the run cap spans the
//     whole request rather than resetting per session — needs a change in
//     the batch loop (apps/cloud/src/app/api/code-sessions/route.ts), which
//     is outside this build step's owned files; flagged as an open item in
//     the step2d report rather than silently left undone.
//   - finding 4: `turn_role` always comes from the resolved receipt turn,
//     never the model (merge.ts's `groundRecord`); a preference whose
//     receipt turn is an assistant turn is DROPPED (counted here as
//     `dropped_owner_voice`).
//   - finding 6: the checkpoint advances only past turns a window actually
//     covered (extracted successfully, not dropped by budget degrade, not a
//     failed LLM call) — `tail_turns_uncovered` records what's left for the
//     next run to retry.
//   - finding 7: `--force`'s retire now happens AFTER the new rows are
//     inserted (extract -> embed -> insert -> retire the SPECIFIC prior
//     ids), so a mid-run failure never leaves the session with zero live
//     memories.
//   - finding 8: embed.ts batches and catches per batch — a failed batch's
//     records are still written, with `embedding: null` (excluded from
//     cosine dedupe/supersede, counted as `embed_failed`).
//   - finding 13/14: the turns read and the supersede write are both scoped
//     by `user_id`.
//   - finding 15: a record whose receipt `turn_idx` never resolves to a
//     real turn is clamped to the session's last turn (merge.ts's
//     `groundRecord`), counted here as `dangling_receipts`.
//   - finding 17: reads `code_sessions.source` for the header (was
//     hardcoded "claude-code"); a tail with zero prose turns is skipped with
//     `props.memory_extraction = {skipped: "no_prose", ...}` and NO LLM call.

import { randomUUID } from "node:crypto";
import { redactFileSecrets, redactPii } from "@membral/core";
import {
  type KnownBranchMr,
  knownBranchesFromTurns,
  type ProfileChildSession,
  type ProfileTrace,
  type ProfileTurnInput,
} from "@/lib/code-sessions/profile";
import type { Db } from "@/lib/db/types";
import { BLOCKER_FRESH_DAYS } from "@/lib/domain/blockers";
import { RESOLVED_IN_SESSION_RETIRE_REASON, RESOLVED_OBSERVED_RETIRE_REASON } from "@/lib/domain/retire-reasons";
import type { LlmClient } from "@/lib/llm/client";
import { log } from "@/lib/log";
import {
  dropCrossSessionDuplicates,
  fetchLaterResolutionCandidates,
  fetchOpenBlockersForRecurrence,
  fetchServedRecords,
  hasSelfReport,
  type InsertableRecord,
  insertMemoryRecords,
  insertSessionFeedback,
  isMemoryExtractionLockHeld,
  isRetiredUnverified,
  JUDGE_ORDER,
  type LaterResolutionCandidate,
  type MemoryExtractionProps,
  mergeSemanticDuplicates,
  releaseMemoryExtractionLock,
  retagUnverifiedAsRerun,
  retireBlockersResolvedLater,
  retireRowsByIds,
  setMemoryExtractionLock,
  supersedeRecords,
  updateSessionMemoryProps,
  upsertQuestionnaire,
  upsertServedVerdicts,
} from "@/lib/memory/write";
import { selectAllRows } from "@/lib/util/pagination";
import { carryUserDismissals } from "./blocker-dismiss";
import { BRANCH_STATE_TABLE } from "./branch-state";
import { estimateWindowCostUsd, resolveSessionBudgetUsd, selectWindowsWithinBudget } from "./budget";
import { recordCutoffReply } from "./cutoff-debug";
import { embedTexts } from "./embed";
import {
  buildUserPassTurns,
  checkLaterBlockerResolutions,
  extractUserTurnPass,
  extractWindow,
  groundSessionIssues,
  type LaterBlockerCheckResult,
  MAX_OPEN_BLOCKERS_OFFERED,
  PROMPT_VERSION,
  reaskBlockerResolutions,
  renderOpenBlockersBlock,
  SUB_AGENT_NOTE,
  selectBlockerReaskLines,
  type TruncatedWindowInfo,
} from "./extract";
import { logMemoryExtraction } from "./extraction-log";
import { type FeedbackParsed, groundFeedbackItems, judgeServedRecords, type ServedVerdictResult } from "./feedback";
import { isContentFailure, type LlmCallFailure } from "./llm-failure";
import {
  applyDeterministicFixes,
  computePaths,
  dedupeByContentHash,
  dedupeByCosine,
  dedupeByNormalizedText,
  type EmbeddedGroundedRecord,
  type GroundedRecord,
  groundRecord,
  isSubAgentBriefRecord,
  unionModelPaths,
} from "./merge";
import { findObservedRetirements, type ObservedBranchState, type ObservedRetirement } from "./observed-retirement";
import { judgeQuestionnaire, type QuestionnaireJudgeResult } from "./questionnaire";
import { liveReconcileEnabled, reconcileInserted } from "./reconcile/live";
import { type CodeSessionRow, renderSessionHeader, renderTurnLines, type TurnRow } from "./render";
import { parseSessionIssues, type SessionIssueParsed } from "./schema";
import { associateSession, sessionAssocEnabled } from "./session-association";
import { writeSessionIssueRows } from "./session-issues";
import {
  countTailTurnsExtracted,
  countTailTurnsUncovered,
  countWindowsFailed,
  didCheckpointAdvance,
  runCostUsd,
} from "./tail-capture/checkpoint";
import { buildWindows, type ChatPrecontextLine, fetchChatPrecontext, renderPrecontextBlock } from "./windows";

/** step2e finding 5: a hard cap on how many rendered tail lines the blocker re-ask prompt carries — a long session's remaining tail could otherwise be enormous; the resolution is almost always visible soon after the blocker, not necessarily at the very end. */
const BLOCKER_REASK_MAX_TAIL_LINES = 400;
/** Served-record verdict evidence: each tool_result (command output) line is cut to this many chars. */
export const SERVED_EVIDENCE_TOOL_RESULT_MAX_CHARS = 400;
/** ...and all tool_result lines together carry at most this many chars (latest kept), so the prompt stays bounded. */
export const SERVED_EVIDENCE_TOOL_RESULT_BUDGET_CHARS = 16_000;

/** ...each rendered evidence line is cut to this many chars (a line is never dropped half-way: it is cut or kept). */
export const SERVED_EVIDENCE_LINE_MAX_CHARS = 2_000;
/** ...and the whole evidence block carries at most this many chars, newest lines first, whole lines only. */
export const SERVED_EVIDENCE_TOTAL_MAX_CHARS = 24_000;

/**
 * The served-record verdict call is one paid LLM call per extraction. It is
 * OFF on hosted (prod): on only for a local stack (MEMBRAL_LOCAL=1) or an
 * explicit MEMBRAL_SERVED_VERDICTS=1; MEMBRAL_SERVED_VERDICTS=0 forces it off.
 */
export function servedVerdictsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  if (env.MEMBRAL_SERVED_VERDICTS === "0") return false;
  return env.MEMBRAL_SERVED_VERDICTS === "1" || env.MEMBRAL_LOCAL === "1";
}

/** Cuts each line to SERVED_EVIDENCE_LINE_MAX_CHARS, then keeps the newest whole lines within `total` chars. Pure. */
export function capEvidenceLines(
  lines: readonly string[],
  lineMax = SERVED_EVIDENCE_LINE_MAX_CHARS,
  total = SERVED_EVIDENCE_TOTAL_MAX_CHARS,
): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = (lines[i] as string).slice(0, lineMax);
    if (used + l.length > total) break;
    used += l.length;
    kept.push(l);
  }
  return kept.reverse();
}

/** Parsers store tool results as `[tool_result elided: ok|error]` placeholders; only a result with real text beyond that counts as evidence. */
const TOOL_RESULT_PLACEHOLDER = /\[tool_result elided: (?:ok|error)\]/g;
function isRealToolText(t: TurnRow): boolean {
  return t.kind === "tool_result" && (t.text ?? "").replace(TOOL_RESULT_PLACEHOLDER, "").trim().length > 0;
}

/**
 * Evidence for the served-record verdicts and the questionnaire judge: the
 * session's prose lines plus any tool_result that carries real text (the
 * `[tool_result elided: ok|error]` placeholders are dropped). Today every
 * parser stores tool results only as that placeholder, so in practice the
 * evidence is prose alone and a record contradicted only by command output is
 * counted `unused` (a known undercount). Kept tool text is secret-redacted and
 * PII-redacted (redactPii, as feedback/merge do for prose they store) and cut
 * to SERVED_EVIDENCE_TOOL_RESULT_MAX_CHARS; tool_result lines past
 * SERVED_EVIDENCE_TOOL_RESULT_BUDGET_CHARS in total are dropped oldest first.
 * The same (redacted, cut) turns are returned for receipt matching, so a quote
 * the model copies from a shown line matches. Pure.
 */
export function servedVerdictEvidence(
  allTurns: readonly TurnRow[],
  isSubAgent: boolean,
): { lines: string[]; turns: TurnRow[] } {
  const evidence: TurnRow[] = [];
  let budget = SERVED_EVIDENCE_TOOL_RESULT_BUDGET_CHARS;
  const keepResult = new Set<number>();
  for (let i = allTurns.length - 1; i >= 0; i--) {
    const t = allTurns[i] as TurnRow;
    if (!isRealToolText(t)) continue;
    const len = Math.min((t.text ?? "").length, SERVED_EVIDENCE_TOOL_RESULT_MAX_CHARS);
    if (len > budget) break;
    budget -= len;
    keepResult.add(i);
  }
  allTurns.forEach((t, i) => {
    if (t.kind === "prose") evidence.push(t);
    else if (keepResult.has(i))
      evidence.push({
        ...t,
        text: redactPii(redactFileSecrets(t.text ?? "")).slice(0, SERVED_EVIDENCE_TOOL_RESULT_MAX_CHARS),
      });
  });
  const lines = selectBlockerReaskLines(
    renderTurnLines(evidence, { subAgent: isSubAgent }),
    [Number.NEGATIVE_INFINITY],
    BLOCKER_REASK_MAX_TAIL_LINES,
  );
  return { lines: capEvidenceLines(lines), turns: evidence };
}

/** The questionnaire judge runs only on the local claude-code provider (goal: "fresh judge (local provider)"). */
export function shouldRunQuestionnaireJudge(llm: Pick<LlmClient, "isClaudeCodeProvider">): boolean {
  return llm.isClaudeCodeProvider === true;
}

/** Later-session resolution: at most this many open blockers from earlier sessions are checked per run (most recent first). */
export const LATER_RESOLUTION_MAX_BLOCKERS = 20;
/** Review v6 R2-M1: a user-pass window holds the checkpoint for at most this many attempts (runs) in a row. */
export const USER_PASS_MAX_ATTEMPTS = 3;

export interface TailCaptureSummary {
  sessionId: string;
  skipped: boolean;
  windowsTotal: number;
  windowsExtracted: number;
  tailTurnsExtracted: number;
  budgetHit: boolean;
  droppedContainingUserProse: number;
  droppedPii: number;
  /** Issue #162 (renamed N2, review round 2): every ref that `applyDeterministicFixes` changed and kept — hallucination recovery, range-ref split, or a benign mis-copy fix, not hallucinations alone — so the caller can report a run that fixed records instead of just dropping them. */
  repairedRef: number;
  repairedPii: number;
  /** Issue #162 (retry-on-empty): windows whose valid-but-empty result got one identical-prompt retry. */
  retriedEmpty: number;
  /** Of `retriedEmpty`, retries that returned >=1 record. */
  retryRecovered: number;
  /** Retries skipped because the run was already over budget, or the retry's estimated cost didn't fit what was left of the session budget (RR-S1, review round 2). */
  retrySkippedBudget: number;
  /** RR-S2 (review round 2): retries that themselves threw — the first (empty) result and its cost were kept, the window is not marked failed. */
  retryFailed: number;
  recordsWritten: number;
  /** P10 round 3 R3-m2: records stored with `embedding: null` (their embed batch failed after the SDK retries). */
  embeddingMissing: number;
  /** D3 decision B: of `recordsWritten`, inserted live (grounded). */
  recordsVerified: number;
  /** D3 decision B: of `recordsWritten`, inserted already retired (`retire_reason = "unverified:<reason>"`). */
  recordsRetiredUnverified: number;
  costUsd: number;
  /** P10 re-review N3: main-pass windows plus user-pass windows whose LLM call failed this run. */
  windowsFailed: number;
  /** P10 re-review N2: `opts.shouldStop` fired, so later windows were not started (they stay uncovered for the next run). */
  deadlineHit: boolean;
  /** P10 re-review N1: another run holds this session's props lock — nothing was done. */
  lockHeld: boolean;
  /** True when this run moved `props.memory_checkpoint_turn_idx` forward (a resumed run made progress). */
  checkpointAdvanced: boolean;
  /** Sub-agent sessions: preference/blocker records dropped because they quoted the parent agent's brief (a role-"user" turn). */
  droppedSubagentBrief: number;
  /** Open blockers from earlier sessions this run retired as `resolved_later`. */
  blockersResolvedLater: number;
  /** The run re-derived the session's code_session_issues rows itself (the extracting path); otherwise the wrapper did, from actions and stored model rows. */
  issuesRederived?: boolean;
  /** Issue #339: the first failed window's class/status/timeout (content-free), set when `windowsFailed > 0`. */
  firstWindowFailure?: LlmCallFailure;
  /**
   * Issue #339: true when this run had window failures and EVERY one was a
   * content failure (reply cut off at the output limit; llm-failure.ts
   * isContentFailure), so waiting cannot help. Unset when there was none.
   */
  windowFailuresAllContent?: boolean;
}

function emptySummary(sessionId: string): TailCaptureSummary {
  return {
    sessionId,
    skipped: true,
    windowsTotal: 0,
    windowsExtracted: 0,
    tailTurnsExtracted: 0,
    budgetHit: false,
    droppedContainingUserProse: 0,
    droppedPii: 0,
    repairedRef: 0,
    repairedPii: 0,
    retriedEmpty: 0,
    retryRecovered: 0,
    retrySkippedBudget: 0,
    retryFailed: 0,
    recordsWritten: 0,
    embeddingMissing: 0,
    recordsVerified: 0,
    recordsRetiredUnverified: 0,
    costUsd: 0,
    windowsFailed: 0,
    deadlineHit: false,
    lockHeld: false,
    checkpointAdvanced: false,
    droppedSubagentBrief: 0,
    blockersResolvedLater: 0,
  };
}

/**
 * D-051 B16 (sub-agent fold): the sub-agent sessions this session spawned —
 * same user and source, `parent_source_session_id` = this session's
 * `source_session_id` — with the turns the profile builder reads and the
 * parent's spawn row (`props.subAgent.toolUseId`). Best-effort: a failed read
 * logs and folds nothing (the session's own actions still ground).
 */
export async function fetchChildSessionsForProfile(
  supabase: Db,
  userId: string,
  session: Pick<SessionRowWithProject, "id" | "source" | "source_session_id"> &
    Partial<Pick<SessionRowWithProject, "code_project_id">>,
): Promise<ProfileChildSession[]> {
  if (!session.source_session_id) return [];
  try {
    let q = supabase
      .from("code_sessions")
      .select("id, props, code_project_id")
      .eq("user_id", userId)
      .eq("parent_source_session_id", session.source_session_id);
    if (session.source) q = q.eq("source", session.source);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    const rows = (Array.isArray(data) ? data : []) as Array<{
      id: string;
      props?: Record<string, unknown> | null;
      code_project_id?: string | null;
    }>;
    const out: ProfileChildSession[] = [];
    for (const row of rows) {
      if (!row?.id || row.id === session.id) continue;
      const turns = (await selectAllRows((from, to) =>
        supabase
          .from("code_session_turns")
          .select("idx, role, kind, tool_name, file_path, props")
          .eq("session_id", row.id)
          .eq("user_id", userId)
          .order("idx", { ascending: true })
          .range(from, to),
      )) as ProfileTurnInput[];
      const sub = row.props?.subAgent as { toolUseId?: unknown } | undefined;
      // D-051 B2: a child filed under another project ran in another repo — its bare refs and
      // ref-less actions are that repo's, never the parent's (rows imported before per-action repos).
      const foreign =
        !!session.code_project_id && !!row.code_project_id && row.code_project_id !== session.code_project_id;
      out.push({
        id: row.id,
        spawnToolUseId: typeof sub?.toolUseId === "string" ? sub.toolUseId : null,
        turns: foreign ? turns.map(foreignChildTurn) : turns,
      });
    }
    return out;
  } catch (err) {
    log.warn("memory: child-session read failed — profile built from this session alone", {
      user_id: userId,
      session_id: session.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

const BARE_ITEM_REF = /^[#!]\d+$/;

/** D-051 B2: a child turn from another project, folded into the parent: only repo-qualified item refs keep counting. */
function foreignChildTurn(t: ProfileTurnInput): ProfileTurnInput {
  const props = t.props as { action?: unknown; actions?: unknown } | null | undefined;
  if (!props || typeof props !== "object") return t;
  const mark = (a: unknown): unknown => {
    if (!a || typeof a !== "object") return a;
    const r = a as Record<string, unknown>;
    const qualified =
      (r.refKind === "issue" || r.refKind === "merge_request") &&
      typeof r.ref === "string" &&
      !BARE_ITEM_REF.test(r.ref);
    if (!qualified) return { ...r, repoUnknown: true };
    // Its branch is the other repo's: it must never map a same-named branch of the parent's.
    const { branch: _branch, ...rest } = r;
    return rest;
  };
  return {
    ...t,
    props: {
      ...props,
      ...(props.action !== undefined ? { action: mark(props.action) } : {}),
      ...(Array.isArray(props.actions) ? { actions: props.actions.map(mark) } : {}),
    },
  } as ProfileTurnInput;
}

const SESSION_ROW_SELECT =
  "id, user_id, code_project_id, source, git_branch, model, started_at, ended_at, duration_seconds, files_touched, props, cwd, parent_source_session_id, source_session_id, short_title, code_projects(display_name, repo_identity)";

/** Stored tiers that came from the extractor, not from an action: the rows a re-derivation re-offers for grounding. */
const MODEL_TIERS = new Set<string | null>([null, "discussed", "inferred"]);

/**
 * The session's stored MODEL rows (tier discussed / inferred / pre-W4 null),
 * as extractor entries to ground again. Observed and inferred_ref rows are not
 * carried: the profile re-derives them from the turns' actions, so a row whose
 * action changed or vanished is not re-offered. A carried row survives only
 * if it still grounds under the current rules (groundSessionIssues).
 */
async function storedModelIssues(supabase: Db, userId: string, sessionId: string): Promise<SessionIssueParsed[]> {
  const { data, error } = await supabase
    .from("code_session_issues")
    .select("ref, kind, role, evidence_quote, tier")
    .eq("user_id", userId)
    .eq("session_id", sessionId);
  if (error) throw new Error(`storedModelIssues: read failed: ${error.message}`);
  const out: SessionIssueParsed[] = [];
  for (const r of (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>) {
    if (!MODEL_TIERS.has((r.tier as string | null | undefined) ?? null)) continue;
    const parsed = parseSessionIssues([
      {
        ref: r.ref,
        kind: r.kind,
        role: r.role === "worked_on" || r.role === "referenced" ? r.role : undefined,
        evidence_quote: r.evidence_quote,
      },
    ]);
    out.push(...parsed);
  }
  return out;
}

/**
 * Re-derive a session's code_session_issues rows and replace the stored set
 * with them (goal 2026-09-27 re-derive): the extractor's refs from this run
 * (`fresh`) plus — unless this run covered the session from its first turn —
 * the stored model rows, all grounded again against ALL the session's turns
 * and its sub-agents' turns (D-051 B16), merged with what the actions
 * observably did. The writer then deletes every stored row not derived again,
 * so a re-upload that changed the actions (or a rule that changed) never
 * leaves a stale row behind. Never fails the caller: a write error logs and
 * returns 0.
 */
export async function rederiveSessionIssues(
  supabase: Db,
  userId: string,
  sessionRow: SessionRowWithProject,
  allTurns: readonly TurnRow[],
  fresh: readonly SessionIssueParsed[],
  opts: {
    fullRun: boolean;
    /**
     * D-057: the extraction run's LLM, the USD left of its session budget, and where its spend
     * goes — the session-issue association may call the model only with this (MEMBRAL_SESSION_ASSOC
     * on). Without it, a stored answer for the same turns is re-applied, never a new call.
     */
    association?: { llm: LlmClient; budgetUsd: number; onCost: (usd: number) => void };
  },
): Promise<number> {
  try {
    const carried = opts.fullRun ? [] : await storedModelIssues(supabase, userId, sessionRow.id);
    const actionsVersion = sessionRow.props?.actions_version;
    // D-051 B16: a sub-agent's commit/push folds into this session's profile.
    const childSessions = await fetchChildSessionsForProfile(supabase, userId, sessionRow);
    // D-055: branch → MR lineage from earlier sessions, and the start/default branch for the guard.
    const lineage = await fetchBranchLineage(supabase, userId, sessionRow);
    const trace: { value?: ProfileTrace } = {};
    let grounded = groundSessionIssues([...fresh, ...carried], allTurns, projectIdentity(sessionRow), {
      actionsVersion: typeof actionsVersion === "number" ? actionsVersion : null,
      // D-053: a sub-agent's "user" lines are the parent agent's words, never the developer's.
      subAgent: !!sessionRow.parent_source_session_id,
      childSessions,
      knownBranches: lineage.knownBranches,
      startBranch: sessionRow.git_branch,
      defaultBranch: lineage.defaultBranch,
      trace,
    });
    // D-057: build work no observed evidence linked, linked by the model's reading of the
    // session — behind MEMBRAL_SESSION_ASSOC (OFF by default). A sub-agent session is never
    // asked: its actions fold into its parent's (B16), whose association covers them.
    const withAssociation = sessionAssocEnabled();
    if (withAssociation && !sessionRow.parent_source_session_id && trace.value) {
      const assoc = await associateSession({
        supabase,
        userId,
        session: sessionRow,
        projectIdentity: projectIdentity(sessionRow),
        turns: allTurns,
        childSessions,
        trace: trace.value,
        rows: grounded,
        // NB1: associated only once the session is idle (never mid-session).
        lastActivityAt:
          latestTimestamp(allTurns.map((t) => t.ts)) ?? sessionRow.ended_at ?? sessionRow.started_at ?? null,
        llm: opts.association?.llm,
        budgetUsd: opts.association?.budgetUsd,
      });
      grounded = assoc.rows;
      if (assoc.costUsd > 0) opts.association?.onCost(assoc.costUsd);
    }
    return await writeSessionIssueRows(supabase, userId, sessionRow.id, grounded, true, { withAssociation });
  } catch (err) {
    log.warn("memory: session issues write failed — memories unaffected", {
      session_id: sessionRow.id,
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/**
 * No-LLM re-derivation of one session's issue rows (a run that extracted
 * nothing, or a parent whose sub-agent was re-uploaded): reads the session and
 * its turns and calls rederiveSessionIssues with the stored model rows only.
 * Skips a session whose extraction lock is held (that run writes the rows).
 * Never throws.
 */
export async function rederiveStoredSessionIssues(
  supabase: Db,
  userId: string,
  sessionId: string,
  newId: () => string = randomUUID,
): Promise<number> {
  try {
    const res = await supabase
      .from("code_sessions")
      .select(SESSION_ROW_SELECT)
      .eq("id", sessionId)
      .eq("user_id", userId)
      .maybeSingle();
    if (res.error) throw new Error(res.error.message);
    const row = res.data as SessionRowWithProject | null;
    if (!row || isMemoryExtractionLockHeld(row.props ?? {})) return 0;
    // S2: hold the session's extraction lock across read -> ground -> write,
    // so an extraction run (queue or backfill) never has its fresh rows
    // replaced by this re-derivation mid-write. Taken, then confirmed ours.
    const runId = `rederive:${newId()}`;
    await setMemoryExtractionLock(supabase, userId, sessionId, row.props ?? {}, runId);
    try {
      const again = await supabase
        .from("code_sessions")
        .select("props")
        .eq("id", sessionId)
        .eq("user_id", userId)
        .maybeSingle();
      const lock = (again.data as { props?: { memory_extraction_lock?: { run_id?: unknown } } } | null)?.props
        ?.memory_extraction_lock;
      if (again.error || lock?.run_id !== runId) return 0;
      const turns = (await selectAllRows((from, to) =>
        supabase
          .from("code_session_turns")
          .select("idx, role, kind, text, tool_name, file_path, ts, props")
          .eq("session_id", sessionId)
          .eq("user_id", userId)
          .order("idx", { ascending: true })
          .range(from, to),
      )) as TurnRow[];
      return await rederiveSessionIssues(supabase, userId, row, turns, [], { fullRun: false });
    } finally {
      await releaseMemoryExtractionLock(supabase, userId, sessionId, runId);
    }
  } catch (err) {
    log.warn("memory: session issues re-derive failed", {
      session_id: sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

interface SessionRowWithProject {
  id: string;
  user_id: string;
  code_project_id: string;
  source: string | null;
  git_branch: string | null;
  model: string | null;
  started_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  files_touched: string[];
  props: Record<string, unknown> | null;
  cwd: string | null;
  /** Set for a sub-agent session (migration 089) — its role-"user" turns are the parent agent's brief. */
  parent_source_session_id?: string | null;
  /** The harness's own session id — a sub-agent's `parent_source_session_id` points at it (B16 child fold). */
  source_session_id?: string | null;
  /** Migration 110's 3-8 word title; copied onto each record as `session_title` (migration 122, lexical index only). */
  short_title?: string | null;
  code_projects: ProjectEmbed | ProjectEmbed[] | null;
}

type ProjectEmbed = { display_name: string | null; repo_identity?: string | null };

/**
 * step2d finding 7: retires exactly `priorLiveIds` (captured before this run
 * started) and returns the `previous` bookkeeping for `props.memory_extraction`
 * — a no-op (returns `undefined`) unless this is a force run that actually
 * found prior live rows to retire. Shared by the "nothing to extract, but
 * force determined so decisively" branches (empty session, no-prose tail)
 * and the main extraction path below (where `idsToRetire` first excludes
 * whatever the new insert reused via upsert-on-conflict).
 */
async function retirePriorForForce(
  supabase: Db,
  userId: string,
  previousExtraction: MemoryExtractionProps | null,
  priorLiveIds: string[],
  priorUnverifiedIds: string[] = [],
): Promise<MemoryExtractionProps["previous"]> {
  if (!previousExtraction) return undefined;
  await retagUnverifiedAsRerun(supabase, userId, priorUnverifiedIds);
  if (priorLiveIds.length === 0) return undefined;
  const { retiredIds, retiredAt } = await retireRowsByIds(supabase, userId, priorLiveIds);
  return { prompt_version: previousExtraction.prompt_version, records: retiredIds.length, retired_at: retiredAt };
}

/**
 * Branch-state rows (migration 084) for the blockers whose `ref` could be a
 * branch — closure evidence for observed retirement (merged AND gone).
 * Best effort: a lookup failure yields none, never an error.
 */
async function fetchClosedBranchStates(
  supabase: Db,
  userId: string,
  codeProjectId: string | null,
  blockers: ReadonlyArray<{ ref: string | null }>,
): Promise<ObservedBranchState[]> {
  const branches = [
    ...new Set(
      blockers
        .map((b) => (typeof b.ref === "string" ? b.ref.trim() : ""))
        .filter((r) => r && !/[#!]\d+$/.test(r) && !/^[0-9a-f]{7,40}$/i.test(r)),
    ),
  ];
  if (!codeProjectId || branches.length === 0) return [];
  try {
    const { data, error } = await supabase
      .from(BRANCH_STATE_TABLE)
      .select("branch, merged_at, branch_gone_at")
      .eq("user_id", userId)
      .eq("code_project_id", codeProjectId)
      .in("branch", branches);
    if (error) throw new Error(error.message);
    return (data ?? []) as ObservedBranchState[];
  } catch (err) {
    log.warn("memory: branch-state lookup for observed retirement failed — skipped", {
      user_id: userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

/** D-055: earlier sessions of the same project read for branch → MR lineage (most recent first). */
const LINEAGE_SESSIONS = 50;
/** Sessions this far back are read for closure / conflict evidence on a mapping. */
const LINEAGE_DAYS = 90;
/** L3: a branch → MR mapping must be (re-)observed in a session this recent to hold. */
const LINEAGE_FRESH_DAYS = 14;
/** Branch-state rows read for dead branches (merged into another, or gone). */
const LINEAGE_BRANCH_STATE_ROWS = 1000;

/**
 * D-055: open-MR source branches from this user's EARLIER sessions of the
 * same project (their action turns: opened_mr head, view/checkout source
 * branch) — a mapping needs a session inside LINEAGE_FRESH_DAYS, and a branch
 * `memory_branch_state` saw merged or gone never maps (L3) — and the project's
 * default branch when a sweep proved one
 * (`memory_branch_state.merged_into`). Best effort: a lookup failure yields
 * none, never an error — lineage then uses this session alone.
 */
export async function fetchBranchLineage(
  supabase: Db,
  userId: string,
  session: Pick<SessionRowWithProject, "id" | "code_project_id" | "started_at">,
): Promise<{ knownBranches: KnownBranchMr[]; defaultBranch: string | null }> {
  if (!session.code_project_id) return { knownBranches: [], defaultBranch: null };
  let knownBranches: KnownBranchMr[] = [];
  let defaultBranch: string | null = null;
  // L3: a branch a sweep saw merged into another or gone never maps to an open MR.
  const deadBranches = new Set<string>();
  try {
    const { data, error } = await supabase
      .from(BRANCH_STATE_TABLE)
      .select("branch, merged_into, branch_gone_at")
      .eq("user_id", userId)
      .eq("code_project_id", session.code_project_id)
      .limit(LINEAGE_BRANCH_STATE_ROWS);
    if (error) throw new Error(error.message);
    for (const r of (Array.isArray(data) ? data : []) as Array<Record<string, unknown>>) {
      const merged = typeof r.merged_into === "string" && r.merged_into ? r.merged_into : null;
      if (merged && defaultBranch === null) defaultBranch = merged;
      if ((merged || r.branch_gone_at) && typeof r.branch === "string" && r.branch) deadBranches.add(r.branch);
    }
  } catch {
    // Unknown default branch: profile.ts treats main/master as default; no dead branches known.
  }
  try {
    // #176: anchor the window on the session's own started_at, same as the
    // fresh window below — not on wall-clock Date.now(), which for an old
    // session pulls `since` forward past `started_at` and wrongly excludes
    // earlier same-project sessions that are inside the intended 90-day
    // window measured from started_at.
    const parsedStartedAt = session.started_at ? Date.parse(session.started_at) : Date.now();
    const anchor = Number.isFinite(parsedStartedAt) ? parsedStartedAt : Date.now();
    const since = new Date(anchor - LINEAGE_DAYS * 24 * 60 * 60_000).toISOString();
    let q = supabase
      .from("code_sessions")
      .select("id, started_at")
      .eq("user_id", userId)
      .eq("code_project_id", session.code_project_id)
      .neq("id", session.id)
      .gte("started_at", since);
    if (session.started_at) q = q.lte("started_at", session.started_at);
    const { data, error } = await q.order("started_at", { ascending: false }).limit(LINEAGE_SESSIONS);
    if (error) throw new Error(error.message);
    const rows = (Array.isArray(data) ? data : []) as Array<{ id: string; started_at: string | null }>;
    const order = new Map(rows.map((r, i) => [r.id, rows.length - i]));
    // L3: only a session inside the fresh window can create a mapping; older ones can still close one.
    const freshSince = anchor - LINEAGE_FRESH_DAYS * 24 * 60 * 60_000;
    const freshIds = new Set(
      rows.filter((r) => r.started_at !== null && Date.parse(r.started_at) >= freshSince).map((r) => r.id),
    );
    if (rows.length > 0) {
      const turns = (await selectAllRows((from, to) =>
        supabase
          .from("code_session_turns")
          .select("session_id, idx, props")
          .eq("user_id", userId)
          .in(
            "session_id",
            rows.map((r) => r.id),
          )
          .not("props->action", "is", null)
          .order("session_id", { ascending: true })
          .order("idx", { ascending: true })
          .range(from, to),
      )) as Array<{ session_id: string; idx: number; props: ProfileTurnInput["props"] }>;
      turns.sort((a, b) => (order.get(a.session_id) ?? 0) - (order.get(b.session_id) ?? 0) || a.idx - b.idx);
      knownBranches = knownBranchesFromTurns(
        turns.map((t) => ({ props: t.props, fresh: freshIds.has(t.session_id) })),
        { defaultBranch, deadBranches },
      );
    }
  } catch (err) {
    log.warn("memory: branch lineage lookup failed — this session's own lineage only", {
      user_id: userId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
  return { knownBranches, defaultBranch };
}

/** The identity a bare "#N" issue ref is qualified with — code_projects.repo_identity, else the project id. */
function projectIdentity(row: SessionRowWithProject): string {
  const cp = Array.isArray(row.code_projects) ? row.code_projects[0] : row.code_projects;
  return cp?.repo_identity || `code-project:${row.code_project_id}`;
}

function projectDisplayName(row: SessionRowWithProject): string | null {
  const cp = row.code_projects;
  if (!cp) return null;
  return Array.isArray(cp) ? (cp[0]?.display_name ?? null) : (cp.display_name ?? null);
}

/** The latest parseable timestamp in `values`, as given (null when none parses). */
function latestTimestamp(values: ReadonlyArray<string | null>): string | null {
  let best: { ts: string; ms: number } | null = null;
  for (const v of values) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (Number.isFinite(ms) && (!best || ms > best.ms)) best = { ts: v, ms };
  }
  return best?.ts ?? null;
}

export interface TailCaptureDeps {
  supabase: Db;
  llm: LlmClient;
  /** Clock seam (G2 2.3a): every timestamp the run stamps. Default `new Date()`. */
  now?: () => Date;
  /** Id seam (G2 2.3a): for ids the run mints. Default `randomUUID`. */
  newId?: () => string;
}

const defaultNow = (): Date => new Date();

/**
 * Runs tail capture for ONE session. Idempotent and incremental: reads
 * `props.memory_checkpoint_turn_idx` to find the uncovered tail, and no-ops
 * (without touching `props`) when there is genuinely nothing new since the
 * last run. Never throws on a per-window extraction failure (extract.ts
 * already degrades those to zero records) — DOES throw on a hard DB read/
 * write failure, since that's a real bug the caller (backfill script or the
 * upload hook) needs to see and log, not silently swallow mid-session.
 *
 * `opts.force` (step2b, one-repo re-run): ignores the stored checkpoint —
 * the WHOLE session is re-windowed and re-extracted under the CURRENT
 * `PROMPT_VERSION`, regardless of what a prior run already covered.
 * step2d finding 7: the prior run's live `source='extractor'` rows are
 * retired only AFTER the new rows are successfully inserted (extract ->
 * embed -> insert -> retire), targeting exactly the ids captured before
 * this run started — never a blanket "all live extractor rows", which
 * would also retire the rows this run just wrote. If insert throws,
 * nothing is retired. `props.memory_extraction.previous` records what was
 * retired (`{prompt_version, records, retired_at}`) so a before/after
 * comparison never needs to guess which rows were which.
 */
export async function runTailCaptureForSession(
  deps: TailCaptureDeps,
  userId: string,
  sessionId: string,
  opts: Parameters<typeof runTailCaptureInner>[3] = { runId: "manual" },
): Promise<TailCaptureSummary> {
  const summary = await runTailCaptureInner(deps, userId, sessionId, opts);
  // A run that extracted nothing (no new turns, a no-prose tail, an empty
  // session) still re-derives the session's issue rows: a re-upload can change
  // the turns' actions (or a sub-agent's) without adding a turn, and the rows
  // must follow what the current code derives, not what an earlier run wrote.
  if (!summary.lockHeld && !summary.issuesRederived) {
    await rederiveStoredSessionIssues(deps.supabase, userId, sessionId, deps.newId ?? randomUUID);
  }
  return summary;
}

/** Per-run options of `runTailCaptureInner` (moved verbatim from its inline parameter type). */
interface TailCaptureRunOpts {
  runId: string;
  sessionBudgetUsd?: number;
  force?: boolean;
  /**
   * Open-weight trial (2026-09-24): `false` turns the whole user-turn pass
   * (D3 decision C2/C3) off for this run — no `extractUserTurnPass` calls,
   * no cost, no records from it. Default `true` (today's behavior).
   * S3 fix (review round 2, issue #162): an OFF user pass must NEVER
   * advance the checkpoint past turns it hasn't covered — every turn in
   * this run's user-pass range is treated as uncovered (same as if every
   * window in it had failed), so the checkpoint holds back to just before
   * it. A later default (`userPass: true`) run still covers those turns
   * with no `--force` needed; the cost is that the MAIN pass re-extracts
   * that same range next run too (the checkpoint is shared between both
   * passes) — accepted, since silently never covering those turns is
   * worse than a bounded re-extraction.
   */
  userPass?: boolean;
  /**
   * P10 re-review N2: checked before each LLM window, with the pass it is
   * about to run. Once true, no further window of that pass starts; the
   * ones not run are treated like failed windows for the checkpoint (it
   * stops before them), so the next run resumes there. What already ran is
   * still grounded, embedded and written. The caller should stop "main"
   * earlier than "user": the checkpoint only passes turns BOTH passes
   * covered, so a user pass cut off entirely means no progress at all.
   * A window's retry-on-empty call is checked against its own pass too
   * (P10 round 3 R3-m1): past the cutoff the retry is skipped.
   * "reask" is checked before the blocker re-ask: when it fires, the
   * re-ask is skipped and the blockers are kept as extracted — the run
   * still writes. "embed" is checked before the embedding call: when it
   * fires, the run writes nothing (records need embeddings), releases the
   * props lock and returns deadlineHit with no progress. The caller sets
   * "embed" at least one worst-case chat call after "reask", so a re-ask
   * that started never trips it.
   * Default: never stop.
   */
  shouldStop?: (pass: "main" | "user" | "reask" | "embed") => boolean;
  /** Issue #339: the queue attempt this run is (1-based), for the per-window failure log only. */
  attempt?: number;
}

/** Issue #339: cap on the provider `code` / `type` fields of a failed-window line. */
const WINDOW_FAILURE_FIELD_MAX_CHARS = 64;

/**
 * Issue #339: the ONE log line per failed window — which window, of how many,
 * and what the call threw (class, provider status, timeout, latency). Every
 * field is an id, a count or llm-failure.ts's content-free description: no
 * prompt, transcript, quote or key. The first failure of the run is kept on
 * `state` so the queue's session-level `fail` line can carry it.
 */
function recordWindowFailure(
  state: RunState,
  pass: "main" | "user",
  windowIndex: number,
  windowsTotal: number,
  failure: LlmCallFailure | undefined,
): void {
  const f: LlmCallFailure = failure ?? {
    errorClass: "unknown",
    message: "no_failure_detail",
    isTimeout: false,
    latencyMs: 0,
  };
  state.firstWindowFailure ??= f;
  if (isContentFailure(failure)) state.contentWindowFailures = (state.contentWindowFailures ?? 0) + 1;
  else state.otherWindowFailures = (state.otherWindowFailures ?? 0) + 1;
  log.warn("memory: extraction window failed", {
    session_id: state.sessionId,
    pass,
    window_index: windowIndex,
    windows_total: windowsTotal,
    error_class: f.errorClass,
    error_message: f.message,
    status: f.status ?? null,
    // 57a4895 captured these; content-free provider identifiers, capped again here.
    error_code: f.code?.slice(0, WINDOW_FAILURE_FIELD_MAX_CHARS) ?? null,
    error_type: f.type?.slice(0, WINDOW_FAILURE_FIELD_MAX_CHARS) ?? null,
    is_timeout: f.isTimeout,
    latency_ms: f.latencyMs,
    attempt: state.opts.attempt ?? null,
  });
}

/**
 * Issue #339: one `[memory-extraction]` line per window whose reply was cut off
 * at the output limit but kept its complete records (the window counts as
 * extracted). Counts only, never reply text.
 */
function recordWindowSalvage(state: RunState, windowIndex: number, truncated: TruncatedWindowInfo | undefined): void {
  if (!truncated) return;
  logMemoryExtraction({
    event: "salvage",
    reason: "output_truncated",
    userId: state.userId,
    sessionId: state.sessionId,
    windowIndex,
    recordsRecovered: truncated.recordsRecovered,
    tokensOut: truncated.tokensOut,
    attempt: state.opts.attempt,
  });
}

/**
 * G2 2.3: the locals the phases of `runTailCaptureInner` share, as one plain
 * object. Built by the load phase; later phases read it (and, from 2.3b on,
 * write the fields they own). No class, no getters.
 */
interface RunState {
  userId: string;
  sessionId: string;
  opts: TailCaptureRunOpts;
  sessionRow: SessionRowWithProject;
  isSubAgent: boolean;
  /** Live props; reassigned by the caller when the lease lock is taken and at write-back. */
  props: Record<string, unknown>;
  /** The snapshot this run started from: only memory_* keys changed from it are written back. */
  baseProps: Record<string, unknown>;
  checkpoint: number | null;
  previousExtraction: MemoryExtractionProps | null;
  priorLiveIdsForForce: string[];
  priorUnverifiedIdsForForce: string[];
  allTurns: TurnRow[];
  tailTurns: TurnRow[];
  /** Written by the main-pass phase (G2 2.3c); unset before it runs. */
  mainPass?: MainPassState;
  /** Written by the user-pass phase (G2 2.3d); unset before it runs. */
  userPass?: UserPassState;
  /** Written by the blocker-checks phase (G2 2.3e); unset before it runs. */
  blockerChecks?: BlockerChecksState;
  /** Written by the persist phase (G2 2.3f); unset before it runs. */
  persist?: PersistState;
  /** Written by the issues phase (G2 2.3g); unset before it runs. */
  issues?: IssuesState;
  /** Issue #339: the first failed window's content-free description (recordWindowFailure). */
  firstWindowFailure?: LlmCallFailure;
  /** Issue #339: failed windows whose failure was a content failure / anything else (recordWindowFailure). */
  contentWindowFailures?: number;
  otherWindowFailures?: number;
}

/**
 * Phase "load" (G2 2.3a): reads the session row, the prior extraction
 * snapshot, the prior live/unverified row ids a force run retires, and every
 * turn; computes the uncovered tail. Reads only — no writes, no lock. Body
 * moved verbatim from `runTailCaptureInner`; the only change is that the
 * locals later phases need are returned as a `RunState`.
 */
async function loadPhase(
  deps: TailCaptureDeps,
  userId: string,
  sessionId: string,
  opts: TailCaptureRunOpts,
): Promise<RunState> {
  const sessionRes = await deps.supabase
    .from("code_sessions")
    .select(SESSION_ROW_SELECT)
    .eq("id", sessionId)
    .eq("user_id", userId)
    .maybeSingle();
  if (sessionRes.error) throw new Error(`runTailCaptureForSession: session read failed: ${sessionRes.error.message}`);
  const sessionRow = sessionRes.data as SessionRowWithProject | null;
  if (!sessionRow) throw new Error(`runTailCaptureForSession: no such session ${sessionId} for user ${userId}`);
  // A sub-agent session's role-"user" turns are the PARENT agent's brief,
  // never the owner: rendered as "parent_agent", no user-turn pass, and any
  // preference/blocker quoting one is dropped after grounding.
  const isSubAgent = !!sessionRow.parent_source_session_id;

  const props = sessionRow.props ?? {};
  /** The snapshot this run started from: only memory_* keys changed from it are written back. */
  const baseProps = props;
  const storedCheckpoint =
    typeof props.memory_checkpoint_turn_idx === "number" ? props.memory_checkpoint_turn_idx : null;
  const checkpoint = opts.force ? null : storedCheckpoint;

  const previousExtraction =
    props.memory_extraction && typeof props.memory_extraction === "object"
      ? (props.memory_extraction as MemoryExtractionProps)
      : null;

  // step2d finding 7: capture which rows are live BEFORE this run starts —
  // these (and only these) are what a successful force re-run retires,
  // AFTER its own new rows are already inserted and live. A plain read, no
  // mutation — safe to do even for a run that ends up no-op'ing below.
  let priorLiveIdsForForce: string[] = [];
  let priorUnverifiedIdsForForce: string[] = [];
  if (opts.force && previousExtraction) {
    const priorRes = await deps.supabase
      .from("session_memories")
      .select("id")
      .eq("user_id", userId)
      .eq("code_session_id", sessionId)
      .eq("source", "extractor")
      .is("retired_at", null);
    if (priorRes.error) {
      throw new Error(`runTailCaptureForSession: prior-live-rows read failed: ${priorRes.error.message}`);
    }
    priorLiveIdsForForce = ((priorRes.data ?? []) as Array<{ id: string }>).map((r) => r.id);
    // Review v6 M1: the replaced extraction's rows that were already
    // retired as unverified — re-tagged `rerun` after this run's insert so
    // `--reverify` can never resurrect them.
    const priorRetiredRes = await deps.supabase
      .from("session_memories")
      .select("id, retire_reason")
      .eq("user_id", userId)
      .eq("code_session_id", sessionId)
      .eq("source", "extractor")
      .not("retired_at", "is", null);
    if (priorRetiredRes.error) {
      throw new Error(`runTailCaptureForSession: prior-retired-rows read failed: ${priorRetiredRes.error.message}`);
    }
    priorUnverifiedIdsForForce = ((priorRetiredRes.data ?? []) as Array<{ id: string; retire_reason: string | null }>)
      .filter((r) => isRetiredUnverified(r.retire_reason))
      .map((r) => r.id);
  }

  const allTurns = (await selectAllRows((from, to) =>
    deps.supabase
      .from("code_session_turns")
      .select("idx, role, kind, text, tool_name, file_path, ts, props")
      .eq("session_id", sessionId)
      // step2d finding 14: scoped by user_id too — belt and braces, free on
      // a service-role client, matching every other read/write in this
      // module. Safe today because sessionRow above was already read with
      // .eq("user_id", userId), but this no longer depends on that
      // invariant holding upstream.
      .eq("user_id", userId)
      .order("idx", { ascending: true })
      .range(from, to),
  )) as TurnRow[];

  const tailTurns = allTurns.filter((t) => checkpoint === null || t.idx > checkpoint);

  return {
    userId,
    sessionId,
    opts,
    sessionRow,
    isSubAgent,
    props,
    baseProps,
    checkpoint,
    previousExtraction,
    priorLiveIdsForForce,
    priorUnverifiedIdsForForce,
    allTurns,
    tailTurns,
  };
}

/** What `leasePhase` tells the caller: return `result` as-is, or carry on. */
type LeaseOutcome = { kind: "skip"; result: TailCaptureSummary } | { kind: "continue" };

/**
 * Phase "lease" (G2 2.3b): the gate before any real work. A fully covered
 * tail is a no-op; a session with no turns at all is stamped once; a held
 * lease lock skips the run; otherwise the lock is taken and `state.props`
 * becomes the props returned by `setMemoryExtractionLock`. Body moved
 * verbatim from `runTailCaptureInner`; each early `return` is a `skip`
 * sentinel carrying the identical summary, which the caller returns.
 */
async function leasePhase(state: RunState, deps: TailCaptureDeps): Promise<LeaseOutcome> {
  const { userId, sessionId, opts, baseProps, checkpoint, previousExtraction } = state;
  const { priorLiveIdsForForce, priorUnverifiedIdsForForce, tailTurns } = state;
  const props = state.props;
  const now = deps.now ?? defaultNow;

  if (tailTurns.length === 0) {
    if (checkpoint !== null) {
      // Already fully covered — genuinely nothing new. Do not touch props
      // (and never acquire the lease lock for a run that writes nothing).
      return { kind: "skip", result: emptySummary(sessionId) };
    }
    // checkpoint is null AND there are no turns at all: a genuinely empty
    // session. Stamp it once so D2's "props.memory_extraction present"
    // count reflects that this session was considered, not skipped forever.
    const extraction: MemoryExtractionProps = {
      windows_total: 0,
      windows_extracted: 0,
      tail_turns_extracted: 0,
      budget_hit: false,
      records: 0,
      prompt_version: PROMPT_VERSION,
      run_id: opts.runId,
      at: now().toISOString(),
      windows_dropped_user_prose: 0,
      dropped_pii: 0,
      previous: await retirePriorForForce(
        deps.supabase,
        userId,
        previousExtraction,
        priorLiveIdsForForce,
        priorUnverifiedIdsForForce,
      ),
    };
    await updateSessionMemoryProps(deps.supabase, userId, sessionId, props, extraction, null, {
      baseProps,
      runId: opts.runId,
    });
    return { kind: "skip", result: { ...emptySummary(sessionId), skipped: false } };
  }

  // step2d finding 3: from here on this run WILL either write props (via
  // updateSessionMemoryProps, which always clears the lock again) or throw
  // (runTailCaptureInner releases the lock before rethrowing), so this is the right
  // place to check/acquire it, never earlier (a no-op run above never locks
  // anything) and never later (every remaining path below does real work).
  if (isMemoryExtractionLockHeld(props)) {
    log.info("memory: tail capture skipped — lease lock held by a concurrent/recent run", {
      user_id: userId,
      session_id: sessionId,
      lock: props.memory_extraction_lock,
    });
    return { kind: "skip", result: { ...emptySummary(sessionId), lockHeld: true } };
  }
  state.props = await setMemoryExtractionLock(deps.supabase, userId, sessionId, props, opts.runId);
  return { kind: "continue" };
}

/**
 * What the main pass (G2 2.3c) hands the rest of the run: the header and
 * windows the user pass reuses, the window bookkeeping, the raw records and
 * issues, the running counters the user pass keeps adding to, and the
 * checkpoint the main pass alone reached.
 */
interface MainPassState {
  header: ReturnType<typeof renderSessionHeader>;
  openBlockers: Awaited<ReturnType<typeof fetchOpenBlockersForRecurrence>>;
  turnLines: ReturnType<typeof renderTurnLines>;
  windows: ReturnType<typeof buildWindows>;
  sessionBudgetUsd: number;
  degrade: ReturnType<typeof selectWindowsWithinBudget>;
  extractionCostUsd: number;
  droppedPii: number;
  droppedOwnerVoice: number;
  droppedSubagentBrief: number;
  droppedNarration: number;
  droppedHallucinatedRef: number;
  durableDefaulted: number;
  repairedRef: number;
  repairedPii: number;
  retriedEmpty: number;
  retryRecovered: number;
  retrySkippedBudget: number;
  retryFailed: number;
  failedWindowIndexes: Set<number>;
  deadlineSkippedIndexes: Set<number>;
  /** Issue #339: main-pass windows whose cut-off reply was salvaged (their issues may be lost past the cut). */
  truncatedWindowIndexes: Set<number>;
  shouldStop: (pass: "main" | "user" | "reask" | "embed") => boolean;
  deadlineHit: boolean;
  rawGrounded: GroundedRecord[];
  rawIssues: SessionIssueParsed[];
  /** v24: feedback about Membral the windows returned, schema-valid but ungrounded (feedback.ts). */
  rawFeedback: FeedbackParsed[];
  checkpointIdx: number | null;
}

type MainPassOutcome = { kind: "skip"; result: TailCaptureSummary } | { kind: "continue"; mainPass: MainPassState };

/**
 * Phase "main pass" (G2 2.3c): the no-prose gate (stamps and skips a tail
 * with no prose turns), then the header, precontext and open blockers, the
 * budgeted windows, one `extractWindow` call per selected window in order,
 * deterministic fixes and grounding of each record, and the checkpoint the
 * main pass alone reached. Body moved verbatim from `runTailCaptureInner`;
 * the early `return` is a `skip` sentinel carrying the identical summary,
 * and the locals later passes need are stored as `state.mainPass`.
 */
async function mainPassPhase(state: RunState, deps: TailCaptureDeps): Promise<MainPassOutcome> {
  const { userId, sessionId, opts, sessionRow, isSubAgent, baseProps, checkpoint, previousExtraction } = state;
  const { priorLiveIdsForForce, priorUnverifiedIdsForForce, allTurns, tailTurns } = state;
  const props = state.props;
  const now = deps.now ?? defaultNow;

  // step2d finding 17: a session with source recorded reads its OWN source
  // for the header instead of a hardcoded "claude-code" (self-flagged in
  // step2.md) — falls back to "claude-code" only when the column is
  // genuinely null (older rows imported before this was backfilled).
  const source = sessionRow.source ?? "claude-code";

  // step2d finding 17: a tail with zero prose turns (either role) can only
  // ever cost money for no possible yield (the narration/preference/outcome
  // rules all require SOMEONE'S words to ground a record on) — skip
  // extraction entirely, no LLM call, but still advance the checkpoint past
  // these turns so the next upload doesn't re-check the same all-tool-calls
  // stretch forever.
  if (!tailTurns.some((t) => t.kind === "prose")) {
    const lastIdx = Math.max(...tailTurns.map((t) => t.idx));
    const extraction: MemoryExtractionProps = {
      windows_total: 0,
      windows_extracted: 0,
      tail_turns_extracted: 0,
      budget_hit: false,
      records: 0,
      prompt_version: PROMPT_VERSION,
      run_id: opts.runId,
      at: now().toISOString(),
      windows_dropped_user_prose: 0,
      dropped_pii: 0,
      skipped: "no_prose",
      previous: await retirePriorForForce(
        deps.supabase,
        userId,
        previousExtraction,
        priorLiveIdsForForce,
        priorUnverifiedIdsForForce,
      ),
    };
    await updateSessionMemoryProps(deps.supabase, userId, sessionId, props, extraction, lastIdx, {
      baseProps,
      runId: opts.runId,
    });
    return { kind: "skip", result: { ...emptySummary(sessionId), skipped: false, checkpointAdvanced: true } };
  }

  const sessionForHeader: CodeSessionRow = {
    id: sessionRow.id,
    user_id: sessionRow.user_id,
    code_project_id: sessionRow.code_project_id,
    source,
    source_session_id: sessionRow.id,
    git_branch: sessionRow.git_branch,
    model: sessionRow.model,
    started_at: sessionRow.started_at,
    ended_at: sessionRow.ended_at,
    duration_seconds: sessionRow.duration_seconds,
    files_touched: sessionRow.files_touched ?? [],
    props,
    project_display_name: projectDisplayName(sessionRow),
  };
  const renderedHeader = renderSessionHeader(sessionForHeader, allTurns);
  const header = isSubAgent ? { ...renderedHeader, text: `${renderedHeader.text}${SUB_AGENT_NOTE}` } : renderedHeader;
  const precontext: ChatPrecontextLine[] = await fetchChatPrecontext(deps.supabase, userId, sessionRow.code_project_id);
  // Prompt v12: this project's open blockers from other sessions, offered to
  // every main-pass window so the model can say `recurs_of` in context.
  const openBlockers = await fetchOpenBlockersForRecurrence(
    deps.supabase,
    userId,
    sessionRow.code_project_id,
    sessionId,
    MAX_OPEN_BLOCKERS_OFFERED,
  );
  const headerAndPrecontextChars =
    header.text.length + renderPrecontextBlock(precontext).length + renderOpenBlockersBlock(openBlockers).length;

  const turnLines = renderTurnLines(tailTurns, { subAgent: isSubAgent });
  const windows = buildWindows(turnLines);
  const sessionBudgetUsd = opts.sessionBudgetUsd ?? resolveSessionBudgetUsd();
  const degrade = selectWindowsWithinBudget(windows, {
    budgetUsd: sessionBudgetUsd,
    model: deps.llm.modelName,
    headerAndPrecontextChars,
    selfHosted: deps.llm.chatSelfHosted,
  });

  let extractionCostUsd = 0;
  let droppedPii = 0;
  let droppedOwnerVoice = 0;
  let droppedSubagentBrief = 0;
  let droppedNarration = 0;
  let droppedHallucinatedRef = 0;
  let durableDefaulted = 0;
  // Issue #162: the repair counterparts of droppedPii/droppedHallucinatedRef
  // above — a record that was FIXED (ref recovered, PII span redacted) and
  // kept, rather than dropped. See merge.ts's applyDeterministicFixes.
  let repairedRef = 0;
  let repairedPii = 0;
  let retriedEmpty = 0;
  let retryRecovered = 0;
  let retrySkippedBudget = 0;
  let retryFailed = 0;
  // RR2-S1 (retry re-check): `extractionCostUsd` alone is spend SO FAR — it
  // leaves out the budget degrade already reserved for windows still to run
  // and the retry estimates already committed to earlier in this loop, so
  // several windows in a row could each see enough headroom and retry,
  // blowing well past sessionBudgetUsd in total. Track everything spoken for
  // instead: what degrade reserved for the whole selection, plus every retry
  // estimate actually used, and gate + grow it as one running total.
  let reserved = degrade.estimatedCostUsd;
  const failedWindowIndexes = new Set<number>();
  const deadlineSkippedIndexes = new Set<number>();
  const truncatedWindowIndexes = new Set<number>();
  const shouldStop = opts.shouldStop ?? (() => false);
  let deadlineHit = false;
  const rawGrounded: GroundedRecord[] = [];
  const rawIssues: SessionIssueParsed[] = [];
  const rawFeedback: FeedbackParsed[] = [];
  for (const window of degrade.selected) {
    // P10 re-review N2: after a failed window (429 / provider error) or the
    // cutoff, no further window starts this run; the rest stay uncovered.
    if (deadlineSkippedIndexes.size > 0 || failedWindowIndexes.size > 0 || shouldStop("main")) {
      if (failedWindowIndexes.size > 0) {
        deadlineSkippedIndexes.add(window.windowIndex);
        continue;
      }
      deadlineHit = true;
      deadlineSkippedIndexes.add(window.windowIndex);
      continue;
    }
    // RR-S1 (review round 2): the retry is a second call on top of the one
    // selectWindowsWithinBudget already priced in, so it must be checked
    // against what's left of the session budget, not just the run-wide cap.
    // P10 round 3 R3-m1: the retry is also a call that must start before the
    // pass cutoff, or a window started just before it could end a worst call late.
    const canAffordRetry = () => {
      if (shouldStop("main")) return false;
      const retryEstimate = estimateWindowCostUsd(window, deps.llm.modelName, headerAndPrecontextChars, {
        selfHosted: deps.llm.chatSelfHosted,
      });
      if (retryEstimate > sessionBudgetUsd - reserved) return false;
      reserved += retryEstimate;
      return true;
    };
    const {
      result,
      costUsd,
      failed,
      failure,
      truncated,
      cutoffReply,
      droppedNarration: windowDroppedNarration,
      durableDefaulted: windowDurableDefaulted,
      retriedEmpty: windowRetriedEmpty,
      retryRecovered: windowRetryRecovered,
      retrySkippedBudget: windowRetrySkippedBudget,
      retryFailed: windowRetryFailed,
    } = await extractWindow(
      deps.llm,
      header.text,
      precontext,
      window,
      sessionId,
      header.offRepoStrict,
      canAffordRetry,
      openBlockers,
    );
    extractionCostUsd += costUsd;
    droppedNarration += windowDroppedNarration;
    durableDefaulted += windowDurableDefaulted;
    retriedEmpty += windowRetriedEmpty;
    retryRecovered += windowRetryRecovered;
    retrySkippedBudget += windowRetrySkippedBudget;
    retryFailed += windowRetryFailed;
    if (failed) {
      failedWindowIndexes.add(window.windowIndex);
      recordWindowFailure(state, "main", window.windowIndex, windows.length, failure);
    }
    recordWindowSalvage(state, window.windowIndex, truncated);
    recordCutoffReply(state, "main", window.windowIndex, cutoffReply);
    if (truncated) truncatedWindowIndexes.add(window.windowIndex);
    rawIssues.push(...result.issues);
    rawFeedback.push(...result.feedback);
    for (const raw of result.records) {
      const fixed = applyDeterministicFixes(raw, allTurns, sessionRow.cwd ?? undefined);
      droppedPii += fixed.droppedPii;
      droppedHallucinatedRef += fixed.droppedHallucinatedRef;
      repairedRef += fixed.repairedRef;
      repairedPii += fixed.repairedPii;
      for (const record of fixed.records) {
        const grounded = groundRecord(record, allTurns, PROMPT_VERSION, window.windowIndex);
        if (grounded === null) {
          // step2d finding 4: a preference whose receipt turn resolved to
          // an assistant turn — dropped, not stored.
          droppedOwnerVoice++;
          continue;
        }
        // Sub-agent session: a preference/blocker whose (ground-truth)
        // receipt turn is role "user" quotes the parent agent's brief —
        // dropped whatever the model said, not prompt-only.
        if (isSubAgent && isSubAgentBriefRecord(grounded)) {
          droppedSubagentBrief++;
          continue;
        }
        rawGrounded.push(grounded);
      }
    }
  }

  // step2d finding 6: the checkpoint advances window-by-window, in order,
  // stopping at the FIRST window that was dropped by budget degrade or
  // whose extraction call failed — never past a gap. `tail_turns_uncovered`
  // is everything from that gap onward, all re-offered as the tail on the
  // next upload (whether the same upload retries it, or the next one does).
  const uncoveredWindowIndexes = new Set<number>([
    ...degrade.dropped.map((w) => w.windowIndex),
    ...failedWindowIndexes,
    ...deadlineSkippedIndexes,
  ]);
  let checkpointIdx: number | null = checkpoint;
  for (const w of windows) {
    if (uncoveredWindowIndexes.has(w.windowIndex)) break;
    if (w.turns.length > 0) checkpointIdx = Math.max(...w.turns.map((t) => t.idx));
  }
  state.mainPass = {
    header,
    openBlockers,
    turnLines,
    windows,
    sessionBudgetUsd,
    degrade,
    extractionCostUsd,
    droppedPii,
    droppedOwnerVoice,
    droppedSubagentBrief,
    droppedNarration,
    droppedHallucinatedRef,
    durableDefaulted,
    repairedRef,
    repairedPii,
    retriedEmpty,
    retryRecovered,
    retrySkippedBudget,
    retryFailed,
    failedWindowIndexes,
    deadlineSkippedIndexes,
    truncatedWindowIndexes,
    shouldStop,
    deadlineHit,
    rawGrounded,
    rawIssues,
    rawFeedback,
    checkpointIdx,
  };
  return { kind: "continue", mainPass: state.mainPass };
}

/**
 * What the user pass (G2 2.3d) hands the rest of the run: the running
 * counters it added to (carried in from the main pass), the checkpoint after
 * its pullback, and its own bookkeeping for the summary and write-back.
 */
interface UserPassState {
  extractionCostUsd: number;
  droppedPii: number;
  droppedOwnerVoice: number;
  droppedNarration: number;
  droppedHallucinatedRef: number;
  durableDefaulted: number;
  repairedRef: number;
  repairedPii: number;
  retriedEmpty: number;
  retryRecovered: number;
  retrySkippedBudget: number;
  retryFailed: number;
  deadlineHit: boolean;
  checkpointIdx: number | null;
  userPassFailures: Record<string, number>;
  userPassWindowsAbandoned: string[];
  userPassWindowsBudgetReleased: number;
  userPassRecords: number;
  userPassWindowsSkipped: number;
  userPassWindowsFailed: number;
}

/** The user pass never ends the run early: it always continues. */
type UserPassOutcome = { kind: "continue"; userPass: UserPassState };

/**
 * Phase "user pass" (G2 2.3d): D3 decision C2, the separate pass over the
 * tail's user prose turns (gated by `opts.userPass` and sub-agent sessions
 * inside the phase), then the checkpoint pullback and the R2-M1 attempt
 * bookkeeping. Body moved verbatim from `runTailCaptureInner`; it has no
 * early return, and the locals later phases need are stored as
 * `state.userPass`. `rawGrounded` is the main pass's array, pushed to in place.
 */
async function userPassPhase(state: RunState, deps: TailCaptureDeps): Promise<UserPassOutcome> {
  const { sessionId, opts, sessionRow, isSubAgent, checkpoint, allTurns, tailTurns } = state;
  const props = state.props;
  if (!state.mainPass) throw new Error("userPassPhase: main pass has not run");
  const { header, openBlockers, turnLines, windows, sessionBudgetUsd, degrade } = state.mainPass;
  const { failedWindowIndexes, shouldStop, rawGrounded } = state.mainPass;
  let { extractionCostUsd, droppedPii, droppedOwnerVoice, droppedNarration, droppedHallucinatedRef } = state.mainPass;
  let { durableDefaulted, repairedRef, repairedPii, retriedEmpty, retryRecovered } = state.mainPass;
  let { retrySkippedBudget, retryFailed, deadlineHit, checkpointIdx } = state.mainPass;

  // D3 decision C2 (D-047): a separate pass over the tail's USER prose turns
  // (each with the preceding assistant line, truncated) asking only for
  // preferences and user-stated open blockers — the main pass under-reads
  // the owner's own words. Same windowing, same LlmClient (and so the same
  // cost guard). Review v6 M5: it covers ONLY turns the main pass covered
  // (<= the main checkpoint), and a user-pass window that fails or is
  // skipped for budget pulls the checkpoint back before its first turn — so
  // the checkpoint only ever passes turns that got BOTH passes. Review v6
  // m4: its budget is what is left after the main pass's ESTIMATE or its
  // ACTUAL cost, whichever leaves less. Its records sort after the main
  // pass's (windowIndex offset) so `dedupeByNormalizedText` sees both.
  const mainCheckpointIdx = checkpointIdx;
  const userPassTurns =
    mainCheckpointIdx === null || mainCheckpointIdx === checkpoint
      ? []
      : turnLines.filter((t) => t.idx <= mainCheckpointIdx);
  const userPass = opts.userPass ?? true;
  // A sub-agent session has no owner turns, so the user-turn pass never runs
  // for it. Unlike `userPass: false` (S3 below), this is not "not yet
  // covered": there is nothing for that pass to find, so it never holds the
  // checkpoint back.
  const userPassWindows = userPass && !isSubAgent ? buildWindows(buildUserPassTurns(userPassTurns)) : [];
  let userPassBudgetLeft = Math.max(
    0,
    Math.min(sessionBudgetUsd - degrade.estimatedCostUsd, sessionBudgetUsd - extractionCostUsd),
  );
  // Review v6 R2-M1: the hold-back is bounded. When the main pass itself hit
  // the session budget (degrade dropped windows, or its estimate/actual cost
  // left nothing), a per-session budget skip of a user-pass window is
  // deliberate — recorded, never a hold. Every other hold (the call failed,
  // or the window did not fit a budget the main pass left) counts an attempt
  // per window in `props.memory_user_pass_failures`, keyed "<first>-<last>"
  // turn idx; on attempt USER_PASS_MAX_ATTEMPTS the window is abandoned
  // (recorded) and the checkpoint passes it. The run-wide cap
  // (`overBudget()`) still holds without counting: the run stops there.
  const mainPassHitBudget = degrade.budgetHit || userPassBudgetLeft <= 0;
  const userPassFailures: Record<string, number> =
    !opts.force && props.memory_user_pass_failures && typeof props.memory_user_pass_failures === "object"
      ? { ...(props.memory_user_pass_failures as Record<string, number>) }
      : {};
  const userPassWindowsAbandoned: string[] = [];
  let userPassWindowsBudgetReleased = 0;
  let userPassRecords = 0;
  let userPassWindowsSkipped = 0;
  let userPassWindowsFailed = 0;
  // S3 fix (review round 2, issue #162): userPass=false must not advance the
  // checkpoint past turns the user pass never ran on. With the pass off,
  // `userPassWindows` above is empty and the loop below never runs, so
  // without this the checkpoint would silently advance to wherever the
  // MAIN pass alone got to — permanently skipping those turns for the user
  // pass unless a later run passes `--force`. Seed
  // `firstUncoveredUserPassIdx` with the earliest turn this run's user-pass
  // range would have covered, exactly as if every window in it had failed;
  // the existing pullback below (`firstUncoveredUserPassIdx !== null`) then
  // holds the checkpoint back correctly with no other change needed.
  let firstUncoveredUserPassIdx: number | null = !userPass && userPassTurns.length > 0 ? userPassTurns[0].idx : null;
  const windowKey = (window: { turns: Array<{ idx: number }> }) =>
    `${window.turns[0]?.idx ?? ""}-${window.turns[window.turns.length - 1]?.idx ?? ""}`;
  const markUncovered = (window: { turns: Array<{ idx: number }> }) => {
    const first = window.turns[0]?.idx;
    if (first !== undefined && (firstUncoveredUserPassIdx === null || first < firstUncoveredUserPassIdx)) {
      firstUncoveredUserPassIdx = first;
    }
  };
  const holdOrAbandon = (window: { turns: Array<{ idx: number }> }) => {
    const key = windowKey(window);
    const attempts = (userPassFailures[key] ?? 0) + 1;
    if (attempts >= USER_PASS_MAX_ATTEMPTS) {
      delete userPassFailures[key];
      userPassWindowsAbandoned.push(key);
      return;
    }
    userPassFailures[key] = attempts;
    markUncovered(window);
  };
  let userPassDeadlineHit = false;
  for (const window of userPassWindows) {
    // P10 re-review N2: past the deadline, the window is left uncovered
    // (checkpoint pulled back before it) without counting a hold attempt.
    // After any failed call this run (429 / provider error), start no more.
    if (failedWindowIndexes.size > 0 || userPassWindowsFailed > 0) {
      userPassWindowsSkipped++;
      markUncovered(window);
      continue;
    }
    if (userPassDeadlineHit || shouldStop("user")) {
      deadlineHit = true;
      userPassDeadlineHit = true;
      userPassWindowsSkipped++;
      markUncovered(window);
      continue;
    }
    const estimate = estimateWindowCostUsd(window, deps.llm.modelName, header.text.length, {
      selfHosted: deps.llm.chatSelfHosted,
    });
    if (deps.llm.overBudget()) {
      userPassWindowsSkipped++;
      markUncovered(window);
      continue;
    }
    if (estimate > userPassBudgetLeft) {
      userPassWindowsSkipped++;
      if (mainPassHitBudget) {
        userPassWindowsBudgetReleased++;
        delete userPassFailures[windowKey(window)];
      } else {
        holdOrAbandon(window);
      }
      continue;
    }
    userPassBudgetLeft -= estimate;
    // RR-S1 (review round 2): same reasoning as the main pass — the retry is
    // a second call the preemptive `estimate` reservation above didn't
    // budget for, so it needs its own check against what's left, with its
    // own decrement on use (mirrors the reservation idiom above).
    const canAffordRetry = () => {
      if (shouldStop("user")) return false; // P10 round 3 R3-m1, as the main pass
      if (estimate > userPassBudgetLeft) return false;
      userPassBudgetLeft -= estimate;
      return true;
    };
    const pass = await extractUserTurnPass(deps.llm, header.text, window, sessionId, canAffordRetry, openBlockers);
    extractionCostUsd += pass.costUsd;
    if (pass.failed) {
      userPassWindowsFailed++;
      recordWindowFailure(state, "user", window.windowIndex, userPassWindows.length, pass.failure);
      holdOrAbandon(window);
    } else {
      delete userPassFailures[windowKey(window)];
    }
    recordWindowSalvage(state, window.windowIndex, pass.truncated);
    recordCutoffReply(state, "user", window.windowIndex, pass.cutoffReply);
    droppedNarration += pass.droppedNarration;
    durableDefaulted += pass.durableDefaulted;
    retriedEmpty += pass.retriedEmpty;
    retryRecovered += pass.retryRecovered;
    retrySkippedBudget += pass.retrySkippedBudget;
    retryFailed += pass.retryFailed;
    userPassRecords += pass.records.length;
    for (const raw of pass.records) {
      const fixed = applyDeterministicFixes(raw, allTurns, sessionRow.cwd ?? undefined);
      droppedPii += fixed.droppedPii;
      droppedHallucinatedRef += fixed.droppedHallucinatedRef;
      repairedRef += fixed.repairedRef;
      repairedPii += fixed.repairedPii;
      for (const record of fixed.records) {
        const grounded = groundRecord(record, allTurns, PROMPT_VERSION, windows.length + window.windowIndex, {
          userTurnsOnly: true,
        });
        if (grounded === null) {
          droppedOwnerVoice++;
          continue;
        }
        rawGrounded.push(grounded);
      }
    }
  }
  if (firstUncoveredUserPassIdx !== null) {
    const stopBefore: number = firstUncoveredUserPassIdx;
    const covered = tailTurns.filter((t) => t.idx < stopBefore).map((t) => t.idx);
    checkpointIdx = covered.length > 0 ? Math.max(...covered) : checkpoint;
  }
  // R2-M1: attempt counts for windows the checkpoint has now passed are done.
  const finalCheckpoint = checkpointIdx;
  for (const key of Object.keys(userPassFailures)) {
    const first = Number(key.split("-")[0]);
    if (finalCheckpoint !== null && Number.isFinite(first) && first <= finalCheckpoint) delete userPassFailures[key];
  }

  state.userPass = {
    extractionCostUsd,
    droppedPii,
    droppedOwnerVoice,
    droppedNarration,
    droppedHallucinatedRef,
    durableDefaulted,
    repairedRef,
    repairedPii,
    retriedEmpty,
    retryRecovered,
    retrySkippedBudget,
    retryFailed,
    deadlineHit,
    checkpointIdx,
    userPassFailures,
    userPassWindowsAbandoned,
    userPassWindowsBudgetReleased,
    userPassRecords,
    userPassWindowsSkipped,
    userPassWindowsFailed,
  };
  return { kind: "continue", userPass: state.userPass };
}

/**
 * What the blocker checks (G2 2.3e) hand the rest of the run: this run's
 * deduped records (paths filled, re-asked blockers' `durable` overridden in
 * place), the content hashes of blockers resolved in this session, the
 * later-session check's result, the counters, and the running cost.
 */
interface BlockerChecksState {
  deduped: GroundedRecord[];
  dedupedText: number;
  blockersReasked: number;
  resolvedBlockerHashes: Set<string>;
  laterCheck: {
    candidates: LaterResolutionCandidate[];
    result: LaterBlockerCheckResult;
    observed: ObservedRetirement[];
  };
  danglingReceipts: number;
  /** v24: the served-record verdicts (feedback.ts judgeServedRecords); written in the persist phase. */
  servedVerdicts: ServedVerdictResult;
  /** W3b questionnaire: the judge's answers (null when it did not run); written in the persist phase. */
  questionnaireJudge: QuestionnaireJudgeResult | null;
  extractionCostUsd: number;
}

/** The blocker checks never end the run early: they always continue. */
type BlockerChecksOutcome = { kind: "continue"; blockerChecks: BlockerChecksState };

/**
 * Phase "blocker checks" (G2 2.3e): within-session dedupe of the grounded
 * records, the in-session blocker re-ask (skipped past the "reask" cutoff
 * inside the phase), and the later-session blocker check (observed
 * retirements first, then one LLM call). Body moved verbatim from
 * `runTailCaptureInner`; it has no early return, and the locals later
 * phases need are stored as `state.blockerChecks`.
 */
async function blockerChecksPhase(state: RunState, deps: TailCaptureDeps): Promise<BlockerChecksOutcome> {
  const { userId, sessionId, sessionRow, isSubAgent, allTurns } = state;
  if (!state.mainPass || !state.userPass) throw new Error("blockerChecksPhase: user pass has not run");
  const { shouldStop, rawGrounded } = state.mainPass;
  let { extractionCostUsd } = state.userPass;

  // D3 decision C3(c): near-identical records within the session (window
  // overlap, main pass vs user pass) collapse before insert.
  const { kept: textDeduped, dropped: dedupedText } = dedupeByNormalizedText(dedupeByContentHash(rawGrounded));
  const deduped = textDeduped;
  const cwd = sessionRow.cwd ?? undefined;
  for (const r of deduped) r.paths = unionModelPaths(computePaths(r.turn_idx, allTurns, cwd), r.paths, cwd);

  // step2e finding 5 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
  // #151): the per-window `resolved_in_session` answer only ever saw that
  // one window's turns — re-ask once, given every turn of the session AFTER
  // the earliest blocker this run found, and apply the SAME deterministic
  // `durable = !resolved_in_session` override to whatever comes back. A
  // no-op (no LLM call) when there are no blockers, or nothing follows the
  // earliest one.
  const runLaterBlockerCheck = async (): Promise<{
    candidates: LaterResolutionCandidate[];
    result: LaterBlockerCheckResult;
    /** W5/P3: blockers this session's turns observably closed (an action on their ref, or an edit + commit on a path) — retired without an LLM call, never offered to it. */
    observed: ObservedRetirement[];
  }> => {
    const noResult: LaterBlockerCheckResult = { resolutions: [], unverified: 0, costUsd: 0, failed: false };
    const none = { candidates: [], result: noResult, observed: [] };
    const lastTurnTs = latestTimestamp(allTurns.map((t) => t.ts)) ?? sessionRow.ended_at ?? sessionRow.started_at;
    if (!lastTurnTs) return none;
    let fetched: LaterResolutionCandidate[];
    try {
      fetched = await fetchLaterResolutionCandidates(
        deps.supabase,
        userId,
        sessionRow.code_project_id,
        sessionId,
        lastTurnTs,
        BLOCKER_FRESH_DAYS,
        LATER_RESOLUTION_MAX_BLOCKERS,
      );
    } catch (err) {
      log.warn("memory: later-session blocker lookup failed — skipped", {
        user_id: userId,
        session_id: sessionId,
        err: err instanceof Error ? err.message : String(err),
      });
      return none;
    }
    if (fetched.length === 0) return none;
    // B2, observed beats inferred: a blocker the tool calls already closed is
    // retired `resolved_observed` from the turns alone (pure, free, before
    // any deadline or budget check) and never reaches the model.
    const observed = findObservedRetirements(fetched, allTurns, {
      repoIdentity: projectIdentity(sessionRow),
      branchStates: await fetchClosedBranchStates(deps.supabase, userId, sessionRow.code_project_id, fetched),
    });
    const observedIds = new Set(observed.map((o) => o.memoryId));
    const candidates = fetched.filter((c) => !observedIds.has(c.id));
    if (candidates.length === 0) return { ...none, observed };
    if (shouldStop("reask") || deps.llm.overBudget()) {
      log.warn("memory: later-session blocker check skipped (deadline or budget)", {
        user_id: userId,
        session_id: sessionId,
      });
      return { ...none, observed };
    }
    const lines = selectBlockerReaskLines(
      renderTurnLines(allTurns, { subAgent: isSubAgent }).filter((t) => t.isProse),
      [Number.NEGATIVE_INFINITY],
      BLOCKER_REASK_MAX_TAIL_LINES,
    );
    const result = await checkLaterBlockerResolutions(
      deps.llm,
      candidates.map((c, i) => ({ index: i, text: c.text, quote: c.quote, ref: c.ref, paths: c.paths })),
      lines,
      allTurns.filter((t) => t.kind === "prose"),
      sessionId,
      allTurns,
      projectIdentity(sessionRow),
    );
    return { candidates, result, observed };
  };

  const blockerRecords = deduped.filter((r) => r.kind === "blocker");
  let blockersReasked = 0;
  const resolvedBlockers = new Set<GroundedRecord>();
  if (blockerRecords.length > 0) {
    const reaskLines = selectBlockerReaskLines(
      renderTurnLines(allTurns, { subAgent: isSubAgent }),
      blockerRecords.map((r) => r.turn_idx),
      BLOCKER_REASK_MAX_TAIL_LINES,
    );
    if (reaskLines.length > 0 && shouldStop("reask")) {
      log.warn("memory: blocker re-ask skipped (deadline) — blockers kept as extracted", {
        user_id: userId,
        session_id: sessionId,
      });
    } else if (reaskLines.length > 0) {
      const reaskInput = blockerRecords.map((r, i) => ({
        index: i,
        text: r.text,
        quote: r.quote,
        turn_idx: r.turn_idx,
      }));
      const reask = await reaskBlockerResolutions(deps.llm, reaskInput, reaskLines, sessionId);
      extractionCostUsd += reask.costUsd;
      blockerRecords.forEach((r, i) => {
        const resolved = reask.resolutions.get(i);
        if (resolved !== undefined) {
          r.durable = !resolved;
          blockersReasked++;
          if (resolved) resolvedBlockers.add(r);
        }
      });
    }
  }
  // P8 (goal 2026-09-24 memory-on-prod): a blocker the re-ask judged resolved in this
  // session is never deleted (P10 review M4: `reaskBlockerResolutions` only returns
  // verdicts when the returned index set is exactly {0..N-1}, else every blocker is kept
  // as extracted). It is inserted RETIRED with `retire_reason = "resolved_in_session"`
  // (write.ts), so open-blocker serving (`retired_at is null`) drops it without
  // relying on `durable` — which schema.ts defaults to false for a blocker whose
  // resolution the model never answered — and `--reverify` never lifts it.
  const resolvedBlockerHashes = new Set([...resolvedBlockers].map((r) => r.contentHash));

  // Later-session resolution: open blockers from EARLIER sessions of this
  // project (main or sub-agent, fresh per BLOCKER_FRESH_DAYS, from sessions that started before
  // this one's last turn) that THIS session closed. One LLM call on the same
  // cost-guarded client; a resolution counts only with an evidence quote
  // found verbatim in this session. The call happens here (before the
  // "embed" cutoff, like the re-ask); the retire is applied after this run's
  // own insert. Any failure logs and skips — never fails the extraction.
  const laterCheck = await runLaterBlockerCheck();
  extractionCostUsd += laterCheck.result.costUsd;

  // v24 (box 9b): the records Membral served into this session, judged
  // confirmed / contradicted / unused with a receipt (D-021). One call, only
  // when something was served; skipped past the "reask" cutoff or over budget
  // (no verdicts written, an earlier run's stay).
  const noVerdicts: ServedVerdictResult = { verdicts: [], droppedNoReceipt: 0, costUsd: 0, failed: false };
  let servedVerdicts = noVerdicts;
  let questionnaireJudge: QuestionnaireJudgeResult | null = null;
  const served = servedVerdictsEnabled()
    ? await fetchServedRecords(deps.supabase, userId, sessionId, sessionRow.source_session_id ?? null)
    : [];
  if (served.length > 0) {
    if (shouldStop("reask") || deps.llm.overBudget()) {
      log.warn("memory: served-record verdicts skipped (deadline or budget)", {
        user_id: userId,
        session_id: sessionId,
      });
    } else {
      const { lines, turns: evidenceTurns } = servedVerdictEvidence(allTurns, isSubAgent);
      servedVerdicts = await judgeServedRecords(deps.llm, served, lines, evidenceTurns, sessionId);
      extractionCostUsd += servedVerdicts.costUsd;
      // W3b questionnaire judge: the same four questions the session answered
      // about its injected lines (preamble / prompt hook), over the same tail
      // lines, WITHOUT the self-report. It runs only when a self-report exists
      // (its presence is read, never its answers): agreement needs both, and
      // the self-report is opt-in (dogfood.questionnaire), so sessions nobody
      // asked about spend nothing.
      // Fresh judge on the LOCAL provider only (goal: "fresh judge (local
      // provider)"): any other provider skips it with a log line.
      const injected = served.filter((s) => s.surface !== "mcp").map((s) => s.text);
      if (
        injected.length > 0 &&
        !deps.llm.overBudget() &&
        (await hasSelfReport(deps.supabase, userId, sessionRow.source_session_id ?? null))
      ) {
        if (!shouldRunQuestionnaireJudge(deps.llm)) {
          log.info("memory: questionnaire judge skipped (provider is not the local claude-code provider)", {
            user_id: userId,
            session_id: sessionId,
          });
        } else {
          questionnaireJudge = await judgeQuestionnaire(deps.llm, injected, lines, evidenceTurns, sessionId);
          extractionCostUsd += questionnaireJudge.costUsd;
        }
      }
    }
  }

  const danglingReceipts = deduped.filter((r) => r.dangling).length;

  state.blockerChecks = {
    deduped,
    dedupedText,
    blockersReasked,
    resolvedBlockerHashes,
    laterCheck,
    danglingReceipts,
    servedVerdicts,
    questionnaireJudge,
    extractionCostUsd,
  };
  return { kind: "continue", blockerChecks: state.blockerChecks };
}

/**
 * What the persist phase (G2 2.3f) hands finalize: the rows written (all and
 * live), the embedding cost and failures, the force-run snapshot of the prior
 * extraction, and the counters the extraction props and summary report.
 */
interface PersistState {
  inserted: Awaited<ReturnType<typeof insertMemoryRecords>>;
  insertedLive: Awaited<ReturnType<typeof insertMemoryRecords>>;
  embedCostUsd: number;
  embedFailedCount: number;
  previousExtractionInfo: MemoryExtractionProps["previous"];
  retiredResolvedBlocker: number;
  recordsRetiredUnverified: number;
  dedupedCrossSession: number;
  recurrences: number;
  blockersResolvedLater: number;
  blockersResolvedObserved: number;
  /** v24: session_feedback rows offered (grounded feedback about Membral). */
  feedbackWritten: number;
  /** v24: served_record_verdicts rows upserted. */
  servedVerdictsWritten: number;
}

/** What `persistPhase` tells the caller: return `result` as-is (embed cutoff), or carry on. */
type PersistOutcome = { kind: "skip"; result: TailCaptureSummary } | { kind: "continue"; persist: PersistState };

/**
 * Phase "persist" (G2 2.3f): the "embed" cutoff, the embeddings, the
 * cross-session dedupe, the carried dismissals, the re-tag, the insert, the
 * force-run retire, supersede, the semantic-duplicate merge, and the
 * later-session and observed blocker retirements. Body moved verbatim from
 * `runTailCaptureInner`; the one early `return` (past the "embed" cutoff) is a
 * `skip` sentinel carrying the identical summary, and the locals finalize
 * needs are stored as `state.persist`.
 */
async function persistPhase(state: RunState, deps: TailCaptureDeps): Promise<PersistOutcome> {
  const { userId, sessionId, opts, sessionRow, allTurns, previousExtraction } = state;
  const { priorLiveIdsForForce, priorUnverifiedIdsForForce } = state;
  if (!state.mainPass || !state.userPass || !state.blockerChecks) {
    throw new Error("persistPhase: blocker checks have not run");
  }
  const { windows, failedWindowIndexes, shouldStop } = state.mainPass;
  const { userPassWindowsFailed } = state.userPass;
  const { deduped, resolvedBlockerHashes, laterCheck, servedVerdicts, questionnaireJudge, extractionCostUsd } =
    state.blockerChecks;

  // P10 re-review N2 / round 3 R3-m1: past the "reask" cutoff the re-ask is
  // skipped (blockers kept as extracted) and the run still writes. Past the
  // "embed" cutoff this run's records are dropped (nothing written,
  // checkpoint untouched) and the lock released, so the queue retries it.
  const abortBeforePostPass = async (): Promise<TailCaptureSummary> => {
    // Only the lock key is removed (migration 109), and only while it is still
    // this run's (compare-and-delete): never another run's lease.
    try {
      await releaseMemoryExtractionLock(deps.supabase, userId, sessionId, opts.runId);
    } catch (err) {
      throw new Error(
        `runTailCaptureForSession: lock release failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    log.warn("memory: tail capture stopped before the re-ask/embeddings (deadline) — nothing written", {
      user_id: userId,
      session_id: sessionId,
    });
    return {
      ...emptySummary(sessionId),
      skipped: false,
      windowsTotal: windows.length,
      deadlineHit: true,
      windowsFailed: countWindowsFailed(failedWindowIndexes, userPassWindowsFailed),
      costUsd: extractionCostUsd,
    };
  };

  const texts = deduped.map((r) => r.text);
  if (texts.length > 0 && shouldStop("embed")) return { kind: "skip", result: await abortBeforePostPass() };
  const {
    vectors,
    costUsd: embedCostUsd,
    failedCount: embedFailedCount,
  } = await embedTexts(deps.llm, texts, sessionId, deps.supabase);
  const embedded: EmbeddedGroundedRecord[] = deduped.map((r, i) => ({ ...r, embedding: vectors[i] ?? null }));
  embedded.sort((a, b) => a.windowIndex - b.windowIndex);
  const candidates: InsertableRecord[] = dedupeByCosine(embedded).map((r) =>
    resolvedBlockerHashes.has(r.contentHash) ? { ...r, retireReason: RESOLVED_IN_SESSION_RETIRE_REASON } : r,
  );
  // A record restating a live one from another session (e.g. the answer
  // echoed the injected preamble) is not a new fact — never inserted.
  const {
    kept: keptCrossSession,
    deduped: dedupedCrossSession,
    recurrences,
  } = await dropCrossSessionDuplicates(deps.supabase, userId, sessionRow.code_project_id, sessionId, candidates);
  // UX pass 2: a blocker the user dismissed on Today stays dismissed when this
  // run re-derives it (Ignore always; Resolved for sightings from before the
  // click, timed by the receipt turn) — blocker-dismiss.ts carryUserDismissals.
  const turnTs = new Map(allTurns.filter((t) => !!t.ts).map((t) => [t.idx, t.ts as string]));
  const { records: final } = await carryUserDismissals(
    deps.supabase,
    userId,
    sessionRow.code_project_id,
    sessionId,
    (r) => turnTs.get(r.turn_idx) ?? sessionRow.ended_at ?? sessionRow.started_at ?? null,
    keptCrossSession,
  );
  const retiredResolvedBlocker = final.filter((r) => r.retireReason === RESOLVED_IN_SESSION_RETIRE_REASON).length;

  // Review v6 R2-m3: re-tag the replaced extraction's `unverified*` rows as
  // `rerun` BEFORE the insert, not after. The update touches only rows that
  // are already retired, so if the insert (or anything later) then crashes,
  // nothing is lost — the old rows are simply no longer reverify-liftable,
  // which is the M1 guarantee. A crash between an insert and a later re-tag
  // was the window that left them open. A row this run re-derives gets its
  // reason back from the insert itself (verified -> lifted, since `rerun`
  // is liftable; unverified -> `unverified:<reason>`), so excluding
  // re-derived ids up front is no longer needed.
  await retagUnverifiedAsRerun(deps.supabase, userId, priorUnverifiedIdsForForce);

  const inserted = await insertMemoryRecords(
    deps.supabase,
    userId,
    sessionRow.code_project_id,
    sessionId,
    sessionRow.git_branch,
    final,
    sessionRow.short_title ?? null,
  );

  // step2d finding 7: retire the prior version ONLY after the new rows are
  // live, and ONLY the ids captured before this run started — the ids
  // `insertMemoryRecords` just returned are the ones an upsert-on-conflict
  // may have reused (same content_hash as a prior row), so they're excluded
  // here rather than immediately re-retired.
  const insertedIds = new Set(inserted.map((r) => r.id));
  const idsToRetire = priorLiveIdsForForce.filter((id) => !insertedIds.has(id));
  const previousExtractionInfo = await retirePriorForForce(deps.supabase, userId, previousExtraction, idsToRetire);

  // D3 decision B + review v6 M4: only rows LIVE after the write take part
  // in supersede — decided by the row's own retired_at, not the candidate's
  // verified flag (a verified upsert onto a row retired as `duplicate` stays
  // retired and must not retire anything else).
  const insertedLive = inserted.filter((r) => r.live);
  const recordsRetiredUnverified = inserted.filter(
    (r) => !r.live && !r.verified && !resolvedBlockerHashes.has(r.contentHash),
  ).length;
  await supersedeRecords(deps.supabase, userId, sessionRow.code_project_id, insertedLive);
  // L1: flag-gated (MEMBRAL_RECONCILE=1, local claude-code only), never blocks or fails the write. Off => no call.
  if (liveReconcileEnabled()) {
    await reconcileInserted(
      deps.supabase,
      userId,
      sessionRow.code_project_id,
      insertedLive.map((r) => r.id),
      deps.llm,
    );
  }
  // Migration 101: keep only the newest row of each semantic-duplicate
  // cluster these rows join (older memories and this batch alike; cosine in
  // Postgres, after the embeddings above are stored; logged to
  // memory_merges). Never throws.
  // B7: this run's recurrence rows are counted, never merged — kept out of
  // the semantic-duplicate pass on both sides of every pair.
  const recurrenceHashes = new Set(final.filter((r) => r.recursOf).map((r) => r.contentHash));
  const recurrenceIds = new Set(insertedLive.filter((r) => recurrenceHashes.has(r.contentHash)).map((r) => r.id));
  await mergeSemanticDuplicates(
    deps.supabase,
    userId,
    insertedLive.map((r) => r.id),
    undefined,
    undefined,
    recurrenceIds,
  );

  const blockersResolvedLater = await retireBlockersResolvedLater(
    deps.supabase,
    userId,
    laterCheck.result.resolutions.flatMap((r) => {
      const candidate = laterCheck.candidates[r.index];
      return candidate
        ? [{ memoryId: candidate.id, resolvedBySessionId: sessionId, quote: r.quote, turnIdx: r.turn_idx }]
        : [];
    }),
  );
  // W5/P3: blockers the turns themselves closed (observed-retirement.ts) —
  // the receipt is the closing action's turn and a fixed-shape evidence
  // string, never transcript text.
  const blockersResolvedObserved = await retireBlockersResolvedLater(
    deps.supabase,
    userId,
    laterCheck.observed.map((o) => ({
      memoryId: o.memoryId,
      resolvedBySessionId: sessionId,
      quote: o.evidence,
      turnIdx: o.turnIdx,
    })),
    RESOLVED_OBSERVED_RETIRE_REASON,
  );

  // v24 (box 9a/9b): feedback about Membral and the served-record verdicts go
  // to their own tables (migration 125), never session_memories, so no
  // serving path can return them. A failed write logs and counts 0.
  const feedbackWritten = await insertSessionFeedback(
    deps.supabase,
    userId,
    sessionRow.code_project_id,
    sessionId,
    groundFeedbackItems(state.mainPass.rawFeedback, allTurns),
    PROMPT_VERSION,
  );
  const servedVerdictsWritten =
    servedVerdicts.verdicts.length === 0
      ? 0
      : await upsertServedVerdicts(
          deps.supabase,
          userId,
          sessionId,
          servedVerdicts.verdicts,
          PROMPT_VERSION,
          (deps.now ?? defaultNow)().toISOString(),
        );
  if (questionnaireJudge?.answers && sessionRow.source_session_id) {
    await upsertQuestionnaire(deps.supabase, userId, {
      sourceSessionId: sessionRow.source_session_id,
      codeSessionId: sessionId,
      source: "judge",
      order: JUDGE_ORDER,
      answers: questionnaireJudge.answers,
    });
  }

  state.persist = {
    inserted,
    insertedLive,
    embedCostUsd,
    embedFailedCount,
    previousExtractionInfo,
    retiredResolvedBlocker,
    recordsRetiredUnverified,
    dedupedCrossSession,
    recurrences,
    blockersResolvedLater,
    blockersResolvedObserved,
    feedbackWritten,
    servedVerdictsWritten,
  };
  return { kind: "continue", persist: state.persist };
}

/**
 * What the issues phase (G2 2.3g) hands finalize: the count of
 * code_session_issues rows the re-derivation wrote.
 */
interface IssuesState {
  issuesWritten: Awaited<ReturnType<typeof rederiveSessionIssues>>;
  /** D-057: USD the session-issue association spent (0 when it did not call the model). */
  associationCostUsd: number;
}

/** What `issuesPhase` tells the caller: always carry on (the block has no early return). */
type IssuesOutcome = { kind: "continue"; issues: IssuesState };

/**
 * Phase "issues" (G2 2.3g): re-derives the session's code_session_issues rows
 * from the extractor's raw refs and the turns' observed actions. Body moved
 * verbatim from `runTailCaptureInner`; the result finalize needs is stored as
 * `state.issues`.
 */
async function issuesPhase(state: RunState, deps: TailCaptureDeps): Promise<IssuesOutcome> {
  const { userId, sessionRow, allTurns, checkpoint } = state;
  if (!state.mainPass) throw new Error("issuesPhase: main pass has not run");
  if (!state.blockerChecks) throw new Error("issuesPhase: blocker checks have not run");
  if (!state.persist) throw new Error("issuesPhase: persist has not run");
  const { windows, degrade, failedWindowIndexes, deadlineSkippedIndexes, truncatedWindowIndexes, rawIssues } =
    state.mainPass;
  const { sessionBudgetUsd } = state.mainPass;
  const { extractionCostUsd } = state.blockerChecks;
  const { embedCostUsd } = state.persist;

  // code_session_issues (migrations 099 + 103): the session's issues — the
  // extractor's refs grounded against ALL its turns, merged with the refs the
  // session OBSERVABLY acted on (profile.ts over the turns' actions), each
  // row's role derived from the observed ladders (goal 2026-09-26 W4, B2).
  // A run from the first turn (checkpoint null: first extraction or --force)
  // replaces the session's rows; a tail run adds. Sub-agent sessions keep
  // their own rows — the issues page prices each session on its own. Never
  // fails the extraction: a write error (e.g. the table not migrated yet)
  // logs and records 0.
  let associationCostUsd = 0;
  const issuesWritten = await rederiveSessionIssues(deps.supabase, userId, sessionRow, allTurns, rawIssues, {
    // D-057: the association call answers to what is left of this session's budget.
    association: {
      llm: deps.llm,
      budgetUsd: Math.max(0, sessionBudgetUsd - extractionCostUsd - embedCostUsd),
      onCost: (usd) => {
        associationCostUsd += usd;
      },
    },
    // S1: only a run from the first turn whose every window was selected and
    // succeeded (no failure, no deadline, no budget cut) replaces the stored
    // model rows; any partial run carries them and they are grounded again.
    // Issue #339: a salvaged (cut-off) window counts as partial too: a cut
    // inside "issues" (or inside "records", before "issues" is reached) loses
    // the entries after the cut, so the stored model rows are carried.
    fullRun:
      checkpoint === null &&
      degrade.selected.length === windows.length &&
      failedWindowIndexes.size === 0 &&
      deadlineSkippedIndexes.size === 0 &&
      truncatedWindowIndexes.size === 0,
  });

  state.issues = { issuesWritten, associationCostUsd };
  return { kind: "continue", issues: state.issues };
}

/**
 * Phase "finalize" (G2 2.3h): builds the run's extraction snapshot, writes it
 * and the new checkpoint back to the session's props, and returns the run
 * summary. Body moved verbatim from `runTailCaptureInner`; the only change is
 * that its inputs are read from `RunState` and the checkpoint/budget math
 * calls the helpers in `./tail-capture/checkpoint`.
 */
async function finalizePhase(state: RunState, deps: TailCaptureDeps): Promise<TailCaptureSummary> {
  const { userId, sessionId, opts, baseProps, checkpoint, tailTurns } = state;
  let props = state.props;
  const now = deps.now ?? defaultNow;
  if (!state.mainPass) throw new Error("finalizePhase: main pass has not run");
  if (!state.userPass) throw new Error("finalizePhase: user pass has not run");
  if (!state.blockerChecks) throw new Error("finalizePhase: blocker checks have not run");
  if (!state.persist) throw new Error("finalizePhase: persist has not run");
  if (!state.issues) throw new Error("finalizePhase: issues have not run");
  const { windows, degrade, failedWindowIndexes, rawIssues, droppedSubagentBrief } = state.mainPass;
  const { droppedPii, droppedOwnerVoice, droppedNarration, droppedHallucinatedRef } = state.userPass;
  const { durableDefaulted, repairedRef, repairedPii, retriedEmpty, retryRecovered } = state.userPass;
  const { retrySkippedBudget, retryFailed, deadlineHit, checkpointIdx } = state.userPass;
  const { userPassFailures, userPassWindowsAbandoned, userPassWindowsBudgetReleased } = state.userPass;
  const { userPassRecords, userPassWindowsSkipped, userPassWindowsFailed } = state.userPass;
  const { dedupedText, blockersReasked, laterCheck, danglingReceipts, extractionCostUsd } = state.blockerChecks;
  const { inserted, insertedLive, embedCostUsd, embedFailedCount, previousExtractionInfo } = state.persist;
  const { retiredResolvedBlocker, recordsRetiredUnverified, dedupedCrossSession, recurrences } = state.persist;
  const { blockersResolvedLater, blockersResolvedObserved, feedbackWritten, servedVerdictsWritten } = state.persist;
  const { servedVerdicts } = state.blockerChecks;
  const { issuesWritten, associationCostUsd } = state.issues;

  const tailTurnsExtracted = countTailTurnsExtracted(degrade.selected);

  const tailTurnsUncovered = countTailTurnsUncovered(tailTurns, checkpointIdx);

  const extraction: MemoryExtractionProps = {
    windows_total: windows.length,
    windows_extracted: degrade.selected.length,
    tail_turns_extracted: tailTurnsExtracted,
    budget_hit: degrade.budgetHit,
    records: inserted.length,
    prompt_version: PROMPT_VERSION,
    run_id: opts.runId,
    at: now().toISOString(),
    windows_dropped_user_prose: degrade.droppedContainingUserProse,
    dropped_pii: droppedPii,
    previous: previousExtractionInfo,
    tail_turns_uncovered: tailTurnsUncovered,
    embed_failed: embedFailedCount,
    dropped_owner_voice: droppedOwnerVoice,
    dangling_receipts: danglingReceipts,
    dropped_narration: droppedNarration,
    dropped_hallucinated_ref: droppedHallucinatedRef,
    repaired_ref: repairedRef,
    repaired_pii: repairedPii,
    retried_empty: retriedEmpty,
    retry_recovered: retryRecovered,
    retry_skipped_budget: retrySkippedBudget,
    retry_failed: retryFailed,
    blockers_reasked: blockersReasked,
    retired_resolved_blocker: retiredResolvedBlocker,
    durable_defaulted: durableDefaulted,
    verified: insertedLive.length,
    retired_unverified: recordsRetiredUnverified,
    user_pass_records: userPassRecords,
    user_pass_windows_skipped: userPassWindowsSkipped,
    user_pass_windows_failed: userPassWindowsFailed,
    user_pass_windows_abandoned: userPassWindowsAbandoned,
    user_pass_windows_budget_released: userPassWindowsBudgetReleased,
    deduped_text: dedupedText,
    deduped: dedupedCrossSession,
    dropped_subagent_brief: droppedSubagentBrief,
    blockers_resolved_later: blockersResolvedLater,
    blockers_resolution_unverified: laterCheck.result.unverified,
    blockers_resolved_observed: blockersResolvedObserved,
    recurrences,
    issues: issuesWritten,
    issues_offered: rawIssues.length,
    feedback: feedbackWritten,
    served_verdicts: servedVerdictsWritten,
    served_verdicts_no_receipt: servedVerdicts.droppedNoReceipt,
  };
  props = { ...props, memory_user_pass_failures: userPassFailures };
  await updateSessionMemoryProps(deps.supabase, userId, sessionId, props, extraction, checkpointIdx, {
    baseProps,
    runId: opts.runId,
  });

  return {
    sessionId,
    skipped: false,
    windowsTotal: windows.length,
    windowsExtracted: degrade.selected.length,
    tailTurnsExtracted,
    budgetHit: degrade.budgetHit,
    droppedContainingUserProse: degrade.droppedContainingUserProse,
    droppedPii,
    repairedRef,
    repairedPii,
    retriedEmpty,
    retryRecovered,
    retrySkippedBudget,
    retryFailed,
    recordsWritten: inserted.length,
    embeddingMissing: embedFailedCount,
    recordsVerified: insertedLive.length,
    recordsRetiredUnverified,
    costUsd: runCostUsd(extractionCostUsd, embedCostUsd) + associationCostUsd,
    windowsFailed: countWindowsFailed(failedWindowIndexes, userPassWindowsFailed),
    deadlineHit,
    lockHeld: false,
    checkpointAdvanced: didCheckpointAdvance(checkpointIdx, checkpoint),
    droppedSubagentBrief,
    blockersResolvedLater,
    issuesRederived: true,
  };
}

async function runTailCaptureInner(
  deps: TailCaptureDeps,
  userId: string,
  sessionId: string,
  opts: TailCaptureRunOpts = { runId: "manual" },
): Promise<TailCaptureSummary> {
  const state = await loadPhase(deps, userId, sessionId, opts);
  // Issue #339: every summary carries the run's first window failure, if any.
  // windowFailuresAllContent: only when every failed window was a content failure.
  const withFailure = (summary: TailCaptureSummary): TailCaptureSummary =>
    state.firstWindowFailure
      ? {
          ...summary,
          firstWindowFailure: state.firstWindowFailure,
          windowFailuresAllContent: (state.contentWindowFailures ?? 0) > 0 && (state.otherWindowFailures ?? 0) === 0,
        }
      : summary;

  const lease = await leasePhase(state, deps);
  if (lease.kind === "skip") return lease.result;

  // The lease lock is held from here. Every normal completion clears it via
  // updateSessionMemoryProps; a THROW would leave it for the 15-minute stale
  // window, and every kick in that window then answers session_locked on the
  // same queue head. Release it (compare-and-delete: only this run's lock)
  // before rethrowing, so the failure counts as a normal attempt and the
  // retry/backoff state, not the lock, decides when it runs again.
  try {
    const main = await mainPassPhase(state, deps);
    if (main.kind === "skip") return withFailure(main.result);

    await userPassPhase(state, deps);
    await blockerChecksPhase(state, deps);

    const persist = await persistPhase(state, deps);
    if (persist.kind === "skip") return withFailure(persist.result);

    await issuesPhase(state, deps);

    return withFailure(await finalizePhase(state, deps));
  } catch (err) {
    try {
      await releaseMemoryExtractionLock(deps.supabase, userId, sessionId, opts.runId);
    } catch (releaseErr) {
      // Staleness still reclaims it; the original error is the one that matters.
      log.warn("memory: could not release the extraction lock after a failed run", {
        user_id: userId,
        session_id: sessionId,
        err: releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
      });
    }
    throw err;
  }
}
