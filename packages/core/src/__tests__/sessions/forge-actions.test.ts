// Goal 2026-09-26 W3 / P1 (D-051) — structured forge actions survive import.
//
// Every test feeds a REAL-SHAPED transcript through the parser (Claude Code
// JSONL events or an opencode SQLite export) and asserts the action a turn
// yields — never a hand-built row that skips the parser. Fictional host
// `codehub.example`, project `acme/billing` throughout.
import { describe, expect, it } from "vitest";
import { claudeCodeParser } from "../../sessions/claude-code.js";
import type { ForgeAction } from "../../sessions/forge-actions.js";
import { deriveToolActions, settleActionDir, splitShellChain } from "../../sessions/forge-actions.js";
import { opencodeParser } from "../../sessions/opencode.js";
import type { RawCodeSession, RawTurn } from "../../sessions/types.js";

// ---------------------------------------------------------------------------
// Claude Code fixture builders — the exact event shapes `~/.claude/projects/
// <cwd>/<session>.jsonl` carries (see the checked-in fixtures next to this file).
// ---------------------------------------------------------------------------

const SESSION_ID = "77777777-7777-4777-8777-777777777777";
const CC_REF = { source: "claude-code", sourceSessionId: SESSION_ID, path: "n/a" };
let clock = 0;
function ts(): string {
  clock += 1;
  return `2026-09-26T09:${String(Math.floor(clock / 60)).padStart(2, "0")}:${String(clock % 60).padStart(2, "0")}.000Z`;
}

function ccUser(text: string, extra: Record<string, unknown> = {}): object {
  return {
    type: "user",
    message: { role: "user", content: text },
    isMeta: null,
    cwd: "/home/dev/billing",
    gitBranch: "15178-5-idempotent-debits",
    timestamp: ts(),
    sessionId: SESSION_ID,
    ...extra,
  };
}

interface ToolCallOpts {
  isError?: boolean;
  mcpServer?: string;
  mcpTool?: string;
  /** tool_result content as an array of text blocks instead of a string. */
  arrayResult?: boolean;
  /** Omit the tool_result event entirely (the session ended mid-call). */
  noResult?: boolean;
}

function ccTool(
  id: string,
  name: string,
  input: Record<string, unknown>,
  result: string,
  opts: ToolCallOpts = {},
): object[] {
  const assistant: Record<string, unknown> = {
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
  };
  if (opts.mcpServer) assistant.attributionMcpServer = opts.mcpServer;
  if (opts.mcpTool) assistant.attributionMcpTool = opts.mcpTool;
  const events: object[] = [assistant];
  if (!opts.noResult) {
    events.push({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: id,
            is_error: opts.isError === true,
            content: opts.arrayResult ? [{ type: "text", text: result }] : result,
          },
        ],
      },
      toolUseResult: { stdout: result },
      timestamp: ts(),
      sessionId: SESSION_ID,
    });
  }
  return events;
}

function bash(id: string, command: string, result: string, opts: ToolCallOpts = {}): object[] {
  return ccTool(id, "Bash", { command, description: "run" }, result, opts);
}

function parseCCRaw(events: object[]): RawCodeSession {
  const raw = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
  return claudeCodeParser.parse(CC_REF, raw);
}

/**
 * Drop each action's LOCAL-ONLY `dir`/`shownRepo` (D-051 F1: where the command ran, settled
 * to a repo by the importer and never uploaded). The F1 tests read it through
 * `parseCCRaw`; every other test asserts the uploaded shape.
 */
function stripDirs(session: RawCodeSession): RawCodeSession {
  const strip = (a: ForgeAction): ForgeAction => {
    const { dir: _dir, shownRepo: _shown, ...rest } = a;
    return rest;
  };
  for (const t of session.turns) {
    if (t.action) t.action = strip(t.action);
    if (t.actions) t.actions = t.actions.map(strip);
  }
  return session;
}

function parseCC(events: object[]): RawCodeSession {
  return stripDirs(parseCCRaw(events));
}

function toolTurn(session: RawCodeSession, id: string): RawTurn {
  const turn = session.turns.find((t) => t.kind === "tool_use" && t.toolUseId === id);
  if (!turn) throw new Error(`no tool_use turn ${id}`);
  return turn;
}

/** The tool_result turn that follows a tool_use — its text must always be the elided sentinel (B10). */
function resultTurn(session: RawCodeSession, id: string): RawTurn {
  const idx = toolTurn(session, id).idx;
  const next = session.turns[idx + 1];
  if (!next || next.kind !== "tool_result") throw new Error(`no tool_result turn after ${id}`);
  return next;
}

function expectElided(session: RawCodeSession, id: string, status: "ok" | "error" = "ok"): void {
  expect(resultTurn(session, id).text).toBe(`[tool_result elided: ${status}]`);
}

/** One Bash call with its result → the tool_use turn's action, asserting the result text was elided. */
function bashAction(command: string, result: string, opts: ToolCallOpts = {}): ForgeAction | undefined {
  const session = parseCC([ccUser("go"), ...bash("tu_1", command, result, opts)]);
  expectElided(session, "tu_1", opts.isError ? "error" : "ok");
  // The raw result text never reaches stored turn text (B10) — checked on
  // its first line when that line is distinctive enough not to be a
  // substring of the sentinel itself.
  const firstLine = result.split("\n")[0];
  if (firstLine.length >= 8) {
    const allText = session.turns.map((t) => t.text ?? "").join("\n");
    expect(allText).not.toContain(firstLine);
  }
  return toolTurn(session, "tu_1").action;
}

const COMMIT_RESULT =
  "[15178-5-idempotent-debits d7e5977] make debit posting idempotent\n 2 files changed, 41 insertions(+), 3 deletions(-)";
const PUSH_RESULT =
  "remote: \nremote: To create a merge request for 15178-5-idempotent-debits, visit:\nremote:   https://codehub.example/acme/billing/-/merge_requests/new?merge_request%5Bsource_branch%5D=15178-5-idempotent-debits\nremote: \nTo codehub.example:acme/billing.git\n * [new branch]      15178-5-idempotent-debits -> 15178-5-idempotent-debits\nbranch '15178-5-idempotent-debits' set up to track 'origin/15178-5-idempotent-debits'.";

// ---------------------------------------------------------------------------
// B14 git table — delivery class
// ---------------------------------------------------------------------------

