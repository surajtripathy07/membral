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
import { buildRelevance } from "../relevance";

const USER = "user-1";
const PROJECT_A = "proj-a";
const REPO = "https://github.com/acme/repo";

function record(overrides: Partial<Row> & { id: string }): Row {
  return {
    user_id: USER,
    code_session_id: "sess-1",
    code_project_id: PROJECT_A,
    agent_id: null,
    source: "hook",
    kind: "decision",
    text: "keyed the cache on repo + branch",
    quote: "keyed the cache on repo + branch",
    turn_idx: 0,
    turn_role: "assistant",
    ref: null,
    ref_kind: null,
    branch: null,
    head_sha: null,
    thread: null,
    paths: [],
    durable: true,
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

process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-secret";

describe("buildRelevance", () => {
  beforeEach(() => {
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-secret";
    // #436: fixtures are created 2026-09-10; "now" is 2 days later, so their blockers are fresh.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-12T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns at most 6 hits", async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      record({ id: `r${i}`, text: `decision ${i}`, quote: `decision ${i}` }),
    );
    const supabase = makeFakeSupabase(
      {
        code_projects: [{ id: PROJECT_A, user_id: USER, repo_identity: "github.com/acme/repo" }],
        session_memories: [],
        code_session_turns: rows.map((r) => ({
          session_id: r.code_session_id,
          idx: r.turn_idx,
          text: r.text,
          props: {},
        })),
        memory_branch_state: [],
        conversations: [],
      },
      {
        rpc: {
          memory_search_scored: (args) => ({ data: rows.slice(0, (args.p_limit as number) ?? 20), error: null }),
        },
      },
    );

    const result = await buildRelevance(supabase, USER, null, { prompt: "cache key", repo: REPO });
    expect(result.lines.length).toBeLessThanOrEqual(6);
    expect(result.recall_token).toBeTruthy();
  });

  it("reuses a caller-supplied recall_token rather than minting a new one", async () => {
    const supabase = makeFakeSupabase(
      {
        code_projects: [],
        session_memories: [],
        code_session_turns: [],
        memory_branch_state: [],
        conversations: [],
      },
      { rpc: { memory_search_scored: () => ({ data: [], error: null }) } },
    );
    const result = await buildRelevance(supabase, USER, null, {
      prompt: "cache key",
      repo: REPO,
      recall_token: "v1.given.token",
    });
    expect(result.recall_token).toBe("v1.given.token");
  });

  it("returns the repo's open blockers", async () => {
    const blocker = record({ id: "blk", kind: "blocker", text: "ci is red", quote: "ci is red" });
    const supabase = makeFakeSupabase(
      {
        code_projects: [{ id: PROJECT_A, user_id: USER, repo_identity: "github.com/acme/repo" }],
        session_memories: [blocker],
        code_session_turns: [{ session_id: "sess-1", idx: 0, text: "ci is red", props: {} }],
        memory_branch_state: [],
        conversations: [],
      },
      { rpc: { memory_search_scored: () => ({ data: [], error: null }) } },
    );
    const result = await buildRelevance(supabase, USER, null, { prompt: "cache key", repo: REPO });
    expect(result.open_blockers.map((b) => b.id)).toEqual(["blk"]);
  });

  it("leaves a blocker older than 7 days out of the open-blockers outbox (#436)", async () => {
    const stale = record({
      id: "blk-old",
      kind: "blocker",
      text: "ci is red",
      quote: "ci is red",
      created_at: "2026-09-04T00:00:00Z",
    });
    const fresh = record({ id: "blk", kind: "blocker", text: "ci is red", quote: "ci is red" });
    const supabase = makeFakeSupabase(
      {
        code_projects: [{ id: PROJECT_A, user_id: USER, repo_identity: "github.com/acme/repo" }],
        session_memories: [stale, fresh],
        code_session_turns: [{ session_id: "sess-1", idx: 0, text: "ci is red", props: {} }],
        memory_branch_state: [],
        conversations: [],
      },
      { rpc: { memory_search_scored: () => ({ data: [], error: null }) } },
    );
    const result = await buildRelevance(supabase, USER, null, { prompt: "cache key", repo: REPO });
    expect(result.open_blockers.map((b) => b.id)).toEqual(["blk"]);
  });

  it("excludes a blocker retired resolved_in_session but keeps a durable:false unresolved one", async () => {
    const resolved = record({
      id: "blk-resolved",
      kind: "blocker",
      text: "ci is red",
      quote: "ci is red",
      durable: false,
      retired_at: "2026-09-24T00:00:00Z",
      retire_reason: "resolved_in_session",
    });
    const open = record({
      id: "blk-open",
      kind: "blocker",
      text: "flaky test blocks merge",
      quote: "flaky test blocks merge",
      durable: false,
    });
    const supabase = makeFakeSupabase(
      {
        code_projects: [
          {
            id: PROJECT_A,
            user_id: USER,
            repo_identity: "github.com/acme/repo",
          },
        ],
        session_memories: [resolved, open],
        code_session_turns: [
          { session_id: "sess-1", idx: 0, text: "ci is red", props: {} },
          {
            session_id: "sess-1",
            idx: 0,
            text: "flaky test blocks merge",
            props: {},
          },
        ],
        memory_branch_state: [],
        conversations: [],
      },
      { rpc: { memory_search_scored: () => ({ data: [], error: null }) } },
    );
    const result = await buildRelevance(supabase, USER, null, {
      prompt: "cache key",
      repo: REPO,
    });
    expect(result.open_blockers.map((b) => b.id)).toEqual(["blk-open"]);
  });
});
