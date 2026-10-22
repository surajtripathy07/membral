// Goal 2026-09-24 review B1/M1/M2/M3/m2: the queue worker that extracts ONE
// session per serverless invocation (extraction-queue.ts). Drives the real
// runTailCaptureForSession over the fake Supabase double; only the feature
// flag, the app mode, the service-role factory and the cost-guard factory
// are mocked. The claim itself is SQL (migration 087's
// memory_extraction_claim): here a fake rpc stands in for it; its atomicity,
// lease-expiry reclaim and backfill window are exercised against a real
// Postgres by the driver's migration check (see the receipt), and its
// load-bearing clauses are pinned by the static test at the bottom.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { APIConnectionTimeoutError, APIError } from "openai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LlmClient, type OpenAILike } from "@/lib/llm/client";
import type { ModelConfig } from "@/lib/llm/config";
import { log } from "@/lib/log";
import { MEMORY_EXTRACTION_LOCK_STALE_MS } from "@/lib/memory/write";
import {
  DEFAULT_MEMORY_BACKFILL_MAX_AGE_DAYS,
  DEFAULT_MEMORY_BACKFILL_SESSIONS,
  enqueueMemoryExtraction,
  MAX_MEMORY_BACKFILL_MAX_AGE_DAYS,
  MEMORY_EMBED_MAX_RETRIES,
  MEMORY_EMBED_TIMEOUT_MS,
  MEMORY_EMBED_WORST_CALL_MS,
  MEMORY_FINISH_MARGIN_MS,
  MEMORY_LEASE_SECONDS,
  MEMORY_LLM_MAX_RETRIES,
  MEMORY_LLM_TIMEOUT_MS,
  MEMORY_MAX_ATTEMPTS,
  MEMORY_MAX_DURATION_MS,
  MEMORY_MAX_SESSIONS_PER_INVOCATION,
  MEMORY_MIN_REMAINING_TO_START_MS,
  MEMORY_PASS_DEADLINE_SHARE,
  MEMORY_QUEUE_TABLE,
  MEMORY_RUN_DEADLINE_MS,
  MEMORY_SPEND_PASSES,
  processNextMemoryExtraction,
  reconcileMemoryExtractionQueue,
  resetNoModelLogForTests,
  resolveMemoryBackfillMaxAgeDays,
  resolveMemoryBackfillSessions,
  sessionGrewSinceExtraction,
  startOfUtcMonthIso,
} from "../extraction-queue";
import { runMemoryExtractionStep } from "../extraction-trigger";

const mockCheckFeature = vi.fn();
const mockGetAppMode = vi.fn();
vi.mock("@/lib/feature-flags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/feature-flags")>();
  return {
    ...actual,
    checkFeature: (...args: unknown[]) => mockCheckFeature(...args),
    getAppMode: () => mockGetAppMode(),
  };
});

let fakeSupabase: ReturnType<typeof makeFakeSupabase>;
vi.mock("@/lib/db/clients", () => ({
  getServiceClient: () => fakeSupabase,
  SUPABASE_ENV_MISSING_MESSAGE: "Missing Supabase env vars (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)",
}));

const mockCreateCostGuardedLlm = vi.fn();
vi.mock("@/lib/llm/spend-ledger", () => ({
  createCostGuardedLlm: (...args: unknown[]) => mockCreateCostGuardedLlm(...args),
}));

const CONFIG: ModelConfig = {
  model: "gpt-4o-mini",
  baseURL: undefined,
  apiKey: "test",
  embedModel: "text-embedding-3-small",
  embedDimensions: 1536,
};

function sessionRow(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
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

function turnsFor(sessionId: string): Row[] {
  return [
    {
      session_id: sessionId,
      user_id: "u1",
      idx: 0,
      role: "user",
      kind: "prose",
      text: "please add dark mode",
    },
    {
      session_id: sessionId,
      user_id: "u1",
      idx: 1,
      role: "assistant",
      kind: "prose",
      text: "Dark mode is now the default theme.",
    },
  ].map((t) => ({
    tool_name: null,
    file_path: null,
    ts: null,
    props: {},
    ...t,
  }));
}

function makeGuardedLlm(capUsd?: number) {
  const chatCreate = vi.fn().mockResolvedValue({
    choices: [
      {
        message: {
          content: JSON.stringify({
            records: [
              {
                kind: "learning",
                text: "Dark mode is now the default theme",
                quote: "Dark mode is now the default theme.",
                turn_idx: 1,
                turn_role: "assistant",
                durable: true,
                thread: "dark mode default",
              },
            ],
          }),
        },
      },
    ],
    usage: { prompt_tokens: 50, completion_tokens: 20 },
  });
  const embedCreate = vi.fn().mockResolvedValue({
    data: [{ embedding: [1, 0, 0] }],
    usage: { prompt_tokens: 5 },
  });
  const client: OpenAILike = {
    chat: { completions: { create: chatCreate } },
    embeddings: { create: embedCreate },
  };
  const llm = new LlmClient(CONFIG, { client, capUsd });
  return { llm, chatCreate };
}

const NOW = new Date("2026-09-25T12:00:00.000Z");

function queueRow(sessionId: string, overrides: Partial<Row> = {}): Row {
  return {
    session_id: sessionId,
    user_id: "u1",
    status: "pending",
    lease_until: null,
    lease_token: null,
    attempts: 0,
    last_reason: null,
    dirty: false,
    ...overrides,
  };
}

interface World {
  rows: Record<string, Row[]>;
  monthSpend: (sinceIso: string) => number;
  globalSum: (sinceIso: string) => {
    data: unknown;
    error: { message: string; code?: string } | null;
  };
  claimArgs: Record<string, unknown>[];
  spendArgs: Record<string, unknown>[];
}

/** Fakes of migration 088's enqueue/finish — same semantics as the SQL (which the receipt exercised against local Postgres). */
function queueRpcs(
  rows: Record<string, Row[]>,
): Record<string, (args: Record<string, unknown>) => { data: unknown; error: null }> {
  const q = () => rows.memory_extraction_queue;
  return {
    memory_extraction_enqueue: (args) => {
      let n = 0;
      for (const id of (args.p_requeue as string[]) ?? []) {
        const row = q().find((r) => r.session_id === id);
        if (!row) {
          q().push(queueRow(id, { user_id: args.p_user }));
        } else if (row.status === "running") {
          row.dirty = true;
        } else {
          Object.assign(row, { status: "pending", attempts: 0, last_reason: null, lease_token: null, dirty: false });
        }
        n++;
      }
      for (const id of (args.p_ensure as string[]) ?? []) {
        if (q().some((r) => r.session_id === id)) continue;
        q().push(queueRow(id, { user_id: args.p_user }));
        n++;
      }
      return { data: n, error: null };
    },
    memory_extraction_finish: (args) => {
      const row = q().find((r) => r.session_id === args.p_session && r.lease_token === args.p_token);
      if (!row) return { data: null, error: null };
      Object.assign(
        row,
        row.dirty
          ? { status: "pending", attempts: 0, last_reason: "requeued_during_run" }
          : {
              status: args.p_status,
              attempts: (args.p_attempts as number | null) ?? row.attempts,
              last_reason: args.p_reason,
            },
        { dirty: false, lease_token: null, lease_until: null },
      );
      return { data: row.status, error: null };
    },
  };
}

/** Fake claim: the first pending row becomes running with a fresh token (the SQL's own semantics are tested against Postgres). */
function makeWorld(sessionIds: string[], opts: Partial<Pick<World, "monthSpend" | "globalSum">> = {}): World {
  const world: World = {
    rows: {
      code_sessions: sessionIds.map((id) => sessionRow(id)),
      code_session_turns: sessionIds.flatMap((id) => turnsFor(id)),
      session_memories: [],
      memory_extraction_queue: sessionIds.map((id) => queueRow(id)),
    },
    monthSpend: opts.monthSpend ?? (() => 0),
    globalSum: opts.globalSum ?? (() => ({ data: 0, error: null })),
    claimArgs: [],
    spendArgs: [],
  };
  let token = 0;
  fakeSupabase = makeFakeSupabase(world.rows, {
    rpc: {
      memory_extraction_claim: (args) => {
        world.claimArgs.push(args);
        // 087/088: one live lease per user blocks any new claim.
        if (world.rows.memory_extraction_queue.some((r) => r.status === "running")) return { data: [], error: null };
        const row = world.rows.memory_extraction_queue.find((r) => r.status === "pending");
        if (!row) return { data: [], error: null };
        token++;
        Object.assign(row, {
          status: "running",
          lease_token: `t${token}`,
          attempts: row.attempts + 1,
          dirty: false,
        });
        return {
          data: [
            {
              session_id: row.session_id,
              lease_token: row.lease_token,
              attempts: row.attempts,
            },
          ],
          error: null,
        };
      },
      ...queueRpcs(world.rows),
      llm_spend_sum: (args) => {
        world.spendArgs.push(args);
        return { data: world.monthSpend(String(args.p_since)), error: null };
      },
      llm_spend_global_sum: (args) =>
        world.globalSum(String(args.p_since)) as {
          data: unknown;
          error: { message: string } | null;
        },
    },
  });
  return world;
}

function queue(world: World, sessionId: string): Row {
  const row = world.rows.memory_extraction_queue.find((r) => r.session_id === sessionId);
  if (!row) throw new Error(`no queue row ${sessionId}`);
  return row;
}

let lines: Record<string, unknown>[];
function memoryLines(): Record<string, unknown>[] {
  return lines.filter((l) => l.msg === "[memory-extraction]");
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of [
    "MEMBRAL_LLM_GLOBAL_DAILY_CEILING_USD",
    "MEMBRAL_MEMORY_MONTHLY_BUDGET_USD",
    "MEMBRAL_MEMORY_BACKFILL_SESSIONS",
    "MEMBRAL_MEMORY_SESSION_BUDGET_USD",
    "MEMBRAL_KG_COST_CAP_USD",
  ]) {
    delete process.env[k];
  }
  mockGetAppMode.mockResolvedValue("hosted");
  mockCheckFeature.mockResolvedValue({
    allowed: true,
    reason: "ok",
    spentUsd: 0,
    budgetUsd: null,
    dailyUsd: null,
    contact: "x",
  });
  lines = [];
  const capture = (line: unknown) => {
    try {
      lines.push(JSON.parse(String(line)));
    } catch {
      // not a structured line
    }
  };
  vi.spyOn(console, "log").mockImplementation(capture);
  vi.spyOn(console, "warn").mockImplementation(capture);
  vi.spyOn(console, "error").mockImplementation(capture);
});

/** Like the real factory, the client's hard cap is the `capUsdOverride` it was given. */
function guardOk() {
  const flushSpend = vi.fn().mockResolvedValue(undefined);
  const made: { chatCreate?: ReturnType<typeof vi.fn> } = {};
  mockCreateCostGuardedLlm.mockImplementation(async (_s: unknown, _u: unknown, opts: { capUsdOverride?: number }) => {
    const guarded = makeGuardedLlm(opts.capUsdOverride);
    made.chatCreate = guarded.chatCreate;
    return { ok: true, llm: guarded.llm, flushSpend };
  });
  return {
    chatCalls: () => made.chatCreate?.mock.calls.length ?? 0,
    flushSpend,
  };
}

