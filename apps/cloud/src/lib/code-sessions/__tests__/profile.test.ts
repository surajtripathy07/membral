// Goal 2026-09-26 W4 / P2 (D-051) — the profile builder, tested by behaviour.
//
// Every fixture is a REAL-SHAPED Claude Code transcript (the JSONL events
// `~/.claude/projects/<cwd>/<session>.jsonl` carries) run through the core
// parser, then mapped to the `code_session_turns` row shape exactly as
// import.ts's buildTurnProps stores it — never a hand-built action object.
// Fictional host `codehub.example`, project `acme/billing` throughout.
import { claudeCodeParser, type ForgeAction, type RawCodeSession, type RawTurn, settleActionDir } from "@membral/core";
import { describe, expect, it } from "vitest";
import { buildProfile, commitSubjectRefs, deriveRole, type ProfileTurnInput, type RefProfile } from "../profile";

const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const CC_REF = { source: "claude-code", sourceSessionId: SESSION_ID, path: "n/a" };
let clock = 0;
function ts(): string {
  clock += 1;
  return `2026-09-26T08:${String(Math.floor(clock / 60) % 60).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}.000Z`;
}

function user(text: string): object {
  return {
    type: "user",
    message: { role: "user", content: text },
    isMeta: null,
    cwd: "/home/dev/billing",
    gitBranch: "main",
    timestamp: ts(),
    sessionId: SESSION_ID,
  };
}

/** A slash-command invocation as Claude Code stores it (B13). */
function slash(skill: string, args: string): object {
  return user(
    `<command-name>/${skill}</command-name>\n<command-message>${skill}</command-message>\n<command-args>${args}</command-args>`,
  );
}

function assistant(text: string): object {
  return {
    type: "assistant",
    message: {
      id: `msg_p_${clock}`,
      role: "assistant",
      model: "codehub-model-1",
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    timestamp: ts(),
    sessionId: SESSION_ID,
  };
}

let toolSeq = 0;
function tool(name: string, input: Record<string, unknown>, result = "ok", opts: { id?: string } = {}): object[] {
  toolSeq += 1;
  const id = opts.id ?? `tu_${toolSeq}`;
  return [
    {
      type: "assistant",
      message: {
        id: `msg_${id}`,
        role: "assistant",
        model: "codehub-model-1",
        content: [{ type: "tool_use", id, name, input }],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      timestamp: ts(),
      sessionId: SESSION_ID,
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: result }] },
      toolUseResult: { stdout: result },
      timestamp: ts(),
      sessionId: SESSION_ID,
    },
  ];
}
const bash = (command: string, result = "") => tool("Bash", { command, description: "run" }, result);
const edit = (file_path: string) => tool("Edit", { file_path, old_string: "a", new_string: "b" }, "ok");
const write = (file_path: string) => tool("Write", { file_path, content: "notes" }, "ok");
const read = (file_path: string) => tool("Read", { file_path }, "1\tcontents");

function parse(events: object[]): RawCodeSession {
  return claudeCodeParser.parse(CC_REF, `${events.map((e) => JSON.stringify(e)).join("\n")}\n`);
}

