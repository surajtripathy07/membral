// D-051 F1–F3: a ref is qualified to the session's project only on structural
// evidence — a readable -R/--repo, the command's own result URL, the session's
// own directory with no move away from it, and the owner's own authorship of a
// prose line. Synthetic sessions, fictional CodeHub-style repos; no rule here
// names a repo, user, session or number.
import { claudeCodeParser, type ForgeAction, type RawTurn, settleActionDir } from "@membral/core";
import { describe, expect, it } from "vitest";
import { aggregateIssueAttribution, type SessionIssueRow } from "@/lib/agent-stats/attribution";
import type { ProfileTurnInput } from "@/lib/code-sessions/profile";
import { actionVerb } from "@/lib/stats/user-stats";
import { groundSessionIssues } from "../extract";
import { fetchChildSessionsForProfile } from "../tail-capture";

const PROJECT = "codehub.example/acme/billing";
const HOME = "/home/dev/billing";
let clock = 0;
const ts = () => {
  clock += 1;
  return `2026-09-26T10:${String(Math.floor(clock / 60) % 60).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}.000Z`;
};

function user(sid: string, text: string, cwd = HOME): object {
  return { type: "user", message: { role: "user", content: text }, cwd, timestamp: ts(), sessionId: sid };
}
function assistant(sid: string, text: string): object {
  return {
    type: "assistant",
    message: {
      id: `msg_${sid}_${clock}`,
      role: "assistant",
      model: "codehub-model-1",
      content: [{ type: "text", text }],
      usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    },
    cwd: HOME,
    timestamp: ts(),
    sessionId: sid,
  };
}
let seq = 0;
function bash(sid: string, command: string, result = "", cwd = HOME): object[] {
  const id = `tu_ra_${++seq}`;
  return [
    {
      type: "assistant",
      message: {
        id: `msg_${id}`,
        role: "assistant",
        model: "codehub-model-1",
        content: [{ type: "tool_use", id, name: "Bash", input: { command, description: "run" } }],
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
      cwd,
      timestamp: ts(),
      sessionId: sid,
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: result }] },
      toolUseResult: { stdout: result },
      cwd,
      timestamp: ts(),
      sessionId: sid,
    },
  ];
}

/**
 * The importer's per-action repo verdict (the CLI resolves each action's `dir`
 * with git; packages/cli/src/action-repos.ts, tested there against real
 * repos). Stand-in here: a directory under HOME is the project's repo, any
 * other is unknown. `repoUnknown` actions are kept (the CLI omits them) so
 * the server's own refusal to count them stays tested.
 */
function settled(a: ForgeAction | undefined): ForgeAction | undefined {
  if (!a) return a;
  const home = a.dir !== undefined && (a.dir === HOME || a.dir.startsWith(`${HOME}/`));
  return settleActionDir(a, home ? { kind: "project" } : { kind: "unknown" });
}

