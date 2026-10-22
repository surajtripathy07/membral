// R5 5.12 (#201): branch coverage for forge-actions result parsing, the gh/glab segment table,
// MCP tool mapping, Bash chain assembly, the quiet-commit sha backfill and the entry-point
// wrappers. Each case feeds a realistic command/result through the public seam and asserts the
// action it yields (verb, ref, refKind, state, branch, url…). Fictional host `codehub.example`,
// project `acme/billing`, product "CodeHub".
import { describe, expect, it } from "vitest";
import { cap } from "../forge-actions/assemble.js";
import { segmentAction } from "../forge-actions/gh-glab.js";
import { parsePushResult, viewStates } from "../forge-actions/results.js";
import type { ForgeAction, ToolActionInput } from "../forge-actions/types.js";
import {
  actionFromPastedText,
  createCommitShaBackfill,
  deriveToolActions,
  parseSlashCommandMessage,
  toolResultText,
} from "../forge-actions.js";

const HOST = "https://codehub.example";
const bash = (command: string, result?: string, extra: Partial<ToolActionInput> = {}): ForgeAction[] =>
  deriveToolActions({ toolName: "Bash", input: { command }, result, ...extra });
const mcp = (tool: string, input: Record<string, unknown>, result?: string, isError = false): ForgeAction[] =>
  deriveToolActions({ toolName: `mcp__codehub__${tool}`, input, result, isError });

describe("viewStates (result attribution)", () => {
  const view = (ref?: string, refKind: "issue" | "merge_request" = "merge_request") =>
    ({ verb: "viewed", ref, refKind }) as Parameters<typeof viewStates>[0][number];

  it("one item: a JSON head whose label owner differs from the base is a fork, so no branch", () => {
    const fork = '{"head":{"label":"someone:feat","ref":"feat"},"base":{"label":"acme:main"}}';
    const v = view("acme/billing!5");
    viewStates([v], fork);
    expect(v.branch).toBeUndefined();

    const same = '{"head":{"label":"acme:feat","ref":"feat"},"base":{"label":"acme:main"}}';
    const w = view("acme/billing!5");
    viewStates([w], same);
    expect(w.branch).toBe("feat");
  });

  it("one item: glab's `!N title (branch)` header line names the branch", () => {
    const v = view("acme/billing!17");
    viewStates([v], "!17 Idempotent debits (15178-5-idempotent-debits)\nstate: opened\n");
    expect(v).toMatchObject({ branch: "15178-5-idempotent-debits", state: "opened" });
  });

  it("one item: a `title:` field with no space after the colon still gives the title", () => {
    const v = view("acme/billing#5", "issue");
    viewStates([v], "title:Plain title\nstate: open\n");
    expect(v).toMatchObject({ title: "Plain title", state: "opened" });
  });

  it("several views with no ref at all are one item: the state goes to every one", () => {
    const a = view(undefined, "issue");
    const b = view(undefined, "issue");
    viewStates([a, b], "state: closed\n");
    expect([a.state, b.state]).toEqual(["closed", "closed"]);
  });

  it("views with no ref and no kind are one item too", () => {
    const a = { verb: "viewed" } as Parameters<typeof viewStates>[0][number];
    const b = { verb: "viewed" } as Parameters<typeof viewStates>[0][number];
    viewStates([a, b], "state: merged\n");
    expect([a.state, b.state]).toEqual(["merged", "merged"]);
  });

  it("several items: each block goes to the view whose number it names; a `!` TTY header makes it a merge request", () => {
    const mr = view("acme/billing!17");
    const issue = view("acme/billing#18", "issue");
    const result = [
      "Add debits !17",
      "Merged • someone wants to merge 1 commit into main from feat-x",
      "",
      "Fix ledger #18",
      "Closed • opened by someone",
      "",
    ].join("\n");
    viewStates([mr, issue], result);
    expect(mr).toMatchObject({ state: "merged", title: "Add debits" });
    expect(issue).toMatchObject({ state: "closed", title: "Fix ledger" });
  });

  it("several items: a block with no number is skipped, a number matching two views gives neither", () => {
    const a = view("acme/billing#5", "issue");
    const b = view("acme/billing#6", "issue");
    const result = [
      "title: orphan block",
      "state: open",
      "title: Five",
      "number: 5",
      "state: open",
      "title: Six",
      "number: 6",
      "state: closed",
    ].join("\n");
    viewStates([a, b], result);
    expect(a).toMatchObject({ state: "opened", title: "Five" });
    expect(b).toMatchObject({ state: "closed", title: "Six" });

    const c = view("acme/billing#7", "issue");
    const d = view("acme/billing#8", "issue");
    const dup = [
      "title: Seven",
      "number: 7",
      "state: open",
      "source_branch: one",
      "title: Seven again",
      "number: 7",
      "state: closed",
      "source_branch: two",
      "title: Eight",
      "number: 8",
    ].join("\n");
    viewStates([c, d], dup);
    expect(c.state).toBeUndefined();
    expect(c.title).toBeUndefined();
    expect(c.branch).toBeUndefined();
    expect(d.title).toBe("Eight");
  });

  it("several items: a unique block fills state, title and branch together", () => {
    const a = view("acme/billing!5");
    const b = view("acme/billing!6");
    const result = [
      "title: Five",
      "number: 5",
      "state: open",
      "source_branch: feat-five",
      "title: Six",
      "number: 6",
    ].join("\n");
    viewStates([a, b], result);
    expect(a).toMatchObject({ title: "Five", state: "opened", branch: "feat-five" });
    expect(b.branch).toBeUndefined();
  });
});

