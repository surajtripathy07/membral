// step2d finding 11 (docs/goals/2026-09-13_memory-v1-build_goal.md; issue
// #151): tail-capture.ts owns the checkpoint arithmetic, the user-scoping of
// every read/write, the force/retire ordering, the lease lock, the props
// stamp, and the no-prose skip — this file exercises all of it against the
// shared fake-supabase.ts double + a real LlmClient over a fake OpenAILike
// transport (same pattern as extract.test.ts/embed.test.ts).

import { createFakeDb, makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { planReverifyUpdate } from "@/lib/memory/write";
import { fetchBranchLineage, runTailCaptureForSession, USER_PASS_MAX_ATTEMPTS } from "../tail-capture";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

// step2e finding 4: a "decision"/"blocker"/"learning" quote must be >= 8
// words or >= 40 chars AND share a content token with `text` — this fixture
// satisfies both (shares "dark"/"mode"/"theme"/"default").
const DECISION_RECORD = {
  kind: "learning",
  text: "Dark mode is now the default theme",
  quote: "Dark mode is now the default theme across the whole app.",
  turn_idx: 1,
  turn_role: "assistant",
  durable: true,
  thread: "dark mode default",
};

function makeLlm(opts: { chatBody?: unknown } = {}) {
  const chatCreate = vi.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ records: [opts.chatBody ?? DECISION_RECORD] }) } }],
    usage: { prompt_tokens: 50, completion_tokens: 20 },
  });
  const embedCreate = vi.fn().mockImplementation((body: { input: string | string[] }) => {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return Promise.resolve({ data: inputs.map(() => ({ embedding: [1, 0, 0] })), usage: { prompt_tokens: 5 } });
  });
  const client: OpenAILike = { chat: { completions: { create: chatCreate } }, embeddings: { create: embedCreate } };
  const llm = new LlmClient(CONFIG, { client });
  return { llm, chatCreate, embedCreate };
}

function sessionRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "s1",
    user_id: "u1",
    code_project_id: "p1",
    source: "claude-code",
    git_branch: "main",
    model: "claude-sonnet-5",
    started_at: "2026-09-01T00:00:00Z",
    ended_at: "2026-09-01T00:10:00Z",
    duration_seconds: 600,
    files_touched: [],
    props: {},
    cwd: "/repo",
    code_projects: { display_name: "Test Repo" },
    ...overrides,
  };
}

function turnRow(overrides: Partial<Row> & Pick<Row, "idx" | "role" | "kind">): Row {
  return {
    session_id: "s1",
    user_id: "u1",
    text: null,
    tool_name: null,
    file_path: null,
    ts: null,
    props: {},
    ...overrides,
  };
}

const TWO_TURNS: Row[] = [
  turnRow({ idx: 0, role: "user", kind: "prose", text: "please add dark mode" }),
  turnRow({
    idx: 1,
    role: "assistant",
    kind: "prose",
    text: "Dark mode is now the default theme across the whole app.",
  }),
];

