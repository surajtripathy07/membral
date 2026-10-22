// W3 D5: current-work.ts's item grouping rules (design §4). The preamble's
// own sections are covered in preamble.work-sections.test.ts.
// Design: docs/design/observed-forge-refs.md §4; D-071.
import { describe, expect, it } from "vitest";
import {
  attributeBareRows,
  CURRENT_WORK_HEADING,
  type CurrentWorkGroup,
  currentWorkGroups,
  type ForgeRefReadRow,
  isGitBranchName,
  renderCurrentWork,
  renderGroupLine,
  seenText,
} from "../current-work";

const NOW = Date.parse("2026-09-26T12:00:00Z"); // a Saturday
const PROJECT_IDENTITY = "codehub.example/acme/api";
const SHA_A1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";

function ref(overrides: Partial<ForgeRefReadRow>): ForgeRefReadRow {
  return {
    session_id: "s1",
    turn_idx: 0,
    action_ix: 0,
    kind: "issue",
    target_kind: null,
    prose_ref: false,
    host: "codehub.example",
    project: "acme/api",
    number: null,
    sha: null,
    branch: null,
    observed_state: null,
    title: null,
    observed_at: "2026-09-25T10:00:00Z", // 26h before NOW
    ...overrides,
  };
}

function groups(rows: ForgeRefReadRow[], memoryRefs: Parameters<typeof currentWorkGroups>[0]["memoryRefs"] = []) {
  return currentWorkGroups({ rows, memoryRefs, projectIdentity: PROJECT_IDENTITY, now: NOW });
}

const tokens = (g: CurrentWorkGroup) => ({ lead: g.lead.token, members: g.members.map((m) => m.token) });

/** Design §4 fixture: commit a1 names #4 and #7; MR !9 is on a1's branch in the same session. */
const fixture = [
  ref({ turn_idx: 1, kind: "commit", sha: SHA_A1, branch: "feat-ledger" }),
  ref({ turn_idx: 1, kind: "issue", number: 4, sha: SHA_A1 }),
  ref({ turn_idx: 1, kind: "issue", number: 7, sha: SHA_A1 }),
  ref({ turn_idx: 2, kind: "merge_request", number: 9, branch: "feat-ledger", observed_state: "opened" }),
];

