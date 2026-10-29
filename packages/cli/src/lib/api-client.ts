// The CLI's one HTTP client for the Membral API (R4, design note
// docs/design/cli-api-client-contract.md §3-§5): `createApiClient({ credentials })`
// returns a client whose `call(endpoint, input)` looks up the fixed ENDPOINTS
// table and runs auth, timeout, retry, rule-4 backoff and JSON parsing the
// same way for every endpoint. It never throws — it returns a typed ApiResult.
// Every CLI request to the Membral API goes through `call`; its fetch is the
// only one in the CLI (the `local` command's health checks run inside Docker).

import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type CredentialSource,
  defaultCredentialsPath,
  type ResolvedCredentials,
  resolveKeyFallback,
} from "../credentials.js";
import {
  type BucketState,
  createBucketState,
  decayBucketState,
  growBucketState,
  parseRetryAfterMs,
  RULE4_BACKOFF,
} from "./backoff.js";

// ---------------------------------------------------------------------------
// Policy client
// ---------------------------------------------------------------------------

export type EndpointId =
  | "upload"
  | "known"
  | "import"
  | "importClaudeMem"
  | "preamble"
  | "promptRecall"
  | "kick"
  | "refs"
  | "branchState"
  | "servedUsed"
  | "dogfood"
  | "questionnaire"
  | "deviceStart"
  | "devicePoll"
  | "validateKey";

export interface EndpointPolicy {
  method: "GET" | "POST";
  path: string;
  auth: "key" | "none";
  /** Preamble only: that route answers JSON only when `accept` names it (design note B1). */
  accept?: string;
  /** "answer": a 401 is the result itself (validateKey). */
  on401: "fallback" | "answer";
  /** Per attempt; clipped to abortAt. */
  timeoutMs: number;
  /** Decides retry after a timeout or a mid-request error (§4 table B). */
  idempotent: boolean | "unless-force";
  /** Total tries per class; the total cap is max(budgets) + 2. */
  attempts: { network: number; server5xx: number; rateLimited: number };
  /** Server limiter name; keys the backoff state. null: a fresh state per call. */
  bucket: string | null;
  /** Inter-request pacing after a 429 (batch endpoints). */
  pace: boolean;
  /** lenient: bad JSON on a 2xx -> data undefined, ok. */
  response: "json" | "json-lenient" | "none";
}

/** Preamble's own default budget (preamble-hook.ts PREAMBLE_HOOK_TIMEOUT_MS); the caller's startBy/abortAt clip it. */
const PREAMBLE_DEFAULT_TIMEOUT_MS = 20_000;