type Turn = ProfileTurnInput & { text: string | null };
function turnsOf(sid: string, events: object[]): Turn[] {
  const s = claudeCodeParser.parse(
    { source: "claude-code", sourceSessionId: sid, path: "n/a" },
    `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
  );
  for (const t of s.turns) {
    const at = t.action && t.actions ? t.actions.indexOf(t.action) : -1;
    if (t.actions) t.actions = t.actions.map((a) => settled(a) as ForgeAction);
    t.action = at >= 0 && t.actions ? t.actions[at] : settled(t.action);
  }
  return s.turns.map((t: RawTurn) => ({
    idx: t.idx,
    role: t.role,
    kind: t.kind,
    tool_name: t.toolName ?? null,
    file_path: t.filePath ?? null,
    text: t.text ?? null,
    props: { toolUseId: t.toolUseId, action: t.action, actions: t.actions, inputDigest: t.inputDigest },
  }));
}

describe("F1 (a): a forge command after cd into another clone never lands on the session's project", () => {
  const turns = turnsOf("s-a", [
    user("s-a", "set up a scratch clone of the ledger service and poke at it"),
    ...bash("s-a", "cd /tmp/scratch/ledger && gh pr view 18 && gh issue view 10", '{"state":"OPEN"}'),
    ...bash("s-a", "R=$HOME/clones/ledger; cd $R; glab mr merge 17", "✓ Merged!"),
    ...bash("s-a", "git -C /tmp/scratch/ledger commit -am wip", "[main abc1234] wip"),
  ]);

  it("yields no row qualified to the project, observed or discussed", () => {
    const rows = groundSessionIssues([], turns, PROJECT, { actionsVersion: 1 });
    expect(rows).toEqual([]);
  });

  it("a model ref quoting the away command's digest is no receipt either", () => {
    const rows = groundSessionIssues(
      [{ ref: "#10", kind: "issue", evidence_quote: "gh issue view 10" }],
      turns,
      PROJECT,
      { actionsVersion: 1 },
    );
    expect(rows.filter((r) => r.ref.startsWith(PROJECT))).toEqual([]);
  });

  it("the command's own result URL qualifies the item to the repo it names, not the project", () => {
    const t = turnsOf("s-a2", [
      ...bash(
        "s-a2",
        "cd /tmp/scratch/ledger && glab issue close 17",
        "✓ Closed issue #17\nurl: https://codehub.example/acme/ledger/-/issues/17",
      ),
    ]);
    const rows = groundSessionIssues([], t, PROJECT, { actionsVersion: 1 });
    expect(rows.map((r) => [r.ref, r.kind, r.build_verb])).toEqual([
      ["codehub.example/acme/ledger#17", "issue", "closed"],
    ]);
  });

  it("a sub-agent's away actions do not fold into the parent's project either (B16 + F1)", () => {
    const parent = turnsOf("p-a", [user("p-a", "run the scratch checks in a sub-agent")]);
    const rows = groundSessionIssues([], parent, PROJECT, {
      actionsVersion: 1,
      childSessions: [{ id: "c-a", spawnToolUseId: null, turns }],
    });
    expect(rows).toEqual([]);
  });
});

describe("F2 (b): a sub-agent's brief is the parent agent's words, never the owner's", () => {
  const child = turnsOf("c-b", [
    user("c-b", "Verify the fix for #42 landed, then report back."),
    assistant("c-b", "Checked: the fix for #42 is in."),
  ]);
  const model = [
    {
      ref: "#42",
      kind: "issue" as const,
      evidence_quote: "Verify the fix for #42 landed",
      mentions: [{ turn_idx: 0, quote: "the fix for #42" }],
    },
  ];

  it("the brief grounds no discussed ref in the sub-agent session", () => {
    expect(groundSessionIssues(model, child, PROJECT, { actionsVersion: 1, subAgent: true })).toEqual([]);
  });

  it("a brief or narration that spells the project's repo still grounds nothing in the sub-agent", () => {
    const t = turnsOf("c-b3", [
      user("c-b3", "Check acme/billing#43 and report."),
      assistant("c-b3", "ref: codehub.example/acme/billing#43 is open."),
    ]);
    for (const evidence_quote of [
      "Check acme/billing#43 and report.",
      "ref: codehub.example/acme/billing#43 is open.",
    ]) {
      const rows = groundSessionIssues([{ ref: "acme/billing#43", kind: "issue", evidence_quote }], t, PROJECT, {
        actionsVersion: 1,
        subAgent: true,
      });
      expect(rows).toEqual([]);
    }
  });

  it("the same line in a main session is the owner's own and stays a row (v4: no verb → referenced)", () => {
    const rows = groundSessionIssues(model, child, PROJECT, { actionsVersion: 1 });
    expect(rows.map((r) => [r.ref, r.role])).toEqual([[`${PROJECT}#42`, "referenced"]]);
  });

  it("a sub-agent's own observed action still counts", () => {
    const worked = turnsOf("c-b2", [
      user("c-b2", "Comment on #42 that the fix is in."),
      ...bash("c-b2", "glab issue note 42 -m done", "https://codehub.example/acme/billing/-/issues/42#note_1"),
    ]);
    const rows = groundSessionIssues([], worked, PROJECT, { actionsVersion: 1, subAgent: true });
    expect(rows.map((r) => [r.number, r.review_verb])).toEqual([[42, "commented"]]);
  });
});