describe("runTailCaptureForSession (step2d finding 11)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("checkpoint null: processes the WHOLE session and advances the checkpoint to the last covered idx (finding 6)", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: [...TWO_TURNS], session_memories: [] as Row[] };
    const supabase = makeFakeSupabase(rows);
    const { llm, chatCreate } = makeLlm();

    const summary = await runTailCaptureForSession({ supabase, llm }, "u1", "s1", { runId: "r1" });

    expect(chatCreate).toHaveBeenCalledTimes(2); // extraction window + D3 C2 user-turn pass (its decision reply is dropped: user pass keeps preference/blocker only)
    expect(summary.recordsWritten).toBe(1);
    expect(rows.session_memories).toHaveLength(1);
    expect(rows.session_memories[0].verified).toBe(true);
    expect(rows.code_sessions[0].props.memory_checkpoint_turn_idx).toBe(1);
    expect(rows.code_sessions[0].props.memory_extraction_lock).toBeUndefined(); // released
  });

  it("checkpoint set: only the TAIL (idx > checkpoint) is windowed/extracted", async () => {
    const rows = {
      code_sessions: [sessionRow({ props: { memory_checkpoint_turn_idx: 0 } })],
      code_session_turns: [...TWO_TURNS],
      session_memories: [] as Row[],
    };
    const supabase = makeFakeSupabase(rows);
    const { llm } = makeLlm();

    const summary = await runTailCaptureForSession({ supabase, llm }, "u1", "s1", { runId: "r1" });

    expect(summary.tailTurnsExtracted).toBe(1); // only idx 1
    expect(rows.code_sessions[0].props.memory_checkpoint_turn_idx).toBe(1);
  });

  it("no-op (no props touched) when the checkpoint already covers every turn", async () => {
    const rows = {
      code_sessions: [sessionRow({ props: { memory_checkpoint_turn_idx: 1 } })],
      code_session_turns: [...TWO_TURNS],
      session_memories: [] as Row[],
    };
    const supabase = makeFakeSupabase(rows);
    const { llm, chatCreate } = makeLlm();

    const summary = await runTailCaptureForSession({ supabase, llm }, "u1", "s1", { runId: "r1" });

    expect(summary.skipped).toBe(true);
    expect(chatCreate).not.toHaveBeenCalled();
    expect(rows.code_sessions[0].props.memory_checkpoint_turn_idx).toBe(1); // untouched, not re-stamped
  });

  it("lease lock (finding 3): a fresh lock skips the run entirely, no LLM call, lock left untouched", async () => {
    const lock = { at: new Date().toISOString(), run_id: "other-run" };
    const rows = {
      code_sessions: [sessionRow({ props: { memory_extraction_lock: lock } })],
      code_session_turns: [...TWO_TURNS],
      session_memories: [] as Row[],
    };
    const supabase = makeFakeSupabase(rows);
    const { llm, chatCreate } = makeLlm();

    const summary = await runTailCaptureForSession({ supabase, llm }, "u1", "s1", { runId: "r1" });

    expect(summary.skipped).toBe(true);
    expect(summary.lockHeld).toBe(true); // P10 re-review N1: the queue releases, never marks done
    expect(chatCreate).not.toHaveBeenCalled();
    expect(rows.session_memories).toHaveLength(0);
    expect(rows.code_sessions[0].props.memory_extraction_lock).toEqual(lock); // untouched
  });

  it("lease lock (finding 3): a STALE lock (>15min old) is taken over and the run proceeds normally", async () => {
    const staleAt = new Date(Date.now() - 16 * 60 * 1000).toISOString();
    const rows = {
      code_sessions: [sessionRow({ props: { memory_extraction_lock: { at: staleAt, run_id: "dead-run" } } })],
      code_session_turns: [...TWO_TURNS],
      session_memories: [] as Row[],
    };
    const supabase = makeFakeSupabase(rows);
    const { llm, chatCreate } = makeLlm();

    const summary = await runTailCaptureForSession({ supabase, llm }, "u1", "s1", { runId: "r1" });

    expect(summary.skipped).toBe(false);
    expect(chatCreate).toHaveBeenCalledTimes(2); // extraction window + D3 C2 user-turn pass (its decision reply is dropped: user pass keeps preference/blocker only)
    expect(rows.code_sessions[0].props.memory_extraction_lock).toBeUndefined(); // released at the end
  });

  it("lock release: a returned failure (every window replies non-JSON) still clears this run's lock", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: [...TWO_TURNS], session_memories: [] as Row[] };
    const supabase = makeFakeSupabase(rows);
    const chatCreate = vi.fn().mockResolvedValue({
      choices: [{ message: { content: "sorry, I cannot produce that" } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });
    const embedCreate = vi.fn();
    const llm = new LlmClient(CONFIG, {
      client: { chat: { completions: { create: chatCreate } }, embeddings: { create: embedCreate } },
    });

    const summary = await runTailCaptureForSession({ supabase, llm }, "u1", "s1", { runId: "r1" });

    expect(summary.windowsFailed).toBeGreaterThan(0);
    expect(rows.code_sessions[0].props.memory_extraction_lock).toBeUndefined();
  });

  it("lock release: a THROW after the lock was taken clears this run's lock and rethrows, so the next kick is not session_locked", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: [...TWO_TURNS], session_memories: [] as Row[] };
    const supabase = makeFakeSupabase(rows);
    let armed = false;
    const chatCreate = vi.fn().mockImplementation(async () => {
      armed = true; // the lock is already held here (the lease phase ran before any LLM call)
      return {
        choices: [{ message: { content: JSON.stringify({ records: [DECISION_RECORD] }) } }],
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      };
    });
    const embedCreate = vi.fn().mockResolvedValue({ data: [{ embedding: [1, 0, 0] }], usage: { prompt_tokens: 5 } });
    const llm = new LlmClient(CONFIG, {
      client: { chat: { completions: { create: chatCreate } }, embeddings: { create: embedCreate } },
    });
    const realFrom = supabase.from.bind(supabase);
    supabase.from = ((table: string) => {
      if (armed && table === "session_memories") throw new Error("db down");
      return realFrom(table);
    }) as typeof supabase.from;

    await expect(runTailCaptureForSession({ supabase, llm }, "u1", "s1", { runId: "r1" })).rejects.toThrow("db down");
    expect(chatCreate).toHaveBeenCalled();
    expect(rows.code_sessions[0].props.memory_extraction_lock).toBeUndefined();

    // Another run's lock is never removed by the failing run's release (compare-and-delete on run_id).
    const other = { at: new Date().toISOString(), run_id: "other-run" };
    rows.code_sessions[0].props = { memory_extraction_lock: other };
    const again = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s1", {
      runId: "r2",
    });
    expect(again.lockHeld).toBe(true);
    expect(rows.code_sessions[0].props.memory_extraction_lock).toEqual(other);
  });

  it("G2 2.3b lease phase: a session with no turns at all is stamped once, never locked, no LLM call", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: [] as Row[], session_memories: [] as Row[] };
    const supabase = makeFakeSupabase(rows);
    const { llm, chatCreate } = makeLlm();

    const summary = await runTailCaptureForSession({ supabase, llm }, "u1", "s1", { runId: "r1" });

    expect(summary.skipped).toBe(false);
    expect(summary.lockHeld).toBeFalsy();
    expect(chatCreate).not.toHaveBeenCalled();
    expect(rows.code_sessions[0].props.memory_extraction.windows_total).toBe(0);
    expect(rows.code_sessions[0].props.memory_extraction.run_id).toBe("r1");
    expect(rows.code_sessions[0].props.memory_extraction_lock).toBeUndefined();
    expect(rows.code_sessions[0].props.memory_checkpoint_turn_idx ?? null).toBeNull(); // no turns: nothing to cover
  });

  it("force ordering (finding 7): retires the SPECIFIC prior live rows only AFTER the new rows are inserted, never the rows just written", async () => {
    const priorRow: Row = {
      id: "old-1",
      user_id: "u1",
      code_session_id: "s1",
      code_project_id: "p1",
      source: "extractor",
      kind: "decision",
      retired_at: null,
      embedding: "[0,1,0]",
    };
    const rows = {
      code_sessions: [
        sessionRow({
          props: {
            memory_checkpoint_turn_idx: 1, // fully covered under a normal run — force must ignore this
            memory_extraction: { prompt_version: "memory-extract-v-old", records: 1 },
          },
        }),
      ],
      code_session_turns: [...TWO_TURNS],
      session_memories: [priorRow],
    };
    const supabase = makeFakeSupabase(rows);
    const { llm } = makeLlm();

    const summary = await runTailCaptureForSession({ supabase, llm }, "u1", "s1", { runId: "r1", force: true });

    expect(summary.recordsWritten).toBe(1);
    const newRow = rows.session_memories.find((r) => r.id !== "old-1");
    expect(newRow).toBeDefined();
    expect(newRow?.retired_at).toBeFalsy(); // the just-written row stays live
    expect(priorRow.retired_at).toBeTruthy(); // the prior version is retired
    expect(rows.code_sessions[0].props.memory_extraction.previous).toMatchObject({
      prompt_version: "memory-extract-v-old",
      records: 1,
    });
  });

  it("no-prose skip (finding 17): a tail with zero prose turns makes no LLM call and is stamped skipped:'no_prose'", async () => {
    const toolOnlyTurns: Row[] = [
      turnRow({ idx: 0, role: "assistant", kind: "tool_use", tool_name: "Bash" }),
      turnRow({ idx: 1, role: "assistant", kind: "tool_result", text: "ok" }),
    ];
    const rows = {
      code_sessions: [sessionRow()],
      code_session_turns: toolOnlyTurns,
      session_memories: [] as Row[],
    };
    const supabase = makeFakeSupabase(rows);
    const { llm, chatCreate } = makeLlm();

    const summary = await runTailCaptureForSession({ supabase, llm }, "u1", "s1", { runId: "r1" });

    expect(chatCreate).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(false); // considered, just yielded nothing
    expect(rows.code_sessions[0].props.memory_extraction.skipped).toBe("no_prose");
    expect(rows.code_sessions[0].props.memory_checkpoint_turn_idx).toBe(1);
  });

  it("G2 2.3a now seam: a frozen deps.now stamps props.memory_extraction.at on every write path", async () => {
    const frozen = new Date("2026-01-02T03:04:05.000Z");
    const now = vi.fn(() => frozen);
    const { llm } = makeLlm();

    // full run
    const full = { code_sessions: [sessionRow()], code_session_turns: [...TWO_TURNS], session_memories: [] as Row[] };
    await runTailCaptureForSession({ supabase: makeFakeSupabase(full), llm, now }, "u1", "s1", { runId: "r1" });
    expect(full.code_sessions[0].props.memory_extraction.at).toBe(frozen.toISOString());

    // no-prose skip
    const noProse = {
      code_sessions: [sessionRow()],
      code_session_turns: [turnRow({ idx: 0, role: "assistant", kind: "tool_use", tool_name: "Bash" })],
      session_memories: [] as Row[],
    };
    await runTailCaptureForSession({ supabase: makeFakeSupabase(noProse), llm, now }, "u1", "s1", { runId: "r1" });
    expect(noProse.code_sessions[0].props.memory_extraction.at).toBe(frozen.toISOString());

    // empty session
    const empty = { code_sessions: [sessionRow()], code_session_turns: [] as Row[], session_memories: [] as Row[] };
    await runTailCaptureForSession({ supabase: makeFakeSupabase(empty), llm, now }, "u1", "s1", { runId: "r1" });
    expect(empty.code_sessions[0].props.memory_extraction.at).toBe(frozen.toISOString());

    expect(now).toHaveBeenCalledTimes(3);
  });

  it("G2 2.3a newId seam: accepted on deps; the run mints no ids today, so a fixed newId is never called and the output is unchanged", async () => {
    const newId = vi.fn(() => "fixed-id");
    const withSeam = {
      code_sessions: [sessionRow()],
      code_session_turns: [...TWO_TURNS],
      session_memories: [] as Row[],
    };
    const without = {
      code_sessions: [sessionRow()],
      code_session_turns: [...TWO_TURNS],
      session_memories: [] as Row[],
    };
    const now = () => new Date("2026-01-02T03:04:05.000Z");

    await runTailCaptureForSession(
      { supabase: makeFakeSupabase(withSeam), llm: makeLlm().llm, now, newId },
      "u1",
      "s1",
      { runId: "r1" },
    );
    await runTailCaptureForSession({ supabase: makeFakeSupabase(without), llm: makeLlm().llm, now }, "u1", "s1", {
      runId: "r1",
    });

    expect(newId).not.toHaveBeenCalled();
    expect(withSeam.code_sessions[0].props.memory_extraction).toEqual(without.code_sessions[0].props.memory_extraction);
    const shape = (r: Row) => ({ kind: r.kind, durable: r.durable, verified: r.verified });
    expect(withSeam.session_memories).toHaveLength(1);
    expect(withSeam.session_memories.map(shape)).toEqual(without.session_memories.map(shape));
  });

  it("review followup (test-add): an empty-session run, which takes the rederive path, mints its lock id from deps.newId", async () => {
    const newId = vi.fn(() => "stub-rederive-id");
    const empty = { code_sessions: [sessionRow()], code_session_turns: [] as Row[], session_memories: [] as Row[] };
    const summary = await runTailCaptureForSession(
      { supabase: makeFakeSupabase(empty), llm: makeLlm().llm, newId },
      "u1",
      "s1",
      { runId: "r1" },
    );
    expect(summary.issuesRederived).toBeUndefined();
    expect(newId).toHaveBeenCalledTimes(1);
  });

  it("user scoping: turns belonging to a DIFFERENT user on the same session_id are never read (finding 14)", async () => {
    const otherUserTurn = turnRow({ idx: 5, role: "user", kind: "prose", text: "not this user's turn", user_id: "u2" });
    const rows = {
      code_sessions: [sessionRow()],
      code_session_turns: [...TWO_TURNS, otherUserTurn],
      session_memories: [] as Row[],
    };
    const supabase = makeFakeSupabase(rows);
    const { llm, chatCreate } = makeLlm();

    await runTailCaptureForSession({ supabase, llm }, "u1", "s1", { runId: "r1" });

    const promptSeen = chatCreate.mock.calls[0][0].messages[1].content as string;
    expect(promptSeen).not.toContain("not this user's turn");
  });

  it("blocker resolution tail re-ask (step2e finding 5): a resolution the extraction window couldn't see (it happens LATER) flips durable via a second, dedicated LLM call", async () => {
    const blockerTurns: Row[] = [
      turnRow({ idx: 0, role: "user", kind: "prose", text: "we're blocked on the migration" }),
      turnRow({
        idx: 1,
        role: "assistant",
        kind: "prose",
        text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration from running against the hosted project.",
      }),
      turnRow({ idx: 2, role: "user", kind: "prose", text: "found the key, added it to .env.local" }),
      turnRow({
        idx: 3,
        role: "assistant",
        kind: "prose",
        text: "Migration ran successfully now that the service-role key is set.",
      }),
    ];
    const rows = { code_sessions: [sessionRow()], code_session_turns: blockerTurns, session_memories: [] as Row[] };
    const supabase = makeFakeSupabase(rows);

    const blockerRecord = {
      kind: "blocker",
      text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration.",
      quote: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration from running against the hosted project.",
      turn_idx: 1,
      turn_role: "assistant",
      durable: false,
      resolved_in_session: false, // this window's own (wrong) verdict: "still open"
      thread: "migration blocker",
    };
    const { llm, chatCreate } = makeLlm({ chatBody: blockerRecord });
    // The SECOND chatCreate call is the D3 C2 user-turn pass (answers
    // nothing — a valid empty `{records: []}`, so issue #162's
    // retry-on-empty fires ONCE more with the identical prompt: the THIRD
    // call, still empty, "recovers" nothing). The FOURTH is the tail re-ask
    // (schema.ts's BlockerResolutionCheck shape) — it sees the later turns
    // and correctly reports the blocker WAS resolved.
    chatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ records: [blockerRecord] }) } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });
    chatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ records: [] }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    });
    chatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ records: [] }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    });
    chatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ resolutions: [{ index: 0, resolved_in_session: true }] }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });

    await runTailCaptureForSession({ supabase, llm }, "u1", "s1", { runId: "r1" });

    expect(chatCreate).toHaveBeenCalledTimes(4);
    expect(rows.code_sessions[0].props.memory_extraction.retried_empty).toBe(1);
    expect(rows.code_sessions[0].props.memory_extraction.retry_recovered).toBe(0);
    const reaskPrompt = chatCreate.mock.calls[3][0].messages[1].content as string;
    expect(reaskPrompt).toContain("service-role key is set"); // the later turns were actually given
    expect(reaskPrompt).toContain("(raised at #1)");
    // M4 fix (P10 review) + P8: resolved_in_session:true from the re-ask overrides the
    // window's own "still open" verdict, but the record is NEVER deleted — it is inserted
    // RETIRED with retire_reason "resolved_in_session", so no open-blocker surface serves
    // it next session and --reverify (unverified* only) never lifts it.
    expect(rows.session_memories).toHaveLength(1);
    expect(rows.session_memories[0].kind).toBe("blocker");
    expect(rows.session_memories[0].durable).toBe(false);
    expect(rows.session_memories[0].retired_at).not.toBeNull();
    expect(rows.session_memories[0].retire_reason).toBe("resolved_in_session");
    expect(rows.code_sessions[0].props.memory_extraction.blockers_reasked).toBe(1);
    expect(rows.code_sessions[0].props.memory_extraction.retired_resolved_blocker).toBe(1);
    expect(rows.code_sessions[0].props.memory_extraction.retired_unverified).toBe(0);
  });

  it("M4 (P10 review): a 1-based re-ask response is malformed (not the exact {0..N-1} set) — every blocker kept as extracted", async () => {
    const blockerTurns: Row[] = [
      turnRow({
        idx: 0,
        role: "user",
        kind: "prose",
        text: "we're blocked on the migration",
      }),
      turnRow({
        idx: 1,
        role: "assistant",
        kind: "prose",
        text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration from running against the hosted project.",
      }),
      turnRow({
        idx: 2,
        role: "user",
        kind: "prose",
        text: "found the key, added it to .env.local",
      }),
    ];
    const rows = {
      code_sessions: [sessionRow()],
      code_session_turns: blockerTurns,
      session_memories: [] as Row[],
    };
    const supabase = makeFakeSupabase(rows);
    const blockerRecord = {
      kind: "blocker",
      text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration.",
      quote: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration from running against the hosted project.",
      turn_idx: 1,
      turn_role: "assistant",
      durable: false,
      resolved_in_session: false,
      thread: "migration blocker",
    };
    const { llm, chatCreate } = makeLlm({ chatBody: blockerRecord });
    const empty = {
      choices: [{ message: { content: JSON.stringify({ records: [] }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    };
    chatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ records: [blockerRecord] }) } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });
    chatCreate.mockResolvedValueOnce(empty);
    chatCreate.mockResolvedValueOnce(empty);
    // 1-based instead of 0-based: passes Zod (index 1 is a valid nonnegative int) but is
    // NOT the exact {0..N-1} set for N=1 blocker — must be treated as malformed, not applied.
    chatCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              resolutions: [{ index: 1, resolved_in_session: true }],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });

    await runTailCaptureForSession({ supabase, llm }, "u1", "s1", {
      runId: "r1",
    });

    expect(rows.session_memories).toHaveLength(1);
    expect(rows.session_memories[0].kind).toBe("blocker");
    expect(rows.session_memories[0].durable).toBe(true); // !resolved_in_session (original, un-overridden)
    expect(rows.session_memories[0].retired_at ?? null).toBeNull(); // still an open blocker
    expect(rows.code_sessions[0].props.memory_extraction.blockers_reasked).toBe(0);
    expect(rows.code_sessions[0].props.memory_extraction.retired_resolved_blocker).toBe(0);
  });

  it("M4 (P10 review): a duplicate re-ask index is malformed — every blocker kept as extracted", async () => {
    const blockerTurns: Row[] = [
      turnRow({
        idx: 0,
        role: "user",
        kind: "prose",
        text: "we're blocked on the migration",
      }),
      turnRow({
        idx: 1,
        role: "assistant",
        kind: "prose",
        text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration from running against the hosted project.",
      }),
      turnRow({
        idx: 2,
        role: "user",
        kind: "prose",
        text: "found the key, added it to .env.local",
      }),
    ];
    const rows = {
      code_sessions: [sessionRow()],
      code_session_turns: blockerTurns,
      session_memories: [] as Row[],
    };
    const supabase = makeFakeSupabase(rows);
    const blockerRecord = {
      kind: "blocker",
      text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration.",
      quote: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration from running against the hosted project.",
      turn_idx: 1,
      turn_role: "assistant",
      durable: false,
      resolved_in_session: false,
      thread: "migration blocker",
    };
    const { llm, chatCreate } = makeLlm({ chatBody: blockerRecord });
    const empty = {
      choices: [{ message: { content: JSON.stringify({ records: [] }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    };
    chatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ records: [blockerRecord] }) } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });
    chatCreate.mockResolvedValueOnce(empty);
    chatCreate.mockResolvedValueOnce(empty);
    // Only 1 blocker was asked (index 0) — a duplicate index-0 answer is not the exact
    // {0..N-1} set either (distinct-index count 1 == N, but returned-array length 2 != 1).
    chatCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              resolutions: [
                { index: 0, resolved_in_session: true },
                { index: 0, resolved_in_session: false },
              ],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });

    await runTailCaptureForSession({ supabase, llm }, "u1", "s1", {
      runId: "r1",
    });

    expect(rows.session_memories).toHaveLength(1);
    expect(rows.session_memories[0].kind).toBe("blocker");
    expect(rows.session_memories[0].durable).toBe(true); // !resolved_in_session (original, un-overridden)
    expect(rows.code_sessions[0].props.memory_extraction.blockers_reasked).toBe(0);
    expect(rows.code_sessions[0].props.memory_extraction.retired_resolved_blocker).toBe(0);
  });

  it("P8: a blocker the re-ask judges still open is kept as a durable blocker", async () => {
    const blockerTurns: Row[] = [
      turnRow({
        idx: 0,
        role: "user",
        kind: "prose",
        text: "we're blocked on the migration",
      }),
      turnRow({
        idx: 1,
        role: "assistant",
        kind: "prose",
        text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration from running against the hosted project.",
      }),
      turnRow({
        idx: 2,
        role: "user",
        kind: "prose",
        text: "I'll look for the key tomorrow",
      }),
    ];
    const rows = {
      code_sessions: [sessionRow()],
      code_session_turns: blockerTurns,
      session_memories: [] as Row[],
    };
    const supabase = makeFakeSupabase(rows);
    const blockerRecord = {
      kind: "blocker",
      text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration.",
      quote: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration from running against the hosted project.",
      turn_idx: 1,
      turn_role: "assistant",
      durable: false,
      resolved_in_session: true, // the window's own (wrong) verdict
      thread: "migration blocker",
    };
    const { llm, chatCreate } = makeLlm({ chatBody: blockerRecord });
    const empty = {
      choices: [{ message: { content: JSON.stringify({ records: [] }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    };
    chatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ records: [blockerRecord] }) } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });
    chatCreate.mockResolvedValueOnce(empty);
    chatCreate.mockResolvedValueOnce(empty);
    chatCreate.mockResolvedValueOnce({
      choices: [
        {
          message: {
            content: JSON.stringify({
              resolutions: [{ index: 0, resolved_in_session: false }],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });

    await runTailCaptureForSession({ supabase, llm }, "u1", "s1", {
      runId: "r1",
    });

    expect(chatCreate).toHaveBeenCalledTimes(4);
    expect(rows.session_memories).toHaveLength(1);
    expect(rows.session_memories[0].kind).toBe("blocker");
    expect(rows.session_memories[0].durable).toBe(true);
    expect(rows.code_sessions[0].props.memory_extraction.retired_resolved_blocker).toBe(0);
  });

  it("P8: a malformed re-ask answer (fails Zod) never throws and keeps the blocker", async () => {
    const blockerTurns: Row[] = [
      turnRow({
        idx: 0,
        role: "user",
        kind: "prose",
        text: "we're blocked on the migration",
      }),
      turnRow({
        idx: 1,
        role: "assistant",
        kind: "prose",
        text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration from running against the hosted project.",
      }),
      turnRow({
        idx: 2,
        role: "user",
        kind: "prose",
        text: "found the key, added it to .env.local",
      }),
    ];
    const rows = {
      code_sessions: [sessionRow()],
      code_session_turns: blockerTurns,
      session_memories: [] as Row[],
    };
    const supabase = makeFakeSupabase(rows);
    const blockerRecord = {
      kind: "blocker",
      text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration.",
      quote: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration from running against the hosted project.",
      turn_idx: 1,
      turn_role: "assistant",
      durable: false,
      resolved_in_session: false,
      thread: "migration blocker",
    };
    const { llm, chatCreate } = makeLlm({ chatBody: blockerRecord });
    const empty = {
      choices: [{ message: { content: JSON.stringify({ records: [] }) } }],
      usage: { prompt_tokens: 20, completion_tokens: 5 },
    };
    chatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ records: [blockerRecord] }) } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });
    chatCreate.mockResolvedValueOnce(empty);
    chatCreate.mockResolvedValueOnce(empty);
    chatCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: JSON.stringify({
              resolutions: [{ index: "zero", resolved_in_session: "yes" }],
            }),
          },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 10 },
    });

    await runTailCaptureForSession({ supabase, llm }, "u1", "s1", {
      runId: "r1",
    });

    expect(rows.session_memories).toHaveLength(1);
    expect(rows.session_memories[0].kind).toBe("blocker");
    expect(rows.code_sessions[0].props.memory_extraction.retired_resolved_blocker).toBe(0);
  });

  it("no blocker records means no re-ask call at all", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: [...TWO_TURNS], session_memories: [] as Row[] };
    const supabase = makeFakeSupabase(rows);
    const { llm, chatCreate } = makeLlm(); // DECISION_RECORD, not a blocker

    await runTailCaptureForSession({ supabase, llm }, "u1", "s1", { runId: "r1" });

    expect(chatCreate).toHaveBeenCalledTimes(2); // extraction + user-turn pass, no re-ask
  });

  // step2f fix 1 (issue #151): a record missing `durable` is kept, not
  // dropped, and the fact that it was defaulted is visible on the session
  // row's props for measurement.
  it("a record missing durable is written (not dropped) and durable_defaulted is stamped on props.memory_extraction", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: [...TWO_TURNS], session_memories: [] as Row[] };
    const supabase = makeFakeSupabase(rows);
    const { llm, chatCreate } = makeLlm({
      chatBody: {
        kind: "blocker",
        text: "Missing SUPABASE_SERVICE_ROLE_KEY blocks the migration",
        quote: "Dark mode is now the default theme across the whole app.",
        turn_idx: 1,
        turn_role: "assistant",
        resolved_in_session: false,
        thread: "migration blocker",
        // durable intentionally omitted
      },
    });

    const summary = await runTailCaptureForSession({ supabase, llm }, "u1", "s1", { runId: "r1" });

    expect(chatCreate).toHaveBeenCalledTimes(2); // extraction + user-turn pass; no tail turns after idx 1, so no re-ask
    expect(summary.recordsWritten).toBe(1);
    expect(rows.session_memories).toHaveLength(1);
    expect(rows.session_memories[0].durable).toBe(true); // !resolved_in_session
    expect(rows.code_sessions[0].props.memory_extraction.durable_defaulted).toBe(1);
  });

  // --- review v6 (handoff/d3-v5/review-v6.md) ---

  const BAD = { choices: [{ message: { content: "not json {" } }], usage: { prompt_tokens: 5, completion_tokens: 1 } };
  const GOOD = {
    choices: [{ message: { content: JSON.stringify({ records: [DECISION_RECORD] }) } }],
    usage: { prompt_tokens: 50, completion_tokens: 20 },
  };

  it("M1: --force re-tags the replaced extraction's retired-unverified rows as rerun so --reverify can never resurrect them", async () => {
    const base = { user_id: "u1", code_session_id: "s1", code_project_id: "p1", source: "extractor", kind: "decision" };
    const oldUnverified: Row = {
      ...base,
      id: "old-u",
      retired_at: "2026-09-01T00:00:00Z",
      retire_reason: "unverified:quote_not_found",
    };
    const oldDuplicate: Row = { ...base, id: "old-d", retired_at: "2026-09-01T00:00:00Z", retire_reason: "duplicate" };
    const rows = {
      code_sessions: [
        sessionRow({ props: { memory_extraction: { prompt_version: "memory-extract-v-old", records: 1 } } }),
      ],
      code_session_turns: [...TWO_TURNS],
      session_memories: [oldUnverified, oldDuplicate],
    };
    const { llm } = makeLlm();
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s1", { runId: "r1", force: true });
    expect(oldUnverified.retire_reason).toBe("rerun");
    expect(oldUnverified.retired_at).toBe("2026-09-01T00:00:00Z");
    expect(oldDuplicate.retire_reason).toBe("duplicate");
  });

  it("M5: a failed user-pass window holds the checkpoint before its first turn and is recorded in props", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: [...TWO_TURNS], session_memories: [] as Row[] };
    const { llm, chatCreate } = makeLlm();
    chatCreate.mockReset();
    chatCreate.mockResolvedValueOnce(GOOD).mockResolvedValue(BAD);
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s1", { runId: "r1" });
    const props = rows.code_sessions[0].props;
    expect(props.memory_extraction.user_pass_windows_failed).toBe(1);
    expect(props.memory_checkpoint_turn_idx ?? null).toBeNull(); // user turn #0 never got the user pass
  });

  it("S3 fix (review round 2, issue #162): userPass:false skips the user pass entirely but still holds back the checkpoint, exactly like a failed user-pass window would", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: [...TWO_TURNS], session_memories: [] as Row[] };
    const { llm, chatCreate } = makeLlm();
    chatCreate.mockReset();
    // Same fixture as the M5 test above (main pass succeeds) — the only
    // difference is userPass: false, so the user pass is never even called.
    chatCreate.mockResolvedValueOnce(GOOD).mockResolvedValue(BAD);
    const summary = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s1", {
      runId: "r1",
      userPass: false,
    });
    expect(chatCreate).toHaveBeenCalledTimes(1); // main pass only — no user-pass window ever attempted
    const props = rows.code_sessions[0].props;
    expect(props.memory_extraction.user_pass_windows_failed).toBe(0);
    expect(props.memory_extraction.user_pass_records).toBe(0);
    // S3: held back to null, same as the M5 (userPass:true, window fails)
    // case just above — an OFF run must not advance the checkpoint past
    // turns the user pass never covered, or a later ON run would never
    // re-cover them without --force.
    expect(props.memory_checkpoint_turn_idx ?? null).toBeNull();
    expect(summary.recordsWritten).toBe(1); // the main pass's own record is still written
  });

  it("M5: the user pass never runs past the main checkpoint (a failed main window means no user-pass call)", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: [...TWO_TURNS], session_memories: [] as Row[] };
    const { llm, chatCreate } = makeLlm();
    chatCreate.mockReset();
    chatCreate.mockResolvedValue(BAD);
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s1", { runId: "r1" });
    const mainAttempts = chatCreate.mock.calls.length;
    expect(chatCreate.mock.calls.every((c) => !String(c[0].messages[1].content).includes("Owner lines"))).toBe(true);
    expect(mainAttempts).toBeGreaterThan(0);
    expect(rows.code_sessions[0].props.memory_extraction.user_pass_records).toBe(0);
  });

  it("m4: the user-pass budget uses the main pass's ACTUAL cost when it overshot the estimate", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: [...TWO_TURNS], session_memories: [] as Row[] };
    const { llm, chatCreate } = makeLlm();
    chatCreate.mockReset();
    // 2M prompt tokens on gpt-4o-mini ~ $0.30: over a $0.25 session budget on its own.
    chatCreate.mockResolvedValue({ ...GOOD, usage: { prompt_tokens: 2_000_000, completion_tokens: 20 } });
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s1", {
      runId: "r1",
      sessionBudgetUsd: 0.25,
    });
    expect(chatCreate).toHaveBeenCalledTimes(1); // main pass only
    expect(rows.code_sessions[0].props.memory_extraction.user_pass_windows_skipped).toBe(1);
  });

  it("RR2-S1 (retry re-check): the main-pass retry gate counts what degrade already reserved for the OTHER selected windows, not just spend so far", async () => {
    // 5 oversized (each >> the 24k-char window-split threshold) user-prose
    // turns => 5 standalone windows, none droppable (every one has user
    // prose) — degrade.estimatedCostUsd is ~$0.253 up front, already over
    // the $0.25 session budget, matching the finding's "budget 0.25, 5
    // windows at 0.05 each" example.
    const bigText = "please always use zsh for scripts here, never bash ".repeat(26000); // ~1.33M chars, ~$0.05/window
    const turns: Row[] = Array.from({ length: 5 }, (_, i) =>
      turnRow({ idx: i, role: "user", kind: "prose", text: bigText }),
    );
    const rows = { code_sessions: [sessionRow()], code_session_turns: turns, session_memories: [] as Row[] };
    const { llm, chatCreate } = makeLlm();
    chatCreate.mockReset();
    chatCreate.mockResolvedValue({
      choices: [{ message: { content: JSON.stringify({ records: [] }) } }],
      usage: { prompt_tokens: 50, completion_tokens: 5 },
    });
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s1", {
      runId: "r1",
      sessionBudgetUsd: 0.25,
    });
    // The OLD gate (extractionCostUsd — spend so far — only) would have let
    // several early windows retry, since actual spend stays well under 0.25
    // for a while even though degrade already committed the whole budget to
    // all 5 selected windows. The fix reserves that commitment up front, so
    // every window sees zero headroom and none retries.
    expect(chatCreate).toHaveBeenCalledTimes(5); // one call per window, no retries
    const extraction = rows.code_sessions[0].props.memory_extraction;
    expect(extraction.retried_empty).toBe(0);
    expect(extraction.retry_skipped_budget).toBe(5);
  });

  // --- review v6, round 2 ---

  const isUserPassCall = (body: { messages: Array<{ content: unknown }> }) =>
    String(body.messages[1]?.content ?? "").includes("Owner lines");

  it("R2-M1: an always-failing user-pass window releases the checkpoint on attempt 3, and no record is written twice across runs", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: [...TWO_TURNS], session_memories: [] as Row[] };
    const { llm, chatCreate } = makeLlm();
    chatCreate.mockReset();
    chatCreate.mockImplementation((body) => Promise.resolve(isUserPassCall(body) ? BAD : GOOD));
    const deps = { supabase: makeFakeSupabase(rows), llm };
    const checkpoints: Array<number | null> = [];
    for (let run = 1; run <= USER_PASS_MAX_ATTEMPTS; run++) {
      await runTailCaptureForSession(deps, "u1", "s1", { runId: `r${run}` });
      const props = rows.code_sessions[0].props;
      checkpoints.push(props.memory_checkpoint_turn_idx ?? null);
      if (run < USER_PASS_MAX_ATTEMPTS) expect(Object.values(props.memory_user_pass_failures)).toEqual([run]);
    }
    expect(USER_PASS_MAX_ATTEMPTS).toBe(3);
    expect(checkpoints).toEqual([null, null, 1]);
    const props = rows.code_sessions[0].props;
    expect(props.memory_extraction.user_pass_windows_abandoned).toEqual(["0-0"]); // "<first>-<last>" user-pass turn idx
    expect(props.memory_user_pass_failures).toEqual({});
    // Three runs re-extracted the same main window: one row, never a copy.
    expect(rows.session_memories).toHaveLength(1);
    // A 4th upload with no new turns is a no-op: the session is not re-billed.
    const callsBefore = chatCreate.mock.calls.length;
    await runTailCaptureForSession(deps, "u1", "s1", { runId: "r4" });
    expect(chatCreate.mock.calls.length).toBe(callsBefore);
  });

  it("R2-M1: when the main pass used the whole session budget, the user-pass skip is deliberate and the checkpoint advances", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: [...TWO_TURNS], session_memories: [] as Row[] };
    const { llm, chatCreate } = makeLlm();
    chatCreate.mockReset();
    chatCreate.mockResolvedValue({ ...GOOD, usage: { prompt_tokens: 2_000_000, completion_tokens: 20 } });
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s1", {
      runId: "r1",
      sessionBudgetUsd: 0.25,
    });
    const props = rows.code_sessions[0].props;
    expect(props.memory_extraction.user_pass_windows_budget_released).toBe(1);
    expect(props.memory_checkpoint_turn_idx).toBe(1);
    expect(props.memory_user_pass_failures).toEqual({});
  });

  it("M5 (m6): a user-pass window that succeeds on the next run clears its attempt count and advances the checkpoint", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: [...TWO_TURNS], session_memories: [] as Row[] };
    const { llm, chatCreate } = makeLlm();
    chatCreate.mockReset();
    let failUserPass = true;
    chatCreate.mockImplementation((body) =>
      Promise.resolve(
        isUserPassCall(body)
          ? failUserPass
            ? BAD
            : { ...GOOD, choices: [{ message: { content: '{"records":[]}' } }] }
          : GOOD,
      ),
    );
    const deps = { supabase: makeFakeSupabase(rows), llm };
    await runTailCaptureForSession(deps, "u1", "s1", { runId: "r1" });
    expect(rows.code_sessions[0].props.memory_checkpoint_turn_idx ?? null).toBeNull();
    failUserPass = false;
    await runTailCaptureForSession(deps, "u1", "s1", { runId: "r2" });
    expect(rows.code_sessions[0].props.memory_checkpoint_turn_idx).toBe(1);
    expect(rows.code_sessions[0].props.memory_user_pass_failures).toEqual({});
    expect(rows.session_memories).toHaveLength(1);
  });

  const forceRows = () => {
    const base = { user_id: "u1", code_session_id: "s1", code_project_id: "p1", source: "extractor", kind: "decision" };
    const oldUnverified: Row = {
      ...base,
      id: "old-u",
      content_hash: "old-hash",
      turn_idx: 1,
      turn_role: "assistant",
      text: "Dark mode is now the default theme",
      quote: "Dark mode is now the default theme across the whole app.",
      ref: null,
      verified: false,
      retired_at: "2026-09-01T00:00:00Z",
      retire_reason: "unverified:quote_not_found",
    };
    return {
      oldUnverified,
      rows: {
        code_sessions: [
          sessionRow({ props: { memory_extraction: { prompt_version: "memory-extract-v-old", records: 1 } } }),
        ],
        code_session_turns: [...TWO_TURNS],
        session_memories: [oldUnverified],
      },
    };
  };

  it("m6 (M1): --force then --reverify never resurrects the replaced extraction's unverified row, even when it would now ground", async () => {
    const { oldUnverified, rows } = forceRows();
    const { llm } = makeLlm();
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s1", { runId: "r1", force: true });
    expect(oldUnverified.retire_reason).toBe("rerun");
    const plan = planReverifyUpdate(
      {
        verified: false,
        turn_idx: 1,
        quote: oldUnverified.quote,
        turn_role: "assistant",
        retired_at: oldUnverified.retired_at,
        retire_reason: oldUnverified.retire_reason,
      },
      { verified: true, turn_idx: 1, reason: null },
      "2026-09-24T00:00:00Z",
    );
    expect(plan.update).toBeNull();
    expect(plan.unretire).toBe(false);
  });

  it("R2-m3: a --force run that crashes at insert has already re-tagged the old unverified rows", async () => {
    const { oldUnverified, rows } = forceRows();
    const { llm } = makeLlm();
    const fake = makeFakeSupabase(rows);
    const crashing = {
      ...fake,
      from(table: string) {
        const q = fake.from(table);
        if (table === "session_memories") {
          q.upsert = () => {
            throw new Error("simulated crash at insert");
          };
        }
        return q;
      },
    };
    await expect(
      runTailCaptureForSession({ supabase: crashing, llm }, "u1", "s1", { runId: "r1", force: true }),
    ).rejects.toThrow("simulated crash at insert");
    expect(oldUnverified.retire_reason).toBe("rerun");
  });
});

