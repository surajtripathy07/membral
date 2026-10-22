// Render-snapshot lock for step 3D-5 (docs/archive/goals/2026-09-28_g3-edges_goal.md, D7): recorded
// BEFORE the pure-logic move out of issues-content.tsx into
// issues-content.logic.ts, and re-run unchanged after. `TZ=UTC` keeps
// formatDateAt's toLocaleDateString deterministic on timezone (no
// Date.now() is read here, so no fake clock is needed) but NOT on locale:
// `toLocaleDateString(undefined, …)` resolves the runtime's default ICU
// locale, which differs between a Mac (picks up the OS locale) and a CI
// runner (no LANG/LC_ALL set) — "1 Aug 2026" vs "Aug 1, 2026" for the same
// Date. Pin `Date.prototype.toLocaleDateString`/`toLocaleString`/
// `toLocaleTimeString` to a fixed locale+UTC for the run so the rendered
// HTML is byte-identical everywhere. Fixtures follow the `issue()`/
// `payload()` shape in issues-content.test.tsx.
process.env.TZ = "UTC";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { IssueAttribution } from "@/lib/agent-stats/attribution";
import { IssuesContent, type IssuesApiPayload } from "../issues-content";

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

function payload(issues: IssueAttribution[], overrides: Partial<IssuesApiPayload> = {}): IssuesApiPayload {
  return {
    issues,
    unattributed: issue({ issue: null, kind: null, sessions: 0, role: null, buildVerb: null, commits: [], costUsd: null }),
    sessions_total: issues.length,
    estimated: true,
    ...overrides,
  };
}

describe("IssuesContent render lock (3D-5, pre/post pure-move)", () => {
  it("empty: no issues, sessions seen", async () => {
    const html = renderToStaticMarkup(<IssuesContent loading={false} error={null} data={payload([], { sessions_total: 4 })} />);
    await expect(html).toMatchFileSnapshot("./__snapshots__/issues-content.render.empty.html");
  });

  it("typical: a worked-on GitHub issue and a discussed glab-family MR, grouped by repo", async () => {
    const rows = [
      issue({
        issue: "github.com/acme/billing#7",
        kind: "issue",
        sessions: 2,
        mentions: 1,
        commits: [{ sha: "abc1234def", subject: "fix billing overflow", at: "2026-08-01T00:00:00Z" }],
      }),
      issue({
        issue: "codehub.example/acme/billing!12",
        kind: "merge_request",
        role: "discussed",
        reviewVerb: "reviewed",
        buildVerb: null,
        sessions: 1,
        mentions: 0,
        costUsd: 2.4,
      }),
    ];
    const html = renderToStaticMarkup(
      <IssuesContent loading={false} error={null} data={payload(rows, { glab_hosts: ["codehub.example"] })} />,
    );
    await expect(html).toMatchFileSnapshot("./__snapshots__/issues-content.render.typical.html");
  });

  it("edge: host-less ref, long commit list (Disclosure), untitled commits, mention-without-work fold", async () => {
    const manyCommits = Array.from({ length: 5 }, (_, i) => ({
      sha: `${i}23456789abcdef`,
      subject: `commit number ${i} with a fairly long subject line describing the change`,
      at: "2026-08-05T00:00:00Z",
    }));
    const rows = [
      issue({
        issue: "bare-repo#3",
        kind: "issue",
        commits: manyCommits,
        untitledCommits: 2,
      }),
      issue({
        issue: "bare-repo#9",
        kind: "issue",
        commits: [],
        untitledCommits: 1,
      }),
      issue({
        issue: "codehub.example/acme/billing#42",
        kind: "issue",
        role: "referenced",
        sessions: 0,
        mentions: 3,
        costUsd: null,
        commits: [],
      }),
    ];
    const html = renderToStaticMarkup(<IssuesContent loading={false} error={null} data={payload(rows)} />);
    await expect(html).toMatchFileSnapshot("./__snapshots__/issues-content.render.edge.html");
  });
});
