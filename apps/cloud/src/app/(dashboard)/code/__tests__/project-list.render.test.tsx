// Render-snapshot lock for step 3D-5 (docs/archive/goals/2026-09-28_g3-edges_goal.md, D7): recorded
// BEFORE the pure-logic move out of project-list.tsx into
// project-list.logic.ts, and re-run unchanged after — proves the move
// changed zero rendered output. `TZ=UTC` + a frozen clock (`vi.useFakeTimers`)
// keep `formatRelativeDate`'s "Nd ago" math and any Date-based formatting
// deterministic across machines/CI. Also pin `toLocaleDateString`/
// `toLocaleString`/`toLocaleTimeString` to a fixed locale+UTC, same as
// issues-content.render.test.tsx, so this lock stays environment-independent
// even if a future formatter here reads the default ICU locale (this
// component's current formatters don't, but keeping both locks pinned the
// same way avoids re-deriving this the next time one does).
// `renderToStaticMarkup` pattern per project-list.test.tsx.
process.env.TZ = "UTC";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeProjectListRow } from "@/lib/code-sessions/queries";
import { ProjectList } from "../project-list";

function pinnedFormat(
  this: Date,
  method: "toLocaleDateString" | "toLocaleTimeString" | "toLocaleString",
  _locale: unknown,
  options?: Intl.DateTimeFormatOptions,
): string {
  const formatterOptions: Intl.DateTimeFormatOptions =
    method === "toLocaleTimeString" ? { hour: "numeric", minute: "2-digit", ...options, timeZone: "UTC" } : { ...options, timeZone: "UTC" };
  return new Intl.DateTimeFormat("en-US", formatterOptions).format(this);
}

beforeAll(() => {
  vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function (this: Date, l, o) {
    return pinnedFormat.call(this, "toLocaleDateString", l, o);
  });
  vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (this: Date, l, o) {
    return pinnedFormat.call(this, "toLocaleString", l, o);
  });
  vi.spyOn(Date.prototype, "toLocaleTimeString").mockImplementation(function (this: Date, l, o) {
    return pinnedFormat.call(this, "toLocaleTimeString", l, o);
  });
});

afterAll(() => {
  vi.restoreAllMocks();
});

const NOW = "2026-08-27T00:00:00.000Z";

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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ProjectList render lock (3D-5, pre/post pure-move)", () => {
  it("empty: no projects", async () => {
    const html = renderToStaticMarkup(<ProjectList projects={[]} now={NOW} />);
    await expect(html).toMatchFileSnapshot("./__snapshots__/project-list.render.empty.html");
  });

  it("typical: a mix of singleton and clubbed projects with stats", async () => {
    const projects = [
      project({ id: "p1", display_name: "fleetdm/fleet", session_count: 3, last_active_at: "2026-08-20T00:00:00Z" }),
      project({ id: "p2", display_name: "dev/membral", session_count: 5, last_active_at: "2026-08-25T00:00:00Z" }),
      project({ id: "p3", display_name: "surajtripathy07/membral", session_count: 2, last_active_at: "2026-08-10T00:00:00Z" }),
    ];
    const canonicalLabels = { p2: "dev/membral", p3: "dev/membral" };
    const cardStats = {
      p1: { turns: 12, files: 4, costUsd: 1.5 },
      p2: { turns: 0, files: 0, costUsd: 0 },
      p3: { turns: 0, files: 0, costUsd: 0 },
    };
    const html = renderToStaticMarkup(
      <ProjectList projects={projects} now={NOW} canonicalLabels={canonicalLabels} cardStats={cardStats} />,
    );
    await expect(html).toMatchFileSnapshot("./__snapshots__/project-list.render.typical.html");
  });

  it("edge: long name, zero counts, missing optional fields, unavailable stats", async () => {
    const projects = [
      project({
        id: "p-long",
        display_name: "a-very-long-organization-name-that-keeps-going/an-even-longer-repository-name-here",
        session_count: 1,
        last_active_at: null,
      }),
      project({ id: "p-zero", repo_identity: "solo/zero-activity", session_count: 0, last_active_at: null, summary: null }),
    ];
    const cardStats = { "p-zero": { turns: 0, files: 0, costUsd: null } };
    const html = renderToStaticMarkup(<ProjectList projects={projects} now={NOW} cardStats={cardStats} />);
    await expect(html).toMatchFileSnapshot("./__snapshots__/project-list.render.edge.html");
  });
});
