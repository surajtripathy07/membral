// Goal 2026-09-26 P9 / W10 — the nightly DB half of "propose a skill".
//
// derivePatternsNightly(supabase) runs from /api/internal/cron/memory-
// extraction after user_stats: for every user with a top-level code session
// in the last WINDOW_DAYS it groups those sessions' tool turns by project,
// mines repeated step sequences (minePatterns, no LLM), drafts a skill for
// each new pattern (draftSkill — one guarded LLM call per pattern per
// REDRAFT_AFTER_DAYS, Zod + heuristic fallback) and writes at most three
// patterns to `code_projects.props.patterns`. A user's failure is counted
// and logged; the caller logs the whole step's failure and never fails the
// cron run for it.
//
// SPEND GATES — the same rule memory extraction applies
// (lib/memory/extraction-queue.ts): the `memory` feature is checked here
// (checkFeature, which includes its trailing-24h allowance and lifetime
// budget), then the global daily ceiling (fails closed); the LLM client is
// then built with `bypassFeatureGate: true` exactly as extraction does,
// because the gate it would check is `llm`, not `memory`. Its hard cap is
// min(3 × per-pattern cap, what is left of each allowance). Not applied: the
// hosted monthly memory budget (its spend reader is private to
// extraction-queue.ts); the per-run cap bounds a night to ≤ $0.15 per user.
import type { Db } from "@/lib/db/types";
import { checkFeature } from "@/lib/feature-flags";
import { createCostGuardedLlm } from "@/lib/llm/spend-ledger";
import { log } from "@/lib/log";
import { checkGlobalCeilings } from "@/lib/memory/global-ceiling";
import { memoryMonthlyRemainingUsd } from "@/lib/memory/monthly-spend";
import { selectAllRows } from "@/lib/util/pagination";
import { draftSkill, MAX_DRAFT_QUOTES, type PatternQuote, type SkillDraftLlm } from "./draft-skill";
import { MAX_PATTERNS_PER_PROJECT, minePatterns, type Pattern, type PatternTurn } from "./mine";
import { parseStoredPatterns, type StoredPattern, withStoredPatterns } from "./storage";

/** Sessions considered: the last 30 days (goal P9). */
export const PATTERN_WINDOW_DAYS = 30;
/** A sequence is a pattern once >= 5 sessions in the window ran it (goal P9). */
export const PATTERN_MIN_SESSIONS = 5;
/** Shortest sequence that counts as a habit. */
export const PATTERN_MIN_LENGTH = 3;
/** The LLM is asked again for a pattern's draft at most once a week (goal P9). */
export const REDRAFT_AFTER_DAYS = 7;
/** Spend ceiling per pattern draft (goal P9: ≤ $0.05); the per-user client is capped at 3× that. */
export const DRAFT_CAP_USD_PER_PATTERN = 0.05;
const DRAFT_LLM_TIMEOUT_MS = 60_000;
const DRAFT_LLM_MAX_RETRIES = 2;
/** PostgREST `in (...)` lists are URL-encoded; keep them well under the URL cap. */
const IN_CHUNK = 100;

interface SessionRow {
  id: string;
  user_id: string;
  code_project_id: string | null;
  started_at: string | null;
}

interface TurnRow {
  session_id: string;
  tool_name: string | null;
  file_path: string | null;
  ts: string | null;
  props: PatternTurn["props"];
}

interface ProjectRow {
  id: string;
  display_name: string | null;
  repo_identity: string;
  props: unknown;
}

export interface DerivePatternsUserSummary {
  projects: number;
  patterns: number;
  drafted: number;
}

export interface DerivePatternsSummary extends DerivePatternsUserSummary {
  users: number;
  failedUsers: number;
  skippedTimeBudget: number;
}

