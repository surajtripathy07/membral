// E2E run R (2026-09-27) fixes for open threads, from real rows of that run:
//   R-1 a thread's priority is only a flagged quote naming that ref (the You said block is gone, UX pass 2)
//   R-8 a closed-then-reopened issue with no commit is not an open thread
//   R-3 a sub-agent's own commit follows its parent's attribution (S06)
//   R-6 a title falling back to the ref never shows a local absolute path
import { describe, expect, it } from "vitest";
import {
  aggregateIssueAttribution,
  parseCommitEvents,
  type SessionIssueRow,
  subAgentParents,
} from "@/lib/agent-stats/attribution";
import { summaryPath } from "@/lib/code-sessions/summarize";
import { sessionDisplayTitle } from "@/lib/code-sessions/view";
import {
  computeThreads,
  displayRef,
  type ThreadIssueRow,
  type ThreadSessionRow,
  type ThreadTurnRow,
} from "../open-threads";

const NOW = new Date("2026-09-26T23:00:00Z");
const REF = "codehub.example/acme/billing#41";

const session = (id: string, started_at: string): ThreadSessionRow => ({
  id,
  code_project_id: "p1",
  started_at,
  git_branch: "main",
  turn_count: 20,
  parent_source_session_id: null,
  cost_usd: 1,
});
const row = (session_id: string, over: Partial<ThreadIssueRow> = {}): ThreadIssueRow => ({
  session_id,
  ref: REF,
  number: 41,
  kind: "issue",
  role: "worked_on",
  evidence_quote: "Issue #41 on this repo",
  turn_idx: 0,
  review_verb: null,
  build_verb: "committed",
  tier: "observed",
  turn_share: 1,
  related_to: [],
  ...over,
});
const turn = (session_id: string, idx: number, ts: string, action: Record<string, unknown>): ThreadTurnRow => ({
  session_id,
  idx,
  ts,
  props: { action },
});
const said = (
  id: string,
  quote: string,
  over: { kind?: string; ref?: string | null; priority?: boolean; turn_idx?: number; at?: string } = {},
) => ({
  id,
  kind: over.kind ?? "preference",
  ref: over.ref ?? null,
  ref_kind: over.ref ? "issue" : null,
  text: quote,
  quote,
  turn_role: "user",
  priority: over.priority ?? true,
  retired_at: null,
  created_at: over.at ?? "2026-09-26T22:30:39Z",
  code_session_id: "s1",
  turn_idx: over.turn_idx ?? 3,
});

describe("R-1: a thread's priority is a flagged quote on that ref", () => {
  it("ref-less or other-ref priorities and an unflagged instruction never become the thread's priority", () => {
    const res = computeThreads(
      {
        sessions: [session("s1", "2026-09-26T22:29:00Z")],
        issues: [row("s1")],
        memories: [
          // Real quotes from runs R (S01 t3, N07) and U16; the Hindi one is the same shape.
          said("friday", "the README fix has to land before Friday's demo", { kind: "decision", turn_idx: 3 }),
          said("prio", "first finish the README, that's the priority", { turn_idx: 5 }),
          said("de", "Issue #5 die wichtigste Priorität, das muss diese Woche fertig werden", {
            ref: "codehub.example/acme/billing#5",
            turn_idx: 13,
          }),
          said("hi", "इस हफ़्ते सबसे ज़रूरी काम README है", { turn_idx: 7 }),
          // Under prompt v15 "commit it referencing #41" is an instruction: no priority flag.
          said("instr", "commit it referencing #41", { ref: REF, priority: false, turn_idx: 9 }),
        ],
      },
      { now: NOW },
    );
    expect(res.recent[0].priority).toBeUndefined();
  });
});

describe("R-8: closing is not a build rung; a reopen only clears closure", () => {
  const REF6 = "github.com/codehub-org/audiobooks#6";
  const sessions = [session("s1", "2026-09-26T20:00:00Z"), session("s2", "2026-09-26T21:00:00Z")];

  it("U09: commented+closed #6, then reopened in a later session, no commit — not open", () => {
    const res = computeThreads(
      {
        sessions,
        issues: [
          row("s1", { ref: REF6, number: 6, review_verb: "commented", build_verb: "closed" }),
          row("s2", { ref: REF6, number: 6, review_verb: "commented", build_verb: null }),
        ],
        turns: [
          turn("s1", 4, "2026-09-26T20:01:00Z", { verb: "closed", ref: "#6", refKind: "issue", source: "cli" }),
          turn("s2", 2, "2026-09-26T21:01:00Z", { verb: "reopened", ref: "#6", refKind: "issue", source: "cli" }),
        ],
      },
      { now: NOW },
    );
    const t = res.recent.find((x) => x.ref === REF6);
    expect(t?.closure).toBeNull();
    expect(t?.open).toBe(false);
    expect(res.open).toHaveLength(0);
  });

  it("a commit, then a close, then a reopen: the commit keeps it open", () => {
    const res = computeThreads(
      {
        sessions,
        issues: [
          row("s1", { ref: REF6, number: 6, build_verb: "closed" }),
          row("s2", { ref: REF6, number: 6, review_verb: "commented", build_verb: null }),
        ],
        turns: [
          turn("s1", 3, "2026-09-26T20:00:30Z", { verb: "committed", sha: "abc1234", branch: "main", source: "cli" }),
          turn("s1", 4, "2026-09-26T20:01:00Z", { verb: "closed", ref: "#6", refKind: "issue", source: "cli" }),
          turn("s2", 2, "2026-09-26T21:01:00Z", { verb: "reopened", ref: "#6", refKind: "issue", source: "cli" }),
        ],
      },
      { now: NOW },
    );
    expect(res.open.map((t) => t.ref)).toEqual([REF6]);
  });
});

