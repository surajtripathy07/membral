// GET /api/pulse route tests — the route that replaced the deleted
// /api/spike?op=pulse branch (commit 12ce038). Covers: auth gating, the
// shape pulse-page-client.tsx / pulse-content.tsx actually consume (recent,
// recent_code_sessions, freshness — NOT census, which the UI never read),
// the code-session count gate, and graceful degradation when the recent-chats
// read throws.

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGetUser = vi.fn();
/** When set, the mocked client also answers `.from("user_stats")...maybeSingle()` with this. */
let userStatsResult: { data: unknown; error: unknown } | (() => never) | null = null;
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: (table: string) => {
      if (table === "conversations") {
        const conv = {
          select: () => conv,
          eq: () => conv,
          neq: () => conv,
          order: () => conv,
          limit: async () => mockRecentChats(),
        };
        return conv;
      }
      if (table !== "user_stats" || userStatsResult === null) throw new Error(`unexpected read of ${table}`);
      const chain = {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: async () => (typeof userStatsResult === "function" ? userStatsResult() : userStatsResult),
      };
      return chain;
    },
  })),
}));

/** Answers the route's `conversations` read: resolves { data, error }. */
const mockRecentChats = vi.fn();

const mockGetCodeSessionCount = vi.fn();
const mockGetRecentCodeSessions = vi.fn();
vi.mock("@/lib/code-sessions/queries", () => ({
  getCodeSessionCount: (...args: unknown[]) => mockGetCodeSessionCount(...args),
  getRecentCodeSessions: (...args: unknown[]) => mockGetRecentCodeSessions(...args),
}));

vi.mock("@/lib/code-sessions/view", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/code-sessions/view")>();
  return { ...actual };
});

const mockGetFreshnessForUser = vi.fn();
vi.mock("@/lib/freshness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/freshness")>();
  return {
    ...actual,
    getFreshnessForUser: (...args: unknown[]) => mockGetFreshnessForUser(...args),
  };
});

const mockListOpenThreads = vi.fn();
vi.mock("@/lib/threads/queries", () => ({
  listOpenThreads: (...args: unknown[]) => mockListOpenThreads(...args),
}));

const mockGetFirstRunHistory = vi.fn();
vi.mock("@/lib/code-sessions/first-run", () => ({
  getFirstRunHistory: (...args: unknown[]) => mockGetFirstRunHistory(...args),
}));

import { GET } from "../route";

