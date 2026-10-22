// E2E runner A fixes, tested on TRIMMED REAL TRANSCRIPTS (fixtures/e2e-a-*.jsonl:
// the runner's Claude Code sessions on the fictional `codehub.example/acme/billing`,
// thinking blocks dropped, long text cut, local paths and names replaced) run
// through the core parser exactly as the CLI does.
//
//   D-053  a ref-less build action attaches to the ref the developer last named
//          in their own prose before it (S01, S05, S02, negative)
//   A-B2   one MR is one row: `host/o/r#N`, `o/r!N`, `o/r/-/merge_requests/N`
//   A-B3   a file name number (`review-17049.md`) is never an issue
//   S06    a sub-agent child is not a separate session on the Issues page
//   S22    `git checkout <MR source branch>` is checked_out only when observed
//   A-B7   review notes written, never committed, are not `edited`
//   B7     pulse blockers: one row per chain, last seen = the session's time
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeCodeParser } from "@membral/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { aggregateIssueAttribution, type SessionIssueRow, subAgentParents } from "@/lib/agent-stats/attribution";
import { buildProfile, type ProfileTurnInput } from "@/lib/code-sessions/profile";
import { canonicalItemRef, hasExplicitRefSyntax } from "@/lib/code-sessions/ref-canon";
import { itemKeyResolver, itemReadKey } from "@/lib/domain/ref-identity";
import { type GroundedSessionIssue, groundSessionIssues, qualifyIssueRef } from "@/lib/memory/extract";
import type { SessionIssueParsed } from "@/lib/memory/schema";
import { computeThreads, type ThreadIssueRow, type ThreadMemoryRow, type ThreadTurnRow } from "../open-threads";
import { collapseBlockerChains } from "../queries";

// D-055: D-053 inference is OFF unless MEMBRAL_INFER_REF is set; these tests cover it switched on.
beforeAll(() => {
  vi.stubEnv("MEMBRAL_INFER_REF", "1");
});
afterAll(() => {
  vi.unstubAllEnvs();
});

const PROJECT = "codehub.example/acme/billing";

interface Turn extends ProfileTurnInput {
  text: string | null;
  props: { toolUseId?: unknown; action?: unknown; actions?: unknown; inputDigest?: unknown };
}

function load(name: string): Turn[] {
  const raw = readFileSync(join(__dirname, "fixtures", `e2e-a-${name}.jsonl`), "utf8");
  const s = claudeCodeParser.parse({ source: "claude-code", sourceSessionId: name, path: "n/a" }, raw);
  return s.turns.map((t) => ({
    idx: t.idx,
    role: t.role,
    kind: t.kind,
    tool_name: t.toolName ?? null,
    file_path: t.filePath ?? null,
    text: t.text ?? null,
    props: { toolUseId: t.toolUseId, action: t.action, actions: t.actions, inputDigest: t.inputDigest },
  }));
}

function issue(
  ref: string,
  kind: SessionIssueParsed["kind"],
  evidence_quote: string,
  mentions?: SessionIssueParsed["mentions"],
): SessionIssueParsed {
  return mentions ? { ref, kind, evidence_quote, mentions } : { ref, kind, evidence_quote };
}

function ground(turns: Turn[], issues: SessionIssueParsed[]): GroundedSessionIssue[] {
  return groundSessionIssues(issues, turns, PROJECT, { actionsVersion: 1 });
}

const row = (rows: GroundedSessionIssue[], ref: string, kind = "issue") =>
  rows.find((r) => r.ref === ref && r.kind === kind);

function asThreadRows(sessionId: string, rows: GroundedSessionIssue[]): ThreadIssueRow[] {
  return rows.map((r) => ({
    session_id: sessionId,
    ref: r.ref,
    number: r.number,
    kind: r.kind,
    role: r.role,
    evidence_quote: r.evidence_quote,
    turn_idx: r.turn_idx,
    review_verb: r.review_verb,
    build_verb: r.build_verb,
    tier: r.tier,
    turn_share: r.turn_share,
    related_to: r.related_to,
  }));
}

