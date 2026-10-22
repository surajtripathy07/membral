// Deterministic time and id sources for goldens. Nothing here reads the wall
// clock or Math.random(): a golden built on these is byte-stable across runs.

export interface FixedClock {
  /** The current instant (a fresh Date each call). */
  now: () => Date;
  /** The current instant as an ISO string. */
  iso: () => string;
  /** Moves the clock forward by `ms`. */
  advance: (ms: number) => void;
}

/** A clock frozen at `startIso`; it only moves when `advance` is called. */
export function createFixedClock(startIso: string): FixedClock {
  let ms = Date.parse(startIso);
  if (!Number.isFinite(ms)) throw new Error(`createFixedClock: unparseable instant ${startIso}`);
  return {
    now: () => new Date(ms),
    iso: () => new Date(ms).toISOString(),
    advance: (delta: number) => {
      ms += delta;
    },
  };
}

/** uuid-shaped ids from a counter: `<prefix>0000-0000-4000-8000-000000000001`, ... `prefix` is 8 hex chars. */
export function createIdSequence(prefix = "901d0000"): () => string {
  if (!/^[0-9a-f]{8}$/.test(prefix)) throw new Error("createIdSequence: prefix must be 8 lowercase hex chars");
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;
  };
}
