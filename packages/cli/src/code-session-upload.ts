// Upload client for POST /api/code-sessions (ADR 0021 Q1/Q8).
//
// Batching: the route caps a batch at 20 sessions and ~4MB of body (see
// apps/cloud/src/app/api/code-sessions/route.ts + lib/code-sessions/payload.ts
// MAX_BATCH_SIZE). We mirror both caps client-side and split oversized runs
// into multiple requests.
//
// Rate limiting, retry, timeout and the env-key fallback live in the one
// policy client (lib/api-client.ts, endpoint "upload"; design note
// docs/design/cli-api-client-contract.md §4): 135 s per attempt, 3 network /
// 3 5xx / 6 rate-limited tries, rule-4 backoff with Retry-After and pacing,
// other 4xx terminal. A 429 is never retried immediately and the delay decays
// 0.9x on success. This file maps the client's result onto its errors.
import {
  assignActions,
  clampWireText,
  type ForgeAction,
  MAX_INPUT_DIGEST_CHARS,
  MAX_SUBAGENT_TEXT_CHARS,
  MAX_TURN_TEXT_CHARS,
  type RawCodeSession,
  type RawSubAgent,
  type RawTurn,
  settleActionDir,
} from "@membral/core";
import {
  type CredentialSource,
  DEFAULT_API_URL,
  describeKeySource,
  loadCredentials,
  maskApiKey,
  resolveCredentials,
} from "./credentials.js";
import { type ApiClient, type ApiClientOptions, type ApiRetryInfo, createApiClient } from "./lib/api-client.js";
import { RULE4_BACKOFF } from "./lib/backoff.js";

export { parseRetryAfterMs } from "./lib/backoff.js";

export { DEFAULT_API_URL };
export const MAX_BATCH_SIZE = 20;
// Headroom under the route's 4MB cap (apps/cloud/src/app/api/code-sessions/route.ts
// MAX_BODY_BYTES) to leave room for the `{"sessions":[...]}` wrapper.
export const MAX_BATCH_BYTES = 4 * 1024 * 1024 - 64 * 1024;

export interface UploadConfig {
  apiUrl: string;
  apiKey: string;
  /** M4 (adversarial round 1 on #136) — lets a 401 be attributed to a source, and decides whether the client's env-key fallback may run. Always set by resolveUploadConfig; optional only so a config built by hand (tests) still compiles (it then counts as a flag key: no fallback). */
  apiKeySource?: CredentialSource;
  apiUrlSource?: CredentialSource;
}

export interface UploadFlags {
  apiUrl?: string;
  apiKey?: string;
}

export interface SessionUploadOutcome {
  imported: number;
  skipped: number;
  total: number;
  errors: { sourceSessionId: string; error: string }[];
}

/**
 * The one 401 explanation for every upload-path call (/known, upload, kick):
 * which server rejected which key (masked prefix only) from which source,
 * and the command that fixes it. Pass the client that made the call: after
 * its env-key fallback (lib/api-client.ts) the rejected key is the
 * credentials.json one, not `config.apiKey`, and "unset MEMBRAL_API_KEY"
 * would be the wrong advice. A `localhost` URL also gets the second-listener
 * hint: Node resolves localhost to ::1 before 127.0.0.1, so an older server
 * bound to IPv6 on the same port answers instead of the one that issued the
 * key (the 2026-10-08 import that 401ed every batch).
 */
export function describeKeyRejected(
  config: Pick<UploadConfig, "apiUrl" | "apiKey" | "apiKeySource">,
  used?: Pick<ApiClient, "apiKey" | "keySource">,
): string {
  const source = used?.keySource ?? config.apiKeySource ?? "flag";
  const key = used?.apiKey ?? config.apiKey;
  const fellBack = config.apiKeySource === "env" && source !== "env";
  const head = fellBack
    ? `the server at ${config.apiUrl} rejected MEMBRAL_API_KEY and then API key ${maskApiKey(key)} from ${describeKeySource(source)}.`
    : `the server at ${config.apiUrl} rejected API key ${maskApiKey(key)} from ${describeKeySource(source)}.`;
  const fix =
    source === "env"
      ? "Run `unset MEMBRAL_API_KEY`, then `membral status` to check the key it falls back to."
      : source === "flag"
        ? "Check the --api-key value, or omit it to use the key from `membral login`."
        : "Run `membral status` to see the active profile, then `membral use <profile>` or `membral login` to fix it.";
  return [head, fix, loopbackHint(config.apiUrl)].filter(Boolean).join(" ");
}