function actionTurns(sessionId: string, turns: Turn[], ts: string): ThreadTurnRow[] {
  return turns
    .filter((t) => t.props.action || t.props.actions)
    .map((t) => ({ session_id: sessionId, idx: t.idx, ts, props: t.props as Record<string, unknown> }));
}

describe("D-053 — a ref-less build action attaches to the ref the developer last named", () => {
  it("S01: 'Issue #41 …' then 'commit it referencing #41, and push' → #41 edited·committed·pushed, inferred_ref, an open thread", () => {
    const turns = load("s01");
    // The extractor's quote for #41 came from the assistant's summary line — the
    // developer's own lines still name it, and only those attach the commit.
    const rows = ground(turns, [
      issue("#41", "issue", "committed with a message referencing #41", [
        { turn_idx: 0, quote: "Issue #41 on this repo" },
        { turn_idx: 23, quote: "commit it referencing #41" },
      ]),
    ]);
    const r = row(rows, `${PROJECT}#41`);
    expect(r).toMatchObject({ build_verb: "pushed", tier: "inferred_ref", role: "worked_on" });
    // v4: a link inferred from prose is no build evidence — the row stays, its share (cost) is 0.
    expect(r?.turn_share).toBe(0);
    const p = buildProfile(turns, { userRefs: [{ ref: `${PROJECT}#41`, refKind: "issue", idx: 0 }] });
    expect(p.refs[0].evidence.edited).toBeDefined(); // the edits at turns 15/20 count: a commit follows

    const res = computeThreads(
      {
        issues: asThreadRows("s01", rows),
        sessions: [
          {
            id: "s01",
            code_project_id: "p",
            started_at: "2026-09-26T20:00:00Z",
            git_branch: "41-running-locally",
            turn_count: 33,
            cost_usd: 0.1,
          },
        ],
        turns: actionTurns("s01", turns, "2026-09-26T20:05:00Z"),
      },
      { now: new Date("2026-09-27T08:00:00Z") },
    );
    expect(res.open.map((t) => [t.ref, t.refKind, t.inferred_ref])).toEqual([[`${PROJECT}#41`, "issue", true]]);
    // v4: inferred from prose is no build evidence — no share, no cost (the row and its verbs stay).
    expect(res.open[0].sessions[0]).toMatchObject({ tier: "inferred_ref", share: 0 });
    expect(res.open[0].sessions[0].cost_est ?? 0).toBe(0);
    expect(res.open[0].ladder.build_verb).toBe("pushed");
  });

  it("S05: two parallel sessions in one checkout — #51 and #53 each get their own commit (v3: observed from the subject)", () => {
    const a = ground(load("s05a"), [
      issue("#51", "issue", "For #51: add a one-line note about the CI badge", [{ turn_idx: 0, quote: "For #51" }]),
    ]);
    const e = ground(load("s05e"), [
      issue("#53", "issue", "For #53: fix the heading levels in docs/", [{ turn_idx: 0, quote: "For #53" }]),
    ]);
    // v3: each commit's own subject says `#51: …` / `#53: …` — an observed link, no inference needed.
    expect(a.map((r) => [r.ref, r.build_verb, r.tier])).toEqual([[`${PROJECT}#51`, "committed", "observed"]]);
    expect(e.map((r) => [r.ref, r.build_verb, r.tier])).toEqual([[`${PROJECT}#53`, "committed", "observed"]]);

    // Cost shares follow: each session's cost lands on its own ref, nothing unattributed.
    const sessions = [
      { id: "A", started_at: "2026-09-26T20:00:00Z", turn_count: 10, user_turn_count: 1, props: null },
      { id: "E", started_at: "2026-09-26T20:00:00Z", turn_count: 15, user_turn_count: 1, props: null },
    ];
    const rows: SessionIssueRow[] = [...asThreadRows("A", a), ...asThreadRows("E", e)] as SessionIssueRow[];
    const agg = aggregateIssueAttribution(sessions, [], rows);
    expect(agg.issues.map((i) => [i.issue, i.sessions, i.buildVerb, i.inferredRef])).toEqual([
      [`${PROJECT}#51`, 1, "committed", false],
      [`${PROJECT}#53`, 1, "committed", false],
    ]);
    expect(agg.unattributed.sessions).toBe(0);
  });

  it("S02: `git commit -q` after 'Fix the typo … for #42' → #42 committed", () => {
    const rows = ground(load("s02"), [
      issue("#42", "issue", "Fix the typo in the README intro for #42", [
        { turn_idx: 0, quote: "Fix the typo in the README intro for #42" },
      ]),
    ]);
    expect(row(rows, `${PROJECT}#42`)).toMatchObject({ build_verb: "committed", tier: "inferred_ref" });
  });

  it("negative: the developer names #5 only AFTER the commit → the commit stays unattributed", () => {
    const turns = load("s02").map((t) =>
      t.idx === 0
        ? { ...t, text: "Fix the typo in the README intro and commit it quietly with git commit -q." }
        : t.idx === 8
          ? { ...t, text: "that one was for #5 by the way, what's the last commit hash?" }
          : t,
    );
    const rows = ground(turns, [
      issue("#5", "issue", "that one was for #5 by the way", [{ turn_idx: 8, quote: "that one was for #5" }]),
    ]);
    expect(row(rows, `${PROJECT}#5`)).toMatchObject({ build_verb: null, tier: "discussed", role: "referenced" });
    expect(row(rows, `${PROJECT}#5`)?.turn_share).toBe(0);
  });

  it("an action naming its own ref wins over the prose (S22: comments stay on the MR they name)", () => {
    const rows = ground(load("s22"), [issue("#9", "issue", "what does issue #9 say?")]);
    expect(row(rows, `${PROJECT}#9`)).toMatchObject({ review_verb: "viewed", build_verb: null });
    expect(row(rows, `${PROJECT}#17300`, "merge_request")?.tier).toBe("observed");
  });
});