/** §4 of the design note, as data. Timeouts sit above the routes' maxDuration (120 s / 300 s). */
export const ENDPOINTS: Record<EndpointId, EndpointPolicy> = {
  upload: {
    method: "POST",
    path: "/api/code-sessions",
    auth: "key",
    on401: "fallback",
    timeoutMs: 135_000,
    idempotent: "unless-force",
    attempts: { network: 3, server5xx: 3, rateLimited: 6 },
    bucket: "codeSessions",
    pace: true,
    response: "json",
  },
  known: {
    method: "POST",
    path: "/api/code-sessions/known",
    auth: "key",
    on401: "fallback",
    timeoutMs: 30_000,
    idempotent: true,
    attempts: { network: 1, server5xx: 1, rateLimited: 3 },
    bucket: "codeSessionsKnown",
    pace: false,
    response: "json",
  },
  import: {
    method: "POST",
    path: "/api/import",
    auth: "key",
    on401: "fallback",
    timeoutMs: 310_000,
    idempotent: false,
    attempts: { network: 3, server5xx: 3, rateLimited: 6 },
    bucket: "importBulk",
    pace: true,
    response: "json",
  },
  // claude-mem observations -> records (apps/cloud/src/lib/memory/import-claude-mem.ts). Idempotent
  // server-side (unique content hash per session), so a timed-out batch may be re-sent.
  importClaudeMem: {
    method: "POST",
    path: "/api/memory/import-claude-mem",
    auth: "key",
    on401: "fallback",
    timeoutMs: 60_000,
    idempotent: true,
    attempts: { network: 3, server5xx: 3, rateLimited: 6 },
    bucket: "importBulk",
    pace: true,
    response: "json",
  },
  preamble: {
    method: "GET",
    path: "/api/memory/preamble",
    auth: "key",
    accept: "application/json",
    on401: "fallback",
    timeoutMs: PREAMBLE_DEFAULT_TIMEOUT_MS,
    idempotent: true,
    attempts: { network: 1, server5xx: 1, rateLimited: 1 },
    bucket: "mcp",
    pace: false,
    response: "json",
  },
  // Prompt-time recall (docs/design/prompt-time-recall.md): the
  // UserPromptSubmit hook's one call. The caller's 4 s hook budget clips this; no
  // retry, since a retried answer arrives after the prompt has gone.
  promptRecall: {
    method: "POST",
    path: "/api/memory/prompt-recall",
    auth: "key",
    on401: "fallback",
    timeoutMs: 3_000,
    idempotent: true,
    attempts: { network: 1, server5xx: 1, rateLimited: 1 },
    bucket: "mcp",
    pace: false,
    response: "json",
  },
  kick: {
    method: "POST",
    path: "/api/memory/extraction/kick",
    auth: "key",
    on401: "fallback",
    timeoutMs: 10_000,
    idempotent: true,
    attempts: { network: 1, server5xx: 1, rateLimited: 1 },
    bucket: "memoryExtractionKick",
    pace: false,
    response: "json-lenient",
  },
  refs: {
    method: "GET",
    path: "/api/memory/branch-state",
    auth: "key",
    on401: "fallback",
    timeoutMs: 20_000,
    idempotent: true,
    attempts: { network: 1, server5xx: 1, rateLimited: 1 },
    bucket: "branchState",
    pace: false,
    response: "json",
  },
  branchState: {
    method: "POST",
    path: "/api/memory/branch-state",
    auth: "key",
    on401: "fallback",
    timeoutMs: 20_000,
    idempotent: true,
    attempts: { network: 1, server5xx: 1, rateLimited: 1 },
    bucket: "branchState",
    pace: false,
    response: "json-lenient",
  },
  // `membral status` served/used line (recall-precision L7). One read, no retry:
  // status must stay quick, and an old server's 404 is simply "no line".
  servedUsed: {
    method: "GET",
    path: "/api/memory/served-used",
    auth: "key",
    on401: "fallback",
    timeoutMs: 4_000,
    idempotent: true,
    attempts: { network: 1, server5xx: 1, rateLimited: 1 },
    bucket: "mcp",
    pace: false,
    response: "json",
  },
  // "Membral on Membral" signals (recall-precision W3b): the status line, the
  // weekly digest and the contradicted-record candidates. Same policy as
  // servedUsed: one read, no retry; an old server's 404 means "nothing".
  dogfood: {
    method: "GET",
    path: "/api/memory/dogfood",
    auth: "key",
    on401: "fallback",
    timeoutMs: 4_000,
    idempotent: true,
    attempts: { network: 1, server5xx: 1, rateLimited: 1 },
    bucket: "mcp",
    pace: false,
    response: "json",
  },
  // Session-end questionnaire self-report (recall-precision W3b), sent by the
  // detached questionnaire child. One attempt, no retry: it is a best-effort
  // signal, and an old server's 404 means "not stored", said nowhere.
  questionnaire: {
    method: "POST",
    path: "/api/memory/questionnaire",
    auth: "key",
    on401: "fallback",
    timeoutMs: 10_000,
    idempotent: true,
    attempts: { network: 1, server5xx: 1, rateLimited: 1 },
    bucket: "mcp",
    pace: false,
    response: "json",
  },
  deviceStart: {
    method: "POST",
    path: "/api/auth/device/start",
    auth: "none",
    on401: "answer",
    timeoutMs: 15_000,
    idempotent: false,
    attempts: { network: 1, server5xx: 1, rateLimited: 1 },
    bucket: "deviceAuthStart",
    pace: false,
    response: "json",
  },
  devicePoll: {
    method: "POST",
    path: "/api/auth/device/poll",
    auth: "none",
    on401: "answer",
    timeoutMs: 15_000,
    idempotent: false,
    attempts: { network: 1, server5xx: 1, rateLimited: 1 },
    bucket: "deviceAuthPoll",
    pace: false,
    response: "json",
  },
  validateKey: {
    method: "GET",
    path: "/api/code-sessions/stats?days=1",
    auth: "key",
    on401: "answer",
    timeoutMs: 10_000,
    idempotent: true,
    attempts: { network: 1, server5xx: 1, rateLimited: 1 },
    bucket: null,
    pace: false,
    response: "json",
  },
};

