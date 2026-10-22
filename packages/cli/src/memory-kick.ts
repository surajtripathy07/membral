// POST /api/memory/extraction/kick — called once at the end of `membral
// sweep` and `membral sessions` (non-dry-run). A self-hosted/local server has
// no Vercel cron to restart a dead memory-extraction chain (see the cloud's
// lib/memory/extraction-trigger.ts header), so the CLI nudges it itself
// using the same profile (URL + key resolution) the uploads use.
//
// Never affects the run's own success/failure: a failed kick is logged (one
// line) and ignored — the next sweep/sessions run, or the hosted daily cron,
// tries again.
//
// Rate limits (CLAUDE.md rule 4): a 429 is never retried at once. The delay
// is persisted in ~/.membral/kick-backoff-<api-url hash>.json (one file per
// server, so `membral use local|prod` never share a backoff) and every later run skips the
// kick until max(Retry-After, delay) has passed; the delay grows x3 while
// under a minute and x1.5 after (capped at an hour), and each success decays
// it by 0.9 — never back to the initial value.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  createUploadClient,
  describeKeyRejected,
  resolveUploadConfig,
  type UploadFlags,
} from "./code-session-upload.js";
import type { ApiClient } from "./lib/api-client.js";
import { KICK_BACKOFF } from "./lib/backoff.js";

export const MEMORY_EXTRACTION_KICK_PATH = "/api/memory/extraction/kick";
// Backoff numbers now live in ./lib/backoff.js's KICK_BACKOFF (G3 step 3C-1).
export const KICK_INITIAL_DELAY_MS = KICK_BACKOFF.initialDelayMs;
export const KICK_MAX_DELAY_MS = KICK_BACKOFF.maxDelayMs;

export interface KickBackoffState {
  /** Current backoff delay; decays on success, never resets. */
  delayMs: number;
  /** Epoch ms before which no kick is sent. */
  notBefore: number;
}

export interface KickBackoffOptions {
  /** Where the backoff state lives; overrides `stateDir` (default ~/.membral/kick-backoff-<api-url hash>.json). */
  statePath?: string;
  /** The directory of the per-API-URL state files (default ~/.membral). */
  stateDir?: string;
  now?: () => number;
}

/** The state file for one API base URL: local and prod profiles back off separately. */
export function kickBackoffPath(apiUrl: string, dir: string = join(homedir(), ".membral")): string {
  const key = createHash("sha256").update(apiUrl.replace(/\/+$/, "")).digest("hex").slice(0, 12);
  return join(dir, `kick-backoff-${key}.json`);
}

/** The delay kept within [initial, max]; a corrupt, zero or non-finite value is the initial delay. */
const clampDelay = KICK_BACKOFF.clampDelay;

function readBackoff(path: string, now: number): KickBackoffState | null {
  try {
    const s = JSON.parse(readFileSync(path, "utf8")) as Partial<KickBackoffState>;
    if (typeof s.delayMs !== "number" || typeof s.notBefore !== "number") return null;
    // A hand-edited or corrupt file never waits past the max, nor retries sooner than the initial delay.
    const notBefore = Number.isFinite(s.notBefore) ? Math.min(s.notBefore, now + KICK_MAX_DELAY_MS) : 0;
    const state = { delayMs: clampDelay(s.delayMs), notBefore };
    // Persist the clamp, or a far-future notBefore would be re-clamped to "an hour from now" forever.
    if (notBefore !== s.notBefore || state.delayMs !== s.delayMs) writeBackoff(path, state);
    return state;
  } catch {
    return null;
  }
}

function writeBackoff(path: string, state: KickBackoffState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(state)}\n`);
  } catch {
    // Best effort: an unwritable home only loses the backoff memory.
  }
}

/** The next delay after a 429: x3 while under a minute, x1.5 after, capped. */
export const nextKickDelay = KICK_BACKOFF.nextDelay;

export interface KickMemoryExtractionResult {
  /** False only on a request/transport failure, or a non-2xx response — never thrown. */
  ok: boolean;
  kicked?: boolean;
  pending?: number;
}

/**
 * POSTs the kick endpoint once, through the policy client (endpoint "kick":
 * 10 s, no retry, env-key fallback on a 401). Never throws — logs one line
 * and returns { ok: false } on any failure. A 429 is not waited on in
 * process: the file backoff waits min(1 h, max(raw Retry-After, delay)).
 */
export async function kickMemoryExtraction(
  opts: UploadFlags,
  logLine: (message: string) => void = console.log,
  fetchImpl?: typeof fetch,
  backoff: KickBackoffOptions = {},
  client?: ApiClient,
): Promise<KickMemoryExtractionResult> {
  const config = resolveUploadConfig(opts);
  if (!config.apiKey) return { ok: true }; // nothing to kick without a key — not this call's failure to report
  const statePath = backoff.statePath ?? kickBackoffPath(config.apiUrl, backoff.stateDir);
  const now = (backoff.now ?? Date.now)();
  const state = readBackoff(statePath, now);
  if (state && now < state.notBefore) {
    logLine(`memory extraction kick: rate-limited, next try in ${Math.ceil((state.notBefore - now) / 1000)}s`);
    return { ok: true };
  }

  const api =
    client ??
    createUploadClient(config, {
      log: logLine,
      ...(fetchImpl ? { fetchImpl } : {}),
      // The same clock reads an HTTP-date Retry-After and stamps the file backoff.
      ...(backoff.now ? { now: backoff.now } : {}),
    });
  const result = await api.call<{ kicked?: boolean; pending?: number }>("kick");
  if (result.ok) {
    // Success decays the delay (never resets it); no state file means no backoff to decay.
    if (state) writeBackoff(statePath, { delayMs: clampDelay(Math.round(state.delayMs * 0.9)), notBefore: 0 });
    return { ok: true, kicked: result.data?.kicked, pending: result.data?.pending };
  }
  switch (result.kind) {
    case "rate_limited": {
      const delayMs = state ? nextKickDelay(state.delayMs) : KICK_INITIAL_DELAY_MS;
      const waitMs = Math.min(KICK_MAX_DELAY_MS, Math.max(result.retryAfterMs ?? 0, delayMs));
      writeBackoff(statePath, { delayMs, notBefore: now + waitMs });
      logLine(`memory extraction kick: server returned 429 — next try in ${Math.ceil(waitMs / 1000)}s`);
      return { ok: false };
    }
    case "auth":
      logLine(
        result.status === 401
          ? `memory extraction kick (POST ${MEMORY_EXTRACTION_KICK_PATH}): server returned 401 — ${describeKeyRejected(config, api)}`
          : `memory extraction kick (POST ${MEMORY_EXTRACTION_KICK_PATH}): server returned ${result.status}`,
      );
      return { ok: false };
    case "http":
      logLine(`memory extraction kick (POST ${MEMORY_EXTRACTION_KICK_PATH}): server returned ${result.status}`);
      return { ok: false };
    case "network":
    case "timeout":
      logLine(`memory extraction kick failed: ${result.message}`);
      return { ok: false };
    case "deferred":
      logLine("memory extraction kick failed: deferred past its deadline");
      return { ok: false };
    default:
      // bad_json cannot happen: the kick response is lenient.
      logLine(`memory extraction kick: server returned ${result.status}`);
      return { ok: false };
  }
}
