// Coverage for getCodeProjectFacts / getCodeSessionFacts (GitHub issue #87) —
// the first UI reads of code_kg_nodes/code_kg_edges (migration 031). Exercises
// against FakeSupabase so the double-filter (user_id AND code_project_id —
// 031's own OWNERSHIP NOTE/F11 warns filtering code_project_id alone is a
// graph-poisoning vector), the edge->node resolution, and the adversarial
// verify's F2/F3/F7 findings are all proven, not just structurally typed.

import { FakeSupabase } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { getCodeProjectFacts, getCodeSessionFacts } from "../queries";

const USER = "user-1";
const OTHER_USER = "user-2";
const PROJECT = "project-1";
const OTHER_PROJECT = "project-2";

function seedNode(db: FakeSupabase, overrides: Record<string, unknown> = {}) {
  db.seed("code_kg_nodes", [
    {
      id: `node-${Math.random()}`,
      user_id: USER,
      code_project_id: PROJECT,
      node_type: "file",
      key: "src/App.tsx",
      label: "src/App.tsx",
      ref_id: null,
      props: {},
      session_count: 1,
      first_seen_at: null,
      last_seen_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
      ...overrides,
    },
  ]);
}

describe("getCodeProjectFacts", () => {
  it("returns file/tool/subagent rows scoped to BOTH user_id and code_project_id", async () => {
    const db = new FakeSupabase();
    seedNode(db, { id: "n-file", node_type: "file", key: "src/App.tsx", label: "src/App.tsx", session_count: 3 });
    seedNode(db, { id: "n-tool", node_type: "tool", key: "Edit", label: "Edit", session_count: 5 });
    // Same user, DIFFERENT project — must not leak in.
    seedNode(db, { id: "n-other-project", code_project_id: OTHER_PROJECT, node_type: "file", key: "leak.ts" });
    // Different user, SAME project id (the graph-poisoning vector 031 warns about).
    seedNode(db, { id: "n-other-user", user_id: OTHER_USER, node_type: "file", key: "poison.ts" });
    // A project/session mirror node — must be excluded (not in the node_type allow-list).
    seedNode(db, { id: "n-session", node_type: "session", key: "sess-1", label: "sess-1" });

    const result = await getCodeProjectFacts(db.asClient(), USER, PROJECT);
    expect(result.rows.map((r) => r.id).sort()).toEqual(["n-file", "n-tool"].sort());
    expect(result.rows.every((r) => ["file", "tool", "subagent"].includes(r.node_type))).toBe(true);
  });

  it("returns empty rows and zeroed trueCounts for a project with no code_kg rows", async () => {
    const db = new FakeSupabase();
    const result = await getCodeProjectFacts(db.asClient(), USER, PROJECT);
    expect(result.rows).toEqual([]);
    expect(result.trueCounts.file).toEqual({ total: 0, qualifying: 0 });
    expect(result.trueCounts.tool).toEqual({ total: 0, qualifying: 0 });
    expect(result.trueCounts.subagent).toEqual({ total: 0, qualifying: 0 });
  });

  it("F3: trueCounts reflect the FULL per-type corpus even when it exceeds the per-type fetch cap (40)", async () => {
    const db = new FakeSupabase();
    // 45 file nodes: 45 qualify (session_count >= 2) — more than the 40-row
    // per-type fetch limit, so this proves trueCounts.qualifying/.total come
    // from an exact count query, not from counting the (capped) fetched rows.
    for (let i = 0; i < 45; i++) {
      seedNode(db, {
        id: `n-file-${i}`,
        node_type: "file",
        key: `file-${i}.ts`,
        label: `file-${i}.ts`,
        session_count: 2,
      });
    }
    // A handful of tool/subagent rows that must NOT be starved by the file
    // type's large row count (the original shared `.limit(60)` bug — F3).
    seedNode(db, { id: "n-tool-1", node_type: "tool", key: "Edit", label: "Edit", session_count: 3 });
    seedNode(db, { id: "n-subagent-1", node_type: "subagent", key: "explore", label: "Explore", session_count: 1 });

    const result = await getCodeProjectFacts(db.asClient(), USER, PROJECT);
    expect(result.trueCounts.file).toEqual({ total: 45, qualifying: 45 });
    expect(result.trueCounts.tool).toEqual({ total: 1, qualifying: 1 });
    expect(result.trueCounts.subagent).toEqual({ total: 1, qualifying: 0 });
    // The tool/subagent rows are still present in the fetched data despite
    // the file type dominating row count — each type got its own query.
    expect(result.rows.some((r) => r.id === "n-tool-1")).toBe(true);
    expect(result.rows.some((r) => r.id === "n-subagent-1")).toBe(true);
    // File rows are fetch-capped at 40 even though 45 exist.
    expect(result.rows.filter((r) => r.node_type === "file")).toHaveLength(40);
  });
});