export type ApiResult<T> =
  | { ok: true; status: number; data: T | undefined; keySource: CredentialSource }
  | { ok: false; kind: "auth"; status: 401 | 403; fellBack: boolean; detail: string }
  | { ok: false; kind: "rate_limited"; attempts: number; retryAfterMs?: number }
  // sent: false when no request had started yet (the deadline or pacing wait came first).
  | { ok: false; kind: "deferred"; waitMs: number; sent: boolean }
  | { ok: false; kind: "http"; status: number; detail: string }
  | { ok: false; kind: "network" | "timeout"; message: string; attempts: number }
  | { ok: false; kind: "bad_json"; status: number };

export interface ApiClientOptions {
  /** Key, url and both sources; the fallback's same-server rule is derived from these alone. */
  credentials: ResolvedCredentials;
  credsPath?: string;
  /** Where env-key markers live (default: the credentials file's directory, ~/.membral). */
  markerDir?: string;
  /** Resolved per request. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** One line per fallback, never key material: stderr (interactive) or the hook log. */
  log?: (line: string) => void;
  /** Epoch ms; no new attempt, retry or wait begins after it. */
  startBy?: number;
  /** Epoch ms; an in-flight attempt is cut here (default: startBy). */
  abortAt?: number;
}

export interface ApiCallInput {
  json?: unknown;
  query?: URLSearchParams;
  signal?: AbortSignal;
  startBy?: number;
  abortAt?: number;
  force?: boolean;
  /**
   * Told before each in-process retry wait (429, 5xx, network or timeout), so a
   * site can keep its own progress line. Never told about pace waits or the
   * fallback retry. A throwing observer is ignored.
   */
  onRetry?: (info: ApiRetryInfo) => void;
}

/** One upcoming retry wait. `attempt`/`max` count tries in this class. */
export interface ApiRetryInfo {
  kind: "rate_limited" | "http" | "network" | "timeout";
  attempt: number;
  max: number;
  waitMs: number;
  /** 429 only: the wait came from the server's Retry-After. */
  retryAfter: boolean;
  /** HTTP status (http, rate_limited) or 0. */
  status: number;
  /** Response body excerpt (http) or error message (network, timeout). */
  detail: string;
}

export interface ApiClient {
  call<T>(id: EndpointId, input?: ApiCallInput): Promise<ApiResult<T>>;
  /** "credentials" after a successful fallback. */
  readonly keySource: CredentialSource;
  /** The key this client sends now: the credentials.json key after a fallback. */
  readonly apiKey: string;
}

/** A fresh marker means an env key was rejected by this server within the last 24 h. */
export const ENV_KEY_MARKER_TTL_MS = 24 * 60 * 60_000;
/** A marker dated further ahead than this clock skew is rejected. */
const ENV_KEY_MARKER_FUTURE_SKEW_MS = 5 * 60_000;

const CONNECT_PHASE_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);

