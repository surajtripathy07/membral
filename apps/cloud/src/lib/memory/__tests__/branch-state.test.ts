// lib/memory/branch-state.ts — goal 2026-09-26 W6 / P4 (B4, B6, B14).
import { describe, expect, it } from "vitest";
import {
  type BranchCheckResult,
  BranchStatePostSchema,
  type BranchStateRow,
  DETACHED_BRANCH_PREFIX,
  filterReposToCheck,
  loadRefsToCheck,
  mergeBranchStateRow,
  planRefsToCheck,
  resolveBranchStateDays,
  upsertBranchState,
} from "../branch-state";

const P1 = "11111111-1111-4111-8111-111111111111";
const USER = "uuuuuuuu-uuuu-4uuu-8uuu-uuuuuuuuuuuu";
const A1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const B2 = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const C3 = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";

const project = { id: P1, repo_identity: "codehub.example/acme/billing", repo_path: "/home/dev/src/billing" };
function session(id: string, started_at: string, extra: Partial<{ cwd: string; git_branch: string }> = {}) {
  return {
    id,
    code_project_id: P1,
    cwd: extra.cwd ?? "/home/dev/src/billing",
    git_branch: extra.git_branch ?? null,
    started_at,
  };
}
function turn(session_id: string, idx: number, action: Record<string, unknown> | Record<string, unknown>[]) {
  return {
    session_id,
    idx,
    props: Array.isArray(action) ? { action: action[0], actions: action } : { action },
  };
}

