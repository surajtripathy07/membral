// Goal 2026-09-24 review B1: what drives the memory extraction queue
// (extraction-queue.ts). Each POST /api/memory/extract-next answers 202 at
// once and, in its own after() inside its own maxDuration (300s), runs
// sessions for the user one after another until one says stop or time runs
// short (runMemoryExtractionStep). Issue #339: it never POSTs itself — the
// host refused that self-call chain (HTTP 508, loop detected); the next
// batch comes from the next upload, kick or cron trigger.
//
// AUTH: a server-only bearer token derived from the service-role key
// (HMAC-SHA256 over a fixed label). Every deployment that can run
// extraction already has that key, so local dev and the smoke test need no
// extra env var, and the raw key never goes over the wire. The daily cron
// (/api/internal/cron/memory-extraction) authenticates with CRON_SECRET like
// /api/internal/cron/advance, then triggers extract-next with the derived token.
import { createHmac, timingSafeEqual } from "node:crypto";
import { getAppUrl, SERVICE_ROLE_KEY_ENV } from "@/lib/env";
import { log } from "@/lib/log";
import { logMemoryExtraction } from "./extraction-log";
import {
  MEMORY_MAX_SESSIONS_PER_INVOCATION,
  MEMORY_MIN_REMAINING_TO_START_MS,
  MEMORY_RUN_DEADLINE_MS,
  type MemoryStepResult,
  type ProcessNextOptions,
  processNextMemoryExtraction,
} from "./extraction-queue";

export const MEMORY_EXTRACT_NEXT_PATH = "/api/memory/extract-next";
const TOKEN_LABEL = "membral:memory-extract-next:v1";
const TRIGGER_TIMEOUT_MS = 10_000;

/** extract-next's bearer token, or undefined when the service-role key is unset (the route then refuses with 503). */
export function memoryWorkerToken(env: Record<string, string | undefined> = process.env): string | undefined {
  const key = env[SERVICE_ROLE_KEY_ENV]?.trim();
  if (!key) return undefined;
  return createHmac("sha256", key).update(TOKEN_LABEL).digest("hex");
}

export type MemoryWorkerAuth = "ok" | "not_configured" | "forbidden";

export function checkMemoryWorkerAuth(
  authorization: string | null,
  env: Record<string, string | undefined> = process.env,
): MemoryWorkerAuth {
  const token = memoryWorkerToken(env);
  if (!token) return "not_configured";
  const expected = Buffer.from(`Bearer ${token}`);
  const got = Buffer.from(authorization ?? "");
  return got.length === expected.length && timingSafeEqual(got, expected) ? "ok" : "forbidden";
}

/**
 * Where a trigger POSTs the service-role-derived bearer. Env only
 * (NEXT_PUBLIC_APP_URL via getAppUrl) in EVERY environment — never the
 * request's URL or Host header, which a caller controls (issue #371: a
 * loopback Host such as localhost:9999 used to redirect the bearer to
 * whatever listens there). Dev on a non-default port must set
 * NEXT_PUBLIC_APP_URL: scripts/dev-up.sh writes it to .env.local and
 * scripts/ci-local.sh sets it for the smoke server on :3001; unset, the
 * fallback is http://localhost:3000.
 */
export function resolveInternalBaseUrl(): string {
  return getAppUrl();
}

