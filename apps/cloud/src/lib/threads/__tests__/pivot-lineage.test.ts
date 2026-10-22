// D-055 — pivots: observed branch lineage before inferred prose links.
//
// The maintainer's concern: "discuss one issue, then another in the same
// session (commits land in a new PR), or discuss an issue and pivot to an open
// unrelated MR — if we cannot keep the PR/MR apart from the issue when they
// were not related, we show something wrong and lose trust."
//
// Transcripts are Claude Code JSONL built line by line in the shape of the
// real fixtures (fixtures/e2e-a-*.jsonl) and run through the core parser, as
// the CLI does. The extractor's output (refs, mentions, worked_span) is given
// per case, the way tail-capture hands it to groundSessionIssues.
//
//   a  discuss #A, name #B, commit, push, gh pr create → PR observed; #B, #A discussed
//   b  same, pivot WITHOUT naming ("now the logging one") → #A never committed
//   c  discuss #A, `glab mr checkout 17`, edit, commit, push → !17 build rungs
//   d  discuss #A, `git checkout feature-x` (!17's observed source branch) → same as c
//   e  discuss #A, unrelated question, commit, no PR → span decides
//   f  positive control: "For #41 fix heading" → #41 committed inferred_ref
//   g  already on feature-y: "forget that, let's first finish this open PR"
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProfile, inferRefEnabled, knownBranchesFromTurns } from "@/lib/code-sessions/profile";
import {
  at,
  bothModes,
  commit,
  GH,
  GL,
  ghCreate,
  ground,
  issue,
  ladder,
  parse,
  push,
  row,
  type Step,
} from "./pivot-transcript";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("D-055 kill switch", () => {
  it("MEMBRAL_INFER_REF is OFF unless '1' or 'true'", () => {
    expect(inferRefEnabled(undefined)).toBe(false);
    expect(inferRefEnabled("")).toBe(false);
    expect(inferRefEnabled("0")).toBe(false);
    expect(inferRefEnabled("yes")).toBe(false);
    expect(inferRefEnabled("1")).toBe(true);
    expect(inferRefEnabled("TRUE")).toBe(true);
  });
});

describe("a — discuss #A, name #B, commit, push, gh pr create", () => {
  const steps: Step[] = [
    { user: "What's the status of #7? Is the flaky retry still open?" },
    { say: "#7 is still open; the retry test fails about one run in ten." },
    { user: "OK leave that. Let's do #9 instead: add request logging to the ledger client." },
    { bash: "git checkout -b add-request-logging", out: "Switched to a new branch 'add-request-logging'" },
    { edit: "services/ledger/client.ts" },
    commit("add-request-logging", "a1b2c3d", "Add request logging to the ledger client"),
    push("add-request-logging"),
    ghCreate(12),
  ];
  for (const [mode, env] of bothModes) {
    it(`${mode}: the PR gets edited·committed·pushed·opened_mr (observed); #9 and #7 stay discussed`, () => {
      if (env) vi.stubEnv("MEMBRAL_INFER_REF", env);
      const turns = parse(steps);
      const rows = ground(turns, GH, [
        issue("#7", "What's the status of #7?", at(turns, "#7")),
        issue("#9", "Let's do #9 instead", at(turns, "#9")),
      ]);
      const pr = row(rows, `${GH}#12`, "merge_request");
      expect(ladder(pr)).toEqual(["opened_mr", null, "observed"]);
      expect(pr?.role).toBe("worked_on");
      // Decision: with a PR present, lineage owns the commit; #9 is not also inferred (no double count).
      expect(ladder(row(rows, `${GH}#9`))).toEqual([null, null, "discussed"]);
      expect(ladder(row(rows, `${GH}#7`))).toEqual([null, null, "discussed"]);
      const p = buildProfile(turns, { inferRef: env === "1" });
      expect(p.refs.find((r) => r.refKind === "merge_request")?.evidence.edited).toBeDefined();
    });
  }
});