describe("planRefsToCheck", () => {
  it("B4 fixture: two sessions overlapping in one cwd keep their own refs — the commit's sha never carries the review's ref", () => {
    const plan = planRefsToCheck({
      projects: [project],
      sessions: [session("s-commit", "2026-09-26T08:50:00Z"), session("s-review", "2026-09-26T08:55:00Z")],
      turns: [
        turn("s-review", 3, {
          verb: "checked_out",
          ref: "acme/billing!2",
          refKind: "merge_request",
          branch: "mr-2-fix",
          source: "cli",
        }),
        turn("s-commit", 4, {
          verb: "committed",
          ref: "acme/billing#1",
          refKind: "issue",
          sha: A1,
          branch: "feat-1",
          source: "cli",
        }),
        turn("s-review", 9, { verb: "viewed", ref: "acme/billing!2", source: "cli" }),
      ],
    });
    expect(plan).toHaveLength(1);
    const repo = plan[0];
    expect(repo.codeProjectId).toBe(P1);
    expect(repo.paths).toEqual(["/home/dev/src/billing"]);
    expect(repo.shas).toEqual([{ sha: A1, branch: "feat-1", ref: "acme/billing#1", sessionId: "s-commit" }]);
    expect(repo.branches).toEqual(["feat-1", "mr-2-fix"]);
    // Nothing in the plan mentions !2 next to the commit, or #1 next to the checkout.
    expect(repo.shas.some((s) => s.ref === "acme/billing!2")).toBe(false);
    expect(repo.openRefs).toEqual([]);
  });

  it("B6: a rewrite supersedes the shas named before it on that branch; the newest sha is what remains", () => {
    const [repo] = planRefsToCheck({
      projects: [project],
      sessions: [session("s1", "2026-09-26T09:00:00Z", { git_branch: "feat-9" })],
      turns: [
        turn("s1", 2, { verb: "committed", ref: "acme/billing#9", sha: A1, branch: "feat-9", source: "cli" }),
        turn("s1", 5, { verb: "rewrote", branch: "feat-9", source: "cli" }),
        turn("s1", 7, { verb: "committed", ref: "acme/billing#9", sha: B2, branch: "feat-9", source: "cli" }),
        turn("s1", 8, { verb: "pushed", branch: "feat-9", source: "cli" }),
      ],
    });
    expect(repo.shas.map((s) => s.sha)).toEqual([B2]);
    expect(repo.branches).toEqual(["feat-9"]);
  });

  it("a rewrite on one branch leaves another branch's shas alone; the session's git_branch fills a missing action branch", () => {
    const [repo] = planRefsToCheck({
      projects: [project],
      sessions: [session("s1", "2026-09-26T09:00:00Z", { git_branch: "feat-a" })],
      turns: [
        turn("s1", 1, { verb: "committed", sha: A1, source: "cli" }), // -> feat-a via git_branch
        turn("s1", 2, { verb: "committed", sha: B2, branch: "feat-b", source: "cli" }),
        turn("s1", 3, { verb: "rewrote", branch: "feat-b", source: "cli" }),
      ],
    });
    expect(repo.shas).toEqual([{ sha: A1, branch: "feat-a", ref: null, sessionId: "s1" }]);
    expect(repo.branches).toEqual(["feat-a", "feat-b"]);
  });

  it("a sha tied to no branch gets the commit:<sha> key and adds no branch", () => {
    const [repo] = planRefsToCheck({
      projects: [project],
      sessions: [session("s1", "2026-09-26T09:00:00Z")],
      turns: [turn("s1", 1, { verb: "committed", sha: C3, source: "cli" })],
    });
    expect(repo.shas[0].branch).toBe(`${DETACHED_BRANCH_PREFIX}${C3}`);
    expect(repo.branches).toEqual([]);
  });

  it("opened_mr refs stay open until a merged/closed action (or state) for that ref appears in any session", () => {
    const [repo] = planRefsToCheck({
      projects: [project],
      sessions: [session("s1", "2026-09-26T09:00:00Z"), session("s2", "2026-09-26T13:00:00Z")],
      turns: [
        turn("s1", 1, {
          verb: "opened_mr",
          ref: "acme/billing!40",
          url: "https://codehub.example/acme/billing/-/merge_requests/40",
          branch: "feat-40",
          source: "cli",
        }),
        turn("s1", 2, { verb: "opened_mr", ref: "acme/billing!41", branch: "feat-41", source: "cli" }),
        turn("s2", 3, { verb: "merged", ref: "acme/billing!41", source: "cli" }),
        turn("s1", 4, { verb: "opened_mr", ref: "acme/billing!42", source: "cli" }),
        turn("s2", 5, { verb: "viewed", ref: "acme/billing!42", state: "closed", source: "mcp" }),
      ],
    });
    expect(repo.openRefs).toEqual([
      {
        ref: "acme/billing!40",
        url: "https://codehub.example/acme/billing/-/merge_requests/40",
        branch: "feat-40",
        sessionId: "s1",
      },
    ]);
  });

  it("orders the superseded rule by (session start, idx) across sessions and reads props.actions when present", () => {
    const [repo] = planRefsToCheck({
      projects: [project],
      sessions: [session("late", "2026-09-26T12:00:00Z"), session("early", "2026-09-26T08:00:00Z")],
      turns: [
        turn("late", 1, [{ verb: "committed", sha: B2, branch: "f", source: "cli" }]),
        turn("early", 1, [
          { verb: "committed", sha: A1, branch: "f", source: "cli" },
          { verb: "rewrote", branch: "f", source: "cli" },
        ]),
      ],
    });
    expect(repo.shas.map((s) => s.sha)).toEqual([B2]);
  });

  it("collects every distinct cwd (worktrees) plus repo_path; skips projects with nothing to check; ignores unknown sessions/projects", () => {
    const plan = planRefsToCheck({
      projects: [project, { id: "p2", repo_identity: "other", repo_path: null }],
      sessions: [
        session("s1", "2026-09-26T09:00:00Z", { cwd: "/home/dev/src/billing" }),
        session("s2", "2026-09-26T10:00:00Z", { cwd: "/home/dev/src/billing-wt2/" }),
        { id: "s3", code_project_id: "p2", cwd: "/x", git_branch: null, started_at: "2026-09-26T10:00:00Z" },
        { id: "s4", code_project_id: "p-missing", cwd: "/y", git_branch: null, started_at: null },
      ],
      turns: [
        turn("s2", 1, { verb: "pushed", branch: "wt-branch", source: "cli" }),
        turn("s-unknown", 1, { verb: "committed", sha: A1, branch: "z", source: "cli" }),
        turn("s3", 1, { verb: "navigated", source: "cli" }),
        turn("s4", 1, { verb: "committed", sha: A1, branch: "z", source: "cli" }),
      ],
    });
    expect(plan.map((r) => r.codeProjectId)).toEqual([P1]);
    expect(plan[0].paths).toEqual(["/home/dev/src/billing", "/home/dev/src/billing-wt2"]);
    expect(plan[0].branches).toEqual(["wt-branch"]);
  });

  it("ignores malformed actions and non-hex shas without throwing", () => {
    const plan = planRefsToCheck({
      projects: [project],
      sessions: [session("s1", "2026-09-26T09:00:00Z")],
      turns: [
        { session_id: "s1", idx: 1, props: { action: "not an object" } },
        { session_id: "s1", idx: 2, props: { action: { verb: 7 } } },
        { session_id: "s1", idx: 3, props: { action: { verb: "committed", sha: "not-a-sha", branch: "b" } } },
        { session_id: "s1", idx: 4, props: null },
      ],
    });
    expect(plan).toEqual([]);
  });
});

