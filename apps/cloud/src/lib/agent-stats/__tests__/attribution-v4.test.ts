// Attribution v4 — one synthetic test per driver finding (items 1, 2, 3-Today, 4, 5, 6, 7).
// Fictional GitHub repo `acme/billing` throughout.
import { claudeCodeParser, type RawCodeSession, type RawTurn } from "@membral/core";
import { describe, expect, it } from "vitest";
import { sessionHref } from "@/components/session-title-list";
import type { AgentStatsSessionInput } from "@/lib/agent-stats/aggregate";
import {
  aggregateIssueAttribution,
  type CommitEvent,
  mrBranchesBySession,
  type SessionIssueRow,
} from "@/lib/agent-stats/attribution";
import { nonGitSessionTitle } from "@/lib/code-sessions/import";
import {
  buildProfile,
  deriveRole,
  type ProfileTurnInput,
  type RefProfile,
  roleFromStoredVerbs,
  rowCarriesCost,
} from "@/lib/code-sessions/profile";
import { parseTurnParam } from "@/lib/code-sessions/queries";
import { sessionDisplayTitle, titleSourceText } from "@/lib/code-sessions/view";
import { computeThreads, type ThreadIssueRow, type ThreadSessionRow } from "@/lib/threads/open-threads";
import { yesterdayRows, yesterdayView } from "@/lib/threads/view";

// ---- transcript builders (the parser's real event shapes) ---------------------

const SID = "55555555-5555-4555-8555-555555555555";
let clock = 0;
const ts = () => {
  clock += 1;
  return `2026-09-26T09:${String(Math.floor(clock / 60) % 60).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}.000Z`;
};
const user = (text: string) => ({
  type: "user",
  message: { role: "user", content: text },
  cwd: "/home/dev/billing",
  gitBranch: "main",
  timestamp: ts(),
  sessionId: SID,
});
const assistant = (text: string) => ({
  type: "assistant",
  message: { id: `m${clock}`, role: "assistant", model: "codehub-model-1", content: [{ type: "text", text }] },
  timestamp: ts(),
  sessionId: SID,
});
let seq = 0;
function tool(name: string, input: Record<string, unknown>, result = "ok"): object[] {
  seq += 1;
  const id = `tu_v4_${seq}`;
  return [
    {
      type: "assistant",
      message: {
        id: `m_${id}`,
        role: "assistant",
        model: "codehub-model-1",
        content: [{ type: "tool_use", id, name, input }],
      },
      timestamp: ts(),
      sessionId: SID,
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: result }] },
      timestamp: ts(),
      sessionId: SID,
    },
  ];
}
const bash = (command: string, result = "") => tool("Bash", { command, description: "run" }, result);
const edit = (file_path: string) => tool("Edit", { file_path, old_string: "a", new_string: "b" });