describe("parsePushResult", () => {
  it("reads the branch from a tracking line when no ref line is printed", () => {
    expect(parsePushResult("branch 'feat-x' set up to track 'origin/feat-x'.\n")).toEqual({
      pushed: false,
      rejected: false,
      branch: "feat-x",
      deleted: undefined,
    });
  });

  it("a ref line proves the push and its target loses refs/heads/; a rejection disproves it", () => {
    expect(parsePushResult(" * [new branch]      feat -> refs/heads/feat\n")).toMatchObject({
      pushed: true,
      branch: "feat",
    });
    expect(
      parsePushResult(" ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs\n"),
    ).toMatchObject({
      pushed: false,
      rejected: true,
    });
    expect(parsePushResult(" - [deleted]         old-branch\n").deleted).toBe("old-branch");
  });
});

describe("gh / glab segment table", () => {
  it("a --head=/--source-branch= flag value gives the MR branch; an empty or owner-only head gives none", () => {
    expect(bash("gh pr create --head=feat-a --title x")[0]).toMatchObject({ verb: "opened_mr" });
    expect(segmentAction("gh pr create --head=someone:feat-a")).toMatchObject({ verb: "opened_mr", branch: "feat-a" });
    expect(segmentAction("gh pr create --head=")?.branch).toBeUndefined();
    expect(segmentAction("gh pr create --head someone:")?.branch).toBeUndefined();
    expect(segmentAction("glab mr create --source-branch=feat-b")).toMatchObject({
      verb: "opened_mr",
      branch: "feat-b",
    });
    expect(segmentAction("glab mr create -s feat-c")).toMatchObject({ verb: "opened_mr", branch: "feat-c" });
  });

  it.each([
    ["gh issue checkout 5", "an issue cannot be checked out"],
    ["gh issue review 5", "only a PR is reviewed"],
    ["gh pr", "no action word"],
    ["glab mr", "no action word"],
    ["glab", "no resource"],
    ["gh", "no resource"],
    ["gh release view v1", "not a pr/issue resource"],
    ["glab issue checkout 5", "an issue cannot be checked out"],
    ["glab issue approve 5", "only an MR is approved"],
    ["glab release view v1", "not an mr/issue resource"],
    ["gh pr merge 5 --auto", "auto-merge is not a merge"],
    ["glab mr merge 5 --when-pipeline-succeeds", "queued merge is not a merge"],
    ["gh pr edit 5", "edit without a triage flag"],
    ["glab mr update 5", "update without a triage flag"],
  ])("%s -> no action (%s)", (command) => {
    expect(segmentAction(command)).toBeNull();
  });

  it("an inline GH_REPO prefix retargets gh, qualifying the ref with no outer env map", () => {
    expect(segmentAction("GH_REPO=acme/billing gh pr view 5")).toMatchObject({
      verb: "viewed",
      refKind: "merge_request",
      ref: "acme/billing!5",
      toolHost: "github.com",
    });
  });

  it("the review flag decides approved vs commented, and glab's note/comment verbs both comment", () => {
    expect(segmentAction("gh pr review 5 --approve")?.verb).toBe("approved");
    expect(segmentAction("gh pr review 5 -a")?.verb).toBe("approved");
    expect(segmentAction("gh pr review 5 -c -b text")?.verb).toBe("commented");
    expect(segmentAction("glab mr note 5 -m text")?.verb).toBe("commented");
    expect(segmentAction("glab mr approve 5")?.verb).toBe("approved");
  });
});

