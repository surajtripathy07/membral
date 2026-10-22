import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateEmbedding = vi.fn();
vi.mock("@/lib/embeddings", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
  EmbeddingCeilingExceededError: class EmbeddingCeilingExceededError extends Error {},
}));
vi.mock("@/lib/feature-flags", () => ({
  FeatureDisabledError: class FeatureDisabledError extends Error {},
}));

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { log } from "@/lib/log";
import { createEmbedBreaker, EMBED_BREAKER_OPEN_MS, EMBED_BREAKER_WINDOW_MS } from "../embed-breaker";
import { buildPromptRecall } from "../prompt-recall";
import { memorySearch } from "../search";

const USER = "user-1";
const PROJECT = "proj-a";
// The prompt-recall default (the hop-1 cutoff); memorySearch caps the wait at cutoff minus the 500 ms verify reserve.
const DEADLINE = 1500;
const EMBED_WAIT = 1000;

function rec(id: string, extra: Partial<Row>): Row {
  return {
    id,
    code_session_id: "sess-1",
    code_project_id: PROJECT,
    agent_id: null,
    source: "hook",
    kind: "decision",
    text: `record ${id}`,
    quote: `record ${id}`,
    turn_idx: 0,
    turn_role: "assistant",
    ref: null,
    ref_kind: null,
    branch: null,
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
    created_at: "2026-09-10T00:00:00Z",
    leg_score: 0.02,
    ...extra,
  };
}

const rpcCalls: Record<string, unknown>[] = [];
// The stand-in for memory_search_scored: a null embedding gets keyword rows only (no similarity), a vector gets both.
function makeDb() {
  const strong = (v: boolean) => rec("strong", { similarity: v ? 0.7 : null, lex_hits: 3, query_lexemes: 4 });
  const weak = (v: boolean) => rec("weak", { similarity: v ? 0.2 : null, lex_hits: 1, query_lexemes: 4 });
  return makeFakeSupabase(
    {
      code_session_turns: [{ session_id: "sess-1", idx: 0, text: "x", props: {} }],
      code_projects: [{ id: PROJECT, display_name: "a", repo_identity: "a" }],
      memory_branch_state: [],
      conversations: [],
    },
    {
      rpc: {
        memory_search_scored: (args: Record<string, unknown>) => {
          rpcCalls.push(args);
          const v = args.p_query_embedding != null;
          return { data: [strong(v), weak(v)], error: null };
        },
      },
    },
  );
}

const VEC = new Array(4).fill(0.5);
const opts = (extra: Record<string, unknown> = {}) => ({
  floor: true,
  logEvent: false,
  embedDeadlineMs: DEADLINE,
  embedBreaker: createEmbedBreaker(),
  ...extra,
});
const timingsLog = () => {
  const call = vi
    .mocked(log.info)
    .mock.calls.filter((c) => c[0] === "memory_search timings")
    .at(-1);
  return call?.[1] as Record<string, unknown>;
};

