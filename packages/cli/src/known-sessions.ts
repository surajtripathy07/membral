// Client for POST /api/code-sessions/known — asks the server which of the
// sessions this run parsed it already stores unchanged, so the import only
// uploads what is new or grew. The server's database is the single source of
// truth for "already uploaded" (no local ledger: a local file resets on a new
// machine or a deleted ~/.membral, and two records can disagree).
//
// Probes are built with @membral/core's knownSessionProbe — the same
// derivation the ingest uses for code_sessions.turn_count / ended_at — so a
// probe for the payload about to be uploaded matches the row that payload
// would produce.
//
// Never blocks an import: any failure (404 from a server that predates the
// endpoint, network error, 5xx, rate limit that outlasts the retries, a
// malformed body) is thrown as KnownSessionsUnavailableError, and the caller
// warns once and uploads everything. 401/403 throw UploadAuthError; the
// env-key -> credentials.json fallback already ran inside the policy client
// (endpoint "known": 30 s, no network/5xx retry, 3 tries on 429 with the
// rule-4 wait).
import { KNOWN_SESSIONS_MAX_BATCH, knownSessionProbe, type RawCodeSession } from "@membral/core";
import { createUploadClient, UploadAuthError, type UploadConfig } from "./code-session-upload.js";
import type { ApiClient } from "./lib/api-client.js";

export class KnownSessionsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KnownSessionsUnavailableError";
  }
}

export interface KnownSessionsDeps {
  /** Used only for a client this function builds itself (tests); a passed client keeps its own sleep. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Returns the subset of `sessions` the server already has with the same
 * turn count and end time, queried in chunks of KNOWN_SESSIONS_MAX_BATCH.
 */
export async function fetchKnownSessions(
  config: UploadConfig,
  sessions: RawCodeSession[],
  deps: KnownSessionsDeps = {},
  client?: ApiClient,
): Promise<Set<RawCodeSession>> {
  const api = client ?? createUploadClient(config, deps.sleep ? { sleep: deps.sleep } : {});
  const known = new Set<RawCodeSession>();
  for (let start = 0; start < sessions.length; start += KNOWN_SESSIONS_MAX_BATCH) {
    const chunk = sessions.slice(start, start + KNOWN_SESSIONS_MAX_BATCH);
    const indexes = await postChunk(api, chunk);
    for (const index of indexes) {
      const session = chunk[index];
      if (session) known.add(session);
    }
  }
  return known;
}

async function postChunk(api: ApiClient, chunk: RawCodeSession[]): Promise<number[]> {
  const result = await api.call<{ known?: unknown } | null>("known", {
    json: { sessions: chunk.map(knownSessionProbe) },
  });
  if (!result.ok) {
    switch (result.kind) {
      case "auth":
        throw new UploadAuthError(result.status, `known-sessions check rejected the API key (${result.status})`);
      case "rate_limited":
        throw new KnownSessionsUnavailableError("server answered 429");
      case "bad_json":
        throw new KnownSessionsUnavailableError("response was not JSON");
      case "http":
        throw new KnownSessionsUnavailableError(`server answered ${result.status}`);
      case "network":
      case "timeout":
        throw new KnownSessionsUnavailableError(`network error: ${result.message}`);
      default:
        throw new KnownSessionsUnavailableError("deferred past its deadline");
    }
  }
  const list = result.data?.known;
  if (!Array.isArray(list) || !list.every((i) => Number.isInteger(i) && i >= 0 && i < chunk.length)) {
    throw new KnownSessionsUnavailableError("response had no valid `known` list");
  }
  return list as number[];
}