const trimUrl = (u: string): string => u.replace(/\/+$/, "");

/** `env-key-rejected-<sha256(envKey + "\n" + url)[0..12]>.json` — a new key hashes to a new name. */
export function envKeyMarkerPath(markerDir: string, envKey: string, url: string): string {
  const hash = createHash("sha256")
    .update(`${envKey}\n${trimUrl(url)}`)
    .digest("hex")
    .slice(0, 12);
  return join(markerDir, `env-key-rejected-${hash}.json`);
}

/** The marker's write time if it is readable, for this URL, and fresh; otherwise undefined (unreadable = absent). */
export function readEnvKeyMarker(
  markerDir: string,
  envKey: string,
  url: string,
  now: number = Date.now(),
): { at: number; url: string } | undefined {
  try {
    const raw = JSON.parse(readFileSync(envKeyMarkerPath(markerDir, envKey, url), "utf8")) as Record<string, unknown>;
    const at = typeof raw.at === "number" ? raw.at : typeof raw.at === "string" ? Date.parse(raw.at) : Number.NaN;
    if (!Number.isFinite(at) || raw.url !== trimUrl(url)) return undefined;
    if (now - at >= ENV_KEY_MARKER_TTL_MS || at - now > ENV_KEY_MARKER_FUTURE_SKEW_MS) return undefined;
    return { at, url: raw.url };
  } catch {
    return undefined;
  }
}

/** Removes every env-key marker in `markerDir` (`membral logout`); returns how many. Never throws. */
export function deleteEnvKeyMarkers(markerDir: string): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(markerDir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^env-key-rejected-[0-9a-f]{12}\.json$/.test(name)) continue;
    try {
      unlinkSync(join(markerDir, name));
      removed++;
    } catch {
      // already gone
    }
  }
  return removed;
}

