// Goal 2026-09-26 W2 (P0b, P0d): render checks for the Issues tab —
// renderToStaticMarkup pattern as in sessions-outcome-table.test.tsx.
//
// UX audit B1 rewrite: rows now group under a repo sub-header with the host
// prefix dropped (a compact "#N"/"!N" label, not the full qualified ref), and
// a ref links only via forgeUrl on a GitHub host (maintainer note) — this
// fixture's own "codehub.example" glab-family host no longer links, same as
// forge-url.ts's own documented posture.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { IssueAttribution } from "@/lib/agent-stats/attribution";
import { IssuesContent, type IssuesApiPayload } from "../issues-content";
import { groupByRepo } from "../issues-content.logic";

function issue(overrides: Partial<IssueAttribution> = {}): IssueAttribution {
  return {
    issue: "codehub.example/acme/billing#7",
    kind: "issue",
    sessions: 1,
    mentions: 0,
    turns: 3,
    tokens: { input: 10, output: 5, cache_read: 0, cache_creation: 0 },
    costUsd: 0.01,
    estimated: true,
    role: "worked_on",
    reviewVerb: null,
    buildVerb: "committed",
    commits: [],
    unpricedSessions: 0,
    inferredRef: false,
    sessionIds: [],
    turnIdxBySession: {},
    ...overrides,
  };
}

function payload(issues: IssueAttribution[]): IssuesApiPayload {
  return {
    issues,
    unattributed: issue({ issue: null, kind: null, sessions: 0, role: null, buildVerb: null, commits: [], costUsd: null }),
    sessions_total: issues.length,
    estimated: true,
  };
}