export interface DerivePatternsOptions {
  now?: Date;
  windowDays?: number;
  minSessions?: number;
  minLength?: number;
  /** Stop starting new users once `Date.now()` passes this (the cron's time budget). */
  deadlineMs?: number;
  /**
   * Builds the per-user LLM (null → heuristic drafts only). Default: a
   * cost-guarded client under the memory budget. Tests inject a fake.
   */
  llmFactory?: (userId: string) => Promise<{ llm: SkillDraftLlm | null; flush: () => Promise<void> }>;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const HEURISTIC_ONLY = { llm: null, flush: async () => {} };

async function defaultLlmFactory(
  supabase: Db,
  userId: string,
): Promise<{ llm: SkillDraftLlm | null; flush: () => Promise<void> }> {
  try {
    // Same gates as memory extraction, in the same order (see header).
    const feature = await checkFeature(userId, "memory");
    if (!feature.allowed) {
      log.info("patterns/derive: memory feature refused — heuristic drafts only", {
        user_id: userId,
        reason: feature.reason,
      });
      return HEURISTIC_ONLY;
    }
    const allowances = [DRAFT_CAP_USD_PER_PATTERN * MAX_PATTERNS_PER_PROJECT];
    if (feature.budgetUsd !== null) allowances.push(feature.budgetUsd - feature.spentUsd);
    // Issue #335: global daily AND monthly ceilings (all users).
    const global = await checkGlobalCeilings(supabase);
    if (!global.allowed) {
      log.info("patterns/derive: global spend ceiling — heuristic drafts only", {
        user_id: userId,
        reason: global.reason ?? "global_daily_ceiling",
      });
      return HEURISTIC_ONLY;
    }
    allowances.push(global.ceilingUsd - global.spentUsd);
    // Drafts bill the `memory` pass group (draft-skill.ts pass
    // memory_backfill ∈ MEMORY_PASSES), so the hosted monthly memory budget
    // caps them as it caps extraction. Unreadable spend throws → heuristic.
    const monthly = await memoryMonthlyRemainingUsd(supabase, userId);
    if (monthly !== null) allowances.push(monthly);
    const capUsd = Math.min(...allowances);
    if (!(capUsd > 0)) return HEURISTIC_ONLY;

    const guarded = await createCostGuardedLlm(supabase, userId, {
      // The `memory` gate was checked above; the client's own gate is `llm` (extraction does the same).
      bypassFeatureGate: true,
      capUsdOverride: capUsd,
      flushEvery: 1,
      timeoutMs: DRAFT_LLM_TIMEOUT_MS,
      maxRetries: DRAFT_LLM_MAX_RETRIES,
    });
    if (!guarded.ok) {
      log.info("patterns/derive: LLM refused for this user — heuristic drafts only", {
        user_id: userId,
        reason: guarded.reason,
      });
      return { llm: null, flush: async () => {} };
    }
    return { llm: guarded.llm, flush: guarded.flushSpend };
  } catch (err) {
    log.warn("patterns/derive: could not build the LLM client — heuristic drafts only", {
      user_id: userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return { llm: null, flush: async () => {} };
  }
}

async function fetchSessions(supabase: Db, userId: string, sinceIso: string): Promise<SessionRow[]> {
  return selectAllRows<SessionRow>((a, b) =>
    supabase
      .from("code_sessions")
      .select("id, user_id, code_project_id, started_at")
      .eq("user_id", userId)
      .is("parent_source_session_id", null)
      .not("code_project_id", "is", null)
      .gte("started_at", sinceIso)
      .order("id")
      .range(a, b),
  );
}

async function fetchTurns(supabase: Db, sessionIds: string[]): Promise<TurnRow[]> {
  const out: TurnRow[] = [];
  for (const chunk of chunks(sessionIds, IN_CHUNK)) {
    const rows = await selectAllRows<TurnRow>(
      (a, b) =>
        supabase
          .from("code_session_turns")
          .select("session_id, tool_name, file_path, ts, props")
          .in("session_id", chunk)
          .not("tool_name", "is", null)
          .order("session_id")
          .order("idx")
          .range(a, b) as unknown as PromiseLike<{ data: TurnRow[] | null; error: { message: string } | null }>,
    );
    out.push(...rows);
  }
  return out;
}

async function fetchProjects(supabase: Db, projectIds: string[]): Promise<ProjectRow[]> {
  const out: ProjectRow[] = [];
  for (const chunk of chunks(projectIds, IN_CHUNK)) {
    const rows = await selectAllRows<ProjectRow>(
      (a, b) =>
        supabase
          .from("code_projects")
          .select("id, display_name, repo_identity, props")
          .in("id", chunk)
          .order("id")
          .range(a, b) as unknown as PromiseLike<{ data: ProjectRow[] | null; error: { message: string } | null }>,
    );
    out.push(...rows);
  }
  return out;
}

/**
 * P9's quotes: the owner's opening prompt (first user prose turn) in up to
 * MAX_DRAFT_QUOTES of the pattern's sessions, most recent first. A read
 * failure yields no quotes, never a failed draft.
 */
/** User prose turns read per session to find its first non-empty prompt. */
const QUOTE_TURNS_PER_SESSION = 10;

async function fetchPatternQuotes(supabase: Db, userId: string, sessionIds: string[]): Promise<PatternQuote[]> {
  const ids = sessionIds.slice(0, MAX_DRAFT_QUOTES);
  if (ids.length === 0) return [];
  // One small read per session (review N4): a shared 200-row page ordered by
  // session let one long session starve the others of their quote.
  const perSession = await Promise.all(
    ids.map(async (id): Promise<PatternQuote | null> => {
      const { data, error } = (await supabase
        .from("code_session_turns")
        .select("session_id, idx, text")
        .eq("user_id", userId)
        .eq("session_id", id)
        .eq("role", "user")
        .eq("kind", "prose")
        .order("idx")
        .limit(QUOTE_TURNS_PER_SESSION)) as {
        data: { session_id: string; idx: number; text: string | null }[] | null;
        error: { message: string } | null;
      };
      if (error) {
        log.warn("patterns/derive: quote read failed — drafting without it", { user_id: userId, err: error.message });
        return null;
      }
      const row = (data ?? []).find((r) => !!r.text?.trim());
      return row ? { session_id: id, turn_idx: row.idx, quote: (row.text as string).trim() } : null;
    }),
  );
  return perSession.filter((q): q is PatternQuote => !!q);
}

/** The row's `props` as of now, or `fallback` when the re-read errors or finds no row. */
async function readProjectProps(supabase: Db, projectId: string, fallback: unknown): Promise<unknown> {
  const { data, error } = (await supabase.from("code_projects").select("props").eq("id", projectId).maybeSingle()) as {
    data: { props?: unknown } | null;
    error: { message: string } | null;
  };
  if (error || !data) return fallback;
  return data.props;
}

function draftIsFresh(existing: StoredPattern | undefined, nowMs: number): boolean {
  if (!existing?.draft?.draftedAt) return false;
  const at = Date.parse(existing.draft.draftedAt);
  return Number.isFinite(at) && nowMs - at < REDRAFT_AFTER_DAYS * 86_400_000;
}

/**
 * Mine and store patterns for one user's projects. Reads the user's
 * top-level sessions of the window, their tool turns and the projects'
 * current props; writes `props.patterns` (≤ 3) per project that had any.
 * A project whose stored patterns all went stale gets an empty list.
 */
export async function derivePatternsForUser(
  supabase: Db,
  userId: string,
  opts: DerivePatternsOptions = {},
): Promise<DerivePatternsUserSummary> {
  const now = opts.now ?? new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();
  const sinceIso = new Date(nowMs - (opts.windowDays ?? PATTERN_WINDOW_DAYS) * 86_400_000).toISOString();
  const minSessions = opts.minSessions ?? PATTERN_MIN_SESSIONS;
  const minLength = opts.minLength ?? PATTERN_MIN_LENGTH;

  const sessions = await fetchSessions(supabase, userId, sinceIso);
  const byProject = new Map<string, SessionRow[]>();
  for (const s of sessions) {
    if (!s.code_project_id) continue;
    const list = byProject.get(s.code_project_id) ?? [];
    list.push(s);
    byProject.set(s.code_project_id, list);
  }
  // A project with fewer sessions than minSessions cannot have a pattern — skip its turns read.
  const candidateProjects = [...byProject.entries()].filter(([, list]) => list.length >= minSessions);
  if (candidateProjects.length === 0) return { projects: 0, patterns: 0, drafted: 0 };

  const sessionIds = candidateProjects.flatMap(([, list]) => list.map((s) => s.id));
  const [turns, projects] = await Promise.all([
    fetchTurns(supabase, sessionIds),
    fetchProjects(
      supabase,
      candidateProjects.map(([id]) => id),
    ),
  ]);
  const turnsBySession = new Map<string, PatternTurn[]>();
  for (const t of turns) {
    const list = turnsBySession.get(t.session_id) ?? [];
    list.push({ tool_name: t.tool_name, file_path: t.file_path, ts: t.ts, props: t.props });
    turnsBySession.set(t.session_id, list);
  }
  const projectById = new Map(projects.map((p) => [p.id, p]));

  let llmHandle: { llm: SkillDraftLlm | null; flush: () => Promise<void> } | null = null;
  const getLlm = async () => {
    if (!llmHandle)
      llmHandle = opts.llmFactory ? await opts.llmFactory(userId) : await defaultLlmFactory(supabase, userId);
    return llmHandle.llm;
  };

  let patternsTotal = 0;
  let drafted = 0;
  let projectsWritten = 0;
  try {
    for (const [projectId, list] of candidateProjects) {
      const project = projectById.get(projectId);
      if (!project) continue;
      const input: Record<string, PatternTurn[]> = {};
      for (const s of list) input[s.id] = turnsBySession.get(s.id) ?? [];
      const mined: Pattern[] = minePatterns(input, { minSessions, minLength, maxPatterns: MAX_PATTERNS_PER_PROJECT });
      const existing = parseStoredPatterns(project.props);
      if (mined.length === 0 && existing.length === 0) continue;
      const existingByKey = new Map(existing.map((p) => [p.key, p]));

      const stored: StoredPattern[] = [];
      for (const pattern of mined) {
        const prior = existingByKey.get(pattern.key);
        if (prior && draftIsFresh(prior, nowMs)) {
          stored.push({ ...pattern, minedAt: nowIso, draft: prior.draft });
          continue;
        }
        const quotes = await fetchPatternQuotes(supabase, userId, pattern.sessionIds);
        const draft = await draftSkill(pattern, await getLlm(), {
          projectId,
          projectName: project.display_name || project.repo_identity,
          quotes,
        });
        drafted++;
        stored.push({ ...pattern, minedAt: nowIso, draft: { ...draft, draftedAt: nowIso } });
      }

      // Re-read props right before the write: the LLM drafts above can take
      // seconds, and a concurrent rollup may have rewritten other keys in the
      // meantime (F11). Fall back to the row we fetched when the re-read fails.
      const currentProps = await readProjectProps(supabase, projectId, project.props);
      const { error } = await supabase
        .from("code_projects")
        .update({ props: withStoredPatterns(currentProps, stored), updated_at: nowIso })
        .eq("id", projectId);
      if (error) throw new Error(error.message);
      projectsWritten++;
      patternsTotal += stored.length;
    }
  } finally {
    if (llmHandle) {
      try {
        await (llmHandle as { flush: () => Promise<void> }).flush();
      } catch (err) {
        log.warn("patterns/derive: spend flush failed", {
          user_id: userId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { projects: projectsWritten, patterns: patternsTotal, drafted };
}

/** Distinct users with a top-level code session in the window. */
async function listActiveUsers(supabase: Db, sinceIso: string): Promise<string[]> {
  const rows = await selectAllRows<{ user_id: string }>((a, b) =>
    supabase
      .from("code_sessions")
      .select("user_id")
      .is("parent_source_session_id", null)
      .gte("started_at", sinceIso)
      .order("user_id")
      .range(a, b),
  );
  return [...new Set(rows.map((r) => r.user_id))];
}

/** The cron step: every active user, one at a time, inside the caller's deadline. A user's failure is logged and counted. */
export async function derivePatternsNightly(
  supabase: Db,
  opts: DerivePatternsOptions = {},
): Promise<DerivePatternsSummary> {
  const now = opts.now ?? new Date();
  const sinceIso = new Date(now.getTime() - (opts.windowDays ?? PATTERN_WINDOW_DAYS) * 86_400_000).toISOString();
  const users = await listActiveUsers(supabase, sinceIso);
  const summary: DerivePatternsSummary = {
    users: users.length,
    projects: 0,
    patterns: 0,
    drafted: 0,
    failedUsers: 0,
    skippedTimeBudget: 0,
  };
  for (let i = 0; i < users.length; i++) {
    if (opts.deadlineMs !== undefined && Date.now() > opts.deadlineMs) {
      summary.skippedTimeBudget = users.length - i;
      break;
    }
    try {
      const one = await derivePatternsForUser(supabase, users[i], opts);
      summary.projects += one.projects;
      summary.patterns += one.patterns;
      summary.drafted += one.drafted;
    } catch (err) {
      summary.failedUsers++;
      log.error("patterns/derive: user failed — continuing with the next", {
        user_id: users[i],
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return summary;
}
