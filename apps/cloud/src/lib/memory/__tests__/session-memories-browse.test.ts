import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockMemorySearch = vi.fn();
vi.mock("../search", () => ({
  memorySearch: (...args: unknown[]) => mockMemorySearch(...args),
}));

import {
  type BrowseSessionMemory,
  groupProjectMemories,
  listMemoryProjects,
  listSessionMemories,
  loadProjectMemoryGroups,
  parseMemoryKind,
  parsePage,
  receiptHref,
  resolveProjectParam,
  searchSessionMemories,
} from "../session-memories-browse";

const USER = "user-1";

function memory(id: string, over: Row = {}): Row {
  return {
    id,
    user_id: USER,
    code_session_id: "s-main",
    code_project_id: "p1",
    agent_id: null,
    kind: "decision",
    text: `record ${id}`,
    quote: `quote ${id}`,
    verified: true,
    turn_idx: 4,
    ref: null,
    retired_at: null,
    created_at: "2026-09-20T00:00:00Z",
    ...over,
  };
}

function db(memories: Row[]) {
  return makeFakeSupabase({
    code_projects: [
      { id: "p1", user_id: USER, display_name: "CodeHub", repo_identity: "codehub/web" },
      { id: "p2", user_id: USER, display_name: null, repo_identity: "codehub/api" },
      { id: "p-other", user_id: "someone-else", display_name: "CodeHub", repo_identity: "x/y" },
    ],
    code_sessions: [
      { id: "s-main", user_id: USER, parent_source_session_id: null },
      { id: "s-sub", user_id: USER, parent_source_session_id: "src-parent" },
    ],
    session_memories: memories,
  });
}

function browse(id: string, kind: BrowseSessionMemory["kind"]): BrowseSessionMemory {
  return {
    id,
    kind,
    text: id,
    quote: null,
    verified: true,
    turn_idx: 0,
    code_session_id: "s",
    code_project_id: "p1",
    project_name: "CodeHub",
    created_at: "2026-09-20T00:00:00Z",
    ref: null,
    from_sub_agent: false,
  };
}

describe("param helpers", () => {
  it("parseMemoryKind accepts the five kinds only", () => {
    expect(parseMemoryKind("blocker")).toBe("blocker");
    expect(parseMemoryKind("person")).toBeNull();
    expect(parseMemoryKind(null)).toBeNull();
  });

  it("parsePage defaults to 1 on junk", () => {
    expect(parsePage("3")).toBe(3);
    expect(parsePage("0")).toBe(1);
    expect(parsePage("abc")).toBe(1);
    expect(parsePage(undefined)).toBe(1);
  });

  it("receiptHref links the session, jumped to the turn's anchor", () => {
    expect(receiptHref({ code_session_id: "abc", turn_idx: 12 })).toBe("/code/session/abc?turn=12#turn-12");
  });

  it("receiptHref adds the quote (squashed, encoded, capped) so the session page can mark it", () => {
    expect(receiptHref({ code_session_id: "abc", turn_idx: 3, quote: "keep it\n  inline & simple" })).toBe(
      "/code/session/abc?turn=3&quote=keep%20it%20inline%20%26%20simple#turn-3",
    );
    expect(receiptHref({ code_session_id: "abc", turn_idx: 3, quote: null })).toBe("/code/session/abc?turn=3#turn-3");
    const long = receiptHref({ code_session_id: "abc", turn_idx: 3, quote: "x".repeat(1000) });
    expect(long.length).toBeLessThan(400);
  });

  it("v4 item 6: receiptHref always asks for the window around the turn, past the default cap too", () => {
    expect(receiptHref({ code_session_id: "abc", turn_idx: 499 })).toBe("/code/session/abc?turn=499#turn-499");
    expect(receiptHref({ code_session_id: "abc", turn_idx: 500 })).toBe("/code/session/abc?turn=500#turn-500");
    expect(receiptHref({ code_session_id: "abc", turn_idx: 731 })).toBe("/code/session/abc?turn=731#turn-731");
  });

  it("resolveProjectParam matches an id first, then a name case-insensitively", () => {
    const projects = [
      { id: "p1", name: "CodeHub" },
      { id: "p2", name: "codehub/api" },
    ];
    expect(resolveProjectParam(projects, "p2")?.id).toBe("p2");
    expect(resolveProjectParam(projects, "codehub")?.id).toBe("p1");
    expect(resolveProjectParam(projects, "nope")).toBeNull();
    expect(resolveProjectParam(projects, null)).toBeNull();
  });
});

