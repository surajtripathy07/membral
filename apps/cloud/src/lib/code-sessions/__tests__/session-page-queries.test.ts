// Session-page viewer-check fixes on the query side: the whole-session
// tool-use index (D2), the parent's props.subAgents[] spawn index (D3) and
// the parent's first prompt for the child breadcrumb.

import { FakeSupabase } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { getCodeSessionDetail, getParentSessionForChild, getSessionToolUseIndex } from "../queries";

const USER_ID = "user-1";

function seed(): FakeSupabase {
  const db = new FakeSupabase();
  db.seed("code_projects", [
    { id: "proj-1", user_id: USER_ID, display_name: "webapp", repo_identity: null, props: {} },
  ]);
  db.seed("code_sessions", [
    {
      id: "s-parent",
      user_id: USER_ID,
      code_project_id: "proj-1",
      source: "opencode",
      source_session_id: "ses_parent",
      parent_source_session_id: null,
      title: null,
      summary: null,
      git_branch: "main",
      turn_count: 4,
      user_turn_count: 1,
      files_touched: [],
      started_at: "2026-09-25T10:00:00Z",
      props: { subAgents: [{ agentId: "ses_child", toolUseId: "toolu_9" }] },
    },
  ]);
  const t = { user_id: USER_ID, session_id: "s-parent", text: null, tool_name: null, file_path: null, ts: null };
  db.seed("code_session_turns", [
    { ...t, idx: 0, role: "user", kind: "prose", text: "Audit the repo", props: {} },
    { ...t, idx: 1, role: "assistant", kind: "tool_use", tool_name: "task", props: { toolUseId: "toolu_9" } },
    { ...t, idx: 2, role: "assistant", kind: "tool_use", tool_name: "read", props: {} },
    { ...t, idx: 3, role: "user", kind: "tool_result", props: { toolUseId: "toolu_9" } },
    { ...t, session_id: "other", idx: 1, role: "assistant", kind: "tool_use", props: { toolUseId: "toolu_x" } },
  ]);
  return db;
}

describe("getSessionToolUseIndex", () => {
  it("returns idx + toolUseId for this session's tool_use turns only", async () => {
    expect(await getSessionToolUseIndex(seed().asClient(), USER_ID, "s-parent")).toEqual([
      { idx: 1, toolUseId: "toolu_9" },
    ]);
  });
});

describe("getCodeSessionDetail — subAgentSpawnIndex", () => {
  it("exposes the parent's props.subAgents[] agentId -> toolUseId", async () => {
    const detail = await getCodeSessionDetail(seed().asClient(), USER_ID, "s-parent", true);
    expect([...(detail?.subAgentSpawnIndex ?? [])]).toEqual([["ses_child", "toolu_9"]]);
  });
});

describe("getParentSessionForChild — first_prompt", () => {
  it("carries the parent's first user prompt when it has no title", async () => {
    const parent = await getParentSessionForChild(seed().asClient(), USER_ID, "opencode", "ses_parent");
    expect(parent?.first_prompt).toBe("Audit the repo");
  });
});

describe("getCodeSessionDetail — ?turn=N deep link in a long session", () => {
  it("renders a bounded window around N — past the 1000-row response cap too (a 1068-turn session)", async () => {
    const db = new FakeSupabase();
    db.seed("code_projects", [
      { id: "proj-1", user_id: USER_ID, display_name: "webapp", repo_identity: null, props: {} },
    ]);
    db.seed("code_sessions", [
      {
        id: "s-long",
        user_id: USER_ID,
        code_project_id: "proj-1",
        source: "claude-code",
        source_session_id: "long",
        parent_source_session_id: null,
        title: null,
        summary: null,
        git_branch: "main",
        turn_count: 1068,
        user_turn_count: 1,
        files_touched: [],
        started_at: "2026-09-25T10:00:00Z",
        props: {},
      },
    ]);
    const base = {
      user_id: USER_ID,
      session_id: "s-long",
      text: null,
      tool_name: "read",
      file_path: null,
      ts: null,
      props: {},
    };
    db.seed(
      "code_session_turns",
      Array.from({ length: 1068 }, (_, idx) =>
        idx === 0
          ? { ...base, idx, role: "user", kind: "prose", text: "Start", tool_name: null }
          : { ...base, idx, role: "assistant", kind: "tool_use" },
      ),
    );
    const detail = await getCodeSessionDetail(db.asClient(), USER_ID, "s-long", false, 1040);
    // Only the window [N-15, N+50] clamped to the end: turn N is there, nothing far away is rendered first.
    expect(detail?.window).toEqual({ from: 1025, to: 1067, hasLater: false });
    expect(detail?.turns.map((t) => t.idx)).toEqual(Array.from({ length: 43 }, (_, i) => 1025 + i));
    expect(detail?.truncated).toBe(true);
    const early = await getCodeSessionDetail(db.asClient(), USER_ID, "s-long", false, 5);
    expect(early?.window).toEqual({ from: 0, to: 55, hasLater: true });
    expect(early?.turns[0]?.idx).toBe(0);
    // Review r2 S6: a stale turn_count never hides stored turns past it.
    db.getRows("code_sessions")[0].turn_count = 1000;
    const stale = await getCodeSessionDetail(db.asClient(), USER_ID, "s-long", false, 1040);
    expect(stale?.turns.some((t) => t.idx === 1040)).toBe(true);
    expect(stale?.window?.to).toBe(1067);
    db.getRows("code_sessions")[0].turn_count = 1068;
    // The no-param load is unchanged: the first 500 turns.
    const plain = await getCodeSessionDetail(db.asClient(), USER_ID, "s-long", false);
    expect(plain?.turns.length).toBe(500);
    expect(plain?.truncated).toBe(true);
    expect(plain?.window).toBeUndefined();
  });
});