describe("processNextMemoryExtraction — one session per invocation", () => {
  it("claims ONE pending session, extracts it, flushes spend, marks it done and lets the chain continue", async () => {
    const world = makeWorld(["s1", "s2"]);
    const { chatCalls, flushSpend } = guardOk();

    const step = await processNextMemoryExtraction("u1", { now: NOW });

    expect(step).toMatchObject({
      outcome: "done",
      sessionId: "s1",
      continueChain: true,
    });
    expect(chatCalls()).toBe(2); // s1 only: main window + user-turn pass
    expect(flushSpend).toHaveBeenCalledTimes(1);
    expect(queue(world, "s1")).toMatchObject({
      status: "done",
      lease_token: null,
      lease_until: null,
    });
    expect(queue(world, "s2").status).toBe("pending"); // untouched: the next invocation's job
    expect(world.rows.session_memories.map((r) => r.code_session_id)).toEqual(["s1"]);
    expect(memoryLines().map((l) => l.event)).toEqual(["run", "done"]);
    expect(memoryLines()[1]).toMatchObject({
      session_id: "s1",
      records_written: 1,
    });
  });

  it("returns none_claimed (chain stops) when nothing is pending — no gate is even checked", async () => {
    makeWorld([]);
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toEqual({ outcome: "none_claimed", continueChain: false });
    expect(mockCheckFeature).not.toHaveBeenCalled();
    expect(mockCreateCostGuardedLlm).not.toHaveBeenCalled();
  });

  it("gates on the `memory` feature, never `llm` (review M1)", async () => {
    makeWorld(["s1"]);
    guardOk();
    await processNextMemoryExtraction("u1", { now: NOW });
    expect(mockCheckFeature.mock.calls.map((c) => c[1])).toEqual(["memory"]);
  });

  it("passes the max age from MEMBRAL_MEMORY_BACKFILL_MAX_AGE_DAYS to the claim (100)", async () => {
    const world = makeWorld([]);
    await processNextMemoryExtraction("u1", {
      now: NOW,
      env: { MEMBRAL_MEMORY_BACKFILL_MAX_AGE_DAYS: "7" },
    });
    expect(world.claimArgs[0]).toMatchObject({ p_user: "u1", p_max_age_days: 7 });
  });

  it("passes the backfill window and a lease longer than tail-capture's own lock to the claim", async () => {
    const world = makeWorld([]);
    await processNextMemoryExtraction("u1", {
      now: NOW,
      env: { MEMBRAL_MEMORY_BACKFILL_SESSIONS: "7" },
    });
    expect(world.claimArgs[0]).toMatchObject({
      p_user: "u1",
      p_backfill_limit: 7,
      p_lease_seconds: MEMORY_LEASE_SECONDS,
      p_max_age_days: 30,
    });
    expect(MEMORY_LEASE_SECONDS * 1000).toBeGreaterThan(MEMORY_EXTRACTION_LOCK_STALE_MS);
    expect(MEMORY_LEASE_SECONDS).toBeGreaterThan(300); // outlives extract-next's maxDuration
  });

  it("N3: a session error releases the row to pending with the attempt counted, and stops the chain", async () => {
    const world = makeWorld(["s1", "s2"]);
    world.rows.code_sessions.length = 0; // runTailCaptureForSession throws "no such session"
    const { flushSpend } = guardOk();
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({ outcome: "released", reason: "session_error", continueChain: false });
    expect(queue(world, "s1")).toMatchObject({ status: "pending", attempts: 1, last_reason: "session_error" });
    expect(queue(world, "s2")).toMatchObject({ status: "pending", attempts: 0 }); // untouched
    expect(flushSpend).toHaveBeenCalled();
  });

  it("N3: a session error on the last allowed attempt marks it failed", async () => {
    const world = makeWorld(["s1"]);
    queue(world, "s1").attempts = MEMORY_MAX_ATTEMPTS - 1;
    world.rows.code_sessions.length = 0;
    guardOk();
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({ outcome: "failed", reason: "session_error" });
    expect(queue(world, "s1")).toMatchObject({ status: "failed", attempts: MEMORY_MAX_ATTEMPTS });
  });

  it("N3: a failed window (provider error) is never done — released, attempt counted", async () => {
    const world = makeWorld(["s1"]);
    const flushSpend = vi.fn().mockResolvedValue(undefined);
    const client: OpenAILike = {
      chat: { completions: { create: vi.fn().mockRejectedValue(new Error("503 upstream")) } },
      embeddings: { create: vi.fn() },
    };
    mockCreateCostGuardedLlm.mockResolvedValue({ ok: true, llm: new LlmClient(CONFIG, { client }), flushSpend });
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({ outcome: "released", reason: "windows_failed", continueChain: false });
    expect(queue(world, "s1")).toMatchObject({ status: "pending", attempts: 1, last_reason: "windows_failed" });
  });

  it("N3: no model key stops the chain after touching ONE row, attempt uncounted", async () => {
    const world = makeWorld(["s1", "s2", "s3"]);
    mockCreateCostGuardedLlm.mockRejectedValue(new Error("Missing OPENAI_API_KEY (or set MEMBRAL_MODEL_BASE_URL ...)"));
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({ outcome: "released", reason: "no_model_key", continueChain: false });
    expect(queue(world, "s1")).toMatchObject({ status: "pending", attempts: 0, last_reason: "no_model_key" });
    expect(world.claimArgs).toHaveLength(1);
    expect([queue(world, "s2"), queue(world, "s3")].map((r) => r.last_reason)).toEqual([null, null]);
  });

  it("W7 D3: no model configured logs once per process at info, never as an error on every kick", async () => {
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    vi.stubEnv("VERCEL", "");
    resetNoModelLogForTests();
    const errorSpy = vi.spyOn(log, "error");
    const infoSpy = vi.spyOn(log, "info");
    try {
      mockCreateCostGuardedLlm.mockRejectedValue(new Error("Missing LLM key (set OPENAI_API_KEY, ...)"));
      for (let i = 0; i < 3; i++) {
        makeWorld(["s1"]);
        const step = await processNextMemoryExtraction("u1", { now: NOW });
        expect(step).toMatchObject({ outcome: "released", reason: "no_model_key" });
      }
      const offLines = infoSpy.mock.calls.filter(([m]) => String(m).includes("extraction is off"));
      expect(offLines).toHaveLength(1);
      expect(errorSpy.mock.calls.filter(([m]) => String(m).includes("could not be built"))).toHaveLength(0);
      // Any other config error is still an error.
      mockCreateCostGuardedLlm.mockRejectedValue(new Error("claude-code provider refused: hosted"));
      makeWorld(["s1"]);
      await processNextMemoryExtraction("u1", { now: NOW });
      expect(errorSpy.mock.calls.filter(([m]) => String(m).includes("could not be built"))).toHaveLength(1);
    } finally {
      errorSpy.mockRestore();
      infoSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("no model key off the local stack (hosted, or MEMBRAL_LOCAL unset) keeps log.error", async () => {
    resetNoModelLogForTests();
    const errorSpy = vi.spyOn(log, "error");
    try {
      mockCreateCostGuardedLlm.mockRejectedValue(new Error("Missing OPENAI_API_KEY"));
      for (const [local, vercel] of [
        ["1", "1"],
        ["", ""],
      ]) {
        vi.stubEnv("MEMBRAL_LOCAL", local);
        vi.stubEnv("VERCEL", vercel);
        errorSpy.mockClear();
        makeWorld(["s1"]);
        await processNextMemoryExtraction("u1", { now: NOW });
        expect(errorSpy.mock.calls.filter(([m]) => String(m).includes("could not be built"))).toHaveLength(1);
      }
    } finally {
      errorSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("N3: an unreadable feature flag releases (attempt counted) instead of a permanent skip", async () => {
    mockCheckFeature.mockResolvedValue({
      allowed: false,
      reason: "disabled",
      spentUsd: 0,
      budgetUsd: null,
      dailyUsd: null,
      contact: "x",
    });
    const world = makeWorld(["s1"]);
    const from = fakeSupabase.from;
    fakeSupabase.from = (t: string) =>
      t === "feature_flags"
        ? {
            select: () => ({
              eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "timeout" } }) }) }),
            }),
          }
        : from(t);
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({ outcome: "released", reason: "feature_flag_unreadable", continueChain: false });
    expect(queue(world, "s1")).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("a readable disabled flag is still a terminal skip", async () => {
    mockCheckFeature.mockResolvedValue({
      allowed: false,
      reason: "disabled",
      spentUsd: 0,
      budgetUsd: null,
      dailyUsd: null,
      contact: "x",
    });
    const world = makeWorld(["s1"]);
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({ outcome: "skipped", reason: "disabled" });
    expect(queue(world, "s1").status).toBe("skipped");
  });

  it("N2: builds the memory LLM client with per-call spend flush, a 60s timeout and at most 2 retries", async () => {
    makeWorld(["s1"]);
    guardOk();
    await processNextMemoryExtraction("u1", { now: NOW });
    expect(mockCreateCostGuardedLlm.mock.calls[0][2]).toMatchObject({
      flushEvery: 1,
      timeoutMs: MEMORY_LLM_TIMEOUT_MS,
      maxRetries: MEMORY_LLM_MAX_RETRIES,
    });
    expect(MEMORY_LLM_TIMEOUT_MS).toBe(60_000);
    expect(MEMORY_LLM_MAX_RETRIES).toBe(0);
  });

  it("N2: a deadline hit after progress releases uncounted and continues the chain; the next run resumes", async () => {
    // 500 reps (~25.5k chars) is just over WINDOW_TARGET_CHARS (24k) — still one window per
    // turn, without the 26000-rep (~1.3M-char) fixture's O(turnTokens) cost in every grounding
    // snapQuoteToSource call (a real CPU cost, not a fake-timer-able wait) that made this test
    // 1.2s locally and flaky-timeout (>5s) on a loaded CI runner.
    const big = "please always use zsh for scripts here, never bash ".repeat(500); // one window per turn
    const world = makeWorld(["s1"]);
    world.rows.code_session_turns = [0, 1, 2].map((idx) => ({
      session_id: "s1",
      user_id: "u1",
      idx,
      role: "user",
      kind: "prose",
      text: big,
      tool_name: null,
      file_path: null,
      ts: null,
      props: {},
    }));
    const { chatCalls } = guardOk();
    // Time jumps past the main-pass share after the first LLM call, but stays inside the full deadline.
    const clock = () => (chatCalls() >= 1 ? 0.6 * MEMORY_RUN_DEADLINE_MS : 0);
    const first = await processNextMemoryExtraction("u1", { now: NOW, clock });
    expect(first).toMatchObject({ outcome: "released", reason: "deadline_partial", continueChain: true });
    expect(queue(world, "s1")).toMatchObject({ status: "pending", attempts: 0 });
    expect(world.rows.code_sessions[0].props.memory_checkpoint_turn_idx).toBe(0);

    const second = await processNextMemoryExtraction("u1", { now: NOW });
    expect(second).toMatchObject({ outcome: "done", sessionId: "s1" });
    expect(world.rows.code_sessions[0].props.memory_checkpoint_turn_idx).toBe(2);
  });

  it("N2/R3-m1: every call's cutoff + its worst case + finish margin fits extract-next's maxDuration", () => {
    const worstChat = MEMORY_LLM_TIMEOUT_MS * (MEMORY_LLM_MAX_RETRIES + 1);
    expect(worstChat).toBe(60_000);
    expect(MEMORY_EMBED_MAX_RETRIES).toBe(2);
    expect(MEMORY_EMBED_WORST_CALL_MS).toBeGreaterThanOrEqual(MEMORY_EMBED_TIMEOUT_MS * (MEMORY_EMBED_MAX_RETRIES + 1));
    expect(MEMORY_RUN_DEADLINE_MS).toBe(230_000);
    const cutoff = (pass: keyof typeof MEMORY_PASS_DEADLINE_SHARE) =>
      MEMORY_PASS_DEADLINE_SHARE[pass] * MEMORY_RUN_DEADLINE_MS;
    expect(cutoff("main")).toBeCloseTo(120_000);
    expect(cutoff("user")).toBeCloseTo(160_000);
    expect(cutoff("reask")).toBeCloseTo(170_000);
    // The embedding call is the last call of a run.
    expect(cutoff("embed") + MEMORY_EMBED_WORST_CALL_MS + MEMORY_FINISH_MARGIN_MS).toBeLessThanOrEqual(
      MEMORY_MAX_DURATION_MS,
    );
    // Livelock guard: the last user window (and its retry-on-empty, gated on
    // the same cutoff) and a re-ask that started all end before the embed
    // cutoff, so a slow re-ask never makes the embed check discard the run.
    expect(cutoff("user") + worstChat).toBeLessThanOrEqual(cutoff("embed"));
    expect(cutoff("reask") + worstChat).toBeLessThanOrEqual(cutoff("embed") + 1e-6);
    expect(MEMORY_PASS_DEADLINE_SHARE.main).toBeLessThan(MEMORY_PASS_DEADLINE_SHARE.user);
    expect(MEMORY_PASS_DEADLINE_SHARE.user).toBeLessThan(MEMORY_PASS_DEADLINE_SHARE.reask);
    expect(MEMORY_PASS_DEADLINE_SHARE.reask).toBeLessThan(MEMORY_PASS_DEADLINE_SHARE.embed);
    expect(MEMORY_PASS_DEADLINE_SHARE.embed).toBe(1);
    const route = readFileSync(join(__dirname, "../../../app/api/memory/extract-next/route.ts"), "utf8");
    expect(route).toContain(`export const maxDuration = ${MEMORY_MAX_DURATION_MS / 1000};`);
  });

  it("N2: past the cutoff before re-ask/embeddings -> nothing written, lock released, attempt counted", async () => {
    const world = makeWorld(["s1"]);
    const { chatCalls } = guardOk();
    // Both passes run; the clock passes the full cutoff before the post-pass calls.
    const clock = () => (chatCalls() >= 2 ? MEMORY_RUN_DEADLINE_MS : 0);
    const step = await processNextMemoryExtraction("u1", { now: NOW, clock });
    expect(step).toMatchObject({ outcome: "released", reason: "deadline_no_progress", continueChain: false });
    expect(queue(world, "s1")).toMatchObject({ status: "pending", attempts: 1 });
    expect(world.rows.session_memories).toHaveLength(0);
    expect(world.rows.code_sessions[0].props.memory_extraction_lock).toBeUndefined();
    expect(world.rows.code_sessions[0].props.memory_checkpoint_turn_idx ?? null).toBeNull();
  });

  it("N2 livelock guard: a session too big for one run finishes 'done' over several runs, never 'failed'", async () => {
    // See the deadline-hit test above for why 500 reps, not 26000.
    const big = "please always use zsh for scripts here, never bash ".repeat(500); // one window per turn
    const world = makeWorld(["s1"]);
    world.rows.code_session_turns = [0, 1, 2, 3, 4, 5].map((idx) => ({
      session_id: "s1",
      user_id: "u1",
      idx,
      role: "user",
      kind: "prose",
      text: big,
      tool_name: null,
      file_path: null,
      ts: null,
      props: {},
    }));
    const { chatCalls } = guardOk();
    const clock = () => chatCalls() * 50_000; // every LLM call takes 50s
    const outcomes: string[] = [];
    for (let run = 0; run < 10; run++) {
      const step = await processNextMemoryExtraction("u1", {
        now: NOW,
        clock,
        env: { MEMBRAL_MEMORY_SESSION_BUDGET_USD: "1", MEMBRAL_KG_COST_CAP_USD: "5" },
      });
      outcomes.push(`${step.outcome}:${step.reason ?? ""}`);
      if (!step.continueChain || step.outcome === "done") break;
    }
    expect(outcomes.length).toBeGreaterThanOrEqual(2);
    expect(outcomes.slice(0, -1).every((o) => o === "released:deadline_partial")).toBe(true);
    expect(outcomes.at(-1)).toBe("done:");
    expect(queue(world, "s1")).toMatchObject({ status: "done" });
    expect(world.rows.code_sessions[0].props.memory_checkpoint_turn_idx).toBe(5);
  });

  it("N2/rule 4: a failed window stops the run's other windows and the chain (no immediate retry)", async () => {
    const world = makeWorld(["s1", "s2"]);
    world.rows.code_session_turns = [0, 1].map((idx) => ({
      session_id: "s1",
      user_id: "u1",
      idx,
      role: "user",
      kind: "prose",
      text: "please always use zsh for scripts here, never bash ".repeat(26000),
      tool_name: null,
      file_path: null,
      ts: null,
      props: {},
    }));
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("429 rate limited"), { status: 429 }));
    const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
    mockCreateCostGuardedLlm.mockResolvedValue({
      ok: true,
      llm: new LlmClient(CONFIG, { client }),
      flushSpend: vi.fn().mockResolvedValue(undefined),
    });
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(create).toHaveBeenCalledTimes(1); // window 1 and the user pass never started
    expect(step).toMatchObject({ outcome: "released", reason: "windows_failed", continueChain: false });
    expect(queue(world, "s1")).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("N2: a deadline hit with no progress counts the attempt and stops the chain", async () => {
    const world = makeWorld(["s1"]);
    guardOk();
    const step = await processNextMemoryExtraction("u1", { now: NOW, deadlineMs: 0 });
    expect(step).toMatchObject({ outcome: "released", reason: "deadline_no_progress", continueChain: false });
    expect(queue(world, "s1")).toMatchObject({ status: "pending", attempts: 1 });
  });

  it("N1: a re-upload mid-run keeps the row running (no second claim), then the finish sends it back to pending", async () => {
    const world = makeWorld(["s1"]);
    const { llm } = makeGuardedLlm();
    let midRun: Awaited<ReturnType<typeof processNextMemoryExtraction>> | undefined;
    const flushSpend = vi.fn().mockImplementation(async () => {
      if (midRun) return;
      await enqueueMemoryExtraction(fakeSupabase, "u1", { requeue: ["s1"] });
      expect(queue(world, "s1")).toMatchObject({ status: "running", dirty: true, attempts: 1 });
      midRun = await processNextMemoryExtraction("u1", { now: NOW });
    });
    mockCreateCostGuardedLlm.mockResolvedValue({ ok: true, llm, flushSpend });
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(midRun).toEqual({ outcome: "none_claimed", continueChain: false });
    expect(step.outcome).toBe("done");
    expect(queue(world, "s1")).toMatchObject({
      status: "pending",
      attempts: 0,
      dirty: false,
      lease_token: null,
      last_reason: "requeued_during_run",
    });
  });

  it("N1: a held props lock releases the row to pending uncounted — never done", async () => {
    const world = makeWorld(["s1"]);
    world.rows.code_sessions[0].props = { memory_extraction_lock: { run_id: "other", at: new Date().toISOString() } };
    guardOk();
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({ outcome: "released", reason: "session_locked", continueChain: false });
    expect(queue(world, "s1")).toMatchObject({ status: "pending", attempts: 0 });
  });
});

describe("per-session spend cap (review M2) and monthly budget", () => {
  it("caps the session at the REMAINING monthly budget when that is the tightest limit", async () => {
    makeWorld(["s1"], { monthSpend: () => 1.9 }); // $2/month default -> $0.10 left
    guardOk();
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    const opts = mockCreateCostGuardedLlm.mock.calls[0][2] as {
      capUsdOverride: number;
      bypassFeatureGate: boolean;
    };
    expect(opts.capUsdOverride).toBeCloseTo(0.1, 10);
    expect(opts.bypassFeatureGate).toBe(true);
    expect(step.capUsd).toBeCloseTo(0.1, 10);
  });

  it("caps at the session budget (min with the per-run cap) when every allowance is roomy", async () => {
    makeWorld(["s1"]);
    guardOk();
    await processNextMemoryExtraction("u1", { now: NOW });
    expect(mockCreateCostGuardedLlm.mock.calls[0][2]).toMatchObject({
      capUsdOverride: 0.25,
    });
  });

  it("caps at the global remaining when that is tightest", async () => {
    makeWorld(["s1"], { globalSum: () => ({ data: 1.95, error: null }) }); // $2/day default -> $0.05 left
    guardOk();
    await processNextMemoryExtraction("u1", { now: NOW });
    expect((mockCreateCostGuardedLlm.mock.calls[0][2] as { capUsdOverride: number }).capUsdOverride).toBeCloseTo(
      0.05,
      10,
    );
  });

  it("sums only memory passes since the UTC month start", async () => {
    const world = makeWorld(["s1"]);
    guardOk();
    await processNextMemoryExtraction("u1", { now: NOW });
    expect(world.spendArgs[0]).toMatchObject({
      p_user_id: "u1",
      p_since: "2026-09-01T00:00:00.000Z",
      p_include_passes: MEMORY_SPEND_PASSES,
    });
    // D-057: the session-issue association runs inside extraction and answers to the same budgets.
    expect(MEMORY_SPEND_PASSES).toEqual(["memory_backfill", "session_assoc", "memory_embedding"]);
  });

  it("month boundary: September's spend no longer counts on 1 October", async () => {
    expect(startOfUtcMonthIso(new Date("2026-09-30T23:59:59.999Z"))).toBe("2026-09-01T00:00:00.000Z");
    expect(startOfUtcMonthIso(new Date("2026-10-01T00:00:00.000Z"))).toBe("2026-10-01T00:00:00.000Z");
    // $2.50 spent on 30 September: exhausted in September, fresh in October.
    const monthSpend = (since: string) => (since < "2026-10-01T00:00:00.000Z" ? 2.5 : 0);

    const sept = makeWorld(["s1"], { monthSpend });
    guardOk();
    const late = await processNextMemoryExtraction("u1", {
      now: new Date("2026-09-30T23:59:00.000Z"),
    });
    expect(late).toMatchObject({
      outcome: "skipped_budget",
      reason: "monthly_budget_exhausted",
    });
    expect(queue(sept, "s1").status).toBe("skipped_budget");

    makeWorld(["s2"], { monthSpend });
    guardOk();
    const early = await processNextMemoryExtraction("u1", {
      now: new Date("2026-10-01T00:01:00.000Z"),
    });
    expect(early).toMatchObject({ outcome: "done", sessionId: "s2" });
  });

  it("an exhausted monthly budget leaves the session skipped_budget, logs a skip, builds no LLM client, stops the chain", async () => {
    const world = makeWorld(["s1"], { monthSpend: () => 2 });
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({
      outcome: "skipped_budget",
      continueChain: false,
    });
    expect(queue(world, "s1")).toMatchObject({
      status: "skipped_budget",
      last_reason: "monthly_budget_exhausted",
    });
    expect(mockCreateCostGuardedLlm).not.toHaveBeenCalled();
    expect(memoryLines()).toEqual([
      expect.objectContaining({
        event: "skip",
        reason: "monthly_budget_exhausted",
        session_id: "s1",
        spent_usd: 2,
        limit_usd: 2,
      }),
    ]);
  });

  it("open (self-hosted) mode has no monthly budget — spend is not even read", async () => {
    mockGetAppMode.mockResolvedValue("open");
    const world = makeWorld(["s1"], { monthSpend: () => 99 });
    guardOk();
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step.outcome).toBe("done");
    expect(world.spendArgs).toHaveLength(0);
  });

  it("a run the allowance (not the normal session budget) cut short is left skipped_budget and stops the chain", async () => {
    const world = makeWorld(["s1"], { monthSpend: () => 2 - 1e-9 }); // a hair left: the first call trips the cap
    guardOk();
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({
      outcome: "skipped_budget",
      reason: "allowance_reached",
      continueChain: false,
    });
    expect(queue(world, "s1").status).toBe("skipped_budget");
  });

  it("a feature budget_exhausted verdict leaves the session skipped_budget", async () => {
    mockCheckFeature.mockResolvedValue({
      allowed: false,
      reason: "budget_exhausted",
      spentUsd: 1,
      budgetUsd: 1,
      dailyUsd: null,
      contact: "x",
    });
    const world = makeWorld(["s1"]);
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({
      outcome: "skipped_budget",
      continueChain: false,
    });
    expect(queue(world, "s1").status).toBe("skipped_budget");
  });
});