describe("getCodeSessionFacts", () => {
  it("returns null-ish (sessionProps: null, edges: []) when there is no session mirror node", async () => {
    const db = new FakeSupabase();
    const result = await getCodeSessionFacts(db.asClient(), USER, "session-missing");
    expect(result).toEqual({ sessionProps: null, edges: [] });
  });

  it("F2: another user's session mirror node with the SAME ref_id is never returned (kills a dropped user_id filter)", async () => {
    const db = new FakeSupabase();
    db.seed("code_kg_nodes", [
      {
        id: "node-other-user-session",
        user_id: OTHER_USER,
        code_project_id: "other-project",
        node_type: "session",
        key: "session-shared-id",
        label: "session-shared-id",
        ref_id: "session-shared-id",
        props: { models: ["should-never-leak"] },
        session_count: 1,
        created_at: "2026-01-01T00:00:00.000Z",
      },
    ]);

    const result = await getCodeSessionFacts(db.asClient(), USER, "session-shared-id");
    expect(result).toEqual({ sessionProps: null, edges: [] });
  });

  it("resolves the session node's outgoing touched/used edges to their destination file/tool labels", async () => {
    const db = new FakeSupabase();
    const sessionNodeId = "node-session-1";
    const fileNodeId = "node-file-1";
    const toolNodeId = "node-tool-1";

    db.seed("code_kg_nodes", [
      {
        id: sessionNodeId,
        user_id: USER,
        code_project_id: PROJECT,
        node_type: "session",
        key: "session-1",
        label: "session-1",
        ref_id: "session-1",
        props: {
          models: ["claude-sonnet-4-5"],
          usage: { inputTokens: 10 },
          est_cost_usd: { amount: 0.01, price_table_version: "v1" },
        },
        session_count: 1,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: fileNodeId,
        user_id: USER,
        code_project_id: PROJECT,
        node_type: "file",
        key: "src/App.tsx",
        label: "src/App.tsx",
        ref_id: null,
        props: {},
        session_count: 1,
      },
      {
        id: toolNodeId,
        user_id: USER,
        code_project_id: PROJECT,
        node_type: "tool",
        key: "Edit",
        label: "Edit",
        ref_id: null,
        props: {},
        session_count: 1,
      },
    ]);
    db.seed("code_kg_edges", [
      {
        id: "edge-1",
        user_id: USER,
        code_project_id: PROJECT,
        src_node_id: sessionNodeId,
        dst_node_id: fileNodeId,
        rel_type: "touched",
        weight: 2,
        props: { edit_count: 2, created: true },
      },
      {
        id: "edge-2",
        user_id: USER,
        code_project_id: PROJECT,
        src_node_id: sessionNodeId,
        dst_node_id: toolNodeId,
        rel_type: "used",
        weight: 4,
        props: {},
      },
      // A CONTAINS edge from project -> session must be excluded (not touched/used).
      {
        id: "edge-3",
        user_id: USER,
        code_project_id: PROJECT,
        src_node_id: "node-project-1",
        dst_node_id: sessionNodeId,
        rel_type: "contains",
        weight: 1,
        props: {},
      },
    ]);

    const result = await getCodeSessionFacts(db.asClient(), USER, "session-1");
    // UX W5: the stored cost snapshot on the node never leaves the query.
    expect(result.sessionProps).toEqual({
      models: ["claude-sonnet-4-5"],
      usage: { inputTokens: 10 },
    });
    expect(result.edges).toHaveLength(2);
    const byRelType = Object.fromEntries(result.edges.map((e) => [e.rel_type, e]));
    expect(byRelType.touched).toMatchObject({ key: "src/App.tsx", label: "src/App.tsx", weight: 2 });
    expect(byRelType.touched.props).toEqual({ edit_count: 2, created: true });
    expect(byRelType.used).toMatchObject({ key: "Edit", label: "Edit", weight: 4 });
  });

  it("F7: a session mirrored under two projects (same user, same ref_id) does not throw — picks deterministically (earliest created_at)", async () => {
    const db = new FakeSupabase();
    db.seed("code_kg_nodes", [
      {
        id: "node-session-first",
        user_id: USER,
        code_project_id: PROJECT,
        node_type: "session",
        key: "session-dup",
        label: "session-dup",
        ref_id: "session-dup",
        props: { models: ["first-mirror"] },
        session_count: 1,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "node-session-second",
        user_id: USER,
        code_project_id: OTHER_PROJECT,
        node_type: "session",
        key: "session-dup",
        label: "session-dup",
        ref_id: "session-dup",
        props: { models: ["second-mirror"] },
        session_count: 1,
        created_at: "2026-02-01T00:00:00.000Z",
      },
    ]);

    const result = await getCodeSessionFacts(db.asClient(), USER, "session-dup");
    expect(result.sessionProps).toEqual({ models: ["first-mirror"] });
  });
});
