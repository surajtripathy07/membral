/**
 * G2 2.3h: the pure checkpoint/budget arithmetic of a tail-capture run's
 * summary, lifted verbatim from `runTailCaptureInner`'s finalize block. No
 * I/O; every function is a single expression over its arguments.
 */

/** Distinct turn indexes covered by the windows budget degrade selected. */
export function countTailTurnsExtracted(selected: ReadonlyArray<{ turns: ReadonlyArray<{ idx: number }> }>): number {
  return new Set(selected.flatMap((w) => w.turns.map((t) => t.idx))).size;
}

/** Tail turns past the new checkpoint (all of them when it did not move to a turn). */
export function countTailTurnsUncovered(
  tailTurns: ReadonlyArray<{ idx: number }>,
  checkpointIdx: number | null,
): number {
  return tailTurns.filter((t) => checkpointIdx === null || t.idx > checkpointIdx).length;
}

/** True when the new checkpoint is set and past the one this run started from. */
export function didCheckpointAdvance(checkpointIdx: number | null, checkpoint: number | null): boolean {
  return checkpointIdx !== null && (checkpoint === null || checkpointIdx > checkpoint);
}

/** Main-pass windows whose LLM call failed plus user-pass windows that failed. */
export function countWindowsFailed(failedWindowIndexes: ReadonlySet<number>, userPassWindowsFailed: number): number {
  return failedWindowIndexes.size + userPassWindowsFailed;
}

/** The run's spend: chat extraction plus embeddings. */
export function runCostUsd(extractionCostUsd: number, embedCostUsd: number): number {
  return extractionCostUsd + embedCostUsd;
}
