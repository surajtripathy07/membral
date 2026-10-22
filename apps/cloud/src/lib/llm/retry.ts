// Issue #170 / R4 4.5: the house backoff policy for LLM HTTP calls, replacing the
// OpenAI SDK's `maxRetries: 8` (the SDK is now built with maxRetries: 0).
//
// Rule 4 (CLAUDE.md): never retry a 429 immediately; back off proportionally
// (bigger multiplier at small delay, smaller as it grows); decay on success by
// 0.9x, never reset to initial.
//
// STATE IS MODULE-SCOPED: `delayMs` is shared by every client in one server
// instance (one warm Vercel function / one Node process), so a rate limit hit by
// one call slows the next calls too. It is not shared across instances.
//
//   floor            INITIAL_DELAY_MS = 1000
//   ceiling          MAX_DELAY_MS     = 60000 (also the longest single wait)
//   growth           next = delay * (1 + 4 * INITIAL / (delay + INITIAL)), capped
//                    1000 -> x3.0, 4000 -> x1.8, 16000 -> x1.24, 60000 -> x1.07
//   success          delay = max(INITIAL, delay * 0.9)
//   wait per retry   Retry-After / retry-after-ms if present, else current delay;
//                    a header asking for more than MAX_DELAY_MS is not waited out:
//                    the error propagates instead (bounded wait).
// Retryable: 429, 5xx, connection errors/timeouts (no HTTP status). Never other 4xx.

import { APIConnectionError } from "openai";

export const INITIAL_DELAY_MS = 1000;
export const MAX_DELAY_MS = 60_000;
export const DECAY_FACTOR = 0.9;
/** Default retries after the first attempt (total calls = retries + 1). */
export const DEFAULT_MAX_RETRIES = 5;

let delayMs = INITIAL_DELAY_MS;

export function currentBackoffDelayMs(): number {
  return delayMs;
}

/** Test hook: restore the module state to its floor. */
export function resetBackoffState(): void {
  delayMs = INITIAL_DELAY_MS;
}

/** Growth multiplier for the current delay: large when small, approaching 1 near the ceiling. */
export function backoffMultiplier(delay: number): number {
  return 1 + (4 * INITIAL_DELAY_MS) / (delay + INITIAL_DELAY_MS);
}

export interface RetryDeps {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const realDeps: RetryDeps = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const h = headers as { get?: (n: string) => string | null | undefined; [k: string]: unknown };
  if (typeof h.get === "function") return h.get(name) ?? undefined;
  const hit = Object.keys(h).find((k) => k.toLowerCase() === name);
  const v = hit ? h[hit] : undefined;
  return typeof v === "string" ? v : undefined;
}

/** Server-requested wait in ms from retry-after-ms / Retry-After (seconds or HTTP date), or null. */
export function retryAfterMs(err: unknown, now: number): number | null {
  const headers = (err as { headers?: unknown } | null)?.headers;
  const ms = Number(headerValue(headers, "retry-after-ms"));
  if (Number.isFinite(ms) && ms >= 0 && headerValue(headers, "retry-after-ms") !== undefined) return ms;
  const raw = headerValue(headers, "retry-after");
  if (raw === undefined) return null;
  const secs = Number(raw);
  if (raw.trim() !== "" && Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

export function isRetryableLlmError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const status = (err as { status?: unknown }).status;
  if (typeof status === "number") return status === 429 || status >= 500;
  // No HTTP status: an OpenAI SDK APIConnectionError / APIConnectionTimeoutError.
  if (err instanceof APIConnectionError) return true; // includes APIConnectionTimeoutError
  const name = (err as { name?: unknown }).name;
  return name === "APIConnectionError" || name === "APIConnectionTimeoutError";
}

/**
 * Runs `fn`, retrying retryable errors up to `maxRetries` times with the module-scoped
 * backoff. Exhaustion rethrows the last original error (same type callers handle today).
 */
export async function withLlmRetry<T>(
  fn: () => Promise<T>,
  opts?: { maxRetries?: number; deps?: Partial<RetryDeps> },
): Promise<T> {
  const maxRetries = Math.max(0, opts?.maxRetries ?? DEFAULT_MAX_RETRIES);
  const deps = { ...realDeps, ...opts?.deps };
  for (let attempt = 0; ; attempt++) {
    try {
      const out = await fn();
      delayMs = Math.max(INITIAL_DELAY_MS, delayMs * DECAY_FACTOR);
      return out;
    } catch (err) {
      if (attempt >= maxRetries || !isRetryableLlmError(err)) throw err;
      const asked = retryAfterMs(err, deps.now());
      if (asked !== null && asked > MAX_DELAY_MS) throw err;
      // Never immediate: wait at least the floor even when the server says 0.
      const wait = Math.max(INITIAL_DELAY_MS, asked ?? delayMs);
      delayMs = Math.min(MAX_DELAY_MS, delayMs * backoffMultiplier(delayMs));
      await deps.sleep(wait);
    }
  }
}