function writeEnvKeyMarker(path: string, url: string, at: number): void {
  const tmp = `${path}.tmp-${process.pid}-${at}`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(tmp, `${JSON.stringify({ at: new Date(at).toISOString(), url })}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // best-effort on filesystems without modes
    }
    renameSync(tmp, path);
  } catch {
    // A marker is an optimisation; failing to write one never fails a call.
    deleteFileQuietly(tmp);
  }
}

function deleteFileQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // absent already
  }
}

type FallbackOutcome = "swapped" | "unavailable";

type AttemptOutcome =
  | { type: "response"; res: Response; text: string }
  | { type: "error"; cut: "deadline" | "timeout" | "caller" | null; error: unknown };

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isConnectPhaseError(error: unknown): boolean {
  const e = error as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = e?.cause?.code ?? e?.code;
  return typeof code === "string" && CONNECT_PHASE_CODES.has(code);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createApiClient(o: ApiClientOptions): ApiClient {
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? defaultSleep;
  const rawLog = o.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  /** A failing log sink (ENOSPC, EPIPE) never fails a call or poisons the shared fallback. */
  const log = (line: string): void => {
    try {
      rawLog(line);
    } catch {
      // dropped
    }
  };
  const credsPath = o.credsPath ?? defaultCredentialsPath();
  const markerDir = o.markerDir ?? dirname(credsPath);
  const baseUrl = trimUrl(o.credentials.apiUrl);

  const originalSource = o.credentials.apiKeySource;
  const envKey = originalSource === "env" ? o.credentials.apiKey : undefined;
  const markerPath = envKey !== undefined ? envKeyMarkerPath(markerDir, envKey, baseUrl) : undefined;

  let activeKey = o.credentials.apiKey;
  let keySource: CredentialSource = originalSource;
  let fallback: Promise<FallbackOutcome> | null = null;
  let envRejected = false;
  let markerWritten = false;
  let markerMayExist = true;
  let markerStartLine: string | undefined;

  const buckets = new Map<string, BucketState>();
  const bucketFor = (name: string | null): BucketState => {
    if (name === null) return createBucketState();
    let s = buckets.get(name);
    if (!s) {
      s = createBucketState();
      buckets.set(name, s);
    }
    return s;
  };

  /** The creds key, only when it differs and was saved for this same server (credentials.ts resolveKeyFallback). */
  const credsFallbackKey = (): string | undefined => resolveKeyFallback(o.credentials, credsPath)?.apiKey;

  // A fresh marker: this env key was rejected by this server recently and the
  // creds key worked — start with the creds key (same URL rule applies).
  const marker = envKey !== undefined ? readEnvKeyMarker(markerDir, envKey, baseUrl, now()) : undefined;
  if (marker) {
    const k = credsFallbackKey();
    if (k !== undefined) {
      activeKey = k;
      keySource = "credentials";
      envRejected = true;
      markerWritten = true;
      fallback = Promise.resolve("swapped");
      const ageMin = Math.max(0, Math.round((now() - marker.at) / 60_000));
      markerStartLine = `membral: using the key from ${credsPath}; MEMBRAL_API_KEY was rejected by ${baseUrl} ${ageMin} min ago`;
    }
  }

  const startFallback = (): Promise<FallbackOutcome> => {
    if (fallback) return fallback;
    fallback = Promise.resolve().then((): FallbackOutcome => {
      let k: string | undefined;
      try {
        k = credsFallbackKey();
      } catch {
        k = undefined;
      }
      if (k === undefined) return "unavailable";
      activeKey = k;
      keySource = "credentials";
      log(`membral: MEMBRAL_API_KEY was rejected by ${baseUrl} (401); retrying with the key from ${credsPath}`);
      return "swapped";
    });
    return fallback;
  };

  const onSuccess = (usedKey: string): void => {
    if (envKey === undefined || markerPath === undefined) return;
    if (usedKey === envKey) {
      // The env key works (again): any marker for it is wrong now, even one this run wrote.
      if (markerMayExist) {
        markerMayExist = false;
        deleteFileQuietly(markerPath);
      }
    } else if (envRejected && !markerWritten) {
      markerWritten = true;
      markerMayExist = true;
      writeEnvKeyMarker(markerPath, baseUrl, now());
    }
  };

  async function attempt(
    policy: EndpointPolicy,
    url: string,
    key: string,
    input: ApiCallInput,
    abortAt: number | undefined,
  ): Promise<AttemptOutcome> {
    const doFetch = o.fetchImpl ?? globalThis.fetch;
    if (typeof doFetch !== "function") {
      return { type: "error", cut: null, error: new Error("fetch is not available in this runtime") };
    }

    const headers: Record<string, string> = {};
    if (policy.auth === "key") headers.authorization = `Bearer ${key}`;
    if (input.json !== undefined) headers["content-type"] = "application/json";
    if (policy.accept) headers.accept = policy.accept;
    const init: RequestInit = {};
    if (policy.method !== "GET") init.method = policy.method;
    init.headers = headers;
    if (input.json !== undefined) init.body = JSON.stringify(input.json);

    const controller = new AbortController();
    let cut: "deadline" | "timeout" | "caller" | null = null;
    const remaining = abortAt === undefined ? Number.POSITIVE_INFINITY : abortAt - now();
    const deadlineFirst = remaining <= policy.timeoutMs;
    const timer = setTimeout(
      () => {
        cut = deadlineFirst ? "deadline" : "timeout";
        controller.abort();
      },
      Math.max(0, Math.min(remaining, policy.timeoutMs)),
    );
    const onCallerAbort = (): void => {
      cut ??= "caller";
      controller.abort();
    };
    if (input.signal?.aborted) onCallerAbort();
    else input.signal?.addEventListener("abort", onCallerAbort, { once: true });
    init.signal = controller.signal;

    try {
      // The signal stays attached through the body read.
      const res = await doFetch(url, init);
      const text = await res.text();
      return { type: "response", res, text };
    } catch (error) {
      return { type: "error", cut, error };
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onCallerAbort);
    }
  }

  /** The source of the key a request actually carried (not the client's current one). */
  const sourceOf = (usedKey: string): CredentialSource => {
    if (envKey !== undefined) return usedKey === envKey ? "env" : "credentials";
    return originalSource;
  };

  /** The client never throws: any unexpected throw (a JSON.stringify on a cycle, a sink) becomes `network`. */
  async function call<T>(id: EndpointId, input: ApiCallInput = {}): Promise<ApiResult<T>> {
    try {
      return await callInner<T>(id, input);
    } catch (error) {
      return { ok: false, kind: "network", message: errorMessage(error), attempts: 0 };
    }
  }

  async function callInner<T>(id: EndpointId, input: ApiCallInput): Promise<ApiResult<T>> {
    if (markerStartLine !== undefined) {
      log(markerStartLine);
      markerStartLine = undefined;
    }
    const policy = ENDPOINTS[id];
    const startBy = input.startBy ?? o.startBy;
    let abortAt = input.abortAt ?? o.abortAt ?? input.startBy ?? o.startBy;
    if (abortAt !== undefined && startBy !== undefined) abortAt = Math.max(abortAt, startBy);

    const idempotent = policy.idempotent === "unless-force" ? !input.force : policy.idempotent;
    const state = bucketFor(policy.bucket);
    const budgets = policy.attempts;
    const totalCap = Math.max(budgets.network, budgets.server5xx, budgets.rateLimited) + 2;
    const counts = { network: 0, server5xx: 0, rateLimited: 0 };
    let total = 0;
    // Set once any fetch starts; `total` can step back on a key fallback, so it cannot answer this.
    let requestSent = false;
    let fallbackRetried = false;

    let url = `${baseUrl}${policy.path}`;
    const qs = input.query?.toString();
    if (qs) url += `${policy.path.includes("?") ? "&" : "?"}${qs}`;

    /** A wait that would carry us past startBy never begins. */
    const waitOrDefer = async (ms: number): Promise<boolean> => {
      if (startBy !== undefined && now() + ms > startBy) return false;
      if (ms > 0) await sleep(ms);
      return true;
    };

    const tellRetry = (info: ApiRetryInfo): void => {
      try {
        input.onRetry?.(info);
      } catch {
        // an observer never fails a call
      }
    };

    if (policy.pace && state.paceMs > 0 && !(await waitOrDefer(state.paceMs))) {
      return { ok: false, kind: "deferred", waitMs: state.paceMs, sent: requestSent };
    }

    let last: ApiResult<T> | undefined;
    while (total < totalCap) {
      if (startBy !== undefined && now() > startBy)
        return { ok: false, kind: "deferred", waitMs: 0, sent: requestSent };
      if (abortAt !== undefined && now() >= abortAt)
        return { ok: false, kind: "deferred", waitMs: 0, sent: requestSent };

      total++;
      requestSent = true;
      const usedKey = activeKey;
      const epochAtSend = state.epoch;
      const out = await attempt(policy, url, usedKey, input, abortAt);

      if (out.type === "error") {
        if (out.cut === "deadline") return { ok: false, kind: "deferred", waitMs: 0, sent: requestSent };
        counts.network++;
        const isTimeout = out.cut === "timeout";
        const message = isTimeout ? `timed out after ${policy.timeoutMs} ms` : errorMessage(out.error);
        last = { ok: false, kind: isTimeout ? "timeout" : "network", message, attempts: counts.network };
        const retryable =
          out.cut !== "caller" && (isTimeout ? idempotent : isConnectPhaseError(out.error) || idempotent);
        if (!retryable || counts.network >= budgets.network) return last;
        const wait = RULE4_BACKOFF.retryWaitMs(state.delayMs);
        growBucketState(state, epochAtSend, false);
        if (startBy === undefined || now() + wait <= startBy) {
          tellRetry({
            kind: isTimeout ? "timeout" : "network",
            attempt: counts.network,
            max: budgets.network,
            waitMs: wait,
            retryAfter: false,
            status: 0,
            detail: message,
          });
        }
        if (!(await waitOrDefer(wait))) return { ok: false, kind: "deferred", waitMs: wait, sent: requestSent };
        continue;
      }

      const { res, text } = out;
      const status = res.status;
      const detail = text.trim().slice(0, 300);

      if (status >= 200 && status < 300) {
        decayBucketState(state);
        onSuccess(usedKey);
        const keySource = sourceOf(usedKey);
        if (policy.response === "none") return { ok: true, status, data: undefined, keySource };
        try {
          return { ok: true, status, data: JSON.parse(text) as T, keySource };
        } catch {
          if (policy.response === "json-lenient") return { ok: true, status, data: undefined, keySource };
          return { ok: false, kind: "bad_json", status };
        }
      }

      if (status === 401) {
        if (policy.on401 === "answer" || policy.auth === "none") {
          return { ok: false, kind: "auth", status: 401, fellBack: false, detail };
        }
        if (envKey !== undefined && usedKey === envKey && !fallbackRetried) {
          envRejected = true;
          const outcome = await startFallback();
          if (outcome === "swapped") {
            fallbackRetried = true;
            total--; // the fallback retry is not a class retry
            continue;
          }
          return { ok: false, kind: "auth", status: 401, fellBack: false, detail };
        }
        return { ok: false, kind: "auth", status: 401, fellBack: envKey !== undefined && usedKey !== envKey, detail };
      }

      if (status === 403) {
        return { ok: false, kind: "auth", status: 403, fellBack: envKey !== undefined && usedKey !== envKey, detail };
      }

      if (status === 429) {
        counts.rateLimited++;
        const retryAfterMs = parseRetryAfterMs(res.headers?.get?.("retry-after"), now());
        const wait = RULE4_BACKOFF.rateLimitWaitMs(retryAfterMs, state.delayMs);
        growBucketState(state, epochAtSend, policy.pace);
        last =
          retryAfterMs === undefined
            ? { ok: false, kind: "rate_limited", attempts: counts.rateLimited }
            : { ok: false, kind: "rate_limited", attempts: counts.rateLimited, retryAfterMs };
        if (counts.rateLimited >= budgets.rateLimited) return last;
        if (startBy === undefined || now() + wait <= startBy) {
          tellRetry({
            kind: "rate_limited",
            attempt: counts.rateLimited,
            max: budgets.rateLimited,
            waitMs: wait,
            retryAfter: retryAfterMs !== undefined,
            status,
            detail: "",
          });
        }
        if (!(await waitOrDefer(wait))) return { ok: false, kind: "deferred", waitMs: wait, sent: requestSent };
        continue;
      }

      if (status >= 500 || status === 408) {
        counts.server5xx++;
        last = { ok: false, kind: "http", status, detail };
        // A 504 is the server attempt dying at maxDuration: like a client timeout, never re-sent when not idempotent.
        if (counts.server5xx >= budgets.server5xx || (status === 504 && !idempotent)) return last;
        const wait = RULE4_BACKOFF.retryWaitMs(state.delayMs);
        growBucketState(state, epochAtSend, false);
        if (startBy === undefined || now() + wait <= startBy) {
          tellRetry({
            kind: "http",
            attempt: counts.server5xx,
            max: budgets.server5xx,
            waitMs: wait,
            retryAfter: false,
            status,
            detail,
          });
        }
        if (!(await waitOrDefer(wait))) return { ok: false, kind: "deferred", waitMs: wait, sent: requestSent };
        continue;
      }

      // Every other 4xx is terminal.
      return { ok: false, kind: "http", status, detail };
    }
    return last ?? { ok: false, kind: "network", message: "attempt cap reached", attempts: counts.network };
  }

  return {
    call,
    get keySource() {
      return keySource;
    },
    get apiKey() {
      return activeKey;
    },
  };
}
