// The handoff phase in tail-capture: behind MEMBRAL_HANDOFF_SYNTHESIS, off by default, never fails extraction.

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { log } from "@/lib/log";

const synth = vi.hoisted(() => vi.fn());
vi.mock("../session-handoff", () => ({ synthesizeSessionHandoff: synth }));
const gap = vi.hoisted(() => vi.fn());
vi.mock("../session-handoff-gap", () => ({ markHandoffGaps: gap }));

import { runTailCaptureForSession } from "../tail-capture";

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};
const RECORD = {
  kind: "learning",
  text: "Dark mode is now the default theme",
  quote: "Dark mode is now the default theme across the whole app.",
  turn_idx: 1,
  turn_role: "assistant",
  durable: true,
  thread: "dark mode default",
};

function llm() {
  const create = vi.fn().mockResolvedValue({
    choices: [{ message: { content: JSON.stringify({ records: [RECORD] }) } }],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  });
  const embed = vi.fn().mockImplementation((b: { input: string | string[] }) =>
    Promise.resolve({
      data: (Array.isArray(b.input) ? b.input : [b.input]).map(() => ({ embedding: [1, 0, 0] })),
      usage: { prompt_tokens: 1 },
    }),
  );
  const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: embed } };
  return new LlmClient(CONFIG, { client });
}

function rows(): Record<string, Row[]> {
  return {
    code_sessions: [
      {
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
      },
    ],
    code_session_turns: [
      {
        idx: 0,
        role: "user",
        kind: "prose",
        text: "please add dark mode",
        session_id: "s1",
        user_id: "u1",
        tool_name: null,
        file_path: null,
        ts: null,
        props: {},
      },
      {
        idx: 1,
        role: "assistant",
        kind: "prose",
        text: "Dark mode is now the default theme across the whole app.",
        session_id: "s1",
        user_id: "u1",
        tool_name: null,
        file_path: null,
        ts: null,
        props: {},
      },
    ],
    session_memories: [],
  };
}

/** The `reason` of every "handoff skipped" log line seen by the spy. */
function skipReasons(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls
    .filter((c) => String(c[0]).startsWith("memory: handoff skipped"))
    .map((c) => String((c[1] as { reason?: string }).reason));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  synth.mockReset();
  gap.mockReset();
});