describe("A-B2 — one MR is one row", () => {
  it("every written form canonicalises to (merge_request, host/owner/repo#N)", () => {
    for (const w of [
      "codehub.example/acme/billing#17049",
      "acme/billing!17049",
      "acme/billing/-/merge_requests/17049",
      "https://codehub.example/acme/billing/-/merge_requests/17049",
      "!17049",
    ]) {
      expect(canonicalItemRef(w, PROJECT, "merge_request")).toEqual({
        ref: `${PROJECT}#17049`,
        number: 17049,
        kind: "merge_request",
      });
    }
    expect(qualifyIssueRef("acme/billing!17201", PROJECT, 17201)).toBe(`${PROJECT}#17201`);
    const key = itemKeyResolver([{ ref: `${PROJECT}#17`, kind: "merge_request" }]);
    expect(key("acme/billing/-/merge_requests/17", "merge_request")).toBe(key(`${PROJECT}#17`, "merge_request"));
    expect(itemReadKey(`${PROJECT}#17`, "issue")).not.toBe(itemReadKey(`${PROJECT}#17`, "merge_request"));
  });

  it("write time (S04): the extractor's `acme/billing!17100` and URL-path forms join the observed row", () => {
    const rows = ground(load("s04"), [
      issue(
        "acme/billing!17100",
        "merge_request",
        "here's the MR: https://codehub.example/acme/billing/-/merge_requests/17100",
      ),
      issue(
        "acme/billing/-/merge_requests/17100",
        "merge_request",
        "https://codehub.example/acme/billing/-/merge_requests/17100",
      ),
    ]);
    expect(rows.filter((r) => r.number === 17100).map((r) => [r.ref, r.kind, r.review_verb])).toEqual([
      [`${PROJECT}#17100`, "merge_request", "commented"],
    ]);
  });

  it("read time: rows already stored as three spellings (issues.json) show as one Issues row and one thread", () => {
    const stored: SessionIssueRow[] = [
      {
        session_id: "s",
        ref: `${PROJECT}#17049`,
        number: 17049,
        kind: "merge_request",
        role: "worked_on",
        review_verb: "reviewed",
        tier: "observed",
        turn_share: 1,
      },
      {
        session_id: "s",
        ref: "acme/billing/-/merge_requests/17049",
        number: 17049,
        kind: "merge_request",
        role: "discussed",
        tier: "discussed",
        turn_share: 0,
      },
      {
        session_id: "t",
        ref: "acme/billing!17049",
        number: 17049,
        kind: "merge_request",
        role: "discussed",
        tier: "discussed",
        turn_share: 0,
      },
    ];
    const sessions = ["s", "t"].map((id) => ({
      id,
      started_at: "2026-09-26T20:00:00Z",
      turn_count: 4,
      user_turn_count: 1,
      props: null,
    }));
    const agg = aggregateIssueAttribution(sessions, [], stored);
    expect(agg.issues.map((i) => [i.issue, i.kind, i.sessions, i.reviewVerb])).toEqual([
      // v4: the discussed-only (no verb) spellings are mentions (referenced), so one working session.
      [`${PROJECT}#17049`, "merge_request", 1, "reviewed"],
    ]);
    const res = computeThreads({
      issues: stored.map((r) => ({ ...r, evidence_quote: null, turn_idx: 0 })) as ThreadIssueRow[],
      sessions: sessions.map((s) => ({
        id: s.id,
        code_project_id: "p",
        started_at: s.started_at,
        git_branch: null,
        turn_count: 4,
        cost_usd: null,
      })),
    });
    expect(res.recent.map((t) => [t.ref, t.refKind])).toEqual([[`${PROJECT}#17049`, "merge_request"]]);
  });
});

