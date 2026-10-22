// Step 3D-5 lock for the functions moved verbatim into project-list.logic.ts
// — a small table per function so a future move stays honest.
import { describe, expect, it } from "vitest";
import type { CodeProjectListRow } from "@/lib/code-sessions/queries";
import {
  groupProjects,
  isInactive,
  projectName,
  sortGroups,
  sortProjects,
  splitOwnerRepo,
} from "../project-list.logic";

function project(overrides: Partial<CodeProjectListRow> & { id: string }): CodeProjectListRow {
  return {
    display_name: null,
    repo_identity: overrides.id,
    session_count: 1,
    last_active_at: null,
    summary: null,
    ...overrides,
  };
}

describe("projectName", () => {
  it.each([
    [
      "display_name wins over repo_identity",
      { id: "p1", display_name: "acme/widgets", repo_identity: "raw" },
      "acme/widgets",
    ],
    ["falls back to repo_identity when display_name is null", { id: "p2", display_name: null }, "p2"],
    ["falls back to repo_identity when display_name is empty string", { id: "p3", display_name: "" }, "p3"],
    ["a display_name with no slash", { id: "p4", display_name: "solo" }, "solo"],
  ] as const)("%s", (_label, overrides, expected) => {
    expect(projectName(project(overrides))).toBe(expected);
  });
});

describe("splitOwnerRepo", () => {
  it.each([
    ["owner/repo", "acme/widgets", { owner: "acme", repo: "widgets" }],
    ["no slash", "solo", { owner: null, repo: "solo" }],
    ["multiple slashes: splits on the first", "a/b/c", { owner: "a", repo: "b/c" }],
    ["empty string", "", { owner: null, repo: "" }],
  ] as const)("%s", (_label, name, expected) => {
    expect(splitOwnerRepo(name)).toEqual(expected);
  });
});

describe("sortProjects", () => {
  const a = project({ id: "a", display_name: "b-name", session_count: 1, last_active_at: "2026-01-01T00:00:00Z" });
  const b = project({ id: "b", display_name: "a-name", session_count: 5, last_active_at: "2026-02-01T00:00:00Z" });

  it.each([
    ["sessions: most sessions first", "sessions" as const, [b, a]],
    ["name: alphabetical", "name" as const, [b, a]],
    ["recent: most recently active first", "recent" as const, [b, a]],
  ])("%s", (_label, sort, expected) => {
    expect(sortProjects([a, b], sort).map((p) => p.id)).toEqual(expected.map((p) => p.id));
  });

  it("does not mutate the input array", () => {
    const input = [a, b];
    sortProjects(input, "name");
    expect(input).toEqual([a, b]);
  });
});

describe("groupProjects", () => {
  it("a project with no alias is its own singleton group", () => {
    const groups = groupProjects([project({ id: "p1", display_name: "acme/widgets" })], {});
    expect(groups).toHaveLength(1);
    expect(groups[0].members).toHaveLength(1);
  });

  it("clubs projects sharing a canonical label and aggregates session_count", () => {
    const p1 = project({
      id: "p1",
      display_name: "dev/membral",
      session_count: 5,
      last_active_at: "2026-08-01T00:00:00Z",
    });
    const p2 = project({
      id: "p2",
      display_name: "org/membral",
      session_count: 3,
      last_active_at: "2026-08-05T00:00:00Z",
    });
    const groups = groupProjects([p1, p2], { p1: "dev/membral", p2: "dev/membral" });
    expect(groups).toHaveLength(1);
    expect(groups[0].sessionCount).toBe(8);
    expect(groups[0].lastActiveAt).toBe("2026-08-05T00:00:00Z");
    expect(groups[0].primary.id).toBe("p1"); // higher session_count
  });

  it("primary ties break on most recent activity", () => {
    const p1 = project({ id: "p1", display_name: "x", session_count: 2, last_active_at: "2026-01-01T00:00:00Z" });
    const p2 = project({ id: "p2", display_name: "x", session_count: 2, last_active_at: "2026-06-01T00:00:00Z" });
    const groups = groupProjects([p1, p2], { p1: "x", p2: "x" });
    expect(groups[0].primary.id).toBe("p2");
  });

  it("empty input yields no groups", () => {
    expect(groupProjects([], {})).toEqual([]);
  });
});

describe("sortGroups", () => {
  const g1 = {
    label: "b",
    members: [],
    sessionCount: 1,
    lastActiveAt: "2026-01-01T00:00:00Z",
    primary: project({ id: "p1" }),
  };
  const g2 = {
    label: "a",
    members: [],
    sessionCount: 5,
    lastActiveAt: "2026-02-01T00:00:00Z",
    primary: project({ id: "p2" }),
  };

  it.each([
    ["sessions", "sessions" as const, ["a", "b"]],
    ["name", "name" as const, ["a", "b"]],
    ["recent", "recent" as const, ["a", "b"]],
  ])("%s order", (_label, sort, expected) => {
    expect(sortGroups([g1, g2], sort).map((g) => g.label)).toEqual(expected);
  });
});

describe("isInactive", () => {
  it.each([
    ["undefined stats (query failed) is not inactive", undefined, false],
    ["zero turns and files is inactive", { turns: 0, files: 0, costUsd: null }, true],
    ["nonzero turns is active", { turns: 3, files: 0, costUsd: null }, false],
    ["nonzero files is active", { turns: 0, files: 2, costUsd: 1 }, false],
  ] as const)("%s", (_label, stats, expected) => {
    expect(isInactive(stats)).toBe(expected);
  });
});
