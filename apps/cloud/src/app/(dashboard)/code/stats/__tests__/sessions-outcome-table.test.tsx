// #93 — render checks for SessionsOutcomeTable (the /code/stats per-session
// outcome link). renderToStaticMarkup pattern established in
// project-facts.test.tsx / issues-content.tsx.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SessionOutcome } from "@/lib/agent-stats/attribution";
import type { RecentSessionForStatsRow } from "@/lib/code-sessions/queries";
import { type SessionOutcomeRowData, SessionsOutcomeTable } from "../sessions-outcome-table";

function sessionRow(overrides: Partial<RecentSessionForStatsRow> = {}): RecentSessionForStatsRow {
  return {
    id: "s1",
    started_at: "2026-09-01T12:00:00.000Z",
    git_branch: "main",
    code_project_id: "p1",
    project_display_name: "CodeHub",
    project_repo_identity: "codehub/parade-planner",
    ...overrides,
  };
}

function outcome(overrides: Partial<SessionOutcome> = {}): SessionOutcome {
  return { issues: [], commits: [], ...overrides };
}

describe("SessionsOutcomeTable", () => {
  it("renders an empty state when there are no sessions in the window", () => {
    const html = renderToStaticMarkup(<SessionsOutcomeTable rows={[]} />);
    expect(html).toContain("No sessions in this window yet.");
  });

  it("renders the literal 'no outcome recorded' when a session has no resolved issues or commits", () => {
    const rows: SessionOutcomeRowData[] = [{ session: sessionRow(), outcome: outcome() }];
    const html = renderToStaticMarkup(<SessionsOutcomeTable rows={rows} />);
    expect(html).toContain("no outcome recorded");
  });

  it("renders issue badges and commit subjects when the session resolved to an outcome", () => {
    const rows: SessionOutcomeRowData[] = [
      {
        session: sessionRow(),
        outcome: outcome({
          issues: [
            { ref: "codehub.example/codehub/parade-planner#87", kind: "issue" },
            { ref: "codehub.example/codehub/parade-planner#93", kind: "issue" },
          ],
          commits: [
            {
              sha: "abc1234def",
              observed: true,
              turnIdx: 3,
              message: "m",
              subject: "fix: usage viz",
              sessionId: "s1",
              at: "",
              truncated: false,
            },
          ],
        }),
      },
    ];
    const html = renderToStaticMarkup(<SessionsOutcomeTable rows={rows} />);
    expect(html).toContain("codehub.example/codehub/parade-planner#87");
    expect(html).toContain("codehub.example/codehub/parade-planner#93");
    expect(html).toContain("abc1234");
    expect(html).toContain("fix: usage viz");
    expect(html).not.toContain("no outcome recorded");
  });

  it("renders the branch and project name, and links to the session", () => {
    const rows: SessionOutcomeRowData[] = [
      { session: sessionRow({ git_branch: "feature/x", id: "s9" }), outcome: outcome() },
    ];
    const html = renderToStaticMarkup(<SessionsOutcomeTable rows={rows} />);
    expect(html).toContain("feature/x");
    expect(html).toContain("CodeHub");
    expect(html).toContain('href="/code/session/s9"');
  });

  it("a GitHub-hosted ref renders as a link via forgeUrl; a non-GitHub host renders a span (maintainer requirement: forgeUrl only)", () => {
    const rows: SessionOutcomeRowData[] = [
      {
        session: sessionRow(),
        outcome: outcome({
          issues: [
            { ref: "codehub.example/acme/billing#17049", kind: "merge_request" },
            { ref: "codehub.example/acme/billing#17049", kind: "issue" },
            { ref: "github.com/acme/billing#12", kind: "issue" },
          ],
        }),
      },
    ];
    const html = renderToStaticMarkup(<SessionsOutcomeTable rows={rows} />);
    // forgeUrl (lib/format/forge-url.ts) only names a page for GitHub hosts —
    // codehub.example stays plain text, its !N label unchanged.
    expect(html).not.toMatch(/<a[^>]*codehub\.example/);
    expect(html).toContain("codehub.example/acme/billing!17049");
    expect(html).toContain('href="https://github.com/acme/billing/issues/12"');
  });

  it("an unknown or non-GitHub host renders a span, not a link", () => {
    const rows: SessionOutcomeRowData[] = [
      { session: sessionRow(), outcome: outcome({ issues: [{ ref: "acme/billing#12", kind: "issue" }] }) },
    ];
    const html = renderToStaticMarkup(<SessionsOutcomeTable rows={rows} />);
    expect(html).toContain("acme/billing#12");
    expect(html).not.toMatch(/<a[^>]*acme\/billing#12/);
    expect(html).toMatch(/<span[^>]*>acme\/billing#12<\/span>/);
  });

  it("groups rows under one header per project instead of repeating the project cell", () => {
    const rows: SessionOutcomeRowData[] = [
      { session: sessionRow({ id: "s1" }), outcome: outcome() },
      { session: sessionRow({ id: "s2", code_project_id: "p2", project_display_name: "Billing" }), outcome: outcome() },
      { session: sessionRow({ id: "s3" }), outcome: outcome() },
    ];
    const html = renderToStaticMarkup(<SessionsOutcomeTable rows={rows} />);
    // one project link per project, not per row
    expect(html.match(/href="\/code\/p1"/g)).toHaveLength(1);
    expect(html.match(/href="\/code\/p2"/g)).toHaveLength(1);
    expect(html.match(/scope="rowgroup"/g)).toHaveLength(2);
    expect(html).toContain("2 sessions");
    // first-appearance order: CodeHub's group (s1) before Billing's (s2), s3 folded into CodeHub's
    expect(html.indexOf('href="/code/p1"')).toBeLessThan(html.indexOf('href="/code/p2"'));
    expect(html.indexOf('href="/code/session/s3"')).toBeLessThan(html.indexOf('href="/code/p2"'));
  });

  it("falls back to the repo identity when no display name is set", () => {
    const rows: SessionOutcomeRowData[] = [
      { session: sessionRow({ project_display_name: null }), outcome: outcome() },
    ];
    const html = renderToStaticMarkup(<SessionsOutcomeTable rows={rows} />);
    expect(html).toContain("codehub/parade-planner");
  });

  it("caps rendered commits at 3 with a '+N more' note", () => {
    const commits = Array.from({ length: 5 }, (_, i) => ({
      sha: `sha${i}`.padEnd(7, "0"),
      observed: true,
      turnIdx: i,
      message: "m",
      subject: `commit ${i}`,
      sessionId: "s1",
      at: "",
      truncated: false,
    }));
    const rows: SessionOutcomeRowData[] = [{ session: sessionRow(), outcome: outcome({ commits }) }];
    const html = renderToStaticMarkup(<SessionsOutcomeTable rows={rows} />);
    expect(html).toContain("+2 more commit(s)");
  });

  // UX audit B3 ("add a cost column" / "collapse runs of 'no outcome
  // recorded' into one row per project").
  it("UX W5: a row names its session by title (linked), with the date beneath; no title falls back to the date", () => {
    const html = renderToStaticMarkup(
      <SessionsOutcomeTable
        rows={[
          { session: sessionRow({ id: "s-t" }), outcome: outcome({ issues: [{ ref: "codehub.example/acme/billing#1", kind: "issue" }] }), title: "Fix the rounding bug" },
          { session: sessionRow({ id: "s-u" }), outcome: outcome({ issues: [{ ref: "codehub.example/acme/billing#2", kind: "issue" }] }) },
        ]}
      />,
    );
    expect(html).toContain("Fix the rounding bug");
    expect(html).toContain('href="/code/session/s-t"');
    expect(html).toContain('href="/code/session/s-u"');
  });

  it("renders a cost column, never a bare $0.00", () => {
    const rows: SessionOutcomeRowData[] = [{ session: sessionRow(), outcome: outcome(), costUsd: 12.4 }];
    const html = renderToStaticMarkup(<SessionsOutcomeTable rows={rows} />);
    expect(html).toContain("$12.40");
    expect(html).not.toContain("$0.00");
  });

  it("collapses two or more no-outcome sessions in a project into one summed row, but leaves a lone one inline", () => {
    const rows: SessionOutcomeRowData[] = [
      { session: sessionRow({ id: "s1" }), outcome: outcome(), costUsd: 3 },
      { session: sessionRow({ id: "s2" }), outcome: outcome(), costUsd: 2 },
    ];
    const html = renderToStaticMarkup(<SessionsOutcomeTable rows={rows} />);
    expect(html).toContain("2 sessions · no outcome recorded · $5.00");
    // still reachable — no silent drop of the individual sessions
    expect(html).toContain('href="/code/session/s1"');
    expect(html).toContain('href="/code/session/s2"');
  });
});
