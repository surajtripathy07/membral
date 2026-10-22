// G2 step 2.4f: the pure lease-lock logic behind write/io.ts's
// setMemoryExtractionLock / releaseMemoryExtractionLock. The props patches,
// and the clock read that stamps a new lock, stay in write/io.ts.

/** step2d finding 3: how long a lease lock is honored before it's treated as abandoned (a crashed process, or a hard-throw path that never reached `updateSessionMemoryProps`) and safe to take over. */
export const MEMORY_EXTRACTION_LOCK_STALE_MS = 15 * 60 * 1000;

/** The shape stored at `code_sessions.props.memory_extraction_lock`. */
export interface MemoryExtractionLock {
  at: string;
  run_id: string;
}

/** True when `props.memory_extraction_lock` is present and not yet stale. Never throws on a malformed lock shape — treats it as not-held (fails open on a corrupt lock, rather than jamming extraction forever on bad data). */
export function isMemoryExtractionLockHeld(props: Record<string, unknown>, now: number = Date.now()): boolean {
  const lock = props.memory_extraction_lock;
  if (!lock || typeof lock !== "object") return false;
  const at = (lock as Partial<MemoryExtractionLock>).at;
  if (typeof at !== "string") return false;
  const ts = Date.parse(at);
  if (Number.isNaN(ts)) return false;
  return now - ts <= MEMORY_EXTRACTION_LOCK_STALE_MS;
}

/** The lock value a run writes: `at` then `run_id`. `at` is an ISO timestamp the caller takes. */
export function buildLock(at: string, runId: string): MemoryExtractionLock {
  return { at, run_id: runId };
}

/** The caller's local props view with `lock` set (a new object; `props` is not mutated). */
export function withLock(props: Record<string, unknown>, lock: MemoryExtractionLock): Record<string, unknown> {
  return { ...props, memory_extraction_lock: lock };
}