describe("F3 (c): a bare #N is qualified to the session's project only when the owner wrote it", () => {
  const NON_GIT = "code-project:0000-non-git";
  const turns = turnsOf("s-c", [
    user("s-c", "notes for #7: rewrite the intro"),
    assistant("s-c", "Also saw a new commit on #9 after dismissal."),
  ]);

  it("owner prose in a non-git project stays with that project, never a forge repo", () => {
    const rows = groundSessionIssues(
      [{ ref: "#7", kind: "issue", evidence_quote: "notes for #7: rewrite the intro" }],
      turns,
      NON_GIT,
      { actionsVersion: 1 },
    );
    expect(rows.map((r) => r.ref)).toEqual([`${NON_GIT}#7`]);
  });

  it("assistant prose naming a bare #N grounds nothing, even when the model qualified it to the project", () => {
    for (const ref of ["#9", `${PROJECT}#9`, "https://codehub.example/other/tool/-/issues/9"]) {
      const rows = groundSessionIssues(
        [{ ref, kind: "issue", evidence_quote: "a new commit on #9 after dismissal" }],
        turns,
        PROJECT,
        { actionsVersion: 1 },
      );
      expect(rows).toEqual([]);
    }
  });

  it("assistant prose that spells the project's repo itself is still grounded", () => {
    const t = turnsOf("s-c2", [assistant("s-c2", "Opened acme/billing#11 for the follow-up.")]);
    const rows = groundSessionIssues(
      [{ ref: "acme/billing#11", kind: "issue", evidence_quote: "Opened acme/billing#11 for the follow-up." }],
      t,
      PROJECT,
      { actionsVersion: 1 },
    );
    expect(rows.map((r) => r.ref)).toEqual([`${PROJECT}#11`]);
  });
});

describe("F1 (d): a same-repo command still attributes", () => {
  it("no cd, a descent, and an absolute path inside the session all land on the project", () => {
    const turns = turnsOf("s-d", [
      user("s-d", "review the open MRs"),
      ...bash("s-d", "glab mr view 5", "title: x\nstate: opened"),
      ...bash("s-d", "cd services/ledger && glab mr view 6", "title: y\nstate: opened"),
      ...bash("s-d", `cd ${HOME}/docs && glab issue note 9 -m ok`, ""),
    ]);
    const rows = groundSessionIssues([], turns, PROJECT, { actionsVersion: 1 });
    expect(rows.map((r) => r.ref).sort()).toEqual([`${PROJECT}#5`, `${PROJECT}#6`, `${PROJECT}#9`]);
  });
});

