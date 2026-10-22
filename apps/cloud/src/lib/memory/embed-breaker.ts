// Circuit breaker for the prompt-recall query embedding (per process, in memory).
//
// Prompt recall gives the query embedding a short deadline and falls back to keyword-only results when it misses.
// When the embedding provider is slow for a stretch, waiting out the deadline on every request just burns the
// budget: after SKIP_LIMIT deadline misses within WINDOW_MS the breaker opens and the next OPEN_MS skip the
// dense leg without waiting. It closes by itself once OPEN_MS has passed; nothing persists across processes.

export const EMBED_BREAKER_SKIP_LIMIT = 3;
export const EMBED_BREAKER_WINDOW_MS = 60_000;
export const EMBED_BREAKER_OPEN_MS = 30_000;

export interface EmbedBreaker {
  /** True while open; closes (and forgets its skips) once the open period has passed. */
  isOpen(): boolean;
  /** Record one deadline miss; opens the breaker on the SKIP_LIMIT-th within the window. */
  recordSkip(): void;
  /** A vector arrived within the deadline: forget the pending skips (an open breaker stays open until its time is up). */
  recordSuccess(): void;
  reset(): void;
}

export function createEmbedBreaker(clock: () => number = Date.now): EmbedBreaker {
  let skips: number[] = [];
  let openUntil = 0;
  return {
    isOpen() {
      if (openUntil === 0) return false;
      if (clock() < openUntil) return true;
      openUntil = 0;
      skips = [];
      return false;
    },
    recordSkip() {
      const now = clock();
      skips = skips.filter((t) => now - t < EMBED_BREAKER_WINDOW_MS);
      skips.push(now);
      if (skips.length >= EMBED_BREAKER_SKIP_LIMIT) {
        openUntil = now + EMBED_BREAKER_OPEN_MS;
        skips = [];
      }
    },
    recordSuccess() {
      if (openUntil === 0) skips = [];
    },
    reset() {
      skips = [];
      openUntil = 0;
    },
  };
}

/** The process-wide breaker prompt recall uses; tests build their own with an injected clock. */
export const promptRecallEmbedBreaker: EmbedBreaker = createEmbedBreaker();