describe("global daily ceiling fails closed (review M3)", () => {
  it("RPC missing (PGRST202, migration 087 not applied) -> skip logged, session released to pending, attempt uncounted", async () => {
    const world = makeWorld(["s1"], {
      globalSum: () => ({
        data: null,
        error: { message: "Could not find the function", code: "PGRST202" },
      }),
    });
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({
      outcome: "released",
      reason: "global_ceiling_unchecked",
      continueChain: false,
    });
    expect(queue(world, "s1")).toMatchObject({
      status: "pending",
      attempts: 0,
      lease_token: null,
    });
    expect(mockCreateCostGuardedLlm).not.toHaveBeenCalled();
    expect(memoryLines()).toEqual([
      expect.objectContaining({
        event: "skip",
        reason: "global_ceiling_unchecked",
      }),
    ]);
  });

  it("any other RPC error also fails closed", async () => {
    makeWorld(["s1"], {
      globalSum: () => ({ data: null, error: { message: "timeout" } }),
    });
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step.outcome).toBe("released");
    expect(mockCreateCostGuardedLlm).not.toHaveBeenCalled();
  });

  it("ceiling reached -> released with reason global_daily_ceiling", async () => {
    makeWorld(["s1"], { globalSum: () => ({ data: "2.0001", error: null }) });
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({
      outcome: "released",
      reason: "global_daily_ceiling",
    });
  });

  it("issue #335: global MONTHLY ceiling reached (daily under) -> released with reason global_monthly_ceiling", async () => {
    // NOW is 2026-09-25: the daily window starts that day, the monthly on the 1st.
    makeWorld(["s1"], {
      globalSum: (since) =>
        since === "2026-09-01T00:00:00.000Z" ? { data: "30", error: null } : { data: "0.5", error: null },
    });
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({ outcome: "released", reason: "global_monthly_ceiling" });
    expect(mockCreateCostGuardedLlm).not.toHaveBeenCalled();
  });

  it("issue #335 review: the factory's own global re-check refuses (race) -> released, not skipped", async () => {
    const world = makeWorld(["s1"]);
    mockCreateCostGuardedLlm.mockResolvedValue({
      ok: false,
      reason: "global_ceiling_exceeded",
      detail: "global_daily_ceiling",
      spentUsd: 2,
      ceilingUsd: 2,
    });
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({ outcome: "released", reason: "global_daily_ceiling" });
    expect(queue(world, "s1")).toMatchObject({ status: "pending", attempts: 0 });
  });

  it("issue #335: monthly headroom below daily headroom caps the session", async () => {
    // Default monthly ceiling $30: $0.03 left this month, $2 left today.
    makeWorld(["s1"], {
      globalSum: (since) =>
        since === "2026-09-01T00:00:00.000Z" ? { data: 29.97, error: null } : { data: 0, error: null },
    });
    guardOk();
    await processNextMemoryExtraction("u1", { now: NOW });
    expect((mockCreateCostGuardedLlm.mock.calls[0][2] as { capUsdOverride: number }).capUsdOverride).toBeCloseTo(
      0.03,
      10,
    );
  });

  it("an unreadable monthly spend also fails closed (released, not failed)", async () => {
    const world = makeWorld(["s1"]);
    fakeSupabase.rpc = (
      (orig) => (name: string, args: Record<string, unknown>) =>
        name === "llm_spend_sum" ? Promise.resolve({ data: null, error: { message: "boom" } }) : orig(name, args)
    )(fakeSupabase.rpc);
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({
      outcome: "released",
      reason: "monthly_budget_unchecked",
    });
    expect(queue(world, "s1").status).toBe("pending");
  });
});