describe("IssuesContent", () => {
  it("drops the host prefix, groups under a repo sub-header, and renders no link for a non-GitHub host", () => {
    const html = renderToStaticMarkup(<IssuesContent loading={false} error={null} data={payload([issue()])} />);
    expect(html).toContain("acme/billing"); // repo group header
    expect(html).not.toMatch(/<a[^>]*codehub\.example/);
    // D-065: an unknown-family host has no link, so its label carries the repo (same rule as Today).
    expect(html).toMatch(/<span>acme\/billing#7<\/span>/);
  });

  it("a glab-family host (in glab_hosts) reads `#N` / `!N` and links — the same host check for label and link", () => {
    const html = renderToStaticMarkup(
      <IssuesContent
        loading={false}
        error={null}
        data={{
          ...payload([issue(), issue({ issue: "codehub.example/acme/billing#17049", kind: "merge_request" })]),
          glab_hosts: ["codehub.example"],
        }}
      />,
    );
    expect(html).toContain('href="https://codehub.example/acme/billing/-/issues/7"');
    expect(html).toContain('href="https://codehub.example/acme/billing/-/merge_requests/17049"');
    expect(html).toMatch(/>#7</);
    expect(html).toMatch(/>!17049</);
  });

  it("a GitHub-hosted merge request links via forgeUrl (to its issues page — GitHub redirects) and keeps the MR tag", () => {
    const html = renderToStaticMarkup(
      <IssuesContent loading={false} error={null} data={payload([issue({ issue: "github.com/acme/billing#45", kind: "merge_request" })])} />,
    );
    expect(html).toContain('href="https://github.com/acme/billing/issues/45"');
    expect(html).toContain(">MR<");
  });

  it("a host-less ref renders a span, not a link", () => {
    const html = renderToStaticMarkup(
      <IssuesContent loading={false} error={null} data={payload([issue({ issue: "acme/billing#12" })])} />,
    );
    expect(html).toMatch(/<span>acme\/billing#12<\/span>/); // D-065: no host, no link, so the repo stays in the label
    expect(html).not.toMatch(/<a[^>]*acme\/billing/);
  });

  it("the Issue column carries a minimum width so a ref does not wrap every few characters", () => {
    const html = renderToStaticMarkup(<IssuesContent loading={false} error={null} data={payload([issue()])} />);
    expect(html).toMatch(/<th[^>]*min-w-\[18rem\][^>]*>Issue<\/th>/);
    expect(html).toMatch(/<td[^>]*min-w-\[18rem\]/);
    expect(html).not.toContain("break-all");
  });

  // ---- goal 2026-09-26 W4 (P2): role and the est. label ----

  it("shows each ref's derived role with its observed verbs, and labels every cost an estimate via fmtUsdEst", () => {
    const html = renderToStaticMarkup(
      <IssuesContent
        loading={false}
        error={null}
        data={payload([
          issue({ role: "worked_on", reviewVerb: "reviewed", buildVerb: null, costUsd: 2.1 }),
          issue({ issue: "codehub.example/acme/billing#254702", role: "discussed", reviewVerb: null, buildVerb: null, sessions: 0, mentions: 1, costUsd: 4.2 }),
        ])}
      />,
    );
    expect(html).toMatch(/<th[^>]*>Role<\/th>/);
    expect(html).toContain('data-role="worked_on">worked on<');
    expect(html).toContain("reviewed");
    expect(html).toContain('data-role="discussed">discussed<');
    expect(html).toContain("Cost (est.)");
    expect(html).toContain("$2.10 est.");
    expect(html).toContain("$4.20 est.");
  });

  it("a build verb with an underscore reads as words; a row with no cost carries no est. label", () => {
    const html = renderToStaticMarkup(
      <IssuesContent loading={false} error={null} data={payload([issue({ buildVerb: "opened_mr", costUsd: null })])} />,
    );
    expect(html).toContain("opened mr");
    // the column header still reads "Cost (est.)"; the no-cost cell itself is a bare "—", never "$0.00 est."
    expect(html).toMatch(/tabular-nums">—<\/td>/);
    expect(html).not.toContain("$0.00");
  });

  // ---- UX audit B1: commits collapse, unattributed summary, mentions fold ----

  it("shows the first 2 commits inline, the rest behind a '+N commits' disclosure", () => {
    const commits = Array.from({ length: 5 }, (_, i) => ({ sha: `sha${i}`.padEnd(7, "0"), subject: `commit ${i}`, at: "2026-09-01T00:00:00Z" }));
    const html = renderToStaticMarkup(<IssuesContent loading={false} error={null} data={payload([issue({ commits })])} />);
    expect(html).toContain("commit 0");
    expect(html).toContain("commit 1");
    expect(html).toContain("+3 commits");
  });

  it("maintainer steer: cost no issue claims is never shown — no Unattributed row, line or commits", () => {
    const data: IssuesApiPayload = {
      issues: [issue()],
      unattributed: issue({ issue: null, kind: null, sessions: 264, role: null, buildVerb: null, commits: [], costUsd: 7473 }),
      sessions_total: 265,
      estimated: true,
    };
    data.unattributed.commits = [{ sha: "c0ffee1", subject: "stray commit", at: "2026-09-01T00:00:00Z" }];
    const html = renderToStaticMarkup(<IssuesContent loading={false} error={null} data={data} />);
    expect(html).not.toContain("264 sessions");
    expect(html).not.toContain("$7,473");
    expect(html).not.toContain("not tied to any issue");
    expect(html).not.toContain("stray commit");
    expect(html).not.toMatch(/unattributed/i);
  });

  it("UX W5: a row with 3 sessions shows the newest title, then '+2 more' listing the others, linked to their turns", () => {
    const row = issue({
      sessions: 3,
      sessionIds: ["s-1", "s-2", "s-3"],
      sessionRefs: [
        { id: "s-3", title: "Ship the billing export", started_at: "2026-09-26T09:00:00Z", turn_idx: 5 },
        { id: "s-2", title: "Fix the rounding bug", started_at: "2026-09-25T09:00:00Z", turn_idx: null },
        { id: "s-1", title: "Draft the ledger import", started_at: "2026-09-24T09:00:00Z", turn_idx: 2 },
      ],
    });
    const html = renderToStaticMarkup(<IssuesContent loading={false} error={null} data={payload([row])} />);
    expect(html).toContain("Ship the billing export");
    expect(html).toContain("+2 more");
    expect(html).toContain('href="/code/session/s-3?turn=5#turn-5"');
    expect(html).toContain('href="/code/session/s-2"');
    expect(html).toContain('href="/code/session/s-1?turn=2#turn-2"');
    expect(html).not.toMatch(/>3 sessions</);
  });

  it("folds 'referenced' rows with 0 sessions and no cost behind a 'mentions without work' disclosure", () => {
    const mention = issue({ issue: "codehub.example/acme/other#3", role: "referenced", sessions: 0, mentions: 2, costUsd: null, buildVerb: null });
    const html = renderToStaticMarkup(<IssuesContent loading={false} error={null} data={payload([issue(), mention])} />);
    expect(html).toContain("Show 1 mention without work");
    // still reachable — no silent drop
    expect(html).toContain("acme/other#3");
  });
});

describe("groupByRepo (UX W6 3a: one repo is one group)", () => {
  it("keys on host + owner/repo and folds a host-less owner/repo into its one host-qualified group", () => {
    const groups = groupByRepo([
      issue({ issue: "github.com/surajtripathy07/membral-personal#118" }),
      issue({ issue: "surajtripathy07/membral-personal#119" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].repo).toBe("surajtripathy07/membral-personal");
    expect(groups[0].rows).toHaveLength(2);
  });

  it("keeps a bare repo name the route did not qualify as its own, plainly labelled group", () => {
    const groups = groupByRepo([
      issue({ issue: "github.com/surajtripathy07/membral-personal#118" }),
      issue({ issue: "other-repo#3" }),
    ]);
    expect(groups.map((g) => g.repo)).toEqual(["surajtripathy07/membral-personal", "other-repo"]);
  });

  it("does not merge the same owner/repo on two different hosts", () => {
    const groups = groupByRepo([
      issue({ issue: "github.com/acme/billing#1" }),
      issue({ issue: "codehub.example/acme/billing#1" }),
    ]);
    expect(groups).toHaveLength(2);
  });

  it("with sessions but no issue, the page says so instead of showing an unattributed total", () => {
    const html = renderToStaticMarkup(
      <IssuesContent
        loading={false}
        error={null}
        data={{
          ...payload([]),
          unattributed: issue({ issue: null, kind: null, sessions: 2, role: null, costUsd: 12 }),
          sessions_total: 2,
        }}
      />,
    );
    expect(html).toContain("No issue or MR was worked on in your sessions yet.");
    expect(html).not.toMatch(/unattributed|\$12/i);
  });

  it("review S4: a worked-on row with no attributed cost shows —, never $0.00; the footnote is one line", () => {
    const html = renderToStaticMarkup(
      <IssuesContent
        loading={false}
        error={null}
        data={payload([issue({ issue: "github.com/acme/api#41", costUsd: 0 }), issue({ issue: "github.com/acme/api#42", costUsd: null })])}
      />,
    );
    expect(html).not.toContain("$0.00");
    expect(html.match(/tabular-nums">—<\/td>/g)?.length).toBe(2);
    expect(html).toContain("Cost is shown only where a session&#x27;s work on an issue was observed.");
    expect(html).not.toMatch(/split across its refs/);
  });
});