describe("b — discuss #A, pivot WITHOUT naming, commit", () => {
  const withPr: Step[] = [
    { user: "Can you check why #7 keeps failing in CI?" },
    { say: "The retry test in #7 times out when the ledger mock is slow." },
    { user: "Hmm, park that. Now the logging one — add request logging to the ledger client." },
    { bash: "git checkout -b add-request-logging", out: "Switched to a new branch 'add-request-logging'" },
    { edit: "services/ledger/client.ts" },
    commit("add-request-logging", "b1b2c3d", "Add request logging"),
    push("add-request-logging"),
    ghCreate(13),
  ];
  const noPr = withPr.slice(0, 6);

  it("model returns a span ending before the pivot, no PR: #A is not committed (unattributed)", () => {
    vi.stubEnv("MEMBRAL_INFER_REF", "1");
    const turns = parse(noPr);
    const a = at(turns, "#7");
    const rows = ground(turns, GH, [issue("#7", "why #7 keeps failing", a, { from_turn: a, to_turn: a + 1 })]);
    expect(ladder(row(rows, `${GH}#7`))).toEqual([null, null, "discussed"]);
  });

  for (const [mode, env] of bothModes) {
    it(`${mode}: model returns NO span, PR opened: lineage takes the commit; #A stays discussed`, () => {
      if (env) vi.stubEnv("MEMBRAL_INFER_REF", env);
      const turns = parse(withPr);
      const rows = ground(turns, GH, [issue("#7", "why #7 keeps failing", at(turns, "#7"))]);
      expect(ladder(row(rows, `${GH}#7`))).toEqual([null, null, "discussed"]);
      expect(ladder(row(rows, `${GH}#13`, "merge_request"))).toEqual(["opened_mr", null, "observed"]);
    });
  }

  it("with a span AND the PR: same — #A discussed, PR observed", () => {
    vi.stubEnv("MEMBRAL_INFER_REF", "1");
    const turns = parse(withPr);
    const a = at(turns, "#7");
    const rows = ground(turns, GH, [issue("#7", "why #7 keeps failing", a, { from_turn: a, to_turn: a + 1 })]);
    expect(ladder(row(rows, `${GH}#7`))).toEqual([null, null, "discussed"]);
    expect(ladder(row(rows, `${GH}#13`, "merge_request"))).toEqual(["opened_mr", null, "observed"]);
  });
});

describe("c/d — discuss #A, then work on an unrelated open MR", () => {
  const glCommit = (sha: string): Step => ({
    bash: `git commit -am "Address review: rename helper"`,
    out: `[feature-x ${sha}] Address review: rename helper\n 1 file changed, 2 insertions(+), 2 deletions(-)`,
  });
  const glPush: Step = {
    bash: "git push",
    out: "To codehub.example:acme/billing.git\n   1111111..2222222  feature-x -> feature-x",
  };
  const c: Step[] = [
    { user: "Where are we on #5, the invoice rounding bug?" },
    { say: "#5 still needs a failing test first." },
    { user: "Fine. Pick up the open MR 17 and address its review comments." },
    {
      bash: "glab mr checkout 17",
      out: "Switched to branch 'feature-x'\nYour branch is up to date with 'origin/feature-x'.",
    },
    { edit: "services/ledger/helpers.ts" },
    glCommit("c1c2c3d"),
    glPush,
  ];
  const d: Step[] = [
    { user: "Where are we on #5, the invoice rounding bug?" },
    { say: "#5 still needs a failing test first." },
    {
      bash: "glab mr view 17",
      out: "title:\tRename ledger helper\nstate:\topen\nsource_branch:\tfeature-x\n--\nRenames it.",
    },
    { user: "Fine. Switch to that branch and address the review comments." },
    { bash: "git checkout feature-x", out: "Switched to branch 'feature-x'" },
    { edit: "services/ledger/helpers.ts" },
    glCommit("d1d2c3d"),
    glPush,
  ];
  for (const [mode, env] of bothModes) {
    it(`c ${mode}: glab mr checkout 17 → !17 checked_out, edited·committed·pushed (observed); #5 discussed`, () => {
      if (env) vi.stubEnv("MEMBRAL_INFER_REF", env);
      const turns = parse(c);
      const rows = ground(turns, GL, [issue("#5", "Where are we on #5", at(turns, "#5"))]);
      expect(ladder(row(rows, `${GL}#17`, "merge_request"))).toEqual(["pushed", "checked_out", "observed"]);
      expect(ladder(row(rows, `${GL}#5`))).toEqual([null, null, "discussed"]);
    });
    it(`d ${mode}: git checkout feature-x (!17's observed source branch) → same as c`, () => {
      if (env) vi.stubEnv("MEMBRAL_INFER_REF", env);
      const turns = parse(d);
      const rows = ground(turns, GL, [issue("#5", "Where are we on #5", at(turns, "#5"))]);
      expect(ladder(row(rows, `${GL}#17`, "merge_request"))).toEqual(["pushed", "checked_out", "observed"]);
      expect(ladder(row(rows, `${GL}#5`))).toEqual([null, null, "discussed"]);
    });
  }
});

