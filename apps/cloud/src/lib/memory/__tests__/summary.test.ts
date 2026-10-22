import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { sessionSummary } from "../summary";

const USER = "user-1";
const PROJECT_A = "proj-a";

function session(overrides: Partial<Row> & { id: string }): Row {
  return {
    user_id: USER,
    code_project_id: PROJECT_A,
    git_branch: "main",
    model: "claude-sonnet-5",
    started_at: "2026-09-10T00:00:00Z",
    ended_at: "2026-09-10T01:00:00Z",
    duration_seconds: 3600,
    turn_count: 10,
    user_turn_count: 4,
    tool_count: 6,
    files_touched: ["src/auth.ts", "src/routes.ts"],
    props: {},
    ...overrides,
  };
}

function record(overrides: Partial<Row> & { id: string }): Row {
  return {
    user_id: USER,
    code_session_id: "sess-1",
    code_project_id: PROJECT_A,
    agent_id: null,
    source: "hook",
    kind: "decision",
    text: "decided X",
    quote: "decided X",
    turn_idx: 0,
    turn_role: "assistant",
    ref: null,
    ref_kind: null,
    branch: "main",
    head_sha: null,
    thread: null,
    paths: [],
    verified: false,
    durable: true,
    observed_durable: false,
    recurrence_count: 1,
    scope: "project",
    confidence: 0.5,
    supersedes: null,
    retired_at: null,
    chat_conversation_id: null,
    created_at: "2026-09-10T00:10:00Z",
    ...overrides,
  };
}

