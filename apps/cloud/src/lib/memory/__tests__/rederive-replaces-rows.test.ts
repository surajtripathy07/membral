// Goal 2026-09-27 (re-derive replaces rows): a session's code_session_issues
// rows always equal what the current code derives from its turns. A re-upload
// that changes the actions (its own, or a sub-agent's) without adding a turn
// must retire the rows the old actions produced, and tier `observed` (with its
// verbs) only ever comes from a parsed action with a known repo — never from
// the extractor, never from an elided tool result.

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { foldDiscussedKinds } from "@/lib/domain/ref-identity";
import { groundSessionIssues } from "../extract";
import { rederiveStoredSessionIssues, runTailCaptureForSession } from "../tail-capture";

const USER = "u1";
const PROJECT = "github.com/acme/app";
const project = { display_name: "app", repo_identity: PROJECT };

const view = (ref: string, refKind: "issue" | "merge_request" = "issue") => ({
  ref,
  verb: "viewed",
  source: "cli",
  refKind,
});

function turn(sessionId: string, idx: number, t: Partial<Row>): Row {
  return {
    session_id: sessionId,
    user_id: USER,
    idx,
    role: "assistant",
    kind: "prose",
    text: null,
    tool_name: null,
    file_path: null,
    props: {},
    ...t,
  };
}

function issueRow(sessionId: string, r: Partial<Row>): Row {
  return {
    id: `${sessionId}:${r.ref}:${r.kind ?? "issue"}`,
    session_id: sessionId,
    user_id: USER,
    kind: "issue",
    role: "discussed",
    turn_idx: 0,
    review_verb: null,
    build_verb: null,
    tier: "discussed",
    turn_share: 0,
    related_to: [],
    created_at: "2026-09-26T10:00:00.000Z",
    ...r,
  };
}

const rowsOf = (tables: Record<string, Row[]>, sessionId: string) =>
  tables.code_session_issues
    .filter((r) => r.session_id === sessionId)
    .map((r) => `${r.ref}|${r.kind}|${r.tier}|${r.review_verb ?? ""}|${r.build_verb ?? ""}`)
    .sort();

describe("re-extracting a session after its actions change retires the stale rows", () => {
  function fixture() {
    const tables: Record<string, Row[]> = {
      code_sessions: [
        {
          id: "s1",
          user_id: USER,
          source: "claude-code",
          source_session_id: "src-s1",
          parent_source_session_id: null,
          code_project_id: "p1",
          git_branch: "main",
          props: { actions_version: 1, memory_checkpoint_turn_idx: 2 },
          code_projects: project,
        },
      ],
      code_session_turns: [
        turn("s1", 0, { role: "user", text: "look at #9 before lunch" }),
        // Re-uploaded: the view now carries the repo the command named (-R other/lib).
        turn("s1", 1, { kind: "tool_use", tool_name: "Bash", props: { toolUseId: "t1", action: view("other/lib#7") } }),
        turn("s1", 2, {
          role: "user",
          kind: "tool_result",
          text: "[tool_result elided: ok]",
          props: { toolUseId: "t1" },
        }),
      ],
      code_session_issues: [
        // Written by an earlier parse that filed the bare #7 under the session's own project.
        issueRow("s1", {
          ref: `${PROJECT}#7`,
          number: 7,
          role: "referenced",
          tier: "observed",
          review_verb: "viewed",
          turn_idx: 2,
          evidence_quote: "[tool_result elided: ok]",
        }),
        // The owner's own line naming #9: still grounds, so it stays (created_at untouched).
        // v4 item 7: stored with the role its verbs give (none → referenced), so it is upserted in place.
        issueRow("s1", {
          ref: `${PROJECT}#9`,
          number: 9,
          role: "referenced",
          evidence_quote: "look at #9 before lunch",
        }),
        // A model row whose receipt is gone from the transcript: no longer derived.
        issueRow("s1", { ref: `${PROJECT}#4`, number: 4, evidence_quote: "closed #4 yesterday" }),
      ],
    };
    return tables;
  }

  it("a run with no new turns re-derives: the stale observed row and the ungrounded model row go, the owner's line stays", async () => {
    const tables = fixture();
    const supabase = makeFakeSupabase(tables);
    // biome-ignore lint/suspicious/noExplicitAny: no LLM is reached on a run with no new turns
    const summary = await runTailCaptureForSession({ supabase, llm: {} as any }, USER, "s1", { runId: "r1" });
    expect(summary.skipped).toBe(true);
    expect(rowsOf(tables, "s1")).toEqual([`${PROJECT}#9|issue|discussed||`, "other/lib#7|issue|observed|viewed|"]);
    const kept = tables.code_session_issues.find((r) => r.ref === `${PROJECT}#9`);
    expect(kept?.created_at).toBe("2026-09-26T10:00:00.000Z");
    const seven = tables.code_session_issues.find((r) => r.ref === "other/lib#7");
    expect(seven?.evidence_quote).not.toMatch(/elided/);
  });

  it("S2: the re-derive takes the extraction lock and releases it", async () => {
    const tables = fixture();
    const supabase = makeFakeSupabase(tables);
    await rederiveStoredSessionIssues(supabase, USER, "s1");
    expect(rowsOf(tables, "s1")).toContain("other/lib#7|issue|observed|viewed|");
    expect(tables.code_sessions[0].props.memory_extraction_lock).toBeUndefined();
  });

  it("re-deriving twice is a fixed point", async () => {
    const tables = fixture();
    const supabase = makeFakeSupabase(tables);
    await rederiveStoredSessionIssues(supabase, USER, "s1");
    const once = rowsOf(tables, "s1");
    await rederiveStoredSessionIssues(supabase, USER, "s1");
    expect(rowsOf(tables, "s1")).toEqual(once);
  });

  it("a session whose extraction lock is held is left to that run", async () => {
    const tables = fixture();
    tables.code_sessions[0].props.memory_extraction_lock = { run_id: "other", at: new Date().toISOString() };
    await rederiveStoredSessionIssues(makeFakeSupabase(tables), USER, "s1");
    expect(rowsOf(tables, "s1")).toContain(`${PROJECT}#7|issue|observed|viewed|`);
  });
});

