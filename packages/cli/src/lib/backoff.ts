// Retry/backoff delay computations for the CLI's HTTP calls.
//
// RULE4_BACKOFF (below) is the one curve every endpoint of the policy client
// (./api-client.ts) uses (docs/design/cli-api-client-contract.md §5); the
// per-caller tables it replaced (import, upload, known-sessions) are gone
// with R4 4.3. KICK_BACKOFF stays: memory-kick persists its own file backoff.
//
// CLAUDE.md rule 4: never retry a 429 immediately; back off proportionally
// (bigger multiplier while the delay is small, smaller as it grows); decay
// the delay by 0.9x on success; never reset it to the initial value. No
// jitter (Math.random) — the delay is a pure function of the previous delay
// and, where noted, the server's Retry-After header.

const KICK_INITIAL_DELAY_MS = 10_000;
const KICK_MAX_DELAY_MS = 60 * 60_000;

/** memory-kick.ts's persisted (file-backed) 429 backoff for the memory-extraction kick. */
export const KICK_BACKOFF = {
  initialDelayMs: KICK_INITIAL_DELAY_MS,
  maxDelayMs: KICK_MAX_DELAY_MS,
  /** x3 while under a minute, x1.5 after, capped at the max. */
  nextDelay(delayMs: number): number {
    return Math.min(KICK_MAX_DELAY_MS, Math.round(delayMs < 60_000 ? delayMs * 3 : delayMs * 1.5));
  },
  /** Keeps a (possibly hand-edited or corrupt) delay within [initial, max]. */
  clampDelay(ms: number): number {
    if (!Number.isFinite(ms) || ms <= 0) return KICK_INITIAL_DELAY_MS;
    return Math.min(KICK_MAX_DELAY_MS, Math.max(KICK_INITIAL_DELAY_MS, ms));
  },
};

// ---------------------------------------------------------------------------
// The one rule-4 curve. The policy client keeps one BucketState per server
// rate bucket for the life of one command run.
// ---------------------------------------------------------------------------

const RULE4_INITIAL_DELAY_MS = 500;
const RULE4_MIN_WAIT_MS = 500;
const RULE4_MAX_WAIT_MS = 120_000;
const RULE4_INITIAL_PACE_MS = 1000;
const RULE4_MAX_PACE_MS = 30_000;

/** Backoff state for one server rate bucket. `epoch` dedupes growth across concurrent lanes. */
export interface BucketState {
  delayMs: number;
  paceMs: number;
  epoch: number;
}

export const RULE4_BACKOFF = {
  initialDelayMs: RULE4_INITIAL_DELAY_MS,
  minWaitMs: RULE4_MIN_WAIT_MS,
  /** In-process waits only; ApiResult.retryAfterMs stays raw. */
  maxWaitMs: RULE4_MAX_WAIT_MS,
  initialPaceMs: RULE4_INITIAL_PACE_MS,
  maxPaceMs: RULE4_MAX_PACE_MS,
  /** x5 while < 1 s, x3 while < 15 s, x1.3 while < 40 s, then hold: 500, 2,500, 7,500, 22,500, 29,250, 38,025, 49,433. */
  nextDelay(delayMs: number): number {
    if (delayMs < 1000) return Math.round(delayMs * 5);
    if (delayMs < 15000) return Math.round(delayMs * 3);
    if (delayMs < 40000) return Math.round(delayMs * 1.3);
    return delayMs;
  },
  /** Decay on success, never reset: max(500, round(delay x 0.9)). */
  decayDelay(delayMs: number): number {
    return Math.max(RULE4_INITIAL_DELAY_MS, Math.round(delayMs * 0.9));
  },
  /** 0 -> 1,000, x2 while < 5 s, then x1.3, capped at 30 s. */
  nextPace(paceMs: number): number {
    if (paceMs <= 0) return RULE4_INITIAL_PACE_MS;
    if (paceMs < 5000) return Math.min(RULE4_MAX_PACE_MS, Math.round(paceMs * 2));
    return Math.min(RULE4_MAX_PACE_MS, Math.round(paceMs * 1.3));
  },
  decayPace(paceMs: number): number {
    return Math.round(paceMs * 0.9);
  },
  /** A 429 is never retried immediately: min(120 s, max(Retry-After ?? delay, 500)). Retry-After wins when present. */
  rateLimitWaitMs(retryAfterMs: number | undefined, delayMs: number): number {
    return Math.min(RULE4_MAX_WAIT_MS, Math.max(retryAfterMs ?? delayMs, RULE4_MIN_WAIT_MS));
  },
  /** 5xx / network retry wait: the current delay, floored at 500 ms. */
  retryWaitMs(delayMs: number): number {
    return Math.min(RULE4_MAX_WAIT_MS, Math.max(delayMs, RULE4_MIN_WAIT_MS));
  },
};

export function createBucketState(): BucketState {
  return { delayMs: RULE4_INITIAL_DELAY_MS, paceMs: 0, epoch: 0 };
}

/**
 * On a 429, 5xx or network error. `delayMs` grows (and `epoch` bumps) only if
 * nobody else changed the state since this lane sent (`epochAtSend`), so one
 * burst across N lanes grows it once. `paceMs` grows on every 429 when the
 * endpoint paces, deduplicated or not.
 */
export function growBucketState(state: BucketState, epochAtSend: number, growPace: boolean): void {
  if (state.epoch === epochAtSend) {
    state.delayMs = RULE4_BACKOFF.nextDelay(state.delayMs);
    state.epoch++;
  }
  if (growPace) state.paceMs = RULE4_BACKOFF.nextPace(state.paceMs);
}

/** On success: decay both, bump `epoch`. */
export function decayBucketState(state: BucketState): void {
  state.delayMs = RULE4_BACKOFF.decayDelay(state.delayMs);
  state.paceMs = RULE4_BACKOFF.decayPace(state.paceMs);
  state.epoch++;
}

/**
 * Parses a Retry-After header — delta-seconds or an HTTP date — into ms,
 * RAW (no clamp; callers clamp their own waits). Undefined when absent or
 * unparseable.
 */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = Date.parse(trimmed);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, at - now);
}