describe("sessionSummary", () => {
  it("returns the session header from code_sessions", async () => {
    const supabase = makeFakeSupabase({
      code_sessions: [session({ id: "sess-1" })],
      code_projects: [{ id: PROJECT_A, display_name: "acme/repo", repo_identity: "github.com/acme/repo" }],
      session_memories: [],
      code_session_turns: [],
    });

    const result = await sessionSummary(supabase, USER, null, { session_id: "sess-1" });
    expect(result?.header).toMatchObject({
      id: "sess-1",
      repo: "acme/repo",
      branch: "main",
      turn_count: 10,
      user_turn_count: 4,
      tool_count: 6,
    });
  });

  it("computes header.cost_usd from code_sessions.props.usage via price-table.ts (2026-09-13 spend-attribution leg)", async () => {
    const supabase = makeFakeSupabase({
      code_sessions: [
        session({
          id: "sess-1",
          model: "claude-sonnet-5",
          props: {
            usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          },
        }),
      ],
      code_projects: [],
      session_memories: [],
      code_session_turns: [],
    });
    const result = await sessionSummary(supabase, USER, null, { session_id: "sess-1" });
    // Sonnet 5 (price table v4): $2/Mtok in, $10/Mtok out -> 100*2e-6 + 50*10e-6 = 0.0007
    expect(result?.header.cost_usd).toBeCloseTo(0.0007, 6);
  });

  it("returns header.cost_usd null when props.usage is missing (never throws, never fabricates)", async () => {
    const supabase = makeFakeSupabase({
      code_sessions: [session({ id: "sess-1", props: {} })],
      code_projects: [],
      session_memories: [],
      code_session_turns: [],
    });
    const result = await sessionSummary(supabase, USER, null, { session_id: "sess-1" });
    expect(result?.header.cost_usd).toBeNull();
  });

  it("#436: leaves out a blocker older than 7 days, keeps a fresh one", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-15T00:00:00Z"));
    try {
      const supabase = makeFakeSupabase({
        code_sessions: [session({ id: "sess-1" })],
        code_projects: [],
        session_memories: [
          record({ id: "old-blk", kind: "blocker", turn_idx: 0, text: "old", created_at: "2026-09-01T00:00:00Z" }),
          record({ id: "new-blk", kind: "blocker", turn_idx: 1, text: "new", created_at: "2026-09-12T00:00:00Z" }),
        ],
        code_session_turns: [],
      });
      const result = await sessionSummary(supabase, USER, null, { session_id: "sess-1" });
      expect((result?.journey ?? []).flatMap((j) => j.records).map((r) => r.id)).toEqual(["new-blk"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("attaches the session's cost_usd to outcome records alongside their ref, but not to other kinds", async () => {
    const outcome = record({
      id: "shipped",
      kind: "outcome",
      turn_idx: 0,
      ref: "pr-1",
      text: "shipped the fix",
      quote: "shipped the fix",
    });
    const decision = record({
      id: "dec",
      kind: "decision",
      turn_idx: 1,
      text: "chose postgres",
      quote: "chose postgres",
    });
    const supabase = makeFakeSupabase({
      code_sessions: [
        session({
          id: "sess-1",
          model: "claude-sonnet-5",
          props: {
            usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
          },
        }),
      ],
      code_projects: [],
      session_memories: [outcome, decision],
      code_session_turns: [
        { session_id: "sess-1", idx: 0, text: "shipped the fix", props: { inputDigest: "pr-1" }, file_path: null },
        { session_id: "sess-1", idx: 1, text: "chose postgres", props: {}, file_path: null },
      ],
    });
    const result = await sessionSummary(supabase, USER, null, { session_id: "sess-1" });
    const allRecords = (result?.journey ?? []).flatMap((j) => j.records);
    const outcomeRecord = allRecords.find((r) => r.id === "shipped");
    const decisionRecord = allRecords.find((r) => r.id === "dec");
    expect(outcomeRecord?.cost_usd).toBeCloseTo(0.0007, 6);
    expect(outcomeRecord?.ref).toBe("pr-1");
    expect(decisionRecord?.cost_usd).toBeUndefined();
  });

  it("returns null for a session outside a code-scoped key's bound (no existence leak)", async () => {
    const supabase = makeFakeSupabase({
      code_sessions: [session({ id: "sess-1", code_project_id: "other-project" })],
      code_projects: [],
      session_memories: [],
      code_session_turns: [],
    });
    const result = await sessionSummary(supabase, USER, PROJECT_A, { session_id: "sess-1" });
    expect(result).toBeNull();
  });

  it("last:true picks the newest session for the user (optionally narrowed by repo)", async () => {
    const supabase = makeFakeSupabase({
      code_sessions: [
        session({ id: "old", started_at: "2026-09-01T00:00:00Z" }),
        session({ id: "new", started_at: "2026-09-12T00:00:00Z" }),
      ],
      code_projects: [],
      session_memories: [],
      code_session_turns: [],
    });
    const result = await sessionSummary(supabase, USER, null, { last: true });
    expect(result?.header.id).toBe("new");
  });

  it("groups records into threads ordered by first turn, with turn range and files touched in range; threadless records land in a trailing unsorted group", async () => {
    // #436: the threadless record is a blocker; "now" sits inside its 7-day window.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const authDecision = record({
      id: "auth-dec",
      thread: "wire up auth",
      turn_idx: 1,
      kind: "decision",
      text: "use JWT",
      quote: "use JWT",
    });
    const authOutcome = record({
      id: "auth-out",
      thread: "wire up auth",
      turn_idx: 3,
      kind: "outcome",
      ref: "pr-1",
      text: "shipped auth",
      quote: "shipped auth",
    });
    const routesLearning = record({
      id: "routes-learn",
      thread: "add routes",
      turn_idx: 6,
      kind: "learning",
      text: "routes need auth guard",
      quote: "routes need auth guard",
    });
    const orphan = record({
      id: "orphan",
      thread: null,
      turn_idx: 9,
      kind: "blocker",
      text: "flaky test",
      quote: "flaky test",
    });

    const supabase = makeFakeSupabase({
      code_sessions: [session({ id: "sess-1" })],
      code_projects: [],
      session_memories: [authDecision, authOutcome, routesLearning, orphan],
      code_session_turns: [
        { session_id: "sess-1", idx: 1, text: "use JWT", props: {}, file_path: null },
        { session_id: "sess-1", idx: 2, text: "editing", props: {}, file_path: "src/auth.ts" },
        { session_id: "sess-1", idx: 3, text: "shipped auth", props: { inputDigest: "pr-1" }, file_path: null },
        { session_id: "sess-1", idx: 6, text: "routes need auth guard", props: {}, file_path: "src/routes.ts" },
        { session_id: "sess-1", idx: 9, text: "flaky test", props: {}, file_path: null },
      ],
    });

    const result = await sessionSummary(supabase, USER, null, { session_id: "sess-1" });
    expect(result).not.toBeNull();
    const journey = result?.journey ?? [];

    // Two named threads first (first-turn order), then the trailing unsorted group.
    expect(journey.map((j) => j.thread)).toEqual(["wire up auth", "add routes", null]);

    const authThread = journey[0];
    expect(authThread.turn_range).toEqual([1, 3]);
    expect(authThread.files_touched).toEqual(["src/auth.ts"]);
    // outcomes-first within a thread's records.
    expect(authThread.records.map((r) => r.id)).toEqual(["auth-out", "auth-dec"]);

    const routesThread = journey[1];
    expect(routesThread.turn_range).toEqual([6, 6]);
    expect(routesThread.files_touched).toEqual(["src/routes.ts"]);

    const unsorted = journey[2];
    expect(unsorted.turn_range).toBeNull();
    expect(unsorted.records.map((r) => r.id)).toEqual(["orphan"]);
  });

  it("excludes a record superseded by another live record of the session", async () => {
    const older = record({ id: "older", kind: "decision", turn_idx: 0, text: "old call", quote: "old call" });
    const newer = record({
      id: "newer",
      kind: "decision",
      turn_idx: 1,
      supersedes: "older",
      text: "new call",
      quote: "new call",
    });
    const supabase = makeFakeSupabase({
      code_sessions: [session({ id: "sess-1" })],
      code_projects: [],
      session_memories: [older, newer],
      code_session_turns: [
        { session_id: "sess-1", idx: 0, text: "old call", props: {}, file_path: null },
        { session_id: "sess-1", idx: 1, text: "new call", props: {}, file_path: null },
      ],
    });
    const result = await sessionSummary(supabase, USER, null, { session_id: "sess-1" });
    const allIds = (result?.journey ?? []).flatMap((j) => j.records.map((r) => r.id));
    expect(allIds).toEqual(["newer"]);
  });

  it("writes a memory_recall_events row with the resolved code_session_id", async () => {
    const inserted: Row[] = [];
    const supabase = makeFakeSupabase(
      {
        code_sessions: [session({ id: "sess-1" })],
        code_projects: [],
        session_memories: [],
        code_session_turns: [],
      },
      { onInsert: (table, row) => table === "memory_recall_events" && inserted.push(row) },
    );
    await sessionSummary(supabase, USER, null, { session_id: "sess-1" });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ tool: "session_summary", code_session_id: "sess-1" });
  });
});