describe("MCP tool mapping", () => {
  it("decodes a percent-encoded project id, keeps an undecodable one raw, and ignores a numeric id", () => {
    expect(mcp("get_merge_request", { project_id: "acme%2Fbilling", merge_request_iid: 5 })[0]).toMatchObject({
      verb: "viewed",
      ref: "acme/billing!5",
    });
    expect(mcp("get_merge_request", { project_id: "acme/bill%", merge_request_iid: 5 })[0].ref).toBe("acme/bill%!5");
    expect(mcp("get_merge_request", { project_id: "42", merge_request_iid: "6" })[0].ref).toBe("!6");
    expect(mcp("get_issue", { owner: "acme", repo: "billing", issue_number: 9 })[0]).toMatchObject({
      refKind: "issue",
      ref: "acme/billing#9",
    });
  });

  it("a merge's own result state counts unless the result shows a different item or is silent about it", () => {
    const input = { project_id: "acme/billing", merge_request_iid: 5 };
    expect(mcp("merge_merge_request", input, '{"iid":5,"state":"merged"}')[0]).toMatchObject({
      verb: "merged",
      state: "merged",
    });
    expect(mcp("merge_merge_request", input, '{"state":"merged"}')[0]).toMatchObject({ state: "merged" });
    expect(mcp("merge_merge_request", input, '{"iid":9,"state":"merged"}')[0].state).toBeUndefined();
    // No iid in the input, so a result naming any item is "another item".
    expect(
      mcp("merge_merge_request", { project_id: "acme/billing" }, '{"iid":9,"state":"merged"}')[0].state,
    ).toBeUndefined();
  });

  it("a merge whose result shows the item still open, or queued, is not a merge", () => {
    const input = { project_id: "acme/billing", merge_request_iid: 5 };
    expect(mcp("merge_merge_request", input, '{"iid":5,"state":"opened"}')).toEqual([]);
    expect(mcp("merge_merge_request", input, "Merge request will be merged when the pipeline succeeds")).toEqual([]);
    expect(mcp("merge_merge_request", { ...input, auto_merge: true })).toEqual([]);
  });

  it("a review's event decides approved vs commented (event, body_event, or neither)", () => {
    const base = { owner: "acme", repo: "billing", pull_number: 5 };
    expect(mcp("create_pull_request_review", { ...base, event: "approve" })[0].verb).toBe("approved");
    expect(mcp("create_pull_request_review", { ...base, body_event: "APPROVE" })[0].verb).toBe("approved");
    expect(mcp("create_pull_request_review", { ...base, event: "COMMENT" })[0].verb).toBe("commented");
    expect(mcp("create_pull_request_review", base)[0].verb).toBe("commented");
  });

  it("close_* closes; reopen_* needs a ref and a result that does not still show it closed", () => {
    expect(
      mcp("close_issue", { project_id: "acme/billing", issue_iid: 3 }, '{"iid":3,"state":"closed"}')[0],
    ).toMatchObject({
      verb: "closed",
      ref: "acme/billing#3",
      state: "closed",
    });
    expect(mcp("reopen_issue", {})).toEqual([]);
    const input = { project_id: "acme/billing", issue_iid: 3 };
    expect(mcp("reopen_issue", input, '{"iid":3,"state":"closed"}')).toEqual([]);
    expect(mcp("reopen_issue", input, '{"iid":3,"state":"opened"}')[0]).toMatchObject({
      verb: "reopened",
      state: "opened",
    });
  });

  it("an issue tool that is no recognised write verb yields nothing", () => {
    expect(mcp("transfer_issue", { project_id: "acme/billing", issue_iid: 3 })).toEqual([]);
  });

  it("create_merge_request takes its ref and URL from the result's web_url, or the first item URL in plain text", () => {
    expect(
      mcp(
        "create_merge_request",
        { project_id: "acme/billing" },
        `{"web_url":"${HOST}/acme/billing/-/merge_requests/17"}`,
      )[0],
    ).toMatchObject({
      verb: "opened_mr",
      ref: "acme/billing!17",
      refKind: "merge_request",
      url: `${HOST}/acme/billing/-/merge_requests/17`,
    });
    expect(
      mcp("create_merge_request", { project_id: "acme/billing" }, `Created ${HOST}/acme/billing/pull/18`)[0],
    ).toMatchObject({
      ref: "acme/billing!18",
    });
    // An issue URL in the result still parses as an item, and its kind replaces the tool's.
    const noUrl = mcp("create_merge_request", { project_id: "acme/billing" }, "created ok")[0];
    expect(noUrl.verb).toBe("opened_mr");
    expect(noUrl.ref).toBeUndefined();
  });

  it("a failed MCP call yields nothing unless its own result proved the action", () => {
    expect(mcp("create_merge_request", { project_id: "acme/billing" }, "boom", true)).toEqual([]);
    expect(
      mcp(
        "create_merge_request",
        { project_id: "acme/billing" },
        `{"web_url":"${HOST}/acme/billing/-/merge_requests/17"}`,
        true,
      ),
    ).toHaveLength(1);
  });
});