/** The `code_session_turns` row shape import.ts writes (buildTurnProps), as the profile reads it. */
function rows(session: RawCodeSession): ProfileTurnInput[] {
  return session.turns.map((t: RawTurn) => {
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

function profileOf(events: object[]) {
  return buildProfile(rows(parse(events)));
}
function ref(p: { refs: RefProfile[] }, r: string): RefProfile {
  const found = p.refs.find((x) => x.ref === r);
  if (!found) throw new Error(`no ref ${r} in ${p.refs.map((x) => x.ref).join(", ")}`);
  return found;
}

const MR_URL = "https://codehub.example/acme/billing/-/merge_requests/17049";
const CHECKOUT_RESULT =
  "Branch 'fix-debits' set up to track remote branch 'fix-debits' from 'origin'.\nSwitched to a new branch 'fix-debits'";
const COMMIT_RESULT =
  "[15178-5-idempotent-debits d7e5977] make debit posting idempotent\n 2 files changed, 41 insertions(+), 3 deletions(-)";
const COMMIT_RESULT_2 =
  "[15178-5-idempotent-debits 0a1b2c3] add idempotency key migration\n 1 file changed, 12 insertions(+)";
const PUSH_RESULT =
  "To codehub.example:acme/billing.git\n * [new branch]      15178-5-idempotent-debits -> 15178-5-idempotent-debits";

/** The journey's 08:50 review session: slash line, checkout, tests, a review file, reframes. */
function reviewSession(opts: { post?: boolean; skill?: string } = {}): object[] {
  return [
    slash(opts.skill ?? "review-mr", `this is the MR we are reviewing ${MR_URL}`),
    assistant("Checking the branch out."),
    ...bash("glab mr checkout 17049", CHECKOUT_RESULT),
    ...bash("npm test -- --run", "Tests 41 passed"),
    ...bash("npm run typecheck", "ok"),
    ...write("/home/dev/billing/review-17049.md"),
    user("tighten point 2, it reads as a nag"),
    assistant("Reframed point 2."),
    ...edit("/home/dev/billing/review-17049.md"),
    user("good. now point 4 is wrong, the retry path is fine"),
    assistant("Dropped point 4."),
    ...(opts.post ? bash("glab mr note 17049 -m 'Two things before this merges'", "ok") : []),
  ];
}

describe("buildProfile — B3 two ladders per ref, highest rung of each counts", () => {
  it("a review session (slash line, checkout, tests, review file, no post) is `reviewed`, build ladder empty, and never open", () => {
    const p = profileOf(reviewSession());
    expect(p.refs.map((r) => r.ref)).toEqual(["acme/billing!17049"]);
    const mr = ref(p, "acme/billing!17049");
    expect(mr.refKind).toBe("merge_request");
    expect(mr.review_verb).toBe("reviewed");
    expect(mr.build_verb).toBeNull(); // editing review-17049.md is not delivering on the MR
    expect(mr.evidence.checked_out).toBeDefined();
    expect(mr.evidence.reviewed).toEqual(mr.evidence.checked_out);
    expect(mr.tier).toBe("observed");
    expect(mr.discussed).toBe(false);
    expect(mr.skill).toBe("review-mr");
    expect(mr.url).toBe(MR_URL);
    // v4 B2: a review that posted nothing (no `gh pr review`/approval) carries no cost; the verb stays.
    expect(mr.turn_share).toBe(0);
    expect(deriveRole(mr)).toBe("worked_on");
  });

  it("the same session plus `glab mr note` is `reviewed · commented` — commented is the top review rung", () => {
    const mr = ref(profileOf(reviewSession({ post: true })), "acme/billing!17049");
    expect(mr.review_verb).toBe("commented");
    expect(mr.evidence.commented).toBeDefined();
    expect(mr.evidence.reviewed).toBeDefined();
    expect(mr.build_verb).toBeNull();
  });

  it("B13: renaming the skill to a nonsense word yields identical rows (the label is never a verb)", () => {
    const a = profileOf(reviewSession({ post: true }));
    const b = profileOf(reviewSession({ post: true, skill: "zorbulate" }));
    const strip = (r: RefProfile) => ({ ...r, skill: undefined });
    expect(b.refs.map(strip)).toEqual(a.refs.map(strip));
    expect(b.refs[0].skill).toBe("zorbulate");
  });

  it("the journey's build session: paste issue #15178, edit six files, tests, commit twice, push → `#15178: pushed`, shas kept", () => {
    const events = [
      user("lets do https://codehub.example/acme/billing/-/issues/15178 — idempotent debits"),
      assistant("On it."),
      ...read("/home/dev/billing/src/ledger/debits.ts"),
      ...["debits.ts", "debits.test.ts", "idempotency.ts", "keys.ts", "migrate.sql", "index.ts"].flatMap((f) =>
        edit(`/home/dev/billing/src/ledger/${f}`),
      ),
      ...bash("npm test -- --run", "Tests 44 passed"),
      ...bash("git add -A && git commit -m 'make debit posting idempotent'", COMMIT_RESULT),
      ...bash("git commit -am 'add idempotency key migration'", COMMIT_RESULT_2),
      ...bash("git push -u origin 15178-5-idempotent-debits", PUSH_RESULT),
      assistant("Pushed."),
    ];
    const p = profileOf(events);
    const issue = ref(p, "acme/billing#15178");
    expect(issue.refKind).toBe("issue");
    expect(issue.build_verb).toBe("pushed");
    expect(issue.evidence.edited).toBeDefined();
    expect(issue.evidence.committed).toBeDefined();
    expect(issue.evidence.pushed).toBeDefined();
    expect(issue.shas).toEqual(["d7e5977", "0a1b2c3"]);
    expect(issue.review_verb).toBeNull(); // reads on an issue being built are not a review
    // v4 B1: no PR branch observed — the pasted issue labels the work, it carries no cost.
    expect(issue.turn_share).toBe(0);
    expect(p.edits).toBe(6);
    expect(p.commits).toBe(2);
    expect(p.pushes).toBe(1);
    expect(deriveRole(issue)).toBe("worked_on");
  });

  it("paste issue #9, then `Edit` + `git commit` → `#9: committed`", () => {
    const p = profileOf([
      user("fix #9 please"),
      ...edit("/home/dev/billing/src/x.ts"),
      ...bash("git commit -am 'fix #9'", "[main abc1234] fix #9\n 1 file changed"),
    ]);
    // A bare `#9` in prose is not a pasted URL; the commit's ref-less action lands on the focus,
    // which the pasted URL (not prose) sets — so with prose only there is no ref row yet.
    expect(p.refs).toEqual([]);
    const withUrl = profileOf([
      user("fix https://codehub.example/acme/billing/-/issues/9 please"),
      ...edit("/home/dev/billing/src/x.ts"),
      ...bash("git commit -am 'fix #9'", "[main abc1234] fix #9\n 1 file changed"),
    ]);
    const issue = ref(withUrl, "acme/billing#9");
    expect(issue.build_verb).toBe("committed");
    expect(issue.shas).toEqual(["abc1234"]);
  });

  it("edits with no commit stay at `edited` — a rung below committed, so the role is discussed, never worked_on", () => {
    const issue = ref(
      profileOf([
        user(`look at ${MR_URL.replace("merge_requests/17049", "issues/12")}`),
        ...edit("/home/dev/billing/a.ts"),
      ]),
      "acme/billing#12",
    );
    expect(issue.build_verb).toBe("edited");
    expect(deriveRole(issue)).toBe("discussed");
  });

  it("triage via `glab issue update --label` is `triaged`, standing alone (v4: no verb on the ladders → referenced, no share)", () => {
    const p = profileOf([
      user("this one needs design: https://codehub.example/acme/billing/-/issues/16002"),
      assistant("Agreed — labelling it."),
      ...bash("glab issue update 16002 --label needs-design", "ok"),
    ]);
    const issue = ref(p, "acme/billing#16002");
    expect(issue.triaged).toBe(true);
    expect(issue.review_verb).toBeNull();
    expect(issue.build_verb).toBeNull();
    expect(issue.evidence.triaged).toBeDefined();
    expect(issue.turn_share).toBe(0);
    expect(deriveRole(issue)).toBe("referenced");
  });

  it('a session whose only review evidence is prose ("I reviewed it") reaches no rung', () => {
    const p = profileOf([user(`have a look at ${MR_URL}`), assistant("I reviewed it carefully and it looks fine.")]);
    const mr = ref(p, "acme/billing!17049");
    expect(mr.review_verb).toBeNull();
    expect(mr.build_verb).toBeNull();
    expect(mr.discussed).toBe(true);
  });
});

describe("buildProfile — B5 discussion is shown and never counted as open", () => {
  it("a pasted epic talked through for 30 turns with no tool is tier discussed; v4: no verb → referenced, no share", () => {
    const events = [user("thinking about https://codehub.example/acme/billing/-/issues/254702 the ledger epic")];
    for (let i = 0; i < 15; i++) events.push(assistant(`Thought ${i}.`), user(`Reply ${i}.`));
    const p = profileOf(events);
    const epic = ref(p, "acme/billing#254702");
    expect(epic.discussed).toBe(true);
    expect(epic.tier).toBe("discussed");
    expect(epic.review_verb).toBeNull();
    expect(epic.build_verb).toBeNull();
    expect(epic.turn_share).toBe(0);
    expect(epic.turns).toBe(0);
    expect(deriveRole(epic)).toBe("referenced");
  });

  it("a ref only viewed (`glab issue view`) with no edits is discussed too", () => {
    const issue = ref(
      profileOf([user("what is 9 about"), ...bash("glab issue view 9", "title: Debits\nstate: opened")]),
      "#9",
    );
    expect(issue.review_verb).toBe("viewed");
    expect(issue.discussed).toBe(true);
    expect(issue.state).toBe("opened");
    // v3: a view-only ref carries no turn share, so it reads as a mention (referenced), not a costed session.
    expect(issue.turn_share).toBe(0);
    expect(deriveRole(issue)).toBe("referenced");
  });
});

describe("buildProfile — B15 several refs in one session", () => {
  const b15 = () => [
    slash("review-mr", MR_URL), // A = acme/billing!17049
    assistant("Looking at the related issue first."),
    ...bash("glab issue view 9", "title: Debits\nstate: opened"),
    assistant("Noted: #9 explains the retry path."),
    ...read("/home/dev/billing/src/ledger/debits.ts"),
    user("ok now also check MR 22"),
    ...bash("glab mr checkout 22", "Switched to branch 'mr-22'"),
    ...bash("npm test -- --run", "Tests 41 passed"),
    ...bash("glab mr note 17049 -m 'looks good, one nit'", "ok"),
    ...bash("glab mr note 22 -m 'needs a test'", "ok"),
  ];

  it("A `reviewed · commented`, B `checked_out · commented`, #9 `viewed` linked to A with share 0; A and B split at the checkout", () => {
    const p = profileOf(b15());
    const a = ref(p, "acme/billing!17049");
    const b = ref(p, "!22");
    const nine = ref(p, "#9");

    expect(a.review_verb).toBe("commented");
    expect(a.evidence.reviewed).toBeDefined();
    expect(b.review_verb).toBe("commented");
    expect(b.evidence.checked_out).toBeDefined();
    expect(nine.review_verb).toBe("viewed");
    expect(nine.related_to).toEqual(["acme/billing!17049"]);
    expect(nine.turn_share).toBe(0);
    expect(deriveRole(nine)).toBe("referenced");

    // v4 B2/S3: `glab mr note` is conversation, not a review command, and nothing was built on
    // either MR's branch — neither carries cost; the verbs stay.
    expect(a.turn_share).toBe(0);
    expect(b.turn_share).toBe(0);
  });

  it("`viewed` never switches focus: the prose after `glab issue view 9` still lands on the MR", () => {
    const p = profileOf([
      slash("review-mr", MR_URL),
      ...bash("glab issue view 9", "state: opened"),
      assistant("Right, #9 explains it."),
      user("keep going on the MR"),
      assistant("Continuing."),
    ]);
    // v4: a slash line alone is no build evidence and no review — neither ref carries share.
    expect(ref(p, "acme/billing!17049").turn_share).toBe(0);
    expect(ref(p, "#9").turn_share).toBe(0);
  });

  it("an action's own turn belongs to its own ref: a `glab mr note A` while focused on B is commented on A", () => {
    const p = profileOf([
      slash("review-mr", "https://codehub.example/acme/billing/-/merge_requests/2"),
      ...bash("glab mr checkout 2", "Switched to branch 'b'"),
      ...bash("glab mr note 1 -m 'unrelated nit'", "ok"),
    ]);
    expect(ref(p, "!1").review_verb).toBe("commented");
    // v4 S3: a note is conversation — no turn of its own.
    expect(ref(p, "!1").turns).toBe(0);
    expect(ref(p, "acme/billing!2").review_verb).toBe("checked_out");
  });

  it("a build action naming another ref switches focus: `glab mr create` moves the rest of the session onto the new MR", () => {
    const p = profileOf([
      user("ship https://codehub.example/acme/billing/-/issues/15178"),
      ...edit("/home/dev/billing/a.ts"),
      ...bash("git commit -am x", COMMIT_RESULT),
      ...bash("glab mr create --fill", "https://codehub.example/acme/billing/-/merge_requests/17050"),
      assistant("MR opened."),
      user("nice"),
    ]);
    expect(ref(p, "acme/billing#15178").build_verb).toBe("committed");
    // v3 item 6: the create keeps the host its own output URL proved.
    const mr = ref(p, "codehub.example/acme/billing!17050");
    expect(mr.build_verb).toBe("opened_mr");
    expect(mr.turns).toBe(4);
  });

  it("a bare `!N` from a CLI positional joins the qualified ref the slash line named", () => {
    const p = profileOf([
      slash("review-mr", MR_URL),
      ...bash("glab mr checkout 17049", "ok"),
      ...bash("glab mr approve 17049", "ok"),
    ]);
    expect(p.refs.map((r) => r.ref)).toEqual(["acme/billing!17049"]);
    expect(p.refs[0].review_verb).toBe("approved");
  });
});

describe("buildProfile — B16 sub-agents fold into the parent", () => {
  it("the B15 transcript with the checkout and tests done by a sub-agent yields identical rows", () => {
    const parentEvents = [
      slash("review-mr", MR_URL),
      assistant("Looking at the related issue first."),
      ...bash("glab issue view 9", "title: Debits\nstate: opened"),
      assistant("Noted: #9 explains the retry path."),
      ...read("/home/dev/billing/src/ledger/debits.ts"),
      user("ok now also check MR 22"),
      ...tool(
        "Agent",
        { description: "check out and test MR 22", prompt: "glab mr checkout 22 then run tests" },
        "done",
        {
          id: "toolu_spawn_1",
        },
      ),
      ...bash("glab mr note 17049 -m 'looks good, one nit'", "ok"),
      ...bash("glab mr note 22 -m 'needs a test'", "ok"),
    ];
    const childEvents = [
      user("glab mr checkout 22 then run tests"),
      ...bash("glab mr checkout 22", "Switched to branch 'mr-22'"),
      ...bash("npm test -- --run", "Tests 41 passed"),
      assistant("Done."),
    ];
    const parent = rows(parse(parentEvents));
    const child = rows(parse(childEvents));
    expect(parent.find((t) => t.tool_name === "Agent")?.props?.toolUseId).toBe("toolu_spawn_1");

    const folded = buildProfile(parent, {
      childSessions: [{ id: "child-1", spawnToolUseId: "toolu_spawn_1", turns: child }],
    });
    const alone = buildProfile(parent);

    const b = ref(folded, "!22");
    expect(b.review_verb).toBe("commented");
    expect(b.evidence.checked_out).toEqual({ idx: 1, child: "child-1" });
    expect(ref(folded, "acme/billing!17049").review_verb).toBe("commented");
    expect(ref(folded, "#9").related_to).toEqual(["acme/billing!17049"]);
    expect(folded.turns).toBe(parent.length + child.length);
    // v4 B2/S3: notes are no review command — no cost on either MR.
    expect(ref(folded, "acme/billing!17049").turn_share + b.turn_share).toBe(0);
    expect(folded.tests).toBe(1);
    // Without the child, the parent alone never sees the checkout.
    expect(ref(alone, "!22").review_verb).toBe("commented");
    expect(ref(alone, "!22").evidence.checked_out).toBeUndefined();
  });
});

describe("buildProfile — B12 degrade, never fail", () => {
  it("a session with no forge tools, no refs and no edits yields no refs and the counts", () => {
    const p = profileOf([user("hello"), assistant("hi"), ...read("/home/dev/billing/README.md")]);
    expect(p.refs).toEqual([]);
    expect(p.reads).toBe(1);
    expect(p.turns).toBe(4);
    expect(p.userProse).toBe(1);
  });

  it("malformed action props are skipped, not thrown", () => {
    const p = buildProfile([
      { idx: 0, role: "assistant", kind: "tool_use", tool_name: "Bash", props: { action: "not an object" } },
      { idx: 1, role: "assistant", kind: "tool_use", tool_name: "Bash", props: { actions: [null, 3, { verb: 1 }] } },
      { idx: 2, role: "user", kind: "prose", props: null },
    ]);
    expect(p.refs).toEqual([]);
    expect(p.turns).toBe(3);
  });
});

// --- attribution v3 -----------------------------------------------------------

const VIEW_9 = "title: Debits\nstate: opened";
const agent = (prompt: string, id: string) =>
  tool("Agent", { description: "sub-task", prompt, subagent_type: "general-purpose" }, "done", { id });

describe("v3 — a view carries no turn share, and a sub-agent's view never moves the parent's focus", () => {
  it("a status sweep viewing two issues gives neither a share: the first view is not 'the' item", () => {
    const p = profileOf([
      user("any updates for me?"),
      ...bash("glab issue view 9", VIEW_9),
      ...bash("glab issue view 31", "title: Docs\nstate: opened"),
      ...read("/home/dev/billing/src/ledger/debits.ts"),
      ...read("/home/dev/billing/src/ledger/credits.ts"),
      assistant("Both are still open; nothing new."),
    ]);
    for (const r of ["#9", "#31"]) {
      expect(ref(p, r).turn_share).toBe(0);
      expect(ref(p, r).review_verb).toBe("viewed"); // the reads were not "on" the first view
      expect(deriveRole(ref(p, r))).toBe("referenced");
    }
  });

  it("a session whose only item is the one it viewed and then read around is reviewing it (v4: an issue review carries no share)", () => {
    const p = profileOf([
      user("look into 9"),
      ...bash("glab issue view 9", VIEW_9),
      ...read("/home/dev/billing/src/ledger/debits.ts"),
      assistant("The retry path double-posts."),
    ]);
    const nine = ref(p, "#9");
    expect(nine.review_verb).toBe("reviewed");
    expect(nine.turn_share).toBe(0);
    expect(deriveRole(nine)).toBe("worked_on");
  });

  it("a sole view with nothing after it is view-only: no share, the session's turns stay unclaimed", () => {
    const p = profileOf([user("what is 9"), ...bash("glab issue view 9", VIEW_9), assistant("It is about debits.")]);
    expect(ref(p, "#9").turn_share).toBe(0);
    expect(deriveRole(ref(p, "#9"))).toBe("referenced");
  });

  it("a sub-agent's view sets no focus in the parent: its reads never make the parent 'review' it", () => {
    const parent = rows(
      parse([
        user("survey the open issues and then refactor the ledger"),
        ...agent("survey issue 5", "toolu_spawn_v3"),
        assistant("Survey done; refactoring now."),
        ...edit("/home/dev/billing/src/ledger/debits.ts"),
        assistant("Done."),
      ]),
    );
    const child = rows(
      parse([
        user("survey issue 5"),
        ...bash("glab issue view 5", "title: Ledger\nstate: opened"),
        ...read("/home/dev/billing/src/ledger/debits.ts"),
        assistant("Issue 5 is about the ledger."),
      ]),
    );
    const p = buildProfile(parent, { childSessions: [{ id: "c1", spawnToolUseId: "toolu_spawn_v3", turns: child }] });
    const five = ref(p, "#5");
    expect(five.review_verb).toBe("viewed");
    expect(five.turn_share).toBe(0);
    expect(five.build_verb).toBeNull(); // the parent's later edit did not land on the child's view
  });
});

describe("v3 — an explicit #N in a commit's own subject is an observed `committed` link", () => {
  const commitOut = (subject: string) => `[main abc1234] ${subject}\n 1 file changed, 2 insertions(+)`;

  it("reads bare and qualified refs, never merge subjects, squash suffixes or non-ref hashes", () => {
    expect(commitSubjectRefs("fix(db): #115 drop the SRF", true)).toEqual(["#115"]);
    expect(commitSubjectRefs("chore(#129): scrub", true)).toEqual(["#129"]);
    expect(commitSubjectRefs("fix acme/billing#7 and #8", true)).toEqual(["acme/billing#7", "#8"]);
    expect(commitSubjectRefs("fix acme/billing#7 and #8", false)).toEqual(["acme/billing#7"]);
    expect(commitSubjectRefs("feat: ledger export (#123)", true)).toEqual([]);
    expect(commitSubjectRefs("Merge pull request #12 from acme/x", true)).toEqual([]);
    expect(commitSubjectRefs("port the C# client; see docs/api.md#12 and &#39;", true)).toEqual([]);
    expect(commitSubjectRefs(undefined, true)).toEqual([]);
  });

  it("a builder sub-agent's `#7: …` commit in a forge repo is committed on #7, observed, with the sha", () => {
    const events = [
      user("Implement the fix described in the brief"),
      ...edit("/home/dev/billing/src/ledger/debits.ts"),
      ...bash('git commit -am "#7: make debit posting idempotent"', commitOut("#7: make debit posting idempotent")),
      assistant("Committed."),
    ];
    const p = buildProfile(rows(parse(events)), { projectIsForgeRepo: true });
    const seven = ref(p, "#7");
    expect(seven.build_verb).toBe("committed");
    expect(seven.tier).toBe("observed");
    expect(seven.shas).toEqual(["abc1234"]);
    // Driver decision: the subject link is a rung only — no focus, no turns, so no cost share.
    expect(seven.turn_share).toBe(0);
    expect(p.commits).toBe(1);
    expect(deriveRole(seven)).toBe("worked_on");
    // Repo not known to be a forge repo: a bare #7 names nothing.
    expect(buildProfile(rows(parse(events))).refs).toEqual([]);
  });

  it("a commit whose directory is unresolved (repoUnknown) links nothing, even with #N in its subject", () => {
    const turns = rows(parse([user("commit it"), ...bash('git commit -am "#7: fix"', commitOut("#7: fix"))])).map(
      (t) => {
        const a = t.props?.action as ForgeAction | undefined;
        return a
          ? {
              ...t,
              props: {
                ...t.props,
                action: settleActionDir({ ...a, dir: "/elsewhere" }, { kind: "unknown" }),
                actions: undefined,
              },
            }
          : t;
      },
    );
    expect(buildProfile(turns, { projectIsForgeRepo: true }).refs).toEqual([]);
  });

  it("a view of another item plus a subject-named commit: neither carries a share (the cost stays unattributed)", () => {
    const p = buildProfile(
      rows(
        parse([
          user("check 31 then fix 12"),
          ...bash("glab issue view 31", "title: Docs\nstate: opened"),
          ...edit("/home/dev/billing/src/ledger/debits.ts"),
          ...bash('git commit -am "fix: #12 rounding"', commitOut("fix: #12 rounding")),
          assistant("Done."),
        ]),
      ),
      { projectIsForgeRepo: true },
    );
    expect(ref(p, "#31").turn_share).toBe(0);
    expect(ref(p, "#12").build_verb).toBe("committed");
    expect(ref(p, "#12").turn_share).toBe(0);
    expect(deriveRole(ref(p, "#12"))).toBe("worked_on");
  });

  it("a subject naming another item ends the current focus: no build rung and no later turns for the old focus", () => {
    const events = [
      user("close out 9, then fix 12"),
      ...bash("glab issue comment 9 -m 'done'", "ok"),
      assistant("Commented on 9."),
      ...edit("/home/dev/billing/src/ledger/debits.ts"),
      ...bash('git commit -am "fix: #12 rounding"', commitOut("fix: #12 rounding")),
      assistant("Next: more work."),
      assistant("Still going."),
      ...read("/home/dev/billing/src/ledger/credits.ts"),
    ];
    const p = buildProfile(rows(parse(events)), { projectIsForgeRepo: true });
    const nine = ref(p, "#9");
    expect(nine.build_verb).toBeNull(); // the commit is #12's, never the focus's
    const turnsBeforeCommit = 6; // user, 9's comment (2), assistant, edit (2)
    expect(nine.turns).toBeLessThanOrEqual(turnsBeforeCommit);
    expect(ref(p, "#12").turns).toBe(0);
    expect(ref(p, "#12").build_verb).toBe("committed");
  });

  it("a subject commit before any focus: the turns so far are never handed to the next focus", () => {
    const events = [
      user("write the ADR, then close 9"),
      ...edit("/home/dev/billing/docs/adr.md"),
      ...bash(
        'git commit -am "docs: ADR accepted; #12 filed for the follow-up"',
        commitOut("docs: ADR accepted; #12 filed for the follow-up"),
      ),
      ...bash("glab issue close 9", "✓ Closed issue #9"),
      assistant("Closed 9."),
    ];
    const p = buildProfile(rows(parse(events)), { projectIsForgeRepo: true });
    // v4: a close is a closure verb — the rung only, never a turn; the ADR turns stay unclaimed.
    expect(ref(p, "#9").build_verb).toBe("closed");
    expect(ref(p, "#9").turns).toBe(0);
    expect(ref(p, "#12").turns).toBe(0);
  });

  it("review S1: on GitHub a subject #12 naming the PR in focus is that PR — no second, issue-kind row", () => {
    const events = [
      user("address the review"),
      ...bash("gh pr checkout 12", "Switched to branch 'fix-x'"),
      ...edit("/home/dev/billing/src/ledger/debits.ts"),
      ...bash('git commit -am "address review on #12"', "[fix-x aaa1111] address review on #12\n 1 file changed"),
    ];
    const opts = { projectIsForgeRepo: true, projectRepo: "acme/billing", projectHost: "github.com" };
    const p = buildProfile(rows(parse(events)), opts);
    expect(p.refs.map((r) => [r.ref, r.refKind])).toEqual([["!12", "merge_request"]]);
    expect(ref(p, "!12").build_verb).toBe("committed");
    // Off GitHub, #12 and !12 are different items: the issue row stays (rung only).
    const gl = buildProfile(rows(parse(events)), { ...opts, projectHost: "codehub.example" });
    expect(gl.refs.map((r) => r.refKind).sort()).toEqual(["issue", "merge_request"]);
  });

  it("review S2: a subject naming the focus in another spelling keeps the focus (one row, later turns stay)", () => {
    const events = [
      slash("fix", "https://codehub.example/acme/billing/-/issues/41"),
      ...edit("/home/dev/billing/src/a.ts"),
      ...bash('git commit -am "fix #41"', commitOut("fix #41")),
      assistant("More."),
      ...edit("/home/dev/billing/src/b.ts"),
    ];
    const p = buildProfile(rows(parse(events)), { projectIsForgeRepo: true, projectRepo: "acme/billing" });
    expect(p.refs.map((r) => r.ref)).toEqual(["acme/billing#41"]);
    expect(ref(p, "acme/billing#41").build_verb).toBe("committed");
    // v4 B1: an issue labels the commit; no PR branch, no cost.
    expect(ref(p, "acme/billing#41").turn_share).toBe(0);
  });

  it("review S2: with no focus, a subject in another spelling of an item already seen joins that row", () => {
    const events = [
      user("fix 41"),
      ...bash("glab issue comment 41 -m 'on it'", "ok"),
      ...bash('git commit -am "fix acme/billing#41"', commitOut("fix acme/billing#41")),
    ];
    const p = buildProfile(rows(parse(events)), { projectIsForgeRepo: true, projectRepo: "acme/billing" });
    expect(p.refs.map((r) => r.ref)).toEqual(["#41"]);
    expect(ref(p, "#41").build_verb).toBe("committed");
  });

  it("review S3: a revert's subject links nothing, even with a quoted squash suffix", () => {
    expect(commitSubjectRefs('Revert "fix: ledger (#45)"', true)).toEqual([]);
    expect(commitSubjectRefs('Revert "fix #45 rounding"', true)).toEqual([]);
    expect(commitSubjectRefs('docs: quote "feat: x (#45)"', true)).toEqual([]);
  });

  it("nit N1: a sub-agent's subject commit does not leave the parent's leading turns released", () => {
    const parent = rows(
      parse([
        user("plan the work"),
        ...agent("commit the doc", "toolu_spawn_n1"),
        assistant("Now finishing 9."),
        ...bash("glab mr checkout 9", "Switched to branch 'fix-9'"),
        ...bash("git commit -am 'finish 9'", "[fix-9 abc1234] finish 9\n 1 file changed"),
      ]),
    );
    const child = rows(
      parse([user("commit the doc"), ...bash('git commit -am "docs: #12 note"', commitOut("docs: #12 note"))]),
    );
    const p = buildProfile(parent, {
      projectIsForgeRepo: true,
      childSessions: [{ id: "c", spawnToolUseId: "toolu_spawn_n1", turns: child }],
    });
    // Leading turns before !9's checkout still go to !9 (the child's release stays in the child).
    expect(ref(p, "!9").turns).toBeGreaterThan(3);
  });
});
