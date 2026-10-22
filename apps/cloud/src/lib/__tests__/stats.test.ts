import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks ---

const mockFrom = vi.fn();

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: mockFrom,
  })),
}));

process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import { buildWeeklyActivity, getConversationStats } from "../stats";

describe("getConversationStats", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // A single chain "node" that returns ITSELF from every builder method
  // (select/eq/neq/order/range) and carries the terminal {data,error} —
  // regardless of how many filters the real code chains on (e.g. the
  // conversations lane filter, ADR 0039 W6/D7, adds a .neq()/.eq() call
  // this mock must tolerate without caring about call depth).
  function chain(result: { data?: unknown; error?: unknown }) {
    const node = {
      select: () => node,
      eq: () => node,
      neq: () => node,
      order: () => node,
      range: () => node,
      data: result.data ?? null,
      error: result.error ?? null,
    };
    return node;
  }

  const PAGE_SIZE = 1000;

  function setupMocks(opts: {
    conversations?: unknown[];
    metadata?: unknown[];
    recent?: unknown[];
    conversationsError?: { message: string } | null;
    metadataError?: { message: string } | null;
    recentError?: { message: string } | null;
  }) {
    const convData = opts.conversations ?? [];
    const metaData = opts.metadata ?? [];
    const recentData = opts.recent ?? convData.slice(0, 10);

    // The conversations query now pages past PostgREST's 1000-row cap
    // (lib/kg/pagination.ts's selectAllRows, goal 2026-08-27 D5) — each
    // page is its own `.from("conversations")` call, so a >1000-row
    // fixture must drive >1 call before this mock moves on to metadata
    // then recent.
    let convPage = 0;
    let conversationsDone = false;
    let metadataServed = false;

    mockFrom.mockImplementation(() => {
      if (!conversationsDone) {
        if (opts.conversationsError) {
          conversationsDone = true;
          return chain({ data: [], error: opts.conversationsError });
        }
        const start = convPage * PAGE_SIZE;
        const page = convData.slice(start, start + PAGE_SIZE);
        convPage++;
        if (page.length < PAGE_SIZE) conversationsDone = true;
        return chain({ data: page, error: null });
      }
      // metadata query (first call after conversations), then recent.
      if (!metadataServed) {
        metadataServed = true;
        return chain({ data: metaData, error: opts.metadataError ?? null });
      }
      return chain({ data: recentData, error: opts.recentError ?? null });
    });
  }

  it("returns zero counts for user with no conversations", async () => {
    setupMocks({ conversations: [], metadata: [], recent: [] });

    const stats = await getConversationStats("user-empty");

    expect(stats.total).toBe(0);
    expect(stats.bySource).toEqual({});
    expect(stats.byType).toEqual({});
    expect(stats.topTopics).toEqual([]);
    expect(stats.recentConversations).toEqual([]);
    expect(stats.weeklyActivity).toHaveLength(12);
    stats.weeklyActivity.forEach((w) => expect(w.count).toBe(0));
  });

  it("correctly counts by source", async () => {
    const conversations = [
      { id: "1", source: "chatgpt", created_at: "2026-03-01" },
      { id: "2", source: "chatgpt", created_at: "2026-03-02" },
      { id: "3", source: "claude", created_at: "2026-03-03" },
      { id: "4", source: "grok", created_at: "2026-03-04" },
      { id: "5", source: "claude", created_at: "2026-03-05" },
    ];

    setupMocks({ conversations, metadata: [] });

    const stats = await getConversationStats("user-123");

    expect(stats.total).toBe(5);
    expect(stats.bySource).toEqual({ chatgpt: 2, claude: 2, grok: 1 });
  });

  it("does not cap total/bySource at 1,000 rows (goal 2026-08-27 D5)", async () => {
    // 1,055 chatgpt + 135 claude + 1 claude-code-chat = 1,191 — mirrors the
    // founder corpus's real chat-lane split (SQL truth: `select source,
    // count(*) from conversations where user_id=<founder> group by 1`).
    const conversations = [
      ...Array.from({ length: 1055 }, (_, i) => ({ id: `chatgpt-${i}`, source: "chatgpt", created_at: "2026-03-01" })),
      ...Array.from({ length: 135 }, (_, i) => ({ id: `claude-${i}`, source: "claude", created_at: "2026-03-01" })),
      { id: "bridge-1", source: "claude-code-chat", created_at: "2026-03-01" },
    ];

    setupMocks({ conversations, metadata: [] });

    const stats = await getConversationStats("user-123", 1, 20, "chat");

    expect(stats.total).toBe(1191);
    expect(stats.bySource).toEqual({ chatgpt: 1055, claude: 135, "claude-code-chat": 1 });
  });

  it("correctly aggregates top topics", async () => {
    const metadata = [
      { topics: ["react", "typescript", "hooks"], conversation_type: "coding" },
      { topics: ["react", "performance"], conversation_type: "coding" },
      { topics: ["typescript", "generics"], conversation_type: "research" },
      { topics: ["react"], conversation_type: "coding" },
    ];

    setupMocks({
      conversations: [{ id: "1", source: "chatgpt", created_at: "2026-03-01" }],
      metadata,
    });

    const stats = await getConversationStats("user-123");

    expect(stats.topTopics[0]).toEqual({ topic: "react", count: 3 });
    expect(stats.topTopics[1]).toEqual({ topic: "typescript", count: 2 });
    // Remaining topics have count 1
    const singleCountTopics = stats.topTopics.filter((t) => t.count === 1);
    expect(singleCountTopics).toHaveLength(3); // hooks, performance, generics
  });

  it("correctly counts by conversation type", async () => {
    const metadata = [
      { topics: [], conversation_type: "coding" },
      { topics: [], conversation_type: "coding" },
      { topics: [], conversation_type: "research" },
      { topics: [], conversation_type: null },
    ];

    setupMocks({
      conversations: [{ id: "1", source: "chatgpt", created_at: "2026-03-01" }],
      metadata,
    });

    const stats = await getConversationStats("user-123");

    expect(stats.byType).toEqual({ coding: 2, research: 1, unknown: 1 });
  });

  it("recent conversations are sorted by created_at desc", async () => {
    const recent = [
      { id: "3", source: "claude", title: "Newest", created_at: "2026-03-20T10:00:00Z" },
      { id: "1", source: "chatgpt", title: "Middle", created_at: "2026-03-19T10:00:00Z" },
      { id: "2", source: "grok", title: "Oldest", created_at: "2026-03-18T10:00:00Z" },
    ];

    setupMocks({
      conversations: recent.map((r) => ({ ...r })),
      metadata: [],
      recent,
    });

    const stats = await getConversationStats("user-123");

    expect(stats.recentConversations[0].title).toBe("Newest");
    expect(stats.recentConversations[1].title).toBe("Middle");
    expect(stats.recentConversations[2].title).toBe("Oldest");
  });

  it("throws on database error", async () => {
    setupMocks({
      conversationsError: { message: "DB connection failed" },
    });

    await expect(getConversationStats("user-123")).rejects.toThrow("Failed to fetch conversations");
  });

  describe("lane (migration-free, ADR 0039 W6/D7)", () => {
    it("filters out source='claude-code' on the conversations/recent queries by default (lane='chat')", async () => {
      setupMocks({ conversations: [{ id: "1", source: "claude", created_at: "2026-03-01" }] });
      const neqSpies: string[][] = [];
      const originalChain = mockFrom.getMockImplementation();
      mockFrom.mockImplementation((...args) => {
        const node = originalChain?.(...args);
        if (!node) return node;
        const neq = node.neq;
        node.neq = (...neqArgs: [string, unknown]) => {
          neqSpies.push(neqArgs.map(String));
          return neq();
        };
        return node;
      });

      await getConversationStats("user-123");
      // 2 of the 3 from() calls (conversations, recent) apply .neq — metadata does not.
      expect(neqSpies.filter((a) => a[0] === "source" && a[1] === "claude-code")).toHaveLength(2);
    });

    it("does not filter by source when lane='all'", async () => {
      setupMocks({ conversations: [{ id: "1", source: "claude-code", created_at: "2026-03-01" }] });
      const neqSpies: unknown[] = [];
      const originalChain = mockFrom.getMockImplementation();
      mockFrom.mockImplementation((...args) => {
        const node = originalChain?.(...args);
        if (!node) return node;
        const neq = node.neq;
        node.neq = (...neqArgs: unknown[]) => {
          neqSpies.push(neqArgs);
          return neq();
        };
        return node;
      });

      const stats = await getConversationStats("user-123", 1, 20, "all");
      expect(neqSpies).toHaveLength(0);
      expect(stats.total).toBe(1);
    });
  });
});

describe("buildWeeklyActivity", () => {
  it("returns 12 weeks of data", () => {
    const result = buildWeeklyActivity([]);
    expect(result).toHaveLength(12);
  });

  it("counts conversations in correct week buckets", () => {
    const now = new Date();
    const thisWeek = new Date(now);
    thisWeek.setDate(thisWeek.getDate() - 1); // yesterday

    const conversations = [{ created_at: thisWeek.toISOString() }, { created_at: thisWeek.toISOString() }];

    const result = buildWeeklyActivity(conversations);
    // The last bucket should have the count
    const lastWeek = result[result.length - 1];
    expect(lastWeek.count).toBeGreaterThanOrEqual(0);
    // Total across all weeks should be 2
    const totalCounted = result.reduce((sum, w) => sum + w.count, 0);
    expect(totalCounted).toBe(2);
  });

  it("ignores conversations older than 12 weeks", () => {
    const oldDate = new Date();
    oldDate.setDate(oldDate.getDate() - 100); // ~14 weeks ago

    const conversations = [{ created_at: oldDate.toISOString() }];

    const result = buildWeeklyActivity(conversations);
    const totalCounted = result.reduce((sum, w) => sum + w.count, 0);
    expect(totalCounted).toBe(0);
  });
});
