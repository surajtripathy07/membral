import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock Supabase client
const mockSingle = vi.fn();
const mockEq = vi.fn(() => ({ single: mockSingle }));
const mockSelect = vi.fn(() => ({ eq: mockEq }));
// Round-2 review HIGH 4: getConversationQuota's count query no longer
// `.neq("source", "claude-code")` — a mirrored code session now counts
// against the same conversation_limit as a chat conversation (see
// migration 078's DB trigger, which never excluded any source). `.eq()`
// resolves the count directly.
function conversationsCountNode(count: number) {
  return Promise.resolve({ count });
}
const mockFrom = vi.fn((table: string) => {
  if (table === "conversations") {
    return {
      select: vi.fn(() => ({
        eq: vi.fn(() => conversationsCountNode(50)),
      })),
    };
  }
  return { select: mockSelect, update: vi.fn(() => ({ eq: vi.fn() })) };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({
    from: mockFrom,
  })),
}));

// Set env vars before importing billing
process.env.NEXT_PUBLIC_SUPABASE_URL = "http://localhost:54321";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

import {
  _clearConversationCountCacheForTest,
  getConversationQuota,
  parseConversationLimitError,
  partitionByConversationQuota,
} from "../billing";

describe("getConversationQuota", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Round-2 review LOW 15: getConversationQuota now caches the count
    // per-user for a short TTL — clear it so each test's mocked count is
    // actually exercised instead of one test's result leaking into the
    // next (all these tests share userId "user-123").
    _clearConversationCountCacheForTest();
  });

  it("reports the profile limit and current count when user is under the limit", async () => {
    // Profile query returns free tier with limit 100
    mockSingle.mockResolvedValueOnce({
      data: { tier: "free", conversation_limit: 100 },
      error: null,
    });

    // Conversations count mock - set up the full chain
    mockFrom.mockImplementationOnce(() => ({
      select: mockSelect,
      update: vi.fn(() => ({ eq: vi.fn() })),
    }));
    mockFrom.mockImplementationOnce(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => conversationsCountNode(50)),
      })),
    }));

    const result = await getConversationQuota("user-123");
    expect(result).toEqual({ limit: 100, count: 50 });
  });

  it("reports count equal to limit when user is at the limit", async () => {
    mockSingle.mockResolvedValueOnce({
      data: { tier: "free", conversation_limit: 100 },
      error: null,
    });

    // Override from to return count at limit
    mockFrom.mockImplementationOnce(() => ({
      select: mockSelect,
      update: vi.fn(() => ({ eq: vi.fn() })),
    }));
    mockFrom.mockImplementationOnce(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => conversationsCountNode(100)),
      })),
    }));

    const result = await getConversationQuota("user-123");
    expect(result).toEqual({ limit: 100, count: 100 });
  });

  it("round-2 review HIGH 4: counts source='claude-code' rows too (no longer excluded — ADR 0039 M3 narrowed, see migration 078)", async () => {
    mockSingle.mockResolvedValueOnce({
      data: { tier: "free", conversation_limit: 100 },
      error: null,
    });
    const eqSpy = vi.fn(() => conversationsCountNode(50));
    mockFrom.mockImplementationOnce(() => ({
      select: mockSelect,
      update: vi.fn(() => ({ eq: vi.fn() })),
    }));
    mockFrom.mockImplementationOnce(() => ({
      select: vi.fn(() => ({ eq: eqSpy })),
    }));

    await getConversationQuota("user-123");
    // Only ever filtered by user_id — no .neq("source", ...) call at all.
    expect(eqSpy).toHaveBeenCalledWith("user_id", "user-123");
    expect(eqSpy).toHaveBeenCalledTimes(1);
  });

  it("round-2 review LOW 15: caches the count per user for a short TTL — a second call within the window doesn't re-query", async () => {
    mockSingle.mockResolvedValueOnce({
      data: { tier: "free", conversation_limit: 100 },
      error: null,
    });
    mockSingle.mockResolvedValueOnce({
      data: { tier: "free", conversation_limit: 100 },
      error: null,
    });
    const eqSpy = vi.fn(() => conversationsCountNode(50));
    mockFrom.mockImplementation((table: string) => {
      if (table === "conversations") return { select: vi.fn(() => ({ eq: eqSpy })) };
      return { select: mockSelect, update: vi.fn(() => ({ eq: vi.fn() })) };
    });

    await getConversationQuota("user-123");
    await getConversationQuota("user-123");
    // The profile lookup runs every call (tier can change); the count
    // query is what's cached — only queried once across both calls.
    expect(eqSpy).toHaveBeenCalledTimes(1);
  });

  it("reports an infinite limit for pro users (unlimited)", async () => {
    mockSingle.mockResolvedValueOnce({
      data: { tier: "pro", conversation_limit: 999999 },
      error: null,
    });
    mockFrom.mockImplementation((table: string) => {
      if (table === "conversations") {
        return { select: vi.fn(() => ({ eq: vi.fn(() => conversationsCountNode(7)) })) };
      }
      return { select: mockSelect, update: vi.fn(() => ({ eq: vi.fn() })) };
    });

    const result = await getConversationQuota("user-123");
    expect(result).toEqual({ limit: Number.POSITIVE_INFINITY, count: 7 });
  });

  it("issue #127 self-hosting decision: a NULL conversation_limit (free tier, open-mode default) is unlimited, not the free-tier fallback", async () => {
    mockSingle.mockResolvedValueOnce({
      data: { tier: "free", conversation_limit: null },
      error: null,
    });
    // A count well past the OLD free-tier default (100) — must still pass.
    mockFrom.mockImplementationOnce(() => ({
      select: mockSelect,
      update: vi.fn(() => ({ eq: vi.fn() })),
    }));
    mockFrom.mockImplementationOnce(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => conversationsCountNode(500)),
      })),
    }));

    const result = await getConversationQuota("user-123");
    expect(result).toEqual({ limit: Number.POSITIVE_INFINITY, count: 500 });
  });
});