describe("current work grouping (design §4)", () => {
  it("fixture: two groups #4 (!9, a1) and #7 (!9, a1); #4 never lists #7", () => {
    const gs = groups(fixture);
    const byLead = new Map(gs.map((g) => [g.lead.token, tokens(g).members]));
    expect([...byLead.keys()].sort()).toEqual(["#4", "#7"]);
    expect(byLead.get("#4")).toEqual(["!9", "a1a1a1a"]);
    expect(byLead.get("#7")).toEqual(["!9", "a1a1a1a"]);
    const line4 = renderGroupLine(gs.find((g) => g.lead.token === "#4") as CurrentWorkGroup, NOW);
    expect(line4).not.toContain("#7");
    expect(line4).toBe("- #4 — seen 26h ago: !9 — seen 26h ago · a1a1a1a — seen 26h ago");
  });

  it("does not link an MR to a commit on the same branch name in ANOTHER session", () => {
    const rows = [
      ref({ session_id: "s1", turn_idx: 1, kind: "commit", sha: SHA_A1, branch: "feat-ledger" }),
      ref({ session_id: "s1", turn_idx: 1, kind: "issue", number: 4, sha: SHA_A1 }),
      ref({ session_id: "s2", kind: "merge_request", number: 9, branch: "feat-ledger", observed_state: "opened" }),
    ];
    const gs = groups(rows);
    const g4 = gs.find((g) => g.lead.token === "#4") as CurrentWorkGroup;
    expect(tokens(g4).members).toEqual(["a1a1a1a"]);
    // The MR stands as its own group.
    expect(gs.map((g) => g.lead.token).sort()).toEqual(["!9", "#4"]);
  });

  it("never links through a default branch, even in one session", () => {
    const rows = [
      ref({ turn_idx: 1, kind: "commit", sha: SHA_A1, branch: "main" }),
      ref({ turn_idx: 1, kind: "issue", number: 4, sha: SHA_A1 }),
      ref({ turn_idx: 2, kind: "merge_request", number: 9, branch: "main" }),
    ];
    const g4 = groups(rows).find((g) => g.lead.token === "#4") as CurrentWorkGroup;
    expect(tokens(g4).members).toEqual(["a1a1a1a"]);
  });

  it("drops an item whose latest observed state is merged", () => {
    const rows = [
      ...fixture,
      ref({
        turn_idx: 5,
        kind: "merge_request",
        number: 9,
        observed_state: "merged",
        observed_at: "2026-09-25T18:00:00Z",
      }),
    ];
    for (const g of groups(rows)) {
      expect(g.lead.token).not.toBe("!9");
      expect(tokens(g).members).not.toContain("!9");
    }
  });

  it("keeps an item whose latest state is open after an earlier closed", () => {
    const rows = [
      ref({ kind: "issue", number: 3, observed_state: "closed", observed_at: "2026-09-22T09:00:00Z" }),
      ref({ kind: "issue", number: 3, observed_state: "opened", observed_at: "2026-09-24T09:00:00Z" }),
    ];
    expect(groups(rows).map((g) => g.lead.token)).toEqual(["#3"]);
  });

  it("renders when each item was last seen and never a forge state (the agent checks state live)", () => {
    const rows = [
      ref({
        kind: "issue",
        number: 4,
        observed_state: "opened",
        title: "Fix ledger totals",
        observed_at: "2026-09-22T09:00:00Z",
      }),
      // A later state-less observation moves "seen" forward.
      ref({ turn_idx: 3, kind: "issue", number: 4, observed_at: "2026-09-25T09:00:00Z" }),
      ref({ session_id: "s2", kind: "merge_request", number: 12, observed_at: "2026-09-24T09:00:00Z" }),
    ];
    const lines = renderCurrentWork(groups(rows), 6, NOW);
    expect(lines[0]).toBe(CURRENT_WORK_HEADING);
    expect(lines[0]).toBe("Seen in the last 7 days");
    expect(lines).toContain("- #4 Fix ledger totals — seen 27h ago");
    expect(lines).toContain("- !12 — seen 2d ago");
    expect(lines.join("\n")).not.toMatch(/\b(open|opened|merged|closed) as of\b/);
    // Relative ages: minutes under 1h, hours under 48h, then days. No weekday, no timezone.
    expect(seenText("2026-09-26T11:55:00Z", NOW)).toBe("seen 5m ago");
    expect(seenText("2026-09-26T07:00:00Z", NOW)).toBe("seen 5h ago");
    expect(seenText("2026-09-24T13:00:00Z", NOW)).toBe("seen 47h ago");
    expect(seenText("2026-09-24T12:00:00Z", NOW)).toBe("seen 2d ago");
  });

  it("excludes prose_ref rows: they never lead or group", () => {
    const rows = [ref({ kind: "issue", number: 4, prose_ref: true, observed_state: "opened" })];
    expect(groups(rows)).toEqual([]);
    expect(renderCurrentWork(groups(rows), 6, NOW)).toEqual([]);
  });

  it("renders an inferred MR→issue link as 'probably for #N' and a stated one as 'for #N'", () => {
    const rows = [
      ref({ kind: "issue", number: 12, observed_state: "opened" }),
      ref({ turn_idx: 2, kind: "merge_request", number: 14, observed_state: "opened" }),
      ref({ turn_idx: 3, kind: "merge_request", number: 15 }),
    ];
    const gs = groups(rows, [
      {
        ref: "!14",
        ref_kind: "pr",
        ref_title: "Fix totals",
        ref_issue: "#12",
        ref_issue_basis: "inferred",
        created_at: "2026-09-25T00:00:00Z",
      },
      {
        ref: "!15",
        ref_kind: "pr",
        ref_title: null,
        ref_issue: "#99",
        ref_issue_basis: "stated",
        created_at: "2026-09-25T00:00:00Z",
      },
    ]);
    const g12 = gs.find((g) => g.lead.token === "#12") as CurrentWorkGroup;
    expect(tokens(g12).members).toEqual(["!14"]);
    const line = renderGroupLine(g12, NOW);
    expect(line).toContain("!14 Fix totals (extracted title; probably for #12) — seen 26h ago");
    // #99 is not in the window: the link is labelled but makes no group.
    const g15 = gs.find((g) => g.lead.token === "!15") as CurrentWorkGroup;
    expect(renderGroupLine(g15, NOW)).toContain("!15 (for #99) — seen 26h ago");
  });

  it("prefers an observed title over an extracted one, and truncates titles", () => {
    const rows = [ref({ kind: "issue", number: 4, title: `Observed ${"t".repeat(80)}` })];
    const gs = groups(rows, [
      { ref: "#4", ref_kind: "issue", ref_title: "Extracted", created_at: "2026-09-25T00:00:00Z" },
    ]);
    const line = renderGroupLine(gs[0], NOW);
    expect(line).not.toContain("Extracted");
    expect(line).not.toContain("extracted title");
    expect(line).toMatch(/^- #4 Observed t+… — seen 26h ago$/);
  });

  it("three same-session issues render as three lines with no `also` (each is listed already)", () => {
    const rows = [
      ref({ kind: "issue", number: 1 }),
      ref({ turn_idx: 2, kind: "issue", number: 2 }),
      ref({ turn_idx: 3, kind: "issue", number: 3 }),
    ];
    const lines = renderCurrentWork(groups(rows), 6, NOW);
    expect(lines).toEqual([CURRENT_WORK_HEADING, "- #1 — seen 26h ago", "- #2 — seen 26h ago", "- #3 — seen 26h ago"]);
  });

  it("mentions an unlisted same-session item once per session, on the first listed lead only", () => {
    // Four lines' worth of groups with room for two: #1 and #2 are listed; !14 and #3 are cut.
    const rows = [
      ref({ kind: "issue", number: 1, observed_at: "2026-09-25T12:00:00Z" }),
      ref({ turn_idx: 2, kind: "issue", number: 2, observed_at: "2026-09-25T11:00:00Z" }),
      ref({ turn_idx: 3, kind: "merge_request", number: 14, observed_at: "2026-09-25T10:00:00Z" }),
      ref({ turn_idx: 4, kind: "issue", number: 3, observed_at: "2026-09-25T09:00:00Z" }),
    ];
    const lines = renderCurrentWork(groups(rows), 4, NOW);
    expect(lines).toEqual([
      CURRENT_WORK_HEADING,
      "- #1 — seen 24h ago; also in this session: !14, #3",
      "- #2 — seen 25h ago",
      "…2 more",
    ]);
  });

  it("never renders a branch whose name breaks git's ref-name rules or is a file the session touched", () => {
    const rows = [
      ref({ kind: "branch", branch: "feat/ok-branch" }),
      ref({ turn_idx: 2, kind: "branch", branch: "bad name" }),
      ref({ turn_idx: 3, kind: "branch", branch: "a..b" }),
      ref({ turn_idx: 4, kind: "branch", branch: "-x" }),
      ref({ turn_idx: 5, kind: "branch", branch: "x.lock" }),
      ref({ turn_idx: 6, kind: "branch", branch: "plugins/demo/hooks/hooks.json" }),
    ];
    const gs = currentWorkGroups({
      rows,
      projectIdentity: PROJECT_IDENTITY,
      sessionFiles: new Map([["s1", ["/home/dev/repo/plugins/demo/hooks/hooks.json"]]]),
      now: NOW,
    });
    expect(gs.map((g) => g.lead.token)).toEqual(["feat/ok-branch"]);
    expect(isGitBranchName("feat/x")).toBe(true);
    expect(isGitBranchName("feat/")).toBe(false);
  });

  it("an inferred MR→issue link is terminal: the MR is listed with its hedge, its branch and commits are not", () => {
    const rows = [
      ref({ kind: "issue", number: 12, observed_state: "opened" }),
      ref({ session_id: "s2", turn_idx: 1, kind: "commit", sha: SHA_A1, branch: "feat-guess" }),
      ref({ session_id: "s2", turn_idx: 2, kind: "merge_request", number: 14, branch: "feat-guess" }),
    ];
    const memoryRefs = [
      { ref: "!14", ref_kind: "pr", ref_issue: "#12", ref_issue_basis: "inferred", created_at: "2026-09-25T00:00:00Z" },
    ];
    const g12 = groups(rows, memoryRefs).find((g) => g.lead.token === "#12") as CurrentWorkGroup;
    expect(tokens(g12).members).toEqual(["!14"]);
    expect(renderGroupLine(g12, NOW)).toContain("!14 (probably for #12)");
    // A stated link is structural: the walk passes the MR to its branch's commit.
    const stated = groups(rows, [{ ...memoryRefs[0], ref_issue_basis: "stated" }]);
    expect(tokens(stated.find((g) => g.lead.token === "#12") as CurrentWorkGroup).members).toEqual(["!14", "a1a1a1a"]);
  });

  it("drops a finished MR's branch and commits with it, but keeps a branch another live item still uses", () => {
    const rows = [
      ref({ turn_idx: 1, kind: "commit", sha: SHA_A1, branch: "feat-done" }),
      ref({ turn_idx: 2, kind: "merge_request", number: 9, branch: "feat-done", observed_state: "merged" }),
      ref({ turn_idx: 3, kind: "branch", branch: "feat-done" }),
    ];
    expect(groups(rows)).toEqual([]);
    const live = [...rows, ref({ turn_idx: 4, kind: "merge_request", number: 10, branch: "feat-done" })];
    const gs = groups(live);
    expect(gs.map((g) => tokens(g))).toEqual([{ lead: "!10", members: ["a1a1a1a"] }]);
  });

  it("keeps the repo on an item or linked issue of another repo", () => {
    const rows = [
      ref({ kind: "issue", number: 3, project: "acme/web" }),
      ref({ session_id: "s2", kind: "merge_request", number: 14 }),
    ];
    const gs = groups(rows, [
      {
        ref: "!14",
        ref_kind: "pr",
        ref_issue: "codehub.example/acme/web#3",
        ref_issue_basis: "stated",
        created_at: "2026-09-25T00:00:00Z",
      },
    ]);
    const lines = renderCurrentWork(gs, 6, NOW);
    expect(lines).toContain("- acme/web#3 — seen 26h ago: !14 (for acme/web#3) — seen 26h ago");
  });

  it("caps the section and shows `…N more`", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ref({ session_id: `s${i}`, kind: "issue", number: i + 1 }));
    const lines = renderCurrentWork(groups(rows), 6, NOW);
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe("…5 more");
  });
});

