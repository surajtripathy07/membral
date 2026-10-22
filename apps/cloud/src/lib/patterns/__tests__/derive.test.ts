// Goal 2026-09-26 P9 / W10 — derivePatternsForUser: sessions → turns → patterns → props.patterns (≤ 3).
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGuarded = vi.fn();
vi.mock("@/lib/llm/spend-ledger", () => ({ createCostGuardedLlm: (...args: unknown[]) => mockGuarded(...args) }));
const mockCheckFeature = vi.fn();
vi.mock("@/lib/feature-flags", () => ({ checkFeature: (...args: unknown[]) => mockCheckFeature(...args) }));
const mockCeiling = vi.fn();
vi.mock("@/lib/memory/global-ceiling", () => ({
  checkGlobalCeilings: (...args: unknown[]) => mockCeiling(...args),
}));
const mockMonthly = vi.fn();
vi.mock("@/lib/memory/monthly-spend", () => ({
  memoryMonthlyRemainingUsd: (...args: unknown[]) => mockMonthly(...args),
}));
const FEATURE_OK = { allowed: true, reason: "ok", spentUsd: 0.01, budgetUsd: 1, dailyUsd: 0.5, contact: "x" };
const CEILING_OK = { allowed: true, spentUsd: 1, ceilingUsd: 10 };

import { derivePatternsForUser, derivePatternsNightly } from "../derive";
import { MAX_DRAFT_QUOTES } from "../draft-skill";
import { parseStoredPatterns } from "../storage";

type Row = Record<string, unknown>;

/** A tiny PostgREST-shaped fake: tables of rows, filters applied in order, one page. */
function fakeSupabase(tables: Record<string, Row[]>) {
  const updates: { table: string; patch: Row; id: string }[] = [];
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (col: string, v: unknown) => {
        rows = rows.filter((r) => r[col] === v);
        return q;
      },
      is: (col: string, v: unknown) => {
        rows = rows.filter((r) => (r[col] ?? null) === v);
        return q;
      },
      not: (col: string, _op: string, v: unknown) => {
        rows = rows.filter((r) => (r[col] ?? null) !== v);
        return q;
      },
      gte: (col: string, v: string) => {
        rows = rows.filter((r) => typeof r[col] === "string" && (r[col] as string) >= v);
        return q;
      },
      in: (col: string, vals: unknown[]) => {
        rows = rows.filter((r) => vals.includes(r[col]));
        return q;
      },
      order: () => q,
      range: async (a: number, b: number) => ({ data: rows.slice(a, b + 1), error: null }),
      limit: async (n: number) => ({ data: rows.slice(0, n), error: null }),
      maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
      update: (patch: Row) => ({
        eq: async (_col: string, id: string) => {
          updates.push({ table, patch, id });
          return { error: null };
        },
      }),
    };
    return q;
  };
  return { from, updates };
}

const NOW = new Date("2026-09-26T03:00:00Z");
const bashTurn = (session_id: string, idx: number, digest: string): Row => ({
  session_id,
  idx,
  tool_name: "Bash",
  file_path: null,
  ts: "2026-09-20T10:00:00Z",
  props: { inputDigest: digest },
});
const editTurn = (session_id: string, idx: number, path: string): Row => ({
  session_id,
  idx,
  tool_name: "Edit",
  file_path: path,
  ts: "2026-09-20T10:05:00Z",
  props: {},
});

function habitSessions(projectId: string, n: number, prefix: string): { sessions: Row[]; turns: Row[] } {
  const sessions: Row[] = [];
  const turns: Row[] = [];
  for (let i = 0; i < n; i++) {
    const id = `${prefix}${i}`;
    sessions.push({
      id,
      user_id: "u1",
      code_project_id: projectId,
      parent_source_session_id: null,
      started_at: "2026-09-20T09:00:00Z",
    });
    turns.push(bashTurn(id, 0, "npm test -- --run"), editTurn(id, 1, "src/a.ts"), bashTurn(id, 2, "git commit -m x"));
  }
  return { sessions, turns };
}