describe("usage dashboard: rows that F1–F3 no longer write leave the cost in Unattributed", () => {
  it("a session with no rows is priced in unattributed, not on any ref", () => {
    const session = {
      id: "s-u",
      started_at: "2026-09-26T10:00:00Z",
      turn_count: 10,
      props: {
        usage: { input_tokens: 1000, output_tokens: 1000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        models: ["claude-sonnet-4-5"],
      },
    };
    const rows: SessionIssueRow[] = [];
    const out = aggregateIssueAttribution([session as never], [], rows);
    expect(out.issues).toEqual([]);
    expect(out.unattributed.sessions).toBe(1);
  });
});

describe("round 2: another repo's item is shown under that repo, never joined to the project's", () => {
  it("a bare #5 closed in the project is not folded onto ledger's qualified #5 (canon guard)", () => {
    const turns = turnsOf("s-canon", [
      user("s-canon", "compare the two #5s"),
      ...bash("s-canon", "gh issue view 5 -R acme/ledger", "title:\tLedger five\nstate:\tOPEN"),
      ...bash("s-canon", "gh issue close 5", "✓ Closed issue #5"),
    ]);
    const rows = groundSessionIssues([], turns, PROJECT, { actionsVersion: 2 });
    const byRef = Object.fromEntries(rows.map((r) => [r.ref, r.build_verb]));
    expect(byRef[`${PROJECT}#5`]).toBe("closed");
    // v3 item 6: a gh `-R` item is a github.com item.
    expect(byRef["github.com/acme/ledger#5"]).toBeNull();
  });

  it("N4: a repo named inside a longer name is not named", () => {
    const turns = turnsOf("s-n4", [
      user("s-n4", "hi"),
      assistant("s-n4", "The fix for xacme/billing-old#12 is upstream."),
    ]);
    const rows = groundSessionIssues(
      [{ ref: "acme/billing#12", kind: "issue", evidence_quote: "The fix for xacme/billing-old#12 is upstream." }],
      turns,
      PROJECT,
      { actionsVersion: 2 },
    );
    expect(rows).toEqual([]);
  });
});

describe("B2 (stored rows): a child filed under another project folds only repo-named items into the parent", () => {
  function fakeSupabase(children: Array<{ id: string; code_project_id: string; turns: object[] }>) {
    const chain = (rows: unknown[]) => {
      const q: Record<string, unknown> = {};
      for (const k of ["select", "eq", "order"]) q[k] = () => q;
      q.range = () => Promise.resolve({ data: rows, error: null });
      // biome-ignore lint/suspicious/noThenProperty: a Supabase query builder is awaited as a thenable
      q.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: rows, error: null }).then(res);
      return q;
    };
    let turnsFor = "";
    return {
      from(table: string) {
        if (table === "code_sessions")
          return chain(children.map((c) => ({ id: c.id, props: {}, code_project_id: c.code_project_id })));
        const q = chain([]) as Record<string, unknown>;
        q.eq = (col: string, v: string) => {
          if (col === "session_id") turnsFor = v;
          return q;
        };
        q.range = () => Promise.resolve({ data: children.find((c) => c.id === turnsFor)?.turns ?? [], error: null });
        return q;
      },
    };
  }

  it("bare refs and ref-less actions of a foreign-project child never count for the parent", async () => {
    const childTurns = [
      {
        idx: 0,
        role: "assistant",
        kind: "tool_use",
        tool_name: "Bash",
        file_path: null,
        props: { action: { verb: "closed", ref: "#7", refKind: "issue", state: "closed", source: "cli" } },
      },
      {
        idx: 1,
        role: "assistant",
        kind: "tool_use",
        tool_name: "Bash",
        file_path: null,
        props: {
          action: { verb: "viewed", ref: "acme/ledger!3", refKind: "merge_request", branch: "feat", source: "cli" },
        },
      },
    ];
    const supabase = fakeSupabase([
      { id: "c-foreign", code_project_id: "proj-ledger", turns: childTurns },
      { id: "c-same", code_project_id: "proj-billing", turns: childTurns },
    ]);
    const kids = await fetchChildSessionsForProfile(supabase as never, "u1", {
      id: "p1",
      source: "claude-code",
      source_session_id: "src-p1",
      code_project_id: "proj-billing",
    });
    const foreign = kids.find((k) => k.id === "c-foreign");
    const same = kids.find((k) => k.id === "c-same");
    expect((foreign?.turns[0].props as { action: ForgeAction }).action.repoUnknown).toBe(true);
    expect((foreign?.turns[1].props as { action: ForgeAction }).action).toEqual({
      verb: "viewed",
      ref: "acme/ledger!3",
      refKind: "merge_request",
      source: "cli",
    });
    expect((same?.turns[0].props as { action: ForgeAction }).action.repoUnknown).toBeUndefined();

    const parent = turnsOf("p-b2", [user("p-b2", "delegate")]);
    const rows = groundSessionIssues([], parent, PROJECT, {
      actionsVersion: 2,
      childSessions: foreign ? [foreign] : [],
    });
    expect(rows.map((r) => r.ref)).toEqual(["acme/ledger!3".replace("!", "#")]);
  });
});

describe("N3: user-level stats skip an action whose repo is not observable", () => {
  it("actionVerb reads no verb from a repoUnknown action", () => {
    expect(actionVerb({ action: { verb: "committed", source: "cli" } })).toBe("committed");
    expect(actionVerb({ action: { verb: "committed", source: "cli", repoUnknown: true } })).toBeUndefined();
  });
});

