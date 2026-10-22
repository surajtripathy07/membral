import { describe, expect, it } from "vitest";
import { computeCost } from "@/lib/code-sessions/price-table";
import {
  deriveUserStats,
  estimateSessionCost,
  formatStatsLine,
  statsLines,
  type UserStatsRow,
  type UserStatsSessionRow,
  type UserStatsTurnRow,
} from "../user-stats";

const DAY = "2026-09-25";
const USAGE = { inputTokens: 200_000, outputTokens: 20_000, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };

function session(over: Partial<UserStatsSessionRow> & { id: string }): UserStatsSessionRow {
  return {
    user_id: "u1",
    code_project_id: "p1",
    parent_source_session_id: null,
    started_at: `${DAY}T09:00:00Z`,
    ended_at: `${DAY}T09:30:00Z`,
    duration_seconds: 1800,
    turn_count: 10,
    user_turn_count: 3,
    tool_count: 4,
    model: "claude-sonnet-4-5",
    props: { usage: USAGE, models: ["claude-sonnet-4-5"] },
    ...over,
  };
}

function toolUse(session_id: string, tool_name: string, over: Partial<UserStatsTurnRow> = {}): UserStatsTurnRow {
  return { session_id, role: "assistant", kind: "tool_use", tool_name, file_path: null, props: {}, ...over };
}

describe("deriveUserStats", () => {
  it("a day with two sessions and one MCP call yields one row with both sessions, the est. cost, tool and MCP counts", () => {
    const s1 = session({ id: "s1", started_at: `${DAY}T09:00:00Z`, duration_seconds: 1800 });
    const s2 = session({
      id: "s2",
      code_project_id: "p2",
      started_at: `${DAY}T14:10:00Z`,
      ended_at: `${DAY}T15:10:00Z`,
      duration_seconds: 3600,
      turn_count: 20,
      user_turn_count: 5,
    });
    const turns: UserStatsTurnRow[] = [
      toolUse("s1", "Read"),
      toolUse("s1", "Edit", { file_path: "src/a.ts" }),
      toolUse("s1", "Edit", { file_path: "src/a.ts" }),
      toolUse("s1", "Bash", { props: { action: { verb: "committed", sha: "d7e5977" } } }),
      toolUse("s2", "Edit", { file_path: "src/b.ts" }),
      toolUse("s2", "Bash", { props: { inputDigest: "npm test" } }),
      toolUse("s2", "Bash", { props: { inputDigest: "git commit -m 'x'" } }),
      { session_id: "s2", role: "user", kind: "prose", tool_name: null, file_path: null, props: {} },
    ];
    const rows = deriveUserStats({
      day: DAY,
      sessions: [s1, s2],
      turns,
      issues: [
        { session_id: "s1", ref: "codehub/app#12", role: "worked_on" },
        { session_id: "s2", ref: "codehub/app#12", role: "referenced" },
        { session_id: "s2", ref: "codehub/app!7", role: "worked_on" },
      ],
      mcpCalls: [{ user_id: "u1", tool: "memory_search", ok: true }],
      projects: [
        { id: "p1", repo_identity: "codehub/app", display_name: null },
        { id: "p2", repo_identity: "codehub/other", display_name: "Other" },
      ],
      firstSessionAt: { u1: "2026-08-01T10:00:00Z" },
    });

    expect(rows).toHaveLength(1);
    const row = rows[0];
    const perSession = computeCost(USAGE, "claude-sonnet-4-5")?.amount ?? 0;
    expect(perSession).toBeGreaterThan(0);
    expect(row).toMatchObject({
      user_id: "u1",
      day: DAY,
      sessions: 2,
      sub_agent_sessions: 0,
      turns: 30,
      user_turns: 8,
      tool_calls: 7,
      edits: 3,
      reads: 1,
      tests: 1,
      commits: 2,
      pushes: 0,
      verb_counts: { committed: 1 },
      refs: 2,
      ref_counts: { worked_on: 2, referenced: 1 },
      tool_counts: { Read: 1, Edit: 3, Bash: 3 },
      mcp_calls: 1,
      mcp_errors: 0,
      mcp_tool_counts: { memory_search: 1 },
      longest_session_seconds: 3600,
      longest_session_id: "s2",
      most_edited_file: "src/a.ts",
      start_hour: 9,
      first_session_at: "2026-08-01T10:00:00Z",
    });
    expect(row.cost_usd).toBeCloseTo(perSession * 2, 6);
    // Tie on session count (1 each) keeps the first-seen repo.
    expect(row.busiest_repo).toBe("codehub/app");
  });

  it("a day with no sessions writes nothing, even when MCP calls exist", () => {
    const rows = deriveUserStats({
      day: DAY,
      sessions: [],
      turns: [],
      issues: [],
      mcpCalls: [{ user_id: "u1", tool: "memory_search", ok: true }],
    });
    expect(rows).toEqual([]);
  });

  it("a sub-agent session folds into its parent's row and does not create a row on its own", () => {
    const parent = session({ id: "s1" });
    const child = session({ id: "c1", parent_source_session_id: "src-1", turn_count: 6, user_turn_count: 1 });
    const orphanChild = session({ id: "c2", user_id: "u2", parent_source_session_id: "src-9" });
    const rows = deriveUserStats({
      day: DAY,
      sessions: [parent, child, orphanChild],
      turns: [toolUse("c1", "Edit", { file_path: "src/z.ts" })],
      issues: [],
      mcpCalls: [],
    });
    expect(rows.map((r) => r.user_id)).toEqual(["u1"]);
    expect(rows[0]).toMatchObject({
      sessions: 1,
      sub_agent_sessions: 1,
      turns: 16,
      edits: 1,
      most_edited_file: "src/z.ts",
    });
  });

  it("malformed props never throw and count as absent (B12)", () => {
    const s = session({ id: "s1", props: { usage: "nope", subAgents: 3, models: null } });
    const rows = deriveUserStats({
      day: DAY,
      sessions: [s],
      turns: [toolUse("s1", "Bash", { props: { action: { verb: 42 } } }), toolUse("s1", "Bash", { props: null })],
      issues: [],
      mcpCalls: [],
    });
    expect(rows[0]).toMatchObject({ cost_usd: 0, tool_calls: 2, verb_counts: {}, commits: 0 });
  });

  it("estimateSessionCost prices non-fork sub-agent runs at their own model and skips forks", () => {
    const base = computeCost(USAGE, "claude-sonnet-4-5")?.amount ?? 0;
    const sub = computeCost(USAGE, "claude-haiku-4-5")?.amount ?? 0;
    const cost = estimateSessionCost({
      model: "claude-sonnet-4-5",
      props: {
        usage: USAGE,
        subAgents: [
          { model: "claude-haiku-4-5", usage: USAGE },
          { model: "claude-opus-4-1", usage: USAGE, isFork: true },
        ],
      },
    });
    expect(cost).toBeCloseTo(base + sub, 6);
  });
});

