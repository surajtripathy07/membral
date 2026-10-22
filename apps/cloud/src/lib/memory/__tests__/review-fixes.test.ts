// 2026-09-27 review fixes (cloud data slice): one test per rule.

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it, vi } from "vitest";
import { buildProfile, sharesSummingExactly } from "@/lib/code-sessions/profile";
import { dropCrossSessionDuplicates, type InsertableRecord, insertMemoryRecords } from "@/lib/memory/write";
import { deriveUserStats } from "@/lib/stats/user-stats";
import { type GroundedSessionIssue, groundSessionIssues } from "../extract";
import { collapseRecurrenceChains } from "../preamble";
import { writeSessionIssueRows } from "../session-issues";

const PID = "github.com/acme/app";
// biome-ignore lint/suspicious/noExplicitAny: loose turn fixture
const t = (idx: number, over: Record<string, any> = {}) => ({
  idx,
  role: "assistant",
  kind: "prose",
  text: "",
  tool_name: null,
  file_path: null,
  props: null,
  ...over,
});

describe("session issues: one row per (ref, kind), fresh role and shares on every run", () => {
  const prefix = [
    t(0, {
      role: "user",
      text: "/fix acme/app#42",
      props: { action: { verb: "referenced", ref: "acme/app#42", refKind: "issue", source: "command" } },
    }),
    t(1, { text: "looking" }),
  ];
  const full = [
    ...prefix,
    t(2, {
      kind: "tool_use",
      tool_name: "Bash",
      props: { action: { verb: "committed", ref: "acme/app#42", refKind: "issue", sha: "abc1234", source: "cli" } },
    }),
  ];

  it("a tail run whose derived role changed replaces the old-role row instead of adding a second", async () => {
    const tables: Record<string, Row[]> = { code_session_issues: [] };
    const sb = makeFakeSupabase(tables);
    await writeSessionIssueRows(sb, "u1", "s1", groundSessionIssues([], prefix, PID), true);
    expect(tables.code_session_issues.map((r) => [r.ref, r.role])).toEqual([[`${PID}#42`, "referenced"]]);
    await writeSessionIssueRows(sb, "u1", "s1", groundSessionIssues([], full, PID), false);
    expect(tables.code_session_issues.map((r) => [r.ref, r.role, r.turn_share])).toEqual([
      // v4 B1: an issue labels the commit — no PR branch, no share.
      [`${PID}#42`, "worked_on", 0],
    ]);
  });

  it("a tail run refreshes shares: a stale share never survives beside fresh ones (shares sum to 1)", async () => {
    const tables: Record<string, Row[]> = {
      code_session_issues: [
        // An earlier run's row at share 1, no longer offered with that share.
        {
          id: "old",
          user_id: "u1",
          session_id: "s1",
          ref: `${PID}#1`,
          kind: "issue",
          role: "discussed",
          turn_share: 1,
        },
      ],
    };
    const turns = [
      t(0, {
        role: "user",
        text: "/fix acme/app#2",
        props: { action: { verb: "referenced", ref: "acme/app#2", refKind: "issue", source: "command" } },
      }),
      t(1, { text: "on it" }),
    ];
    await writeSessionIssueRows(makeFakeSupabase(tables), "u1", "s1", groundSessionIssues([], turns, PID), false);
    // v4: a slash line alone carries no share; the stale share is still zeroed (never survives).
    const sum = tables.code_session_issues.reduce((s, r) => s + Number(r.turn_share ?? 0), 0);
    expect(sum).toBeLessThanOrEqual(1);
    expect(tables.code_session_issues.find((r) => r.id === "old")?.turn_share).toBe(0);
  });

  it("shares sum to 1 exactly: 3 x 1/3 and 1/6 + 1/6 + 4/6", () => {
    expect(sharesSummingExactly([1, 1, 1], 3).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(sharesSummingExactly([1, 1, 4], 6).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(sharesSummingExactly([1, 1, 4], 6)).toEqual([0.1667, 0.1667, 0.6666]);
    expect(sharesSummingExactly([0, 3], 4)).toEqual([0, 0.75]);
    const turns: Row[] = [];
    let idx = 0;
    for (const r of ["a/b!1", "a/b!2", "a/b!3"]) {
      // v4: share needs PR/branch evidence — an MR create naming the item.
      turns.push({
        idx: idx++,
        role: "assistant",
        kind: "tool_use",
        tool_name: "Bash",
        props: { action: { verb: "opened_mr", ref: r, refKind: "merge_request", source: "cli" } },
      });
      turns.push({ idx: idx++, role: "assistant", kind: "prose" });
    }
    // biome-ignore lint/suspicious/noExplicitAny: fixture
    const p = buildProfile(turns as any);
    expect(p.refs.reduce((s, r) => s + r.turn_share, 0)).toBeCloseTo(1, 10);
  });
});

describe("session issues: a cross-repo MR is one row (host-stripped owner/repo + number + kind)", () => {
  it("the model's URL and the observed other/lib!5 merge into one row carrying the observed role", () => {
    const turns = [
      t(0, { role: "user", text: "please look at https://github.com/other/lib/pull/5 and comment" }),
      t(1, {
        kind: "tool_use",
        tool_name: "Bash",
        props: { action: { verb: "commented", ref: "other/lib!5", refKind: "merge_request", source: "cli" } },
      }),
    ];
    const out = groundSessionIssues(
      [
        {
          ref: "https://github.com/other/lib/pull/5",
          kind: "merge_request",
          evidence_quote: "please look at https://github.com/other/lib/pull/5",
        },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: fixture
      turns as any,
      PID,
    );
    expect(out.map((o) => [o.ref, o.role])).toEqual([["github.com/other/lib#5", "worked_on"]]);
  });
});

describe("session issues: a session with no actions at all (pre-W3 CLI) — v4: no verb, so referenced", () => {
  const turns = [
    t(0, { role: "user", text: "fixes #12 for the retry path" }),
    t(1, { role: "user", text: "see #13 later on" }),
  ];
  it("v4 item 7: the model role is never shown — referenced, share 0, tier inferred", () => {
    const out = groundSessionIssues(
      [
        { ref: "#12", kind: "issue", role: "worked_on", evidence_quote: "fixes #12 for the retry path" },
        { ref: "#13", kind: "issue", role: "referenced", evidence_quote: "see #13 later on" },
      ],
      // biome-ignore lint/suspicious/noExplicitAny: fixture
      turns as any,
      PID,
    );
    expect(out.map((o) => [o.ref, o.role, o.role_source, o.tier, o.turn_share])).toEqual([
      [`${PID}#12`, "referenced", "model", "inferred", 0],
      [`${PID}#13`, "referenced", "model", "inferred", 0],
    ]);
  });

  it("a current-CLI session (actionsVersion stamped) with zero actions ignores the model role: referenced, not inferred", () => {
    const out = groundSessionIssues(
      [{ ref: "#12", kind: "issue", role: "worked_on", evidence_quote: "fixes #12 for the retry path" }],
      // biome-ignore lint/suspicious/noExplicitAny: fixture
      turns as any,
      PID,
      { actionsVersion: 1 },
    );
    expect(out.map((o) => [o.ref, o.role, o.tier])).toEqual([[`${PID}#12`, "referenced", "discussed"]]);
  });

  it("an unstamped session (actionsVersion null) with zero actions is the old CLI: inferred, referenced (no verb)", () => {
    const out = groundSessionIssues(
      [{ ref: "#12", kind: "issue", role: "worked_on", evidence_quote: "fixes #12 for the retry path" }],
      // biome-ignore lint/suspicious/noExplicitAny: fixture
      turns as any,
      PID,
      { actionsVersion: null },
    );
    expect(out.map((o) => [o.ref, o.role, o.tier])).toEqual([[`${PID}#12`, "referenced", "inferred"]]);
  });

  it("v4 item 7: re-extraction never carries a stored model-pass `worked_on` onto a row with no verb", async () => {
    const tables: Record<string, Row[]> = {
      code_session_issues: [
        {
          id: "r1",
          user_id: "u1",
          session_id: "s1",
          ref: `${PID}#12`,
          kind: "issue",
          role: "worked_on",
          turn_share: null,
        },
      ],
    };
    const out = groundSessionIssues(
      [{ ref: "#12", kind: "issue", evidence_quote: "fixes #12 for the retry path" }],
      // biome-ignore lint/suspicious/noExplicitAny: fixture
      turns as any,
      PID,
    );
    expect(out[0].role_source).toBe("default");
    await writeSessionIssueRows(makeFakeSupabase(tables), "u1", "s1", out, true);
    expect(tables.code_session_issues.map((r) => [r.ref, r.role, r.tier, r.turn_share])).toEqual([
      [`${PID}#12`, "referenced", "inferred", 0],
    ]);
  });

  it("a session WITH actions still ignores the model role (B2)", () => {
    const withAction = [
      ...turns,
      t(2, { kind: "tool_use", tool_name: "Bash", props: { action: { verb: "tested", source: "cli" } } }),
    ];
    const out: GroundedSessionIssue[] = groundSessionIssues(
      [{ ref: "#12", kind: "issue", role: "worked_on", evidence_quote: "fixes #12 for the retry path" }],
      // biome-ignore lint/suspicious/noExplicitAny: fixture
      withAction as any,
      PID,
    );
    expect(out.map((o) => [o.role, o.tier, o.turn_share])).toEqual([["referenced", "discussed", 0]]);
  });
});

describe("user_stats: a child session is priced through its parent only", () => {
  it("parent $X with a sub-agent run + its child row costs the same as the parent alone", () => {
    const USAGE = { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
    const base = {
      user_id: "u1",
      code_project_id: "p1",
      started_at: "2026-09-25T10:00:00Z",
      ended_at: null,
      duration_seconds: 60,
      turn_count: 1,
      user_turn_count: 1,
      tool_count: 0,
      model: "claude-sonnet-4-5",
    };
    const parent = {
      ...base,
      id: "s1",
      parent_source_session_id: null,
      props: { usage: USAGE, models: ["claude-sonnet-4-5"], subAgents: [{ model: "claude-sonnet-4-5", usage: USAGE }] },
    };
    const child = {
      ...base,
      id: "c1",
      parent_source_session_id: "src",
      props: { usage: USAGE, models: ["claude-sonnet-4-5"] },
    };
    const input = { day: "2026-09-25", turns: [], issues: [], mcpCalls: [] };
    // biome-ignore lint/suspicious/noExplicitAny: fixture
    const alone = deriveUserStats({ ...input, sessions: [parent] as any });
    // biome-ignore lint/suspicious/noExplicitAny: fixture
    const both = deriveUserStats({ ...input, sessions: [parent, child] as any });
    expect(alone[0].cost_usd).toBeGreaterThan(0);
    expect(both[0].cost_usd).toBe(alone[0].cost_usd);
    expect(both[0].sub_agent_sessions).toBe(1);
  });

  it("a legacy ref stored under two roles counts once, at its strongest role", () => {
    const s = {
      id: "s1",
      user_id: "u1",
      code_project_id: "p1",
      parent_source_session_id: null,
      started_at: "2026-09-25T10:00:00Z",
      ended_at: null,
      duration_seconds: 60,
      turn_count: 1,
      user_turn_count: 1,
      tool_count: 0,
      model: null,
      props: {},
    };
    const rows = deriveUserStats({
      day: "2026-09-25",
      // biome-ignore lint/suspicious/noExplicitAny: fixture
      sessions: [s] as any,
      turns: [],
      issues: [
        { session_id: "s1", ref: "x#1", role: "discussed" },
        { session_id: "s1", ref: "x#1", role: "worked_on" },
      ],
      mcpCalls: [],
    });
    expect(rows[0].ref_counts).toEqual({ worked_on: 1 });
    expect(rows[0].refs).toBe(1);
  });
});

describe("recurrence: the count lands on a LIVE root, atomically", () => {
  const at = (cos: number) => [cos, Math.sqrt(1 - cos * cos), 0, 0, 0, 0, 0, 0];
  const E0 = "[1,0,0,0,0,0,0,0]";

  it("a match whose recurs_of root is retired becomes the root itself", async () => {
    const supabase = makeFakeSupabase({
      session_memories: [
        {
          id: "gone",
          user_id: "u1",
          code_project_id: "p1",
          code_session_id: "s0",
          kind: "blocker",
          text: "g",
          embedding: E0,
          created_at: "2026-01-01T00:00:00Z",
          retired_at: "2026-02-01T00:00:00Z",
          recurs_of: null,
        },
        {
          id: "live",
          user_id: "u1",
          code_project_id: "p1",
          code_session_id: "s1",
          kind: "blocker",
          text: "l",
          embedding: E0,
          created_at: "2026-01-05T00:00:00Z",
          retired_at: null,
          recurs_of: "gone",
        },
      ],
    });
    const { kept } = await dropCrossSessionDuplicates(supabase, "u1", "p1", "s2", [
      { kind: "blocker", text: "again", verified: true, embedding: at(0.85), contentHash: "h" } as InsertableRecord,
    ]);
    expect(kept[0].recursOf).toBe("live");
  });

  it("A -> B -> C with A retired: the re-rooted live root B inherits A's count, so C makes it 3", async () => {
    const rows: Record<string, Row[]> = {
      session_memories: [
        {
          id: "A",
          user_id: "u1",
          code_session_id: "s0",
          recurrence_count: 2,
          retired_at: "2026-02-01T00:00:00Z",
          content_hash: "hA",
        },
        {
          id: "B",
          user_id: "u1",
          code_session_id: "s1",
          recurrence_count: 1,
          recurs_of: "A",
          retired_at: null,
          content_hash: "hB",
        },
      ],
    };
    const rec = {
      kind: "blocker",
      text: "C",
      quote: null,
      turn_idx: 0,
      turn_role: "assistant",
      ref: null,
      ref_kind: null,
      thread: null,
      paths: [],
      verified: true,
      durable: true,
      scope: "project",
      confidence: 1,
      contentHash: "hC",
      embedding: null,
      windowIndex: 0,
      recursOf: "B",
    } as unknown as InsertableRecord;
    await insertMemoryRecords(makeFakeSupabase(rows), "u1", "p1", "s2", "main", [rec]);
    expect(rows.session_memories.find((r) => r.id === "B")?.recurrence_count).toBe(3);
  });

  it("the increment is one SQL call (increment_memory_recurrence) when the RPC exists", async () => {
    const rpc = vi.fn().mockReturnValue({ data: 1, error: null });
    const rows: Record<string, Row[]> = {
      session_memories: [
        { id: "root", user_id: "u1", code_session_id: "s-old", recurrence_count: 1, content_hash: "h-root" },
      ],
    };
    const rec = {
      kind: "blocker",
      text: "fresh",
      quote: null,
      turn_idx: 0,
      turn_role: "assistant",
      ref: null,
      ref_kind: null,
      thread: null,
      paths: [],
      verified: true,
      durable: true,
      scope: "project",
      confidence: 1,
      contentHash: "fresh",
      embedding: null,
      windowIndex: 0,
      recursOf: "root",
    } as unknown as InsertableRecord;
    await insertMemoryRecords(
      makeFakeSupabase(rows, { rpc: { increment_memory_recurrence: rpc } }),
      "u1",
      "p1",
      "s2",
      "main",
      [rec],
    );
    expect(rpc).toHaveBeenCalledWith({ p_user_id: "u1", p_ids: ["root"], p_counts: [1] });
    // The RPC did the bump; no read-then-write fallback ran.
    expect(rows.session_memories.find((r) => r.id === "root")?.recurrence_count).toBe(1);
  });
});

// ---- recurring blocker chains: one row per chain, inline suffix, recurrence-first order ----

const USER = "user-1";
const PROJECT = "proj-a";
const SUFFIX = "was written down verbatim in this turn";
const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();

function mem(over: Partial<Row> & { id: string; text: string; turn_idx: number }): Row {
  return {
    user_id: USER,
    code_session_id: "sess-1",
    code_project_id: PROJECT,
    agent_id: null,
    source: "hook",
    kind: "blocker",
    quote: `${over.text} ${SUFFIX}`,
    turn_role: "assistant",
    ref: null,
    ref_kind: null,
    branch: null,
    head_sha: null,
    thread: null,
    paths: [],
    durable: true,
    recurrence_count: 1,
    recurs_of: null,
    scope: "project",
    confidence: 0.5,
    supersedes: null,
    retired_at: null,
    chat_conversation_id: null,
    created_at: daysAgo(1),
    ...over,
  };
}

describe("preamble: recurring blockers", () => {
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-secret";

  it("chains link transitively (a restarted root stays one chain) and seen = max(root count, live members)", () => {
    const rows = [
      mem({ id: "x", text: "x", turn_idx: 0, recurs_of: "retired-root", recurrence_count: 2, created_at: daysAgo(3) }),
      mem({ id: "y", text: "y", turn_idx: 1, recurs_of: "x", created_at: daysAgo(1) }),
      mem({ id: "z", text: "z", turn_idx: 2, created_at: daysAgo(1) }),
    ];
    // biome-ignore lint/suspicious/noExplicitAny: fixture
    const { rows: kept, seen } = collapseRecurrenceChains(rows as any);
    expect(kept.map((r) => r.id)).toEqual(["y", "z"]);
    expect(seen.get("y")).toBe(2);
    expect(seen.get("z")).toBe(1);
  });

  it("seen N counts a retired root's occurrences: live B, C pointing at retired A (count 3) read seen 3x", () => {
    const rows = [
      mem({ id: "B", text: "b", turn_idx: 0, recurs_of: "A", created_at: daysAgo(3) }),
      mem({ id: "C", text: "c", turn_idx: 1, recurs_of: "A", created_at: daysAgo(1) }),
    ];
    // biome-ignore lint/suspicious/noExplicitAny: fixture
    const { seen } = collapseRecurrenceChains(rows as any, new Map([["A", 3]]));
    expect(seen.get("C")).toBe(3);
  });
});
