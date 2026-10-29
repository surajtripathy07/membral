// ANALYZE keeps memory_search_scored fast on PGlite (no autovacuum: 108 s at 10k rows without it, 121 ms after).
// Runs every 10 minutes when a write happened since the last run, and after 500 writes. Never REINDEX (blocks ~45 s).

export interface Maintenance {
  noteWrite(): void;
  /** Runs ANALYZE now. Called inside a store transaction callback, the embedded store defers it until the transaction ends and resolves at once. */
  analyzeNow(): Promise<void>;
  stop(): void;
}

export const ANALYZE_INTERVAL_MS = 10 * 60 * 1000;
export const ANALYZE_AFTER_WRITES = 500;

export function startMaintenance(
  analyze: () => Promise<unknown>,
  opts: { intervalMs?: number; afterWrites?: number; onError?: (e: unknown) => void } = {},
): Maintenance {
  const intervalMs = opts.intervalMs ?? ANALYZE_INTERVAL_MS;
  const afterWrites = opts.afterWrites ?? ANALYZE_AFTER_WRITES;
  let dirty = 0;
  let running: Promise<void> | null = null;
  let stopped = false;

  const run = (): Promise<void> => {
    if (running) return running;
    dirty = 0;
    running = Promise.resolve()
      .then(() => analyze())
      .then(
        () => undefined,
        (e) => opts.onError?.(e),
      )
      .finally(() => {
        running = null;
      });
    return running;
  };

  const timer = setInterval(() => {
    if (!stopped && dirty > 0) void run();
  }, intervalMs);
  timer.unref?.();

  return {
    noteWrite() {
      if (stopped) return;
      dirty++;
      if (dirty >= afterWrites) void run();
    },
    analyzeNow: run,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
