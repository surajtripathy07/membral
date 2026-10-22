import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { memoryRecall, memoryRecallWithStats } from "../recall";

const USER = "user-1";
const PROJECT_A = "proj-a";

function baseRecord(overrides: Partial<Row> & { id: string }): Row {
  return {
    user_id: USER,
    code_session_id: "sess-1",
    code_project_id: PROJECT_A,
    agent_id: null,
    source: "hook",
    kind: "outcome",
    text: "shipped the fix",
    quote: "shipped the fix",
    turn_idx: 0,
    turn_role: "assistant",
    ref: "https://github.com/acme/repo/pull/1",
    ref_kind: "pr",
    branch: "main",
    head_sha: null,
    thread: null,
    paths: ["src/a.ts"],
    verified: false,
    durable: true,
    observed_durable: false,
    recurrence_count: 1,
    scope: "project",
    confidence: 0.5,
    supersedes: null,
    retired_at: null,
    chat_conversation_id: null,
    created_at: "2026-09-10T00:00:00Z",
    ...overrides,
  };
}

function turnFor(row: Row) {
  return { session_id: row.code_session_id, idx: row.turn_idx, role: row.turn_role, text: row.text, props: {} };
}

describe("memoryRecall", () => {
  it("#436: hides an 8-day-old blocker (never retires it) and counts it", async () => {
    const rows = [
      baseRecord({ id: "old-blk", kind: "blocker", created_at: "2026-09-02T00:00:00Z" }),
      baseRecord({ id: "new-blk", kind: "blocker", created_at: "2026-09-09T00:00:00Z" }),
      baseRecord({ id: "old-dec", kind: "decision", created_at: "2026-08-01T00:00:00Z" }),
    ];
    const supabase = makeFakeSupabase({
      session_memories: rows,
      code_session_turns: rows.map(turnFor),
      code_projects: [],
      memory_branch_state: [],
      conversations: [],
    });
    const now = Date.parse("2026-09-10T00:00:00Z");
    const result = await memoryRecallWithStats(supabase, USER, null, { durable_only: false }, now);
    expect(result.records.map((r) => r.id).sort()).toEqual(["new-blk", "old-dec"]);
    expect(result.staleBlockersHidden).toBe(1);
  });

  it("matches by repo, not topic: returns outcomes for the project regardless of any text overlap", async () => {
    const rows = [baseRecord({ id: "shipped" })];
    const supabase = makeFakeSupabase({
      session_memories: rows,
      code_session_turns: rows.map(turnFor),
      code_projects: [{ id: PROJECT_A, user_id: USER, repo_identity: "github.com/acme/repo" }],
      memory_branch_state: [],
      conversations: [],
    });

    const result = await memoryRecall(supabase, USER, null, { repo: "github.com/acme/repo", kind: "outcome" });
    expect(result.map((r) => r.id)).toEqual(["shipped"]);
  });

  it("returns nothing for an unresolvable repo -- never falls back to 'recent' (rule 1)", async () => {
    const supabase = makeFakeSupabase({ session_memories: [baseRecord({ id: "shipped" })], code_projects: [] });
    const result = await memoryRecall(supabase, USER, null, { repo: "github.com/acme/does-not-exist" });
    expect(result).toEqual([]);
  });

  it("matches by path", async () => {
    const rows = [baseRecord({ id: "a", paths: ["src/a.ts"] }), baseRecord({ id: "b", paths: ["src/b.ts"] })];
    const supabase = makeFakeSupabase({
      session_memories: rows,
      code_session_turns: rows.map(turnFor),
      code_projects: [],
      memory_branch_state: [],
      conversations: [],
    });
    const result = await memoryRecall(supabase, USER, null, { path: "src/a.ts" });
    expect(result.map((r) => r.id)).toEqual(["a"]);
  });

  it("excludes a superseded record unless include_retired is set", async () => {
    const older = baseRecord({ id: "older", kind: "decision", quote: "old decision", text: "old decision" });
    const newer = baseRecord({
      id: "newer",
      kind: "decision",
      supersedes: "older",
      quote: "new decision",
      text: "new decision",
    });
    const supabase = makeFakeSupabase({
      session_memories: [older, newer],
      code_session_turns: [turnFor(older), turnFor(newer)],
      code_projects: [],
      memory_branch_state: [],
      conversations: [],
    });

    const withoutRetired = await memoryRecall(supabase, USER, null, { kind: "decision", durable_only: false });
    expect(withoutRetired.map((r) => r.id)).toEqual(["newer"]);

    const withRetired = await memoryRecall(supabase, USER, null, {
      kind: "decision",
      durable_only: false,
      include_retired: true,
    });
    expect(withRetired.map((r) => r.id).sort()).toEqual(["newer", "older"]);
  });

  it("durable_only defaults to true (session-scoped records never push/recall by default)", async () => {
    const durable = baseRecord({ id: "durable", kind: "learning", durable: true });
    const sessionScoped = baseRecord({ id: "session-scoped", kind: "learning", durable: false });
    const supabase = makeFakeSupabase({
      session_memories: [durable, sessionScoped],
      code_session_turns: [turnFor(durable), turnFor(sessionScoped)],
      code_projects: [],
      memory_branch_state: [],
      conversations: [],
    });
    const result = await memoryRecall(supabase, USER, null, { kind: "learning" });
    expect(result.map((r) => r.id)).toEqual(["durable"]);
  });

  it("excludes a superseded record even when the superseding row sits past PostgREST's 1000-row page cap (#165)", async () => {
    // 1,500 live "filler" rows each supersede a throwaway id, except the one
    // at index 1200 (i.e. beyond a naive 1000-row select), which supersedes
    // `old-record`. A single unpaginated select over `session_memories` only
    // ever sees the first PAGE_SIZE rows PostgREST hands back (simulated
    // below since the shared memory-flavour fake doesn't clamp by itself);
    // only a paginated read reaches row 1200 and excludes `old-record`.
    const PAGE_SIZE = 1000;
    const fillers = Array.from({ length: 1500 }, (_, i) =>
      baseRecord({
        id: `filler-${i}`,
        kind: "outcome",
        supersedes: i === 1200 ? "old-record" : `throwaway-${i}`,
      }),
    );
    const oldRecord = baseRecord({ id: "old-record", kind: "decision" });
    const rows = [...fillers, oldRecord];
    const supabase = makeFakeSupabase({
      session_memories: rows,
      code_session_turns: [turnFor(oldRecord)],
      code_projects: [],
      memory_branch_state: [],
      conversations: [],
    });

    // Simulate PostgREST's server-side row cap: a `session_memories` select
    // that never calls `.range()`/`.limit()` only ever gets the first
    // PAGE_SIZE matching rows, in table order -- exactly what the real
    // service does regardless of client intent.
    const realFrom = supabase.from.bind(supabase);
    supabase.from = ((table: string) => {
      const builder = realFrom(table);
      if (table !== "session_memories") return builder;
      let bounded = false;
      const proxy: unknown = new Proxy(builder, {
        get(target, prop, receiver) {
          if (prop === "range" || prop === "limit" || prop === "single" || prop === "maybeSingle") bounded = true;
          if (prop === "then") {
            return (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
              target.then((result: { data: unknown[] | null; error: unknown }) => {
                const clamped =
                  !bounded && Array.isArray(result.data) && result.data.length > PAGE_SIZE
                    ? { ...result, data: result.data.slice(0, PAGE_SIZE) }
                    : result;
                return onFulfilled ? onFulfilled(clamped) : clamped;
              }, onRejected);
          }
          const orig = (target as Record<string, unknown>)[prop as string];
          if (typeof orig !== "function") return orig;
          return (...args: unknown[]) => {
            const result = (orig as (...a: unknown[]) => unknown).apply(target, args);
            return result === target ? receiver : result;
          };
        },
      });
      return proxy;
    }) as typeof supabase.from;

    const result = await memoryRecall(supabase, USER, null, { kind: "decision", durable_only: false });
    expect(result.map((r) => r.id)).toEqual([]);
  });

  it("writes one memory_recall_events row with tool='memory_recall'", async () => {
    const rows = [baseRecord({ id: "shipped" })];
    const inserted: Row[] = [];
    const supabase = makeFakeSupabase(
      {
        session_memories: rows,
        code_session_turns: rows.map(turnFor),
        code_projects: [],
        memory_branch_state: [],
        conversations: [],
      },
      { onInsert: (table, row) => table === "memory_recall_events" && inserted.push(row) },
    );
    await memoryRecall(supabase, USER, null, {});
    expect(inserted).toHaveLength(1);
    expect(inserted[0].tool).toBe("memory_recall");
  });
});