describe("filterReposToCheck / resolveBranchStateDays", () => {
  const repos = planRefsToCheck({
    projects: [project],
    sessions: [session("s1", "2026-09-26T09:00:00Z")],
    turns: [turn("s1", 1, { verb: "pushed", branch: "b", source: "cli" })],
  });
  it("matches a repo identity or one of its paths, trailing slash ignored", () => {
    expect(filterReposToCheck(repos, "codehub.example/acme/billing")).toHaveLength(1);
    expect(filterReposToCheck(repos, "/home/dev/src/billing/")).toHaveLength(1);
    expect(filterReposToCheck(repos, "/elsewhere")).toHaveLength(0);
    expect(filterReposToCheck(repos, null)).toBe(repos);
  });
  it("clamps days to [1, 90] and defaults to 30", () => {
    expect(resolveBranchStateDays(null)).toBe(30);
    expect(resolveBranchStateDays("abc")).toBe(30);
    expect(resolveBranchStateDays("0")).toBe(1);
    expect(resolveBranchStateDays("400")).toBe(90);
    expect(resolveBranchStateDays("7")).toBe(7);
  });
});

describe("mergeBranchStateRow", () => {
  const T1 = "2026-09-26T17:30:00.000Z";
  const T2 = "2026-09-27T09:00:00.000Z";
  const result = (over: Partial<BranchCheckResult>): BranchCheckResult => ({
    code_project_id: P1,
    branch: "feat-1",
    default_branch: "main",
    last_seen_sha: A1,
    merged_into_default: null,
    sha_superseded_by: null,
    branch_gone: null,
    ...over,
  });

  it("creates a row with last_seen_sha and no evidence when nothing was proven", () => {
    expect(mergeBranchStateRow(null, result({}), USER, T1)).toEqual<BranchStateRow>({
      user_id: USER,
      code_project_id: P1,
      branch: "feat-1",
      last_seen_sha: A1,
      merged_into: null,
      merged_at: null,
      branch_gone_at: null,
      last_seen_at: T1,
    });
  });

  it("records merged_into/merged_at on the first yes and a later no or unknown never clears it", () => {
    const merged = mergeBranchStateRow(null, result({ merged_into_default: true }), USER, T1);
    expect(merged.merged_into).toBe("main");
    expect(merged.merged_at).toBe(T1);
    const later = mergeBranchStateRow(merged, result({ merged_into_default: false }), USER, T2);
    expect(later.merged_into).toBe("main");
    expect(later.merged_at).toBe(T1);
    expect(later.last_seen_at).toBe(T2);
    expect(mergeBranchStateRow(later, result({ merged_into_default: null }), USER, T2).merged_into).toBe("main");
  });

  it("B6 superseded-sha rule: sha_superseded_by moves last_seen_sha forward", () => {
    const first = mergeBranchStateRow(null, result({}), USER, T1);
    const rewritten = mergeBranchStateRow(first, result({ last_seen_sha: A1, sha_superseded_by: B2 }), USER, T2);
    expect(rewritten.last_seen_sha).toBe(B2);
    expect(rewritten.merged_into).toBeNull();
  });

  it("branch_gone_at is set once, kept on unknown, and cleared when the branch is found again", () => {
    const gone = mergeBranchStateRow(null, result({ branch_gone: true }), USER, T1);
    expect(gone.branch_gone_at).toBe(T1);
    expect(mergeBranchStateRow(gone, result({ branch_gone: true }), USER, T2).branch_gone_at).toBe(T1);
    expect(mergeBranchStateRow(gone, result({ branch_gone: null }), USER, T2).branch_gone_at).toBe(T1);
    expect(mergeBranchStateRow(gone, result({ branch_gone: false }), USER, T2).branch_gone_at).toBeNull();
  });
});