describe("enqueue + backfill config", () => {
  it("requeues changed sessions, queues unchanged ones only when missing, and logs a queued line", async () => {
    const rows: Record<string, Row[]> = {
      memory_extraction_queue: [
        queueRow("s1", { status: "done", attempts: 2 }),
        queueRow("s3", { status: "done", attempts: 1 }),
      ],
    };
    const args: Record<string, unknown>[] = [];
    const rpcs = queueRpcs(rows);
    fakeSupabase = makeFakeSupabase(rows, {
      rpc: {
        memory_extraction_enqueue: (a) => {
          args.push(a);
          return rpcs.memory_extraction_enqueue(a);
        },
      },
    });
    const n = await enqueueMemoryExtraction(fakeSupabase, "u1", { requeue: ["s1", "s2"], ensure: ["s3", "s4"] });
    expect(args[0]).toEqual({ p_user: "u1", p_requeue: ["s1", "s2"], p_ensure: ["s3", "s4"] });
    expect(n).toBe(3);
    const byId = Object.fromEntries(rows.memory_extraction_queue.map((r) => [r.session_id, r]));
    expect(byId.s1).toMatchObject({ status: "pending", attempts: 0 });
    expect(byId.s2).toMatchObject({ status: "pending", user_id: "u1" });
    expect(byId.s3).toMatchObject({ status: "done", attempts: 1 }); // unchanged content, row exists: untouched
    expect(byId.s4).toMatchObject({ status: "pending" }); // never queued (the cron's reconcile, R3-M1)
    expect(memoryLines()).toEqual([expect.objectContaining({ event: "queued", session_count: 3, user_id: "u1" })]);
  });

  it("enqueue throws on an RPC error (the upload route logs it and still succeeds, R3-M1)", async () => {
    fakeSupabase = makeFakeSupabase({});
    await expect(enqueueMemoryExtraction(fakeSupabase, "u1", { requeue: ["s1"] })).rejects.toThrow(
      /memory_extraction_enqueue failed/,
    );
  });

  it("backfill window defaults to 100 most recent sessions; invalid or negative -> 0 (review m2)", () => {
    expect(DEFAULT_MEMORY_BACKFILL_SESSIONS).toBe(100);
    expect(resolveMemoryBackfillSessions({})).toBe(100);
    expect(resolveMemoryBackfillSessions({ MEMBRAL_MEMORY_BACKFILL_SESSIONS: "20" })).toBe(20);
    expect(
      resolveMemoryBackfillSessions({
        MEMBRAL_MEMORY_BACKFILL_SESSIONS: "lots",
      }),
    ).toBe(0);
    expect(resolveMemoryBackfillSessions({ MEMBRAL_MEMORY_BACKFILL_SESSIONS: "-5" })).toBe(0);
  });

  it("max age defaults to 30 days; blank, invalid, 0 or negative -> 30; 36500 caps (disables) the bound", () => {
    expect(DEFAULT_MEMORY_BACKFILL_MAX_AGE_DAYS).toBe(30);
    expect(resolveMemoryBackfillMaxAgeDays({})).toBe(30);
    expect(resolveMemoryBackfillMaxAgeDays({ MEMBRAL_MEMORY_BACKFILL_MAX_AGE_DAYS: "" })).toBe(30);
    expect(resolveMemoryBackfillMaxAgeDays({ MEMBRAL_MEMORY_BACKFILL_MAX_AGE_DAYS: "off" })).toBe(30);
    expect(resolveMemoryBackfillMaxAgeDays({ MEMBRAL_MEMORY_BACKFILL_MAX_AGE_DAYS: "0" })).toBe(30);
    expect(resolveMemoryBackfillMaxAgeDays({ MEMBRAL_MEMORY_BACKFILL_MAX_AGE_DAYS: "-3" })).toBe(30);
    expect(resolveMemoryBackfillMaxAgeDays({ MEMBRAL_MEMORY_BACKFILL_MAX_AGE_DAYS: "7" })).toBe(7);
    expect(resolveMemoryBackfillMaxAgeDays({ MEMBRAL_MEMORY_BACKFILL_MAX_AGE_DAYS: "0.5" })).toBe(1);
    expect(resolveMemoryBackfillMaxAgeDays({ MEMBRAL_MEMORY_BACKFILL_MAX_AGE_DAYS: "9.9" })).toBe(9);
    expect(resolveMemoryBackfillMaxAgeDays({ MEMBRAL_MEMORY_BACKFILL_MAX_AGE_DAYS: "1e9" })).toBe(
      MAX_MEMORY_BACKFILL_MAX_AGE_DAYS,
    );
    expect(MAX_MEMORY_BACKFILL_MAX_AGE_DAYS).toBe(36500);
  });
});