describe("listMemoryProjects", () => {
  it("lists only the user's projects, named display_name || repo_identity", async () => {
    const projects = await listMemoryProjects(db([]), USER);
    expect(projects.map((p) => [p.id, p.name]).sort()).toEqual([
      ["p1", "CodeHub"],
      ["p2", "codehub/api"],
    ]);
  });
});

describe("listSessionMemories", () => {
  const projects = [
    { id: "p1", name: "CodeHub" },
    { id: "p2", name: "codehub/api" },
  ];

  it("returns the user's live records newest first, with project name and sub-agent flag", async () => {
    const supabase = db([
      memory("old", { created_at: "2026-09-01T00:00:00Z" }),
      memory("new", { created_at: "2026-09-22T00:00:00Z", code_session_id: "s-sub" }),
      memory("retired", { retired_at: "2026-09-23T00:00:00Z" }),
      memory("foreign", { user_id: "someone-else" }),
      memory("agent", { created_at: "2026-09-10T00:00:00Z", agent_id: "agent-7" }),
    ]);
    const { records, hasMore } = await listSessionMemories(supabase, USER, projects);
    expect(records.map((r) => r.id)).toEqual(["new", "agent", "old"]);
    expect(hasMore).toBe(false);
    expect(records[0]).toMatchObject({ project_name: "CodeHub", from_sub_agent: true, quote: "quote new" });
    expect(records[1].from_sub_agent).toBe(true);
    expect(records[2].from_sub_agent).toBe(false);
  });

  it("filters by project and kind", async () => {
    const supabase = db([memory("a"), memory("b", { code_project_id: "p2" }), memory("c", { kind: "blocker" })]);
    expect((await listSessionMemories(supabase, USER, projects, { projectId: "p2" })).records.map((r) => r.id)).toEqual(
      ["b"],
    );
    expect((await listSessionMemories(supabase, USER, projects, { kind: "blocker" })).records.map((r) => r.id)).toEqual(
      ["c"],
    );
  });

  it("2.3c: with a handoff flag on, the default (All) view never lists a handoff note", async () => {
    vi.stubEnv("MEMBRAL_HANDOFF_SYNTHESIS", "1");
    const supabase = db([memory("a"), memory("h", { kind: "handoff" })]);
    expect((await listSessionMemories(supabase, USER, projects)).records.map((r) => r.id)).toEqual(["a"]);
    vi.unstubAllEnvs();
  });

  it("both handoff flags off: the default view sends no kind filter, as main did (a stray note is not filtered here)", async () => {
    const supabase = db([memory("a"), memory("h", { kind: "handoff" })]);
    expect((await listSessionMemories(supabase, USER, projects)).records.map((r) => r.id).sort()).toEqual(["a", "h"]);
  });

  it("pages with limit/offset and reports hasMore from one extra row", async () => {
    const rows = Array.from({ length: 5 }, (_, i) => memory(`m${i}`, { created_at: `2026-09-2${i}T00:00:00Z` }));
    const supabase = db(rows);
    const p1 = await listSessionMemories(supabase, USER, projects, { limit: 2, offset: 0 });
    expect(p1.records.map((r) => r.id)).toEqual(["m4", "m3"]);
    expect(p1.hasMore).toBe(true);
    const p3 = await listSessionMemories(supabase, USER, projects, { limit: 2, offset: 4 });
    expect(p3.records.map((r) => r.id)).toEqual(["m0"]);
    expect(p3.hasMore).toBe(false);
  });
});