describe("P10 re-review N2/N3: deadline stop and failed-window count", () => {
  const big = "please always use zsh for scripts here, never bash ".repeat(26000); // one window per turn
  const bigTurns = () => [0, 1, 2].map((idx) => turnRow({ idx, role: "user", kind: "prose", text: big }));
  const emptyReply = {
    choices: [{ message: { content: JSON.stringify({ records: [] }) } }],
    usage: { prompt_tokens: 50, completion_tokens: 5 },
  };

  it("stops starting main windows once shouldStop('main') fires, keeps the checkpoint before them, and the next run resumes", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: bigTurns(), session_memories: [] as Row[] };
    const { llm, chatCreate } = makeLlm();
    chatCreate.mockReset();
    chatCreate.mockResolvedValue(emptyReply);
    const deps = { supabase: makeFakeSupabase(rows), llm };
    const passes: string[] = [];
    const first = await runTailCaptureForSession(deps, "u1", "s1", {
      runId: "r1",
      shouldStop: (pass) => {
        passes.push(pass);
        return pass === "main" && chatCreate.mock.calls.length >= 1;
      },
    });
    expect(first).toMatchObject({ deadlineHit: true, checkpointAdvanced: true, windowsFailed: 0, lockHeld: false });
    const mainCalls = chatCreate.mock.calls.filter(([body]) =>
      String((body as { messages: Array<{ content: unknown }> }).messages[0]?.content ?? "").startsWith(
        'You extract short "session memory"',
      ),
    );
    // R3-m1: window 0 ran; its retry-on-empty is gated on the same cutoff
    // (already past), and windows 1-2 never started.
    expect(mainCalls).toHaveLength(1);
    expect(passes).toContain("user");
    expect(rows.code_sessions[0].props.memory_checkpoint_turn_idx).toBe(0);
    expect(rows.code_sessions[0].props.memory_extraction_lock).toBeUndefined(); // released for the resume

    const second = await runTailCaptureForSession(deps, "u1", "s1", { runId: "r2", sessionBudgetUsd: 1 });
    expect(second).toMatchObject({ deadlineHit: false, checkpointAdvanced: true });
    expect(rows.code_sessions[0].props.memory_checkpoint_turn_idx).toBe(2);
  });

  it("R3-m1: past the reask cutoff the blocker re-ask is skipped and the run still writes", async () => {
    const turns: Row[] = [
      turnRow({ idx: 0, role: "user", kind: "prose", text: "we're blocked on the migration" }),
      turnRow({ idx: 1, role: "assistant", kind: "prose", text: "Missing key blocks the migration." }),
      turnRow({ idx: 2, role: "user", kind: "prose", text: "found the key" }),
    ];
    const rows = { code_sessions: [sessionRow()], code_session_turns: turns, session_memories: [] as Row[] };
    const blocker = {
      kind: "blocker",
      text: "Missing key blocks the migration.",
      quote: "Missing key blocks the migration.",
      turn_idx: 1,
      turn_role: "assistant",
      durable: false,
      resolved_in_session: false,
      thread: "migration blocker",
    };
    const { llm, chatCreate } = makeLlm();
    chatCreate.mockReset();
    chatCreate.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ records: [blocker] }) } }],
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });
    chatCreate.mockResolvedValue(emptyReply);
    const passes: string[] = [];
    const summary = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s1", {
      runId: "r1",
      shouldStop: (pass) => {
        passes.push(pass);
        return pass === "reask";
      },
    });
    expect(passes).toContain("reask");
    expect(passes).toContain("embed");
    expect(summary).toMatchObject({ deadlineHit: false, checkpointAdvanced: true });
    expect(rows.code_sessions[0].props.memory_extraction.blockers_reasked ?? 0).toBe(0);
    expect(rows.session_memories.length).toBeGreaterThan(0);
  });

  it("a user-pass deadline pulls the checkpoint back without counting a hold attempt", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: bigTurns(), session_memories: [] as Row[] };
    const { llm, chatCreate } = makeLlm();
    chatCreate.mockReset();
    chatCreate.mockResolvedValue(emptyReply);
    const summary = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s1", {
      runId: "r1",
      shouldStop: (pass) => pass === "user",
    });
    expect(summary).toMatchObject({ deadlineHit: true, checkpointAdvanced: false });
    expect(rows.code_sessions[0].props.memory_checkpoint_turn_idx ?? null).toBeNull();
    expect(rows.code_sessions[0].props.memory_user_pass_failures).toEqual({});
  });

  it("counts failed windows so the queue never marks such a session done", async () => {
    const rows = { code_sessions: [sessionRow()], code_session_turns: [...TWO_TURNS], session_memories: [] as Row[] };
    const { llm, chatCreate } = makeLlm();
    chatCreate.mockReset();
    chatCreate.mockRejectedValue(new Error("timeout"));
    const summary = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows), llm }, "u1", "s1", {
      runId: "r1",
    });
    expect(summary.windowsFailed).toBeGreaterThan(0);
    expect(summary.checkpointAdvanced).toBe(false);
  });
});

