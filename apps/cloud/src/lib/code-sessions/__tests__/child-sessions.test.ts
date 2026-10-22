// Migration 089: sub-agent child sessions are excluded from every list/count
// of code sessions but still reachable by id and via listChildSessions.

import { FakeSupabase } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { RawCodeSessionSchema } from "../payload";
import {
  getCodeProjectDetail,
  getCodeSessionCount,
  getCodeSessionDetail,
  getParentSessionForChild,
  getRecentCodeSessions,
  listChildSessions,
} from "../queries";

const USER_ID = "user-1";

function seed(): FakeSupabase {
  const db = new FakeSupabase();
  db.seed("code_projects", [
    { id: "proj-1", user_id: USER_ID, display_name: "webapp", repo_identity: "github.com/acme/webapp", props: {} },
  ]);
  const base = {
    user_id: USER_ID,
    code_project_id: "proj-1",
    source: "claude-code",
    title: null,
    summary: null,
    turn_count: 3,
    user_turn_count: 1,
    files_touched: [],
  };
  db.seed("code_sessions", [
    {
      ...base,
      id: "s-parent",
      source_session_id: "p1",
      parent_source_session_id: null,
      started_at: "2026-09-01T10:00:00Z",
    },
    { ...base, id: "s-old", source_session_id: "p0", started_at: "2026-08-01T10:00:00Z" },
    {
      ...base,
      id: "s-child",
      source_session_id: "p1:agent-a1",
      parent_source_session_id: "p1",
      started_at: "2026-09-01T10:01:00Z",
      turn_count: 7,
      props: { subAgent: { agentType: "Explore", description: "look around", toolUseId: "toolu_1" } },
    },
  ]);
  return db;
}

describe("child sessions are excluded from lists and counts", () => {
  it("getCodeSessionCount counts top-level sessions only", async () => {
    expect(await getCodeSessionCount(seed().asClient(), USER_ID)).toBe(2);
  });

  it("getRecentCodeSessions never returns a child", async () => {
    const rows = await getRecentCodeSessions(seed().asClient(), USER_ID, 10);
    expect(rows.map((r) => r.id).sort()).toEqual(["s-old", "s-parent"]);
  });

  it("getCodeProjectDetail's session list and total exclude children", async () => {
    const detail = await getCodeProjectDetail(seed().asClient(), USER_ID, "proj-1", 1, 20);
    expect(detail?.sessions.map((s) => s.id).sort()).toEqual(["s-old", "s-parent"]);
    expect(detail?.sessionsTotal).toBe(2);
  });

  it("a child is still fetchable by id", async () => {
    const detail = await getCodeSessionDetail(seed().asClient(), USER_ID, "s-child", true);
    expect(detail?.session.id).toBe("s-child");
  });
});

describe("listChildSessions", () => {
  it("returns a parent's children with their spawn metadata", async () => {
    const rows = await listChildSessions(seed().asClient(), USER_ID, "claude-code", "p1");
    expect(rows).toEqual([
      {
        id: "s-child",
        source_session_id: "p1:agent-a1",
        title: null,
        started_at: "2026-09-01T10:01:00Z",
        turn_count: 7,
        agent_type: "Explore",
        description: "look around",
        tool_use_id: "toolu_1",
        agent_id: null,
        parent_agent_id: null,
      },
    ]);
  });

  it("is scoped by source and user", async () => {
    expect(await listChildSessions(seed().asClient(), USER_ID, "opencode", "p1")).toEqual([]);
    expect(await listChildSessions(seed().asClient(), "user-2", "claude-code", "p1")).toEqual([]);
  });
});

describe("getParentSessionForChild", () => {
  it("resolves a child's parent by (user_id, source, source_session_id)", async () => {
    const parent = await getParentSessionForChild(seed().asClient(), USER_ID, "claude-code", "p1");
    expect(parent?.id).toBe("s-parent");
  });

  it("returns null for a wrong user or a parent source_session_id that doesn't exist", async () => {
    expect(await getParentSessionForChild(seed().asClient(), "user-2", "claude-code", "p1")).toBeNull();
    expect(await getParentSessionForChild(seed().asClient(), USER_ID, "claude-code", "no-such-session")).toBeNull();
  });
});

describe("RawCodeSessionSchema — parentSessionId / subAgent", () => {
  const base = {
    source: "claude-code",
    sourceSessionId: "p1:agent-a1",
    contentHash: "h",
    repo: {},
    startedAt: "",
    endedAt: "",
    turns: [],
    filesTouched: [],
    toolCounts: {},
  };

  it("accepts an optional parentSessionId + subAgent", () => {
    const parsed = RawCodeSessionSchema.parse({ ...base, parentSessionId: "p1", subAgent: { agentType: "Explore" } });
    expect(parsed.parentSessionId).toBe("p1");
    expect(parsed.subAgent?.agentType).toBe("Explore");
  });

  it("still accepts a session without them, and rejects an empty parentSessionId", () => {
    expect(RawCodeSessionSchema.safeParse(base).success).toBe(true);
    expect(RawCodeSessionSchema.safeParse({ ...base, parentSessionId: "" }).success).toBe(false);
  });
});