describe("e — discuss #A, an unrelated question, then a commit with no PR", () => {
  const steps: Step[] = [
    { user: "Look at #7 and tell me what the retry test does." },
    { say: "It retries the ledger call three times and asserts the backoff." },
    { user: "Unrelated: the README badge is broken, fix the URL and commit it." },
    { edit: "README.md" },
    commit("main", "e1e2e3f", "Fix README badge URL"),
  ];
  it("model says the span ended before the question → the commit is unattributed", () => {
    vi.stubEnv("MEMBRAL_INFER_REF", "1");
    const turns = parse(steps);
    const a = at(turns, "#7");
    const rows = ground(turns, GH, [issue("#7", "Look at #7", a, { from_turn: a, to_turn: a + 1 })]);
    expect(ladder(row(rows, `${GH}#7`))).toEqual([null, null, "discussed"]);
  });
  it("model silent (no span), inference ON → documented fallback: inferred to #A", () => {
    vi.stubEnv("MEMBRAL_INFER_REF", "1");
    const turns = parse(steps);
    const rows = ground(turns, GH, [issue("#7", "Look at #7", at(turns, "#7"))]);
    expect(ladder(row(rows, `${GH}#7`))).toEqual(["committed", null, "inferred_ref"]);
  });
  it("model silent, inference OFF → unattributed", () => {
    const turns = parse(steps);
    const rows = ground(turns, GH, [issue("#7", "Look at #7", at(turns, "#7"))]);
    expect(ladder(row(rows, `${GH}#7`))).toEqual([null, null, "discussed"]);
  });
  it("an invalid span (from_turn not a mention, or past the last turn) is ignored → fallback", () => {
    vi.stubEnv("MEMBRAL_INFER_REF", "1");
    const turns = parse(steps);
    const a = at(turns, "#7");
    for (const span of [
      { from_turn: a + 1, to_turn: a + 2 },
      { from_turn: a, to_turn: 999 },
    ]) {
      const rows = ground(turns, GH, [issue("#7", "Look at #7", a, span)]);
      expect(ladder(row(rows, `${GH}#7`))).toEqual(["committed", null, "inferred_ref"]);
    }
  });
});

describe("f — positive control", () => {
  const steps: Step[] = [
    { user: "For #41 fix the heading levels in docs/guide.md, then commit and push." },
    { edit: "docs/guide.md" },
    commit("main", "f1f2f3a", "Fix heading levels in the guide"),
    { bash: "git push", out: "To github.com:acme/billing.git\n   1111111..f1f2f3a  main -> main" },
  ];
  it("inference ON: #41 committed·pushed, inferred_ref (with and without a span covering it)", () => {
    vi.stubEnv("MEMBRAL_INFER_REF", "1");
    const turns = parse(steps);
    const a = at(turns, "#41");
    const last = turns[turns.length - 1].idx;
    for (const span of [undefined, { from_turn: a, to_turn: last }]) {
      const rows = ground(turns, GH, [issue("#41", "For #41 fix the heading levels", a, span)]);
      expect(ladder(row(rows, `${GH}#41`))).toEqual(["pushed", null, "inferred_ref"]);
    }
  });
  it("inference OFF: #41 stays discussed", () => {
    const turns = parse(steps);
    const rows = ground(turns, GH, [issue("#41", "For #41 fix the heading levels", at(turns, "#41"))]);
    expect(ladder(row(rows, `${GH}#41`))).toEqual([null, null, "discussed"]);
  });
});

