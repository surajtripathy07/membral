// Live progress for `membral setup` step 5 / `membral sessions` — pure
// formatting + throttling helpers, plus a thin writer that picks TTY
// (rewrite one line in place) vs non-TTY (throttled plain lines) output.
//
// Born from a real 2026-09-25 report: a ~1,166-session first import, paced
// at ~27/min for the server's rate limit, printed nothing for ~40 minutes
// after "Ready to import..." — the run was fine, but looked hung. See
// import-sessions.ts's upload loop for where this hooks in, and
// code-session-upload.ts's `uploadBatch` for the pacing/429 backoff this
// surfaces.
//
// Kept dependency-free and side-effect-free (no `Date.now()`/`process.*`
// calls baked in — callers inject `now`/`write`/`log`) so every piece here
// is a plain function or a small class over injected clocks/sinks, cheap to
// unit test without faking timers or capturing real stdout.

/** One line of the "Parsing N[/total]…" phase. `total` is omitted for opencode, whose session count isn't known until its generator finishes (see import-sessions.ts). */
export function formatParseLine(harness: string, done: number, total?: number): string {
  const count = total !== undefined ? `${done}/${total}` : `${done}`;
  return `${harness}: Parsing ${count}…`;
}

/** One line of the "Uploading N/total …" phase. `ratePerMinute`/`etaMs` are omitted (not computed) until the rate tracker has seen enough batches — see RateTracker below. */
export function formatUploadLine(opts: {
  harness: string;
  done: number;
  total: number;
  ratePerMinute?: number;
  etaMs?: number;
  errors: number;
}): string {
  const parts = [`Uploading ${opts.done}/${opts.total}`];
  if (opts.ratePerMinute !== undefined) parts.push(`${Math.max(1, Math.round(opts.ratePerMinute))}/min`);
  if (opts.etaMs !== undefined) parts.push(`~${formatMinutesLeft(opts.etaMs)} left`);
  parts.push(`${opts.errors} error${opts.errors === 1 ? "" : "s"}`);
  return `${opts.harness}: ${parts.join(" · ")}`;
}

/** The line shown when a batch is paced/backed off after a 429, so a pause never reads as a hang. */
export function formatRateLimitLine(harness: string, waitMs: number): string {
  return `${harness}: rate limited — waiting ${formatSeconds(waitMs)}`;
}

function formatSeconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function formatMinutesLeft(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 1) return "1 min";
  return `${Math.round(minutes)} min`;
}

/** "41m 12s" / "38s" / "1h 04m" — used for the final elapsed-time line. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

interface RateSample {
  atMs: number;
  count: number;
}

/**
 * Moving-window upload rate (sessions/min) from recent batch completions.
 * `windowMs` bounds which samples count toward the rate (default 90s, a few
 * batches at the paced ~27/min the real report hit); `record` is called once
 * per completed batch regardless of window, so `batchesRecorded` (the ETA
 * gate — "ETA only after >=2 batches") is exact even once old samples age
 * out of the window.
 */
export class RateTracker {
  private samples: RateSample[] = [];
  private readonly windowMs: number;
  private recorded = 0;

  constructor(windowMs = 90_000) {
    this.windowMs = windowMs;
  }

  record(atMs: number, count: number): void {
    this.recorded++;
    this.samples.push({ atMs, count });
    // Keeps at least 2 samples even once they've aged out of the window —
    // otherwise a single very-old sample would make the rate (which needs a
    // span between two points) disappear right when `batchesRecorded` says
    // there's enough data for one.
    const cutoff = atMs - this.windowMs;
    while (this.samples.length > 2 && this.samples[0].atMs < cutoff) this.samples.shift();
  }

  /** Batches recorded so far (never shrinks as the window trims old samples). */
  get batchesRecorded(): number {
    return this.recorded;
  }

  /** Sessions/minute over the current window, or undefined with fewer than 2 samples in it. */
  ratePerMinute(atMs: number): number | undefined {
    if (this.samples.length < 2) return undefined;
    const total = this.samples.reduce((sum, s) => sum + s.count, 0);
    const spanMs = Math.max(1000, atMs - this.samples[0].atMs);
    return (total / spanMs) * 60_000;
  }