describe("reconcileMemoryExtractionQueue (P10 round 3 R3-M1 / N-m4)", () => {
  const NOW_R = new Date("2026-09-25T03:30:00.000Z");

  function sessionRow(id: string, userId: string, overrides: Partial<Row> = {}): Row {
    return {
      id,
      user_id: userId,
      turn_count: 10,
      ended_at: "2026-09-24T10:00:00.000Z",
      started_at: "2026-09-24T09:00:00.000Z",
      created_at: "2026-09-24T10:01:00.000Z",
      checkpoint: 9,
      uncovered: 0,
      ...overrides,
    };
  }

  it("grew = more turns than the last run knew (checkpoint + uncovered)", () => {
    expect(sessionGrewSinceExtraction(10, 9, 0)).toBe(false);
    expect(sessionGrewSinceExtraction(12, 9, 0)).toBe(true);
    // A degrade/budget gap the last run already saw is not growth.
    expect(sessionGrewSinceExtraction(10, 5, 4)).toBe(false);
    expect(sessionGrewSinceExtraction(11, 5, 4)).toBe(true);
    // Never extracted (no checkpoint) with turns -> grew; empty session -> not.
    expect(sessionGrewSinceExtraction(3, null, undefined)).toBe(true);
    expect(sessionGrewSinceExtraction(0, null, undefined)).toBe(false);
  });

  it("ensures missing rows, requeues grown done rows, leaves the rest, through the enqueue RPC", async () => {
    const rows: Record<string, Row[]> = {
      code_sessions: [
        sessionRow("s-missing", "u1"),
        sessionRow("s-grown", "u1", { turn_count: 14 }),
        sessionRow("s-same", "u1"),
        sessionRow("s-running", "u1", { turn_count: 20 }),
        sessionRow("s-failed", "u1", { turn_count: 20 }),
        sessionRow("s-skipped", "u1", { turn_count: 20 }),
      ],
      memory_extraction_queue: [
        queueRow("s-grown", { status: "done", attempts: 1 }),
        queueRow("s-same", { status: "done" }),
        queueRow("s-running", { status: "running", lease_token: "t", lease_until: "2026-09-25T04:00:00.000Z" }),
        queueRow("s-failed", { status: "failed", attempts: 3 }),
        queueRow("s-skipped", { status: "skipped" }),
      ],
    };
    const args: Record<string, unknown>[] = [];
    const rpcs = queueRpcs(rows);
    fakeSupabase = makeFakeSupabase(rows, {
      rpc: {
        memory_extraction_enqueue: (a) => {
          args.push(a);
          return rpcs.memory_extraction_enqueue(a);
        },
      },
    });
    const summary = await reconcileMemoryExtractionQueue(fakeSupabase, { env: {}, now: NOW_R });
    expect(summary).toEqual({ users: 1, ensured: 1, requeued: 1, failedUsers: 0 });
    expect(args).toEqual([{ p_user: "u1", p_requeue: ["s-grown"], p_ensure: ["s-missing"] }]);
    const byId = Object.fromEntries(rows.memory_extraction_queue.map((r) => [r.session_id, r]));
    expect(byId["s-missing"]).toMatchObject({ status: "pending", user_id: "u1" });
    expect(byId["s-grown"]).toMatchObject({ status: "pending", attempts: 0 });
    expect(byId["s-same"]).toMatchObject({ status: "done" });
    expect(byId["s-running"]).toMatchObject({ status: "running", dirty: false });
    expect(byId["s-failed"]).toMatchObject({ status: "failed" });
    expect(byId["s-skipped"]).toMatchObject({ status: "skipped" });
  });

  it("bounds each user to the backfill window (most recent N) and filters on the last 14 days", async () => {
    const rows: Record<string, Row[]> = {
      code_sessions: [
        sessionRow("old", "u1", { ended_at: "2026-09-20T00:00:00.000Z" }),
        sessionRow("mid", "u1", { ended_at: "2026-09-22T00:00:00.000Z" }),
        sessionRow("new", "u1", { ended_at: "2026-09-24T00:00:00.000Z" }),
        sessionRow("other", "u2"),
      ],
      memory_extraction_queue: [],
    };
    const args: Record<string, unknown>[] = [];
    const rpcs = queueRpcs(rows);
    const fake = makeFakeSupabase(rows, {
      rpc: {
        memory_extraction_enqueue: (a) => {
          args.push(a);
          return rpcs.memory_extraction_enqueue(a);
        },
      },
    });
    const queries: { orFilters: string[] }[] = [];
    const spyFake = {
      ...fake,
      from(table: string) {
        const q = fake.from(table);
        if (table === "code_sessions") queries.push(q as unknown as { orFilters: string[] });
        return q;
      },
    } as unknown as typeof fake;
    const summary = await reconcileMemoryExtractionQueue(spyFake, {
      env: { MEMBRAL_MEMORY_BACKFILL_SESSIONS: "2" },
      now: NOW_R,
    });
    expect(summary.users).toBe(2);
    expect(args).toEqual([
      { p_user: "u1", p_requeue: [], p_ensure: ["new", "mid"] },
      { p_user: "u2", p_requeue: [], p_ensure: ["other"] },
    ]);
    expect(queries[0].orFilters).toEqual([
      "ended_at.gte.2026-09-11T03:30:00.000Z,and(ended_at.is.null,started_at.gte.2026-09-11T03:30:00.000Z),and(ended_at.is.null,started_at.is.null,created_at.gte.2026-09-11T03:30:00.000Z)",
    ]);
  });

  it("a per-user enqueue failure is logged and counted; other users still reconcile", async () => {
    const rows: Record<string, Row[]> = {
      code_sessions: [sessionRow("a", "u1"), sessionRow("b", "u2")],
      memory_extraction_queue: [],
    };
    const rpcs = queueRpcs(rows);
    fakeSupabase = makeFakeSupabase(rows, {
      rpc: {
        memory_extraction_enqueue: (a) =>
          a.p_user === "u1" ? { data: null, error: { message: "boom" } } : rpcs.memory_extraction_enqueue(a),
      },
    });
    const summary = await reconcileMemoryExtractionQueue(fakeSupabase, { env: {}, now: NOW_R });
    expect(summary).toMatchObject({ users: 2, failedUsers: 1, ensured: 1 });
    expect(memoryLines()).toContainEqual(
      expect.objectContaining({ event: "fail", reason: "reconcile_failed", user_id: "u1" }),
    );
  });

  it("ranks parents only for the window; a child follows its parent in or out (090)", async () => {
    // 3 parents (p1 newest .. p3 oldest) + 5 children, window = 2 parents.
    const rows: Record<string, Row[]> = {
      code_sessions: [
        sessionRow("p1", "u1", {
          ended_at: "2026-09-24T03:00:00.000Z",
          source: "claude-code",
          source_session_id: "p1",
        }),
        sessionRow("p2", "u1", {
          ended_at: "2026-09-23T03:00:00.000Z",
          source: "claude-code",
          source_session_id: "p2",
        }),
        sessionRow("p3", "u1", {
          ended_at: "2026-09-22T03:00:00.000Z",
          source: "claude-code",
          source_session_id: "p3",
        }),
        // children of p1 (in-window parent) — eligible despite not being one of the top 2 by their OWN recency
        sessionRow("c1a", "u1", {
          ended_at: "2026-09-12T00:00:00.000Z",
          source: "claude-code",
          source_session_id: "c1a",
          parent_source_session_id: "p1",
        }),
        sessionRow("c1b", "u1", {
          ended_at: "2026-09-12T00:00:00.000Z",
          source: "claude-code",
          source_session_id: "c1b",
          parent_source_session_id: "p1",
        }),
        // children of p2 (in-window parent)
        sessionRow("c2a", "u1", {
          ended_at: "2026-09-12T00:00:00.000Z",
          source: "claude-code",
          source_session_id: "c2a",
          parent_source_session_id: "p2",
        }),
        // children of p3 (OUT of window — window is top 2 parents) — must follow p3 out
        sessionRow("c3a", "u1", {
          ended_at: "2026-09-12T00:00:00.000Z",
          source: "claude-code",
          source_session_id: "c3a",
          parent_source_session_id: "p3",
        }),
        sessionRow("c3b", "u1", {
          ended_at: "2026-09-12T00:00:00.000Z",
          source: "claude-code",
          source_session_id: "c3b",
          parent_source_session_id: "p3",
        }),
      ],
      memory_extraction_queue: [],
    };
    const args: Record<string, unknown>[] = [];
    const rpcs = queueRpcs(rows);
    fakeSupabase = makeFakeSupabase(rows, {
      rpc: {
        memory_extraction_enqueue: (a) => {
          args.push(a);
          return rpcs.memory_extraction_enqueue(a);
        },
      },
    });
    const summary = await reconcileMemoryExtractionQueue(fakeSupabase, {
      env: { MEMBRAL_MEMORY_BACKFILL_SESSIONS: "2" },
      now: NOW_R,
    });
    expect(summary).toMatchObject({ users: 1, failedUsers: 0 });
    expect(args).toHaveLength(1);
    const ensured = new Set((args[0].p_ensure as string[]) ?? []);
    // Both in-window parents plus all 3 of their children ensured...
    for (const id of ["p1", "p2", "c1a", "c1b", "c2a"]) expect(ensured.has(id)).toBe(true);
    // ...p3 and its children fall outside the 2-parent window.
    for (const id of ["p3", "c3a", "c3b"]) expect(ensured.has(id)).toBe(false);
  });

  it("ignores sessions older than the max age, even inside the 14-day look-back (100)", async () => {
    const rows: Record<string, Row[]> = {
      code_sessions: [
        sessionRow("aged", "u1", { ended_at: "2026-09-20T00:00:00.000Z" }),
        sessionRow("fresh", "u1", { ended_at: "2026-09-24T00:00:00.000Z" }),
      ],
      memory_extraction_queue: [],
    };
    const args: Record<string, unknown>[] = [];
    const rpcs = queueRpcs(rows);
    const fake = makeFakeSupabase(rows, {
      rpc: {
        memory_extraction_enqueue: (a) => {
          args.push(a);
          return rpcs.memory_extraction_enqueue(a);
        },
      },
    });
    const queries: { orFilters: string[] }[] = [];
    const spyFake = {
      ...fake,
      from(table: string) {
        const q = fake.from(table);
        if (table === "code_sessions") queries.push(q as unknown as { orFilters: string[] });
        return q;
      },
    } as unknown as typeof fake;
    await reconcileMemoryExtractionQueue(spyFake, {
      env: { MEMBRAL_MEMORY_BACKFILL_MAX_AGE_DAYS: "3" },
      now: NOW_R,
    });
    expect(args).toEqual([{ p_user: "u1", p_requeue: [], p_ensure: ["fresh"] }]);
    expect(queries[0].orFilters[0]).toMatch(/^ended_at\.gte\.2026-09-22T03:30:00\.000Z,/);
  });

  // 100 parents (all inside the default 100-session window) x 3 children
  // each = 400 ids in `recent`, well past the ~200-id PostgREST 414 cliff
  // (arrival-loop.ts) that an unchunked `.in()` would hit here. Shared by
  // both the chunking test and the chunk-error test below (#277).
  function make400IdFixture(): Row[] {
    const parents: Row[] = [];
    for (let i = 0; i < 100; i++) {
      parents.push(
        sessionRow(`p${i}`, "u1", {
          ended_at: new Date(Date.parse("2026-09-24T00:00:00.000Z") - i * 60_000).toISOString(),
          source: "claude-code",
          source_session_id: `p${i}`,
        }),
      );
    }
    const children: Row[] = [];
    for (let i = 0; i < 100; i++) {
      for (let j = 0; j < 3; j++) {
        children.push(
          sessionRow(`c${i}-${j}`, "u1", {
            ended_at: "2026-09-12T00:00:00.000Z",
            source: "claude-code",
            source_session_id: `c${i}-${j}`,
            parent_source_session_id: `p${i}`,
          }),
        );
      }
    }
    return [...parents, ...children];
  }

  it("chunks the queue .in() lookup to 100 ids — 100 parents plus 300 children still reconcile correctly (#277)", async () => {
    const rows: Record<string, Row[]> = {
      code_sessions: make400IdFixture(),
      memory_extraction_queue: [],
    };
    const args: Record<string, unknown>[] = [];
    const rpcs = queueRpcs(rows);
    const fake = makeFakeSupabase(rows, {
      rpc: {
        memory_extraction_enqueue: (a) => {
          args.push(a);
          return rpcs.memory_extraction_enqueue(a);
        },
      },
    });
    // Same spy shape as the code_sessions orFilters spies above: wrap the
    // queue table's query so every `.in()` call's id-array length is
    // recorded, then let it run for real through the original method.
    const inLengths: number[] = [];
    const spyFake = {
      ...fake,
      from(table: string) {
        const q = fake.from(table);
        if (table === MEMORY_QUEUE_TABLE) {
          const originalIn = q.in.bind(q);
          q.in = (col: string, vals: unknown[]) => {
            inLengths.push(vals.length);
            return originalIn(col, vals);
          };
        }
        return q;
      },
    } as unknown as typeof fake;
    const summary = await reconcileMemoryExtractionQueue(spyFake, { env: {}, now: NOW_R });
    // Unchunked, this same fixture would be a single `.in()` call over all
    // 400 ids and the same result (nothing pre-queued -> everything ensured).
    expect(summary).toEqual({ users: 1, ensured: 400, requeued: 0, failedUsers: 0 });
    expect(inLengths.length).toBe(4);
    for (const len of inLengths) expect(len).toBeLessThanOrEqual(100);
    expect(inLengths.reduce((a, b) => a + b, 0)).toBe(400);
    expect(args).toHaveLength(1);
    expect(args[0].p_ensure).toHaveLength(400);
  });

  it("a failed chunk aborts the user's reconcile instead of being read as 'no rows' (#277)", async () => {
    const rows: Record<string, Row[]> = {
      code_sessions: make400IdFixture(),
      memory_extraction_queue: [],
    };
    const args: Record<string, unknown>[] = [];
    const rpcs = queueRpcs(rows);
    const fake = makeFakeSupabase(rows, {
      rpc: {
        memory_extraction_enqueue: (a) => {
          args.push(a);
          return rpcs.memory_extraction_enqueue(a);
        },
      },
    });
    let inCalls = 0;
    const spyFake = {
      ...fake,
      from(table: string) {
        const q = fake.from(table);
        if (table === MEMORY_QUEUE_TABLE) {
          const originalIn = q.in.bind(q);
          q.in = (col: string, vals: unknown[]) => {
            inCalls++;
            if (inCalls === 2) return Promise.resolve({ data: null, error: { message: "URI too long" } });
            return originalIn(col, vals);
          };
        }
        return q;
      },
    } as unknown as typeof fake;
    const summary = await reconcileMemoryExtractionQueue(spyFake, { env: {}, now: NOW_R });
    expect(summary).toEqual({ users: 1, ensured: 0, requeued: 0, failedUsers: 1 });
    expect(args).toHaveLength(0);
    expect(memoryLines()).toContainEqual(
      expect.objectContaining({ event: "fail", reason: "reconcile_failed", user_id: "u1" }),
    );
  });

  it("a backfill window of 0 reconciles nothing", async () => {
    fakeSupabase = makeFakeSupabase({ code_sessions: [sessionRow("a", "u1")] });
    const summary = await reconcileMemoryExtractionQueue(fakeSupabase, {
      env: { MEMBRAL_MEMORY_BACKFILL_SESSIONS: "0" },
      now: NOW_R,
    });
    expect(summary).toEqual({ users: 0, ensured: 0, requeued: 0, failedUsers: 0 });
  });
});