describe("formatStatsLine", () => {
  const row: UserStatsRow = {
    user_id: "u1",
    day: DAY,
    sessions: 2,
    sub_agent_sessions: 0,
    turns: 30,
    user_turns: 8,
    tool_calls: 7,
    cost_usd: 1.2345,
    edits: 3,
    reads: 1,
    tests: 1,
    commits: 2,
    pushes: 0,
    verb_counts: {},
    refs: 2,
    ref_counts: {},
    tool_counts: {},
    mcp_calls: 1,
    mcp_errors: 0,
    mcp_tool_counts: {},
    longest_session_seconds: 3600,
    longest_session_id: "s2",
    busiest_repo: "codehub/app",
    most_edited_file: "src/a.ts",
    start_hour: 9,
    first_session_at: "2026-08-01T10:00:00Z",
  };

  it("lists every fact the row can say, cost labelled est.", () => {
    expect(statsLines(row)).toEqual([
      "2 sessions on 2026-09-25 · $1.23 est.",
      "Longest session on 2026-09-25: 1h",
      "Busiest repo on 2026-09-25: codehub/app",
      "Most-edited file on 2026-09-25: src/a.ts",
      "2 commits seen on 2026-09-25",
      "Started around 09:00 UTC on 2026-09-25",
      "1 Membral lookup on 2026-09-25",
      "First session: 2026-08-01",
    ]);
  });

  it("rotates by seed and is deterministic for the same seed", () => {
    expect(formatStatsLine(row, 0)).toBe("2 sessions on 2026-09-25 · $1.23 est.");
    expect(formatStatsLine(row, 1)).toBe("Longest session on 2026-09-25: 1h");
    expect(formatStatsLine(row, 9)).toBe("Longest session on 2026-09-25: 1h");
    expect(formatStatsLine(row)).toBe(formatStatsLine(row));
  });

  it("an almost-empty row still yields its session count and no cost", () => {
    const bare: UserStatsRow = {
      ...row,
      sessions: 1,
      cost_usd: 0,
      commits: 0,
      mcp_calls: 0,
      longest_session_seconds: null,
      busiest_repo: null,
      most_edited_file: null,
      start_hour: null,
      first_session_at: `${DAY}T09:00:00Z`,
    };
    expect(statsLines(bare)).toEqual(["1 session on 2026-09-25"]);
    expect(formatStatsLine(bare, 5)).toBe("1 session on 2026-09-25");
  });
});
