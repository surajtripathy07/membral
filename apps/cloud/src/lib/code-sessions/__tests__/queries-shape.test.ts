// Unit coverage for the one piece of pure logic added in queries.ts for
// handoff 0024 directive D (surface code on /pulse + /conversations):
// shapeRecentCodeSessionRow, which flattens the PostgREST embedded-resource
// join (code_sessions -> code_projects(display_name, repo_identity)) into a
// flat RecentCodeSessionRow. The rest of getRecentCodeSessions is a thin
// Supabase round-trip, browser-verified per this file's own header comment
// (same convention as every other loader in queries.ts).
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/types";
import { listCodeProjectsForScopePicker, listSessionIssuesForSessionPage, shapeRecentCodeSessionRow } from "../queries";

describe("shapeRecentCodeSessionRow", () => {
  it("flattens the embedded code_projects join into project_display_name / project_repo_identity", () => {
    const row = shapeRecentCodeSessionRow({
      id: "session-1",
      code_project_id: "project-1",
      title: "Fix the import bug",
      summary: "Tracked down a re-import regression.",
      started_at: "2026-07-20T10:00:00.000Z",
      duration_seconds: 942,
      turn_count: 37,
      user_turn_count: 14,
      code_projects: { display_name: "webapp", repo_identity: "acme/webapp" },
    });
    expect(row).toEqual({
      id: "session-1",
      code_project_id: "project-1",
      title: "Fix the import bug",
      summary: "Tracked down a re-import regression.",
      started_at: "2026-07-20T10:00:00.000Z",
      duration_seconds: 942,
      turn_count: 37,
      user_turn_count: 14,
      project_display_name: "webapp",
      project_repo_identity: "acme/webapp",
    });
  });

  it("falls back project fields to null when code_projects is missing (defensive — should never happen given the FK)", () => {
    const row = shapeRecentCodeSessionRow({
      id: "session-2",
      code_project_id: "project-2",
      title: null,
      summary: null,
      started_at: null,
      duration_seconds: null,
      turn_count: 12,
      user_turn_count: 5,
      code_projects: null,
    });
    expect(row.project_display_name).toBeNull();
    expect(row.project_repo_identity).toBeNull();
  });

  it("passes through null title/summary/started_at unchanged (sessionDisplayTitle/formatRelativeDate own the fallback UX)", () => {
    const row = shapeRecentCodeSessionRow({
      id: "session-3",
      code_project_id: "project-3",
      title: undefined,
      summary: undefined,
      started_at: undefined,
      duration_seconds: undefined,
      turn_count: undefined,
      user_turn_count: undefined,
      code_projects: { display_name: null, repo_identity: "acme/infra" },
    });
    expect(row.title).toBeNull();
    expect(row.summary).toBeNull();
    expect(row.started_at).toBeNull();
    expect(row.duration_seconds).toBeNull();
    expect(row.turn_count).toBe(0);
    expect(row.user_turn_count).toBe(0);
    expect(row.project_display_name).toBeNull();
    expect(row.project_repo_identity).toBe("acme/infra");
  });
});

describe("listCodeProjectsForScopePicker (/settings)", () => {
  it("runs select(cols).order(last_active_at desc) on code_projects and returns the raw result", async () => {
    const result = { data: [], error: null };
    const order = vi.fn().mockResolvedValue(result);
    const select = vi.fn(() => ({ order }));
    const from = vi.fn(() => ({ select }));

    const out = await listCodeProjectsForScopePicker({ from } as unknown as Db);

    expect(out).toBe(result);
    expect(from).toHaveBeenCalledWith("code_projects");
    expect(select).toHaveBeenCalledWith("id, display_name, repo_identity");
    expect(order).toHaveBeenCalledWith("last_active_at", { ascending: false });
  });
});

describe("listSessionIssuesForSessionPage (/code/session/[sessionId])", () => {
  it("runs select(cols).eq(user_id).eq(session_id) on code_session_issues and returns { data, error }", async () => {
    const result = { data: [{ session_id: "s1" }], error: null };
    const eqSession = vi.fn().mockResolvedValue(result);
    const eqUser = vi.fn(() => ({ eq: eqSession }));
    const select = vi.fn(() => ({ eq: eqUser }));
    const from = vi.fn(() => ({ select }));

    const out = await listSessionIssuesForSessionPage({ from } as unknown as Db, "u1", "s1");

    expect(out).toEqual(result);
    expect(from).toHaveBeenCalledWith("code_session_issues");
    expect(select).toHaveBeenCalledWith(
      "session_id, ref, number, kind, role, evidence_quote, turn_idx, review_verb, build_verb, tier, turn_share, related_to",
    );
    expect(eqUser).toHaveBeenCalledWith("user_id", "u1");
    expect(eqSession).toHaveBeenCalledWith("session_id", "s1");
  });
});