describe("A-B3 — a number in a file name is not an issue", () => {
  it("S03: 'write your review notes into review-17049.md' yields no issue #17049", () => {
    const rows = ground(load("s03"), [
      issue("#17049", "issue", "write your review notes into review-17049.md"),
      issue("review-17049.md", "issue", "write your review notes into review-17049.md, don't post anything"),
    ]);
    expect(rows.filter((r) => r.kind === "issue")).toEqual([]);
    expect(rows.map((r) => [r.ref, r.kind])).toEqual([[`${PROJECT}#17049`, "merge_request"]]);
    expect(hasExplicitRefSyntax("review-17049.md", 17049)).toBe(false);
    expect(hasExplicitRefSyntax("see acme/billing!17049", 17049)).toBe(true);
  });
});

describe("A-B7 — review notes never committed are not `edited`", () => {
  it("S03 (git checkout of the branch, notes file written) is `reviewed`, no build rung — like its glab-checkout twin", () => {
    const r = row(ground(load("s03"), []), `${PROJECT}#17049`, "merge_request");
    expect(r).toMatchObject({ review_verb: "reviewed", build_verb: null });
  });
  it("S04 (paste, view, notes file, comment) is `commented`, no build rung", () => {
    const r = row(ground(load("s04"), []), `${PROJECT}#17100`, "merge_request");
    expect(r).toMatchObject({ review_verb: "commented", build_verb: null });
  });
});