describe("partitionByConversationQuota (issue #127)", () => {
  function conv(source_id: string) {
    return { source: "claude", source_id };
  }

  it("accepts everything when the limit is unbounded (pro/Infinity)", () => {
    const items = [conv("a"), conv("b"), conv("c")];
    const { accepted, skipped } = partitionByConversationQuota(items, new Set(), {
      limit: Number.POSITIVE_INFINITY,
      count: 500,
    });
    expect(accepted).toEqual(items);
    expect(skipped).toEqual([]);
  });

  it("always accepts an existing row (an update) regardless of remaining headroom", () => {
    const items = [conv("a")];
    const { accepted, skipped } = partitionByConversationQuota(items, new Set(["claude:a"]), {
      limit: 1,
      count: 1,
    });
    expect(accepted).toEqual(items);
    expect(skipped).toEqual([]);
  });

  it("rejects a brand-new row once the limit is already met", () => {
    const items = [conv("a")];
    const { accepted, skipped } = partitionByConversationQuota(items, new Set(), { limit: 1, count: 1 });
    expect(accepted).toEqual([]);
    expect(skipped).toEqual(items);
  });

  it("accepts new rows only up to the remaining headroom, in array order", () => {
    const items = [conv("a"), conv("b"), conv("c")];
    const { accepted, skipped } = partitionByConversationQuota(items, new Set(), { limit: 5, count: 3 });
    expect(accepted).toEqual([conv("a"), conv("b")]);
    expect(skipped).toEqual([conv("c")]);
  });

  it("mixes updates (always accepted) and new rows (headroom-limited) in one batch", () => {
    const items = [conv("existing"), conv("new-1"), conv("new-2")];
    const { accepted, skipped } = partitionByConversationQuota(items, new Set(["claude:existing"]), {
      limit: 2,
      count: 1,
    });
    // 1 slot of headroom remains (limit 2 - count 1); the existing row is
    // always accepted, plus exactly one of the two new rows.
    expect(accepted).toEqual([conv("existing"), conv("new-1")]);
    expect(skipped).toEqual([conv("new-2")]);
  });
});

describe("parseConversationLimitError (migration 078 trigger, round-2 review HIGH 3/4/6)", () => {
  it("parses limit/count out of the trigger's DETAIL", () => {
    const info = parseConversationLimitError({ message: "conversation_limit", details: '{"limit":100,"count":100}' });
    expect(info).toEqual({ limit: 100, count: 100 });
  });

  it("recognizes the error by message even with malformed/missing detail", () => {
    const info = parseConversationLimitError({ message: "conversation_limit", details: null });
    expect(info).not.toBeNull();
    expect(Number.isNaN(info?.limit)).toBe(true);
  });

  it("returns null for an unrelated error", () => {
    expect(parseConversationLimitError({ message: "some other db error" })).toBeNull();
  });

  it("returns null for null/undefined", () => {
    expect(parseConversationLimitError(null)).toBeNull();
    expect(parseConversationLimitError(undefined)).toBeNull();
  });
});