/** An embedding that resolves after `ms` or rejects when its signal aborts. */
function slowEmbed(ms: number, signals: AbortSignal[] = []) {
  mockGenerateEmbedding.mockImplementation(
    (_t: string, o: { signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        if (o.signal) {
          signals.push(o.signal);
          o.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }
        setTimeout(() => resolve(VEC), ms);
      }),
  );
}

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  vi.useFakeTimers();
  rpcCalls.length = 0;
  mockGenerateEmbedding.mockReset();
  vi.spyOn(log, "info").mockImplementation(() => undefined);
  vi.spyOn(log, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("memorySearch embedding deadline", () => {
  it("a fast embedding gives the same fused search as no deadline (same RPC args, same records)", async () => {
    mockGenerateEmbedding.mockResolvedValue(VEC);
    const baseline = await memorySearch(
      makeDb(),
      USER,
      PROJECT,
      { query: "cache key layout" },
      { floor: true, logEvent: false },
    );
    const baselineFused = rpcCalls.filter((a) => a.p_query_embedding != null);
    rpcCalls.length = 0;
    const withDeadline = await memorySearch(makeDb(), USER, PROJECT, { query: "cache key layout" }, opts());
    const fused = rpcCalls.filter((a) => a.p_query_embedding != null);
    expect(fused).toEqual(baselineFused);
    expect(withDeadline.records.map((r) => r.id)).toEqual(baseline.records.map((r) => r.id));
    expect(timingsLog()).toMatchObject({ embedding_skipped: false, embed_deadline_ms: EMBED_WAIT });
  });

  it("a slow embedding is aborted and the keyword rows are served under the lexical floor", async () => {
    const signals: AbortSignal[] = [];
    slowEmbed(5_000, signals);
    const p = memorySearch(makeDb(), USER, PROJECT, { query: "cache key layout" }, opts());
    await vi.advanceTimersByTimeAsync(DEADLINE + 1);
    const result = await p;
    expect(signals[0].aborted).toBe(true);
    expect(rpcCalls.every((a) => a.p_query_embedding === null)).toBe(true);
    // strong (3 of 4 lexemes) passes rule (b); weak (1 hit) does not, though no vector means no similarity floor at all
    expect(result.records.map((r) => r.id)).toEqual(["strong"]);
    expect(result.degraded).toMatch(/missed its deadline/);
    expect(result.degraded).not.toMatch(/every keyword match is served/);
    expect(timingsLog()).toMatchObject({ embedding_skipped: true, embed_deadline_ms: EMBED_WAIT });
  });

  it("a rejecting embedding falls back the same way and never throws", async () => {
    mockGenerateEmbedding.mockRejectedValue(new Error("provider 500"));
    const result = await memorySearch(makeDb(), USER, PROJECT, { query: "cache key layout" }, opts());
    expect(result.records.map((r) => r.id)).toEqual(["strong"]);
    expect(timingsLog()).toMatchObject({ embedding_skipped: true });
  });

  it("without a deadline the search waits for the vector and logs embedding_skipped false", async () => {
    mockGenerateEmbedding.mockResolvedValue(VEC);
    await memorySearch(makeDb(), USER, PROJECT, { query: "cache key layout" }, { logEvent: false });
    expect(timingsLog()).toMatchObject({ embedding_skipped: false, embed_deadline_ms: null });
    expect(rpcCalls).toHaveLength(1);
  });
});

describe("embed breaker", () => {
  it("opens after 3 deadline skips in 60 s, skips without waiting for 30 s, then closes", async () => {
    let t = 1_000_000;
    const breaker = createEmbedBreaker(() => t);
    slowEmbed(60_000);
    const run = async () => {
      const p = memorySearch(makeDb(), USER, PROJECT, { query: "cache key layout" }, opts({ embedBreaker: breaker }));
      await vi.advanceTimersByTimeAsync(DEADLINE + 1);
      return p;
    };
    for (let i = 0; i < 3; i++) {
      await run();
      t += 1_000;
    }
    expect(breaker.isOpen()).toBe(true);

    // Open: resolves with no timer advance, and no embedding call is made.
    mockGenerateEmbedding.mockClear();
    const quick = await memorySearch(
      makeDb(),
      USER,
      PROJECT,
      { query: "cache key layout" },
      opts({ embedBreaker: breaker }),
    );
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(quick.records.map((r) => r.id)).toEqual(["strong"]);
    expect(timingsLog()).toMatchObject({ embedding_skipped: true, embedding_breaker: "open" });

    t += EMBED_BREAKER_OPEN_MS + 1;
    expect(breaker.isOpen()).toBe(false);
  });

  it("skips spread over more than the window do not open it", () => {
    let t = 0;
    const breaker = createEmbedBreaker(() => t);
    for (let i = 0; i < 4; i++) {
      breaker.recordSkip();
      t += EMBED_BREAKER_WINDOW_MS / 2 + 1;
    }
    expect(breaker.isOpen()).toBe(false);
  });
});

describe("buildPromptRecall hop 1 (default deadline)", () => {
  const PROMPT = "how is the cache key layout decided for the build step";
  const run = (p: ReturnType<typeof buildPromptRecall>) => p;

  it("fast embedding: serves the fused result and reports no skip", async () => {
    mockGenerateEmbedding.mockResolvedValue(VEC);
    const out = await buildPromptRecall(
      makeDb(),
      USER,
      PROJECT,
      { prompt: PROMPT, repo: "a" },
      { now: new Date("2026-10-08T12:00:00Z") },
    );
    expect(out.embedding_skipped).toBeUndefined();
    expect(out.embed_deadline_ms).toBe(EMBED_WAIT);
    expect(rpcCalls.some((a) => a.p_query_embedding != null)).toBe(true);
  });

  it("slow embedding: the 1.5 s budget is not hit, the embedding is aborted, skip is reported", async () => {
    const signals: AbortSignal[] = [];
    slowEmbed(10_000, signals);
    const p = run(
      buildPromptRecall(
        makeDb(),
        USER,
        PROJECT,
        { prompt: PROMPT, repo: "a" },
        { now: new Date("2026-10-08T12:00:00Z") },
      ),
    );
    await vi.advanceTimersByTimeAsync(DEADLINE + 1);
    const out = await p;
    expect(out.skipped).not.toBe("timeout");
    expect(out.embedding_skipped).toBe(true);
    expect(out.embed_deadline_ms).toBe(EMBED_WAIT);
    expect(signals[0].aborted).toBe(true);
    expect(out.stages_ms).toHaveProperty("embed_query");
  });
});

// A lazy fake of the PostgREST builder: every then() starts a new "request", as the real one does.
function lazyDb(fused: { delayMs?: number; reject?: boolean } = {}) {
  const db = makeDb();
  const executions: Array<number[] | null> = [];
  const rows = (v: boolean) => [
    rec("strong", { similarity: v ? 0.7 : null, lex_hits: 3, query_lexemes: 4 }),
    rec("weak", { similarity: v ? 0.2 : null, lex_hits: 1, query_lexemes: 4 }),
  ];
  class LazyBuilder implements PromiseLike<unknown> {
    constructor(private args: Record<string, unknown>) {}
    // biome-ignore lint/suspicious/noThenProperty: a lazy thenable is the point, it mimics the PostgREST builder
    then<R1 = unknown, R2 = never>(
      res?: ((v: unknown) => R1 | PromiseLike<R1>) | null,
      rej?: ((e: unknown) => R2 | PromiseLike<R2>) | null,
    ): PromiseLike<R1 | R2> {
      executions.push(this.args.p_query_embedding as number[] | null);
      const isFused = this.args.p_query_embedding != null;
      const result = new Promise<unknown>((resolve, reject) => {
        const settle = () =>
          isFused && fused.reject ? reject(new Error("rpc boom")) : resolve({ data: rows(isFused), error: null });
        if (isFused && fused.delayMs) setTimeout(settle, fused.delayMs);
        else settle();
      });
      return result.then(res, rej);
    }
  }
  const rpc = (_name: string, args: Record<string, unknown>) => new LazyBuilder(args);
  const proxy = new Proxy(db as object, {
    get: (t, k) => (k === "rpc" ? rpc : (t as Record<string | symbol, unknown>)[k]),
  });
  return { db: proxy as unknown as ReturnType<typeof makeDb>, executions };
}

describe("lazy PostgREST builder: one request per RPC", () => {
  it("skip path: the keyword RPC executes exactly once and the fused RPC never", async () => {
    slowEmbed(60_000);
    const { db, executions } = lazyDb();
    const p = memorySearch(db, USER, PROJECT, { query: "cache key layout" }, opts());
    await vi.advanceTimersByTimeAsync(DEADLINE + 1);
    const result = await p;
    expect(executions).toEqual([null]);
    expect(result.records.map((r) => r.id)).toEqual(["strong"]);
  });

  it("fast path: at most one keyword RPC plus the fused RPC once", async () => {
    mockGenerateEmbedding.mockResolvedValue(VEC);
    const { db, executions } = lazyDb();
    await memorySearch(db, USER, PROJECT, { query: "cache key layout" }, opts());
    expect(executions.filter((e) => e === null).length).toBeLessThanOrEqual(1);
    expect(executions.filter((e) => e !== null)).toHaveLength(1);
  });

  it("a null vector that is not a skip (feature off) reuses the keyword RPC and serves every match", async () => {
    const { FeatureDisabledError } = await import("@/lib/feature-flags");
    mockGenerateEmbedding.mockRejectedValue(new FeatureDisabledError("embeddings"));
    const { db, executions } = lazyDb();
    const result = await memorySearch(db, USER, PROJECT, { query: "cache key layout" }, opts());
    expect(executions).toEqual([null]);
    expect(result.records.map((r) => r.id).sort()).toEqual(["strong", "weak"]);
    expect(timingsLog()).toMatchObject({ embedding_skipped: false });
  });
});

describe("request options stay on the prompt-recall path", () => {
  it("a memorySearch without a deadline embeds with no signal, timeout or retry override", async () => {
    mockGenerateEmbedding.mockResolvedValue(VEC);
    await memorySearch(makeDb(), USER, PROJECT, { query: "cache key layout" }, { logEvent: false });
    const o = mockGenerateEmbedding.mock.calls[0][1] as Record<string, unknown>;
    expect(o).not.toHaveProperty("signal");
    expect(o).not.toHaveProperty("timeoutMs");
  });

  it("the deadline path passes a signal and a timeout", async () => {
    mockGenerateEmbedding.mockResolvedValue(VEC);
    await memorySearch(makeDb(), USER, PROJECT, { query: "cache key layout" }, opts());
    const o = mockGenerateEmbedding.mock.calls[0][1] as Record<string, unknown>;
    expect(o.signal).toBeInstanceOf(AbortSignal);
    expect(o.timeoutMs).toBe(4000);
  });
});

describe("prompt text and breaker recovery", () => {
  it("a 2000+ char prompt whose 2000th char is whitespace is embedded once", async () => {
    mockGenerateEmbedding.mockResolvedValue(VEC);
    const prompt = `one two three four ${"a".repeat(1980)} ${"b".repeat(50)}`;
    expect(prompt[1999]).toBe(" ");
    await buildPromptRecall(makeDb(), USER, PROJECT, { prompt, repo: "a" }, { now: new Date("2026-10-08T12:00:00Z") });
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
  });

  it("a deadline success clears the pending skips", () => {
    const t = 0;
    const breaker = createEmbedBreaker(() => t);
    breaker.recordSkip();
    breaker.recordSkip();
    breaker.recordSuccess();
    breaker.recordSkip();
    expect(breaker.isOpen()).toBe(false);
  });
});

describe("fused RPC race against the hop-1 cap", () => {
  // Embedding lands at `at` ms. Defaults: cap 1500, verify reserve 500, so the fused RPC must land by 1000 ms.
  const embedAt = (at: number) =>
    mockGenerateEmbedding.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(VEC), at)));

  it("a vector at 850 ms with a slow fused RPC serves the keyword rows, embedding_skipped true", async () => {
    embedAt(850);
    const { db, executions } = lazyDb({ delayMs: 5_000 });
    const p = memorySearch(db, USER, PROJECT, { query: "cache key layout" }, opts());
    await vi.advanceTimersByTimeAsync(1_001);
    const result = await p;
    expect(result.records.map((r) => r.id)).toEqual(["strong"]);
    expect(timingsLog()).toMatchObject({ embedding_skipped: true });
    expect(executions.filter((e) => e === null)).toHaveLength(1);
  });

  it("a vector at 100 ms with a fast fused RPC serves the fused rows and leaves no timer pending", async () => {
    embedAt(100);
    const { db, executions } = lazyDb();
    const p = memorySearch(db, USER, PROJECT, { query: "cache key layout" }, opts());
    await vi.advanceTimersByTimeAsync(101);
    const result = await p;
    expect(timingsLog()).toMatchObject({ embedding_skipped: false });
    expect(result.records.map((r) => r.id)).toEqual(["strong"]);
    expect(executions.filter((e) => e !== null)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a late fused rejection after the race was lost is swallowed", async () => {
    embedAt(850);
    const { db } = lazyDb({ delayMs: 3_000, reject: true });
    const p = memorySearch(db, USER, PROJECT, { query: "cache key layout" }, opts());
    await vi.advanceTimersByTimeAsync(1_001);
    await expect(p).resolves.toMatchObject({ records: [{ id: "strong" }] });
    await vi.advanceTimersByTimeAsync(5_000);
  });
});

describe("long embedding wait", () => {
  it("a vector at 1300 ms (past the verify reserve) still gets the keyword rows served, not an empty reply", async () => {
    mockGenerateEmbedding.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(VEC), 1_300)));
    const p = buildPromptRecall(
      makeDb(),
      USER,
      PROJECT,
      { prompt: "how is the cache key layout decided for the build step", repo: "a" },
      { now: new Date("2026-10-08T12:00:00Z") },
    );
    await vi.advanceTimersByTimeAsync(EMBED_WAIT + 1);
    const out = await p;
    expect(out.skipped).not.toBe("timeout");
    expect(out.embedding_skipped).toBe(true);
    expect(out.embed_deadline_ms).toBe(EMBED_WAIT);
    expect(rpcCalls.every((a) => a.p_query_embedding === null)).toBe(true);
  });
});
