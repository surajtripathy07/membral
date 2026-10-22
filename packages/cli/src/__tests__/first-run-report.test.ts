import { describe, expect, it } from "vitest";
import { renderFirstRunReport } from "../first-run-report.js";
import type { SessionFact } from "../import-sessions.js";

const f = (harness: string, startedAt: string, isSubAgent = false): SessionFact => ({ harness, startedAt, isSubAgent });
const WINDOW_START = "2026-09-03T00:00:00.000Z";

describe("renderFirstRunReport", () => {
  it("several harnesses with sub-agents; a session that started before the window is clamped to its start", () => {
    const lines = renderFirstRunReport({
      windowDays: 30,
      windowStart: WINDOW_START,
      sessions: [
        f("claude-code", "2026-08-30T08:00:00Z"),
        f("claude-code", "2026-09-20T08:00:00Z", true),
        f("claude-code", "2026-10-02T08:00:00Z", true),
        f("opencode", "2026-09-10T08:00:00Z"),
        f("copilot-cli", "2026-09-11T08:00:00Z"),
      ],
    });
    expect(lines.join("\n")).toMatchInlineSnapshot(`
      "Found on this machine, last 30 days: 5 sessions
        By harness: Claude Code 3, Copilot CLI 1, opencode 1
        Sub-agents: 2 of 5 (40%)
        Span: 2026-09-03 to 2026-10-02 (30 days)"
    `);
  });

  it("empty history", () => {
    expect(renderFirstRunReport({ windowDays: 30, windowStart: WINDOW_START, sessions: [] })).toMatchInlineSnapshot(`
      [
        "No past sessions found in the last 30 days.",
      ]
    `);
  });

  it("single harness, one session, unknown ids keep their raw name", () => {
    const one = renderFirstRunReport({
      windowDays: 30,
      windowStart: WINDOW_START,
      sessions: [f("opencode", "2026-10-01T10:00:00Z")],
    });
    expect(one.join("\n")).toMatchInlineSnapshot(`
      "Found on this machine, last 30 days: 1 session
        By harness: opencode 1
        Sub-agents: 0 of 1 (0%)
        Span: 2026-10-01 to 2026-10-01 (1 day)"
    `);
    const unknown = renderFirstRunReport({
      windowDays: 30,
      windowStart: WINDOW_START,
      sessions: [f("newharness", "2026-10-01T10:00:00Z")],
    });
    expect(unknown[1]).toBe("  By harness: newharness 1");
  });
});