  /** ms remaining for `remaining` sessions at the current rate, or undefined until >=2 batches have been recorded overall or the rate is non-positive. */
  etaMs(atMs: number, remaining: number): number | undefined {
    if (this.recorded < 2 || remaining <= 0) return undefined;
    const rate = this.ratePerMinute(atMs);
    if (rate === undefined || rate <= 0) return undefined;
    return (remaining / rate) * 60_000;
  }
}

interface ThrottleState {
  lastEmitMs: number;
  lastEmitPct: number;
}

/**
 * Non-TTY gate: "at most every 10% or every 30s", always true for the first
 * call (nothing shown yet) and for completion (pct >= 100), so a piped run
 * or a log file always gets a start line and a final line. Pure and
 * side-effect-free — callers own `state` and pass their own clock/pct.
 */
export function shouldEmitNonTTY(
  state: ThrottleState,
  nowMs: number,
  pct: number | undefined,
  minIntervalMs = 30_000,
  minPctStep = 10,
): boolean {
  if (state.lastEmitMs === 0 && state.lastEmitPct < 0) return true; // never emitted yet
  if (pct !== undefined && pct >= 100) return true;
  if (pct !== undefined && state.lastEmitPct >= 0 && pct - state.lastEmitPct >= minPctStep) return true;
  if (nowMs - state.lastEmitMs >= minIntervalMs) return true;
  return false;
}

export interface ProgressEmitterOptions {
  /** `process.stdout.isTTY` at call time — a plain boolean so tests don't need a fake stream. */
  isTTY: boolean;
  /** Raw stdout write, used only on a TTY (carriage-return line rewrite). */
  write: (chunk: string) => void;
  /** Plain-line sink for a non-TTY run (piped, log files, hooks, the sweep) — the caller's already-resolved `log`. */
  log: (message: string) => void;
  now?: () => number;
  minIntervalMs?: number;
  minPctStep?: number;
}

/**
 * Renders the "Parsing…"/"Uploading…" line. TTY: rewrites one line in place
 * with `\r` + clear-to-end-of-line, never printing a newline until
 * `finish()`. Non-TTY: throttled plain `log()` lines via `shouldEmitNonTTY`,
 * so a piped run or a log file gets occasional progress instead of either a
 * flood or 40 minutes of silence.
 */
export class ProgressEmitter {
  private readonly isTTY: boolean;
  private readonly write: (chunk: string) => void;
  private readonly log: (message: string) => void;
  private readonly now: () => number;
  private readonly minIntervalMs: number;
  private readonly minPctStep: number;
  private readonly throttle: ThrottleState = { lastEmitMs: 0, lastEmitPct: -1 };
  private wroteInline = false;

  constructor(opts: ProgressEmitterOptions) {
    this.isTTY = opts.isTTY;
    this.write = opts.write;
    this.log = opts.log;
    this.now = opts.now ?? (() => Date.now());
    this.minIntervalMs = opts.minIntervalMs ?? 30_000;
    this.minPctStep = opts.minPctStep ?? 10;
  }

  /** Routine progress — throttled on a non-TTY, rewritten in place on a TTY. `pct` (0-100) drives the non-TTY step gate; omit it (opencode's parse phase, total unknown) to fall back to time-only throttling. */
  update(line: string, pct?: number): void {
    if (this.isTTY) {
      this.write(`\r${line}\x1b[K`);
      this.wroteInline = true;
      return;
    }
    const nowMs = this.now();
    if (!shouldEmitNonTTY(this.throttle, nowMs, pct, this.minIntervalMs, this.minPctStep)) return;
    this.throttle.lastEmitMs = nowMs;
    if (pct !== undefined) this.throttle.lastEmitPct = pct;
    this.log(line);
  }

  /** An event worth interrupting the throttle for (a 429 pause) — always shown, never dropped. On a TTY it breaks out of the in-place line so the pause is visible in scrollback; the next `update()` starts a fresh in-place line. */
  interrupt(line: string): void {
    if (this.isTTY) {
      this.write(`\r${line}\x1b[K\n`);
      this.wroteInline = false;
      return;
    }
    this.log(line);
  }

  /** Ends the phase — on a TTY, moves off the in-place line so the next plain `log()` call doesn't collide with it. No-op on a non-TTY (nothing was left in-place). */
  finish(): void {
    if (this.isTTY && this.wroteInline) {
      this.write("\n");
      this.wroteInline = false;
    }
  }
}