function rows(events: object[]): ProfileTurnInput[] {
  const s: RawCodeSession = claudeCodeParser.parse(
    { source: "claude-code", sourceSessionId: SID, path: "n/a" },
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  return s.turns.map((t: RawTurn) => {
    const props: ProfileTurnInput["props"] = {};
    if (t.toolUseId) props.toolUseId = t.toolUseId;
    if (t.inputDigest) props.inputDigest = t.inputDigest;
    if (t.action) props.action = t.action;
    if (t.actions && t.actions.length > 0) props.actions = t.actions;
    return {
      idx: t.idx,
      role: t.role,
      kind: t.kind,
      tool_name: t.toolName ?? null,
      file_path: t.filePath ?? null,
      props,
    };
  });
}
const OPTS = { projectRepo: "acme/billing", projectHost: "github.com", projectIsForgeRepo: true };
const ref = (p: { refs: RefProfile[] }, r: string) => {
  const f = p.refs.find((x) => x.ref.endsWith(r));
  if (!f) throw new Error(`no ${r} in ${p.refs.map((x) => x.ref).join(", ")}`);
  return f;
};

// ---- item 1: cost only through build evidence ---------------------------------

describe("v4 item 1: a triage sweep keeps its verbs but carries no cost", () => {
  const sweep = [
    user("refocus: close what the new plan made obsolete"),
    ...bash("gh issue comment 31 -R acme/billing -b 'superseded'", "https://github.com/acme/billing/issues/31#c1"),
    ...bash("gh issue close 31 -R acme/billing", "✓ Closed issue acme/billing#31"),
    assistant("31 closed. Next 139."),
    ...bash("gh issue close 139 -R acme/billing", "✓ Closed issue acme/billing#139"),
    ...bash("gh issue edit 22 -R acme/billing --add-label later", "https://github.com/acme/billing/issues/22"),
    assistant("Done with the sweep."),
  ];

  it("closed / commented / triaged items: rows with their verbs, share 0", () => {
    const p = buildProfile(rows(sweep), OPTS);
    expect(ref(p, "#31")).toMatchObject({ review_verb: "commented", build_verb: "closed", turn_share: 0 });
    expect(ref(p, "#139")).toMatchObject({ build_verb: "closed", turn_share: 0 });
    expect(ref(p, "#22")).toMatchObject({ triaged: true, turn_share: 0 });
    expect(deriveRole(ref(p, "#22"))).toBe("referenced");
    expect(p.refs.reduce((s, r) => s + r.turn_share, 0)).toBe(0);
  });

  it("a PR built on its own branch carries the session's share; the issue closed after it does not", () => {
    const build = [
      user("finish the ledger PR"),
      ...bash("gh pr checkout 12 -R acme/billing", "Switched to branch 'fix-ledger'"),
      ...edit("/home/dev/billing/src/ledger.ts"),
      ...bash("git commit -am 'fix ledger rounding'", "[fix-ledger aaa1111] fix ledger rounding\n 1 file changed"),
      ...bash("git push", "To github.com:acme/billing.git\n   0000000..aaa1111  fix-ledger -> fix-ledger"),
      ...bash("gh issue close 31 -R acme/billing", "✓ Closed issue acme/billing#31"),
    ];
    const p = buildProfile(rows(build), OPTS);
    const pr = p.refs.find((r) => r.refKind === "merge_request");
    expect(pr?.build_verb).toBe("pushed");
    expect(pr?.turn_share).toBeGreaterThan(0.5);
    const issue = p.refs.find((r) => r.refKind === "issue");
    expect(issue).toMatchObject({ build_verb: "closed", turn_share: 0 });
  });

  it("read time: a stored pre-v4 comment/triage row keeps its verbs and carries no cost", () => {
    expect(rowCarriesCost({ kind: "issue", review_verb: "commented", build_verb: null, tier: "observed" })).toBe(false);
    expect(rowCarriesCost({ kind: "issue", review_verb: null, build_verb: "edited", tier: "observed" })).toBe(false);
    expect(rowCarriesCost({ kind: "issue", review_verb: null, build_verb: "committed", tier: "inferred_ref" })).toBe(
      false,
    );
    // v4 B2: a derived `reviewed` never prices; an approval does.
    expect(rowCarriesCost({ kind: "merge_request", review_verb: "reviewed", build_verb: null, tier: "observed" })).toBe(
      false,
    );
    expect(rowCarriesCost({ kind: "merge_request", review_verb: "approved", build_verb: null, tier: "observed" })).toBe(
      true,
    );
    // v4 B1: cost only from PR/branch evidence — an issue row never prices; an MR build row does.
    expect(rowCarriesCost({ kind: "issue", review_verb: null, build_verb: "pushed", tier: "observed" })).toBe(false);
    expect(rowCarriesCost({ kind: "merge_request", review_verb: null, build_verb: "pushed", tier: "observed" })).toBe(
      true,
    );
    const session: AgentStatsSessionInput = {
      id: "s1",
      started_at: "2026-09-26T10:00:00Z",
      turn_count: 10,
      user_turn_count: 2,
      props: {
        usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
        models: ["claude-sonnet-5"],
      },
    };
    const stored: SessionIssueRow[] = [
      {
        session_id: "s1",
        ref: "github.com/acme/billing#31",
        number: 31,
        kind: "issue",
        role: "worked_on",
        review_verb: "commented",
        tier: "observed",
        turn_share: 0.6,
      },
    ];
    const agg = aggregateIssueAttribution([session], [], stored);
    expect(agg.issues[0]).toMatchObject({ reviewVerb: "commented", costUsd: null });
  });
});

// ---- item 2: commits listed only under the item they are tied to --------------

describe("v4 item 2: the Commits column lists only commits tied to that item", () => {
  const session: AgentStatsSessionInput = {
    id: "s1",
    started_at: "2026-09-26T10:00:00Z",
    turn_count: 10,
    user_turn_count: 2,
    props: null,
  };
  const commit = (o: Partial<CommitEvent>): CommitEvent => ({
    sha: null,
    observed: true,
    turnIdx: 1,
    message: "",
    subject: "",
    sessionId: "s1",
    at: "2026-09-26T10:01:00Z",
    truncated: false,
    ...o,
  });
  const row = (n: number, kind: "issue" | "merge_request" = "issue"): SessionIssueRow => ({
    session_id: "s1",
    ref: `github.com/acme/billing#${n}`,
    number: n,
    kind,
    role: "worked_on",
    build_verb: kind === "issue" ? "closed" : "pushed",
    tier: "observed",
    turn_share: 0,
  });

  it("a subject naming #116 lists under #116 only; a lineage commit under its PR; placeholders fold into a count", () => {
    const commits = [
      commit({ sha: "d367e50", subject: "#116 filed for the follow-up" }),
      commit({ sha: "aaa1111", subject: "fix ledger rounding", branch: "fix-ledger" }),
      commit({ sha: null, subject: "", branch: "fix-ledger" }),
      commit({ sha: null, subject: "" }),
    ];
    const turns = [
      {
        session_id: "s1",
        idx: 0,
        role: "assistant",
        kind: "tool_use",
        text: null,
        tool_name: "Bash",
        ts: null,
        props: {
          action: {
            verb: "checked_out",
            ref: "github.com/acme/billing!12",
            refKind: "merge_request",
            branch: "fix-ledger",
            source: "cli",
          },
        },
      },
    ];
    const agg = aggregateIssueAttribution(
      [session],
      commits,
      [row(115), row(116), row(120), row(12, "merge_request")],
      {
        mrBranches: mrBranchesBySession(turns),
        projectOf: new Map([["s1", "github.com/acme/billing"]]),
      },
    );
    const by = Object.fromEntries(agg.issues.map((i) => [`${i.kind}:${i.issue}`, i]));
    expect(by["issue:github.com/acme/billing#116"].commits.map((c) => c.sha)).toEqual(["d367e50"]);
    expect(by["issue:github.com/acme/billing#115"].commits).toEqual([]);
    expect(by["issue:github.com/acme/billing#120"].commits).toEqual([]);
    const pr = by["merge_request:github.com/acme/billing#12"];
    expect(pr.commits.map((c) => c.sha)).toEqual(["aaa1111"]);
    expect(pr.untitledCommits).toBe(1);
    for (const i of agg.issues) for (const c of i.commits) expect(c.subject || c.sha).toBeTruthy();
  });
});

// ---- item 3 (Today) + item 5: window verbs and action-turn dates ---------------

describe("v4 items 3 + 5: Today dates rows by the action turn and shows only the window's verbs", () => {
  const REF = "github.com/acme/billing#52";
  const sessions: ThreadSessionRow[] = [
    {
      id: "old",
      code_project_id: "p",
      started_at: "2026-09-20T09:00:00Z",
      git_branch: "x",
      turn_count: 10,
      cost_usd: 5,
    },
    {
      id: "long",
      code_project_id: "p",
      started_at: "2026-09-24T09:00:00Z",
      git_branch: "main",
      turn_count: 900,
      cost_usd: 9,
    },
  ];
  const issues: ThreadIssueRow[] = [
    {
      session_id: "old",
      ref: REF,
      number: 52,
      kind: "merge_request",
      role: "worked_on",
      evidence_quote: "x",
      turn_idx: 3,
      review_verb: "checked_out",
      build_verb: "opened_mr",
      tier: "observed",
      turn_share: 1,
    },
    {
      session_id: "long",
      ref: REF,
      number: 52,
      kind: "merge_request",
      role: "referenced",
      evidence_quote: "y",
      turn_idx: 843,
      review_verb: "viewed",
      build_verb: null,
      tier: "observed",
      turn_share: 0,
    },
  ];
  const now = Date.parse("2026-09-27T08:00:00Z");
  // UX pass 2: Yesterday is the previous calendar day, so the day section is viewed from the 28th.
  const nextDay = now + 86_400_000;
  const res = computeThreads(
    { issues, sessions, turnTimes: [{ session_id: "long", idx: 843, ts: "2026-09-27T06:26:32Z" }] },
    { now: new Date(now) },
  );

  it("the long session's row is dated by turn 843, not by its 24 Sept start", () => {
    const t = res.recent.find((x) => x.ref === REF);
    expect(t?.sessions.find((s) => s.id === "long")?.at).toBe("2026-09-27T06:26:32Z");
    expect(t?.last_seen_at).toBe("2026-09-27T06:26:32Z");
  });

  it("Yesterday shows the row (its action is in the window) with only the window's verb", () => {
    const shown = yesterdayRows(res.recent, nextDay);
    expect(shown).toHaveLength(1);
    expect(shown[0].ladder).toMatchObject({ review_verb: "viewed", build_verb: null });
    expect(shown[0].sessions.map((s) => s.id)).toEqual(["long"]);
    // The whole thread still carries the older session's verbs.
    const t = res.recent.find((x) => x.ref === REF);
    if (!t) throw new Error("no thread");
    expect(t.ladder.build_verb).toBe("opened_mr");
    expect(yesterdayView(t, nextDay).ladder.build_verb).toBeNull();
  });
});

// ---- item 4: titles skip harness-injected context ------------------------------

describe("v4 item 4: titles and owner prose skip harness-injected context", () => {
  const CARD =
    "## About this user\n\nThe owner likes tea.\n\n## Code projects\n\n- acme/billing\n\nUser's message:\nfix the ledger rounding";
  it("a card prompt titles the session by the owner's own line (import and read-time fallback)", () => {
    expect(
      nonGitSessionTitle({
        repo: { path: "/home/dev/ws" },
        turns: [{ idx: 0, role: "user", kind: "prose", text: CARD, ts: "" }],
      } as never),
    ).toBe("fix the ledger rounding");
    expect(sessionDisplayTitle({ title: null, summary: null, firstUserMessage: titleSourceText(CARD) })).toBe(
      "fix the ledger rounding",
    );
  });
  it("review B3: an owner who types the heading keeps it as the title (heading alone is never stripped)", () => {
    expect(titleSourceText("## About this user\nI prefer pnpm")).toBe("## About this user\nI prefer pnpm");
    expect(titleSourceText("why does <system-reminder> show up? fix #12")).toBe(
      "why does <system-reminder> show up? fix #12",
    );
  });
  it("a system-reminder block never reaches a title", () => {
    expect(titleSourceText("<system-reminder>open threads: #5</system-reminder>\nship #12").trim()).toBe("ship #12");
  });
});

// ---- item 6: anchors past the default window resolve --------------------------

describe("v4 item 6: a turn link asks the session page for the window around it", () => {
  it("sessionHref carries ?turn=N beside #turn-N; the page parses it", () => {
    expect(sessionHref("abc", 843)).toBe("/code/session/abc?turn=843#turn-843");
    expect(sessionHref("abc")).toBe("/code/session/abc");
    expect(parseTurnParam("843")).toBe(843);
    expect(parseTurnParam("-1")).toBeNull();
    expect(parseTurnParam("8x")).toBeNull();
    expect(parseTurnParam(undefined)).toBeNull();
  });
});

// ---- item 7: role from observed verbs only ------------------------------------

describe("v4 item 7: a row's role comes from its verbs", () => {
  it("no verb → referenced; a worked_on the verbs do not reach → discussed", () => {
    expect(roleFromStoredVerbs({ role: "worked_on", review_verb: null, build_verb: null })).toBe("referenced");
    expect(roleFromStoredVerbs({ role: "worked_on", review_verb: "viewed", build_verb: null })).toBe("discussed");
    expect(roleFromStoredVerbs({ role: "discussed", review_verb: null, build_verb: "committed" })).toBe("worked_on");
  });
  it("the Issues page never shows an old model-pass `worked on` with no verbs", () => {
    const s: AgentStatsSessionInput = {
      id: "s1",
      started_at: "2026-09-01T10:00:00Z",
      turn_count: 4,
      user_turn_count: 1,
      props: null,
    };
    const agg = aggregateIssueAttribution(
      [s],
      [],
      [
        {
          session_id: "s1",
          ref: "github.com/acme/billing#13",
          number: 13,
          kind: "issue",
          role: "worked_on",
          tier: "inferred",
          turn_share: null,
        },
      ],
    );
    expect(agg.issues[0]).toMatchObject({
      role: "referenced",
      reviewVerb: null,
      buildVerb: null,
      sessions: 0,
      mentions: 1,
    });
  });
});

// ---- review v4 (driver decisions B1, B2, S3, B4, S1, S4; B3 is in core + the title test) ----

describe("review v4 B1: cost needs the branch↔PR pairing — a paste or slash line only labels", () => {
  const mainCommit = [
    ...edit("/home/dev/billing/src/ledger.ts"),
    ...bash("git commit -am 'fix ledger rounding'", "[main bbb2222] fix ledger rounding\n 1 file changed"),
    ...bash("git push", "To github.com:acme/billing.git\n   aaa1111..bbb2222  main -> main"),
  ];
  it("pasted issue URL + commit/push on main → the issue is labelled, share 0", () => {
    const p = buildProfile(
      rows([user("look at https://github.com/acme/billing/issues/12 and fix it"), ...mainCommit]),
      OPTS,
    );
    expect(ref(p, "#12")).toMatchObject({ build_verb: "pushed", turn_share: 0 });
  });
  it("a slash line naming #12 + a commit on main → share 0", () => {
    const slash = user(
      "<command-name>/fix-issue</command-name>\n<command-message>fix-issue</command-message>\n<command-args>https://github.com/acme/billing/issues/12</command-args>",
    );
    const p = buildProfile(rows([slash, ...mainCommit]), OPTS);
    expect(p.refs.every((r) => r.turn_share === 0)).toBe(true);
  });
  it("a PR checkout, then a commit and push on its branch → the PR carries the share", () => {
    const p = buildProfile(
      rows([
        ...bash("gh pr checkout 50 -R acme/billing", "Switched to branch 'fix-50'"),
        ...bash("git commit -am 'address review'", "[fix-50 ccc3333] address review\n 1 file changed"),
        ...bash("git push", "To github.com:acme/billing.git\n   bbb2222..ccc3333  fix-50 -> fix-50"),
      ]),
      OPTS,
    );
    const pr = p.refs.find((r) => r.refKind === "merge_request");
    expect(pr?.turn_share).toBeGreaterThan(0.5);
  });
});

describe("review v4 B2 + S3: only a review command prices a PR; view + reads, or a comment ping, never do", () => {
  const read = (file_path: string) => tool("Read", { file_path }, "1\tx");
  it("paste a PR, view it, pivot to main: the PR is `reviewed` by derivation but carries no share", () => {
    const p = buildProfile(
      rows([
        user("what is the state of https://github.com/acme/billing/pull/50 ?"),
        ...bash("gh pr view 50 -R acme/billing", "state: OPEN"),
        user("ok forget it, lets refactor the ledger module on main"),
        ...read("/home/dev/billing/src/a.ts"),
        ...read("/home/dev/billing/src/b.ts"),
        ...edit("/home/dev/billing/src/a.ts"),
        ...bash("git commit -am 'refactor'", "[main ddd4444] refactor\n 1 file changed"),
      ]),
      OPTS,
    );
    for (const r of p.refs.filter((x) => x.refKind === "merge_request")) expect(r.turn_share).toBe(0);
  });
  it("`gh pr comment` is a ping (share 0); `gh pr review --comment` is a review (share > 0)", () => {
    const ping = buildProfile(
      rows([
        ...bash(
          "gh pr comment 50 -R acme/billing -b 'any update?'",
          "https://github.com/acme/billing/pull/50#issuecomment-1",
        ),
        user("now refactor on main"),
        ...read("/home/dev/billing/src/a.ts"),
      ]),
      OPTS,
    );
    expect(ping.refs[0]).toMatchObject({ review_verb: "commented", turn_share: 0 });
    const review = buildProfile(
      rows([
        ...bash(
          "gh pr review 50 -R acme/billing --comment -b 'nit: rename'",
          "- Reviewed pull request acme/billing#50",
        ),
      ]),
      OPTS,
    );
    expect(review.refs[0].review_verb).toBe("commented");
    expect(review.refs[0].turn_share).toBeGreaterThan(0);
  });
});

describe("review v4 B4: off GitHub the subject's sigil decides the kind", () => {
  it("'closes #12' on a CodeHub repo lists under issue #12 only, never MR !12", () => {
    const s: AgentStatsSessionInput = {
      id: "s1",
      started_at: "2026-09-26T10:00:00Z",
      turn_count: 4,
      user_turn_count: 1,
      props: null,
    };
    const rowsIn: SessionIssueRow[] = (["issue", "merge_request"] as const).map((kind) => ({
      session_id: "s1",
      ref: "codehub.example/acme/billing#12",
      number: 12,
      kind,
      role: "worked_on",
      build_verb: "committed",
      tier: "observed",
      turn_share: 0,
    }));
    const c: CommitEvent = {
      sha: "eee5555",
      observed: true,
      turnIdx: 1,
      message: "",
      subject: "fix ledger, closes #12",
      sessionId: "s1",
      at: "2026-09-26T10:01:00Z",
      truncated: false,
    };
    const agg = aggregateIssueAttribution([s], [c], rowsIn, {
      projectOf: new Map([["s1", "codehub.example/acme/billing"]]),
    });
    expect(agg.issues.find((i) => i.kind === "issue")?.commits.map((x) => x.sha)).toEqual(["eee5555"]);
    expect(agg.issues.find((i) => i.kind === "merge_request")?.commits).toEqual([]);
  });
});

describe("review v4 S1: Yesterday ladders by each action's own turn", () => {
  const REF = "github.com/acme/billing#60";
  const sessions: ThreadSessionRow[] = [
    {
      id: "L",
      code_project_id: "p",
      started_at: "2026-09-24T09:00:00Z",
      git_branch: "main",
      turn_count: 900,
      cost_usd: 9,
    },
  ];
  const now = Date.parse("2026-09-27T08:00:00Z");
  // UX pass 2: Yesterday is the previous calendar day, so the day section is viewed from the 28th.
  const nextDay = now + 86_400_000;
  const row = (turn_idx: number): ThreadIssueRow => ({
    session_id: "L",
    ref: REF,
    number: 60,
    kind: "merge_request",
    role: "worked_on",
    evidence_quote: "x",
    turn_idx,
    review_verb: "viewed",
    build_verb: "opened_mr",
    tier: "observed",
    turn_share: 1,
  });
  const act = (idx: number, ts: string, verb: string) => ({
    session_id: "L",
    idx,
    ts,
    props: { action: { verb, ref: "acme/billing!60", refKind: "merge_request", source: "cli" } },
  });
  it("MR opened on the 24th, viewed yesterday → Yesterday says `viewed` only", () => {
    const res = computeThreads(
      {
        issues: [row(800)],
        sessions,
        turns: [act(10, "2026-09-24T10:00:00Z", "opened_mr"), act(800, "2026-09-27T06:00:00Z", "viewed")],
      },
      { now: new Date(now) },
    );
    const [y] = yesterdayRows(res.recent, nextDay);
    expect(y.ladder).toMatchObject({ review_verb: "viewed", build_verb: null });
  });
  it("viewed on the 24th, MR opened yesterday → Yesterday keeps the MR open action", () => {
    const res = computeThreads(
      {
        issues: [row(10)],
        sessions,
        turns: [act(10, "2026-09-24T10:00:00Z", "viewed"), act(800, "2026-09-27T06:00:00Z", "opened_mr")],
      },
      { now: new Date(now) },
    );
    const [y] = yesterdayRows(res.recent, nextDay);
    expect(y.ladder).toMatchObject({ review_verb: null, build_verb: "opened_mr" });
  });
});

describe("UX pass 2: a ?turn=N load renders a bounded window [N-15, N+50]", () => {
  it("turnWindow: near 0, middle, near the end", async () => {
    const { turnWindow } = await import("@/lib/code-sessions/queries");
    expect(turnWindow(5)).toEqual({ from: 0, to: 55 });
    expect(turnWindow(111)).toEqual({ from: 96, to: 161 });
    // Never clamped above by turn_count (review r2 S6): the rows decide what exists.
    expect(turnWindow(1120)).toEqual({ from: 1105, to: 1170 });
    expect(turnWindow(0)).toEqual({ from: 0, to: 50 });
  });
});
