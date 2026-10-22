import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockReconcile = vi.fn();
const order: string[] = [];
vi.mock("@/lib/memory/extraction-queue", () => ({
  MEMORY_QUEUE_TABLE: "memory_extraction_queue",
  reconcileMemoryExtractionQueue: (...args: unknown[]) => {
    order.push("reconcile");
    return mockReconcile(...args);
  },
}));
const mockTrigger = vi.fn();
vi.mock("@/lib/memory/extraction-trigger", () => ({
  resolveInternalBaseUrl: () => "http://localhost:3001",
  triggerMemoryExtraction: (...args: unknown[]) => mockTrigger(...args),
}));
vi.mock("@/lib/env", () => ({ cronSecret: () => "s3cret" }));
let queued: { user_id: string; session_id: string }[] = [];
vi.mock("@/lib/db/clients", () => ({
  getServiceClient: () => ({}),
  SUPABASE_ENV_MISSING_MESSAGE: "Missing Supabase env vars (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)",
}));
vi.mock("@/lib/util/pagination", () => ({
  selectAllRows: async () => {
    order.push("list");
    return queued;
  },
}));
const mockStats = vi.fn();
vi.mock("@/lib/stats/derive-user-stats", () => ({
  deriveUserStatsForDay: (...args: unknown[]) => {
    order.push("stats");
    return mockStats(...args);
  },
}));

const mockPatterns = vi.fn();
vi.mock("@/lib/patterns/derive", () => ({
  derivePatternsNightly: (...args: unknown[]) => {
    order.push("patterns");
    return mockPatterns(...args);
  },
}));

import { GET } from "../route";

const req = () =>
  new NextRequest("http://localhost:3001/api/internal/cron/memory-extraction", {
    headers: { authorization: "Bearer s3cret" },
  });

describe("GET /api/internal/cron/memory-extraction (R3-M1 reconcile)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    queued = [{ user_id: "u1", session_id: "s1" }];
    mockTrigger.mockResolvedValue(true);
    mockStats.mockResolvedValue({ day: "2026-09-25", users: 1, sessions: 2 });
    mockPatterns.mockResolvedValue({
      users: 1,
      projects: 1,
      patterns: 2,
      drafted: 1,
      failedUsers: 0,
      skippedTimeBudget: 0,
    });
  });

  it("derives per-project patterns after user_stats and reports the counts in the summary (P9)", async () => {
    mockReconcile.mockResolvedValue({ users: 1, ensured: 0, requeued: 0, failedUsers: 0 });
    const res = await GET(req());
    expect(order).toEqual(["reconcile", "list", "stats", "patterns"]);
    expect(mockPatterns).toHaveBeenCalledTimes(1);
    expect(mockPatterns.mock.calls[0][1]).toMatchObject({ deadlineMs: expect.any(Number) });
    expect(await res.json()).toMatchObject({
      ok: true,
      kicked: 1,
      patterns_users: 1,
      patterns_projects: 1,
      patterns_found: 2,
      patterns_drafted: 1,
      patterns_error: null,
    });
  });

  it("a patterns failure is logged into the summary and the run still reports ok with its kicks and stats", async () => {
    mockReconcile.mockResolvedValue({ users: 1, ensured: 0, requeued: 0, failedUsers: 0 });
    mockPatterns.mockRejectedValue(new Error("code_projects update refused"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      kicked: 1,
      stats_day: "2026-09-25",
      patterns_found: 0,
      patterns_error: "code_projects update refused",
    });
  });

  it("derives yesterday's user_stats after the chains are kicked and reports the day in the summary (P8)", async () => {
    mockReconcile.mockResolvedValue({ users: 1, ensured: 0, requeued: 0, failedUsers: 0 });
    const res = await GET(req());
    expect(order.slice(0, 3)).toEqual(["reconcile", "list", "stats"]);
    expect(mockStats).toHaveBeenCalledTimes(1);
    expect(await res.json()).toMatchObject({
      ok: true,
      kicked: 1,
      stats_day: "2026-09-25",
      stats_users: 1,
      stats_sessions: 2,
      stats_error: null,
    });
  });

  it("a user_stats failure is logged into the summary and the run still reports ok with its kicks", async () => {
    mockReconcile.mockResolvedValue({ users: 1, ensured: 0, requeued: 0, failedUsers: 0 });
    mockStats.mockRejectedValue(new Error("relation user_stats does not exist"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      kicked: 1,
      stats_day: null,
      stats_users: 0,
      stats_error: "relation user_stats does not exist",
    });
  });

  it("reconciles before listing queued users, then kicks each user's chain", async () => {
    mockReconcile.mockResolvedValue({ users: 1, ensured: 1, requeued: 2, failedUsers: 0 });
    const res = await GET(req());
    expect(order.slice(0, 2)).toEqual(["reconcile", "list"]);
    expect(await res.json()).toMatchObject({
      ok: true,
      kicked: 1,
      reconciled_ensured: 1,
      reconciled_requeued: 2,
      reconcile_failed_users: 0,
    });
    expect(mockTrigger).toHaveBeenCalledWith("u1", "http://localhost:3001");
  });

  it("a reconcile failure is logged and the chains already queued are still kicked", async () => {
    mockReconcile.mockRejectedValue(new Error("db down"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, kicked: 1, reconcile_failed_users: null });
  });
});

