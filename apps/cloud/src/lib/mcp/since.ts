// Recency bound shared by search_conversations and list_recent_conversations.
//
// `since` accepts a plain ISO date ("2026-09-24", read as 00:00 UTC that day)
// or a full ISO datetime ("2026-09-24T09:30:00Z"; no offset = UTC). `days`
// (1..365) means "now minus that many days". When both are given, `since`
// wins. Anything else throws InvalidSinceError, which the MCP tool layer
// turns into an isError result with the message below.

export class InvalidSinceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSinceError";
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME_RE = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})?$/i;
const DAY_MS = 86_400_000;

export const MAX_SINCE_DAYS = 365;

/** A calendar date that round-trips (rejects 2026-02-30 etc.). */
function isRealDate(ymd: string): boolean {
  const d = new Date(`${ymd}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === ymd;
}

/**
 * Resolve `since`/`days` to an ISO timestamp (UTC), or null when neither is
 * given. Throws InvalidSinceError with a message the model can act on.
 */
export function resolveSince(
  input: { since?: string | null; days?: number | null },
  now: Date = new Date(),
): string | null {
  const since = typeof input.since === "string" ? input.since.trim() : "";
  if (since !== "") {
    if (DATE_RE.test(since)) {
      if (!isRealDate(since)) throw new InvalidSinceError(`Invalid since: "${since}" is not a real calendar date.`);
      return `${since}T00:00:00.000Z`;
    }
    const m = DATETIME_RE.exec(since);
    if (m && isRealDate(m[1])) {
      const withZone = m[4] ? since : `${since}Z`;
      const t = Date.parse(withZone);
      if (!Number.isNaN(t)) return new Date(t).toISOString();
    }
    throw new InvalidSinceError(
      `Invalid since: "${since}". Use an ISO date like 2026-09-24 (00:00 UTC that day) or an ISO datetime like 2026-09-24T09:30:00Z.`,
    );
  }
  if (input.days !== undefined && input.days !== null) {
    const days = input.days;
    if (!Number.isInteger(days) || days < 1 || days > MAX_SINCE_DAYS) {
      throw new InvalidSinceError(`Invalid days: ${days}. Use a whole number from 1 to ${MAX_SINCE_DAYS}.`);
    }
    return new Date(now.getTime() - days * DAY_MS).toISOString();
  }
  return null;
}