/** The 403 text shared by the upload and the already-uploaded probe. */
export const SCOPED_KEY_403 =
  "API key is scoped (403) — code-session imports require an unscoped key. Generate a new unscoped lls_ key (a project- or area-scoped key cannot write).";

function loopbackHint(apiUrl: string): string {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return "";
  }
  if (url.hostname !== "localhost") return "";
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return (
    `If a second server also listens on port ${port} (check \`lsof -nP -iTCP:${port} -sTCP:LISTEN\`), ` +
    `"localhost" may reach it instead (::1 is tried before 127.0.0.1) — stop it, or use http://127.0.0.1:${port}.`
  );
}

/** Thrown for 401/403 — never worth retrying, and the caller should stop. */
export class UploadAuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "UploadAuthError";
    this.status = status;
  }
}

/** The client deferred the upload (a wait or attempt would pass the time budget) — the caller leaves it for the sweep. */
export class UploadDeferredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadDeferredError";
  }
}

/**
 * Kept for uploadBatch's signature until R4 PR 7. The backoff state now lives
 * in the ApiClient (one bucket per server limit, shared by every call in a
 * run); only `deadlineAt` is still read, as `startBy` for a client uploadBatch
 * builds itself when none is passed.
 */
export interface RateLimitState {
  /** Unused since R4 4.3 (the client holds the bucket's delay). */
  delayMs: number;
  /** Unused since R4 4.3 (the client holds the bucket's pace). */
  paceMs?: number;
  /**
   * Epoch ms: no new attempt or wait begins after it; the upload is deferred
   * instead. Overrides the client's `startBy` for this one call.
   */
  deadlineAt?: number;
}

export function createRateLimitState(deadlineAt?: number): RateLimitState {
  return deadlineAt === undefined
    ? { delayMs: RULE4_BACKOFF.initialDelayMs, paceMs: 0 }
    : { delayMs: RULE4_BACKOFF.initialDelayMs, paceMs: 0, deadlineAt };
}

/** A policy client for one resolved config (every keyed CLI site uses it, not only uploads). */
export function createUploadClient(
  config: UploadConfig,
  options: Omit<ApiClientOptions, "credentials"> = {},
): ApiClient {
  return createApiClient({
    credentials: {
      apiKey: config.apiKey,
      apiKeySource: config.apiKeySource ?? "flag",
      apiUrl: config.apiUrl,
      apiUrlSource: config.apiUrlSource ?? "flag",
    },
    ...options,
  });
}

/**
 * Config resolution order: CLI flags > MEMBRAL_API_URL/MEMBRAL_API_KEY env
 * vars > ~/.membral/credentials.json (written by `membral login`) > default
 * API URL (no default API key — an empty string means "not configured",
 * callers should treat that as a hard requirement). Goes through
 * credentials.ts's ONE shared resolveCredentials (issue #136) — same
 * precedence as before, but now also reports apiKeySource/apiUrlSource so a
 * 401 can be attributed to a source and the client's env-key fallback
 * (credentials.ts resolveKeyFallback) can decide whether to run.
 */
export function resolveUploadConfig(flags: UploadFlags): UploadConfig {
  return resolveCredentials({
    flagKey: flags.apiKey,
    flagUrl: flags.apiUrl,
    envKey: process.env.MEMBRAL_API_KEY,
    envUrl: process.env.MEMBRAL_API_URL,
    defaultUrl: DEFAULT_API_URL,
  });
}

/**
 * Split sessions into request-sized batches, respecting both the count cap
 * (`maxCount`) and an approximate serialized-byte cap (`maxBytes`). A single
 * session larger than `maxBytes` still gets its own (oversized) batch —
 * sessions are atomic and can't be split further; the server will reject it
 * if it truly exceeds the body limit.
 */