/** POSTs one extract-next call and waits only for its 202. Never throws; false on any failure (logged — the cron is the backstop). */
export async function triggerMemoryExtraction(
  userId: string,
  baseUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  const token = memoryWorkerToken();
  if (!token) {
    log.error(`memory: cannot trigger extraction — ${SERVICE_ROLE_KEY_ENV} is not set`, { user_id: userId });
    return false;
  }
  try {
    const res = await fetchImpl(`${baseUrl}${MEMORY_EXTRACT_NEXT_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(TRIGGER_TIMEOUT_MS),
    });
    if (res.status !== 202) {
      log.error("memory: extract-next trigger refused", { user_id: userId, status: res.status });
      return false;
    }
    return true;
  } catch (err) {
    log.error("memory: extract-next trigger failed", {
      user_id: userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

const ERROR_CLASS_MAX_CHARS = 64;

/** An error's class name (e.g. "TypeError"), capped at 64 chars; typeof for a non-Error throw. */
export function errorClassName(err: unknown): string {
  const name = err instanceof Error ? err.constructor?.name || err.name || "Error" : typeof err;
  return name.slice(0, ERROR_CLASS_MAX_CHARS);
}

export interface MemoryLoopDeps {
  process?: (userId: string, opts: ProcessNextOptions) => Promise<MemoryStepResult>;
  /** Clock for the invocation deadline (tests). Default Date.now. */
  clock?: () => number;
  /** Default MEMORY_RUN_DEADLINE_MS. */
  deadlineMs?: number;
  /** Default MEMORY_MIN_REMAINING_TO_START_MS. */
  minRemainingMs?: number;
  /** Default MEMORY_MAX_SESSIONS_PER_INVOCATION. */
  maxSessions?: number;
}

export interface MemoryLoopResult {
  /** The last step run, or a synthetic none_claimed carrying `stopReason` when none ran. */
  step: MemoryStepResult;
  /** Steps that claimed a session in this invocation. */
  sessionsProcessed: number;
  /** The last step's reason (or outcome), or too_little_time / session_cap / step_error. */
  stopReason: string;
}

/**
 * The body of extract-next's after() (issue #339). Runs steps for one user in
 * THIS invocation while the last step says the next may run now, against one
 * deadline measured from the invocation's start. It never POSTs extract-next:
 * the host refuses a function that calls itself (HTTP 508), which stalled the
 * queue. Stops on the first step that says stop (failed window, provider
 * error, budget, ceiling, flag, no progress — counted on the first step,
 * released uncounted on a later one — nothing claimed; rule 4: a 429
 * is never retried at once), on deadline_partial (its time is spent; the row
 * is pending again for the next trigger), when too little time is left to
 * start a session, or at the step cap. One summary log line. Never throws.
 */
export async function runMemoryExtractionStep(userId: string, deps: MemoryLoopDeps = {}): Promise<MemoryLoopResult> {
  const processFn = deps.process ?? processNextMemoryExtraction;
  const clock = deps.clock ?? Date.now;
  const deadlineMs = deps.deadlineMs ?? MEMORY_RUN_DEADLINE_MS;
  const minRemainingMs = deps.minRemainingMs ?? MEMORY_MIN_REMAINING_TO_START_MS;
  const maxSessions = deps.maxSessions ?? MEMORY_MAX_SESSIONS_PER_INVOCATION;
  const invocationStartedAt = clock();
  let last: MemoryStepResult | undefined;
  let steps = 0;
  let sessionsProcessed = 0;
  let stopReason: string;
  for (;;) {
    if (steps >= maxSessions) {
      stopReason = "session_cap";
      break;
    }
    // Checked BEFORE the claim, so a session never burns an attempt on a run
    // started too late to progress.
    if (deadlineMs - (clock() - invocationStartedAt) < minRemainingMs) {
      stopReason = "too_little_time";
      break;
    }
    steps++;
    try {
      last = await processFn(userId, { clock, deadlineMs, invocationStartedAt, stepIndex: steps - 1 });
    } catch (err) {
      logMemoryExtraction({
        event: "fail",
        reason: "step_error",
        userId,
        // The error's class name only, never its message (it could echo
        // provider or transcript text).
        error: errorClassName(err),
      });
      stopReason = "step_error";
      break;
    }
    if (last.sessionId) sessionsProcessed++;
    if (!last.continueChain) {
      stopReason = last.reason ?? last.outcome;
      break;
    }
    if (last.reason === "deadline_partial") {
      stopReason = "deadline_partial";
      break;
    }
  }
  logMemoryExtraction({
    event: "invocation",
    userId,
    sessionCount: sessionsProcessed,
    reason: stopReason,
    durationMs: clock() - invocationStartedAt,
  });
  return {
    step: last ?? { outcome: "none_claimed", reason: stopReason, continueChain: false },
    sessionsProcessed,
    stopReason,
  };
}