describe("S22 — checkout of an MR's source branch", () => {
  type A = { verb?: string; ref?: string; branch?: string };
  const setBranch = (turns: Turn[], pick: (a: A) => boolean, branch: string | undefined): Turn[] =>
    turns.map((t) => {
      const a = t.props.action as A | undefined;
      if (!a || !pick(a)) return t;
      const { branch: _drop, ...rest } = a;
      return { ...t, props: { ...t.props, action: branch ? { ...rest, branch } : rest } };
    });

  it("is checked_out when the earlier `glab mr view` showed the source branch (real fixture: view idx 16, checkout idx 18)", () => {
    const turns = load("s22");
    expect(turns.find((t) => t.idx === 16)?.props.action).toMatchObject({
      verb: "viewed",
      ref: "!17301",
      branch: "17301-ledger-balance",
    });
    expect(turns.find((t) => t.idx === 18)?.props.action).toMatchObject({
      verb: "navigated",
      refKind: "branch",
      branch: "17301-ledger-balance",
    });
    const r = buildProfile(turns).refs.find((x) => x.ref === "!17301");
    expect(r?.evidence.checked_out).toEqual({ idx: 18 });
    expect(r?.review_verb).toBe("commented");
    // v4 B2/S3: `glab mr note` is no review command and nothing was committed there — no cost.
    expect(r?.turn_share ?? 0).toBe(0);
  });

  it("is not checked_out when no action on the MR showed its branch", () => {
    const turns = setBranch(load("s22"), (a) => a.ref === "!17301" && a.verb !== "navigated", undefined);
    const r = buildProfile(turns).refs.find((x) => x.ref === "!17301");
    expect(r?.review_verb).toBe("commented");
    expect(r?.evidence.checked_out).toBeUndefined();
  });

  it("is not checked_out when the branch is only shown AFTER the checkout (no back-fill)", () => {
    let turns = setBranch(load("s22"), (a) => a.verb === "viewed" && a.ref === "!17301", undefined);
    turns = setBranch(turns, (a) => a.verb === "commented" && a.ref === "!17301", "17301-ledger-balance");
    expect(turns.find((t) => t.idx === 28)?.props.action).toMatchObject({
      ref: "!17301",
      branch: "17301-ledger-balance",
    });
    const r = buildProfile(turns).refs.find((x) => x.ref === "!17301");
    expect(r?.review_verb).toBe("commented");
    expect(r?.evidence.checked_out).toBeUndefined();
  });
});

describe("S06 — a sub-agent child is not a separate session on the Issues page", () => {
  it("counts the child under its parent; the child's cost still counts once", () => {
    const sessions = [
      {
        id: "P",
        started_at: "2026-09-26T20:00:00Z",
        turn_count: 10,
        user_turn_count: 1,
        props: null,
        source: "claude-code",
        source_session_id: "c95b",
      },
      {
        id: "C",
        started_at: "2026-09-26T20:01:00Z",
        turn_count: 8,
        user_turn_count: 1,
        props: null,
        source: "claude-code",
        source_session_id: "c95b:agent-1",
        parent_source_session_id: "c95b",
      },
    ];
    const rows: SessionIssueRow[] = [
      {
        session_id: "P",
        ref: `${PROJECT}#61`,
        number: 61,
        kind: "issue",
        role: "discussed",
        tier: "discussed",
        turn_share: 0,
      },
      {
        session_id: "C",
        ref: `${PROJECT}#61`,
        number: 61,
        kind: "issue",
        role: "discussed",
        tier: "discussed",
        turn_share: 0,
      },
    ];
    const parentOf = subAgentParents(sessions);
    expect([...parentOf]).toEqual([["C", "P"]]);
    const agg = aggregateIssueAttribution(sessions, [], rows, { parentOf });
    // v4: no verb → referenced; the child still counts once, as its parent (one mention, not two).
    expect(agg.issues[0]).toMatchObject({ issue: `${PROJECT}#61`, sessions: 0, mentions: 1 });
    expect(agg.unattributed.sessions).toBe(1);
  });
});

