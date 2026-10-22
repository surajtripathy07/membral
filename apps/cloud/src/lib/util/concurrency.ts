/**
 * Bounded-concurrency worker pool: runs `worker` over `items`, at most
 * `concurrency` at a time.
 *
 * `shouldStop` (issue #21, cost-cap halt): optional, checked in the loop
 * predicate before claiming the next item. When it flips true (e.g. a
 * conversation's classify call threw CostCapExceededError and the caller's
 * worker recorded that), no NEW item is claimed by any pool slot — in-flight
 * items already claimed keep running to completion (their rows still get
 * written), which is what makes a cap breach a clean halt rather than an
 * abort: nothing already in progress is torn down, and unclaimed items are
 * simply never started, so they stay resumable on the next run.
 */
export async function runPool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
  shouldStop?: () => boolean,
): Promise<void> {
  let idx = 0;
  const size = Math.max(1, Math.min(concurrency, items.length));
  const workers = Array.from({ length: size }, async () => {
    while (idx < items.length) {
      if (shouldStop?.()) return;
      const current = idx;
      idx += 1;
      await worker(items[current]);
    }
  });
  await Promise.all(workers);
}

/** Default cap for chunked PostgREST reads fanned out within one request (#173: keeps a heavy user off the pooler's limit). */
export const READ_FANOUT_LIMIT = 6;

/**
 * `items.map(fn)` with at most `limit` calls in flight, results in input
 * order. The first rejection rejects the whole call and stops new items from
 * being claimed (in-flight ones finish), like `Promise.all` over the same work.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const indexed = items.map((item, index) => ({ item, index }));
  let failed = false;
  await runPool(
    indexed,
    limit,
    async ({ item, index }) => {
      try {
        results[index] = await fn(item, index);
      } catch (err) {
        failed = true;
        throw err;
      }
    },
    () => failed,
  );
  return results;
}
