// Both fixtures this smoke run imports carry FIXED historical timestamps
// (the Claude Code fixture is dated 2026-02-01; the opencode fixture is
// dated 2026-06-13). /code/stats (the page, not the API route) hardcodes a
// 30-day window with no query-param override (`WINDOW_DAYS = 30` in
// apps/cloud/src/app/(dashboard)/code/stats/page.tsx — unlike
// GET /api/code-sessions/stats, which does accept `?days=`), so a fixture
// dated outside the last 30 days imports fine and the API's own stats
// endpoint sees it, but the /code/stats PAGE Playwright checks against
// renders "No agent sessions in the last 30 days" — a real gap this smoke
// test surfaced (reported, not fixed, per W8's scope).
//
// Rather than depend on the fixtures staying "recent enough" forever (they
// won't — this repo will still be here in 2027), both fixtures' timestamps
// are shifted at import time so the earliest event lands a fixed few days
// before "now", whatever "now" is when `npm run smoke` runs. Every
// timestamp is shifted by the SAME offset, so relative ordering/durations
// inside each fixture are preserved exactly — only their position on the
// calendar moves.
const ANCHOR_DAYS_AGO = 3;

function anchorMs() {
  return Date.now() - ANCHOR_DAYS_AGO * 24 * 60 * 60 * 1000;
}

/**
 * Shifts every top-level `"timestamp":"<ISO>"` field in a Claude Code
 * transcript JSONL string so the earliest line's timestamp lands at the
 * anchor time, preserving every line's original offset from it.
 */
export function shiftClaudeCodeJsonl(raw) {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const parsedLines = lines.map((l) => JSON.parse(l));

  const timestamps = parsedLines
    .map((event) => (typeof event.timestamp === "string" ? Date.parse(event.timestamp) : undefined))
    .filter((ms) => typeof ms === "number" && !Number.isNaN(ms));
  if (timestamps.length === 0) return raw; // nothing to shift — return unchanged

  const minMs = Math.min(...timestamps);
  const offset = anchorMs() - minMs;

  for (const event of parsedLines) {
    if (typeof event.timestamp === "string") {
      const ms = Date.parse(event.timestamp);
      if (!Number.isNaN(ms)) event.timestamp = new Date(ms + offset).toISOString();
    }
  }
  return `${parsedLines.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

// Heuristic epoch-ms range covering ~2001-01-01 to ~2128-01-01 — wide enough
// to catch every real timestamp field opencode's schema uses (session
// time_created/time_updated, message/part time.created/completed/start/end)
// without false-positiving on small integers like token counts or ids.
const MIN_EPOCH_MS = 1_000_000_000_000;
const MAX_EPOCH_MS = 5_000_000_000_000;

function isEpochMsLike(n) {
  return typeof n === "number" && Number.isFinite(n) && n >= MIN_EPOCH_MS && n <= MAX_EPOCH_MS;
}

/**
 * Recursively finds every epoch-ms-shaped number in `value`, INCLUDING
 * inside JSON-encoded strings (opencode's message/part `data` columns are
 * themselves JSON text, not nested objects, in the exported fixture shape)
 * — parses each such string, recurses into it, and re-serializes it with
 * the shift applied. Returns a new value; never mutates the input.
 */
function shiftDeep(value, offset) {
  if (isEpochMsLike(value)) return value + offset;
  if (Array.isArray(value)) return value.map((v) => shiftDeep(v, offset));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = shiftDeep(v, offset);
    return out;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(value);
        return JSON.stringify(shiftDeep(parsed, offset));
      } catch {
        return value; // not actually JSON — leave the string alone
      }
    }
  }
  return value;
}

function findMinEpochMs(value, acc = { min: undefined }) {
  if (isEpochMsLike(value)) {
    acc.min = acc.min === undefined ? value : Math.min(acc.min, value);
  } else if (Array.isArray(value)) {
    for (const v of value) findMinEpochMs(v, acc);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) findMinEpochMs(v, acc);
  } else if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        findMinEpochMs(JSON.parse(value), acc);
      } catch {
        // not JSON — nothing to scan inside it
      }
    }
  }
  return acc.min;
}

/**
 * Shifts every epoch-ms timestamp found anywhere in an opencode fixture
 * object (`{session, messages, parts, subAgents?}`, the same shape as
 * fixtures/sessions/opencode/*.json), so the earliest one lands at the
 * anchor time. Returns a new object; the input is left untouched.
 */
export function shiftOpencodeFixture(fixture) {
  const minMs = findMinEpochMs(fixture);
  if (minMs === undefined) return fixture;
  const offset = anchorMs() - minMs;
  return shiftDeep(fixture, offset);
}