describe("Bash chain assembly", () => {
  it("cap trims, caps and drops blanks", () => {
    expect(cap("   ", 10)).toBeUndefined();
    expect(cap(undefined, 10)).toBeUndefined();
    expect(cap("  abcdef ", 3)).toBe("abc");
  });

  it("two merge commands: outcome lines tie to commands in order", () => {
    const result = "✓ Merged pull request #5\n✓ Merged pull request #6\n";
    const out = bash("gh pr merge 5 && gh pr merge 6", result);
    expect(out.map((a) => [a.verb, a.ref, a.state])).toEqual([
      ["merged", "!5", "merged"],
      ["merged", "!6", "merged"],
    ]);
  });

  it("two merge commands, one outcome line: the first is unproven and dropped, the last is proven by it", () => {
    const out = bash("gh pr merge 5 ; glab mr merge 6", "some noise\n✓ Merged\n");
    expect(out.map((a) => [a.verb, a.ref])).toEqual([["merged", "!6"]]);
  });

  it("two merge commands and no outcome line at all: neither is proven by output blocks", () => {
    expect(bash("gh pull-request merge 5 ; glab merge-request merge 6", "nothing printed\n")).toEqual([]);
  });

  it("an mr create's URL: glab's header ties to the URL numbered after it, even with a shared tail", () => {
    const result = `!17 Debits (feat-x)\n${HOST}/acme/billing/-/merge_requests/17\ndone\n`;
    expect(bash("glab mr create -s feat-x && echo done", result)[0]).toMatchObject({
      verb: "opened_mr",
      ref: "codehub.example/acme/billing!17",
      branch: "feat-x",
    });
  });

  it("an mr create with a shared tail takes only a single unambiguous URL", () => {
    const one = `${HOST}/acme/billing/pull/21\n${HOST}/acme/billing/pull/21\n`;
    expect(bash("gh pr create --title x && echo done", one)[0]).toMatchObject({
      ref: "codehub.example/acme/billing!21",
    });
    const two = `${HOST}/acme/billing/pull/21\n${HOST}/acme/billing/pull/22\n`;
    const ambiguous = bash("gh pr create --title x && echo done", two)[0];
    expect(ambiguous.verb).toBe("opened_mr");
    expect(ambiguous.ref).toBeUndefined();
    // Printed last with no tail: the last URL wins.
    expect(bash("gh pr create --title x", two)[0].ref).toBe("codehub.example/acme/billing!22");
  });

  it("a delete push with no branch named takes the branch from the result's [deleted] line", () => {
    const out = bash("git push -d", "To codehub.example:acme/billing.git\n - [deleted]         old-branch\n");
    expect(out[0]).toMatchObject({ verb: "closed", refKind: "branch", ref: "old-branch", branch: "old-branch" });
  });

  it("a rejected push is removed even when the harness did not flag an error", () => {
    const result = " ! [rejected]        feat -> feat (fetch first)\nerror: failed to push some refs\n";
    expect(bash("git push origin feat", result)).toEqual([]);
    expect(bash("git push --force origin feat", result)).toEqual([]);
  });
});