describe("migration 087 claim function — load-bearing clauses", () => {
  const sql = readFileSync(join(__dirname, "../../../../supabase/migrations/087_llm_spend_global_daily.sql"), "utf8");

  it("serialises per user, skips locked rows, reclaims expired leases, enforces the backfill window", () => {
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\('memory_extraction:' \|\| p_user::text, 0\)\)/);
    expect(sql).toMatch(/for update of c skip locked/);
    expect(sql).toMatch(/c\.status = 'running' and c\.lease_until <= now\(\)/);
    expect(sql).toMatch(/limit greatest\(p_backfill_limit, 0\)/);
    expect(sql).toMatch(
      /grant execute on function public\.memory_extraction_claim\(uuid, integer, integer, integer\) to service_role/,
    );
  });
});

describe("migration 090 — backfill window ranks parents, admits their children", () => {
  const sql = readFileSync(
    join(__dirname, "../../../../supabase/migrations/090_memory_backfill_window_parents.sql"),
    "utf8",
  );

  it("ranks only top-level sessions for the window, then unions in their children", () => {
    expect(sql).toMatch(/parent_window as \(/);
    expect(sql).toMatch(/cs\.parent_source_session_id is null/);
    expect(sql).toMatch(/limit greatest\(p_backfill_limit, 0\)/);
    expect(sql).toMatch(
      /join parent_window pw\s*\n\s*on pw\.source = child\.source\s*\n\s*and pw\.source_session_id = child\.parent_source_session_id/,
    );
    expect(sql).toMatch(/last_reason = 'outside_backfill_window'/);
    expect(sql).toMatch(
      /grant execute on function public\.memory_extraction_claim\(uuid, integer, integer, integer\) to service_role/,
    );
  });
});

describe("migration 100 — max age bounds the backfill window", () => {
  const sql = readFileSync(join(__dirname, "../../../../supabase/migrations/100_memory_backfill_max_age.sql"), "utf8");

  it("adds a defaulted p_max_age_days, filters parents by age before the limit, names the reason", () => {
    expect(sql).toMatch(/drop function if exists public\.memory_extraction_claim\(uuid, integer, integer, integer\);/);
    expect(sql).toMatch(/p_max_age_days integer default null/);
    expect(sql).toMatch(/make_interval\(days => least\(p_max_age_days, 36500\)\)/);
    expect(sql).toMatch(
      /and \(v_cutoff is null or coalesce\(cs\.ended_at, cs\.started_at, cs\.created_at\) > v_cutoff\)\s*\n\s*order by[^\n]*\n\s*limit greatest\(p_backfill_limit, 0\)/,
    );
    expect(sql).toMatch(/then 'older_than_max_age'\s*\n\s*else 'outside_backfill_window' end/);
    expect(sql).toMatch(
      /grant execute on function public\.memory_extraction_claim\(uuid, integer, integer, integer, integer\) to service_role/,
    );
    expect(sql).not.toMatch(/vector/);
  });
});

describe("migration 088 — dirty requeue, finish, claim", () => {
  const sql = readFileSync(
    join(__dirname, "../../../../supabase/migrations/088_memory_queue_dirty_requeue.sql"),
    "utf8",
  );

  it("enqueue never resets a running row; finish returns a dirty row to pending; claim clears dirty", () => {
    expect(sql).toMatch(/status\s+= case when q\.status = 'running' then 'running' else 'pending' end/);
    expect(sql).toMatch(/dirty\s+= \(q\.status = 'running'\)/);
    expect(sql).toMatch(/on conflict \(session_id\) do nothing/);
    expect(sql).toMatch(/status\s+= case when q\.dirty then 'pending' else p_status end/);
    expect(sql).toMatch(/and q\.lease_token = p_token/);
    expect(sql).toMatch(/dirty = false, -- 088/);
    expect(
      (sql.match(/pg_advisory_xact_lock\(hashtextextended\('memory_extraction:' \|\| p_user::text, 0\)\)/g) ?? [])
        .length,
    ).toBe(2);
    for (const fn of [
      "memory_extraction_enqueue(uuid, uuid[], uuid[])",
      "memory_extraction_finish(uuid, uuid, text, text, integer)",
    ]) {
      expect(sql).toContain(`revoke all on function public.${fn} from anon;`);
      expect(sql).toContain(`grant execute on function public.${fn} to service_role;`);
    }
  });
});

describe("issue #339: failed-window diagnostics (no behaviour change)", () => {
  const SENTINEL = "SENTINEL-TRANSCRIPT-7f3c";

  function worldWithSentinel(): World {
    const world = makeWorld(["s1", "s2"]);
    for (const t of world.rows.code_session_turns) {
      if (t.session_id === "s1") t.text = `${String(t.text)} ${SENTINEL}`;
    }
    return world;
  }

  function failingLlm(create: ReturnType<typeof vi.fn>) {
    const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
    mockCreateCostGuardedLlm.mockResolvedValue({
      ok: true,
      llm: new LlmClient(CONFIG, { client }),
      flushSpend: vi.fn().mockResolvedValue(undefined),
    });
  }

  const windowLines = () => lines.filter((l) => l.msg === "memory: extraction window failed");
  const failLine = () => memoryLines().find((l) => l.event === "fail" && l.reason === "windows_failed");

  it("a timeout logs is_timeout true and no status; the session fail line carries the counts", async () => {
    const world = worldWithSentinel();
    failingLlm(vi.fn().mockRejectedValue(new APIConnectionTimeoutError()));
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({ outcome: "released", reason: "windows_failed", continueChain: false });
    expect(queue(world, "s1")).toMatchObject({ status: "pending", attempts: 1, last_reason: "windows_failed" });
    const [w] = windowLines();
    expect(windowLines()).toHaveLength(1);
    expect(w).toMatchObject({
      level: "warn",
      session_id: "s1",
      pass: "main",
      window_index: 0,
      windows_total: 1,
      error_class: "APIConnectionTimeoutError",
      status: null,
      is_timeout: true,
      attempt: 1,
    });
    expect(typeof w.latency_ms).toBe("number");
    expect(failLine()).toMatchObject({
      session_id: "s1",
      failed_windows: 1,
      windows_total: 1,
      first_failure_status: null,
      first_failure_class: "APIConnectionTimeoutError",
      first_failure_is_timeout: true,
      attempt: 1,
    });
  });

  it("a 429 logs status 429 and a rate-limit class, on the window line and the session fail line", async () => {
    worldWithSentinel();
    const rateLimited = APIError.generate(
      429,
      { error: { message: "Rate limit reached for requests" } },
      undefined,
      new Headers(),
    );
    failingLlm(vi.fn().mockRejectedValue(rateLimited));
    await processNextMemoryExtraction("u1", { now: NOW });
    expect(windowLines()[0]).toMatchObject({ status: 429, error_class: "RateLimitError", is_timeout: false });
    expect(String(windowLines()[0].error_message)).toContain("Rate limit");
    expect(failLine()).toMatchObject({
      first_failure_status: 429,
      first_failure_class: "RateLimitError",
      first_failure_is_timeout: false,
      failed_windows: 1,
    });
  });

  it("no transcript text reaches any log line, even when the model echoes it in unparseable output", async () => {
    worldWithSentinel();
    // Not JSON: callJson's parse-failure error embeds this raw output (and so the sentinel).
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: `not json ${SENTINEL}` } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    failingLlm(create);
    await processNextMemoryExtraction("u1", { now: NOW });
    expect(windowLines()[0]).toMatchObject({ error_class: "RetryableJsonError", error_message: "json_parse_failed" });
    expect(failLine()).toMatchObject({ failed_windows: 1, first_failure_class: "RetryableJsonError" });
    for (const line of lines) expect(JSON.stringify(line)).not.toContain(SENTINEL);
  });

  it("retry-on-empty: a retry that fails to parse never puts its model output in a log line", async () => {
    worldWithSentinel();
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ records: [] }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      })
      .mockResolvedValue({
        choices: [{ message: { content: `not json RETRY-MARKER-91b2 ${SENTINEL}` } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    failingLlm(create);
    await processNextMemoryExtraction("u1", { now: NOW });
    const retryLines = lines.filter((l) => String(l.msg).includes("retry-on-empty call failed"));
    expect(retryLines.length).toBeGreaterThan(0);
    expect(retryLines[0]).toMatchObject({ error_class: "RetryableJsonError", error_message: "json_parse_failed" });
    for (const line of lines) {
      expect(JSON.stringify(line)).not.toContain("RETRY-MARKER-91b2");
      expect(JSON.stringify(line)).not.toContain(SENTINEL);
    }
  });

  it("an APIError whose body echoes a marker logs status, code and type but not the marker", async () => {
    worldWithSentinel();
    const err = APIError.generate(
      400,
      { error: { message: `echo BODY-MARKER-55aa ${SENTINEL}`, code: "bad_thing", type: "invalid_request_error" } },
      undefined,
      new Headers(),
    );
    failingLlm(vi.fn().mockRejectedValue(err));
    await processNextMemoryExtraction("u1", { now: NOW });
    expect(windowLines()[0]).toMatchObject({ status: 400, error_class: "APIError", error_message: "provider_error" });
    for (const line of lines) expect(JSON.stringify(line)).not.toContain("BODY-MARKER-55aa");
  });

  it("a 200 response carrying {error: {code: 429}} and no choices is reported as status 429", async () => {
    worldWithSentinel();
    failingLlm(vi.fn().mockResolvedValue({ error: { code: 429, message: `slow down ${SENTINEL}` } }));
    await processNextMemoryExtraction("u1", { now: NOW });
    expect(windowLines()[0]).toMatchObject({ status: 429, error_class: "RateLimitError" });
    expect(failLine()).toMatchObject({ first_failure_status: 429, failed_windows: 1 });
    for (const line of lines) expect(JSON.stringify(line)).not.toContain(SENTINEL);
  });
});

describe("issue #339: extract-next loops sessions in one invocation, never calls itself", () => {
  const BIG = "please always use zsh for scripts here, never bash ".repeat(500); // one window per turn

  const processAt = (id: string, o: Parameters<typeof processNextMemoryExtraction>[1]) =>
    processNextMemoryExtraction(id, { ...o, now: NOW });
  const invocationLine = () => memoryLines().find((l) => l.event === "invocation");

  function rateLimitedGuard() {
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("429 rate limited"), { status: 429 }));
    const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
    return { ok: true, llm: new LlmClient(CONFIG, { client }), flushSpend: vi.fn().mockResolvedValue(undefined) };
  }

  it("the start guard leaves room for one worst main window before the user cutoff; the cap is a small bound", () => {
    expect(MEMORY_MIN_REMAINING_TO_START_MS).toBe(130_000);
    const latestStart = MEMORY_RUN_DEADLINE_MS - MEMORY_MIN_REMAINING_TO_START_MS;
    expect(latestStart).toBe(100_000);
    // No setup margin any more: a late start that runs out of time is released uncounted.
    expect(latestStart + MEMORY_LLM_TIMEOUT_MS).toBeLessThanOrEqual(
      MEMORY_PASS_DEADLINE_SHARE.user * MEMORY_RUN_DEADLINE_MS + 1e-6,
    );
    expect(MEMORY_MAX_SESSIONS_PER_INVOCATION).toBe(20);
  });

  it("three pending sessions, all succeed: one invocation does all three and never fetches", async () => {
    const world = makeWorld(["s1", "s2", "s3"]);
    guardOk();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await runMemoryExtractionStep("u1", { process: processAt, clock: () => 0 });
    expect(r).toMatchObject({ sessionsProcessed: 3, stopReason: "none_claimed" });
    expect(r).not.toHaveProperty("chained");
    for (const id of ["s1", "s2", "s3"]) expect(queue(world, id)).toMatchObject({ status: "done", attempts: 1 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const line = invocationLine();
    expect(line).toMatchObject({ user_id: "u1", session_count: 3, reason: "none_claimed", duration_ms: 0 });
    expect(line).not.toHaveProperty("error");
  });

  it("a failed window on session 2 of 3 ends the invocation; session 3 stays pending, attempts unchanged", async () => {
    const world = makeWorld(["s1", "s2", "s3"]);
    let built = 0;
    mockCreateCostGuardedLlm.mockImplementation(async (_s: unknown, _u: unknown, opts: { capUsdOverride?: number }) => {
      built++;
      if (built === 2) return rateLimitedGuard();
      return {
        ok: true,
        llm: makeGuardedLlm(opts.capUsdOverride).llm,
        flushSpend: vi.fn().mockResolvedValue(undefined),
      };
    });
    const r = await runMemoryExtractionStep("u1", { process: processAt, clock: () => 0 });
    expect(r).toMatchObject({ sessionsProcessed: 2, stopReason: "windows_failed" });
    expect(r.step).toMatchObject({ sessionId: "s2", reason: "windows_failed", continueChain: false });
    expect(queue(world, "s1")).toMatchObject({ status: "done" });
    expect(queue(world, "s2")).toMatchObject({ status: "pending", attempts: 1, last_reason: "windows_failed" });
    expect(queue(world, "s3")).toMatchObject({ status: "pending", attempts: 0, lease_token: null });
    expect(world.claimArgs).toHaveLength(2);
  });

  it("too little time left: the next session is not claimed, its attempts unchanged, the stop reason logged", async () => {
    const world = makeWorld(["s1", "s2"]);
    guardOk();
    let t = 0;
    const r = await runMemoryExtractionStep("u1", {
      clock: () => t,
      process: async (id, o) => {
        const step = await processAt(id, o);
        t = 101_000; // 129s left < 130s
        return step;
      },
    });
    expect(r).toMatchObject({ sessionsProcessed: 1, stopReason: "too_little_time" });
    expect(world.claimArgs).toHaveLength(1);
    expect(queue(world, "s2")).toMatchObject({ status: "pending", attempts: 0, lease_token: null });
    expect(invocationLine()).toMatchObject({ session_count: 1, reason: "too_little_time", duration_ms: 101_000 });
  });

  it("deadline_partial ends the invocation; the row is pending again, uncounted, and claimable at once", async () => {
    const world = makeWorld(["s1", "s2"]);
    world.rows.code_session_turns = [
      ...[0, 1, 2].map((idx) => ({
        session_id: "s1",
        user_id: "u1",
        idx,
        role: "user",
        kind: "prose",
        text: BIG,
        tool_name: null,
        file_path: null,
        ts: null,
        props: {},
      })),
      ...turnsFor("s2"),
    ];
    const { chatCalls } = guardOk();
    const clock = () => (chatCalls() >= 1 ? 0.6 * MEMORY_RUN_DEADLINE_MS : 0);
    const r = await runMemoryExtractionStep("u1", { process: processAt, clock });
    expect(r).toMatchObject({ sessionsProcessed: 1, stopReason: "deadline_partial" });
    expect(queue(world, "s1")).toMatchObject({ status: "pending", attempts: 0, lease_token: null, lease_until: null });
    expect(queue(world, "s2")).toMatchObject({ status: "pending", attempts: 0 });
    expect(world.claimArgs).toHaveLength(1);
    const next = await processNextMemoryExtraction("u1", { now: NOW });
    expect(next).toMatchObject({ outcome: "done", sessionId: "s1" });
    expect(queue(world, "s1")).toMatchObject({ status: "done", attempts: 1 });
  });

  it("a failed window's log line carries the provider code and type, capped at 64 chars", async () => {
    makeWorld(["s1"]);
    const err = APIError.generate(
      400,
      { error: { message: "nope", code: "bad_thing", type: "x".repeat(40) } },
      undefined,
      new Headers(),
    );
    const client: OpenAILike = {
      chat: { completions: { create: vi.fn().mockRejectedValue(err) } },
      embeddings: { create: vi.fn() },
    };
    mockCreateCostGuardedLlm.mockResolvedValue({
      ok: true,
      llm: new LlmClient(CONFIG, { client }),
      flushSpend: vi.fn().mockResolvedValue(undefined),
    });
    await processNextMemoryExtraction("u1", { now: NOW });
    const w = lines.find((l) => l.msg === "memory: extraction window failed");
    expect(w).toMatchObject({ error_code: "bad_thing", error_type: "x".repeat(40) });
    expect(String(w?.error_type).length).toBeLessThanOrEqual(64);
  });

  it("the per-invocation session cap stops the loop", async () => {
    const world = makeWorld(["s1", "s2", "s3"]);
    guardOk();
    const r = await runMemoryExtractionStep("u1", { process: processAt, clock: () => 0, maxSessions: 2 });
    expect(r).toMatchObject({ sessionsProcessed: 2, stopReason: "session_cap" });
    expect(queue(world, "s3")).toMatchObject({ status: "pending", attempts: 0 });
    expect(world.claimArgs).toHaveLength(2);
  });

  it("the deadline is measured from the invocation's start, not the session's", async () => {
    // A step at t=200s of an invocation that began at t=0 has 30s left: past
    // every window cutoff, so no LLM call starts.
    const late = makeWorld(["s1"]);
    const { chatCalls } = guardOk();
    const step = await processNextMemoryExtraction("u1", { now: NOW, clock: () => 200_000, invocationStartedAt: 0 });
    expect(chatCalls()).toBe(0);
    expect(step).toMatchObject({ reason: "deadline_no_progress" });
    expect(queue(late, "s1")).toMatchObject({ attempts: 1 });

    // The same clock with no invocation start measures from the step itself: 230s, a full run.
    makeWorld(["s1"]);
    const fresh = guardOk();
    const own = await processNextMemoryExtraction("u1", { now: NOW, clock: () => 200_000 });
    expect(own).toMatchObject({ outcome: "done" });
    expect(fresh.chatCalls()).toBe(2);

    // In the loop (start guard off to expose it): session 2 starts at t=200s and gets no window;
    // as a late start it is released uncounted.
    const world = makeWorld(["s1", "s2"]);
    const loop = guardOk();
    let t = 0;
    const r = await runMemoryExtractionStep("u1", {
      clock: () => t,
      minRemainingMs: 0,
      process: async (id, o) => {
        const s = await processAt(id, o);
        t = 200_000;
        return s;
      },
    });
    expect(r).toMatchObject({ sessionsProcessed: 2, stopReason: "deadline_no_progress_late_start" });
    expect(queue(world, "s1")).toMatchObject({ status: "done" });
    expect(queue(world, "s2")).toMatchObject({
      status: "pending",
      attempts: 0,
      last_reason: "deadline_no_progress_late_start",
    });
    expect(loop.chatCalls()).toBe(0); // the last client built (session 2's) never called the model
  });

  it("FIX 3: the second session of an invocation ending with no progress is released uncounted", async () => {
    const world = makeWorld(["s1", "s2"]);
    queue(world, "s2").attempts = 1; // an earlier counted failure
    const loop = guardOk();
    let t = 0;
    const r = await runMemoryExtractionStep("u1", {
      clock: () => t,
      minRemainingMs: 0, // expose a start past every window cutoff
      process: async (id, o) => {
        const s = await processAt(id, o);
        t = 200_000;
        return s;
      },
    });
    expect(r).toMatchObject({ sessionsProcessed: 2, stopReason: "deadline_no_progress_late_start" });
    expect(r.step).toMatchObject({ outcome: "released", sessionId: "s2", continueChain: false });
    expect(loop.chatCalls()).toBe(0);
    expect(queue(world, "s1")).toMatchObject({ status: "done" });
    expect(queue(world, "s2")).toMatchObject({
      status: "pending",
      attempts: 1, // unchanged: the claim's +1 was given back
      lease_token: null,
      lease_until: null,
      last_reason: "deadline_no_progress_late_start",
    });
  });

  it("FIX 3: late start (step 2, started after the invocation) -> uncounted release with its own reason", async () => {
    const world = makeWorld(["s1"]);
    const { chatCalls } = guardOk();
    const step = await processNextMemoryExtraction("u1", {
      now: NOW,
      clock: () => 200_000,
      invocationStartedAt: 0,
      stepIndex: 1,
    });
    expect(chatCalls()).toBe(0);
    expect(step).toMatchObject({
      outcome: "released",
      reason: "deadline_no_progress_late_start",
      continueChain: false,
    });
    expect(queue(world, "s1")).toMatchObject({
      status: "pending",
      attempts: 0,
      lease_token: null,
      lease_until: null,
      last_reason: "deadline_no_progress_late_start",
    });
  });

  it("FIX 3: the same no-progress outcome as the invocation's FIRST step is counted, as before", async () => {
    const world = makeWorld(["s1"]);
    guardOk();
    const step = await processNextMemoryExtraction("u1", {
      now: NOW,
      clock: () => 200_000,
      invocationStartedAt: 0,
      stepIndex: 0,
    });
    expect(step).toMatchObject({ outcome: "released", reason: "deadline_no_progress", continueChain: false });
    expect(queue(world, "s1")).toMatchObject({ status: "pending", attempts: 1, last_reason: "deadline_no_progress" });
  });

  it("the 130s margin: a session may start at t=99s and may not at t=101s", async () => {
    for (const [at, starts] of [
      [99_000, true],
      [101_000, false],
    ] as const) {
      const world = makeWorld(["s1", "s2"]);
      guardOk();
      let t = 0;
      const r = await runMemoryExtractionStep("u1", {
        clock: () => t,
        process: async (id, o) => {
          const s = await processAt(id, o);
          t = at;
          return s;
        },
      });
      // Started means s2 was claimed (its attempt taken); refused means never claimed.
      expect(queue(world, "s2").attempts).toBe(starts ? 1 : 0);
      if (starts) expect(world.claimArgs.length).toBeGreaterThanOrEqual(2);
      else {
        expect(world.claimArgs).toHaveLength(1);
        expect(r.stopReason).toBe("too_little_time");
      }
    }
  });
});

describe("issue #339: a reply cut off at the output token limit", () => {
  const processAt = (id: string, o: Parameters<typeof processNextMemoryExtraction>[1]) =>
    processNextMemoryExtraction(id, { ...o, now: NOW });
  const RECORD = {
    kind: "learning",
    text: "Dark mode is now the default theme",
    quote: "Dark mode is now the default theme.",
    turn_idx: 1,
    turn_role: "assistant",
    durable: true,
    thread: "dark mode default",
  };

  function guardWith(contents: string[]) {
    // Session 1 of the invocation gets `contents` (cut off), later sessions a normal reply.
    let built = 0;
    const creates: ReturnType<typeof vi.fn>[] = [];
    mockCreateCostGuardedLlm.mockImplementation(async (_s: unknown, _u: unknown, opts: { capUsdOverride?: number }) => {
      built++;
      if (built > 1) {
        const g = makeGuardedLlm(opts.capUsdOverride);
        return { ok: true, llm: g.llm, flushSpend: vi.fn().mockResolvedValue(undefined) };
      }
      // After `contents`, a whole empty reply (the user pass's call, when it is not cut off).
      const create = vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"records": []}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      for (const content of contents) {
        create.mockResolvedValueOnce({
          choices: [{ message: { content }, finish_reason: "length" }],
          usage: { prompt_tokens: 9896, completion_tokens: 2000 },
        });
      }
      creates.push(create);
      const client: OpenAILike = {
        chat: { completions: { create } },
        embeddings: {
          create: vi.fn().mockResolvedValue({ data: [{ embedding: [1, 0, 0] }], usage: { prompt_tokens: 5 } }),
        },
      };
      return { ok: true, llm: new LlmClient(CONFIG, { client }), flushSpend: vi.fn().mockResolvedValue(undefined) };
    });
    return creates;
  }

  it("nothing salvageable: finished 'failed' with the content reason at attempt 1, and the invocation goes on", async () => {
    const world = makeWorld(["s1", "s2"]);
    const cut = '{"records": [{"kind": "learning", "text": "CUT-MARKER-5e1 half a rec';
    const creates = guardWith([cut, cut, cut]);
    const r = await runMemoryExtractionStep("u1", { process: processAt, clock: () => 0 });
    const failedRow = [queue(world, "s1"), queue(world, "s2")].find((q) => q.status === "failed");
    expect(failedRow).toMatchObject({ status: "failed", attempts: 1, last_reason: "windows_failed_content" });
    const other = [queue(world, "s1"), queue(world, "s2")].find((q) => q !== failedRow);
    expect(other).toMatchObject({ status: "done" });
    expect(r).toMatchObject({ sessionsProcessed: 2, stopReason: "none_claimed" });
    // One request per pass window: a cut-off reply is never resent.
    expect(creates[0].mock.calls.length).toBeLessThanOrEqual(2);
    const fail = memoryLines().find((l) => l.event === "fail");
    expect(fail).toMatchObject({ reason: "windows_failed_content", first_failure_class: "OutputTruncated" });
    const windowLine = lines.find((l) => l.msg === "memory: extraction window failed");
    expect(windowLine).toMatchObject({
      error_class: "OutputTruncated",
      error_message: "output_truncated",
      is_timeout: false,
    });
    for (const line of lines) expect(JSON.stringify(line)).not.toContain("CUT-MARKER-5e1");
  });

  it("complete records before the cut: the session is done and one salvage line is logged", async () => {
    const world = makeWorld(["s1"]);
    const cut = `{"records": [${JSON.stringify(RECORD)}, {"kind": "decision", "text": "CUT-MARKER-77a half`;
    guardWith([cut]);
    const step = await processNextMemoryExtraction("u1", { now: NOW });
    expect(step).toMatchObject({ outcome: "done", continueChain: true });
    expect(queue(world, "s1")).toMatchObject({ status: "done" });
    const salvage = memoryLines().filter((l) => l.event === "salvage");
    expect(salvage).toHaveLength(1);
    expect(salvage[0]).toMatchObject({
      reason: "output_truncated",
      window_index: 0,
      records_recovered: 1,
      tokens_out: 2000,
    });
    const done = memoryLines().find((l) => l.event === "done");
    expect(Number(done?.records_written)).toBeGreaterThanOrEqual(1);
    for (const line of lines) expect(JSON.stringify(line)).not.toContain("CUT-MARKER-77a");
  });

  for (const [label, content] of [
    ["empty", ""],
    ["malformed with finish_reason stop", "not { json"],
  ] as const) {
    it(`replies all ${label}: the first session is counted and pending, the invocation stops, none is terminal`, async () => {
      const world = makeWorld(["s1", "s2", "s3"]);
      const create = vi.fn().mockResolvedValue({
        choices: [{ message: { content }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
      const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
      mockCreateCostGuardedLlm.mockResolvedValue({
        ok: true,
        llm: new LlmClient(CONFIG, { client }),
        flushSpend: vi.fn().mockResolvedValue(undefined),
      });
      const r = await runMemoryExtractionStep("u1", { process: processAt, clock: () => 0 });
      expect(r).toMatchObject({ sessionsProcessed: 1, stopReason: "windows_failed" });
      expect(r.step).toMatchObject({ outcome: "released", reason: "windows_failed", continueChain: false });
      expect(world.claimArgs).toHaveLength(1);
      const rows = ["s1", "s2", "s3"].map((id) => queue(world, id));
      expect(rows.filter((q) => q.attempts === 1)).toHaveLength(1);
      expect(rows.find((q) => q.attempts === 1)).toMatchObject({ status: "pending", last_reason: "windows_failed" });
      expect(rows.filter((q) => q.attempts === 0 && q.status === "pending")).toHaveLength(2);
      expect(rows.some((q) => q.status === "failed")).toBe(false);
    });
  }

  it("a 429 still behaves as before: pending, attempt counted, the invocation stops", async () => {
    const world = makeWorld(["s1", "s2"]);
    const create = vi.fn().mockRejectedValue(Object.assign(new Error("429 rate limited"), { status: 429 }));
    const client: OpenAILike = { chat: { completions: { create } }, embeddings: { create: vi.fn() } };
    mockCreateCostGuardedLlm.mockResolvedValue({
      ok: true,
      llm: new LlmClient(CONFIG, { client }),
      flushSpend: vi.fn().mockResolvedValue(undefined),
    });
    const r = await runMemoryExtractionStep("u1", { process: processAt, clock: () => 0 });
    expect(r).toMatchObject({ sessionsProcessed: 1, stopReason: "windows_failed" });
    const touched = [queue(world, "s1"), queue(world, "s2")].find((q) => q.attempts === 1);
    expect(touched).toMatchObject({ status: "pending", attempts: 1, last_reason: "windows_failed" });
  });
});