describe("child → parent fold after a child re-upload", () => {
  function fixture(childAction: Row) {
    const tables: Record<string, Row[]> = {
      code_sessions: [
        {
          id: "P",
          user_id: USER,
          source: "claude-code",
          source_session_id: "src-P",
          parent_source_session_id: null,
          code_project_id: "p1",
          git_branch: "main",
          props: { actions_version: 1, memory_checkpoint_turn_idx: 6 },
          code_projects: project,
        },
        {
          id: "C",
          user_id: USER,
          source: "claude-code",
          source_session_id: "src-P:agent-1",
          parent_source_session_id: "src-P",
          code_project_id: "p1",
          props: { actions_version: 1, subAgent: { toolUseId: "tu_spawn" } },
          code_projects: project,
        },
      ],
      code_session_turns: [
        turn("P", 0, { role: "user", text: "run the docs sweep in a sub-agent" }),
        turn("P", 3, {
          kind: "tool_use",
          tool_name: "Agent",
          props: { toolUseId: "tu_spawn", inputDigest: "Docs sweep" },
        }),
        // Same idx as the child's action turn: the old receipt landed here.
        turn("P", 5, { role: "user", kind: "tool_result", text: "[tool_result elided: ok]", props: {} }),
        turn("P", 6, { text: "The sweep is done." }),
        turn("C", 0, { role: "user", text: "sweep the docs" }),
        turn("C", 5, {
          kind: "tool_use",
          tool_name: "Bash",
          props: { toolUseId: "c5", action: childAction, inputDigest: "gh issue view -R other/lib" },
        }),
      ],
      code_session_issues: [
        issueRow("P", {
          ref: `${PROJECT}#6`,
          number: 6,
          role: "referenced",
          tier: "observed",
          review_verb: "viewed",
          turn_idx: 5,
          evidence_quote: "[tool_result elided: ok]",
        }),
      ],
    };
    return tables;
  }

  it("the parent's folded row names the child's repo, is receipted at the spawn turn, and follows the child's re-upload", async () => {
    const tables = fixture(view("other/lib#6"));
    const supabase = makeFakeSupabase(tables);
    await rederiveStoredSessionIssues(supabase, USER, "P");
    expect(rowsOf(tables, "P")).toEqual(["other/lib#6|issue|observed|viewed|"]);
    const row = tables.code_session_issues.find((r) => r.session_id === "P");
    expect(row?.turn_idx).toBe(3);
    expect(row?.evidence_quote).toBe("gh issue view -R other/lib");

    // The child is re-uploaded: its action now names #8. The parent follows.
    const childTurn = tables.code_session_turns.find((t) => t.session_id === "C" && t.idx === 5);
    if (childTurn) childTurn.props = { ...childTurn.props, action: view("other/lib#8") };
    await rederiveStoredSessionIssues(supabase, USER, "P");
    expect(rowsOf(tables, "P")).toEqual(["other/lib#8|issue|observed|viewed|"]);
  });

  it("a child action whose repo is unknown folds nothing into the parent", async () => {
    const tables = fixture({ ...view("#6"), repoUnknown: true });
    await rederiveStoredSessionIssues(makeFakeSupabase(tables), USER, "P");
    expect(rowsOf(tables, "P")).toEqual([]);
  });
});

