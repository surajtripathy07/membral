// Process-wide queue for the raw-unit tasks the import route schedules with after(). Without it, 20 sessions per POST
// times N concurrent POSTs would run that many embedding runs and rpcs at once. FIFO, RAW_UNIT_CONCURRENCY at a time,
// errors swallowed and logged, bounded; a later task for a session supersedes an earlier still-pending one (staleness
// is decided by source_hash, so only the newest turns matter).
import { log } from "@/lib/log";

/** How many raw-unit tasks run at once in this process. */
export const RAW_UNIT_CONCURRENCY = 1;
/** Pending tasks kept; past it the oldest pending task is dropped (logged). */
export const RAW_UNIT_QUEUE_MAX = 200;

interface Pending {
  sessionId: string;
  task: () => Promise<void>;
  done: () => void;
}

const pending: Pending[] = [];
let running = 0;

function pump(): void {
  while (running < RAW_UNIT_CONCURRENCY && pending.length > 0) {
    const next = pending.shift() as Pending;
    running++;
    next
      .task()
      .catch((err) => {
        log.warn("raw units: queued task failed", {
          session_id: next.sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        running--;
        next.done();
        pump();
      });
  }
}

/**
 * Queues `task`. The returned promise settles when the task has run, been superseded by a later task for the same
 * session, or been dropped (never rejects), so it can be handed to after() to keep the invocation alive.
 */
export function enqueueRawUnitTask(sessionId: string, task: () => Promise<void>): Promise<void> {
  return new Promise<void>((done) => {
    const dup = pending.findIndex((p) => p.sessionId === sessionId);
    if (dup >= 0) {
      const [old] = pending.splice(dup, 1);
      log.info("raw units: pending task superseded by a later one", { session_id: sessionId });
      old.done();
    }
    if (pending.length >= RAW_UNIT_QUEUE_MAX) {
      const [oldest] = pending.splice(0, 1);
      log.warn("raw units: queue full, dropped the oldest pending task", { session_id: oldest.sessionId });
      oldest.done();
    }
    pending.push({ sessionId, task, done });
    pump();
  });
}

/** Test hook. */
export function resetRawUnitQueue(): void {
  pending.length = 0;
  running = 0;
}