describe("B7 on the pulse — recurring blockers, one row per chain", () => {
  const blockers: ThreadMemoryRow[] = [
    {
      id: "b1",
      kind: "blocker",
      ref: null,
      text: "npm test hangs on the FX-rates fixture download",
      quote: null,
      turn_role: "user",
      recurrence_count: 2,
      created_at: "2026-09-26T20:21:00Z",
      code_session_id: "s-3d",
    },
    {
      id: "b2",
      kind: "blocker",
      ref: null,
      text: "FX-rates fixture download causes npm test to hang.",
      quote: null,
      turn_role: "user",
      recurrence_count: 1,
      recurs_of: "b1",
      created_at: "2026-09-26T20:22:00Z",
      code_session_id: "s-2d",
    },
    {
      id: "b3",
      kind: "blocker",
      ref: null,
      text: "FX fixture download timeout in tests is blocking progress",
      quote: null,
      turn_role: "user",
      recurrence_count: 1,
      recurs_of: "b1",
      created_at: "2026-09-26T20:20:00Z",
      code_session_id: "s-1d",
    },
    {
      id: "b4",
      kind: "blocker",
      ref: null,
      text: "payment gateway sandbox key expired",
      quote: null,
      turn_role: "user",
      recurrence_count: 1,
      created_at: "2026-09-26T20:23:00Z",
      code_session_id: "s-now",
    },
  ];
  const sessionRows = [
    { id: "s-3d", started_at: "2026-09-23T10:00:00Z", ended_at: "2026-09-23T10:30:00Z" },
    { id: "s-2d", started_at: "2026-09-24T10:00:00Z", ended_at: null },
    { id: "s-1d", started_at: "2026-09-25T10:00:00Z", ended_at: "2026-09-25T11:00:00Z" },
    { id: "s-now", started_at: "2026-09-26T19:00:00Z", ended_at: "2026-09-26T19:10:00Z" },
  ];
  const fake = {
    from: () => ({
      select: () => ({
        eq: () => ({
          in: (_c: string, ids: string[]) =>
            Promise.resolve({ data: sessionRows.filter((s) => ids.includes(s.id)), error: null }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof collapseBlockerChains>[0];

  it("collapses the chain to one row seen 3×, last seen at the newest member's session end, sorted by count then that time", async () => {
    const live = await collapseBlockerChains(fake, "u", blockers);
    const res = computeThreads({ issues: [], sessions: [], memories: live });
    expect(res.recurring_blockers.map((b) => [b.id, b.recurrence_count, b.last_seen_at])).toEqual([
      ["b2", 3, "2026-09-25T11:00:00Z"],
      ["b4", 1, "2026-09-26T19:10:00Z"],
    ]);
  });
});

describe("D-053 on the dashboard", () => {
  it("an inferred_ref thread row says 'linked from your prompt'; an observed one does not", async () => {
    const { createElement } = await import("react");
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { ThreadsContent } = await import("@/app/(dashboard)/pulse/threads-content");
    // s02: `git commit -q` (no subject seen) after "… for #42" — still an inferred link.
    const turns = load("s02");
    const rows = ground(turns, [
      issue("#42", "issue", "Fix the typo in the README intro for #42", [
        { turn_idx: 0, quote: "Fix the typo in the README intro for #42" },
      ]),
    ]);
    const res = computeThreads(
      {
        issues: asThreadRows("A", rows),
        sessions: [
          {
            id: "A",
            code_project_id: "p",
            started_at: "2026-09-26T20:00:00Z",
            git_branch: "spike/unrelated",
            turn_count: 10,
            cost_usd: 0.02,
          },
        ],
        turns: actionTurns("A", turns, "2026-09-26T20:05:00Z"),
      },
      { now: new Date("2026-09-27T08:00:00Z") },
    );
    const html = renderToStaticMarkup(
      createElement(ThreadsContent, {
        recentThreads: res.recent,
        openThreads: res.open,
        recurringBlockers: [],
        statsLine: null,
        now: Date.parse("2026-09-27T08:00:00Z"),
      }),
    );
    expect(res.open).toHaveLength(1);
    expect(html).toContain('data-testid="inferred-ref"');
    expect(html).toContain("linked from your prompt");
    const observed = { ...res.open[0], inferred_ref: undefined };
    const plain = renderToStaticMarkup(
      createElement(ThreadsContent, {
        recentThreads: [],
        openThreads: [observed],
        recurringBlockers: [],
        statsLine: null,
      }),
    );
    expect(plain).not.toContain('data-testid="inferred-ref"');
  });
});