describe("an extractor claim is never observed without a backing action", () => {
  const turns = [
    turn("s", 0, { role: "user", text: "ship the fix for the login bug" }),
    turn("s", 1, { text: "I merged !5 and pushed the fix for #12." }),
    turn("s", 2, { kind: "tool_use", tool_name: "Bash", props: { toolUseId: "t", inputDigest: "git status" } }),
    turn("s", 3, { role: "user", kind: "tool_result", text: "[tool_result elided: ok]", props: { toolUseId: "t" } }),
  ] as unknown as Parameters<typeof groundSessionIssues>[1];

  it("a model row claiming work (role worked_on) on a ref no action touched carries no tier observed and no verbs", () => {
    const rows = groundSessionIssues(
      [
        {
          ref: `${PROJECT}#12`,
          kind: "issue",
          role: "worked_on",
          evidence_quote: "I merged !5 and pushed the fix for #12.",
        },
        {
          ref: "!5",
          kind: "merge_request",
          role: "worked_on",
          evidence_quote: "I merged !5 and pushed the fix for #12.",
        },
      ],
      turns,
      PROJECT,
      { actionsVersion: 1 },
    );
    for (const r of rows) {
      expect(r.tier).not.toBe("observed");
      expect(r.build_verb).toBeNull();
      expect(r.review_verb).toBeNull();
    }
  });

  it("an elided tool result is never a receipt", () => {
    const rows = groundSessionIssues(
      [{ ref: "#3", kind: "issue", role: "worked_on", evidence_quote: "[tool_result elided: ok]" }],
      turns,
      PROJECT,
      { actionsVersion: 1 },
    );
    expect(rows).toEqual([]);
  });
});

describe("one row per item at read time (foldDiscussedKinds)", () => {
  it("a discussed GitHub issue row joins the observed PR on the same ref; a non-GitHub host keeps #N and !N apart", () => {
    const rows = foldDiscussedKinds([
      { ref: "github.com/acme/app#16", kind: "issue", tier: "discussed" },
      { ref: "github.com/acme/app#16", kind: "merge_request", tier: "observed" },
      { ref: "codehub.example/acme/billing#17", kind: "issue", tier: "discussed" },
      { ref: "codehub.example/acme/billing#17", kind: "merge_request", tier: "observed" },
      { ref: "github.com/acme/app#20", kind: "issue", tier: "discussed" },
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["merge_request", "merge_request", "issue", "merge_request", "issue"]);
  });
});

describe("a pasted span (props.ownerText) never grounds an owner ref", () => {
  const full =
    'I also see these listings <pasted_content id="c1">github.com/acme/app#25 discussed 1 session</pasted_content id="c1"> , can we show more precision?';
  const turns = [
    turn("s", 0, {
      role: "user",
      text: full,
      props: { ownerText: "I also see these listings   , can we show more precision?" },
    }),
  ] as unknown as Parameters<typeof groundSessionIssues>[1];

  it("a ref named only inside the paste is no discussed row, by quote or by mention", () => {
    const rows = groundSessionIssues(
      [
        {
          ref: `${PROJECT}#25`,
          kind: "issue",
          evidence_quote: "github.com/acme/app#25",
          mentions: [{ turn_idx: 0, quote: "github.com/acme/app#25" }],
        },
      ],
      turns,
      PROJECT,
      { actionsVersion: 1 },
    );
    expect(rows).toEqual([]);
  });

  it("the same line typed by the owner still grounds as discussed", () => {
    const own = [
      turn("s", 0, { role: "user", text: "please look at github.com/acme/app#25 today" }),
    ] as unknown as Parameters<typeof groundSessionIssues>[1];
    const rows = groundSessionIssues(
      [{ ref: `${PROJECT}#25`, kind: "issue", evidence_quote: "look at github.com/acme/app#25" }],
      own,
      PROJECT,
      { actionsVersion: 1 },
    );
    expect(rows.map((r) => [r.ref, r.tier])).toEqual([[`${PROJECT}#25`, "discussed"]]);
  });
});