describe("derivePatternsForUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGuarded.mockResolvedValue({ ok: false, reason: "monthly_ceiling_exceeded" });
    mockCheckFeature.mockResolvedValue(FEATURE_OK);
    mockCeiling.mockResolvedValue(CEILING_OK);
    mockMonthly.mockResolvedValue(null);
  });

  const oneProject = () => {
    const { sessions, turns } = habitSessions("p1", 5, "s");
    return fakeSupabase({
      code_sessions: sessions,
      code_session_turns: turns,
      code_projects: [{ id: "p1", display_name: "codehub/billing", repo_identity: "codehub/billing", props: {} }],
    });
  };

  it("drafting obeys the memory feature and its daily allowance, as extraction does: refused → heuristic, no LLM built", async () => {
    mockCheckFeature.mockResolvedValue({ ...FEATURE_OK, allowed: false, reason: "daily_exhausted" });
    const summary = await derivePatternsForUser(oneProject() as never, "u1", { now: NOW });
    expect(summary.drafted).toBe(1);
    expect(mockCheckFeature).toHaveBeenCalledWith("u1", "memory");
    expect(mockGuarded).not.toHaveBeenCalled();
  });

  it("issue #335: the global monthly ceiling refuses drafting — heuristic only, no LLM built", async () => {
    mockCeiling.mockResolvedValue({ allowed: false, reason: "global_monthly_ceiling", spentUsd: 30, ceilingUsd: 30 });
    const summary = await derivePatternsForUser(oneProject() as never, "u1", { now: NOW });
    expect(summary.drafted).toBe(1);
    expect(mockGuarded).not.toHaveBeenCalled();
  });

  it("the global daily ceiling refuses drafting too; allowed, the cap is the smallest remaining allowance", async () => {
    mockCeiling.mockResolvedValue({ allowed: false, reason: "global_daily_ceiling", spentUsd: 10, ceilingUsd: 10 });
    await derivePatternsForUser(oneProject() as never, "u1", { now: NOW });
    expect(mockGuarded).not.toHaveBeenCalled();

    mockCeiling.mockResolvedValue(CEILING_OK);
    mockCheckFeature.mockResolvedValue({ ...FEATURE_OK, budgetUsd: 0.05, spentUsd: 0.01 });
    await derivePatternsForUser(oneProject() as never, "u1", { now: NOW });
    expect(mockGuarded).toHaveBeenCalledTimes(1);
    const opts = mockGuarded.mock.calls[0][2] as { capUsdOverride: number; bypassFeatureGate: boolean };
    expect(opts.bypassFeatureGate).toBe(true);
    expect(opts.capUsdOverride).toBeCloseTo(0.04, 9);
  });

  it("the hosted monthly memory budget caps drafting: exhausted → heuristic, partly spent → the cap", async () => {
    mockMonthly.mockResolvedValue(0);
    await derivePatternsForUser(oneProject() as never, "u1", { now: NOW });
    expect(mockGuarded).not.toHaveBeenCalled();

    mockMonthly.mockResolvedValue(0.02);
    await derivePatternsForUser(oneProject() as never, "u1", { now: NOW });
    expect(mockGuarded).toHaveBeenCalledTimes(1);
    expect((mockGuarded.mock.calls[0][2] as { capUsdOverride: number }).capUsdOverride).toBeCloseTo(0.02, 9);
  });

  it("every drafted session gets its quote even when one session has hundreds of user turns", async () => {
    const { sessions, turns } = habitSessions("p1", 5, "s");
    const chatty = Array.from({ length: 250 }, (_, i) => ({
      session_id: sessions[0].id,
      user_id: "u1",
      idx: i,
      role: "user",
      kind: "prose",
      text: `chatty ${i}`,
    }));
    const others = sessions.slice(1).map((s) => ({
      session_id: s.id,
      user_id: "u1",
      idx: 0,
      role: "user",
      kind: "prose",
      text: `asked for thing ${s.id}`,
    }));
    const sb = fakeSupabase({
      code_sessions: sessions,
      code_session_turns: [...turns, ...chatty, ...others],
      code_projects: [{ id: "p1", display_name: "codehub/billing", repo_identity: "codehub/billing", props: {} }],
    });
    await derivePatternsForUser(sb as never, "u1", { now: NOW });
    const pattern = parseStoredPatterns(sb.updates[0].patch.props)[0];
    const cited = new Set((pattern.draft?.sources ?? []).map((q) => q.session_id));
    expect(cited.size).toBe(Math.min(pattern.sessionIds.length, MAX_DRAFT_QUOTES));
  });

  it("P9 chain: the stored draft cites the owner's opening prompts from the pattern's own sessions", async () => {
    const { sessions, turns } = habitSessions("p1", 5, "s");
    const prose = sessions.map((s, i) => ({
      session_id: s.id,
      user_id: "u1",
      idx: -1 + 0 * i,
      role: "user",
      kind: "prose",
      text: `asked for thing ${s.id}`,
    }));
    const sb = fakeSupabase({
      code_sessions: sessions,
      code_session_turns: [...turns, ...prose],
      code_projects: [{ id: "p1", display_name: "codehub/billing", repo_identity: "codehub/billing", props: {} }],
    });
    await derivePatternsForUser(sb as never, "u1", { now: NOW });
    const stored = parseStoredPatterns(sb.updates[0].patch.props);
    const pattern = stored[0];
    const sources = pattern.draft?.sources ?? [];
    expect(sources.length).toBeGreaterThan(0);
    for (const q of sources) {
      expect(pattern.sessionIds).toContain(q.session_id);
      expect(q.quote).toBe(`asked for thing ${q.session_id}`);
    }
  });

  it("a sequence repeated in five sessions is stored on the project with a heuristic draft when the LLM is refused", async () => {
    const { sessions, turns } = habitSessions("p1", 5, "s");
    const sb = fakeSupabase({
      code_sessions: sessions,
      code_session_turns: turns,
      code_projects: [
        {
          id: "p1",
          display_name: "codehub/billing",
          repo_identity: "codehub/billing",
          props: { rollup: { summary: "x" } },
        },
      ],
    });
    const summary = await derivePatternsForUser(sb as never, "u1", { now: NOW });
    expect(summary).toEqual({ projects: 1, patterns: 1, drafted: 1 });
    expect(sb.updates).toHaveLength(1);
    const props = sb.updates[0].patch.props as Record<string, unknown>;
    expect(props.rollup).toEqual({ summary: "x" }); // other props keys untouched
    const stored = parseStoredPatterns(props);
    expect(stored).toHaveLength(1);
    expect(stored[0].steps).toEqual(["npm test", "Edit ts", "git commit"]);
    expect(stored[0].sessionCount).toBe(5);
    expect(stored[0].sessionIds).toHaveLength(5);
    expect(stored[0].draft?.source).toBe("heuristic");
    expect(stored[0].draft?.draftedAt).toBe(NOW.toISOString());
  });

  it("four sessions are not a pattern (minSessions 5) and the project is not written", async () => {
    const { sessions, turns } = habitSessions("p1", 4, "s");
    const sb = fakeSupabase({
      code_sessions: sessions,
      code_session_turns: turns,
      code_projects: [{ id: "p1", display_name: null, repo_identity: "r", props: {} }],
    });
    expect(await derivePatternsForUser(sb as never, "u1", { now: NOW })).toEqual({
      projects: 0,
      patterns: 0,
      drafted: 0,
    });
    expect(sb.updates).toHaveLength(0);
  });

  it("a fresh stored draft is reused (one LLM call per pattern per week) and a stale one is re-drafted", async () => {
    const { sessions, turns } = habitSessions("p1", 5, "s");
    const fresh = {
      name: "kept",
      description: "kept",
      steps: ["kept"],
      source: "llm",
      draftedAt: "2026-09-24T00:00:00Z",
    };
    const sb = fakeSupabase({
      code_sessions: sessions,
      code_session_turns: turns,
      code_projects: [
        {
          id: "p1",
          display_name: null,
          repo_identity: "r",
          props: {
            patterns: [
              {
                key: "npm test → Edit ts → git commit",
                steps: ["npm test", "Edit ts", "git commit"],
                sessionCount: 5,
                draft: fresh,
              },
            ],
          },
        },
      ],
    });
    const llm = { callJson: vi.fn() };
    const llmFactory = vi.fn().mockResolvedValue({ llm, flush: vi.fn() });
    const summary = await derivePatternsForUser(sb as never, "u1", { now: NOW, llmFactory });
    expect(summary.drafted).toBe(0);
    expect(llmFactory).not.toHaveBeenCalled();
    expect(parseStoredPatterns(sb.updates[0].patch.props)[0].draft?.name).toBe("kept");

    // Stale (8 days old) → drafted again; the LLM's good answer is used.
    llm.callJson.mockResolvedValue({
      data: { name: "test-commit", description: "d", steps: ["a", "b", "c"] },
      record: {},
      callCostUsd: 0.001,
    });
    const sb2 = fakeSupabase({
      code_sessions: sessions,
      code_session_turns: turns,
      code_projects: [
        {
          id: "p1",
          display_name: null,
          repo_identity: "r",
          props: {
            patterns: [
              {
                ...parseStoredPatterns({
                  patterns: [
                    {
                      key: "npm test → Edit ts → git commit",
                      steps: ["npm test", "Edit ts", "git commit"],
                      sessionCount: 5,
                      draft: { ...fresh, draftedAt: "2026-09-17T00:00:00Z" },
                    },
                  ],
                })[0],
              },
            ],
          },
        },
      ],
    });
    const summary2 = await derivePatternsForUser(sb2 as never, "u1", { now: NOW, llmFactory });
    expect(summary2.drafted).toBe(1);
    expect(llm.callJson).toHaveBeenCalledTimes(1);
    expect(parseStoredPatterns(sb2.updates[0].patch.props)[0].draft).toMatchObject({
      name: "test-commit",
      source: "llm",
    });
  });

  it("at most three patterns per project are kept", async () => {
    const seqs = [
      ["npm test", "a.ts", "git commit -m x"],
      ["gh pr view 1", "a.md", "git push"],
      ["pytest -q", "a.py", "git commit -m y"],
      ["cargo test", "a.rs", "git push origin"],
    ];
    const sessions: Row[] = [];
    const turns: Row[] = [];
    seqs.forEach((seq, si) => {
      for (let k = 0; k < 5 + si; k++) {
        const id = `p${si}s${k}`;
        sessions.push({
          id,
          user_id: "u1",
          code_project_id: "p1",
          parent_source_session_id: null,
          started_at: "2026-09-20T09:00:00Z",
        });
        turns.push(bashTurn(id, 0, seq[0]), editTurn(id, 1, seq[1]), bashTurn(id, 2, seq[2]));
      }
    });
    const sb = fakeSupabase({
      code_sessions: sessions,
      code_session_turns: turns,
      code_projects: [{ id: "p1", display_name: null, repo_identity: "r", props: {} }],
    });
    const summary = await derivePatternsForUser(sb as never, "u1", { now: NOW });
    expect(summary.patterns).toBe(3);
    const stored = parseStoredPatterns(sb.updates[0].patch.props);
    expect(stored).toHaveLength(3);
    expect(stored.map((p) => p.sessionCount)).toEqual([8, 7, 6]);
  });

  it("derivePatternsNightly runs every active user and counts a failing user without stopping", async () => {
    const { sessions, turns } = habitSessions("p1", 5, "s");
    const sb = fakeSupabase({
      code_sessions: [
        ...sessions,
        {
          id: "z",
          user_id: "u2",
          code_project_id: "p2",
          parent_source_session_id: null,
          started_at: "2026-09-20T09:00:00Z",
        },
      ],
      code_session_turns: turns,
      code_projects: [{ id: "p1", display_name: null, repo_identity: "r", props: {} }],
    });
    const summary = await derivePatternsNightly(sb as never, { now: NOW });
    expect(summary).toMatchObject({ users: 2, projects: 1, patterns: 1, failedUsers: 0, skippedTimeBudget: 0 });

    const deadline = await derivePatternsNightly(sb as never, { now: NOW, deadlineMs: Date.now() - 1 });
    expect(deadline).toMatchObject({ users: 2, skippedTimeBudget: 2, projects: 0 });
  });
});