export function splitIntoBatches(
  sessions: RawCodeSession[],
  maxCount = MAX_BATCH_SIZE,
  maxBytes = MAX_BATCH_BYTES,
): RawCodeSession[][] {
  const batches: RawCodeSession[][] = [];
  let current: RawCodeSession[] = [];
  let currentBytes = 2; // "[" + "]"

  for (const session of sessions) {
    const size = Buffer.byteLength(JSON.stringify(session), "utf8");
    const exceedsCount = current.length >= maxCount;
    const exceedsBytes = current.length > 0 && currentBytes + size + 1 > maxBytes;

    if (exceedsCount || exceedsBytes) {
      batches.push(current);
      current = [];
      currentBytes = 2;
    }

    current.push(session);
    currentBytes += size + 1; // +1 for the separating comma
  }

  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * POST one batch (<= MAX_BATCH_SIZE sessions) to /api/code-sessions through
 * the policy client. Throws `UploadAuthError` on 401/403 (after the client's
 * env-key fallback), `UploadDeferredError` when the client's deadline cut it,
 * and a plain Error for anything else that is not a 2xx.
 *
 * `force` (issue #91 backfill): sends `force: true` so the server skips its
 * content_hash short-circuit; omitted from the body when false. A forced
 * upload is not idempotent, so the client does not re-send it after a timeout.
 *
 * `client`: a command creates one and passes it to every batch, so the
 * backoff state and the key fallback span the run. Absent, one is built from
 * `config`. `state.deadlineAt`, when set, is this call's `startBy`.
 */
export async function uploadBatch(
  config: UploadConfig,
  sessions: RawCodeSession[],
  state: RateLimitState = createRateLimitState(),
  log: (message: string) => void = () => {},
  force = false,
  client?: ApiClient,
): Promise<SessionUploadOutcome> {
  const api = client ?? createUploadClient(config);
  const wire = sessions.map(sessionForWire);
  const requestBody = force ? { sessions: wire, force: true } : { sessions: wire };

  const result = await api.call<Partial<SessionUploadOutcome>>("upload", {
    json: requestBody,
    force,
    ...(state.deadlineAt !== undefined ? { startBy: state.deadlineAt } : {}),
    onRetry: (r) => log(retryLine(r)),
  });

  if (result.ok) {
    const body = result.data ?? {};
    return {
      imported: body.imported ?? 0,
      skipped: body.skipped ?? 0,
      total: body.total ?? sessions.length,
      errors: body.errors ?? [],
    };
  }
  switch (result.kind) {
    case "auth":
      if (result.status === 401) {
        throw new UploadAuthError(401, `Invalid or missing API key (401) — ${describeKeyRejected(config, api)}`);
      }
      throw new UploadAuthError(403, SCOPED_KEY_403);
    case "deferred":
      throw new UploadDeferredError(
        result.waitMs > 0
          ? `a ${result.waitMs}ms wait would pass the time budget; left for the sweep`
          : "the time budget ran out; left for the sweep",
      );
    case "rate_limited":
      throw new Error(`Rate limited (429) after ${result.attempts} attempts`);
    case "http":
      throw new Error(`Upload failed: ${result.status} ${result.detail}`);
    case "bad_json":
      throw new Error(`Upload failed: ${result.status} response was not JSON`);
    default:
      throw new Error(`Network error uploading to ${config.apiUrl}/api/code-sessions: ${result.message}`);
  }
}

/** The pre-client wording, kept: import-sessions.ts parses the 429 line into its progress output. */
function retryLine(r: ApiRetryInfo): string {
  if (r.kind === "rate_limited") {
    const why = r.retryAfter ? " (Retry-After)" : "";
    return `rate limited (429, attempt ${r.attempt}/${r.max}) — waiting ${r.waitMs}ms${why} before retry`;
  }
  if (r.kind === "http") {
    return `upload failed (${r.status}, attempt ${r.attempt}/${r.max}) — waiting ${r.waitMs}ms before retry: ${r.detail}`;
  }
  return `network error (attempt ${r.attempt}/${r.max}) — waiting ${r.waitMs}ms before retry: ${r.detail}`;
}

/**
 * D-051 F1/S4 — the one place actions leave this machine. An action whose repo
 * is not observable (`repoUnknown`) is omitted, never sent: a server that
 * predates the marker strips unknown fields and would read the rest as the
 * session's own project (a bare `#N`, or a ref-less commit landing on a
 * focus). Omitting it is what the current server does with it anyway — it
 * never counts, and its turn's cost falls to Unattributed. The local-only
 * `dir`/`shownRepo` never go up: an action still carrying a `dir` (an import
 * path that did not settle it) keeps its bare ref only when that directory is
 * literally the session's own (never for a sub-agent), else it is unknown.
 */
export function sessionForWire(raw: RawCodeSession): RawCodeSession {
  const session = clampSessionForWire(raw);
  const needs = (a: ForgeAction | undefined) =>
    !!a && (a.repoUnknown === true || a.dir !== undefined || a.shownRepo !== undefined);
  if (!session.turns.some((t) => needs(t.action) || (t.actions ?? []).some(needs))) return session;
  const home = session.parentSessionId === undefined ? normalizeDir(session.repo.path) : undefined;
  const settle = (a: ForgeAction): ForgeAction =>
    a.dir === undefined && a.shownRepo === undefined
      ? a
      : settleActionDir(
          a,
          home !== undefined && normalizeDir(a.dir) === home ? { kind: "project" } : { kind: "unknown" },
        );
  const turns = session.turns.map((t) => {
    const list = t.actions && t.actions.length > 0 ? t.actions : t.action ? [t.action] : [];
    if (!list.some(needs)) return t;
    const kept = list.map(settle).filter((a) => a.repoUnknown !== true);
    const out = { ...t };
    assignActions(out, kept);
    return out;
  });
  return { ...session, turns };
}

function normalizeDir(p: string | undefined): string | undefined {
  if (!p || !p.startsWith("/")) return undefined;
  return p.replace(/\/+$/, "") || "/";
}

/**
 * #480: clamp every string the server's schema caps (turn text and ownerText, inputDigest,
 * sub-agent descriptions) to its limit, with a visible marker, so one oversized field never makes
 * the server answer 400 and drop the whole session. Returns the same object when nothing is over;
 * never mutates the input (the parsed session, and the transcript on disk, stay whole).
 */
function clampSessionForWire(session: RawCodeSession): RawCodeSession {
  const over = (s: string | undefined, max: number) => s !== undefined && s.length > max;
  const turnOver = (t: RawTurn) =>
    over(t.text, MAX_TURN_TEXT_CHARS) ||
    over(t.ownerText, MAX_TURN_TEXT_CHARS) ||
    over(t.inputDigest, MAX_INPUT_DIGEST_CHARS);
  const agentOver = (a: RawSubAgent) => over(a.description, MAX_SUBAGENT_TEXT_CHARS);
  if (
    !session.turns.some(turnOver) &&
    !(session.subAgents ?? []).some(agentOver) &&
    !(session.subAgent && agentOver(session.subAgent))
  ) {
    return session;
  }
  const clamp = (s: string | undefined, max: number) => (s === undefined ? s : clampWireText(s, max));
  const turns = session.turns.map((t): RawTurn => {
    if (!turnOver(t)) return t;
    const out = { ...t };
    if (t.text !== undefined) out.text = clamp(t.text, MAX_TURN_TEXT_CHARS);
    if (t.ownerText !== undefined) out.ownerText = clamp(t.ownerText, MAX_TURN_TEXT_CHARS);
    if (t.inputDigest !== undefined) out.inputDigest = clamp(t.inputDigest, MAX_INPUT_DIGEST_CHARS);
    return out;
  });
  const agent = (a: RawSubAgent): RawSubAgent =>
    agentOver(a) ? { ...a, description: clamp(a.description, MAX_SUBAGENT_TEXT_CHARS) } : a;
  return {
    ...session,
    turns,
    ...(session.subAgents ? { subAgents: session.subAgents.map(agent) } : {}),
    ...(session.subAgent ? { subAgent: agent(session.subAgent) } : {}),
  };
}
