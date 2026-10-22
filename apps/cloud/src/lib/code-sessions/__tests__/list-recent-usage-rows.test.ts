// G3 step 3D-3: listRecentUsageRows — the 30-day code_sessions cost read
// shared by /code (account-wide) and /code/[projectId] (one project).
// Exercises both call shapes' filter chain (user scoping, optional project
// scoping, sub-session exclusion, the since-window, ascending order) and the
// paginate:false vs paginate:true branches — the latter, over FakeSupabase's
// own DB_MAX_ROWS=1000 clamp (see fake-db.ts), is what proves it actually
// pages past PostgREST's cap via selectAllRows/.range, matching the real
// defect (#…, "unbounded read" in the G3 goal) that paginate:false preserves
// on purpose for today's two callers.
import { FakeSupabase } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { listRecentUsageRows } from "../queries";

const USER_ID = "user-1";
const SINCE = new Date("2026-08-01T00:00:00.000Z");

function ids(data: unknown[] | null): string[] {
  return (data ?? []).map((r) => (r as { id: string }).id);
}

function baseRow(overrides: Record<string, unknown>) {
  return {
    user_id: USER_ID,
    code_project_id: "proj-1",
    parent_source_session_id: null,
    turn_count: 1,
    user_turn_count: 1,
    props: {},
    ...overrides,
  };
}

describe("listRecentUsageRows", () => {
  it("account-wide (no projectId): scopes to the user, excludes sub-sessions and rows before `since`, orders ascending", async () => {
    const db = new FakeSupabase();
    db.seed("code_sessions", [
      baseRow({ id: "in-window-2", started_at: "2026-08-20T00:00:00.000Z" }),
      baseRow({ id: "in-window-1", started_at: "2026-08-10T00:00:00.000Z" }),
      baseRow({ id: "too-old", started_at: "2026-07-01T00:00:00.000Z" }),
      baseRow({ id: "sub-session", started_at: "2026-08-15T00:00:00.000Z", parent_source_session_id: "parent-1" }),
      baseRow({ id: "other-user", started_at: "2026-08-15T00:00:00.000Z", user_id: "user-2" }),
    ]);

    const { data, error } = await listRecentUsageRows(db.asClient(), USER_ID, {
      since: SINCE,
      select: "id, started_at",
      paginate: false,
    });

    expect(error).toBeNull();
    expect(ids(data)).toEqual(["in-window-1", "in-window-2"]);
  });

  it("project-scoped (projectId set): also filters to that project", async () => {
    const db = new FakeSupabase();
    db.seed("code_sessions", [
      baseRow({ id: "proj-1-row", code_project_id: "proj-1", started_at: "2026-08-10T00:00:00.000Z" }),
      baseRow({ id: "proj-2-row", code_project_id: "proj-2", started_at: "2026-08-10T00:00:00.000Z" }),
    ]);

    const { data, error } = await listRecentUsageRows(db.asClient(), USER_ID, {
      since: SINCE,
      projectId: "proj-1",
      select: "id, started_at",
      paginate: false,
    });

    expect(error).toBeNull();
    expect(ids(data)).toEqual(["proj-1-row"]);
  });

  it("paginate: false is the plain awaited query — capped at the DB's ~1000-row default (defect 3, preserved on purpose)", async () => {
    const db = new FakeSupabase();
    const rows = Array.from({ length: 1005 }, (_, i) =>
      baseRow({ id: `s${i}`, started_at: new Date(SINCE.getTime() + i * 1000).toISOString() }),
    );
    db.seed("code_sessions", rows);

    const { data, error } = await listRecentUsageRows(db.asClient(), USER_ID, {
      since: SINCE,
      select: "id, started_at",
      paginate: false,
    });

    expect(error).toBeNull();
    expect(data).toHaveLength(1000);
  });

  it("paginate: true drains past the cap via selectAllRows's .range(from, to)", async () => {
    const db = new FakeSupabase();
    const rows = Array.from({ length: 1005 }, (_, i) =>
      baseRow({ id: `s${i}`, started_at: new Date(SINCE.getTime() + i * 1000).toISOString() }),
    );
    db.seed("code_sessions", rows);

    const { data, error } = await listRecentUsageRows(db.asClient(), USER_ID, {
      since: SINCE,
      select: "id, started_at",
      paginate: true,
    });

    expect(error).toBeNull();
    expect(data).toHaveLength(1005);
    expect(ids(data)[0]).toBe("s0");
    expect(ids(data).at(-1)).toBe("s1004");
  });
});