describe("g — already on a feature branch: 'forget that, let's first finish this open PR'", () => {
  const steps: Step[] = [
    { user: "What's the status of #7? Did the retry fix land?" },
    { say: "#7 is still open; nothing merged for it yet." },
    { user: "Forget that, let's first finish this open PR — tidy the error message." },
    { edit: "services/ledger/errors.ts" },
    commit("feature-y", "9a9b9c9", "Tidy the ledger error message"),
    push("feature-y"),
  ];
  // An earlier session of the same project opened PR #20 from feature-y.
  const earlier = knownBranchesFromTurns([
    { props: { action: { verb: "pushed", refKind: "branch", ref: "feature-y", branch: "feature-y", source: "cli" } } },
    {
      props: {
        action: { verb: "opened_mr", refKind: "merge_request", ref: "#20", branch: "feature-y", source: "cli" },
      },
    },
  ]);

  for (const [mode, env] of bothModes) {
    it(`g1 ${mode}: earlier mapping feature-y → PR #20 → #20 edited·committed·pushed (observed), #7 discussed`, () => {
      if (env) vi.stubEnv("MEMBRAL_INFER_REF", env);
      expect(earlier).toEqual([{ branch: "feature-y", ref: "#20", refKind: "merge_request" }]);
      const turns = parse(steps, "feature-y");
      const rows = ground(turns, GH, [issue("#7", "What's the status of #7?", at(turns, "#7"))], {
        knownBranches: earlier,
        startBranch: "feature-y",
      });
      expect(ladder(row(rows, `${GH}#20`, "merge_request"))).toEqual(["pushed", null, "observed"]);
      expect(ladder(row(rows, `${GH}#7`))).toEqual([null, null, "discussed"]);
    });
  }

  it("g2: NO earlier mapping, model gives no span → guard: #7 not linked, commit unattributed", () => {
    vi.stubEnv("MEMBRAL_INFER_REF", "1");
    const turns = parse(steps, "feature-y");
    const rows = ground(turns, GH, [issue("#7", "What's the status of #7?", at(turns, "#7"))], {
      startBranch: "feature-y",
    });
    expect(ladder(row(rows, `${GH}#7`))).toEqual([null, null, "discussed"]);
    expect(rows.filter((r) => r.build_verb !== null)).toEqual([]);
  });

  it("g3: NO earlier mapping, model span ends at 'forget that' → #7 not linked", () => {
    vi.stubEnv("MEMBRAL_INFER_REF", "1");
    // Guard and span both block here; the span alone is isolated in b and e.
    const turns = parse(steps, "feature-y");
    const a = at(turns, "#7");
    const rows = ground(turns, GH, [issue("#7", "What's the status of #7?", a, { from_turn: a, to_turn: a + 1 })], {
      startBranch: "feature-y",
    });
    expect(ladder(row(rows, `${GH}#7`))).toEqual([null, null, "discussed"]);
  });

  it("guard's accepted false negative: 'For #41 …' / 'also make it bold' / commit on a pre-existing branch → unattributed", () => {
    vi.stubEnv("MEMBRAL_INFER_REF", "1");
    const s = (branch: string, pre: Step[] = []): Step[] => [
      { user: "For #41 fix the heading levels in docs/guide.md." },
      ...pre,
      { edit: "docs/guide.md" },
      { user: "also make it bold" },
      { edit: "docs/guide.md" },
      commit(branch, "8a8b8c8", "Fix heading levels"),
    ];
    const run = (steps: Step[], start: string) => {
      const turns = parse(steps, start);
      return row(
        ground(turns, GH, [issue("#41", "For #41 fix the heading", at(turns, "#41"))], { startBranch: start }),
        `${GH}#41`,
      );
    };
    expect(ladder(run(s("feature-y"), "feature-y"))).toEqual([null, null, "discussed"]);
    // The guard is not applied on the default branch, nor on a branch created in the session after the mention.
    expect(ladder(run(s("main"), "main"))).toEqual(["committed", null, "inferred_ref"]);
    const created = s("fix-41-headings", [
      { bash: "git checkout -b fix-41-headings", out: "Switched to a new branch 'fix-41-headings'" },
    ]);
    expect(ladder(run(created, "feature-y"))).toEqual(["committed", null, "inferred_ref"]);
  });
});