describe("createCommitShaBackfill", () => {
  const commitQ = (): ToolActionInput => ({
    toolName: "Bash",
    input: { command: 'git commit -q -m "wip"' },
    result: "",
  });
  const feed = (calls: ToolActionInput[]): ForgeAction[][] => {
    const backfill = createCommitShaBackfill();
    return calls.map((c) => {
      const actions = deriveToolActions(c);
      backfill.observe(c, actions);
      return actions;
    });
  };

  it("a default-format `git log` of HEAD gives the sha and the indented subject", () => {
    const log =
      "commit 1234567890abcdef1234567890abcdef12345678\nAuthor: A <a@codehub.example>\nDate: today\n\n    Fix debits\n";
    const [commit] = feed([commitQ(), { toolName: "Bash", input: { command: "git log -1" }, result: log }]);
    expect(commit[0]).toMatchObject({
      verb: "committed",
      sha: "1234567890abcdef1234567890abcdef12345678",
      subject: "Fix debits",
    });
  });

  it("a default-format log with only header lines gives a sha and no subject", () => {
    const log = "commit 1234567890abcdef1234567890abcdef12345678\nAuthor: A\nDate: today\n";
    const [commit] = feed([commitQ(), { toolName: "Bash", input: { command: "git log -1" }, result: log }]);
    expect(commit[0].sha).toBe("1234567890abcdef1234567890abcdef12345678");
    expect(commit[0].subject).toBeUndefined();
  });

  it("a oneline log gives the subject after the ref decoration, and none when only the decoration follows the sha", () => {
    const [withSubject] = feed([
      commitQ(),
      { toolName: "Bash", input: { command: "git log --oneline -1" }, result: "abc1234 (HEAD -> main) Fix debits\n" },
    ]);
    expect(withSubject[0]).toMatchObject({ sha: "abc1234", subject: "Fix debits" });
    const [bare] = feed([
      commitQ(),
      { toolName: "Bash", input: { command: "git log --oneline -1" }, result: "abc1234 (HEAD -> main)\n" },
    ]);
    expect(bare[0].sha).toBe("abc1234");
    expect(bare[0].subject).toBeUndefined();
  });

  it("rev-parse HEAD attaches the sha; rev-parse of anything else, extra flags or a non-sha tail do not", () => {
    const sha = "abcdef1234567";
    const [ok] = feed([
      commitQ(),
      { toolName: "Bash", input: { command: "git rev-parse --short HEAD" }, result: `${sha}\n` },
    ]);
    expect(ok[0].sha).toBe(sha);
    for (const [command, result] of [
      ["git rev-parse main", `${sha}\n`],
      ["git rev-parse --abbrev-ref HEAD", "main\n"],
      ["git rev-parse HEAD", "not a sha\n"],
      ["git rev-parse HEAD", ""],
    ] as const) {
      const [c] = feed([commitQ(), { toolName: "Bash", input: { command }, result }]);
      expect(c[0].sha, command).toBeUndefined();
    }
  });

  it("an empty log result, or a log with HEAD-excluding flags, attaches nothing", () => {
    const [empty] = feed([commitQ(), { toolName: "Bash", input: { command: "git log -1" }, result: "" }]);
    expect(empty[0].sha).toBeUndefined();
    const [all] = feed([
      commitQ(),
      { toolName: "Bash", input: { command: "git log --all -1" }, result: "abc1234 subject\n" },
    ]);
    expect(all[0].sha).toBeUndefined();
  });

  it("follows `git -C <dir>` (with -c and bare flags) so the query matches the commit's repo", () => {
    const commit: ToolActionInput = {
      toolName: "Bash",
      input: { command: 'git --no-pager -C /srv/billing -c core.x=1 commit -q -m "wip"' },
      result: "",
    };
    const query: ToolActionInput = {
      toolName: "Bash",
      input: { command: "git -C /srv/billing rev-parse HEAD" },
      result: "abcdef1234567\n",
    };
    expect(feed([commit, query])[0][0].sha).toBe("abcdef1234567");
    // A -C with no value falls back to the previous repo; a query in another repo does not match.
    const other: ToolActionInput = {
      toolName: "Bash",
      input: { command: "git -C /srv/other rev-parse HEAD" },
      result: "abcdef1234567\n",
    };
    expect(feed([commit, other])[0][0].sha).toBeUndefined();
    const dangling: ToolActionInput = { toolName: "Bash", input: { command: "git -C" }, result: "" };
    expect(() => feed([dangling])).not.toThrow();
  });

  it("tolerates env-only segments and a bare `cd` in the chain", () => {
    const calls: ToolActionInput[] = [
      commitQ(),
      { toolName: "Bash", input: { command: "FOO=1 && cd && git rev-parse HEAD" }, result: "abcdef1234567\n" },
    ];
    const [commit] = feed(calls);
    expect(commit[0].verb).toBe("committed");
  });

  it("ignores a Bash call with no command or no result, and never throws on a malformed call", () => {
    const backfill = createCommitShaBackfill();
    const actions: ForgeAction[] = [{ verb: "committed", refKind: "commit", source: "cli" }];
    backfill.observe({ toolName: "Bash", input: {}, result: "x" }, actions);
    backfill.observe({ toolName: "Bash", input: { command: "git rev-parse HEAD" } }, actions);
    backfill.observe({ toolName: "Read" }, actions);
    expect(() => backfill.observe({} as ToolActionInput, actions)).not.toThrow();
    expect(actions[0].sha).toBeUndefined();
  });
});

