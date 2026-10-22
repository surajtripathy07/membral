import { makeMemoryFakeSupabase as makeFakeSupabase } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { type MemoryRow, rankAndServe } from "../verify";

const TEXT = "Blocker freshness uses one constant, BLOCKER_FRESH_DAYS = 7, across preamble, search and recall";

function row(id: string, session: string, createdAt: string, over: Partial<MemoryRow> = {}): MemoryRow {
  return {
    id,
    code_session_id: session,
    code_project_id: "p1",
    agent_id: null,
    source: "extractor",
    kind: "decision",
    text: TEXT,
    quote: null,
    turn_idx: 1,
    turn_role: "user",
    ref: null,
    ref_kind: null,
    branch: null,
    head_sha: null,
    thread: null,
    paths: [],
    verified: true,
    durable: true,
    observed_durable: false,
    recurrence_count: 1,
    scope: "project",
    confidence: 1,
    supersedes: null,
    retired_at: null,
    chat_conversation_id: null,
    created_at: createdAt,
    ...over,
  };
}

const db = () =>
  makeFakeSupabase({
    code_session_turns: [],
    code_projects: [{ id: "p1", user_id: "u1", display_name: "acme", repo_identity: "github.com/acme/api" }],
    code_sessions: [
      { id: "s-old", user_id: "u1", started_at: "2026-09-01T00:00:00Z", ended_at: "2026-09-01T01:00:00Z" },
      { id: "s-new", user_id: "u1", started_at: "2026-09-20T00:00:00Z", ended_at: "2026-09-20T01:00:00Z" },
    ],
  });

describe("rankAndServe: serve-time collapse (L2)", () => {
  // The NEWER session's record was inserted FIRST (a re-extraction wrote the old session's row last).
  const rows = [
    row("new-session", "s-new", "2026-09-02T00:00:00Z"),
    row("old-session", "s-old", "2026-10-09T00:00:00Z"),
  ];

  it("serves one line per fact, the newest SESSION's record, with seen_in", async () => {
    const out = await rankAndServe(db(), "u1", rows, "tool", 10);
    expect(out.map((r) => r.id)).toEqual(["new-session"]);
    expect(out[0].seen_in).toBe(2);
    expect(out[0].collapsed_ids).toEqual(["old-session"]);
  });

  it("collapse: false serves both, with no seen_in", async () => {
    const out = await rankAndServe(db(), "u1", rows, "tool", 10, { collapse: false });
    expect(out).toHaveLength(2);
    expect(out.every((r) => r.seen_in === undefined)).toBe(true);
  });

  it("does not merge a different kind or another project's record", async () => {
    const out = await rankAndServe(
      db(),
      "u1",
      [...rows, row("other-kind", "s-old", "2026-09-03T00:00:00Z", { kind: "learning" })],
      "tool",
      10,
    );
    expect(out.map((r) => r.id).sort()).toEqual(["new-session", "other-kind"]);
  });

  it("marks a record superseded_by when the caller passes its replacement (history mode)", async () => {
    const out = await rankAndServe(db(), "u1", [rows[0]], "tool", 10, {
      supersededBy: new Map([["new-session", { id: "z", at: "2026-10-04T05:00:00Z" }]]),
    });
    expect(out[0].superseded_by).toEqual({ id: "z", on: "2026-10-04" });
  });
});
