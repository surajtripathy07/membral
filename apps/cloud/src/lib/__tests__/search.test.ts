import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockRpc = vi.fn();
const mockFrom = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: mockFrom,
    rpc: mockRpc,
  })),
}));

const mockGenerateEmbedding = vi.fn();
vi.mock("@/lib/embeddings", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
}));

// Set env vars before importing
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.OPENAI_API_KEY = "sk-test";

import { searchConversations } from "../search";

const fakeResults = [
  {
    id: "conv-1",
    source: "chatgpt",
    title: "React hooks tutorial",
    created_at: "2026-01-15T10:00:00Z",
    summary: "Discussion about React hooks",
    similarity: 0.85,
  },
  {
    id: "conv-2",
    source: "claude",
    title: "TypeScript generics",
    created_at: "2026-01-14T09:00:00Z",
    summary: "Deep dive into TS generics",
    similarity: 0.72,
  },
];

describe("searchConversations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // goal 2026-08-27 D6 (#106, migration 071 rev-2, adversarial round 1 §4):
  // keyword mode now calls search_conversations with query_embedding: null
  // (relevance-ordered via the RPC's FTS leg) instead of a direct
  // .textSearch()/created_at-ordered query.
  it("uses keyword-only search (RPC with null embedding) when mode is keyword", async () => {
    mockRpc.mockResolvedValueOnce({ data: fakeResults, error: null });

    const results = await searchConversations("user-123", {
      query: "React hooks",
      mode: "keyword",
    });

    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(mockFrom).not.toHaveBeenCalled();
    expect(mockRpc).toHaveBeenCalledWith("search_conversations", {
      query_text: "React hooks",
      query_embedding: null,
      match_count: 10,
      search_user_id: "user-123",
      p_lane: "all",
    });
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe("conv-1");
  });

  it("generates embedding and calls rpc when mode is semantic", async () => {
    const fakeEmbedding = Array.from({ length: 1536 }, () => 0.1);
    mockGenerateEmbedding.mockResolvedValueOnce(fakeEmbedding);
    mockRpc.mockResolvedValueOnce({ data: fakeResults, error: null });

    const results = await searchConversations("user-123", {
      query: "React hooks",
      mode: "semantic",
    });

    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      "React hooks",
      expect.objectContaining({ userId: "user-123", pass: "query_embedding" }),
    );
    expect(mockRpc).toHaveBeenCalledWith("search_conversations", {
      query_text: "",
      query_embedding: `[${fakeEmbedding.join(",")}]`,
      match_count: 10,
      search_user_id: "user-123",
      p_lane: "all",
    });
    expect(mockFrom).not.toHaveBeenCalled();
    expect(results).toHaveLength(2);
  });

  it("uses both FTS and embedding when mode is hybrid (default)", async () => {
    const fakeEmbedding = Array.from({ length: 1536 }, () => 0.1);
    mockGenerateEmbedding.mockResolvedValueOnce(fakeEmbedding);
    mockRpc.mockResolvedValueOnce({ data: fakeResults, error: null });

    const results = await searchConversations("user-123", {
      query: "React hooks",
    });

    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      "React hooks",
      expect.objectContaining({ userId: "user-123", pass: "query_embedding" }),
    );
    expect(mockRpc).toHaveBeenCalledWith("search_conversations", {
      query_text: "React hooks",
      query_embedding: `[${fakeEmbedding.join(",")}]`,
      match_count: 10,
      search_user_id: "user-123",
      p_lane: "all",
    });
    expect(results).toHaveLength(2);
  });

  it("returns empty array when no matches found", async () => {
    const fakeEmbedding = Array.from({ length: 1536 }, () => 0.1);
    mockGenerateEmbedding.mockResolvedValueOnce(fakeEmbedding);
    mockRpc.mockResolvedValueOnce({ data: [], error: null });

    const results = await searchConversations("user-123", {
      query: "nonexistent topic",
    });

    expect(results).toEqual([]);
  });

  it("results are sorted per the RPC's own ordering (preserves DB order)", async () => {
    const sorted = [
      { ...fakeResults[0], similarity: 0.9 },
      { ...fakeResults[1], similarity: 0.5 },
    ];
    const fakeEmbedding = Array.from({ length: 1536 }, () => 0.1);
    mockGenerateEmbedding.mockResolvedValueOnce(fakeEmbedding);
    mockRpc.mockResolvedValueOnce({ data: sorted, error: null });

    const results = await searchConversations("user-123", {
      query: "test",
    });

    // DB function orders (fts_hit, ts_rank, similarity); service preserves that order.
    expect(results[0].similarity).toBe(0.9);
    expect(results[1].similarity).toBe(0.5);
  });

  it("respects custom limit", async () => {
    const fakeEmbedding = Array.from({ length: 1536 }, () => 0.1);
    mockGenerateEmbedding.mockResolvedValueOnce(fakeEmbedding);
    mockRpc.mockResolvedValueOnce({ data: [fakeResults[0]], error: null });

    await searchConversations("user-123", {
      query: "test",
      limit: 5,
    });

    expect(mockRpc).toHaveBeenCalledWith("search_conversations", {
      query_text: "test",
      query_embedding: expect.any(String),
      match_count: 5,
      search_user_id: "user-123",
      p_lane: "all",
    });
  });

  it("returns null similarity for keyword-only results", async () => {
    const keywordResults = fakeResults.map((r) => ({
      ...r,
      similarity: undefined,
    }));
    mockRpc.mockResolvedValueOnce({ data: keywordResults, error: null });

    const results = await searchConversations("user-123", {
      query: "React",
      mode: "keyword",
    });

    expect(results[0].similarity).toBeNull();
  });

  it("falls back to keyword search (RPC with null embedding) when the vector RPC errors", async () => {
    const fakeEmbedding = Array.from({ length: 1536 }, () => 0.1);
    mockGenerateEmbedding.mockResolvedValueOnce(fakeEmbedding);
    mockRpc.mockResolvedValueOnce({
      data: null,
      error: { message: "DB error" },
    });
    const keywordResults = [
      { id: "kw-1", source: "claude", title: "fallback", created_at: "2024-01-01", summary: null, similarity: null },
    ];
    mockRpc.mockResolvedValueOnce({ data: keywordResults, error: null });

    const results = await searchConversations("user-123", { query: "test" });
    expect(results[0].id).toBe("kw-1");
    expect(results[0].similarity).toBeNull();
    expect(mockRpc).toHaveBeenLastCalledWith(
      "search_conversations",
      expect.objectContaining({ query_embedding: null }),
    );
  });

  it("falls back to keyword search (RPC with null embedding) when the embedding provider fails", async () => {
    mockGenerateEmbedding.mockRejectedValueOnce(new Error("OpenAI quota exceeded"));
    const keywordResults = [
      {
        id: "kw-2",
        source: "chatgpt",
        title: "embed-fallback",
        created_at: "2024-01-01",
        summary: null,
        similarity: null,
      },
    ];
    mockRpc.mockResolvedValueOnce({ data: keywordResults, error: null });

    const results = await searchConversations("user-123", { query: "test", mode: "hybrid" });
    expect(results[0].id).toBe("kw-2");
    expect(mockRpc).toHaveBeenCalledTimes(1);
    expect(mockRpc).toHaveBeenCalledWith(
      "search_conversations",
      expect.objectContaining({ query_embedding: null, query_text: "test" }),
    );
  });

  describe("lane (ADR 0039, W6/D7 follow-up; default 'all' per goal 2026-08-27 D6 fix / #106)", () => {
    it("keyword mode defaults to lane='all': passed to the RPC as p_lane, no post-hoc filtering", async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      await searchConversations("user-123", { query: "test", mode: "keyword" });
      expect(mockRpc).toHaveBeenCalledWith("search_conversations", expect.objectContaining({ p_lane: "all" }));
    });

    it("keyword mode lane='code': passed through to the RPC as p_lane", async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      await searchConversations("user-123", { query: "test", mode: "keyword", lane: "code" });
      expect(mockRpc).toHaveBeenCalledWith("search_conversations", expect.objectContaining({ p_lane: "code" }));
    });

    it("keyword mode lane='chat': passed through to the RPC as p_lane", async () => {
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      await searchConversations("user-123", { query: "test", mode: "keyword", lane: "chat" });
      expect(mockRpc).toHaveBeenCalledWith("search_conversations", expect.objectContaining({ p_lane: "chat" }));
    });

    it("RPC path (hybrid/semantic) defaults to lane='all': p_lane passed to the RPC, no TS-side filtering of returned rows", async () => {
      const fakeEmbedding = Array.from({ length: 1536 }, () => 0.1);
      mockGenerateEmbedding.mockResolvedValueOnce(fakeEmbedding);
      mockRpc.mockResolvedValueOnce({
        data: [
          { id: "chat-1", source: "chatgpt", title: "A", created_at: null, summary: null, similarity: 0.9 },
          { id: "code-1", source: "claude-code", title: "B", created_at: null, summary: null, similarity: 0.8 },
        ],
        error: null,
      });

      const results = await searchConversations("user-123", { query: "test" });
      expect(mockRpc).toHaveBeenCalledWith("search_conversations", expect.objectContaining({ p_lane: "all" }));
      // Both rows returned as-is — the RPC (not TS) is responsible for lane filtering now.
      expect(results.map((r) => r.id).sort()).toEqual(["chat-1", "code-1"]);
    });

    it("RPC path lane='code': passed through to the RPC as p_lane", async () => {
      const fakeEmbedding = Array.from({ length: 1536 }, () => 0.1);
      mockGenerateEmbedding.mockResolvedValueOnce(fakeEmbedding);
      mockRpc.mockResolvedValueOnce({
        data: [{ id: "code-1", source: "claude-code", title: "B", created_at: null, summary: null, similarity: 0.8 }],
        error: null,
      });

      const results = await searchConversations("user-123", { query: "test", lane: "code" });
      expect(mockRpc).toHaveBeenCalledWith("search_conversations", expect.objectContaining({ p_lane: "code" }));
      expect(results.map((r) => r.id)).toEqual(["code-1"]);
    });

    it("match_count sent to the RPC always equals limit — lane filtering happens in SQL before the LIMIT now, so there's no over-fetch/short-page trade-off to account for", async () => {
      const fakeEmbedding = Array.from({ length: 1536 }, () => 0.1);
      mockGenerateEmbedding.mockResolvedValueOnce(fakeEmbedding);
      mockRpc.mockResolvedValueOnce({ data: [], error: null });

      await searchConversations("user-123", { query: "test", limit: 7, lane: "chat" });
      expect(mockRpc).toHaveBeenCalledWith("search_conversations", expect.objectContaining({ match_count: 7 }));
    });
  });

  // issue #92: the monthly embedding cost ceiling degrades to keyword
  // search (never throws). goal 2026-08-27 D6 / adversarial round 1 §4:
  // this fallback must now be relevance-ordered (RPC, null embedding), not
  // created_at-ordered — a demo that trips the ceiling mid-session must not
  // silently degrade search recall to near-zero.
  it("issue #92: degrades to relevance-ordered keyword search (never throws) when the monthly cost ceiling is exceeded", async () => {
    class FakeEmbeddingCeilingExceededError extends Error {
      constructor(
        public readonly spentUsd: number,
        public readonly ceilingUsd: number,
      ) {
        super("ceiling exceeded");
      }
    }
    mockGenerateEmbedding.mockRejectedValueOnce(new FakeEmbeddingCeilingExceededError(5, 5));
    const keywordResults = [
      {
        id: "kw-3",
        source: "chatgpt",
        title: "ceiling-fallback",
        created_at: "2024-01-01",
        summary: null,
        similarity: null,
      },
    ];
    mockRpc.mockResolvedValueOnce({ data: keywordResults, error: null });

    const results = await searchConversations("user-123", { query: "test", mode: "hybrid" });
    expect(results[0].id).toBe("kw-3");
    // Relevance-ordered fallback: RPC called with query_embedding null (FTS
    // leg alone), not the old created_at-desc direct table query.
    expect(mockRpc).toHaveBeenCalledWith(
      "search_conversations",
      expect.objectContaining({ query_text: "test", query_embedding: null }),
    );
    expect(mockFrom).not.toHaveBeenCalled();
  });
});
