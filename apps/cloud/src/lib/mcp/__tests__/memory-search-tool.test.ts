// W3: the MCP memory_search tool end to end below the route -- real
// memorySearch, real compaction, real token budget -- over a fake Supabase
// whose memory_search_scored returns scored rows (so the missing embedding key
// in tests never stops the call before the RPC).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateEmbedding = vi.fn();
vi.mock("@/lib/embeddings", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
  EmbeddingCeilingExceededError: class EmbeddingCeilingExceededError extends Error {},
}));
vi.mock("@/lib/feature-flags", () => ({
  FeatureDisabledError: class FeatureDisabledError extends Error {},
}));
let currentDb: unknown = null;
vi.mock("@/lib/db/clients", () => ({ getServiceClient: () => currentDb }));

import { makeMemoryFakeSupabase, type Row } from "@membral/test-kit";
import { EmbeddingCeilingExceededError } from "@/lib/embeddings";
import { registerMemoryTools } from "../memory-tools";

const USER = "user-1";

function record(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id,
    code_session_id: "sess-1",
    code_project_id: "proj-a",
    agent_id: null,
    source: "hook",
    kind: "decision",
    text: `keyed the cache on repo + branch (${id})`,
    quote: "keyed the cache on repo + branch for every run",
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
    confidence: 1,
    supersedes: null,
    retired_at: null,
    chat_conversation_id: null,
    created_at: "2026-09-30T00:00:00Z",
    leg_score: 0.03,
    similarity: 0.7,
    lex_hits: 2,
    query_lexemes: 2,
    observed_at: "2026-09-30T00:00:00Z",
    ...overrides,
  };
}

const toolResult = async (fn: () => Promise<unknown>) => {
  try {
    return { content: [{ type: "text" as const, text: JSON.stringify(await fn()) }], freshness: null };
  } catch (err) {
    return { content: [{ type: "text" as const, text: String(err) }], isError: true, freshness: null };
  }
};

async function callSearch(rows: Row[], args: Record<string, unknown>) {
  const events: Row[] = [];
  currentDb = makeMemoryFakeSupabase(
    {
      code_session_turns: [{ session_id: "sess-1", idx: 0, text: "keyed the cache on repo + branch", props: {} }],
      code_projects: [],
      memory_branch_state: [],
      conversations: [],
      code_session_issues: [],
    },
    {
      rpc: { memory_search_scored: () => ({ data: rows, error: null }) },
      onInsert: (table, row) => table === "memory_recall_events" && events.push(row),
    },
  );
  // biome-ignore lint/suspicious/noExplicitAny: test double for McpServer
  let handler: any;
  const server = {
    registerTool: (name: string, _c: unknown, h: unknown) => {
      if (name === "memory_search") handler = h;
    },
    // biome-ignore lint/suspicious/noExplicitAny: test double
  } as any;
  registerMemoryTools(server, USER, null, toolResult, async () => null);
  const res = (await handler(args)) as { content: { text: string }[]; isError?: boolean };
  await new Promise((r) => setTimeout(r, 0)); // let the off-path event write settle
  expect(res.isError).toBeUndefined();
  return { data: JSON.parse(res.content[0].text), events };
}

describe("memory_search tool: scored rows through compaction and the token budget", () => {
  beforeEach(() => {
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
    vi.stubEnv("MEMBRAL_LOCAL", ""); // hosted: these cases pin the records shape; the lines path is in memory-tools.test.ts
  });
  afterEach(() => vi.unstubAllEnvs());

  it("null similarity (embeddings down): keyword hits are served, not floored, and marked degraded", async () => {
    mockGenerateEmbedding.mockRejectedValue(new EmbeddingCeilingExceededError(1, 1));
    const rows = [record("a", { similarity: null, lex_hits: 1, query_lexemes: 4 })];
    const { data } = await callSearch(rows, { query: "cache key repo branch" });
    expect(data.records.map((r: { id: string }) => r.id)).toEqual(["a"]);
    expect(data.degraded).toMatch(/relevance floor is off/);
  });

  it("logs the recall event AFTER the budget: only the records actually returned", async () => {
    const rows = ["a", "b", "c", "d"].map((id) => record(id, { text: `${id} ${"long text ".repeat(40)}` }));
    const { data, events } = await callSearch(rows, { query: "cache key", max_tokens: 300 });
    const returned = data.records.map((r: { id: string }) => r.id);
    expect(returned.length).toBeGreaterThan(0);
    expect(returned.length).toBeLessThan(4);
    expect(data.dropped_for_budget).toBe(4 - returned.length);
    expect(events).toHaveLength(1);
    expect(events[0].record_ids).toEqual(returned);
  });

  it("first record alone over max_tokens is still returned, with the rest counted as dropped", async () => {
    const rows = [record("big", { text: "x".repeat(3000) }), record("small")];
    const { data, events } = await callSearch(rows, { query: "cache key", max_tokens: 200 });
    expect(data.records.map((r: { id: string }) => r.id)).toEqual(["big"]);
    expect(data.dropped_for_budget).toBe(1);
    expect(events[0].record_ids).toEqual(["big"]);
  });

  it("left_out_ids lists exactly the visible records skipped for the budget, and is absent when everything fits", async () => {
    const rows = [
      record("a", { text: `a ${"long text ".repeat(20)}` }),
      record("huge", { text: `huge ${"long text ".repeat(200)}` }),
      record("b", { text: `b ${"long text ".repeat(20)}` }),
    ];
    const packed = await callSearch(rows, { query: "cache key", max_tokens: 400 });
    const returned = packed.data.records.map((r: { id: string }) => r.id);
    expect(returned).toEqual(["a", "b"]);
    expect(packed.data.left_out_ids).toEqual(["huge"]);
    expect(packed.data.dropped_for_budget).toBe(1);
    expect(packed.events[0].record_ids).toEqual(["a", "b"]);

    const fits = await callSearch([record("a"), record("b")], { query: "cache key" });
    expect(fits.data.left_out_ids).toBeUndefined();
    expect(fits.data.dropped_for_budget).toBeUndefined();
  });
});