describe("a row with no project is not claimed by this repo when another repo owns the number", () => {
  it("merges a bare !123456 into codehub-org/codehub!123456: one item, qualified", async () => {
    const { currentWorkItems } = await import("../current-work");
    const { items } = currentWorkItems({
      rows: [
        ref({ kind: "merge_request", number: 123456, project: "codehub-org/codehub", host: "gitlab.com" }),
        ref({ kind: "merge_request", number: 123456, project: null, host: null, observed_at: "2026-09-25T09:59:00Z" }),
        ref({ kind: "merge_request", number: 54321, project: null, host: null }),
      ],
      projectIdentity: "gitlab.com/codehub-org/portal",
      now: NOW,
    });
    expect(items.map((i) => i.token).sort()).toEqual(["!54321", "codehub-org/codehub!123456"]);
  });

  it("drops a bare row whose host is another forge's", async () => {
    const { currentWorkItems } = await import("../current-work");
    const { items } = currentWorkItems({
      rows: [ref({ kind: "issue", number: 5, project: null, host: "github.com" })],
      projectIdentity: "gitlab.com/codehub-org/portal",
      now: NOW,
    });
    expect(items).toEqual([]);
  });
});

describe("a cwd-defaulted row followed by the right repo in the same session", () => {
  it("merges portal!123456 (viewed without -R) into codehub-org/codehub!123456 seen seconds later: one line, qualified", async () => {
    const { currentWorkItems } = await import("../current-work");
    const own = "gitlab.com/codehub-org/portal";
    const { items } = currentWorkItems({
      rows: [
        ref({
          kind: "merge_request",
          number: 123456,
          host: "gitlab.com",
          project: "codehub-org/portal",
          observed_at: "2026-09-25T10:00:00Z",
        }),
        ref({
          kind: "merge_request",
          number: 123456,
          host: "gitlab.com",
          project: "codehub-org/codehub",
          observed_at: "2026-09-25T10:00:09Z",
        }),
        // Another session's own !123456 an hour later is a different observation: kept as this repo's.
        ref({
          session_id: "s2",
          kind: "merge_request",
          number: 54321,
          host: "gitlab.com",
          project: "codehub-org/portal",
        }),
      ],
      projectIdentity: own,
      now: NOW,
    });
    expect(items.map((i) => i.token).sort()).toEqual(["!54321", "codehub-org/codehub!123456"]);
  });
});