describe("BranchStatePostSchema", () => {
  it("accepts a well-formed body and rejects a bad sha, an oversize batch and a non-ISO checked_at", () => {
    const good = {
      checked_at: "2026-09-26T17:30:00.000Z",
      results: [
        {
          code_project_id: P1,
          branch: "feat-1",
          default_branch: "main",
          last_seen_sha: A1,
          merged_into_default: false,
          sha_superseded_by: null,
          branch_gone: false,
        },
      ],
    };
    expect(BranchStatePostSchema.safeParse(good).success).toBe(true);
    expect(
      BranchStatePostSchema.safeParse({ ...good, results: [{ ...good.results[0], last_seen_sha: "zzz" }] }).success,
    ).toBe(false);
    expect(BranchStatePostSchema.safeParse({ ...good, checked_at: "yesterday" }).success).toBe(false);
    expect(BranchStatePostSchema.safeParse({ ...good, results: Array(501).fill(good.results[0]) }).success).toBe(false);
  });
});

// --- query functions with a minimal supabase double ---------------------------
//
// Records every chain call so the tests can assert the predicates (user_id,
// started_at window) and returns canned rows per table.

interface Call {
  table: string;
  ops: [string, unknown[]][];
}
function makeClient(tables: Record<string, unknown[]>, opts: { upsertError?: string } = {}) {
  const calls: Call[] = [];
  const upserts: { table: string; rows: unknown[]; onConflict?: string }[] = [];
  const client = {
    from(table: string) {
      const call: Call = { table, ops: [] };
      calls.push(call);
      const rows = tables[table] ?? [];
      const chain: Record<string, unknown> = {};
      const record =
        (name: string) =>
        (...args: unknown[]) => {
          call.ops.push([name, args]);
          return chain;
        };
      for (const m of ["select", "eq", "gte", "in", "not", "order", "range"]) chain[m] = record(m);
      chain.upsert = (batch: unknown[], o?: { onConflict?: string }) => {
        call.ops.push(["upsert", [batch, o]]);
        upserts.push({ table, rows: batch, onConflict: o?.onConflict });
        return Promise.resolve({ data: null, error: opts.upsertError ? { message: opts.upsertError } : null });
      };
      // biome-ignore lint/suspicious/noThenProperty: the double must be awaitable like the real query builder
      chain.then = (
        onfulfilled: (v: { data: unknown[]; error: null }) => unknown,
        onrejected?: (e: unknown) => unknown,
      ) => Promise.resolve({ data: rows, error: null }).then(onfulfilled, onrejected);
      return chain;
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: test double
  return { client: client as any, calls, upserts };
}

describe("loadRefsToCheck", () => {
  it("reads only the caller's sessions started in the window, their projects and action-bearing turns, then plans", async () => {
    const now = new Date("2026-09-26T18:00:00.000Z");
    const { client, calls } = makeClient({
      code_sessions: [session("s1", "2026-09-26T09:00:00Z", { git_branch: "feat-1" })],
      code_projects: [project],
      code_session_turns: [turn("s1", 4, { verb: "committed", ref: "acme/billing#1", sha: A1, source: "cli" })],
    });
    const repos = await loadRefsToCheck(client, USER, { days: 7, now });
    expect(repos).toHaveLength(1);
    expect(repos[0].shas).toEqual([{ sha: A1, branch: "feat-1", ref: "acme/billing#1", sessionId: "s1" }]);

    const sessionsCall = calls.find((c) => c.table === "code_sessions");
    expect(sessionsCall?.ops).toEqual(
      expect.arrayContaining([
        ["eq", ["user_id", USER]],
        ["gte", ["started_at", "2026-09-19T18:00:00.000Z"]],
      ]),
    );
    const turnsCall = calls.find((c) => c.table === "code_session_turns");
    expect(turnsCall?.ops).toEqual(
      expect.arrayContaining([
        ["eq", ["user_id", USER]],
        ["in", ["session_id", ["s1"]]],
        ["not", ["props->action", "is", null]],
      ]),
    );
    const projectsCall = calls.find((c) => c.table === "code_projects");
    expect(projectsCall?.ops).toEqual(expect.arrayContaining([["eq", ["user_id", USER]]]));
  });

  it("carries what memory_branch_state already holds for the planned branch keys (`known`), and nothing else", async () => {
    const { client, calls } = makeClient({
      code_sessions: [session("s1", "2026-09-26T09:00:00Z", { git_branch: "feat-1" })],
      code_projects: [project],
      code_session_turns: [
        turn("s1", 4, { verb: "committed", sha: A1, source: "cli" }),
        turn("s1", 6, { verb: "pushed", branch: "gone-branch", source: "cli" }),
      ],
      memory_branch_state: [
        { code_project_id: P1, branch: "gone-branch", last_seen_sha: B2, branch_gone_at: null },
        { code_project_id: P1, branch: "feat-1", last_seen_sha: null, branch_gone_at: "2026-09-20T00:00:00.000Z" },
        { code_project_id: P1, branch: "unrelated", last_seen_sha: C3, branch_gone_at: null },
      ],
    });
    const [repo] = await loadRefsToCheck(client, USER);
    expect(repo.known).toEqual([
      { branch: "feat-1", last_seen_sha: null, branch_gone_at: "2026-09-20T00:00:00.000Z" },
      { branch: "gone-branch", last_seen_sha: B2, branch_gone_at: null },
    ]);
    const stateCall = calls.find((c) => c.table === "memory_branch_state");
    expect(stateCall?.ops).toEqual(
      expect.arrayContaining([
        ["eq", ["user_id", USER]],
        ["in", ["code_project_id", [P1]]],
      ]),
    );
  });

  it("returns [] without reading projects or turns when the window holds no sessions", async () => {
    const { client, calls } = makeClient({ code_sessions: [] });
    expect(await loadRefsToCheck(client, USER)).toEqual([]);
    expect(calls.map((c) => c.table)).toEqual(["code_sessions"]);
  });

  it("applies the ?repo filter", async () => {
    const { client } = makeClient({
      code_sessions: [session("s1", "2026-09-26T09:00:00Z")],
      code_projects: [project],
      code_session_turns: [turn("s1", 1, { verb: "pushed", branch: "b", source: "cli" })],
    });
    expect(await loadRefsToCheck(client, USER, { repo: "/nope" })).toEqual([]);
    expect(await loadRefsToCheck(client, USER, { repo: "/home/dev/src/billing" })).toHaveLength(1);
  });
});

describe("upsertBranchState", () => {
  const body = {
    checked_at: "2026-09-26T17:30:00.000Z",
    results: [
      {
        code_project_id: P1,
        branch: "feat-1",
        default_branch: "main",
        last_seen_sha: A1,
        merged_into_default: true,
        sha_superseded_by: null,
        branch_gone: false,
      },
      {
        code_project_id: "22222222-2222-4222-8222-222222222222",
        branch: "not-mine",
        default_branch: "main",
        last_seen_sha: null,
        merged_into_default: true,
        sha_superseded_by: null,
        branch_gone: true,
      },
    ],
  };

  it("writes only rows for the caller's own projects, folded onto the existing row, with the PK as the conflict target", async () => {
    const existing: BranchStateRow = {
      user_id: USER,
      code_project_id: P1,
      branch: "feat-1",
      last_seen_sha: A1,
      merged_into: null,
      merged_at: null,
      branch_gone_at: "2026-09-20T00:00:00.000Z",
      last_seen_at: "2026-09-20T00:00:00.000Z",
    };
    const { client, upserts } = makeClient({ code_projects: [{ id: P1 }], memory_branch_state: [existing] });
    const outcome = await upsertBranchState(client, USER, body);
    expect(outcome).toEqual({ upserted: 1, rejected: 1 });
    expect(upserts).toHaveLength(1);
    expect(upserts[0].onConflict).toBe("user_id,code_project_id,branch");
    expect(upserts[0].rows).toEqual([
      {
        user_id: USER,
        code_project_id: P1,
        branch: "feat-1",
        last_seen_sha: A1,
        merged_into: "main",
        merged_at: body.checked_at,
        branch_gone_at: null, // branch_gone: false clears an earlier proof
        last_seen_at: body.checked_at,
      },
    ]);
  });

  it("writes nothing when no result belongs to the caller, and surfaces an upsert error", async () => {
    const none = makeClient({ code_projects: [] });
    expect(await upsertBranchState(none.client, USER, body)).toEqual({ upserted: 0, rejected: 2 });
    expect(none.upserts).toHaveLength(0);
    expect(await upsertBranchState(none.client, USER, { checked_at: body.checked_at, results: [] })).toEqual({
      upserted: 0,
      rejected: 0,
    });

    const failing = makeClient({ code_projects: [{ id: P1 }], memory_branch_state: [] }, { upsertError: "boom" });
    await expect(upsertBranchState(failing.client, USER, body)).rejects.toThrow(/boom/);
  });
});
