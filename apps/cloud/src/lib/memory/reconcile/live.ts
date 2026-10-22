// L1 live write path, behind MEMBRAL_RECONCILE=1 (default OFF; local claude-code provider only, never hosted).
// After a record is inserted, reconcile that record against its project's older live records: a per-write call cap, a
// wall-clock timeout, and no throw ever -- the write has already landed and nothing here may block or fail it. With the
// flag off this module does nothing (no read, no call).
import type { Db } from "@/lib/db/types";
import { log } from "@/lib/log";
import { propose } from "./engine";
import { providerProblem } from "./guards";
import { supabaseSource, writePlan } from "./io";
import type { JudgeLlm } from "./judge";
import { projectionFor } from "./plan";
import { RECONCILE_PROMPT_VERSION } from "./verdict";

export const LIVE_MAX_CALLS = 3;
export const LIVE_TIMEOUT_MS = 30_000;
/** At most this many records one insert may hide; further links are stored but not projected. */
export const LIVE_MAX_HIDES = 5;

type Env = Record<string, string | undefined>;

/** At most LIVE_MAX_HIDES projections per insert, in projectionFor's order (by target id). Pure. */
export function capLiveProjections<T>(projections: readonly T[]): T[] {
  return projections.slice(0, LIVE_MAX_HIDES);
}

/** The flag and its provider conditions. Anything but exactly "1" on a local claude-code setup is off. */
export function liveReconcileEnabled(env: Env = process.env): boolean {
  if (env.MEMBRAL_RECONCILE?.trim() !== "1") return false;
  if (env.MEMBRAL_LOCAL !== "1") return false;
  // The kicker's client passes no --model when MEMBRAL_MODEL is unset (the CLI default), so sonnet must be explicit.
  if (env.MEMBRAL_MODEL?.trim() !== "sonnet") return false;
  return providerProblem(env, false) === null;
}

/**
 * Reconciles `recordIds` (just inserted, live). Returns the number of records it hid. Never throws.
 */
export async function reconcileInserted(
  supabase: Db,
  userId: string,
  projectId: string,
  recordIds: readonly string[],
  llm: JudgeLlm,
  opts: {
    env?: Env;
    maxCalls?: number;
    timeoutMs?: number;
  } = {},
): Promise<number> {
  const env = opts.env ?? process.env;
  if (!liveReconcileEnabled(env) || recordIds.length === 0) return 0;
  // The client must itself be on sonnet (its label comes from MEMBRAL_MODEL); anything else is refused.
  if (llm.modelName !== undefined && llm.modelName !== "claude-code/sonnet") return 0;
  const timeoutMs = opts.timeoutMs ?? LIVE_TIMEOUT_MS;
  const ctl = { timedOut: false };
  const shouldStop = () => ctl.timedOut;
  const work = async (): Promise<number> => {
    const src = supabaseSource(supabase, userId, projectId);
    const res = await propose(src, llm, {
      maxCalls: opts.maxCalls ?? LIVE_MAX_CALLS,
      conversationId: `reconcile-live-${recordIds[0]}`,
      onlyIds: new Set(recordIds),
      seen: new Set(),
      shouldStop,
    });
    if (shouldStop()) return 0;
    // A provider failure falls back to today's planSupersede rule, which already ran: nothing more to write.
    if (res.providerFailed || res.links.length === 0) return 0;
    // At most LIVE_MAX_HIDES records hidden per insert; the excess links are stored (memoised) but not projected.
    const projections = capLiveProjections(projectionFor(res.links));
    const model = "claude-code/sonnet";
    await writePlan(
      supabase,
      userId,
      { runId: `live-${Date.now()}`, model, promptVersion: RECONCILE_PROMPT_VERSION },
      res.links,
      res.judgedPairs,
      projections,
      shouldStop,
    );
    return shouldStop() ? 0 : projections.length;
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      new Promise<number>((resolve) => {
        timer = setTimeout(() => {
          // A timeout during the apply rpc may still commit: the rpc is one transaction, so that is atomic and acceptable.
          ctl.timedOut = true;
          log.warn("memory reconcile: live pass timed out, skipped", { user_id: userId });
          resolve(0);
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    log.warn("memory reconcile: live pass failed, skipped", {
      user_id: userId,
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
