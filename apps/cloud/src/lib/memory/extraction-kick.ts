// The memory-extraction kick: reconcile (full mode), list queued users, back off, and kick one extract-next chain per
// user. Shared by GET /api/internal/cron/memory-extraction and the in-process loop (lib/memory/extraction-loop.ts), so
// there is one claim path. Moved verbatim from the route; the route keeps auth, the daily stats and the patterns step.
import { getServiceClient, SUPABASE_ENV_MISSING_MESSAGE } from "@/lib/db/clients";
import { log } from "@/lib/log";
import { type MemoryQueueListingRow, partitionUsersForKick } from "@/lib/memory/extraction-backoff";
import {
  MEMORY_QUEUE_TABLE,
  type ReconcileSummary,
  reconcileMemoryExtractionQueue,
} from "@/lib/memory/extraction-queue";
import { resolveInternalBaseUrl, triggerMemoryExtraction } from "@/lib/memory/extraction-trigger";
import { selectAllRows } from "@/lib/util/pagination";

/** Stop kicking chains after this long, well inside maxDuration, and log how many users were left. */
export const CRON_TIME_BUDGET_MS = 250_000;

export interface KickSummary {
  mode: "kick" | "full";
  users: number;
  kicked: number;
  failed: number;
  skipped_time_budget: number;
  skipped_backoff: number;
}

export type KickResult =
  | {
      ok: true;
      startedAt: number;
      supabase: ReturnType<typeof getServiceClient>;
      reconciled: ReconcileSummary | null;
      kickSummary: KickSummary;
    }
  | { ok: false; error: string };

export async function kickExtraction(mode: "kick" | "full"): Promise<KickResult> {
  const startedAt = Date.now();
  const now = new Date(startedAt);
  const nowIso = now.toISOString();
  let userIds: string[];
  let skippedBackoff: string[];
  let reconciled: ReconcileSummary | null = null;
  let supabase: ReturnType<typeof getServiceClient>;
  try {
    supabase = getServiceClient({
      message: SUPABASE_ENV_MISSING_MESSAGE,
    });
    if (mode === "full") {
      try {
        reconciled = await reconcileMemoryExtractionQueue(supabase);
      } catch (err) {
        log.error("cron/memory-extraction: reconcile failed — kicking the chains already queued", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const rows = await selectAllRows<MemoryQueueListingRow & { session_id: string }>((from, to) =>
      supabase
        .from(MEMORY_QUEUE_TABLE)
        .select("user_id, session_id, status, attempts, updated_at, last_reason")
        .or(`status.eq.pending,and(status.eq.running,lease_until.lt.${nowIso})`)
        .order("session_id")
        .range(from, to),
    );
    // Issue #339 backoff: a user whose most recent counted failure is too
    // recent is not kicked (rule 4). Applies to this route only — the upload
    // route's kick and POST /api/memory/extraction/kick are user actions and
    // still kick at once.
    const split = partitionUsersForKick(rows, now);
    userIds = split.kick;
    skippedBackoff = split.skippedBackoff;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("cron/memory-extraction: failed to list queued users — this run does nothing", { err: message, mode });
    return { ok: false, error: message };
  }

  const baseUrl = resolveInternalBaseUrl();
  let kicked = 0;
  let failed = 0;
  let skippedTimeBudget = 0;
  for (let i = 0; i < userIds.length; i++) {
    if (Date.now() - startedAt > CRON_TIME_BUDGET_MS) {
      skippedTimeBudget = userIds.length - i;
      break;
    }
    if (await triggerMemoryExtraction(userIds[i], baseUrl)) kicked++;
    else failed++;
  }

  const kickSummary = {
    mode,
    users: userIds.length + skippedBackoff.length,
    kicked,
    failed,
    skipped_time_budget: skippedTimeBudget,
    skipped_backoff: skippedBackoff.length,
  };
  if (mode === "kick") {
    log.info("cron/memory-extraction: done", { ...kickSummary, duration_ms: Date.now() - startedAt });
  }
  return { ok: true, startedAt, supabase, reconciled, kickSummary };
}