// #176: the lineage query's lower bound (`since`, tail-capture.ts ~:597) must
// anchor on the session's `started_at`, exactly like the fresh window
// (~:611) already does — not on wall-clock `Date.now()`. For an old session
// (started_at > 90 days before "now"), a wall-clock anchor pulls `since`
// forward past `started_at`, excluding earlier same-project sessions that
// are well inside the intended 90-day lineage window measured from
// `started_at`. The memory-flavour fake used elsewhere in this file has no
// `.neq()`/`.lte()` (SURFACE in fake-db.ts), so `fetchBranchLineage`'s
// second query throws inside its own try/catch and always no-ops under it —
// masking this bug rather than exercising it. The "db" flavour implements
// every builder method, so it is used here to actually run the query this
// issue is about.
describe("fetchBranchLineage (#176: lineage window anchor)", () => {
  const NOW = new Date("2026-01-01T00:00:00.000Z");
  const DAY = 24 * 60 * 60 * 1000;
  // Old session: started_at is 100 days before "now" (> LINEAGE_DAYS=90 from now).
  const SESSION_STARTED_AT = new Date(NOW.getTime() - 100 * DAY).toISOString();
  // Earlier session of the same project: 5 days before SESSION_STARTED_AT (inside a
  // 90-day window measured from started_at) but 105 days before "now" (outside a
  // 90-day window measured from wall-clock "now") -- and inside the 14-day fresh
  // window measured from started_at, so a fixed anchor produces a mapping.
  const LINEAGE_STARTED_AT = new Date(NOW.getTime() - 105 * DAY).toISOString();

  // A session started AFTER s-old: must stay excluded by the `.lte(started_at,
  // session.started_at)` upper bound (tail-capture.ts ~:612), same field as
  // the anchor fix, so a later opened_mr on the same branch never reaches
  // knownBranchesFromTurns and conflicts out the s-lineage mapping.
  const FUTURE_STARTED_AT = new Date(NOW.getTime() - 50 * DAY).toISOString();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fixture(opts: { includeFutureSession?: boolean } = {}) {
    const codeSessions: Row[] = [
      {
        id: "s-old",
        user_id: "u1",
        code_project_id: "p1",
        started_at: SESSION_STARTED_AT,
      } as Row,
      {
        id: "s-lineage",
        user_id: "u1",
        code_project_id: "p1",
        started_at: LINEAGE_STARTED_AT,
      } as Row,
    ];
    const turns: Row[] = [
      {
        session_id: "s-lineage",
        user_id: "u1",
        idx: 0,
        props: {
          action: { verb: "opened_mr", source: "cli", ref: "#42", refKind: "merge_request", branch: "feature-a" },
        },
      } as Row,
    ];
    if (opts.includeFutureSession) {
      codeSessions.push({
        id: "s-future",
        user_id: "u1",
        code_project_id: "p1",
        started_at: FUTURE_STARTED_AT,
      } as Row);
      turns.push({
        session_id: "s-future",
        user_id: "u1",
        idx: 0,
        props: {
          action: { verb: "opened_mr", source: "cli", ref: "#43", refKind: "merge_request", branch: "feature-a" },
        },
      } as Row);
    }
    const tables: Record<string, Row[]> = {
      memory_branch_state: [],
      code_sessions: codeSessions,
      code_session_turns: turns,
    };
    return createFakeDb({ flavour: "db", tables }).client;
  }

  it("DIFFERS: a wall-clock anchor drops an earlier same-project session that a started_at anchor keeps", async () => {
    const supabase = fixture();
    const { knownBranches } = await fetchBranchLineage(supabase, "u1", {
      id: "s-old",
      code_project_id: "p1",
      started_at: SESSION_STARTED_AT,
    });
    // Fixed behaviour: the earlier session is inside the started_at-anchored
    // window, so its opened_mr action produces a lineage mapping.
    expect(knownBranches).toEqual([{ branch: "feature-a", ref: "#42", refKind: "merge_request" }]);
  });

  it("upper bound: a session started AFTER s-old is never pulled into lineage, even on the same branch", async () => {
    const supabase = fixture({ includeFutureSession: true });
    const { knownBranches } = await fetchBranchLineage(supabase, "u1", {
      id: "s-old",
      code_project_id: "p1",
      started_at: SESSION_STARTED_AT,
    });
    // s-future's #43 must never be seen: if it were, feature-a would map to
    // two different refs (#42 vs #43) and knownBranchesFromTurns would drop
    // the branch as conflicting, not just add a second mapping.
    expect(knownBranches).toEqual([{ branch: "feature-a", ref: "#42", refKind: "merge_request" }]);
  });
});
