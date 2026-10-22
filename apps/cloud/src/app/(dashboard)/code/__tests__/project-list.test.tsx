// Grouping behaviour for the /code list (migration 060, W7/D8): projects
// clubbed by project_aliases-resolved canonical label render as one
// GroupCard with member chips, instead of one ProjectCard per raw label.
// renderToStaticMarkup pattern established elsewhere (see project-facts.test.tsx).
//
// W9 (2026-09-12 refocus goal, D9): a card's "owner/repo" name renders as
// two lines (owner on its own line, repo on its own — "never truncate the
// distinguishing half") instead of one continuous string, so these
// assertions check for the owner and repo substrings separately rather than
// the whole "owner/repo" run.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CodeProjectListRow } from "@/lib/code-sessions/queries";
import { ProjectList } from "../project-list";

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

const NOW = "2026-08-27T00:00:00.000Z";

describe("ProjectList grouping (migration 060, W7/D8)", () => {
  it("renders one card per project when no canonicalLabels are given (unchanged behaviour)", () => {
    const projects = [
      project({ id: "p1", display_name: "fleetdm/fleet", session_count: 3 }),
      project({ id: "p2", display_name: "dev/vibe", session_count: 1 }),
    ];
    const html = renderToStaticMarkup(<ProjectList projects={projects} now={NOW} />);
    expect(html).toContain("fleetdm/");
    expect(html).toContain(">fleet<");
    expect(html).toContain("dev/");
    expect(html).toContain(">vibe<");
    expect(html).toContain('href="/code/p1"');
    expect(html).toContain('href="/code/p2"');
    expect(html).not.toContain("labels merged");
  });

  it("clubs projects sharing a canonical label into one GroupCard with aggregated session count", () => {
    const projects = [
      project({ id: "p1", display_name: "dev/membral", session_count: 5, last_active_at: "2026-08-20T00:00:00Z" }),
      project({ id: "p2", display_name: "surajtripathy07/membral", session_count: 2, last_active_at: "2026-08-25T00:00:00Z" }),
      project({ id: "p3", display_name: "surajtripathy07/membral-personal", session_count: 8, last_active_at: "2026-08-10T00:00:00Z" }),
      project({ id: "p4", display_name: "fleetdm/fleet", session_count: 1 }),
    ];
    const canonicalLabels = { p1: "dev/membral", p2: "dev/membral", p3: "dev/membral" };
    const html = renderToStaticMarkup(<ProjectList projects={projects} now={NOW} canonicalLabels={canonicalLabels} />);

    // One merged card: aggregated session count (5+2+8=15), 3 labels merged.
    expect(html).toContain("15 sessions");
    expect(html).toContain("3 labels merged");
    // The unaliased project still renders as its own plain card.
    expect(html).toContain("fleetdm/");
    expect(html).toContain(">fleet<");
    expect(html).toContain('href="/code/p4"');

    // Primary link goes to the highest session_count member (p3, 8 sessions).
    expect(html).toContain('href="/code/p3"');
    // The other two members render as chips, each still linking to its own project page.
    expect(html).toContain('href="/code/p1"');
    expect(html).toContain('href="/code/p2"');
  });

  it("a group of one member renders as a plain ProjectCard, not a GroupCard", () => {
    const projects = [project({ id: "p1", display_name: "dev/membral", session_count: 2 })];
    const canonicalLabels = { p1: "dev/membral" };
    const html = renderToStaticMarkup(<ProjectList projects={projects} now={NOW} canonicalLabels={canonicalLabels} />);
    expect(html).not.toContain("labels merged");
    expect(html).toContain('href="/code/p1"');
  });

  it("keeps client-side search operating over individual project fields before grouping", () => {
    const projects = [
      project({ id: "p1", display_name: "dev/membral", session_count: 1 }),
      project({ id: "p2", display_name: "fleetdm/fleet", session_count: 1 }),
    ];
    const html = renderToStaticMarkup(<ProjectList projects={projects} now={NOW} />);
    // Both render without a query (sanity check that grouping doesn't drop projects).
    expect(html).toContain("dev/");
    expect(html).toContain(">membral<");
    expect(html).toContain("fleetdm/");
    expect(html).toContain(">fleet<");
  });
});