describe("attributeBareRows: a row moves only on a same-session retry and when it carries no evidence", () => {
  const OWN = { host: "gitlab.com", project: "codehub-org/portal" };
  const retry = ref({
    kind: "merge_request",
    number: 123456,
    host: "gitlab.com",
    project: "codehub-org/codehub",
    observed_at: "2026-09-25T10:00:09Z",
  });
  const mine = (o: Partial<ForgeRefReadRow>) =>
    ref({
      kind: "merge_request",
      number: 123456,
      host: "gitlab.com",
      project: OWN.project,
      observed_at: "2026-09-25T10:00:00Z",
      ...o,
    });
  const projectOf = (o: Partial<ForgeRefReadRow>) =>
    attributeBareRows([mine(o), retry], OWN).rows.map((r) => r.project);

  it("the retry pattern merges into the other repo", () => {
    expect(projectOf({})).toEqual(["codehub-org/codehub", "codehub-org/codehub"]);
  });
  it("a commit-subject row (sha) stays this repo's", () => {
    expect(projectOf({ sha: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1" })[0]).toBe(OWN.project);
  });
  it("a row with an observed state stays", () => {
    expect(projectOf({ observed_state: "merged" })[0]).toBe(OWN.project);
  });
  it("a titled view stays", () => {
    expect(projectOf({ title: "Fix totals" })[0]).toBe(OWN.project);
  });
  it("another session's retry, or one observed before the row, does not move it", () => {
    expect(attributeBareRows([mine({}), { ...retry, session_id: "s2" }], OWN).rows[0].project).toBe(OWN.project);
    expect(attributeBareRows([mine({ observed_at: "2026-09-25T10:00:20Z" }), retry], OWN).rows[0].project).toBe(
      OWN.project,
    );
  });
});

describe("fetchProjectSessions: the capped reads keep the latest activity", () => {
  it("orders both reads by ended_at desc (open sessions first), then started_at desc", async () => {
    const { fetchProjectSessions } = await import("../current-work");
    const orders: unknown[][] = [];
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "is", "not", "or", "limit"]) chain[m] = () => chain;
    chain.order = (...args: unknown[]) => {
      orders.push(args);
      return chain;
    };
    const done = Promise.resolve({ data: [], error: null });
    // biome-ignore lint/suspicious/noThenProperty: a thenable query builder, like PostgREST's
    chain.then = done.then.bind(done);
    await fetchProjectSessions({ from: () => chain } as never, "u", "p", "2026-09-01T00:00:00Z");
    const expected = [
      ["ended_at", { ascending: false, nullsFirst: true }],
      ["started_at", { ascending: false }],
    ];
    expect(orders).toEqual([...expected, ...expected]);
  });
});