describe("entry-point wrappers degrade instead of throwing", () => {
  it("deriveToolActions returns [] for a malformed call", () => {
    expect(deriveToolActions({} as ToolActionInput)).toEqual([]);
    expect(deriveToolActions({ toolName: "Read", input: { file_path: "/x" } })).toEqual([]);
  });

  it("toolResultText joins text blocks and gives undefined for anything else", () => {
    expect(toolResultText("plain")).toBe("plain");
    expect(toolResultText([{ type: "text", text: "a" }, { type: "image" }, { type: "text", text: "b" }])).toBe("a\nb");
    expect(toolResultText([{ type: "image" }, null, 7])).toBeUndefined();
    expect(toolResultText([])).toBeUndefined();
    expect(toolResultText(42)).toBeUndefined();
    expect(toolResultText(null)).toBeUndefined();
  });

  it("parseSlashCommandMessage: no command name or no ref gives null; an empty skill name keeps only the args", () => {
    expect(parseSlashCommandMessage("just prose")).toBeNull();
    expect(
      parseSlashCommandMessage("<command-name>/review-mr</command-name><command-args>look at this</command-args>"),
    ).toBeNull();
    const out = parseSlashCommandMessage("<command-name>/</command-name><command-args>see #12</command-args>");
    expect(out?.text).toBe("see #12");
    expect(out?.action).toMatchObject({ verb: "referenced", ref: "#12", refKind: "issue", source: "command" });
    expect(out?.action.skill).toBeUndefined();
    const named = parseSlashCommandMessage("<command-name>/review-mr</command-name><command-args>!7</command-args>");
    expect(named?.action).toMatchObject({ ref: "!7", refKind: "merge_request", skill: "review-mr" });
  });

  it("the slash-line and paste parsers never throw on a hostile input", () => {
    const hostile = {
      toString() {
        throw new Error("boom");
      },
    } as unknown as string;
    expect(parseSlashCommandMessage(hostile)).toBeNull();
    expect(actionFromPastedText(hostile)).toBeUndefined();
    expect(actionFromPastedText(`see ${HOST}/acme/billing/-/issues/4 please`)).toMatchObject({
      verb: "referenced",
      ref: "acme/billing#4",
      source: "paste",
    });
  });
});