describe("v3: an explicit #N in a commit's own subject is an observed link, in the commit's own repo", () => {
  const out = (subject: string) => `[main d7e5977] ${subject}\n 1 file changed, 3 insertions(+)`;

  it("a commit in the project's repo qualifies its bare #N to the project: worked_on, committed, observed", () => {
    const turns = turnsOf("s-v3a", [
      user("s-v3a", "go"),
      ...bash("s-v3a", 'git commit -am "fix(ledger): #7 idempotent debits"', out("fix(ledger): #7 idempotent debits")),
    ]);
    const rows = groundSessionIssues([], turns, PROJECT, { actionsVersion: 2, subAgent: true });
    expect(rows.map((r) => [r.ref, r.role, r.build_verb, r.tier])).toEqual([
      [`${PROJECT}#7`, "worked_on", "committed", "observed"],
    ]);
  });

  it("the same commit in an unresolved directory links nothing", () => {
    const turns = turnsOf("s-v3b", [
      user("s-v3b", "go"),
      ...bash("s-v3b", 'cd /tmp/scratch/ledger && git commit -am "#7: fix"', out("#7: fix")),
    ]);
    expect(groundSessionIssues([], turns, PROJECT, { actionsVersion: 2 })).toEqual([]);
  });

  it("a project with no forge remote (a local path identity) never reads a bare #N", () => {
    const turns = turnsOf("s-v3c", [user("s-v3c", "go"), ...bash("s-v3c", 'git commit -am "#7: fix"', out("#7: fix"))]);
    expect(groundSessionIssues([], turns, HOME, { actionsVersion: 2 })).toEqual([]);
    expect(groundSessionIssues([], turns, "code-project:1234", { actionsVersion: 2 })).toEqual([]);
  });
});

describe("v3: a filed issue comes back as an observed `opened` on it, never as work", () => {
  it("`gh issue create` printing the URL yields a row on that issue: observed, no rung, no share", () => {
    const turns = turnsOf("s-v3o", [
      user("s-v3o", "file an issue for the ledger drift"),
      ...bash(
        "s-v3o",
        'gh issue create --title "Ledger drift" --body "..."',
        "https://codehub.example/acme/billing/issues/161",
      ),
      assistant("s-v3o", "Filed."),
    ]);
    const rows = groundSessionIssues([], turns, PROJECT, { actionsVersion: 2 });
    expect(rows.map((r) => [r.ref, r.role, r.review_verb, r.build_verb, r.tier, r.turn_share])).toEqual([
      [`${PROJECT}#161`, "referenced", null, null, "observed", 0],
    ]);
    expect(rows[0].evidence_quote).toContain("gh issue create");
  });
});

describe("v3 item 6: a cross-repo gh ref is stored github.com-qualified and links; a glab one does not", () => {
  it("gh -R owner/repo → github.com/owner/repo#N (forgeUrl links); glab -R → host-less, no link", async () => {
    const { forgeUrl } = await import("@/lib/format/forge-url");
    const turns = turnsOf("s-v3h", [
      user("s-v3h", "check the audiobooks issue and the tool MR"),
      ...bash("s-v3h", "gh issue view 10 -R acme/audiobooks", "title:\tTen\nstate:\tOPEN"),
      ...bash("s-v3h", "glab mr view 5 -R acme/tool", "title: Five\nstate: opened"),
    ]);
    const rows = groundSessionIssues([], turns, PROJECT, { actionsVersion: 2 });
    const gh = rows.find((r) => r.number === 10);
    const glab = rows.find((r) => r.number === 5);
    expect(gh?.ref).toBe("github.com/acme/audiobooks#10");
    expect(forgeUrl(gh?.ref ?? "")).toBe("https://github.com/acme/audiobooks/issues/10");
    expect(glab?.ref).toBe("acme/tool#5");
    expect(forgeUrl(glab?.ref ?? "")).toBeNull();
  });
});