describe("searchSessionMemories", () => {
  beforeEach(() => mockMemorySearch.mockReset());

  it("calls memorySearch with the project id as scope and keeps its order and verified flag", async () => {
    mockMemorySearch.mockResolvedValue({
      records: [
        { id: "b", verified: false, turn_idx: 9 },
        { id: "a", verified: true, turn_idx: 4 },
      ],
      degraded: "keyword-only results",
    });
    const supabase = db([memory("a"), memory("b"), memory("c")]);
    const result = await searchSessionMemories(supabase, USER, [{ id: "p1", name: "CodeHub" }], {
      query: "pnpm",
      projectId: "p1",
      kind: "decision",
    });
    expect(mockMemorySearch).toHaveBeenCalledWith(
      supabase,
      USER,
      "p1",
      { query: "pnpm", kind: "decision", limit: 20 },
      { includeStaleBlockers: true },
    );
    expect(result.records.map((r) => [r.id, r.verified, r.turn_idx])).toEqual([
      ["b", false, 9],
      ["a", true, 4],
    ]);
    expect(result.degraded).toBe("keyword-only results");
  });

  it("returns nothing when search finds nothing", async () => {
    mockMemorySearch.mockResolvedValue({ records: [] });
    const result = await searchSessionMemories(db([memory("a")]), USER, [], { query: "zzz" });
    expect(result.records).toEqual([]);
  });
});

describe("groupProjectMemories", () => {
  it("orders preferences, open blockers, decisions, learnings; caps per kind; counts outcomes", () => {
    const records = [
      browse("d1", "decision"),
      browse("o1", "outcome"),
      browse("l1", "learning"),
      browse("b1", "blocker"),
      browse("b2", "blocker"),
      browse("b3", "blocker"),
      browse("p1", "preference"),
      browse("o2", "outcome"),
    ];
    const grouped = groupProjectMemories(records, 2, Date.parse("2026-09-22T00:00:00Z"));
    expect(grouped.groups.map((g) => [g.kind, g.label, g.records.map((r) => r.id), g.total])).toEqual([
      ["preference", "Preferences", ["p1"], 1],
      ["blocker", "Open blockers", ["b1", "b2"], 3],
      ["decision", "Decisions", ["d1"], 1],
      ["learning", "Learnings", ["l1"], 1],
    ]);
    expect(grouped.outcomeCount).toBe(2);
    expect(grouped.total).toBe(8);
  });

  it("leaves blockers older than 7 days out of Open blockers (#436)", () => {
    const now = Date.parse("2026-09-28T12:00:00Z");
    const records = [browse("b-old", "blocker"), { ...browse("b-new", "blocker"), created_at: "2026-09-27T00:00:00Z" }];
    const grouped = groupProjectMemories(records, 8, now);
    expect(grouped.groups.map((g) => [g.kind, g.records.map((r) => r.id)])).toEqual([["blocker", ["b-new"]]]);
  });

  it("drops empty kinds", () => {
    const grouped = groupProjectMemories([browse("o1", "outcome")]);
    expect(grouped.groups).toEqual([]);
    expect(grouped.outcomeCount).toBe(1);
  });
});

describe("loadProjectMemoryGroups", () => {
  it("resolves the project by display name and groups its live records", async () => {
    const supabase = db([
      memory("a", { kind: "preference" }),
      memory("b", { kind: "blocker" }),
      memory("c", { code_project_id: "p2" }),
      memory("d", { kind: "learning", retired_at: "2026-09-21T00:00:00Z" }),
    ]);
    const { project, grouped } = await loadProjectMemoryGroups(supabase, USER, {
      projectName: "CodeHub",
      now: Date.parse("2026-09-22T00:00:00Z"),
    });
    expect(project?.id).toBe("p1");
    expect(grouped.groups.map((g) => g.kind)).toEqual(["preference", "blocker"]);
  });

  it("prefers an explicit project id, and returns no project for an unknown name", async () => {
    const supabase = db([memory("c", { code_project_id: "p2" })]);
    const byId = await loadProjectMemoryGroups(supabase, USER, { projectId: "p2", projectName: "CodeHub" });
    expect(byId.project?.id).toBe("p2");
    expect(byId.grouped.total).toBe(1);
    const none = await loadProjectMemoryGroups(supabase, USER, { projectName: "missing" });
    expect(none.project).toBeNull();
    expect(none.grouped.total).toBe(0);
  });
});
