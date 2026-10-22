// e2e review fixes (2026-09-27): S1/S3 mentions from the extractor (D-053),
// S4 a view never outranks the developer's own naming, N1 a two-ref turn
// attaches nothing, S5 different forge hosts never collapse, N3 the later-
// resolution judge needs a structural touch, S2 non-owner "user" lines.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { itemKeyResolver } from "@/lib/domain/ref-identity";
import { computeThreads, type ThreadIssueRow } from "@/lib/threads/open-threads";
import { collectUserNamedRefs, evidenceTouchesBlocker, groundMentions, groundSessionIssues } from "../extract";
import { parseSessionIssues } from "../schema";

// D-055: D-053 inference is OFF unless MEMBRAL_INFER_REF is set; these tests cover it switched on.
beforeAll(() => {
  vi.stubEnv("MEMBRAL_INFER_REF", "1");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const P = "codehub.example/acme/billing";

type T = {
  idx: number;
  role: string;
  kind: string;
  text: string | null;
  tool_name?: string | null;
  file_path?: string | null;
  props: Record<string, unknown>;
};

function session() {
  let n = 0;
  const turns: T[] = [];
  const add = (t: Omit<T, "idx">) => {
    const turn = { idx: n++, ...t };
    turns.push(turn);
    return turn;
  };
  return {
    turns,
    U: (text: string, props: Record<string, unknown> = {}) => add({ role: "user", kind: "prose", text, props }),
    A: (text: string) => add({ role: "assistant", kind: "prose", text, props: {} }),
    EDIT: (file = "/r/README.md") =>
      add({
        role: "assistant",
        kind: "tool_use",
        tool_name: "Edit",
        file_path: file,
        text: null,
        props: { toolUseId: `e${n}` },
      }),
    BASH: (action: unknown) =>
      add({
        role: "assistant",
        kind: "tool_use",
        tool_name: "Bash",
        text: null,
        props: { toolUseId: `b${n}`, action },
      }),
  };
}
const commit = (sha: string) => ({ verb: "committed", refKind: "commit", ref: sha, sha, source: "cli", subject: "x" });
const view = (num: number) => ({ verb: "viewed", refKind: "issue", ref: `acme/billing#${num}`, source: "cli" });
const ground = (turns: T[], issues: unknown[]) =>
  groundSessionIssues(parseSessionIssues(issues), turns, P, { actionsVersion: 1 });
const byRef = (rows: ReturnType<typeof ground>, n: number) => rows.find((r) => r.number === n);

describe("S1/S3 — D-053 mentions come from the extractor, validated against user prose turns", () => {
  it("the assistant lists '#2 Add CI badge'; a mention pointing at that assistant line is rejected", () => {
    const s = session();
    s.U("Look at the open issues and propose options");
    const listing = s.A("Open: #2 Add CI badge, #5 Fix docs. Options: (1) small refactor (2) rewrite the loader");
    s.U("go with option #2, then commit");
    s.EDIT();
    s.BASH(commit("aaa1111"));
    const rows = ground(s.turns, [
      {
        ref: "#2",
        kind: "issue",
        evidence_quote: "go with option #2",
        mentions: [{ turn_idx: listing.idx, quote: "#2 Add CI badge" }],
      },
    ]);
    expect(byRef(rows, 2)).toMatchObject({ build_verb: null, tier: "discussed" });
  });

  it("the model may name no mention for 'go with option #2' — then nothing attaches", () => {
    const s = session();
    s.U("Look at the open issues and propose options");
    s.A("Open: #2 Add CI badge, #5 Fix docs. Options: (1) small refactor (2) rewrite the loader");
    s.U("go with option #2, then commit");
    s.EDIT();
    s.BASH(commit("aaa1111"));
    const rows = ground(s.turns, [{ ref: "#2", kind: "issue", evidence_quote: "go with option #2" }]);
    expect(byRef(rows, 2)).toMatchObject({ build_verb: null, tier: "discussed" });
  });

  it("no regex scan: a user line containing #34 is not a mention unless the extractor returns it (pasted text)", () => {
    const s = session();
    s.U("my manager wrote: 'PR #12 merged, issue #34 closed, thanks'. Anyway, bump the version and commit");
    s.EDIT();
    s.BASH(commit("f1"));
    const rows = ground(s.turns, [{ ref: "#34", kind: "issue", evidence_quote: "issue #34 closed", mentions: [] }]);
    expect(byRef(rows, 34)).toMatchObject({ build_verb: null, tier: "discussed" });
  });

  it("groundMentions: the quote must be in that turn, name the ref, and the turn must be owner prose", () => {
    const s = session();
    const u = s.U("For #41: fix the heading levels in docs.");
    const a = s.A("Working on #41 now.");
    const summary = s.U("Summary: the user asked about flaky test in #41", { nonOwner: "compact_summary" });
    const ref = { number: 41, kind: "issue" as const };
    expect(groundMentions([{ turn_idx: u.idx, quote: "For #41" }], ref, s.turns)).toEqual([u.idx]);
    expect(groundMentions([{ turn_idx: a.idx, quote: "Working on #41" }], ref, s.turns)).toEqual([]);
    expect(groundMentions([{ turn_idx: u.idx, quote: "for #41 please" }], ref, s.turns)).toEqual([]);
    expect(groundMentions([{ turn_idx: u.idx, quote: "fix the heading levels" }], ref, s.turns)).toEqual([]);
    expect(groundMentions([{ turn_idx: summary.idx, quote: "flaky test in #41" }], ref, s.turns)).toEqual([]);
    expect(groundMentions([{ turn_idx: "x", quote: 3 }], ref, s.turns)).toEqual([]);
  });

  it("mentions from several windows' entries for one ref are pooled", () => {
    const s = session();
    const a = s.U("For #41: fix heading");
    const b = s.U("still #41: and the footer");
    const out = collectUserNamedRefs(
      [
        { ref: `${P}#41`, number: 41, kind: "issue", mentions: [{ turn_idx: a.idx, quote: "For #41" }] },
        { ref: `${P}#41`, number: 41, kind: "issue", mentions: [{ turn_idx: b.idx, quote: "still #41" }] },
      ],
      s.turns,
    );
    expect(out.map((u) => u.idx)).toEqual([a.idx, b.idx]);
  });
});

describe("S4 — a tool view of another ref does not override the developer's own naming", () => {
  it("'For #41: fix heading' → gh issue view 12 → edit → commit: #41 committed (inferred_ref), #12 viewed", () => {
    const s = session();
    const u = s.U("For #41: fix the heading levels like #12 did it. Commit when done.");
    s.BASH(view(12));
    s.EDIT();
    s.BASH(commit("bbb2222"));
    const rows = ground(s.turns, [
      {
        ref: "#41",
        kind: "issue",
        evidence_quote: "For #41: fix the heading levels",
        mentions: [{ turn_idx: u.idx, quote: "For #41" }],
      },
    ]);
    expect(byRef(rows, 41)).toMatchObject({ build_verb: "committed", tier: "inferred_ref" });
    expect(byRef(rows, 12)).toMatchObject({ review_verb: "viewed", build_verb: null });
  });

  it("a view with no developer naming is never build focus: the ref-less commit lands nowhere", () => {
    const s = session();
    s.U("check the old issue and fix it");
    s.BASH(view(12));
    s.EDIT();
    s.BASH(commit("ccc3333"));
    const rows = ground(s.turns, []);
    // e2e (backfill Q2): only naming, an explicit-ref action, a checkout or lineage sets build focus.
    expect(byRef(rows, 12)).toMatchObject({ review_verb: "viewed", build_verb: null, tier: "observed" });
  });
});

describe("N1 — a turn naming two refs attaches nothing", () => {
  it("'For #41' → commit → 'now do #41 and #42 together' → commit: only the first commit lands on #41", () => {
    const s = session();
    const u1 = s.U("For #41 fix the heading.");
    s.EDIT();
    s.BASH(commit("c1"));
    const u2 = s.U("now do #41 and #42 together: bump deps");
    s.EDIT();
    s.BASH(commit("c2"));
    const rows = ground(s.turns, [
      {
        ref: "#41",
        kind: "issue",
        evidence_quote: "For #41 fix the heading",
        mentions: [
          { turn_idx: u1.idx, quote: "For #41" },
          { turn_idx: u2.idx, quote: "now do #41" },
        ],
      },
      {
        ref: "#42",
        kind: "issue",
        evidence_quote: "now do #41 and #42 together",
        mentions: [{ turn_idx: u2.idx, quote: "#42 together" }],
      },
    ]);
    expect(byRef(rows, 41)).toMatchObject({ build_verb: "committed", tier: "inferred_ref" });
    expect(byRef(rows, 42)?.build_verb).toBeNull();
  });
});

describe("S5 — different hosts never collapse", () => {
  it("github.com/acme/api#5 and gitlab.com/acme/api#5 are two keys; a host-less spelling joins only a single host", () => {
    const two = itemKeyResolver([
      { ref: "github.com/acme/api#5", kind: "issue" },
      { ref: "gitlab.com/acme/api#5", kind: "issue" },
      { ref: "acme/api#5", kind: "issue" },
    ]);
    expect(two("github.com/acme/api#5", "issue")).not.toBe(two("gitlab.com/acme/api#5", "issue"));
    expect(two("acme/api#5", "issue")).not.toBe(two("github.com/acme/api#5", "issue"));
    expect(two("acme/api#5", "issue")).not.toBe(two("gitlab.com/acme/api#5", "issue"));

    const one = itemKeyResolver([
      { ref: "github.com/acme/api#5", kind: "issue" },
      { ref: "acme/api!5", kind: "merge_request" },
      { ref: "acme/api#5", kind: "issue" },
    ]);
    expect(one("acme/api#5", "issue")).toBe(one("github.com/acme/api#5", "issue"));
    // Kind still separates: the MR has no hosted spelling and stays its own item.
    expect(one("acme/api!5", "merge_request")).not.toBe(one("acme/api#5", "issue"));
  });

  it("two threads; dismissing the github one keeps the gitlab one open", () => {
    const row = (session_id: string, ref: string): ThreadIssueRow => ({
      session_id,
      ref,
      number: 5,
      kind: "issue",
      role: "worked_on",
      evidence_quote: "x",
      turn_idx: 0,
      review_verb: null,
      build_verb: "committed",
      tier: "observed",
      turn_share: 1,
      related_to: [],
    });
    const sessions = ["s1", "s2"].map((id) => ({
      id,
      code_project_id: "p",
      started_at: "2026-09-26T20:00:00Z",
      git_branch: null,
      turn_count: 5,
      cost_usd: 0.1,
    }));
    const input = {
      issues: [row("s1", "github.com/acme/api#5"), row("s2", "gitlab.com/acme/api#5")],
      sessions,
      turns: [],
    };
    const now = { now: new Date("2026-09-27T08:00:00Z") };
    expect(
      computeThreads(input, now)
        .open.map((t) => t.ref)
        .sort(),
    ).toEqual(["github.com/acme/api#5", "gitlab.com/acme/api#5"]);
    const dismissed = computeThreads(
      {
        ...input,
        dismissals: [
          {
            ref: "github.com/acme/api#5",
            kind: "issue",
            reason: "resolved_elsewhere",
            created_at: "2026-09-27T07:00:00Z",
          },
        ],
      },
      now,
    );
    expect(dismissed.open.map((t) => t.ref)).toEqual(["gitlab.com/acme/api#5"]);
  });
});

describe("N3 — the later-resolution judge's evidence must touch the blocker's ref or paths", () => {
  const s = session();
  const ask = s.U("please apply the pending migration");
  s.BASH({ verb: "committed", refKind: "commit", ref: "abc1234", sha: "abc1234", source: "cli", subject: "x" });
  s.EDIT("/repo/apps/cloud/supabase/migrations/108_priority.sql");
  const claim = s.A("Migration applied on the local database.");
  s.U("thanks, now update the README badge");
  s.EDIT("/repo/README.md");
  const readmeClaim = s.A("README badge fixed and the migration question is closed.");

  it("a claim in the step that edited the blocker's path counts; one in an unrelated step does not", () => {
    const blocker = { paths: ["apps/cloud/supabase/migrations/108_priority.sql"], ref: null };
    expect(evidenceTouchesBlocker(claim.idx, blocker, s.turns)).toBe(true);
    expect(evidenceTouchesBlocker(ask.idx, blocker, s.turns)).toBe(true); // the user line's step includes the edit
    expect(evidenceTouchesBlocker(readmeClaim.idx, blocker, s.turns)).toBe(false);
  });

  it("an action naming the blocker's ref counts; a blocker with neither ref nor paths is never retired", () => {
    expect(evidenceTouchesBlocker(claim.idx, { ref: "abc1234", paths: null }, s.turns)).toBe(true);
    expect(evidenceTouchesBlocker(readmeClaim.idx, { ref: "abc1234", paths: null }, s.turns)).toBe(false);
    expect(evidenceTouchesBlocker(claim.idx, { ref: null, paths: null }, s.turns)).toBe(false);
  });
});
