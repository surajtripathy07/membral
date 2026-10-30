// Server-side timestamp hygiene for the code-session import (issue #585).
//
// A transcript line can carry an empty, whitespace-only or otherwise unparseable timestamp ("" is the observed case).
// Postgres rejects the string for a timestamptz column ("invalid input syntax for type timestamp with time zone"),
// which failed the whole session in one transaction and left the sweep retrying it forever. Every timestamp column
// the import writes (code_sessions.started_at / ended_at, code_session_turns.ts, code_projects.last_active_at) is
// nullable, so an unusable value becomes null (or a neighbour's time, see checkSessionTimestamps) and the rest of the
// session imports. Already-installed CLIs send the
// raw value, so the guard lives here and not only in the parser.

import type { RawCodeSessionPayload } from "./payload";

type UploadedTurn = RawCodeSessionPayload["turns"][number];

/** A session whose timestamps are checked: each is a usable ISO string or null. */
export type TimestampCheckedSession = Omit<RawCodeSessionPayload, "startedAt" | "endedAt" | "turns"> & {
  startedAt: string | null;
  endedAt: string | null;
  turns: Array<Omit<UploadedTurn, "ts"> & { ts: string | null }>;
};

// ISO 8601 / RFC 3339 shapes the parsers emit (date, or date + time, optional fraction and zone). A shape outside it
// is treated as missing rather than risking a value Date.parse reads but Postgres rejects.
const ISO_SHAPE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;

/** The trimmed value when it is a parseable ISO timestamp; null for "", whitespace, non-strings and anything else. */
export function usableTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!v || !ISO_SHAPE.test(v) || Number.isNaN(Date.parse(v))) return null;
  return v;
}

/**
 * Replaces every unusable turn timestamp with null (valid ones are kept byte for byte). An unusable session start
 * falls back to the earliest usable turn time, and an unusable end to the latest, so the session still shows in the
 * windowed queries (recent lists, the 30-day extraction window, the sweep); null only when no turn has a usable time.
 */
export function checkSessionTimestamps(session: RawCodeSessionPayload): TimestampCheckedSession {
  const turns = session.turns.map((t) => ({ ...t, ts: usableTimestamp(t.ts) }));
  let earliest: string | null = null;
  let latest: string | null = null;
  for (const t of turns) {
    if (t.ts === null) continue;
    if (earliest === null || Date.parse(t.ts) < Date.parse(earliest)) earliest = t.ts;
    if (latest === null || Date.parse(t.ts) > Date.parse(latest)) latest = t.ts;
  }
  return {
    ...session,
    startedAt: usableTimestamp(session.startedAt) ?? earliest,
    endedAt: usableTimestamp(session.endedAt) ?? latest,
    turns,
  };
}