describe("forge action — git delivery class (Claude Code Bash)", () => {
  it("B1: `git commit` yields committed with the sha, branch and subject parsed from `[branch sha] subject`, and the result text is still elided", () => {
    const session = parseCC([
      ccUser("commit it"),
      ...bash("tu_commit", 'git commit -m "make debit posting idempotent"', COMMIT_RESULT),
    ]);
    const turn = toolTurn(session, "tu_commit");
    expect(turn.toolName).toBe("Bash");
    expect(turn.action).toEqual({
      verb: "committed",
      refKind: "commit",
      sha: "d7e5977",
      branch: "15178-5-idempotent-debits",
      subject: "make debit posting idempotent",
      source: "cli",
    });
    expect(turn.actions).toBeUndefined();
    expectElided(session, "tu_commit");
    // The sha is nowhere in stored text — only in the structured extract.
    expect(session.turns.map((t) => t.text ?? "").join("\n")).not.toContain("d7e5977");
  });

  it("B10: a commit message carrying an API key yields the sha and a REDACTED subject, and the row text is still `[tool_result elided: ok]`", () => {
    const secret = "sk-testFAKEKEY1234567890abcdef";
    const session = parseCC([
      ccUser("commit"),
      ...bash(
        "tu_c",
        `git commit -m "wire billing api_key=${secret}"`,
        `[main 0a1b2c3] wire billing api_key=${secret}\n 1 file changed`,
      ),
    ]);
    const action = toolTurn(session, "tu_c").action;
    expect(action?.verb).toBe("committed");
    expect(action?.sha).toBe("0a1b2c3");
    expect(action?.subject).toContain("[REDACTED]");
    expect(JSON.stringify(session)).not.toContain(secret);
    expectElided(session, "tu_c");
  });

  it("`git push` yields pushed with the branch taken from the result's `X -> X` line", () => {
    expect(bashAction("git push -u origin HEAD", PUSH_RESULT)).toEqual({
      verb: "pushed",
      ref: "15178-5-idempotent-debits",
      refKind: "branch",
      branch: "15178-5-idempotent-debits",
      source: "cli",
    });
  });

  it("`git push origin <branch>` with only `Everything up-to-date` still yields pushed with the branch from the args", () => {
    expect(bashAction("git push origin fix/rounding", "Everything up-to-date")).toMatchObject({
      verb: "pushed",
      ref: "fix/rounding",
      branch: "fix/rounding",
    });
  });

  it("`git cherry-pick` and `git revert` yield committed with the sha from the result", () => {
    expect(
      bashAction("git cherry-pick abc1234", "[release/2.4 9f8e7d6] backport rounding fix\n 1 file changed"),
    ).toMatchObject({
      verb: "committed",
      sha: "9f8e7d6",
      branch: "release/2.4",
    });
    expect(bashAction("git revert --no-edit HEAD", '[main 1234abc] Revert "bad idea"')).toMatchObject({
      verb: "committed",
      sha: "1234abc",
      subject: 'Revert "bad idea"',
    });
  });

  it("`git merge` prints no `[branch sha]` line → committed with no sha (shown unverified)", () => {
    const action = bashAction("git merge --no-ff feature/x", "Merge made by the 'ort' strategy.\n src/a.ts | 2 +-");
    expect(action).toMatchObject({ verb: "committed", refKind: "commit" });
    expect(action?.sha).toBeUndefined();
  });

  it("a root commit and a detached-HEAD commit still parse their sha", () => {
    expect(bashAction("git commit -m init", "[main (root-commit) abcdef1] init")).toMatchObject({
      verb: "committed",
      sha: "abcdef1",
      branch: "main",
    });
    const detached = bashAction("git commit -m x", "[detached HEAD fedcba9] x");
    expect(detached).toMatchObject({ verb: "committed", sha: "fedcba9" });
    expect(detached?.branch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B14 git table — closure, rewrite, checkout, navigation classes
// ---------------------------------------------------------------------------

describe("forge action — git closure class", () => {
  it("`gh pr merge` / `glab mr merge` yield merged (state merged when the result says so)", () => {
    expect(bashAction("gh pr merge 42 --squash", "✓ Squashed and merged pull request #42 (fix rounding)")).toEqual({
      verb: "merged",
      ref: "!42",
      refKind: "merge_request",
      state: "merged",
      source: "cli",
    });
    expect(bashAction("glab mr merge 17049 --yes", "✓ Merged")).toMatchObject({
      verb: "merged",
      ref: "!17049",
      state: "merged",
    });
  });

  it("`gh pr close`, `glab mr close`, `glab issue close`, `gh issue close` yield closed on that ref", () => {
    expect(bashAction("gh pr close 42", "✓ Closed pull request #42")).toMatchObject({
      verb: "closed",
      ref: "!42",
      refKind: "merge_request",
    });
    expect(
      bashAction("glab mr close 17049", "- Closing Merge request !17049...\n✓ Closed Merge request !17049"),
    ).toMatchObject({
      verb: "closed",
      ref: "!17049",
    });
    expect(bashAction("glab issue close 16002", "✓ Closed Issue #16002")).toMatchObject({
      verb: "closed",
      ref: "#16002",
      refKind: "issue",
    });
    expect(bashAction("gh issue close 9 --reason completed", "✓ Closed issue #9")).toMatchObject({
      verb: "closed",
      ref: "#9",
      refKind: "issue",
    });
  });

  it("`git push --delete <branch>` and `git branch -D <branch>` yield closed on the branch", () => {
    expect(
      bashAction(
        "git push origin --delete 15178-5-idempotent-debits",
        "To codehub.example:acme/billing.git\n - [deleted]         15178-5-idempotent-debits",
      ),
    ).toEqual({
      verb: "closed",
      ref: "15178-5-idempotent-debits",
      refKind: "branch",
      branch: "15178-5-idempotent-debits",
      source: "cli",
    });
    expect(bashAction("git branch -D old/experiment", "Deleted branch old/experiment (was 1a2b3c4).")).toMatchObject({
      verb: "closed",
      refKind: "branch",
      ref: "old/experiment",
    });
  });
});

describe("forge action — git rewrite class", () => {
  it("`git rebase` yields rewrote, never a ladder verb", () => {
    expect(
      bashAction("git rebase -i origin/main", "Successfully rebased and updated refs/heads/15178-5-idempotent-debits."),
    ).toEqual({
      verb: "rewrote",
      refKind: "branch",
      source: "cli",
    });
  });

  it("`git commit --amend` yields rewrote carrying the NEW sha, not a fresh committed", () => {
    const action = bashAction(
      "git commit --amend --no-edit",
      "[15178-5-idempotent-debits e1f2a3b] make debit posting idempotent\n Date: ...",
    );
    expect(action).toMatchObject({
      verb: "rewrote",
      refKind: "commit",
      sha: "e1f2a3b",
      branch: "15178-5-idempotent-debits",
    });
  });

  it("`git push --force`, `-f` and `--force-with-lease` yield rewrote on the branch (from the result's `->` line)", () => {
    const forced =
      "To codehub.example:acme/billing.git\n + a1b2c3d...e4f5a6b 15178-5-idempotent-debits -> 15178-5-idempotent-debits (forced update)";
    for (const cmd of [
      "git push --force",
      "git push -f origin HEAD",
      "git push --force-with-lease origin 15178-5-idempotent-debits",
    ]) {
      expect(bashAction(cmd, forced)).toMatchObject({
        verb: "rewrote",
        refKind: "branch",
        branch: "15178-5-idempotent-debits",
      });
    }
  });

  it("`git reset --hard` yields rewrote; a plain `git reset <file>` (unstage) is only navigation", () => {
    expect(bashAction("git reset --hard origin/main", "HEAD is now at 1a2b3c4 tidy")).toMatchObject({
      verb: "rewrote",
    });
    expect(bashAction("git reset src/debits.ts", "Unstaged changes after reset:\nM\tsrc/debits.ts")).toMatchObject({
      verb: "navigated",
    });
  });
});

describe("forge action — git checkout and navigation classes", () => {
  it("`git checkout <branch>` / `git switch <branch>` are navigation carrying the branch, no ladder verb", () => {
    expect(
      bashAction("git checkout 15178-5-idempotent-debits", "Switched to branch '15178-5-idempotent-debits'"),
    ).toEqual({
      verb: "navigated",
      ref: "15178-5-idempotent-debits",
      refKind: "branch",
      branch: "15178-5-idempotent-debits",
      branchConfirmed: true,
      source: "cli",
    });
    expect(bashAction("git switch -c fix/rounding", "Switched to a new branch 'fix/rounding'")).toMatchObject({
      verb: "navigated",
      branch: "fix/rounding",
      branchConfirmed: true,
    });
  });

  it("W3 D9: a plain checkout with no `Switched to` line keeps its ref and branch but is not branchConfirmed", () => {
    const path = bashAction("git checkout src/ledger.ts", "Updated 1 path from the index");
    expect(path).toMatchObject({ verb: "navigated", ref: "src/ledger.ts", refKind: "branch" });
    expect(path?.branchConfirmed).toBeUndefined();
    const sha = bashAction("git checkout 53ab3ed", "HEAD is now at 53ab3ed Fix totals");
    expect(sha?.branch).toBe("53ab3ed");
    expect(sha?.branchConfirmed).toBeUndefined();
  });

  it("`git worktree add <path> <branch>` records the branch; `worktree remove`, `pull`, `fetch`, `status`, `log` record no ref", () => {
    expect(
      bashAction(
        "git worktree add ../billing-wt 15178-5-idempotent-debits",
        "Preparing worktree (checking out '15178-5-idempotent-debits')",
      ),
    ).toMatchObject({
      verb: "navigated",
      branch: "15178-5-idempotent-debits",
    });
    for (const cmd of [
      "git worktree remove ../billing-wt",
      "git pull --rebase",
      "git fetch origin",
      "git status --short",
      "git log --oneline -5",
    ]) {
      const action = bashAction(cmd, "ok");
      expect(action?.verb).toBe("navigated");
      expect(action?.ref).toBeUndefined();
    }
  });

  it("a navigation-class command keeps its digest (widened FORGE_COMMAND) while contributing no ladder verb", () => {
    const session = parseCC([ccUser("look"), ...bash("tu_s", "git status", "On branch main")]);
    expect(toolTurn(session, "tu_s").inputDigest).toBe("git status");
    expect(toolTurn(session, "tu_s").action?.verb).toBe("navigated");
  });
});

// ---------------------------------------------------------------------------
// gh / glab forge CLIs
// ---------------------------------------------------------------------------

describe("forge action — gh and glab review ladder", () => {
  it("`gh pr create` yields opened_mr with the URL and qualified ref from the result", () => {
    expect(
      bashAction('gh pr create --title "Fix rounding" --body "..."', "https://codehub.example/acme/billing/pull/4711"),
    ).toEqual({
      verb: "opened_mr",
      ref: "codehub.example/acme/billing!4711",
      refKind: "merge_request",
      url: "https://codehub.example/acme/billing/pull/4711",
      source: "cli",
    });
  });

  it("`glab mr create` yields opened_mr with the glab-shaped URL and the source branch glab printed", () => {
    const result =
      "Creating merge request for 15178-5-idempotent-debits into main in acme/billing\n\n!17050 Make debit posting idempotent (15178-5-idempotent-debits)\n https://codehub.example/acme/billing/-/merge_requests/17050";
    expect(bashAction('glab mr create --fill --yes --title "Make debit posting idempotent"', result)).toEqual({
      verb: "opened_mr",
      ref: "codehub.example/acme/billing!17050",
      refKind: "merge_request",
      url: "https://codehub.example/acme/billing/-/merge_requests/17050",
      branch: "15178-5-idempotent-debits",
      source: "cli",
    });
  });

  it("`gh pr view` yields viewed with the state parsed from the result", () => {
    expect(bashAction("gh pr view 4711", "title:\tFix rounding\nstate:\tMERGED\nauthor:\tdev\n")).toEqual({
      verb: "viewed",
      ref: "!4711",
      refKind: "merge_request",
      state: "merged",
      title: "Fix rounding",
      source: "cli",
    });
    expect(bashAction("gh pr view 12 --json state", '{"state":"OPEN"}')).toMatchObject({
      verb: "viewed",
      state: "opened",
    });
  });

  it("`glab mr view` and `glab mr diff` yield viewed; `glab issue view` yields viewed on the issue with its state", () => {
    expect(bashAction("glab mr view 17049", "title:\tReview debits\nstate:\topened\nauthor:\tdev")).toEqual({
      verb: "viewed",
      ref: "!17049",
      refKind: "merge_request",
      state: "opened",
      title: "Review debits",
      source: "cli",
    });
    expect(bashAction("glab mr diff 17049", "diff --git a/src/debits.ts b/src/debits.ts")).toMatchObject({
      verb: "viewed",
      ref: "!17049",
    });
    expect(
      bashAction("glab issue view 16002 --output json", '{"iid":16002,"state":"closed","title":"Debit posted twice"}'),
    ).toEqual({
      verb: "viewed",
      ref: "#16002",
      refKind: "issue",
      state: "closed",
      source: "cli",
    });
  });

  it("`gh pr checkout` and `glab mr checkout` yield checked_out", () => {
    expect(bashAction("gh pr checkout 4711", "Switched to branch 'fix-rounding'")).toEqual({
      verb: "checked_out",
      ref: "!4711",
      refKind: "merge_request",
      branch: "fix-rounding",
      source: "cli",
    });
    expect(bashAction("glab mr checkout 17049", "Switched to branch 'review-debits'")).toMatchObject({
      verb: "checked_out",
      ref: "!17049",
    });
  });

  it("`gh pr comment`, `glab mr note` and `glab issue note` yield commented (the note body is never stored)", () => {
    const body = "The rounding branch double-posts on retry";
    const session = parseCC([
      ccUser("post it"),
      ...bash(
        "tu_note",
        `glab mr note 17049 -m "${body}"`,
        "https://codehub.example/acme/billing/-/merge_requests/17049#note_991",
      ),
    ]);
    expect(toolTurn(session, "tu_note").action).toEqual({
      verb: "commented",
      ref: "!17049",
      refKind: "merge_request",
      source: "cli",
    });
    expectElided(session, "tu_note");
    expect(
      bashAction('gh pr comment 4711 --body "LGTM"', "https://codehub.example/acme/billing/pull/4711#issuecomment-1"),
    ).toMatchObject({ verb: "commented", ref: "!4711" });
    expect(bashAction('glab issue note 16002 -m "repro attached"', "ok")).toMatchObject({
      verb: "commented",
      ref: "#16002",
      refKind: "issue",
    });
  });

  it("`gh pr review --approve` and `glab mr approve` yield approved; `gh pr review --comment` is only commented", () => {
    expect(bashAction("gh pr review 4711 --approve", "✓ Approved pull request #4711")).toEqual({
      verb: "approved",
      ref: "!4711",
      refKind: "merge_request",
      source: "cli",
    });
    expect(bashAction("glab mr approve 17049", "- Approving Merge Request !17049\n✓ Approved")).toMatchObject({
      verb: "approved",
      ref: "!17049",
    });
    expect(bashAction('gh pr review 4711 --comment -b "nit"', "✓ Reviewed pull request #4711")).toMatchObject({
      verb: "commented",
    });
  });

  it("`glab issue update --label` and `gh issue edit --add-assignee/--milestone` yield triaged; an edit with no triage flag yields nothing", () => {
    expect(bashAction("glab issue update 16002 --label needs-design", "✓ Updated issue #16002")).toEqual({
      verb: "triaged",
      ref: "#16002",
      refKind: "issue",
      source: "cli",
    });
    expect(
      bashAction(
        "gh issue edit 9 --add-assignee dev --milestone v2.4",
        "https://codehub.example/acme/billing/issues/9",
      ),
    ).toMatchObject({ verb: "triaged", ref: "#9" });
    expect(bashAction('gh issue edit 9 --title "better title"', "ok")).toBeUndefined();
  });

  it("`-R owner/repo` qualifies the ref; a URL positional carries ref and url; a branch positional is kept as branch", () => {
    // v3 item 6: gh talks to github.com unless told otherwise — the ref carries that host.
    expect(bashAction("gh pr view 4711 -R acme/billing", "state:\tOPEN")).toMatchObject({
      ref: "github.com/acme/billing!4711",
      state: "opened",
    });
    expect(
      bashAction("glab mr view https://codehub.example/acme/billing/-/merge_requests/17049", "state:\topened"),
    ).toMatchObject({
      ref: "codehub.example/acme/billing!17049",
      url: "https://codehub.example/acme/billing/-/merge_requests/17049",
    });
    const byBranch = bashAction("gh pr view fix-rounding", "state:\tOPEN");
    expect(byBranch).toMatchObject({ verb: "viewed", branch: "fix-rounding" });
    expect(byBranch?.ref).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Forge MCP tools
// ---------------------------------------------------------------------------

describe("forge action — gitlab/github MCP tools (source mcp)", () => {
  function mcp(
    tool: string,
    input: Record<string, unknown>,
    result: string,
    opts: ToolCallOpts = {},
  ): ForgeAction | undefined {
    const session = parseCC([
      ccUser("use the mcp"),
      ...ccTool("tu_mcp", `mcp__gitlab__${tool}`, input, result, { mcpServer: "gitlab", mcpTool: tool, ...opts }),
    ]);
    expectElided(session, "tu_mcp", opts.isError ? "error" : "ok");
    const turn = toolTurn(session, "tu_mcp");
    expect(turn.mcpTool).toBe(tool);
    return turn.action;
  }

  it("a glab `get_merge_request` call yields viewed with the qualified ref and the state from the JSON result", () => {
    expect(
      mcp(
        "get_merge_request",
        { project_id: "acme/billing", merge_request_iid: 17049 },
        '{"iid":17049,"state":"opened","title":"Review debits"}',
      ),
    ).toEqual({
      verb: "viewed",
      ref: "acme/billing!17049",
      refKind: "merge_request",
      state: "opened",
      title: "Review debits",
      source: "mcp",
    });
    expect(
      mcp("get_issue", { project_id: "acme%2Fbilling", issue_iid: "16002" }, '{"iid":16002,"state":"closed"}'),
    ).toMatchObject({
      verb: "viewed",
      ref: "acme/billing#16002",
      refKind: "issue",
      state: "closed",
    });
  });

  it("an MCP `get_issue` with no `title` in its JSON result carries no title", () => {
    expect(
      mcp("get_issue", { project_id: "acme/billing", issue_iid: 16002 }, '{"iid":16002,"state":"closed"}'),
    ).toEqual({
      verb: "viewed",
      ref: "acme/billing#16002",
      refKind: "issue",
      state: "closed",
      source: "mcp",
    });
  });

  it("`create_merge_request_note` / `create_issue_note` yield commented; `approve_merge_request` yields approved", () => {
    expect(
      mcp(
        "create_merge_request_note",
        { project_id: "acme/billing", merge_request_iid: 17049, body: "nit" },
        '{"id":991}',
      ),
    ).toEqual({
      verb: "commented",
      ref: "acme/billing!17049",
      refKind: "merge_request",
      source: "mcp",
    });
    expect(
      mcp("create_issue_note", { project_id: "acme/billing", issue_iid: 16002, body: "repro" }, "{}"),
    ).toMatchObject({ verb: "commented", ref: "acme/billing#16002" });
    expect(mcp("approve_merge_request", { project_id: "acme/billing", merge_request_iid: 17049 }, "{}")).toMatchObject({
      verb: "approved",
      ref: "acme/billing!17049",
    });
  });

  it("`create_merge_request` yields opened_mr with the web_url; `merge_merge_request` yields merged", () => {
    expect(
      mcp(
        "create_merge_request",
        { project_id: "acme/billing", source_branch: "15178-5", target_branch: "main", title: "x" },
        '{"iid":17050,"web_url":"https://codehub.example/acme/billing/-/merge_requests/17050","state":"opened"}',
      ),
    ).toEqual({
      verb: "opened_mr",
      ref: "acme/billing!17050",
      refKind: "merge_request",
      url: "https://codehub.example/acme/billing/-/merge_requests/17050",
      source: "mcp",
    });
    expect(
      mcp("merge_merge_request", { project_id: "acme/billing", merge_request_iid: 17050 }, '{"state":"merged"}'),
    ).toMatchObject({ verb: "merged", ref: "acme/billing!17050", state: "merged" });
  });

  it("`update_issue` with labels yields triaged, with `state_event: close` yields closed, with neither yields nothing", () => {
    expect(
      mcp("update_issue", { project_id: "acme/billing", issue_iid: 16002, labels: ["needs-design"] }, "{}"),
    ).toMatchObject({ verb: "triaged", ref: "acme/billing#16002" });
    expect(
      mcp("update_issue", { project_id: "acme/billing", issue_iid: 16002, state_event: "close" }, '{"state":"closed"}'),
    ).toMatchObject({ verb: "closed", state: "closed" });
    expect(
      mcp("update_issue", { project_id: "acme/billing", issue_iid: 16002, title: "renamed" }, "{}"),
    ).toBeUndefined();
  });

  it("GitHub MCP names map the same way: pull_request_read → viewed, add_issue_comment → commented, pull_request_review_write APPROVE → approved, merge_pull_request → merged, issue_write with labels → triaged", () => {
    const gh = { owner: "acme", repo: "billing" };
    expect(
      mcp("pull_request_read", { ...gh, pullNumber: 4711, method: "get" }, '{"number":4711,"state":"open"}'),
    ).toMatchObject({ verb: "viewed", ref: "acme/billing!4711", state: "opened" });
    expect(mcp("add_issue_comment", { ...gh, issue_number: 9, body: "hi" }, "{}")).toMatchObject({
      verb: "commented",
      ref: "acme/billing#9",
      refKind: "issue",
    });
    expect(
      mcp("pull_request_review_write", { ...gh, pullNumber: 4711, method: "create", event: "APPROVE" }, "{}"),
    ).toMatchObject({ verb: "approved", ref: "acme/billing!4711" });
    expect(
      mcp("pull_request_review_write", { ...gh, pullNumber: 4711, method: "create", event: "COMMENT" }, "{}"),
    ).toMatchObject({ verb: "commented" });
    expect(mcp("merge_pull_request", { ...gh, pullNumber: 4711 }, '{"merged":true}')).toMatchObject({ verb: "merged" });
    expect(mcp("issue_write", { ...gh, issue_number: 9, method: "update", labels: ["bug"] }, "{}")).toMatchObject({
      verb: "triaged",
      ref: "acme/billing#9",
    });
    expect(
      mcp(
        "create_pull_request",
        { ...gh, head: "fix", base: "main", title: "t" },
        '{"html_url":"https://codehub.example/acme/billing/pull/4712"}',
      ),
    ).toMatchObject({ verb: "opened_mr", ref: "acme/billing!4712" });
  });

  it("list_merge_request_notes is a read, never commented", () => {
    // The read rule runs before the `_notes` rule: fetching a thread is not posting to it (F3).
    expect(
      mcp("list_merge_request_notes", { project_id: "acme/billing", merge_request_iid: 17049 }, '[{"body":"nit"}]'),
    ).toMatchObject({ verb: "viewed", ref: "acme/billing!17049", refKind: "merge_request" });
    // Without an item id a listing of notes is nothing at all, exactly like `list_merge_requests`.
    expect(mcp("list_merge_request_notes", { project_id: "acme/billing" }, "[]")).toBeUndefined();
  });

  it("get_issue_comments is viewed", () => {
    expect(mcp("get_issue_comments", { owner: "acme", repo: "billing", issue_number: 9 }, "[]")).toMatchObject({
      verb: "viewed",
      ref: "acme/billing#9",
      refKind: "issue",
    });
    // Posting one is still commented.
    expect(mcp("create_issue_note", { project_id: "acme/billing", issue_iid: 9, body: "x" }, "{}")).toMatchObject({
      verb: "commented",
    });
  });

  it("a `get_merge_request`/`get_pull_request` JSON result carries the source/head branch", () => {
    expect(
      mcp(
        "get_merge_request",
        { project_id: "acme/billing", merge_request_iid: 17049 },
        '{"iid":17049,"state":"opened","title":"Review debits","source_branch":"17049-docs","target_branch":"main"}',
      ),
    ).toMatchObject({ verb: "viewed", ref: "acme/billing!17049", branch: "17049-docs" });
    // GitHub's shape nests the head branch under `head.ref`.
    const gh = { owner: "acme", repo: "billing" };
    expect(
      mcp(
        "pull_request_read",
        { ...gh, pullNumber: 4711, method: "get" },
        '{"number":4711,"state":"open","head":{"ref":"e2e/ia-python","sha":"abc1234"},"base":{"ref":"main"}}',
      ),
    ).toMatchObject({ verb: "viewed", ref: "acme/billing!4711", branch: "e2e/ia-python" });
  });

  it("a `list_*` call naming no item, a non-forge MCP tool and a failed call yield no action", () => {
    expect(mcp("list_merge_requests", { project_id: "acme/billing", state: "opened" }, "[]")).toBeUndefined();
    expect(mcp("search_repositories", { search: "billing" }, "[]")).toBeUndefined();
    expect(
      mcp("get_merge_request", { project_id: "acme/billing", merge_request_iid: 1 }, "404 Not Found", {
        isError: true,
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// B13 — the slash line names the ref; a pasted URL names the ref
// ---------------------------------------------------------------------------

const SLASH_LINE =
  "<command-name>/review-mr</command-name>\n<command-message>review-mr</command-message>\n<command-args>this is the MR we are reviewing https://codehub.example/acme/billing/-/merge_requests/17049</command-args>";

describe("forge action — slash line (source command, B13)", () => {
  it("emits one user prose turn carrying the ref from the args, the skill as a label and no verb, while the XML wrapper is not stored", () => {
    const session = parseCC([
      ccUser(SLASH_LINE),
      ...bash("tu_co", "glab mr checkout 17049", "Switched to branch 'review-debits'"),
    ]);
    const prose = session.turns.filter((t) => t.role === "user" && t.kind === "prose");
    expect(prose).toHaveLength(1);
    expect(prose[0].action).toEqual({
      verb: "referenced",
      ref: "acme/billing!17049",
      refKind: "merge_request",
      url: "https://codehub.example/acme/billing/-/merge_requests/17049",
      skill: "review-mr",
      source: "command",
    });
    expect(prose[0].text).toBe(
      "/review-mr this is the MR we are reviewing https://codehub.example/acme/billing/-/merge_requests/17049",
    );
    expect(prose[0].text).not.toContain("<command-name>");
    expect(prose[0].text).not.toContain("<command-args>");
    // The verb comes from what follows, never from the skill's name.
    expect(toolTurn(session, "tu_co").action?.verb).toBe("checked_out");
  });

  it("renaming the skill to a nonsense word changes only the label — ref, kind, url and verb are identical", () => {
    const renamed = SLASH_LINE.replaceAll("review-mr", "zorblax");
    const a = parseCC([ccUser(SLASH_LINE)]).turns[0].action;
    const b = parseCC([ccUser(renamed)]).turns[0].action;
    expect(b?.skill).toBe("zorblax");
    expect({ ...a, skill: undefined }).toEqual({ ...b, skill: undefined });
  });

  it("args carrying a bare `#N` or `!N` name the ref too", () => {
    const issue = parseCC([
      ccUser(
        "<command-name>/fix</command-name>\n<command-message>fix</command-message>\n<command-args>start on #15178 today</command-args>",
      ),
    ]);
    expect(issue.turns[0].action).toEqual({
      verb: "referenced",
      ref: "#15178",
      refKind: "issue",
      skill: "fix",
      source: "command",
    });
    const mr = parseCC([ccUser("<command-name>/review</command-name>\n<command-args>!17049</command-args>")]);
    expect(mr.turns[0].action).toMatchObject({ ref: "!17049", refKind: "merge_request" });
  });

  it("a slash line naming no ref (`/compact`, `/clear`) is still skipped, as are the other meta-wrapped messages", () => {
    const session = parseCC([
      ccUser("<command-name>/compact</command-name>"),
      ccUser(
        "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>",
      ),
      ccUser("<local-command-stdout>Compacted</local-command-stdout>"),
      ccUser("<system-reminder>reminder</system-reminder>"),
      ccUser("real question"),
    ]);
    expect(session.turns.map((t) => t.text)).toEqual(["real question"]);
  });
});

describe("forge action — pasted forge URL in user prose (source paste)", () => {
  it("a pasted MR URL yields a `referenced` action on the prose turn, text unchanged", () => {
    const text = "here is the MR https://codehub.example/acme/billing/-/merge_requests/17049 — what do you think?";
    const turn = parseCC([ccUser(text)]).turns[0];
    expect(turn.text).toBe(text);
    expect(turn.action).toEqual({
      verb: "referenced",
      ref: "acme/billing!17049",
      refKind: "merge_request",
      url: "https://codehub.example/acme/billing/-/merge_requests/17049",
      source: "paste",
    });
  });

  it("a pasted issue URL (glab `/-/issues/N` or GitHub `/issues/N`) is an issue ref; a commit URL carries the sha", () => {
    expect(parseCC([ccUser("see https://codehub.example/acme/billing/-/issues/16002")]).turns[0].action).toMatchObject({
      ref: "acme/billing#16002",
      refKind: "issue",
    });
    expect(parseCC([ccUser("see https://codehub.example/acme/billing/issues/9.")]).turns[0].action).toMatchObject({
      ref: "acme/billing#9",
      refKind: "issue",
    });
    expect(
      parseCC([ccUser("see https://codehub.example/acme/billing/-/commit/d7e5977abc")]).turns[0].action,
    ).toMatchObject({ refKind: "commit", sha: "d7e5977abc" });
  });

  it("prose with no forge URL carries no action, exactly as today", () => {
    const turn = parseCC([ccUser("Add a health check endpoint, see https://docs.example/health for the spec.")])
      .turns[0];
    expect(turn.action).toBeUndefined();
    expect(turn).not.toHaveProperty("actions");
  });

  it("opencode user prose gets the same paste action", () => {
    const session = opencodeParser.parse(
      OC_REF,
      ocExport([ocUser("look at https://codehub.example/acme/billing/-/merge_requests/17049")]),
    );
    expect(session.turns[0].action).toMatchObject({ verb: "referenced", ref: "acme/billing!17049", source: "paste" });
  });
});

// ---------------------------------------------------------------------------
// The three mechanics
// ---------------------------------------------------------------------------

describe("forge action — mechanic (i): chained commands are split and every segment matched", () => {
  it("`git add -A && git commit -m … && git push -u origin <b>` yields committed AND pushed; `action` is the top-ranked one", () => {
    const session = parseCC([
      ccUser("ship it"),
      ...bash(
        "tu_chain",
        'git add -A && git commit -m "make debit posting idempotent" && git push -u origin 15178-5-idempotent-debits',
        `${COMMIT_RESULT}\n${PUSH_RESULT}`,
      ),
    ]);
    const turn = toolTurn(session, "tu_chain");
    expect(turn.actions?.map((a) => a.verb)).toEqual(["navigated", "committed", "pushed"]);
    expect(turn.actions?.find((a) => a.verb === "committed")).toMatchObject({
      sha: "d7e5977",
      branch: "15178-5-idempotent-debits",
    });
    expect(turn.actions?.find((a) => a.verb === "pushed")).toMatchObject({
      ref: "15178-5-idempotent-debits",
      branch: "15178-5-idempotent-debits",
    });
    expect(turn.action?.verb).toBe("pushed");
    expectElided(session, "tu_chain");
  });

  it("`;`, `||`, `|` and newlines split too, but a separator inside a quoted message does not", () => {
    expect(
      splitShellChain('git fetch; git rebase origin/main || echo failed | tee log\ngit commit -m "a && b; c | d"'),
    ).toEqual(["git fetch", "git rebase origin/main", "echo failed", "tee log", 'git commit -m "a && b; c | d"']);
    const actions = deriveToolActions({
      toolName: "Bash",
      input: { command: 'git commit -m "a && b" && git push' },
      result: "[main abc1234] a && b\nTo codehub.example:acme/billing.git\n   1111111..abc1234  main -> main",
    });
    expect(actions.map((a) => a.verb)).toEqual(["committed", "pushed"]);
  });

  it("a leading `cd <dir> &&` does not hide the forge command (digest kept, actions found)", () => {
    const session = parseCC([
      ccUser("x"),
      ...bash("tu_cd", "cd /home/dev/billing && git commit -m fix", "[main abc1234] fix"),
    ]);
    expect(toolTurn(session, "tu_cd").inputDigest).toBe("cd /home/dev/billing && git commit -m ‹text›");
    expect(toolTurn(session, "tu_cd").action).toMatchObject({ verb: "committed", sha: "abc1234" });
  });
});

// opencode export builders — the plain-JSON shape the CLI hands the parser
// (`OpencodeSessionExport`, see packages/core/src/sessions/opencode.ts).
const OC_REF = { source: "opencode", sourceSessionId: "ses_forge0001", path: "n/a" };
let ocN = 0;
function ocUser(text: string): { message: { id: string; data: string }; parts: { messageId: string; data: string }[] } {
  ocN += 1;
  const id = `msg_u${ocN}`;
  return {
    message: {
      id,
      data: JSON.stringify({ role: "user", time: { created: 1_790_000_000_000 + ocN * 1000 }, agent: "build" }),
    },
    parts: [{ messageId: id, data: JSON.stringify({ type: "text", text }) }],
  };
}
function ocTool(tool: string, input: Record<string, unknown>, output: string, status = "completed") {
  ocN += 1;
  const id = `msg_a${ocN}`;
  return {
    message: {
      id,
      data: JSON.stringify({
        role: "assistant",
        modelID: "acme-large",
        providerID: "acmeai",
        time: { created: 1_790_000_000_000 + ocN * 1000 },
      }),
    },
    parts: [
      {
        messageId: id,
        data: JSON.stringify({
          type: "tool",
          tool,
          callID: `call_${ocN}`,
          state: { status, input, output, time: { start: 1_790_000_000_000 + ocN * 1000 } },
        }),
      },
    ],
  };
}
function ocExport(rows: ReturnType<typeof ocUser>[]): string {
  return JSON.stringify({
    session: {
      id: OC_REF.sourceSessionId,
      parentId: null,
      directory: "/home/dev/billing",
      title: "forge",
      agent: "build",
      modelRaw: null,
      timeCreated: 1_790_000_000_000,
      timeUpdated: 1_790_000_100_000,
      cost: 0.01,
      tokensInput: 10,
      tokensOutput: 5,
      tokensReasoning: 0,
      tokensCacheRead: 0,
      tokensCacheWrite: 0,
    },
    messages: rows.map((r) => r.message),
    parts: rows.flatMap((r) => r.parts),
  });
}

describe("forge action — mechanic (ii): harness differences", () => {
  it("opencode's lowercase `bash` part with `state.input.command` + `state.output` yields the same committed action as Claude Code's `Bash`", () => {
    const oc = stripDirs(
      opencodeParser.parse(
        OC_REF,
        ocExport([
          ocUser("commit"),
          ocTool("bash", { command: 'git commit -m "make debit posting idempotent"' }, COMMIT_RESULT),
        ]),
      ),
    );
    const ocTurn = oc.turns.find((t) => t.kind === "tool_use");
    expect(ocTurn?.toolName).toBe("bash");
    expect(ocTurn?.action).toEqual({
      verb: "committed",
      refKind: "commit",
      sha: "d7e5977",
      branch: "15178-5-idempotent-debits",
      subject: "make debit posting idempotent",
      source: "cli",
    });
    // opencode emits no tool_result turn; the output text is nowhere in the session.
    expect(oc.turns.some((t) => t.kind === "tool_result")).toBe(false);
    expect(JSON.stringify(oc.turns)).not.toContain("41 insertions");

    const cc = parseCC([
      ccUser("commit"),
      ...bash("tu_cc", 'git commit -m "make debit posting idempotent"', COMMIT_RESULT),
    ]);
    expect(toolTurn(cc, "tu_cc").action).toEqual(ocTurn?.action);
  });

  it("opencode's `gitlab_get_merge_request` (heuristic server_tool split) yields viewed with source mcp; a failed part (`status: error`) yields nothing", () => {
    const ok = opencodeParser.parse(
      OC_REF,
      ocExport([
        ocUser("x"),
        ocTool(
          "gitlab_get_merge_request",
          { project_id: "acme/billing", merge_request_iid: 17049 },
          '{"iid":17049,"state":"merged"}',
        ),
      ]),
    );
    expect(ok.turns.find((t) => t.kind === "tool_use")?.action).toEqual({
      verb: "viewed",
      ref: "acme/billing!17049",
      refKind: "merge_request",
      state: "merged",
      source: "mcp",
    });
    const failed = opencodeParser.parse(
      OC_REF,
      ocExport([ocUser("x"), ocTool("bash", { command: "git push" }, "fatal: could not read from remote", "error")]),
    );
    expect(failed.turns.find((t) => t.kind === "tool_use")?.action).toBeUndefined();
  });

  it("Claude Code reads the result from a tool_result whose content is an array of text blocks", () => {
    const session = parseCC([
      ccUser("x"),
      ...bash("tu_arr", "git commit -m fix", "[main abc1234] fix", { arrayResult: true }),
    ]);
    expect(toolTurn(session, "tu_arr").action).toMatchObject({ verb: "committed", sha: "abc1234" });
    expectElided(session, "tu_arr");
  });

  it("a commit whose result never arrives (session killed mid-call) is not counted as committed — nobody saw it succeed", () => {
    const session = parseCC([ccUser("x"), ...bash("tu_none", 'git commit -m "wip"', "", { noResult: true })]);
    expect(toolTurn(session, "tu_none").action).toBeUndefined();
  });
});

describe("forge action — mechanic (iii): the digest cap and result-proven verbs", () => {
  const longBody = Array.from(
    { length: 40 },
    (_, i) => `- paragraph ${i + 1} of the commit message explaining the idempotent debit posting change in detail`,
  ).join("\n");
  const heredocCommit = `git commit -m "$(cat <<'EOF'\nmake debit posting idempotent\n\n${longBody}\nEOF\n)" && git push -u origin 15178-5-idempotent-debits`;

  it("a long heredoc commit message followed by `&& git push` yields committed and pushed, and the stored digest keeps both commands but none of the message", () => {
    expect(heredocCommit.length).toBeGreaterThan(1200);
    const session = parseCC([ccUser("ship"), ...bash("tu_hd", heredocCommit, `${COMMIT_RESULT}\n${PUSH_RESULT}`)]);
    const turn = toolTurn(session, "tu_hd");
    expect(turn.inputDigest).toContain("git commit -m");
    expect(turn.inputDigest).toContain("git push -u origin 15178-5-idempotent-debits");
    expect(turn.inputDigest).not.toContain("paragraph");
    expect(turn.inputDigest).not.toContain("idempotent debit posting change");
    expect(turn.actions?.map((a) => a.verb)).toEqual(["committed", "pushed"]);
    expect(turn.actions?.[1]).toMatchObject({
      verb: "pushed",
      ref: "15178-5-idempotent-debits",
      branch: "15178-5-idempotent-debits",
    });
    expect(turn.actions?.[0]).toMatchObject({ verb: "committed", sha: "d7e5977" });
    expectElided(session, "tu_hd");
  });

  it("the forge digest cap is 1200 (redactSecrets still applied); a test-runner digest stays at 400", () => {
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const files = Array.from({ length: 80 }, (_, i) => `src/module-${i}.ts`).join(" ");
    const cmd = `git add ${files} && GH_TOKEN=${token} git push`;
    const session = parseCC([ccUser("x"), ...bash("tu_cap", cmd, "Everything up-to-date")]);
    const digest = toolTurn(session, "tu_cap").inputDigest ?? "";
    expect(digest.length).toBeGreaterThan(400);
    expect(digest.length).toBeLessThanOrEqual(1200);
    expect(cmd.length).toBeGreaterThan(1200);

    const withToken = `git push https://token=${token}@codehub.example/acme/billing.git`;
    const pushed = parseCC([ccUser("x"), ...bash("tu_tok", withToken, "Everything up-to-date")]);
    expect(toolTurn(pushed, "tu_tok").inputDigest).not.toContain(token);
    expect(toolTurn(pushed, "tu_tok").inputDigest).toContain("[REDACTED]");

    const long = `npm test -- ${"a".repeat(500)}`;
    const t = parseCC([ccUser("x"), ...bash("tu_t", long, "ok")]);
    expect(toolTurn(t, "tu_t").inputDigest?.length).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// tested, Skill, error results, B12
// ---------------------------------------------------------------------------

describe("forge action — `tested` verb for test runners, nothing for Skill/Read/Edit", () => {
  it("npm / npx / pnpm / yarn / pytest / go test / cargo test yield tested with the digest kept", () => {
    for (const cmd of [
      "npm test",
      "npx vitest run -t forge",
      "pnpm test",
      "yarn test",
      "pytest -q tests/",
      "go test ./...",
      "cargo test --workspace",
    ]) {
      const session = parseCC([ccUser("x"), ...bash("tu_t", cmd, "ok")]);
      expect(toolTurn(session, "tu_t").action).toEqual({ verb: "tested", source: "cli" });
      expect(toolTurn(session, "tu_t").inputDigest).toBe(cmd);
    }
    // Not a test runner: no digest, no action (B12 — degrade, never invent).
    const build = parseCC([ccUser("x"), ...bash("tu_b", "go build ./...", "ok")]);
    expect(toolTurn(build, "tu_b").action).toBeUndefined();
    expect(toolTurn(build, "tu_b").inputDigest).toBeUndefined();
  });

  it("a `Skill` tool row, a `Read` and an `Edit` contribute no action", () => {
    const session = parseCC([
      ccUser("x"),
      ...ccTool("tu_skill", "Skill", { skill: "review-mr", args: "!17049" }, "Loaded skill review-mr"),
      ...ccTool("tu_read", "Read", { file_path: "/home/dev/billing/src/debits.ts" }, "contents"),
      ...ccTool(
        "tu_edit",
        "Edit",
        { file_path: "/home/dev/billing/src/debits.ts", old_string: "a", new_string: "b" },
        "ok",
      ),
    ]);
    for (const id of ["tu_skill", "tu_read", "tu_edit"]) {
      expect(toolTurn(session, id).action).toBeUndefined();
      expect(toolTurn(session, id)).not.toHaveProperty("actions");
      expectElided(session, id);
    }
  });
});

describe("forge action — a failed tool call claims only what its result proves", () => {
  it("a rejected `git push` (is_error) yields no pushed; `git commit && git push` with the commit in the result but the push rejected keeps only committed", () => {
    expect(
      bashAction("git push", "! [rejected]        main -> main (fetch first)\nerror: failed to push some refs", {
        isError: true,
      }),
    ).toBeUndefined();
    const session = parseCC([
      ccUser("x"),
      ...bash(
        "tu_half",
        'git commit -m "fix" && git push',
        "[main abc1234] fix\nerror: failed to push some refs to 'codehub.example:acme/billing.git'",
        { isError: true },
      ),
    ]);
    const turn = toolTurn(session, "tu_half");
    expect(turn.action).toMatchObject({ verb: "committed", sha: "abc1234" });
    expect(turn.actions).toBeUndefined();
    expectElided(session, "tu_half", "error");
  });

  it("a rejected push is not pushed", () => {
    // `To <remote>` precedes the rejection: the header alone must never prove a push (F4), with or without is_error.
    const rejected =
      "To codehub.example:acme/billing.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to 'codehub.example:acme/billing.git'";
    expect(bashAction("git push", rejected, { isError: true })).toBeUndefined();
    expect(bashAction("git push", rejected)).toBeUndefined();
    expect(
      deriveToolActions({ toolName: "Bash", input: { command: "git status" }, result: rejected }).map((a) => a.verb),
    ).toEqual(["navigated"]);
  });

  it("a remote-rejected push is not pushed", () => {
    const remoteRejected =
      "To codehub.example:acme/billing.git\n ! [remote rejected] main -> main (pre-receive hook declined)\nerror: failed to push some refs to 'codehub.example:acme/billing.git'";
    expect(bashAction("git push origin main", remoteRejected, { isError: true })).toBeUndefined();
    expect(bashAction("git push origin main", remoteRejected)).toBeUndefined();
  });

  it("Everything up-to-date is pushed", () => {
    expect(bashAction("git push", "Everything up-to-date")).toMatchObject({ verb: "pushed", refKind: "branch" });
    expect(bashAction("git push origin main", "Everything up-to-date")).toMatchObject({ verb: "pushed", ref: "main" });
    // A bare `To <remote>` header without a ref line proves nothing on its own.
    expect(bashAction("git push", "To codehub.example:acme/billing.git")).toMatchObject({ verb: "pushed" });
  });

  it("a failed `glab mr view` yields no viewed", () => {
    expect(bashAction("glab mr view 999999", "ERROR: 404 Not Found", { isError: true })).toBeUndefined();
  });
});

describe("forge action — B12 degrade, never fail", () => {
  it("an unrecognised `glab`/`gh` subcommand, a bare `git`, an unterminated quote and garbage results yield no action and never throw", () => {
    const session = parseCC([
      ccUser("x"),
      ...bash("tu_1", "glab mr frobnicate 17049", "unknown command"),
      ...bash("tu_2", "gh pr list --state open", "#1 a\n#2 b"),
      ...bash("tu_3", "git", "usage: git"),
      ...bash("tu_4", 'git commit -m "unterminated', "error: pathspec"),
      ...bash("tu_5", "gh", ""),
      ...bash("tu_6", "glab issue update 16002 --title x", "\u0000�{{{"),
    ]);
    for (const id of ["tu_1", "tu_2", "tu_5", "tu_6"]) expect(toolTurn(session, id).action).toBeUndefined();
    // `git` alone names no subcommand; a commit whose result is a git error committed nothing.
    expect(toolTurn(session, "tu_3").action).toBeUndefined();
    expect(toolTurn(session, "tu_4").action).toBeUndefined();
    for (const id of ["tu_1", "tu_2", "tu_3", "tu_4", "tu_5", "tu_6"]) expectElided(session, id);
  });

  it("a non-string command, a missing input and a non-text result degrade to no action", () => {
    expect(deriveToolActions({ toolName: "Bash", input: { command: 42 } })).toEqual([]);
    expect(deriveToolActions({ toolName: "Bash" })).toEqual([]);
    // No result yet: the commit is not observed. An empty result (a quiet commit) is.
    expect(deriveToolActions({ toolName: "Bash", input: { command: "git commit -m x" }, result: undefined })).toEqual(
      [],
    );
    expect(deriveToolActions({ toolName: "Bash", input: { command: "git commit -m x" }, result: "" })).toMatchObject([
      { verb: "committed" },
    ]);
    expect(() =>
      deriveToolActions({
        toolName: "mcp__gitlab__get_merge_request",
        input: null as unknown as Record<string, unknown>,
      }),
    ).not.toThrow();
    const session = parseCC([
      ccUser("x"),
      ...ccTool("tu_j", "Bash", { command: "git commit -m x" }, "", { arrayResult: false }),
    ]);
    expect(toolTurn(session, "tu_j").action).toMatchObject({ verb: "committed" });
  });

  it("a session with no forge tools, no refs and no edits imports exactly as today — no turn carries `action` or `actions`", () => {
    const session = parseCC([
      ccUser("Add a health check endpoint."),
      ...ccTool("tu_r", "Read", { file_path: "/home/dev/billing/src/router.ts" }, "…"),
      ...bash("tu_ls", "ls -la src", "router.ts"),
    ]);
    for (const t of session.turns) {
      expect(t).not.toHaveProperty("action");
      expect(t).not.toHaveProperty("actions");
    }
    expect(toolTurn(session, "tu_ls").inputDigest).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 2026-09-27 review fixes — each block is one user-visible rule.
// ---------------------------------------------------------------------------

function bashVerbs(command: string, result?: string, isError = false): string[] {
  return deriveToolActions({ toolName: "Bash", input: { command }, result, isError }).map((a) => a.verb);
}

describe("output never invents delivery: only the command's own verb can be enriched by its result", () => {
  it("`git pull` printing `old..new main -> origin/main` is not a push", () => {
    expect(bashVerbs("git pull", "Updating abc1234..def5678\n   abc1234..def5678  main       -> origin/main")).toEqual([
      "navigated",
    ]);
  });

  it("`git fetch` printing `[new branch] x -> origin/x` is not a push", () => {
    expect(
      bashVerbs("git fetch", "From codehub.example:acme/billing\n * [new branch]      feature-x  -> origin/feature-x"),
    ).toEqual(["navigated"]);
  });

  it("`git fetch --prune` printing `[deleted]` does not close a branch", () => {
    expect(bashVerbs("git fetch --prune", " - [deleted]         (none)     -> origin/old")).toEqual(["navigated"]);
  });

  it("`cat` of a file containing a `[main abc1234] x` line is not a commit, and its text is nowhere in the actions", () => {
    const actions = deriveToolActions({
      toolName: "Bash",
      input: { command: "cat notes.txt" },
      result: "[main abc1234] secret plan for the reorg",
    });
    expect(actions).toEqual([]);
  });

  it("`git log` with a `[%D %h] %s` format is not a commit", () => {
    expect(bashVerbs("git log -1 --format='[%D %h] %s'", "[main abc1234] tidy")).toEqual(["navigated"]);
  });

  it("`git status` followed by push-shaped output is not a push", () => {
    expect(bashVerbs("git status", PUSH_RESULT)).toEqual(["navigated"]);
  });
});

describe("a commit counts once it returned without error, and a quiet commit gets its sha from a later HEAD query", () => {
  it("`git commit -q` that printed nothing is committed with no sha", () => {
    const actions = deriveToolActions({ toolName: "Bash", input: { command: "git commit -q -m wip" }, result: "" });
    expect(actions).toEqual([{ verb: "committed", refKind: "commit", source: "cli" }]);
  });

  it("`nothing to commit` and a git error are not commits", () => {
    expect(bashVerbs("git commit -m wip || true", "On branch main\nnothing to commit, working tree clean")).toEqual([]);
    expect(bashVerbs("git commit -m wip", "fatal: unable to auto-detect email address")).toEqual([]);
    expect(bashVerbs("git commit -m wip", "husky - pre-commit hook exited with code 1 (error)", true)).toEqual([]);
    expect(bashVerbs("git merge main", "Already up to date.")).toEqual([]);
  });

  it("a later `git rev-parse HEAD` in the same session gives the quiet commit its sha", () => {
    const session = parseCC([
      ccUser("commit"),
      ...bash("tu_q", "git add -A && git commit -q -m wip", ""),
      ...bash("tu_rp", "git rev-parse HEAD", "0123456789abcdef0123456789abcdef01234567"),
    ]);
    expect(toolTurn(session, "tu_q").actions?.find((a) => a.verb === "committed")).toMatchObject({
      verb: "committed",
      sha: "0123456789abcdef0123456789abcdef01234567",
    });
    expectElided(session, "tu_rp");
  });

  it("a `git log -1 --oneline` chained after the quiet commit gives it the sha", () => {
    const session = parseCC([
      ccUser("commit"),
      ...bash("tu_ql", "git commit -q -m wip && git log -1 --oneline", "a1b2c3d (HEAD -> main) wip"),
    ]);
    expect(toolTurn(session, "tu_ql").actions?.find((a) => a.verb === "committed")?.sha).toBe("a1b2c3d");
  });

  it("the sha stays unset when HEAD moved in between, or the query is not about HEAD", () => {
    const moved = parseCC([
      ccUser("x"),
      ...bash("tu_q", "git commit -q -m wip", ""),
      ...bash("tu_co", "git checkout other", "Switched to branch 'other'"),
      ...bash("tu_rp", "git rev-parse HEAD", "0123456789abcdef0123456789abcdef01234567"),
    ]);
    expect(toolTurn(moved, "tu_q").action).toEqual({ verb: "committed", refKind: "commit", source: "cli" });

    const otherRef = parseCC([
      ccUser("x"),
      ...bash("tu_q", "git commit -q -m wip", ""),
      ...bash("tu_lg", "git log --oneline origin/main", "fedcba9 upstream work"),
    ]);
    expect(toolTurn(otherRef, "tu_q").action?.sha).toBeUndefined();
  });

  it("opencode gets the same backfill", () => {
    const oc = opencodeParser.parse(
      OC_REF,
      ocExport([
        ocUser("commit"),
        ocTool("bash", { command: "git commit -q -m wip" }, ""),
        ocTool("bash", { command: "git rev-parse --short HEAD" }, "a1b2c3d\n"),
      ]),
    );
    expect(oc.turns.find((t) => t.action?.verb === "committed")?.action?.sha).toBe("a1b2c3d");
  });
});

describe("A-B5 — a failed commit (pre-commit hook) is never counted as committed", () => {
  it("git commit exiting 1 on a hook rejection produces no action (trimmed real S10a tool_use/tool_result)", () => {
    const actions = deriveToolActions({
      toolName: "Bash",
      input: {
        command:
          "git add README.md && git commit -m \"$(cat <<'EOF'\ndocs: add 0.3.1 to changelog\nCo-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>\nEOF\n)\"",
      },
      result: "Exit code 1\npre-commit: direct commits to main are blocked by repo policy (use a branch + MR)",
      isError: true,
    });
    expect(actions).toEqual([]);
  });
});

describe("A-B6 — a backfilled sha never carries the command text as subject", () => {
  it("`git rev-parse HEAD` fills the sha only; the quiet commit's subject stays undefined, never the command digest (real S02 shape)", () => {
    const session = parseCC([
      ccUser("commit"),
      ...bash(
        "tu_q",
        "git add README.md && git commit -q -m \"$(cat <<'EOF'\nFix typo in README intro\nCo-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>\nEOF\n)\"",
        "",
      ),
      ...bash("tu_rp", "git rev-parse HEAD", "015f23fd106dec253fc835217f6e525fff86ac0f"),
    ]);
    const action = toolTurn(session, "tu_q").actions?.find((a) => a.verb === "committed");
    expect(action).toMatchObject({ verb: "committed", sha: "015f23fd106dec253fc835217f6e525fff86ac0f" });
    expect(action?.subject).toBeUndefined();
  });

  it("a `git log -1 --oneline` after a quiet commit backfills both the sha and the subject it printed", () => {
    const session = parseCC([
      ccUser("commit"),
      ...bash("tu_ql", "git commit -q -m wip && git log -1 --oneline", "a1b2c3d (HEAD -> main) wip: tidy up"),
    ]);
    const action = toolTurn(session, "tu_ql").actions?.find((a) => a.verb === "committed");
    expect(action).toMatchObject({ sha: "a1b2c3d", subject: "wip: tidy up" });
  });

  it("a default-format `git log -1` after a quiet commit backfills the subject from the indented body line", () => {
    const session = parseCC([
      ccUser("commit"),
      ...bash(
        "tu_ql2",
        "git commit -q -m wip && git log -1",
        "commit a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2\nAuthor: dev <dev@example.com>\nDate:   Mon Jan 1 00:00:00 2026 +0000\n\n    tidy up the README",
      ),
    ]);
    const action = toolTurn(session, "tu_ql2").actions?.find((a) => a.verb === "committed");
    expect(action).toMatchObject({
      sha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
      subject: "tidy up the README",
    });
  });

  it("does not overwrite a subject the amend's own result already gave it", () => {
    const session = parseCC([
      ccUser("commit"),
      ...bash(
        "tu_a",
        "git commit --amend -m wip && git log -1 --oneline",
        "[main 5681920] real amended subject\ndeadbee (HEAD -> main) a different subject from log",
      ),
    ]);
    const action = toolTurn(session, "tu_a").actions?.find((a) => a.verb === "rewrote");
    expect(action).toMatchObject({ verb: "rewrote", sha: "5681920", subject: "real amended subject" });
  });

  it("an amend that prints nothing gets its sha and subject from a later `git log`, not left null (real S21 shape)", () => {
    const session = parseCC([
      ccUser("commit"),
      ...bash("tu_c1", "git add -A && git commit -q -m wip", ""),
      ...bash("tu_amend", "git commit -q --amend -m wip2", ""),
      ...bash("tu_ql3", "git log -1 --oneline", "5681920 (HEAD -> main) real amended subject"),
    ]);
    const amend = toolTurn(session, "tu_amend").action;
    expect(amend).toMatchObject({ verb: "rewrote", sha: "5681920", subject: "real amended subject" });
  });
});

describe("shell redirections are never branch names", () => {
  it("`git push -q origin main 2>&1` pushes main", () => {
    const [a] = deriveToolActions({
      toolName: "Bash",
      input: { command: "git push -q origin main 2>&1" },
      result: "",
    });
    expect(a).toMatchObject({ verb: "pushed", ref: "main", branch: "main" });
  });

  it("`git branch -D old 2>/dev/null` closes branch old", () => {
    expect(
      deriveToolActions({ toolName: "Bash", input: { command: "git branch -D old 2>/dev/null" }, result: "" }),
    ).toEqual([{ verb: "closed", refKind: "branch", ref: "old", branch: "old", source: "cli" }]);
  });

  it("`--force-with-lease origin feat >/dev/null`, `> out.txt` and `|&` keep the real branch", () => {
    expect(
      deriveToolActions({
        toolName: "Bash",
        input: { command: "git push --force-with-lease origin feat >/dev/null" },
        result: "",
      })[0],
    ).toMatchObject({ verb: "rewrote", branch: "feat" });
    expect(
      deriveToolActions({ toolName: "Bash", input: { command: "git push origin feat > out.txt" }, result: "" })[0],
    ).toMatchObject({ verb: "pushed", branch: "feat" });
    expect(splitShellChain("git push origin feat |& tail -2")).toEqual(["git push origin feat", "tail -2"]);
  });
});

describe("a merge or close counts only when the forge confirms it happened", () => {
  it("`gh pr merge --auto` is not merged, whatever it prints", () => {
    expect(
      bashVerbs(
        "gh pr merge 5 --auto --squash",
        "✓ Pull request #5 will be automatically merged via squash when all requirements are met",
      ),
    ).toEqual([]);
  });

  it("a merge queued until the pipeline succeeds is not merged", () => {
    expect(bashVerbs("glab mr merge 17", "- Merging merge request !17\n✓ Will merge when pipeline succeeds")).toEqual(
      [],
    );
    expect(bashVerbs("glab mr merge 17", "! MR !17 will be merged when pipeline succeeds")).toEqual([]);
  });

  it("merge or close output that does not confirm, or no output at all, is not closure", () => {
    expect(
      bashVerbs("gh pr merge 5", "X Pull request #5 is not mergeable: the merge commit cannot be cleanly created"),
    ).toEqual([]);
    expect(bashVerbs("gh pr merge 5")).toEqual([]);
    expect(bashVerbs("gh issue close 9", "could not close: closed issues cannot be edited")).toEqual([]);
    expect(bashVerbs("gh pr merge 5 --rebase", "✓ Rebased and merged pull request #5")).toEqual(["merged"]);
  });

  it("an MCP merge queued for the pipeline is not merged", () => {
    const actions = deriveToolActions({
      toolName: "mcp__gitlab__merge_merge_request",
      input: { project_id: "acme/billing", merge_request_iid: 17, merge_when_pipeline_succeeds: true },
      result: '{"state":"opened"}',
    });
    expect(actions).toEqual([]);
  });
});

describe("opencode: a bash command that exited nonzero is a failure", () => {
  it("a failed `git commit` (hook exit 1) and a failed `gh pr merge` (exit 1) yield nothing", () => {
    ocN += 1;
    const id = `msg_a${ocN}`;
    const failedPart = (command: string, output: string) => ({
      messageId: id,
      data: JSON.stringify({
        type: "tool",
        tool: "bash",
        callID: `call_${command.length}`,
        state: { status: "completed", input: { command }, output, metadata: { exit: 1 } },
      }),
    });
    const oc = opencodeParser.parse(
      OC_REF,
      ocExport([
        ocUser("ship"),
        {
          message: {
            id,
            data: JSON.stringify({ role: "assistant", modelID: "acme-large", time: { created: 1_790_000_000_000 } }),
          },
          parts: [
            failedPart("git commit -m wip", "lint failed"),
            failedPart("gh pr merge 5", "Pull request #5 is not mergeable; merged state unknown"),
          ],
        },
      ]),
    );
    const tools = oc.turns.filter((t) => t.kind === "tool_use");
    expect(tools).toHaveLength(2);
    for (const t of tools) expect(t.action).toBeUndefined();
  });
});

describe("a slash command is recognised whichever tag comes first", () => {
  it("`<command-message>` before `<command-name>` still yields one prose turn with the ref and no raw XML", () => {
    const session = parseCC([
      ccUser(
        "<command-message>review-mr</command-message>\n<command-name>/review-mr</command-name>\n<command-args>!17049 please</command-args>",
      ),
    ]);
    expect(session.turns).toHaveLength(1);
    expect(session.turns[0].action).toMatchObject({ verb: "referenced", ref: "!17049", skill: "review-mr" });
    expect(session.turns[0].text).not.toContain("<command-message>");
  });

  it("a `<command-message>`-first slash line naming no ref is skipped like any other meta message", () => {
    const session = parseCC([
      ccUser("<command-message>compact</command-message>\n<command-name>/compact</command-name>"),
      ccUser("real question"),
    ]);
    expect(session.turns.map((t) => t.text)).toEqual(["real question"]);
  });
});

describe("only real test runners count as tested; command secrets never reach the digest", () => {
  it("installs, deploys and scaffolding are not tests and store no digest", () => {
    for (const cmd of [
      "npm i",
      "npm install -g tsx",
      "npx supabase start",
      "npx vercel --prod",
      "npx -y skills@latest",
    ]) {
      const session = parseCC([ccUser("x"), ...bash("tu_n", cmd, "ok")]);
      expect(toolTurn(session, "tu_n").action).toBeUndefined();
      expect(toolTurn(session, "tu_n").inputDigest).toBeUndefined();
    }
  });

  it("test runners in their common spellings are tested", () => {
    for (const cmd of [
      "npm run test",
      "npm run test:unit",
      "pnpm exec vitest run",
      "npx jest --ci",
      "npx playwright test",
      "npx turbo test --filter=@acme/api",
      "bundle exec rspec spec/models",
      "CI=1 npx vitest run",
      "python -m pytest -q",
    ]) {
      expect(bashVerbs(cmd, "ok")).toEqual(["tested"]);
    }
  });

  it("`--token X`, `--token=X`, `--password X`, `--api-key X`, `-pX` and `*_TOKEN=`/`*_KEY=`/`PGPASSWORD=` values are redacted in the digest", () => {
    const cases = [
      "git push --token abcdEFGH1234567890zz",
      "gh auth login --token=abcdEFGH1234567890zz",
      "gh pr view 5 && GH_TOKEN=abcdEFGH1234567890zz gh api user",
      "STRIPE_KEY=abcdEFGH1234567890zz npm test",
      "APP_SECRET=abcdEFGH1234567890zz npm test",
      "PGPASSWORD=abcdEFGH1234567890zz npm test",
      "git -c http.extraheader=x push --password abcdEFGH1234567890zz",
      "npm test -- --api-key abcdEFGH1234567890zz",
      "npm test -- -pabcdEFGH1234567890zz",
    ];
    for (const cmd of cases) {
      const session = parseCC([ccUser("x"), ...bash("tu_s", cmd, "ok")]);
      const digest = toolTurn(session, "tu_s").inputDigest ?? "";
      expect(digest, cmd).toContain("[REDACTED]");
      expect(digest, cmd).not.toContain("abcdEFGH1234567890zz");
    }
  });
});

describe("a heredoc body is never parsed as commands", () => {
  it('an odd `"` count and a `git push --force` line inside the commit body yield only the real commit and the trailing push', () => {
    const command = `git commit -m "$(cat <<'EOF'\nfix layout on the 12" screen\n\ngit push --force was wrong\nEOF\n)" && git push`;
    const result = `[main abc1234] fix layout on the 12" screen\nTo codehub.example:acme/billing.git\n   1111111..abc1234  main -> main`;
    const actions = deriveToolActions({ toolName: "Bash", input: { command }, result });
    expect(actions.map((a) => a.verb)).toEqual(["committed", "pushed"]);
    expect(actions[1]).toMatchObject({ branch: "main" });
    expect(splitShellChain(command)).toHaveLength(2);
  });
});

describe("the stored command keeps the verb and ref but none of the message, body or comment", () => {
  it("a glab review comment and a heredoc commit body leave no comment or body words in the digest", () => {
    const session = parseCC([
      ccUser("x"),
      ...bash("tu_n", 'glab mr note 17049 -m "the rounding branch double-posts on retry"', "ok"),
      ...bash(
        "tu_c",
        `git commit -m "$(cat <<'EOF'\nrework ledger rounding\n\nreviewed by jane@codehub.example\nEOF\n)"`,
        "[main abc1234] rework ledger rounding",
      ),
      ...bash(
        "tu_pr",
        "gh pr create --title \"Fix rounding\" --body-file - <<'EOF'\nsecret roadmap detail\nEOF",
        "https://codehub.example/acme/billing/pull/9",
      ),
      ...bash(
        "tu_eq",
        'gh pr create --title="Fix rounding" --body="internal detail"',
        "https://codehub.example/acme/billing/pull/10",
      ),
      ...bash("tu_am", 'git commit -am "private words here"', "[main bcd2345] private words here"),
    ]);
    const note = toolTurn(session, "tu_n").inputDigest ?? "";
    expect(note).toBe("glab mr note 17049 -m ‹text›");
    const commit = toolTurn(session, "tu_c").inputDigest ?? "";
    expect(commit).toContain("git commit -m");
    for (const word of ["ledger", "rounding", "jane", "reviewed"]) expect(commit).not.toContain(word);
    const pr = toolTurn(session, "tu_pr").inputDigest ?? "";
    expect(pr).toContain("gh pr create");
    expect(pr).not.toContain("Fix rounding");
    expect(pr).not.toContain("roadmap");
    const eq = toolTurn(session, "tu_eq").inputDigest ?? "";
    expect(eq).not.toContain("Fix rounding");
    expect(eq).not.toContain("internal detail");
    expect(toolTurn(session, "tu_am").inputDigest).toBe("git commit -am ‹text›");
    // Verbs and refs are unaffected.
    expect(toolTurn(session, "tu_n").action).toMatchObject({ verb: "commented", ref: "!17049" });
    expect(toolTurn(session, "tu_pr").action).toMatchObject({
      verb: "opened_mr",
      ref: "codehub.example/acme/billing!9",
    });
  });

  it("the commit subject is kept but its email addresses are not", () => {
    const [a] = deriveToolActions({
      toolName: "Bash",
      input: { command: "git commit -m x" },
      result: "[main abc1234] credit jane@codehub.example for the fix",
    });
    expect(a.subject).toContain("credit");
    expect(a.subject).not.toContain("jane@codehub.example");
  });
});

describe("MCP tool names: undo, delete and edit are not the verb they contain", () => {
  function mcpVerbs(tool: string, input: Record<string, unknown>, result = "{}"): string[] {
    return deriveToolActions({ toolName: `mcp__gitlab__${tool}`, input, result }).map((a) => a.verb);
  }
  const mr = { project_id: "acme/billing", merge_request_iid: 17 };

  it("`unapprove_merge_request` is not approved", () => {
    expect(mcpVerbs("unapprove_merge_request", mr)).toEqual([]);
  });

  it("`delete_merge_request_note` and `update_merge_request_note` are not commented", () => {
    expect(mcpVerbs("delete_merge_request_note", { ...mr, note_id: 1 })).toEqual([]);
    expect(mcpVerbs("update_merge_request_note", { ...mr, note_id: 1, body: "x" })).toEqual([]);
  });

  it("snake_case `mr_discussions` names the MR (a read)", () => {
    expect(deriveToolActions({ toolName: "mcp__gitlab__mr_discussions", input: mr, result: "[]" })).toEqual([
      { verb: "viewed", ref: "acme/billing!17", refKind: "merge_request", source: "mcp" },
    ]);
  });

  it("`issue_write` creating an issue with labels (no issue number) is not triage", () => {
    expect(
      deriveToolActions({
        toolName: "mcp__github__issue_write",
        input: { owner: "acme", repo: "billing", method: "create", title: "t", labels: ["bug"] },
        result: "{}",
      }),
    ).toEqual([]);
  });
});

describe("gh/git argument edge cases keep the right ref", () => {
  it("`gh pr review -r 5` requests changes on PR 5", () => {
    expect(deriveToolActions({ toolName: "Bash", input: { command: "gh pr review -r 5 -b nit" }, result: "" })).toEqual(
      [{ verb: "commented", ref: "!5", refKind: "merge_request", source: "cli" }],
    );
    expect(
      deriveToolActions({ toolName: "Bash", input: { command: "gh pr review -a 5" }, result: "" })[0],
    ).toMatchObject({
      verb: "approved",
      ref: "!5",
    });
  });

  it("`git push origin +main` is a force push of main", () => {
    expect(deriveToolActions({ toolName: "Bash", input: { command: "git push origin +main" }, result: "" })).toEqual([
      { verb: "rewrote", ref: "main", refKind: "branch", branch: "main", source: "cli" },
    ]);
  });
});

describe("the digest scrubs only flags that carry prose, per tool and subcommand", () => {
  function digestOf(command: string, result = "ok"): string {
    const session = parseCC([ccUser("x"), ...bash("tu_d", command, result)]);
    return toolTurn(session, "tu_d").inputDigest ?? "";
  }

  it("`gh api` / `glab api` prose fields lose their value; other fields keep theirs", () => {
    expect(digestOf("gh api repos/acme/billing/issues/9/comments -f body='private review words' -f state=open")).toBe(
      "gh api repos/acme/billing/issues/9/comments -f body=‹text› -f state=open",
    );
    expect(digestOf('glab api projects/1/merge_requests/17/notes --raw-field "note=looks wrong"')).toBe(
      'glab api projects/1/merge_requests/17/notes --raw-field "note=‹text›"',
    );
    expect(digestOf("gh api graphql -F title=secret-plan --field description=x -F number=5")).toBe(
      "gh api graphql -F title=‹text› --field description=‹text› -F number=5",
    );
  });

  it("branch, draft and milestone flags keep their value; only title/description/body/message go", () => {
    expect(digestOf('glab mr create -b main -s feat/x -t "Private title" -d "private description"')).toBe(
      "glab mr create -b main -s feat/x -t ‹text› -d ‹text›",
    );
    expect(digestOf('gh pr create -d -B main -t "Private title" -b "private body"')).toBe(
      "gh pr create -d -B main -t ‹text› -b ‹text›",
    );
    expect(digestOf("glab issue update 16002 -m v2.4 --label bug")).toBe("glab issue update 16002 -m v2.4 --label bug");
    expect(digestOf("git checkout -b feat/private-name")).toBe("git checkout -b feat/private-name");
    expect(digestOf("git cherry-pick -m 1 abc1234")).toBe("git cherry-pick -m 1 abc1234");
    expect(digestOf('gh pr review 5 --comment -b "nit words"')).toBe("gh pr review 5 --comment -b ‹text›");
  });
});

// ---------------------------------------------------------------------------
// 2026-09-27 e2e fixes. Commands and results are trimmed from real harness
// transcripts (gh/glab run non-interactively), with the owner renamed.
// ---------------------------------------------------------------------------

const GH_PR_12_MERGED =
  "title:\t[e2e] README: Python 3.12+ to match pyproject\nstate:\tMERGED\nauthor:\tdev (Dev Example)\nlabels:\te2e\nassignees:\t\nreviewers:\t\nprojects:\t\nmilestone:\t\nnumber:\t12\nurl:\thttps://github.com/acme/narrator/pull/12\nadditions:\t1\ndeletions:\t1\nauto-merge:\tdisabled\n--\nFixes #1\n";
const GH_ISSUE_7_OPEN =
  "title:\t[e2e] Split dialogue in single quotes\nstate:\tOPEN\nauthor:\tdev (Dev Example)\nlabels:\te2e, enhancement\ncomments:\t0\nassignees:\tdev (Dev Example)\nprojects:\t\nmilestone:\t\nnumber:\t7\n--\nBritish-style books use single quotes for dialogue.";

function bashActionsOf(command: string, result?: string, isError = false): ForgeAction[] {
  return deriveToolActions({ toolName: "Bash", input: { command }, result, isError });
}

describe("a merge run without a terminal is a merge when it exits cleanly (gh prints nothing)", () => {
  it("`gh pr merge 18 --merge` with no output is merged", () => {
    const session = parseCC([ccUser("merge it"), ...bash("tu_m", "gh pr merge 18 --merge", "")]);
    expect(toolTurn(session, "tu_m").action).toMatchObject({ verb: "merged", ref: "!18", state: "merged" });
  });

  it("a squash merge followed by gh's own git pull output is merged", () => {
    const pull =
      "From github.com:acme/narrator\n * branch            main       -> FETCH_HEAD\n   c492907..a584794  main       -> origin/main\nUpdating c492907..a584794\nFast-forward\n README.md | 4 ++++\n 1 file changed, 4 insertions(+)";
    expect(bashActionsOf("gh pr merge 13 --squash --delete-branch", pull)).toMatchObject([
      { verb: "merged", ref: "!13" },
    ]);
    expect(bashVerbs("sleep 2 && gh pr merge 12 --merge && git checkout main && git pull", pull)).toContain("merged");
  });

  it("a merge whose exit status the call does not report, or that failed, is not a merge", () => {
    expect(bashVerbs("gh pr merge 12 --merge && git pull", "GraphQL: Base branch was modified.", true)).toEqual([]);
    expect(bashVerbs("gh pr merge 12 --merge; echo done", "done")).toEqual([]);
    expect(bashVerbs("gh pr merge 12 --merge | tail -3", "")).toEqual([]);
    expect(bashVerbs("gh pr merge 12 --merge || true", "GraphQL: Pull request is not mergeable")).toEqual([]);
    expect(bashVerbs("gh pr merge 12 --auto --squash", "")).toEqual([]);
    expect(bashVerbs("gh pr merge 12", "✓ Pull request #12 will be automatically merged")).toEqual([]);
  });

  it("glab: `✓ Merged!` and a clean exit are merged; a queued merge is not", () => {
    expect(bashVerbs("glab mr merge 17200", "✓ Merged!")).toEqual(["merged"]);
    expect(bashVerbs("glab mr merge 17200", "")).toEqual(["merged"]);
    expect(
      bashVerbs("glab mr merge 17201 --auto-merge --when-pipeline-succeeds", "✓ Will merge when pipeline succeeds"),
    ).toEqual([]);
  });
});

describe("one state per viewed item: a chained view never gives one item another's state", () => {
  it("`gh pr view 12 && gh issue view 7`: the PR is merged, the issue stays open", () => {
    const session = parseCC([
      ccUser("status?"),
      ...bash("tu_v", "gh pr view 12 && gh issue view 7", `${GH_PR_12_MERGED}${GH_ISSUE_7_OPEN}`),
    ]);
    const actions = toolTurn(session, "tu_v").actions ?? [];
    expect(actions.find((a) => a.ref === "!12")?.state).toBe("merged");
    expect(actions.find((a) => a.ref === "#7")?.state).toBe("opened");
  });

  it("an `echo ---` between the views changes nothing", () => {
    const out = bashActionsOf(
      "gh pr view 12 && echo --- && gh issue view 7",
      `${GH_PR_12_MERGED}---\n${GH_ISSUE_7_OPEN}`,
    );
    expect(out.map((a) => [a.ref, a.state])).toEqual([
      ["!12", "merged"],
      ["#7", "opened"],
    ]);
  });

  it("output that cannot be tied to its item gives no state to any item", () => {
    const json = '{"state":"MERGED","title":"x"}\n{"state":"OPEN","title":"y"}';
    const out = bashActionsOf("gh pr view 12 --json state,title && gh issue view 7 --json state,title", json);
    expect(out.map((a) => a.state)).toEqual([undefined, undefined]);
    // #12 and !12 cannot be told apart by an issue block that carries no URL.
    const same = bashActionsOf(
      "gh pr view 7 && gh issue view 7",
      `${GH_PR_12_MERGED.replace(/12/g, "7")}${GH_ISSUE_7_OPEN}`,
    );
    expect(same.find((a) => a.refKind === "merge_request")?.state).toBe("merged");
    expect(same.find((a) => a.refKind === "issue")?.state).toBeUndefined();
  });

  it("gh's terminal header `Title #N` above `Open • …` ties each block to its item", () => {
    const tty =
      "Fix totals #12\nMerged • dev wants to merge 1 commit\n\nbody\n\nSplit quotes #7\nOpen • dev opened about 1 day ago\n";
    expect(bashActionsOf("gh pr view 12 && gh issue view 7", tty).map((a) => a.state)).toEqual(["merged", "opened"]);
  });

  it("a single viewed item still takes the result's state", () => {
    expect(bashActionsOf("gh issue view 7", GH_ISSUE_7_OPEN)[0].state).toBe("opened");
  });

  it("`gh pr view 12 && gh issue view 7`: each item gets only its own title, never the other's", () => {
    const session = parseCC([
      ccUser("status?"),
      ...bash("tu_v", "gh pr view 12 && gh issue view 7", `${GH_PR_12_MERGED}${GH_ISSUE_7_OPEN}`),
    ]);
    const actions = toolTurn(session, "tu_v").actions ?? [];
    expect(actions.find((a) => a.ref === "!12")?.title).toBe("[e2e] README: Python 3.12+ to match pyproject");
    expect(actions.find((a) => a.ref === "#7")?.title).toBe("[e2e] Split dialogue in single quotes");
  });

  it("gh's terminal header `Title #N` above `Open • …` ties each block's title to its item too", () => {
    const tty =
      "Fix totals #12\nMerged • dev wants to merge 1 commit\n\nbody\n\nSplit quotes #7\nOpen • dev opened about 1 day ago\n";
    const out = bashActionsOf("gh pr view 12 && gh issue view 7", tty);
    expect(out.map((a) => a.title)).toEqual(["Fix totals", "Split quotes"]);
  });

  it("output that cannot be tied to its item gives no title to any item either", () => {
    const json = '{"state":"MERGED","title":"x"}\n{"state":"OPEN","title":"y"}';
    const out = bashActionsOf("gh pr view 12 --json state,title && gh issue view 7 --json state,title", json);
    expect(out.map((a) => a.title)).toEqual([undefined, undefined]);
  });

  it("a single viewed item's title is its own, with no ref to disambiguate against", () => {
    expect(bashActionsOf("gh issue view 7", GH_ISSUE_7_OPEN)[0].title).toBe("[e2e] Split dialogue in single quotes");
  });
});

// Trimmed from a real `glab mr view <n>` transcript (e2e-glab shim), owner renamed.
const GLAB_MR_17100_VIEW =
  "title:          Make debit posting idempotent\nstate:          opened\nsource_branch:  15178-idempotent-debits\ntarget_branch:  main\nauto_merge:     false\napproved:       false\nurl:            https://codehub.example/acme/billing/-/merge_requests/17100\n\nAdds an idempotency key column to debits and a unique index. Closes #15178";
const GLAB_MR_17201_MERGED_VIEW =
  "title:          15178: Large debits table migration with concurrent locking\nstate:          merged\nsource_branch:  15178-debits\ntarget_branch:  main\nauto_merge:     true\napproved:       false\nurl:            https://codehub.example/acme/billing/-/merge_requests/17201\n\nMigrate large debits table.";

describe("a view result's source/head branch fills `action.branch` when unambiguous", () => {
  it("glab mr view's `source_branch:` text field is the MR's branch", () => {
    expect(bashActionsOf("glab mr view 17100", GLAB_MR_17100_VIEW)[0]).toMatchObject({
      verb: "viewed",
      ref: "!17100",
      branch: "15178-idempotent-debits",
    });
  });

  it("gh pr view's JSON `headRefName` and glab's JSON `source_branch` are the branch", () => {
    expect(
      bashActionsOf("gh pr view 4711 --json headRefName,state", '{"headRefName":"e2e/ia-python","state":"OPEN"}')[0],
    ).toMatchObject({ branch: "e2e/ia-python" });
    expect(
      bashActionsOf(
        "glab mr view 17049 --output json",
        '{"iid":17049,"state":"opened","source_branch":"17049-docs"}',
      )[0],
    ).toMatchObject({ branch: "17049-docs" });
  });

  it("`glab mr view 17100 && gh pr view 12`: each gets only its own branch, never the other's", () => {
    const out = bashActionsOf("glab mr view 17100 && gh pr view 12", `${GLAB_MR_17100_VIEW}\n${GH_PR_12_MERGED}`);
    expect(out.find((a) => a.ref === "!17100")?.branch).toBe("15178-idempotent-debits");
    // gh's text block here carries no branch field, so #12/!12 stays unset — never borrows the MR's.
    expect(out.find((a) => a.ref === "!12")?.branch).toBeUndefined();
  });

  it("a chained view of two MRs: an ambiguous block (no number to key on) gives neither a branch", () => {
    const json = '{"state":"opened","source_branch":"a"}\n{"state":"merged","source_branch":"b"}';
    const out = bashActionsOf("glab mr view 17100 --output json && glab mr view 17201 --output json", json);
    expect(out.map((a) => a.branch)).toEqual([undefined, undefined]);
    // Given the number to key on, each unambiguous block gets its own branch.
    const withNumbers = bashActionsOf(
      "glab mr view 17100 && glab mr view 17201",
      `${GLAB_MR_17100_VIEW}\n${GLAB_MR_17201_MERGED_VIEW}`,
    );
    expect(withNumbers.map((a) => a.branch)).toEqual(["15178-idempotent-debits", "15178-debits"]);
  });

  it("a single viewed item's branch is its own, with no ref to disambiguate against", () => {
    expect(bashActionsOf("glab mr view 17100", GLAB_MR_17100_VIEW)[0].branch).toBe("15178-idempotent-debits");
  });
});

describe("an MR's branch is its head branch, never the session's starting branch", () => {
  it("`--head`, `-H` and glab `--source-branch` / `-s` name it", () => {
    const url = "https://github.com/acme/narrator/pull/14";
    expect(bashActionsOf('gh pr create --head e2e/ia-python --title "t" --body "b"', url)[0].branch).toBe(
      "e2e/ia-python",
    );
    expect(bashActionsOf('gh pr create -H dev:e2e/fork-branch --title "t" --body "b"', url)[0].branch).toBe(
      "e2e/fork-branch",
    );
    const glab =
      "!17201 15178: Large debits table migration (15178-debits)\nhttps://codehub.example/acme/billing/-/merge_requests/17201";
    expect(bashActionsOf('glab mr create -s 15178-debits --title "t"', glab)[0].branch).toBe("15178-debits");
  });

  it("glab's result line names the source branch when the command does not", () => {
    const glab =
      "!17200 WIP: postgres CI notes (#71) (71-postgres-ci)\nhttps://codehub.example/acme/billing/-/merge_requests/17200";
    expect(bashActionsOf('glab mr create --title "WIP" --target-branch main', glab)[0].branch).toBe("71-postgres-ci");
  });

  it("the branch pushed earlier in the session (or earlier in the chain) is the MR's branch", () => {
    const push =
      "To github.com:acme/narrator.git\n * [new branch]      e2e/ib-ffmpeg-hint -> e2e/ib-ffmpeg-hint\nbranch 'e2e/ib-ffmpeg-hint' set up to track 'origin/e2e/ib-ffmpeg-hint'.";
    const session = parseCC([
      ccUser("open a PR"),
      ...bash("tu_p", "git push -u origin e2e/ib-ffmpeg-hint", push),
      ...bash("tu_c", 'gh pr create --title "t" --body "b"', "https://github.com/acme/narrator/pull/13"),
    ]);
    expect(toolTurn(session, "tu_c").action).toMatchObject({ verb: "opened_mr", branch: "e2e/ib-ffmpeg-hint" });
    const chained = bashActionsOf(
      'git push -u origin e2e/ib-ffmpeg-hint && gh pr create --title "t"',
      `${push}\nhttps://github.com/acme/narrator/pull/13`,
    );
    expect(chained[1]).toMatchObject({ verb: "opened_mr", branch: "e2e/ib-ffmpeg-hint" });
  });

  it("no head flag and no push seen: the branch is unknown, not the session's branch", () => {
    const session = parseCC([
      ccUser("open a PR"),
      ...bash("tu_c", 'gh pr create --title "t" --body "b"', "https://github.com/acme/narrator/pull/13"),
    ]);
    expect(toolTurn(session, "tu_c").action?.branch).toBeUndefined();
    // A checkout to another branch after the push: the push no longer says which branch the MR is from.
    const moved = parseCC([
      ccUser("open a PR"),
      ...bash("tu_p", "git push origin feat", "To github.com:acme/narrator.git\n   abc1234..def5678  feat -> feat"),
      ...bash("tu_s", "git checkout other", "Switched to branch 'other'"),
      ...bash("tu_c", 'gh pr create --title "t" --body "b"', "https://github.com/acme/narrator/pull/13"),
    ]);
    expect(toolTurn(moved, "tu_c").action?.branch).toBeUndefined();
  });
});

describe("an amended commit is named by its own subject and sha, never by the command", () => {
  it("`git commit --amend --no-edit` takes subject and sha from the `[branch sha] subject` line", () => {
    const out = bashActionsOf(
      "git add README.md && git commit --amend --no-edit",
      "[e2e/ih-troubleshooting 5581a43] README: add download troubleshooting section (#8)\n Date: Sun Sep 27 01:39:12 2026 +0530\n 1 file changed, 12 insertions(+)",
    );
    expect(out.find((a) => a.verb === "rewrote")).toMatchObject({
      sha: "5581a43",
      subject: "README: add download troubleshooting section (#8)",
      branch: "e2e/ih-troubleshooting",
    });
  });

  it("`git commit --amend -m \"$(cat <<'EOF' …)\"` takes the amended subject, not the heredoc command", () => {
    const cmd =
      "git commit --amend -m \"$(cat <<'EOF'\nAdd installation section to README for issue #3\n\nCo-Authored-By: Codehub Model <bot@example.test>\nEOF\n)\"";
    const [a] = bashActionsOf(
      cmd,
      "[main f1cb991] Add installation section to README for issue #3\n Date: Sun Sep 27 01:34:09 2026 +0530\n 1 file changed, 6 insertions(+)",
    );
    expect(a).toMatchObject({
      verb: "rewrote",
      sha: "f1cb991",
      subject: "Add installation section to README for issue #3",
    });
  });
});

describe("a reopen is recorded, with state opened, so it supersedes an earlier close", () => {
  it("`gh issue reopen 6` after `gh issue close 6` yields closed then reopened", () => {
    const session = parseCC([
      ccUser("close then reopen"),
      ...bash("tu_x", "gh issue close 6", "✓ Closed issue acme/narrator#6 ([e2e] Status section is out of date)"),
      ...bash("tu_r", "gh issue reopen 6", "✓ Reopened issue acme/narrator#6 ([e2e] Status section is out of date)"),
    ]);
    expect(toolTurn(session, "tu_x").action).toMatchObject({ verb: "closed", ref: "#6", state: "closed" });
    expect(toolTurn(session, "tu_r").action).toMatchObject({ verb: "reopened", ref: "#6", state: "opened" });
  });

  it("glab and MCP reopen; a failed reopen is nothing", () => {
    expect(bashActionsOf("glab issue reopen 9", "- Reopening Issue #9\n✓ Reopened Issue #9")[0]).toMatchObject({
      verb: "reopened",
      ref: "#9",
    });
    expect(bashVerbs("gh issue reopen 6", "X issue #6 is not closed", true)).toEqual([]);
    expect(
      deriveToolActions({
        toolName: "mcp__gitlab__update_issue",
        input: { project_id: "acme/billing", issue_iid: 9, state_event: "reopen" },
        result: '{"state":"opened"}',
      }),
    ).toMatchObject([{ verb: "reopened", ref: "acme/billing#9", state: "opened", source: "mcp" }]);
    expect(
      deriveToolActions({
        toolName: "mcp__github__reopen_issue",
        input: { owner: "acme", repo: "narrator", issue_number: 6 },
        result: '{"state":"closed"}',
      }),
    ).toEqual([]);
  });
});

describe("a clean exit is a merge only for a foreground, non-auto, non-queued merge", () => {
  it("`--disable-auto` turns auto-merge off and merges nothing", () => {
    expect(bashVerbs("gh pr merge 5 --disable-auto", "")).toEqual([]);
    expect(bashVerbs("glab mr merge 5 --disable-auto", "")).toEqual([]);
  });

  it("auto-merge flags on gh and glab are never a merge", () => {
    expect(bashVerbs("gh pr merge 5 --auto --squash", "")).toEqual([]);
    expect(bashVerbs("glab mr merge 5 --auto-merge", "")).toEqual([]);
    expect(bashVerbs("glab mr merge 5 --when-pipeline-succeeds", "")).toEqual([]);
  });

  it("a backgrounded merge (`&`) has not exited, so its empty output proves nothing", () => {
    expect(bashVerbs("gh pr merge 5 --squash &", "")).toEqual([]);
    expect(bashVerbs("gh pr merge 5 --squash&", "")).toEqual([]);
    expect(bashVerbs("nohup gh pr merge 5 --squash > /dev/null 2>&1 &", "")).toEqual([]);
    expect(bashVerbs("glab mr merge 5 & wait", "")).toEqual([]);
    // Redirections and a quoted `&` are not backgrounding.
    expect(bashVerbs("gh pr merge 5 --squash 2>&1", "")).toEqual(["merged"]);
    expect(bashVerbs('gh pr merge 5 --squash --subject "fix a & b"', "")).toEqual(["merged"]);
  });

  it("a call run with `run_in_background`, or whose result says it runs in the background, is not a merge", () => {
    expect(
      deriveToolActions({
        toolName: "Bash",
        input: { command: "gh pr merge 5 --squash", run_in_background: true },
        result: "",
      }),
    ).toEqual([]);
    expect(bashVerbs("gh pr merge 5 --squash", "Command running in background with ID: bash_3")).toEqual([]);
    const session = parseCC([
      ccUser("merge it"),
      ...ccTool("tu_bg", "Bash", { command: "gh pr merge 5 --squash", run_in_background: true }, ""),
    ]);
    expect(toolTurn(session, "tu_bg").action).toBeUndefined();
  });

  it("a merge the forge only queued is not a merge", () => {
    expect(bashVerbs("gh pr merge 5 --squash", "✓ Pull request acme/api#5 will be added to the merge queue")).toEqual(
      [],
    );
    expect(bashVerbs("gh pr merge 5", "! Pull request #5 was added to the merge queue for main")).toEqual([]);
    expect(bashVerbs("gh pr merge 5", "Queued to merge")).toEqual([]);
    expect(bashVerbs("gh pr merge 5", "✓ Merged pull request #5 (added to the merge queue)")).toEqual([]);
  });

  it("a plain foreground merge with no output is still merged", () => {
    expect(bashVerbs("gh pr merge 5 --squash", "")).toEqual(["merged"]);
    expect(bashVerbs("glab mr merge 5", "")).toEqual(["merged"]);
  });
});

describe("a single view's branch comes from its own block, never a later command's output", () => {
  it("`gh issue view 7 && cat notes.md` never takes the branch from the cat output", () => {
    const [view] = bashActionsOf("gh issue view 7 && cat notes.md", `${GH_ISSUE_7_OPEN}\nhead: evil\n`);
    expect(view).toMatchObject({ verb: "viewed", ref: "#7" });
    expect(view.branch).toBeUndefined();
    const [json] = bashActionsOf("gh pr view 7 --json title && cat x.json", '{"title":"t"}\n{"headRefName":"evil"}');
    expect(json.branch).toBeUndefined();
  });

  it("the view's own metadata header still names the branch when another command follows", () => {
    const glab = "title:\tFix debits\nstate:\topen\nsource_branch:\t15178-debits\n--\nbody text";
    const [view] = bashActionsOf("glab mr view 17 && echo done", `${glab}\ndone`);
    expect(view.branch).toBe("15178-debits");
  });

  it("a view piped into a filter still owns all of the output", () => {
    const [view] = bashActionsOf("gh pr view 7 --json headRefName | cat", '{"headRefName":"feat-x"}');
    expect(view.branch).toBe("feat-x");
  });
});

describe("the last pushed branch belongs to the repo it was pushed from", () => {
  const push = "To github.com:acme/a.git\n * [new branch]      feat-a -> feat-a";

  it("a PR created after a `cd` into another repo does not get the other repo's pushed branch", () => {
    const session = parseCC([
      ccUser("open PRs"),
      ...bash("tu_p", "git push -u origin feat-a", push),
      ...bash("tu_c", 'cd ../b && gh pr create --title "t"', "https://github.com/acme/b/pull/3"),
    ]);
    expect(toolTurn(session, "tu_c").action?.branch).toBeUndefined();
  });

  it("a push with `git -C` into another repo is not the current repo's branch", () => {
    const session = parseCC([
      ccUser("open PRs"),
      ...bash("tu_p", "git -C ../a push -u origin feat-a", push),
      ...bash("tu_c", 'gh pr create --title "t"', "https://github.com/acme/b/pull/3"),
    ]);
    expect(toolTurn(session, "tu_c").action?.branch).toBeUndefined();
  });

  it("the `cd` persists across calls: a push after `cd a` and a later PR in the same shell pair up", () => {
    const session = parseCC([
      ccUser("open a PR"),
      ...bash("tu_p", "cd ../a && git push -u origin feat-a", push),
      ...bash("tu_c", 'gh pr create --title "t"', "https://github.com/acme/a/pull/3"),
    ]);
    expect(toolTurn(session, "tu_c").action).toMatchObject({ verb: "opened_mr", branch: "feat-a" });
  });
});

describe("forge action — multi-command output is attributed per segment (Q2)", () => {
  const derive = (command: string, result: string) =>
    deriveToolActions({ toolName: "Bash", input: { command }, result });

  it("an earlier auto-merge's pending line does not veto a later real merge", () => {
    const actions = derive(
      "glab mr merge 1 --auto-merge\nglab mr merge 1",
      "✓ Will merge when pipeline succeeds\n✓ Merged!\n",
    );
    expect(actions).toEqual([expect.objectContaining({ verb: "merged", ref: "!1", state: "merged" })]);
  });

  it("a real merge followed by an auto-merge on another MR: only the first merged", () => {
    const actions = derive(
      "glab mr merge 1\nglab mr merge 2 --auto-merge",
      "✓ Merged!\n✓ Will merge when pipeline succeeds\n",
    );
    expect(actions.filter((a) => a.verb === "merged").map((a) => a.ref)).toEqual(["!1"]);
  });

  it("untied output: the last merge is judged on the tail from the last outcome line", () => {
    const actions = derive(
      "glab mr merge 1 --auto-merge; glab mr view 1; glab mr merge 1",
      "✓ Will merge when pipeline succeeds\ntitle: t\nstate: open\n✓ Merged!\n✓ Merged!\n",
    );
    expect(actions.filter((a) => a.verb === "merged")).toEqual([
      expect.objectContaining({ ref: "!1", state: "merged" }),
    ]);
  });

  it("a merge whose own outcome is pending stays unmerged", () => {
    const actions = derive("glab mr merge 1\nglab mr merge 1 --auto-merge", "✓ Will merge when pipeline succeeds\n");
    expect(actions.filter((a) => a.verb === "merged")).toEqual([]);
  });

  it("mr create takes the created MR's URL, never an issue URL a prior view printed", () => {
    const actions = derive(
      "glab issue view 17\nglab mr create --title t --source-branch main",
      "url: https://codehub.example/acme/billing/-/issues/17\n!17 t (main)\nhttps://codehub.example/acme/billing/-/merge_requests/17\n",
    );
    expect(actions.find((a) => a.verb === "opened_mr")).toMatchObject({
      ref: "codehub.example/acme/billing!17",
      refKind: "merge_request",
      url: "https://codehub.example/acme/billing/-/merge_requests/17",
      branch: "main",
    });
  });

  it("gh pr create after a pr view takes the last PR URL (the create printed last)", () => {
    const actions = derive(
      "gh pr view 2\ngh pr create --title t",
      "url:\thttps://github.com/acme/a/pull/2\nhttps://github.com/acme/a/pull/3\n",
    );
    expect(actions.find((a) => a.verb === "opened_mr")).toMatchObject({
      refKind: "merge_request",
      url: "https://github.com/acme/a/pull/3",
    });
  });

  it("gh pr create followed by a view of another PR: ambiguous, no URL claimed", () => {
    const actions = derive(
      "gh pr create --title t\ngh pr view 2",
      "https://github.com/acme/a/pull/3\nurl:\thttps://github.com/acme/a/pull/2\n",
    );
    expect(actions.find((a) => a.verb === "opened_mr")?.url).toBeUndefined();
  });
});

describe("D-053 review fixes — merge pairing, checkout branch, fork heads", () => {
  const derive = (command: string, result: string) =>
    deriveToolActions({ toolName: "Bash", input: { command }, result });
  const merged = (command: string, result: string) =>
    derive(command, result)
      .filter((a) => a.verb === "merged")
      .map((a) => a.ref);

  it("untied multi-merge: a sibling's Merged line never proves an earlier merge (glab)", () => {
    expect(merged("glab mr merge 1; glab mr merge 2", "ERROR: 405 Method Not Allowed\n✓ Merged!\n")).toEqual(["!2"]);
  });

  it("untied multi-merge: a sibling's Merged line never proves an earlier merge (gh)", () => {
    expect(
      merged(
        "gh pr merge 1 --squash; gh pr merge 2 --squash",
        "X Pull request #1 is not mergeable: the merge commit cannot be cleanly created.\n✓ Squashed and merged pull request #2\n",
      ),
    ).toEqual(["!2"]);
  });

  it("gh pr checkout reads the local branch git switched to", () => {
    expect(derive("gh pr checkout 50", "Switched to a new branch 'contrib-typo'\n")[0]).toMatchObject({
      verb: "checked_out",
      branch: "contrib-typo",
    });
    expect(derive("glab mr checkout 7", "Switched to branch 'fix-7'\n")[0]).toMatchObject({ branch: "fix-7" });
    expect(derive("glab mr checkout 7", "Already on 'fix-7'\n")[0]).toMatchObject({ branch: "fix-7" });
  });

  it("gh pr checkout with no switch line leaves the branch unknown", () => {
    expect(derive("gh pr checkout 50", "")[0].branch).toBeUndefined();
    expect(derive("git checkout x && gh pr checkout 50", "Switched to branch 'x'\n")[1]?.branch).toBeUndefined();
  });

  it("a fork PR's head never names a branch of this repo", () => {
    const view = (json: string) => derive("gh pr view 50 --json headRefName", json)[0].branch;
    expect(view('{"headRefName":"main","isCrossRepository":true,"state":"OPEN"}')).toBeUndefined();
    expect(
      view(
        '{"headRefName":"main","headRepositoryOwner":{"id":"x","login":"bob"},"url":"https://github.com/acme/billing/pull/50"}',
      ),
    ).toBeUndefined();
    expect(
      view(
        '{"headRefName":"feat","headRepositoryOwner":{"id":"x","login":"acme"},"url":"https://github.com/acme/billing/pull/50"}',
      ),
    ).toBe("feat");
    expect(derive("gh pr view 50", "title:\tFix\nstate:\tOPEN\nhead:\tbob:main\n--\nbody")[0].branch).toBeUndefined();
    expect(
      derive("glab mr view 5 --output json", '{"source_branch":"main","source_project_id":9,"target_project_id":3}')[0]
        .branch,
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// D-051 F1 — which repo a command acted on. Structural evidence only, in
// order: a readable -R/--repo or GH_REPO; the directory the command ran in
// (tracked here, resolved to a repo by the importer via settleActionDir); the
// command's own result URL for the same item; else repoUnknown. Synthetic
// sessions, fictional CodeHub-style repos.
// ---------------------------------------------------------------------------

describe("F1: each action carries the directory it ran in", () => {
  const cwd = "/home/dev/billing";
  const bashCall = (command: string, result = "", extra: Record<string, unknown> = {}) =>
    deriveToolActions({ toolName: "Bash", input: { command }, result, cwd, ...extra });

  it("starts from the call's own cwd and follows literal cd / pushd / popd / git -C", () => {
    expect(bashCall("gh pr view 5")[0]).toMatchObject({ ref: "!5", dir: "/home/dev/billing" });
    expect(bashCall("cd services/ledger && glab mr view 5")[0].dir).toBe("/home/dev/billing/services/ledger");
    expect(bashCall("cd .. && gh issue view 5")[0].dir).toBe("/home/dev");
    expect(bashCall("cd /tmp/scratch/ledger && gh issue view 10")[0]).toMatchObject({
      ref: "#10",
      dir: "/tmp/scratch/ledger",
    });
    expect(bashCall("cd -- /srv/a; cd ../b && gh issue close 5", "✓ Closed issue #5")[0].dir).toBe("/srv/b");
    expect(bashCall("pushd /srv/other && popd && gh issue view 5")[0].dir).toBe("/home/dev/billing");
    expect(bashCall("builtin cd /srv/other && gh issue view 5")[0].dir).toBe("/srv/other");
    expect(bashCall("git -C . commit -m wip", "[main abc1234] wip")[0]).toMatchObject({
      verb: "committed",
      dir: "/home/dev/billing",
    });
    expect(bashCall("git -C /srv/other-clone commit -m wip", "[main abc1234] wip")[0].dir).toBe("/srv/other-clone");
    // S5: a cd back into the session's directory is followed, not latched.
    expect(bashCall("cd /tmp/x && ls; cd /home/dev/billing && gh issue view 5")[0]).toMatchObject({
      dir: "/home/dev/billing",
    });
    expect(bashCall("cd /tmp/x && ls; cd /home/dev/billing && gh issue view 5")[0].repoUnknown).toBeUndefined();
  });

  it('S5: `cd "$(git rev-parse --show-toplevel)"` stays in the same repo', () => {
    const out = bashCall('cd "$(git rev-parse --show-toplevel)" && gh issue view 5');
    expect(out[0]).toMatchObject({ ref: "#5", dir: "/home/dev/billing" });
    expect(out[0].repoUnknown).toBeUndefined();
    const moved = bashCall('cd /srv/other && cd "$(git rev-parse --show-toplevel)" && gh issue view 5');
    expect(moved[0].dir).toBe("/srv/other");
  });

  it("a change this parser cannot follow loses the directory: repoUnknown unless the item's own URL names the repo", () => {
    for (const cmd of [
      "R=$HOME/clones/ledger; cd $R; gh issue close 5",
      "cd ~/clones/ledger && gh issue close 5",
      "cd - && gh issue close 5",
      "cd && gh issue close 5",
      "popd && gh issue close 5",
      "git --git-dir=/srv/x/.git commit -m wip",
    ]) {
      const out = bashCall(cmd, cmd.includes("commit") ? "[main abc1234] wip" : "✓ Closed issue #5");
      expect(out[0], cmd).toMatchObject({ repoUnknown: true });
      expect(out[0].dir, cmd).toBeUndefined();
    }
    const shown = bashCall(
      "cd $CLONE && glab issue close 17",
      "✓ Closed issue #17\nurl: https://codehub.example/acme/ledger/-/issues/17",
    );
    expect(shown[0]).toMatchObject({ verb: "closed", ref: "codehub.example/acme/ledger#17" });
    expect(shown[0].repoUnknown).toBeUndefined();
  });

  it("S2 (review repros): a cd inside a brace group, loop, subshell or after `builtin` is never missed", () => {
    for (const cmd of [
      "{ cd /tmp/o; gh issue close 5; }",
      "for d in /tmp/o; do cd $d; gh issue close 5; done",
      "ls | while read d; do cd /tmp/o; gh issue close 5; done",
      "if true; then cd /tmp/o; fi; gh issue close 5",
    ]) {
      const out = bashCall(cmd, "✓ Closed issue #5");
      // Either no action at all (the construct hides the command) or one that is repoUnknown — never a bare ref with a dir.
      for (const a of out) {
        expect(a.repoUnknown, cmd).toBe(true);
        expect(a.dir, cmd).toBeUndefined();
      }
    }
    // A subshell's cd ends with the subshell: the next command runs where the call started.
    expect(bashCall("(cd /tmp/o && make); gh issue close 5", "✓ Closed issue #5")[0]).toMatchObject({
      ref: "#5",
      dir: "/home/dev/billing",
    });
  });

  it("S1 (review repros): GH_REPO inline or exported is gh's -R; unreadable or unexported is repoUnknown", () => {
    expect(bashCall("GH_REPO=other/ledger gh issue view 5")[0]).toMatchObject({ ref: "github.com/other/ledger#5" });
    expect(bashCall("GH_REPO=other/ledger gh issue view 5")[0].dir).toBeUndefined();
    expect(bashCall("export GH_REPO=other/ledger; gh issue close 5", "✓ Closed issue #5")[0]).toMatchObject({
      verb: "closed",
      ref: "github.com/other/ledger#5",
    });
    expect(bashCall("env GH_REPO=other/ledger gh pr view 7")[0]).toMatchObject({ ref: "github.com/other/ledger!7" });
    expect(bashCall('GH_REPO="$R" gh issue view 5')[0]).toMatchObject({ ref: "#5", repoUnknown: true });
    expect(bashCall("GH_REPO=other/ledger; gh issue view 5")[0]).toMatchObject({ repoUnknown: true });
    expect(bashCall("GH_HOST=forge.example gh issue view 5")[0]).toMatchObject({ repoUnknown: true });
    // The flag wins over the environment, as in gh itself.
    expect(bashCall("GH_REPO=other/ledger gh issue view 5 -R acme/billing")[0].ref).toBe("github.com/acme/billing#5");
    // N2: a glab host override leaves the repo unreadable.
    expect(bashCall("GITLAB_HOST=other.example glab mr merge 5", "✓ Merged!")[0]).toMatchObject({
      repoUnknown: true,
    });
    expect(bashCall("glab mr view 5 -R group/sub/project")[0].ref).toBe("group/sub/project!5");
  });

  it("-R from a literal variable the command assigned is read; an unreadable -R is repoUnknown", () => {
    const set = bashCall("R=acme/ledger\ngh pr diff 18 -R $R --name-only", "README.md");
    expect(set[0]).toMatchObject({ verb: "viewed", ref: "github.com/acme/ledger!18" });
    const unset = bashCall('gh pr view 19 -R "$REPO"', "{}");
    expect(unset[0]).toMatchObject({ ref: "!19", repoUnknown: true });
  });

  it("S3: a result URL is kept as a fallback only when it is the command's own item (kind + number) in one repo", () => {
    const one = bashCall(
      "gh issue view 5",
      "title:\tFive\nurl:\thttps://codehub.example/acme/ledger/issues/5\n--\nbody",
    );
    expect(one[0]).toMatchObject({ ref: "#5", shownRepo: "codehub.example/acme/ledger" });
    const two = bashCall(
      "gh issue close 5",
      "✓ Closed issue #5\nhttps://codehub.example/acme/ledger/issues/5\nhttps://codehub.example/acme/billing/issues/5",
    );
    expect(two[0].shownRepo).toBeUndefined();
    const otherKind = bashCall("gh pr view 5", "url:\thttps://codehub.example/acme/ledger/issues/5");
    expect(otherKind[0].shownRepo).toBeUndefined();
    const otherNumber = bashCall("cd $X && gh pr view 12", "url:\thttps://codehub.example/acme/ledger/pull/21");
    expect(otherNumber[0]).toMatchObject({ repoUnknown: true });
  });

  it("R2-S1 (review repros): a URL in a view's body or comments is never evidence — only the command's own result lines", () => {
    const body = "title:\tFive\nstate:\tOPEN\n--\nThis mirrors https://codehub.example/acme/billing/issues/5";
    const inline = "title:\tFive\nThis mirrors https://codehub.example/acme/billing/issues/5";
    expect(bashCall("gh issue view 5", body)[0].shownRepo).toBeUndefined();
    expect(bashCall("gh issue view 5", inline)[0].shownRepo).toBeUndefined();
    // A lone URL line in a TTY-rendered body is not the view's own line either.
    expect(
      bashCall("gh issue view 5", "Five\n\n  https://codehub.example/acme/billing/issues/5\n")[0].shownRepo,
    ).toBeUndefined();
    for (const cmd of ["cd ~/x && gh issue view 5", 'gh issue view 5 -R "$X"', "cd $GONE && gh issue view 5"]) {
      expect(bashCall(cmd, body)[0], cmd).toMatchObject({ ref: "#5", repoUnknown: true });
      expect(bashCall(cmd, inline)[0], cmd).toMatchObject({ ref: "#5", repoUnknown: true });
    }
    // The view's own header field, gh/glab's own "View this … on" line, and a --json top-level url still count.
    expect(
      bashCall(
        "cd ~/x && glab issue view 5",
        "title:\tFive\nurl:\thttps://codehub.example/acme/ledger/-/issues/5\n--\nsee https://codehub.example/acme/billing/-/issues/5",
      )[0],
    ).toMatchObject({ ref: "codehub.example/acme/ledger#5" });
    expect(
      bashCall(
        "cd ~/x && glab issue view 5",
        "Five\nbody\n\nView this issue on CodeHub: https://codehub.example/acme/ledger/-/issues/5",
      )[0],
    ).toMatchObject({ ref: "codehub.example/acme/ledger#5" });
    expect(
      bashCall(
        "cd ~/x && gh issue view 5 --json url,body",
        JSON.stringify({
          body: "mirrors https://codehub.example/acme/billing/issues/5",
          url: "https://codehub.example/acme/ledger/issues/5",
        }),
      )[0],
    ).toMatchObject({ ref: "codehub.example/acme/ledger#5" });
    expect(
      bashCall(
        "cd ~/x && gh issue view 5 --json body",
        JSON.stringify({ body: "https://codehub.example/acme/billing/issues/5" }),
      )[0],
    ).toMatchObject({ repoUnknown: true });
    // R3-B1: another segment's output BEFORE this one is never this command's line either.
    const url = "https://codehub.example/acme/billing/issues/5";
    expect(bashCall("cd ~/x && cat notes.txt; gh issue close 5", `${url}\n✓ Closed issue #5`)[0]).toMatchObject({
      ref: "#5",
      repoUnknown: true,
    });
    expect(
      bashCall("cd ~/x && git log -1 && gh issue close 5", `commit abc\n\n    ${url}\n${url}\n✓ Closed issue #5`).find(
        (a) => a.verb === "closed",
      ),
    ).toMatchObject({ ref: "#5", repoUnknown: true });
    // A silent `cd` / assignment is no other output: the command's own line still counts.
    expect(bashCall(`cd ~/x && R=1 && gh issue close 5`, `✓ Closed issue #5\n${url}`)[0]).toMatchObject({
      ref: "codehub.example/acme/billing#5",
    });
    // Another segment's output after this one is never this command's line.
    expect(
      bashCall(
        "cd ~/x && gh issue close 5; echo https://codehub.example/acme/billing/issues/5",
        "✓ Closed issue #5\nhttps://codehub.example/acme/billing/issues/5",
      )[0],
    ).toMatchObject({ repoUnknown: true });
  });

  it("with no cwd recorded, only a literal absolute move gives a dir (the legacy reading otherwise)", () => {
    const none = deriveToolActions({ toolName: "Bash", input: { command: "gh issue view 5" }, result: "" });
    expect(none[0]).toEqual({ verb: "viewed", ref: "#5", refKind: "issue", source: "cli" });
    const rel = deriveToolActions({ toolName: "Bash", input: { command: "cd sub && gh issue view 5" }, result: "" });
    expect(rel[0].repoUnknown).toBe(true);
  });

  it("B1: the Claude Code parser gives each call its OWN cwd, so no call is judged against another's directory", () => {
    const session = parseCCRaw([
      ccUser("look at the other clone"),
      ...bash("toolu_f1a", "gh issue close 5", "✓ Closed issue #5").map((e) => ({ ...e, cwd: "/home/dev/billing" })),
      ...bash("toolu_f1b", "gh issue close 6", "✓ Closed issue #6").map((e) => ({
        ...e,
        cwd: "/tmp/scratch/ledger",
      })),
    ]);
    expect(session.repo.path).toBe("/tmp/scratch/ledger");
    expect(toolTurn(session, "toolu_f1a").action).toMatchObject({ ref: "#5", dir: "/home/dev/billing" });
    expect(toolTurn(session, "toolu_f1b").action).toMatchObject({ ref: "#6", dir: "/tmp/scratch/ledger" });
  });
});

describe("F1: settleActionDir applies the importer's verdict for an action's directory", () => {
  const base: ForgeAction = { verb: "closed", ref: "#5", refKind: "issue", state: "closed", source: "cli" };

  it("the project's own directory keeps a bare ref; the local-only fields are dropped", () => {
    expect(settleActionDir({ ...base, dir: "/home/dev/billing" }, { kind: "project" })).toEqual(base);
    expect(settleActionDir({ ...base, dir: "/x", shownRepo: "acme/ledger" }, { kind: "project" })).toEqual(base);
  });

  it("another repo qualifies an item (branch dropped); a ref-less action there is repoUnknown", () => {
    expect(
      settleActionDir(
        { verb: "checked_out", ref: "!7", refKind: "merge_request", branch: "feat", source: "cli", dir: "/x" },
        { kind: "repo", repo: "acme/ledger" },
      ),
    ).toEqual({ verb: "checked_out", ref: "acme/ledger!7", refKind: "merge_request", source: "cli" });
    expect(
      settleActionDir(
        { verb: "committed", refKind: "commit", sha: "abc1234", branch: "main", source: "cli", dir: "/x" },
        { kind: "repo", repo: "acme/ledger" },
      ),
    ).toMatchObject({ verb: "committed", repoUnknown: true });
  });

  it("an unknown directory falls back to the item's own result URL, else repoUnknown", () => {
    expect(settleActionDir({ ...base, dir: "/gone", shownRepo: "acme/ledger" }, { kind: "unknown" })).toEqual({
      ...base,
      ref: "acme/ledger#5",
    });
    expect(settleActionDir({ ...base, dir: "/gone" }, { kind: "unknown" })).toEqual({ ...base, repoUnknown: true });
  });

  it("an action with no dir (MCP, pasted, legacy) is untouched", () => {
    expect(settleActionDir(base, { kind: "unknown" })).toEqual(base);
  });
});

describe("attribution v3 — an issue create is an observed `opened` on the item its own result line names", () => {
  it("`gh issue create` printing the new issue's URL yields opened on that issue", () => {
    expect(
      bashAction(
        'gh issue create --title "Ledger drift" --body "..."',
        "https://codehub.example/acme/billing/issues/161",
      ),
    ).toEqual({
      verb: "opened",
      ref: "codehub.example/acme/billing#161",
      refKind: "issue",
      url: "https://codehub.example/acme/billing/issues/161",
      source: "cli",
    });
  });

  it("`glab issue create` with its `#N title` line and the URL below it yields opened", () => {
    const result =
      "- Creating issue in acme/billing\n#162 Ledger drift (just now)\n https://codehub.example/acme/billing/-/issues/162";
    expect(bashAction('glab issue create --title "Ledger drift" --description "..." --yes', result)).toMatchObject({
      verb: "opened",
      ref: "codehub.example/acme/billing#162",
      refKind: "issue",
    });
  });

  it("a failed create with no URL on its own result line records nothing", () => {
    expect(bashVerbs('gh issue create --title "x" --body "y"', "could not create issue: HTTP 422", true)).toEqual([]);
    expect(bashVerbs('gh issue create --title "x" --body "y"', "")).toEqual([]);
  });

  it("a URL only in another segment's output is not the create's: nothing is recorded", () => {
    expect(
      bashVerbs(
        'gh issue create --title "x" --body "y"; cat notes.md',
        "https://codehub.example/acme/billing/issues/5\nhttps://codehub.example/acme/billing/issues/9",
      ),
    ).toEqual([]);
  });

  it("an MR/PR URL is not an issue: `gh issue create` whose output shows a pull URL records nothing", () => {
    expect(bashVerbs('gh issue create --title "x" --body "y"', "https://codehub.example/acme/billing/pull/5")).toEqual(
      [],
    );
  });
});

describe("v3 item 6 — a cross-repo ref keeps the forge host that is already known", () => {
  const bashCall = (command: string, result = "") =>
    deriveToolActions({ toolName: "Bash", input: { command }, result, cwd: "/home/dev/billing" });
  it("gh: `-R owner/repo` and GH_REPO are github.com items (gh's default host)", () => {
    expect(bashAction("gh issue view 10 -R acme/audiobooks", "title:\tTen\nstate:\tOPEN")?.ref).toBe(
      "github.com/acme/audiobooks#10",
    );
    expect(bashCall("GH_REPO=acme/audiobooks gh issue comment 10 --body x")[0].ref).toBe(
      "github.com/acme/audiobooks#10",
    );
  });

  it("gh: `-R HOST/owner/repo` and a readable GH_HOST keep that host; an unreadable GH_HOST keeps none", () => {
    expect(bashCall("gh issue view 10 -R forge.example/acme/audiobooks")[0].ref).toBe(
      "forge.example/acme/audiobooks#10",
    );
    expect(bashCall("GH_HOST=forge.example gh issue view 10 -R acme/audiobooks")[0].ref).toBe(
      "forge.example/acme/audiobooks#10",
    );
    expect(bashCall('GH_HOST="$H" gh issue view 10 -R acme/audiobooks')[0].ref).toBe("acme/audiobooks#10");
  });

  it("B1/B2 precedence: the item's own result URL host beats gh's github.com default (GitHub Enterprise)", () => {
    expect(
      bashAction('gh issue create --title "x" --body "y"', "https://github.com/acme/audiobooks/issues/12")?.ref,
    ).toBe("github.com/acme/audiobooks#12");
    expect(
      bashAction('gh pr create --title "x" --body "y"', "https://ghe.corp.example/acme/billing/pull/4711")?.ref,
    ).toBe("ghe.corp.example/acme/billing!4711");
    // -R owner/repo on a GHE host: the command's own result line shows the host.
    expect(
      bashCall(
        "gh issue comment 5 -R acme/api --body hi",
        "https://ghe.corp.example/acme/api/issues/5#issuecomment-1",
      )[0].ref,
    ).toBe("ghe.corp.example/acme/api#5");
    // An explicit -R HOST/… outranks even the result URL.
    expect(
      bashCall(
        "gh issue close 5 -R forge.example/acme/api",
        "✓ Closed issue #5\nhttps://other.example/acme/api/issues/5",
      )[0].ref,
    ).toBe("forge.example/acme/api#5");
    // A URL for a different repo or number is not this item's: the tool default applies.
    expect(bashCall("gh issue view 5 -R acme/api", "url:\thttps://ghe.corp.example/acme/other/issues/5")[0].ref).toBe(
      "github.com/acme/api#5",
    );
  });

  it("glab create keeps the host its own output proved (no GITLAB_HOST needed)", () => {
    expect(
      bashAction('glab issue create --title "x" --description "y" --yes', "https://gitlab.com/acme/api/-/issues/12")
        ?.ref,
    ).toBe("gitlab.com/acme/api#12");
  });

  it("a bare ref's shownRepo carries its URL host, and it outranks the directory remote's host for the same repo", () => {
    const shown = bashCall(
      "gh issue view 5",
      "title:\tFive\nurl:\thttps://ghe.corp.example/acme/ledger/issues/5\n--\nbody",
    )[0];
    expect(shown.shownRepo).toBe("ghe.corp.example/acme/ledger");
    expect(settleActionDir(shown, { kind: "repo", repo: "github.com/acme/ledger" }).ref).toBe(
      "ghe.corp.example/acme/ledger#5",
    );
    expect(settleActionDir(shown, { kind: "repo", repo: "github.com/acme/other" }).ref).toBe("github.com/acme/other#5");
  });

  it("glab: a readable GITLAB_HOST with -R gives the host; otherwise no host", () => {
    expect(bashCall("glab mr view 5 -R group/sub/project")[0].ref).toBe("group/sub/project!5");
    expect(bashCall("GITLAB_HOST=codehub.example glab mr view 5 -R acme/billing")[0].ref).toBe(
      "codehub.example/acme/billing!5",
    );
    expect(bashCall("glab mr view 5 -R codehub.example/acme/billing")[0].ref).toBe("codehub.example/acme/billing!5");
  });

  it("a bare ref stays bare (its directory decides its repo later)", () => {
    expect(bashCall("gh issue view 5")[0].ref).toBe("#5");
  });
});