describe("GET /api/pulse", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    userStatsResult = null;
    mockGetFirstRunHistory.mockResolvedValue(null);
  });

  it("serves first_run from getFirstRunHistory for a user with code sessions, null when it fails or there are none (W5 D4)", async () => {
    const history = {
      total: 2,
      perHarness: [{ source: "claude-code", label: "Claude Code", count: 2 }],
      subAgents: 1,
      earliestStart: null,
      latestStart: null,
      memoryCount: 0,
    };
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1", created_at: "2026-10-01T00:00:00.000Z" } } });
    mockRecentChats.mockResolvedValue({ data: [], error: null });
    mockGetFreshnessForUser.mockResolvedValue(null);
    mockGetCodeSessionCount.mockResolvedValue(2);
    mockGetRecentCodeSessions.mockResolvedValue([]);
    mockListOpenThreads.mockResolvedValue({ open: [], recent: [], recurring_blockers: [] });
    mockGetFirstRunHistory.mockResolvedValue(history);
    expect((await (await GET(new NextRequest("http://localhost/api/pulse"))).json()).first_run).toEqual(history);
    expect(mockGetFirstRunHistory).toHaveBeenCalledWith(expect.anything(), "u1", "2026-10-01T00:00:00.000Z");

    mockGetFirstRunHistory.mockRejectedValue(new Error("boom"));
    expect((await (await GET(new NextRequest("http://localhost/api/pulse"))).json()).first_run).toBeNull();

    mockGetCodeSessionCount.mockResolvedValue(0);
    expect((await (await GET(new NextRequest("http://localhost/api/pulse"))).json()).first_run).toBeNull();
  });

  it("serves stats_line from the user's latest user_stats row, and null when there is none or the read fails (W8 / P7)", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockRecentChats.mockResolvedValue({ data: [], error: null });
    mockGetCodeSessionCount.mockResolvedValue(0);
    mockGetFreshnessForUser.mockResolvedValue(null);

    // No row: null, not an error.
    userStatsResult = { data: null, error: null };
    expect((await (await GET(new NextRequest("http://localhost/api/pulse"))).json()).stats_line).toBeNull();

    // The read throws (e.g. the table is missing): still 200, still null.
    userStatsResult = () => {
      throw new Error("relation user_stats does not exist");
    };
    const failed = await GET(new NextRequest("http://localhost/api/pulse"));
    expect(failed.status).toBe(200);
    expect((await failed.json()).stats_line).toBeNull();

    // A row: one sentence, cost labelled est. — numerics may arrive as strings from PostgREST.
    userStatsResult = {
      data: {
        user_id: "u1",
        day: "2026-09-24",
        sessions: 4,
        cost_usd: "21.4",
        commits: 0,
        mcp_calls: 0,
        longest_session_seconds: null,
        busiest_repo: null,
        most_edited_file: null,
        start_hour: null,
        first_session_at: null,
      },
      error: null,
    };
    const line = (await (await GET(new NextRequest("http://localhost/api/pulse"))).json()).stats_line;
    expect(typeof line).toBe("string");
    expect(line).toContain("2026-09-24");
    expect(line).toMatch(/\$21 est\./);
  });

  it("returns 401 when there is no session", async () => {
    mockGetUser.mockResolvedValue({ data: { user: null } });
    const res = await GET(new NextRequest("http://localhost/api/pulse"));
    expect(res.status).toBe(401);
  });

  it("serves open_threads, recent_threads and recurring_blockers from listOpenThreads (W7/P5), and a read failure as null (F9: logged, never the all-clear [])", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockRecentChats.mockResolvedValue({ data: [], error: null });
    mockGetCodeSessionCount.mockResolvedValue(3);
    mockGetRecentCodeSessions.mockResolvedValue([]);
    mockGetFreshnessForUser.mockResolvedValue(null);
    const thread = {
      ref: "codehub.example/acme/billing#15178",
      refKind: "issue",
      open: true,
      closure: null,
      estimated: true,
    };
    mockListOpenThreads.mockResolvedValue({
      open: [thread],
      recent: [thread, { ...thread, ref: "codehub.example/acme/billing#254702", open: false }],
      recurring_blockers: [{ id: "b1", text: "smoke job times out", recurrence_count: 3 }],
      estimated: true,
      window_days: 30,
    });

    const ok = await (await GET(new NextRequest("http://localhost/api/pulse"))).json();
    expect(ok.open_threads).toEqual([thread]);
    expect(ok.recent_threads).toHaveLength(2);
    expect(ok.recurring_blockers[0].recurrence_count).toBe(3);
    expect(mockListOpenThreads).toHaveBeenCalledWith(expect.anything(), "u1");

    mockListOpenThreads.mockRejectedValue(new Error("code_session_issues read failed"));
    const res = await GET(new NextRequest("http://localhost/api/pulse"));
    const degraded = await res.json();
    expect(res.status).toBe(200);
    expect(degraded.open_threads).toBeNull();
    expect(degraded.recent_threads).toBeNull();
    expect(degraded.recurring_blockers).toBeNull();
    expect(degraded).not.toHaveProperty("you_said");
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/open threads read failed/);
    errSpy.mockRestore();
  });

  it("ignores the threads read for a user with no code sessions (#173: started early, outcome dropped)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockRecentChats.mockResolvedValue({ data: [], error: null });
    mockGetCodeSessionCount.mockResolvedValue(0);
    mockGetFreshnessForUser.mockResolvedValue(null);
    for (const outcome of ["resolve", "reject"] as const) {
      if (outcome === "resolve") {
        mockListOpenThreads.mockResolvedValue({ open: [{ ref: "x" }], recent: [{ ref: "x" }], recurring_blockers: [] });
      } else {
        mockListOpenThreads.mockRejectedValue(new Error("threads boom"));
      }
      const data = await (await GET(new NextRequest("http://localhost/api/pulse"))).json();
      expect(data.open_threads).toEqual([]);
      expect(data.recent_threads).toEqual([]);
      expect(data.recurring_blockers).toEqual([]);
      expect(data.session_titles).toEqual({});
      expect(data.recent_code_sessions).toEqual([]);
    }
    expect(mockGetRecentCodeSessions).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).not.toMatch(/open threads read failed/);
    errSpy.mockRestore();
  });

  it("returns recent, recent_code_sessions and freshness — not census", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    const recent = [
      { id: "c1", title: "Chat", source: "claude", date: "2026-09-20", area_id: null, area_label: null, orphan: true },
    ];
    mockRecentChats.mockResolvedValue({
      data: [{ id: "c1", title: "Chat", source: "claude", created_at: "2026-09-20" }],
      error: null,
    });
    mockGetCodeSessionCount.mockResolvedValue(2);
    mockGetRecentCodeSessions.mockResolvedValue([{ id: "s1", code_project_id: "p1" }]);
    mockGetFreshnessForUser.mockResolvedValue({
      corpus_current_through: { claude: { last_item_at: "x", last_synced_at: "y" } },
      generated_at: "z",
    });

    const res = await GET(new NextRequest("http://localhost/api/pulse"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.recent).toEqual(recent);
    expect(data.recent_code_sessions).toEqual([{ id: "s1", code_project_id: "p1" }]);
    expect(data.freshness.corpus_current_through.claude.last_item_at).toBe("x");
    expect(data.census).toBeUndefined();
    expect(mockGetRecentCodeSessions).toHaveBeenCalledWith(expect.anything(), "u1", 8);
  });

  it("skips getRecentCodeSessions when the user has no code sessions", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockRecentChats.mockResolvedValue({ data: [], error: null });
    mockGetCodeSessionCount.mockResolvedValue(0);
    mockGetFreshnessForUser.mockResolvedValue(null);

    const res = await GET(new NextRequest("http://localhost/api/pulse"));
    const data = await res.json();

    expect(data.recent_code_sessions).toEqual([]);
    expect(mockGetRecentCodeSessions).not.toHaveBeenCalled();
  });

  it("degrades recent_code_sessions to [] when the code-session fetch throws, without failing the route", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockRecentChats.mockResolvedValue({ data: [], error: null });
    mockGetCodeSessionCount.mockResolvedValue(3);
    mockGetRecentCodeSessions.mockRejectedValue(new Error("boom"));
    mockGetFreshnessForUser.mockResolvedValue(null);

    const res = await GET(new NextRequest("http://localhost/api/pulse"));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.recent_code_sessions).toEqual([]);
  });

  it("returns 500 with an error message when the recent-chats read fails", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    mockRecentChats.mockResolvedValue({ data: null, error: { message: "no table" } });

    const res = await GET(new NextRequest("http://localhost/api/pulse"));
    const data = await res.json();

    expect(res.status).toBe(500);
    expect(data.error).toMatch(/recent conversations read failed/);
  });

  it("#173: starts the independent reads together — none waits on the recent-chats read", async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: "u1" } } });
    let releasePayload: (v: unknown) => void = () => {};
    mockRecentChats.mockReturnValue(
      new Promise((resolve) => {
        releasePayload = resolve;
      }),
    );
    mockGetCodeSessionCount.mockResolvedValue(3);
    mockGetRecentCodeSessions.mockResolvedValue([]);
    mockGetFreshnessForUser.mockResolvedValue(null);
    mockListOpenThreads.mockResolvedValue({ open: [], recent: [], recurring_blockers: [] });

    const pending = GET(new NextRequest("http://localhost/api/pulse"));
    // Let every microtask chain run while the payload read is still pending.
    await new Promise((r) => setTimeout(r, 0));
    expect(mockGetCodeSessionCount).toHaveBeenCalledTimes(1);
    expect(mockGetFreshnessForUser).toHaveBeenCalledTimes(1);
    expect(mockGetRecentCodeSessions).toHaveBeenCalledTimes(1);
    expect(mockListOpenThreads).toHaveBeenCalledTimes(1);

    releasePayload({ data: [], error: null });
    const res = await pending;
    expect(res.status).toBe(200);
  });
});