describe("R-6: a title falling back to the ref shows no local path", () => {
  it("a non-git project's ref keeps its last two path segments", () => {
    const ref = "/private/tmp/claude-501/x/scratchpad/e2e/R/cwd/notes#7";
    expect(displayRef(ref)).toBe("cwd/notes#7");
    expect(displayRef("codehub.example/acme/billing#42")).toBe("codehub.example/acme/billing#42");
    const res = computeThreads(
      { sessions: [session("s1", "2026-09-26T20:00:00Z")], issues: [row("s1", { ref, number: 7 })] },
      { now: NOW },
    );
    expect(res.recent[0].title).toBe("cwd/notes#7");
  });
});

describe("R-3 (superseded by attribution v3): a sub-agent's commit follows only its OWN rows", () => {
  it("the child's row only discusses #61 (from the parent's brief): its commit is unattributed, never the parent's #61", () => {
    const REF61 = "codehub.example/acme/billing#61";
    const sessions = [
      { id: "P", source: "claude-code", source_session_id: "p-src", parent_source_session_id: null },
      { id: "C", source: "claude-code", source_session_id: "p-src:agent-1", parent_source_session_id: "p-src" },
    ].map((s) => ({ ...s, started_at: "2026-09-26T22:33:00Z", turn_count: 10, user_turn_count: 1, props: {} }));
    const rows: SessionIssueRow[] = [
      {
        session_id: "P",
        ref: REF61,
        number: 61,
        kind: "issue",
        role: "worked_on",
        build_verb: "committed",
        tier: "inferred_ref",
        turn_share: 1,
      },
      { session_id: "C", ref: REF61, number: 61, kind: "issue", role: "discussed", tier: "discussed", turn_share: 0 },
    ];
    const commit = {
      sha: "5547b0e",
      observed: true,
      turnIdx: 12,
      message: "Add FAQ entry",
      subject: "Add FAQ entry",
      sessionId: "C",
      at: "2026-09-26T22:34:00Z",
      truncated: false,
    };
    const agg = aggregateIssueAttribution(sessions, [commit], rows, { parentOf: subAgentParents(sessions) });
    expect(agg.issues[0].issue).toBe(REF61);
    expect(agg.issues[0].commits).toEqual([]);
    expect(agg.unattributed.commits.map((c) => c.sha)).toEqual(["5547b0e"]);
    // Still counted once, as the parent's session (S06).
    expect(agg.unattributed.sessions).toBe(0);
  });
});

describe("R-6: session titles never carry an absolute local path", () => {
  it("summary paths are repo-relative, else the file name", () => {
    expect(summaryPath("/private/tmp/x/R/src/billing/docs/guide.md", "/private/tmp/x/R/src/billing")).toBe(
      "docs/guide.md",
    );
    expect(summaryPath("/private/tmp/x/elsewhere/notes.md", "/private/tmp/x/R/src/billing")).toBe("notes.md");
    expect(summaryPath("docs/guide.md", "/repo")).toBe("docs/guide.md");
  });

  it("a stored summary written before the fix shows file names", () => {
    const title = sessionDisplayTitle({
      title: null,
      summary:
        "Check the tests. Touched 2 files: /private/tmp/claude-501/x/R/src/billing/README.md, /private/tmp/y/a.md.",
    });
    expect(title).toBe("Check the tests. Touched 2 files: README.md, a.md.");
  });
});

describe("R-3/R-5: commit events come from observed actions in an action-aware session", () => {
  const bash = (session_id: string, idx: number, props: Record<string, unknown>) => ({
    session_id,
    idx,
    role: "assistant",
    kind: "tool_use",
    text: null,
    tool_name: "Bash",
    ts: "2026-09-26T22:38:21Z",
    props,
  });

  it("S10a: a failed `git commit -q` (no committed action) in an action-aware session is no commit", () => {
    const events = parseCommitEvents([bash("s10a", 4, { inputDigest: "git commit -q -m ‹text›" })], {
      actionAwareSessions: new Set(["s10a"]),
    });
    expect(events).toEqual([]);
  });

  it("an observed commit with no subject shows none — never the redacted command", () => {
    const events = parseCommitEvents([
      bash("s02b", 7, {
        inputDigest: "git commit -q -m ‹text›",
        action: { verb: "committed", source: "cli", refKind: "commit" },
      }),
    ]);
    expect(events.map((e) => [e.subject, e.message])).toEqual([["", ""]]);
  });

  it("a pre-W3 session (no actions_version) still reads its commit from the digest", () => {
    const events = parseCommitEvents([bash("old", 2, { inputDigest: 'git commit -m "Fix typo in README"' })]);
    expect(events.map((e) => e.subject)).toEqual(["Fix typo in README"]);
  });
});