describe("GET /api/internal/cron/memory-extraction — kick-only mode and per-user backoff (issue #339)", () => {
  const kickReq = (query: string) =>
    new NextRequest(`http://localhost:3001/api/internal/cron/memory-extraction${query}`, {
      headers: { authorization: "Bearer s3cret" },
    });
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  beforeEach(() => {
    vi.clearAllMocks();
    order.length = 0;
    queued = [{ user_id: "u1", session_id: "s1" }];
    mockTrigger.mockResolvedValue(true);
    mockReconcile.mockResolvedValue({ users: 1, ensured: 0, requeued: 0, failedUsers: 0 });
    mockStats.mockResolvedValue({ day: "2026-09-25", users: 1, sessions: 2 });
    mockPatterns.mockResolvedValue({ users: 0, projects: 0, patterns: 0, drafted: 0, failedUsers: 0 });
  });

  it("kick=1 skips reconcile, stats and patterns, and still kicks", async () => {
    const res = await GET(kickReq("?kick=1"));
    expect(res.status).toBe(200);
    expect(mockReconcile).not.toHaveBeenCalled();
    expect(mockStats).not.toHaveBeenCalled();
    expect(mockPatterns).not.toHaveBeenCalled();
    expect(order).toEqual(["list"]);
    expect(mockTrigger).toHaveBeenCalledWith("u1", "http://localhost:3001");
    expect(await res.json()).toMatchObject({ ok: true, mode: "kick", kicked: 1, skipped_backoff: 0 });
  });

  it("no parameter (or any other kick value): reconcile, stats and patterns all run, mode full", async () => {
    for (const q of ["", "?kick=0", "?kick=true"]) {
      vi.clearAllMocks();
      order.length = 0;
      const res = await GET(kickReq(q));
      expect(order).toEqual(["reconcile", "list", "stats", "patterns"]);
      expect(mockReconcile).toHaveBeenCalledTimes(1);
      expect(mockStats).toHaveBeenCalledTimes(1);
      expect(mockPatterns).toHaveBeenCalledTimes(1);
      expect(await res.json()).toMatchObject({ ok: true, mode: "full", kicked: 1, skipped_backoff: 0 });
    }
  });

  it("backs off a user whose last counted failure is recent; kicks a clean user and an expired-lease user", async () => {
    queued = [
      { user_id: "uA", session_id: "a1", status: "pending", attempts: 1, updated_at: minutesAgo(5) },
      { user_id: "uA", session_id: "a2", status: "pending", attempts: 0, updated_at: minutesAgo(60) },
      { user_id: "uB", session_id: "b1", status: "pending", attempts: 0, updated_at: minutesAgo(1) },
      { user_id: "uC", session_id: "c1", status: "running", attempts: 1, updated_at: minutesAgo(20) },
    ] as unknown as typeof queued;
    for (const q of ["?kick=1", ""]) {
      vi.clearAllMocks();
      const res = await GET(kickReq(q));
      const kickedUsers = mockTrigger.mock.calls.map((c) => c[0]);
      expect(kickedUsers).toEqual(["uB", "uC"]);
      expect(await res.json()).toMatchObject({ ok: true, users: 3, kicked: 2, skipped_backoff: 1 });
    }
  });
});
