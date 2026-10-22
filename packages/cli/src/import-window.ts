/**
 * Default upload window for coding-session transcripts, in days.
 *
 * Matches the server's memory-extraction recency window
 * (apps/cloud/src/lib/memory/extraction-queue.ts DEFAULT_MEMORY_BACKFILL_MAX_AGE_DAYS):
 * sessions older than this produce no memories, so uploading them only costs
 * storage. Older history is opt-in: `membral sessions --all` or `--since <date>`.
 * Keep the two numbers in step.
 */
export const DEFAULT_IMPORT_WINDOW_DAYS = 30;

/** ISO timestamp `DEFAULT_IMPORT_WINDOW_DAYS` before `now`. */
export function defaultImportSince(now: Date = new Date()): string {
  return new Date(now.getTime() - DEFAULT_IMPORT_WINDOW_DAYS * 24 * 60 * 60_000).toISOString();
}

/**
 * The `since` an import should use: an explicit `--since` wins, `--all`
 * disables the window, otherwise the default window applies.
 */
export function resolveImportSince(
  opts: { since?: string; all?: boolean },
  now: Date = new Date(),
): string | undefined {
  if (opts.since) return opts.since;
  if (opts.all) return undefined;
  return defaultImportSince(now);
}