describe("handoff phase", () => {
  it("flag off (default): synthesis never runs", async () => {
    const r = rows();
    await runTailCaptureForSession({ supabase: makeFakeSupabase(r), llm: llm() }, "u1", "s1", { runId: "r1" });
    expect(synth).not.toHaveBeenCalled();
  });

  it("flag on: runs once, for this user and session, before the lock is released", async () => {
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "1");
    const r = rows();
    let lockDuring: unknown = "unset";
    synth.mockImplementation(async () => {
      lockDuring = r.code_sessions[0].props.memory_extraction_lock;
      return { status: "written", costUsd: 0 };
    });
    await runTailCaptureForSession({ supabase: makeFakeSupabase(r), llm: llm() }, "u1", "s1", { runId: "r1" });
    expect(synth).toHaveBeenCalledTimes(1);
    expect(synth.mock.calls[0].slice(1)).toEqual(["u1", "s1"]);
    expect(lockDuring).toBeDefined();
    expect(r.code_sessions[0].props.memory_extraction_lock).toBeUndefined();
  });

  it("flag on: the synthesis cost is added to the run cost", async () => {
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "1");
    const base = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows()), llm: llm() }, "u1", "s1", {
      runId: "r1",
    });
    synth.mockResolvedValue({ status: "written", costUsd: 0.25 });
    const withNote = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows()), llm: llm() }, "u1", "s1", {
      runId: "r1",
    });
    expect(withNote.costUsd - base.costUsd).toBeCloseTo(0.25);
  });

  it("flag on: the lease is renewed (a fresh lock stamp with this run's id) before the synthesis starts", async () => {
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "1");
    const r = rows();
    let lockAtSynth: { run_id?: string; at?: string } | undefined;
    synth.mockImplementation(async () => {
      lockAtSynth = r.code_sessions[0].props.memory_extraction_lock as typeof lockAtSynth;
      return { status: "written", costUsd: 0 };
    });
    const t0 = Date.now();
    await runTailCaptureForSession({ supabase: makeFakeSupabase(r), llm: llm() }, "u1", "s1", { runId: "r1" });
    expect(lockAtSynth?.run_id).toBe("r1");
    expect(Date.parse(String(lockAtSynth?.at))).toBeGreaterThanOrEqual(t0 - 5);
  });

  it("flag on: a throwing synthesis does not fail the extraction pass", async () => {
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "true");
    synth.mockRejectedValue(new Error("boom"));
    const r = rows();
    const summary = await runTailCaptureForSession({ supabase: makeFakeSupabase(r), llm: llm() }, "u1", "s1", {
      runId: "r1",
    });
    expect(summary.recordsWritten).toBe(1);
  });

  it("flag on: another run's lock is not overwritten by the lease renewal, and the synthesis is skipped", async () => {
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "1");
    const r = rows();
    const other = { run_id: "other-run", at: "2099-01-01T00:00:00.000Z" };
    const client = llm();
    // The lock changes hands while the extraction call is in flight (e.g. this run's lease went stale).
    const create = (client as unknown as { client: OpenAILike }).client.chat.completions.create as ReturnType<
      typeof vi.fn
    >;
    create.mockImplementation(async () => {
      r.code_sessions[0].props = { ...(r.code_sessions[0].props as object), memory_extraction_lock: other };
      return {
        choices: [{ message: { content: JSON.stringify({ records: [RECORD] }) } }],
        usage: { prompt_tokens: 5, completion_tokens: 5 },
      };
    });
    const supabase = makeFakeSupabase(r);
    const warn = vi.spyOn(log, "warn");
    // Capture the stored lock when the run ends: the finishing write must not have replaced it either.
    await runTailCaptureForSession({ supabase, llm: client }, "u1", "s1", { runId: "r1" });
    expect(synth).not.toHaveBeenCalled();
    expect(r.code_sessions[0].props.memory_extraction_lock).toEqual(other);
    expect(warn.mock.calls.some((c) => (c[1] as { reason?: string } | undefined)?.reason === "lock_lost")).toBe(true);
  });

  it("flag on: shouldStop set by the time the note would start skips the synthesis", async () => {
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "1");
    const info = vi.spyOn(log, "info");
    let embedChecks = 0;
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows()), llm: llm() }, "u1", "s1", {
      runId: "r1",
      // False for the embed check that gates persistence, true for the handoff phase's check after it.
      shouldStop: (pass) => pass === "embed" && ++embedChecks > 1,
    });
    expect(embedChecks).toBeGreaterThan(1);
    expect(synth).not.toHaveBeenCalled();
    expect(skipReasons(info)).toEqual(["deadline_or_stop"]);
  });

  it("flag on: a user pass cut off by the deadline skips the synthesis", async () => {
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "1");
    const info = vi.spyOn(log, "info");
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows()), llm: llm() }, "u1", "s1", {
      runId: "r1",
      shouldStop: (pass) => pass === "user",
    });
    expect(synth).not.toHaveBeenCalled();
    expect(skipReasons(info)).toEqual(["deadline_or_stop"]);
  });

  it("flag on: the synthesis gets what is left of the session budget, and is skipped when none is left", async () => {
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "1");
    synth.mockResolvedValue({ status: "written", costUsd: 0 });
    const base = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows()), llm: llm() }, "u1", "s1", {
      runId: "r1",
      sessionBudgetUsd: 1,
    });
    const deps = synth.mock.calls[0][0] as { budgetUsd: number };
    expect(deps.budgetUsd).toBeCloseTo(1 - base.costUsd, 9);
    expect(deps.budgetUsd).toBeLessThan(1);

    synth.mockClear();
    const info = vi.spyOn(log, "info");
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows()), llm: llm() }, "u1", "s1", {
      runId: "r1",
      // Spend so far (one extraction call plus the association call's share) reaches this budget.
      sessionBudgetUsd: base.costUsd / 2,
    });
    expect(synth).not.toHaveBeenCalled();
    expect(skipReasons(info)).toEqual(["budget_exhausted"]);
  });
});

describe("handoff phase: gap diff (box 2.4)", () => {
  it.each(["skipped", "failed", "empty"])("a %s synthesis does not run the gap diff", async (status) => {
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "1");
    synth.mockResolvedValue({ status, text: "- note", renderedRecordIds: new Set(["a"]), costUsd: 0 });
    await runTailCaptureForSession({ supabase: makeFakeSupabase(rows()), llm: llm() }, "u1", "s1", { runId: "r1" });
    expect(gap).not.toHaveBeenCalled();
  });

  it("a written note runs the gap diff with its text and rendered ids, and the gap cost joins the run cost", async () => {
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "1");
    gap.mockResolvedValue({ status: "marked", costUsd: 0.5 });
    synth.mockResolvedValue({ status: "written", text: "- note", renderedRecordIds: new Set(["a"]), costUsd: 0.25 });
    const base = await (async () => {
      synth.mockResolvedValueOnce({ status: "skipped", costUsd: 0 });
      return runTailCaptureForSession({ supabase: makeFakeSupabase(rows()), llm: llm() }, "u1", "s1", { runId: "r1" });
    })();
    gap.mockClear();
    const withNote = await runTailCaptureForSession({ supabase: makeFakeSupabase(rows()), llm: llm() }, "u1", "s1", {
      runId: "r1",
    });
    expect(gap).toHaveBeenCalledTimes(1);
    const [deps, user, session, note] = gap.mock.calls[0];
    expect([user, session, note.text, [...note.renderedRecordIds]]).toEqual(["u1", "s1", "- note", ["a"]]);
    expect(typeof deps.shouldStop).toBe("function");
    expect(Number.isFinite(deps.remainingBudgetUsd)).toBe(true);
    expect(withNote.costUsd - base.costUsd).toBeCloseTo(0.75);
  });
});
