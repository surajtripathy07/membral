// "Does the server already have this session, unchanged?" — the shared rule
// behind POST /api/code-sessions/known (apps/cloud) and the CLI's
// skip-unchanged step (packages/cli/src/known-sessions.ts).
//
// The database is the single source of truth for "already uploaded": the
// CLI sends one probe per parsed session, and the server answers from the
// code_sessions row it stored for the same (source, source_session_id).
// Both sides derive the probe fields from a RawCodeSession through THIS
// module, and the ingest (apps/cloud/src/lib/code-sessions/import.ts) writes
// code_sessions.turn_count with `sessionTurnCount` and code_sessions.ended_at
// from `session.endedAt` — so a probe built from the payload the CLI is
// about to upload matches the row that payload would produce.
import type { RawCodeSession } from "./types.js";

/** Max probes per POST /api/code-sessions/known request. */
export const KNOWN_SESSIONS_MAX_BATCH = 500;

export interface KnownSessionProbe {
  source: string;
  source_session_id: string;
  turn_count: number;
  ended_at: string | null;
  /**
   * The uploader's parser version (RawCodeSession.actionsVersion, i.e.
   * FORGE_ACTIONS_VERSION). Absent from older CLIs' probes, which then get
   * the pre-#171 answer exactly.
   */
  actions_version?: number;
}

/**
 * code_sessions.turn_count as the ingest stores it for this payload. Only the
 * turn count is read, so the parameter is deliberately structural: the cloud
 * passes its Zod-validated payload (whose `action.verb` is a plain string so a
 * newer CLI's verb never fails an import — B12), not core's `RawCodeSession`.
 */
export function sessionTurnCount(session: { turns: readonly unknown[] }): number {
  return session.turns.length;
}

/** The probe the CLI sends for a session it is about to upload. */
export function knownSessionProbe(
  session: Pick<RawCodeSession, "source" | "sourceSessionId" | "turns" | "endedAt" | "actionsVersion">,
): KnownSessionProbe {
  return {
    source: session.source,
    source_session_id: session.sourceSessionId,
    turn_count: sessionTurnCount(session),
    ended_at: session.endedAt || null,
    ...(session.actionsVersion === undefined ? {} : { actions_version: session.actionsVersion }),
  };
}

/**
 * A timestamp as whole epoch seconds, or null when absent/unparseable.
 * Postgres timestamptz round-trips as e.g. "2026-02-01T00:00:00.123+00:00"
 * while the payload carries "2026-02-01T00:00:00.123Z" — comparing at
 * second precision makes the two spellings equal.
 */
export function endedAtSecond(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/** The match rule: same turn count, and same ended_at to the second (null equals null). */
export function isSameStoredSession(
  probe: Pick<KnownSessionProbe, "turn_count" | "ended_at">,
  row: { turn_count: number | null; ended_at: string | null },
): boolean {
  return row.turn_count === probe.turn_count && endedAtSecond(row.ended_at) === endedAtSecond(probe.ended_at);
}

/**
 * Issue #171: true when the stored row was parsed by an older parser than the
 * uploader's, so it must be re-imported for the upgrade to reach it. A stored
 * version that is null, missing or not a number counts as older. With no
 * incoming version (an older CLI) this is always false — today's behaviour.
 * No age window (maintainer ruling 2026-09-28): every stale session refreshes.
 */
export function needsParserRefresh(storedVersion: unknown, incomingVersion: number | null | undefined): boolean {
  if (typeof incomingVersion !== "number") return false;
  return typeof storedVersion !== "number" || storedVersion < incomingVersion;
}

/**
 * The /known answer for one probe against its stored row: the same session
 * (isSameStoredSession) AND not parsed by an older parser than the probe's.
 */
export function isKnownStoredSession(
  probe: Pick<KnownSessionProbe, "turn_count" | "ended_at" | "actions_version">,
  row: { turn_count: number | null; ended_at: string | null; actions_version?: unknown },
): boolean {
  return isSameStoredSession(probe, row) && !needsParserRefresh(row.actions_version, probe.actions_version);
}
