import { describe, expect, it } from "vitest";
import {
  endedAtSecond,
  isKnownStoredSession,
  isSameStoredSession,
  KNOWN_SESSIONS_MAX_BATCH,
  knownSessionProbe,
  needsParserRefresh,
  sessionTurnCount,
} from "../../sessions/known.js";
import type { RawCodeSession } from "../../sessions/types.js";

function session(turns: number, endedAt: string): RawCodeSession {
  return {
    source: "claude-code",
    sourceSessionId: "s-1",
    contentHash: "h",
    repo: {},
    startedAt: "2026-02-01T00:00:00.000Z",
    endedAt,
    turns: Array.from({ length: turns }, (_, idx) => ({
      idx,
      role: "user" as const,
      kind: "prose" as const,
      text: "x",
      ts: "2026-02-01T00:00:00.000Z",
    })),
    filesTouched: [],
    toolCounts: {},
  };
}

describe("known-session probe", () => {
  it("turn_count is the payload's turn array length, the value the ingest stores", () => {
    expect(sessionTurnCount(session(7, "2026-02-01T00:00:00.000Z"))).toBe(7);
    expect(knownSessionProbe(session(3, "2026-02-01T00:05:00.000Z"))).toEqual({
      source: "claude-code",
      source_session_id: "s-1",
      turn_count: 3,
      ended_at: "2026-02-01T00:05:00.000Z",
    });
  });

  it("compares ended_at at second precision across Postgres and ISO spellings", () => {
    expect(endedAtSecond("2026-02-01T00:00:00.999Z")).toBe(endedAtSecond("2026-02-01T00:00:00.123+00:00"));
    expect(endedAtSecond("2026-02-01T00:00:01.000Z")).not.toBe(endedAtSecond("2026-02-01T00:00:00.999Z"));
    expect(endedAtSecond(null)).toBeNull();
    expect(endedAtSecond("")).toBeNull();
  });

  it("matches only when turn count and ended_at both agree; null equals null", () => {
    const probe = knownSessionProbe(session(2, "2026-02-01T00:00:00.500Z"));
    expect(isSameStoredSession(probe, { turn_count: 2, ended_at: "2026-02-01T00:00:00+00:00" })).toBe(true);
    expect(isSameStoredSession(probe, { turn_count: 1, ended_at: "2026-02-01T00:00:00+00:00" })).toBe(false);
    expect(isSameStoredSession(probe, { turn_count: 2, ended_at: "2026-02-01T00:00:05+00:00" })).toBe(false);
    expect(isSameStoredSession({ turn_count: 0, ended_at: null }, { turn_count: 0, ended_at: null })).toBe(true);
    expect(KNOWN_SESSIONS_MAX_BATCH).toBe(500);
  });
});

// Issue #171: a stored session parsed by an older parser is not "known", so
// the CLI re-sends it and the upgrade reaches it (maintainer ruling
// 2026-09-28: no age window).
describe("parser-version refresh (issue #171)", () => {
  const ended = "2026-02-20T10:00:00.000Z";
  const probe = (actions_version?: number) => ({
    turn_count: 2,
    ended_at: ended,
    ...(actions_version === undefined ? {} : { actions_version }),
  });
  const row = (actions_version: unknown) => ({ turn_count: 2, ended_at: ended, actions_version });

  it("stale stored version is not known, whatever the session's age", () => {
    expect(isKnownStoredSession(probe(2), row(1))).toBe(false);
    expect(
      isKnownStoredSession(
        { turn_count: 2, ended_at: "2020-01-01T00:00:00.000Z", actions_version: 2 },
        { turn_count: 2, ended_at: "2020-01-01T00:00:00.000Z", actions_version: 1 },
      ),
    ).toBe(false);
  });
  it("current (or newer) stored version is known", () => {
    expect(isKnownStoredSession(probe(2), row(2))).toBe(true);
    expect(isKnownStoredSession(probe(2), row(3))).toBe(true);
  });
  it("a probe without actions_version gets today's result", () => {
    expect(isKnownStoredSession(probe(), row(null))).toBe(true);
    expect(isKnownStoredSession(probe(), row(1))).toBe(true);
    expect(isKnownStoredSession({ turn_count: 3, ended_at: ended }, row(null))).toBe(false);
  });
  it("null or missing stored version counts as older", () => {
    expect(isKnownStoredSession(probe(2), row(null))).toBe(false);
    expect(isKnownStoredSession(probe(2), row(undefined))).toBe(false);
    expect(needsParserRefresh(null, 2)).toBe(true);
    expect(needsParserRefresh(1, undefined)).toBe(false);
  });
  it("the probe carries the session's actionsVersion when stamped", () => {
    expect(knownSessionProbe({ ...session(1, ended), actionsVersion: 2 }).actions_version).toBe(2);
    expect("actions_version" in knownSessionProbe(session(1, ended))).toBe(false);
  });
});
