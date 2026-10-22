// D-051 F1 (round 2): which repo each forge action acted on, resolved at
// import from the directory it ran in, by the same mechanism that names the
// session's project (git top level + origin remote). Real temp git repos,
// fictional CodeHub-style remotes.
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeCodeParser, type ForgeAction, type RawCodeSession, type RawTurn } from "@membral/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { remoteHost, settleSessionActionRepos } from "../action-repos.js";
import { sessionForWire } from "../code-session-upload.js";
import { resolveGitRemote } from "../git-remote.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", ["-c", "user.name=Dev", "-c", "user.email=dev@codehub.example", ...args], {
    cwd,
    stdio: "ignore",
  });
}

async function repo(path: string, remotes: Record<string, string>): Promise<string> {
  await mkdir(path, { recursive: true });
  git(path, "init", "-q", "-b", "main");
  for (const [name, url] of Object.entries(remotes)) git(path, "remote", "add", name, url);
  await writeFile(join(path, "README.md"), "x\n");
  git(path, "add", "README.md");
  git(path, "commit", "-q", "-m", "init");
  return path;
}

let root: string;
let billing: string;
let ledger: string;
let plain: string;
let multi: string;
let worktree: string;
let nested: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "membral-action-repos-")));
  billing = await repo(join(root, "billing"), { origin: "git@codehub.example:acme/billing.git" });
  await mkdir(join(billing, "pkg", "api"), { recursive: true });
  ledger = await repo(join(root, "ledger"), { origin: "https://codehub.example/acme/ledger.git" });
  multi = await repo(join(root, "fork"), {
    origin: "https://codehub.example/dev/billing.git",
    upstream: "https://codehub.example/acme/billing.git",
  });
  plain = join(root, "notes");
  await mkdir(plain, { recursive: true });
  worktree = join(root, "billing-wt");
  git(billing, "worktree", "add", "-q", worktree, "-b", "wt");
  // N1: an independent clone of another repo nested inside the project's directory.
  nested = await repo(join(billing, "vendor-ledger"), { origin: "https://codehub.example/acme/ledger.git" });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let n = 0;
function ts(): string {
  n += 1;
  return `2026-09-27T09:00:${String(n % 60).padStart(2, "0")}.000Z`;
}

/** One Claude Code Bash call (tool_use + tool_result) recorded at `cwd`. */
function call(cwd: string, command: string, result = ""): object[] {
  const id = `toolu_${++n}`;
  return [
    {
      type: "assistant",
      cwd,
      message: {
        id: `msg_${id}`,
        role: "assistant",
        model: "codehub-model-1",
        content: [{ type: "tool_use", id, name: "Bash", input: { command } }],
      },
      timestamp: ts(),
      sessionId: "s1",
    },
    {
      type: "user",
      cwd,
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: result }] },
      toolUseResult: { stdout: result },
      timestamp: ts(),
      sessionId: "s1",
    },
  ];
}

function user(cwd: string, text: string): object {
  return { type: "user", cwd, message: { role: "user", content: text }, timestamp: ts(), sessionId: "s1" };
}

async function importLike(events: object[]): Promise<RawCodeSession> {
  const raw = `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
  const session = claudeCodeParser.parse({ source: "claude-code", sourceSessionId: "s1", path: "n/a" }, raw);
  session.repo.remoteUrl = await resolveGitRemote(session.repo.path);
  await settleSessionActionRepos(session, [session.repo]);
  return session;
}

function actions(session: RawCodeSession): ForgeAction[] {
  return session.turns
    .filter((t: RawTurn) => t.kind === "tool_use")
    .flatMap((t) => t.actions ?? (t.action ? [t.action] : []));
}

function only(session: RawCodeSession): ForgeAction {
  const list = actions(session);
  expect(list).toHaveLength(1);
  return list[0];
}

describe("B1 (review repro): first and last cwd never disagree — each action is judged by its own directory", () => {
  it("close #5 in billing, then close #6 in ledger: project = ledger (last cwd), #5 stays billing's", async () => {
    const s = await importLike([
      user(billing, "close both"),
      ...call(billing, "gh issue close 5", "✓ Closed issue #5"),
      ...call(ledger, "gh issue close 6", "✓ Closed issue #6"),
    ]);
    expect(s.repo.path).toBe(ledger);
    const [five, six] = actions(s);
    expect(five).toMatchObject({ verb: "closed", ref: "codehub.example/acme/billing#5" });
    expect(six).toMatchObject({ verb: "closed", ref: "#6" });
    for (const a of [five, six]) {
      expect(a.repoUnknown).toBeUndefined();
      expect(a.dir).toBeUndefined();
    }
  });
});

describe("B2 (review repro): a sub-agent's actions are judged against its parent's project too", () => {
  async function child(cwd: string, command: string, result: string): Promise<RawCodeSession> {
    const raw = `${[user(cwd, "brief"), ...call(cwd, command, result)].map((e) => JSON.stringify(e)).join("\n")}\n`;
    const c = claudeCodeParser.parse({ source: "claude-code", sourceSessionId: "c1", path: "n/a" }, raw);
    c.parentSessionId = "s1";
    c.repo.remoteUrl = await resolveGitRemote(c.repo.path);
    await settleSessionActionRepos(c, [c.repo, { path: billing, remoteUrl: await resolveGitRemote(billing) }]);
    return c;
  }

  it("a child that started in another clone never folds a bare ref into the parent's project", async () => {
    const c = await child(ledger, "gh issue close 7", "✓ Closed issue #7");
    expect(only(c)).toMatchObject({ verb: "closed", ref: "codehub.example/acme/ledger#7" });
  });

  it("a child in the parent's own repo keeps the bare ref; its ref-less commit elsewhere is repoUnknown", async () => {
    expect(only(await child(billing, "gh issue close 7", "✓ Closed issue #7"))).toMatchObject({ ref: "#7" });
    const commit = only(await child(ledger, "git commit -m wip", "[main abc1234] wip"));
    expect(commit).toMatchObject({ verb: "committed", repoUnknown: true });
  });
});

describe("regressions that must still link (session in the project repo)", () => {
  it("a cd into a subdirectory, the session cwd itself a subdirectory, and cd .. from it", async () => {
    expect(only(await importLike([user(billing, "x"), ...call(billing, "cd pkg && gh issue view 5")])).ref).toBe("#5");
    const sub = join(billing, "pkg", "api");
    const s = await importLike([
      user(sub, "x"),
      ...call(sub, "gh issue view 5"),
      ...call(sub, "cd .. && gh issue view 6"),
    ]);
    expect(actions(s).map((a) => [a.ref, a.repoUnknown])).toEqual([
      ["#5", undefined],
      ["#6", undefined],
    ]);
  });

  it('`git -C .`, `cd "$(git rev-parse --show-toplevel)"` and a cd back after leaving (S5)', async () => {
    const commit = only(
      await importLike([user(billing, "x"), ...call(billing, "git -C . commit -m wip", "[main abc1234] wip")]),
    );
    expect(commit).toMatchObject({ verb: "committed", sha: "abc1234" });
    expect(commit.repoUnknown).toBeUndefined();
    const top = await importLike([
      user(join(billing, "pkg"), "x"),
      ...call(join(billing, "pkg"), 'cd "$(git rev-parse --show-toplevel)" && gh issue view 5'),
    ]);
    expect(only(top).ref).toBe("#5");
    const back = await importLike([
      user(billing, "x"),
      ...call(billing, `cd ${plain} && ls; cd ${billing} && gh issue view 5`),
    ]);
    expect(only(back)).toMatchObject({ ref: "#5" });
    expect(only(back).repoUnknown).toBeUndefined();
  });

  it("a worktree of the same repo at a sibling path is the same project", async () => {
    const s = await importLike([
      user(billing, "x"),
      ...call(billing, "cd ../billing-wt && gh issue close 5", "✓ Closed issue #5"),
    ]);
    expect(only(s)).toMatchObject({ verb: "closed", ref: "#5" });
    const wtSession = await importLike([user(worktree, "x"), ...call(billing, "gh issue view 9")]);
    expect(only(wtSession).ref).toBe("#9");
  });

  it("a silent clean `gh pr merge` in the repo directory is a merge (D-054)", async () => {
    const s = await importLike([user(billing, "x"), ...call(billing, "gh pr merge 7 --squash", "")]);
    expect(only(s)).toMatchObject({ verb: "merged", ref: "!7", state: "merged" });
  });
});

describe("another or unknown repo", () => {
  it("S3 (review repro): the directory's repo outranks a same-number URL in the body", async () => {
    const s = await importLike([
      user(billing, "x"),
      ...call(billing, `cd ${ledger} && gh issue view 5`, "dup of https://codehub.example/acme/billing/issues/5"),
    ]);
    expect(only(s).ref).toBe("codehub.example/acme/ledger#5");
  });

  it("N1: an independent clone nested in the project directory is its own repo", async () => {
    const s = await importLike([
      user(billing, "x"),
      ...call(billing, "cd vendor-ledger && gh issue close 5", "✓ Closed issue #5"),
    ]);
    expect(only(s).ref).toBe("codehub.example/acme/ledger#5");
    expect(nested).toContain("vendor-ledger");
  });

  it("not a repo, missing, or several remotes: repoUnknown — unless the item's own URL names one repo", async () => {
    for (const dir of [plain, join(root, "deleted-since"), multi]) {
      const s = await importLike([
        user(billing, "x"),
        ...call(billing, `cd ${dir} && gh issue close 5`, "✓ Closed issue #5"),
      ]);
      expect(only(s), dir).toMatchObject({ ref: "#5", repoUnknown: true });
    }
    const shown = await importLike([
      user(billing, "x"),
      ...call(
        billing,
        `cd ${plain} && glab issue close 17`,
        "✓ Closed issue #17\nurl: https://codehub.example/acme/ledger/-/issues/17",
      ),
    ]);
    expect(only(shown)).toMatchObject({ ref: "codehub.example/acme/ledger#17" });
  });
});

describe("S4: the upload never sends what an old server would misread", () => {
  it("repoUnknown actions are omitted; local-only fields never leave; settled sessions pass through", async () => {
    const s = await importLike([
      user(billing, "x"),
      ...call(billing, `cd ${plain} && gh issue close 5 && gh issue view 6`, "✓ Closed issue #5"),
      ...call(billing, "gh issue view 8"),
    ]);
    const wire = sessionForWire(s);
    const sent = wire.turns.flatMap((t) => t.actions ?? (t.action ? [t.action] : []));
    expect(sent.map((a) => a.ref)).toEqual(["#8"]);
    expect(JSON.stringify(wire)).not.toContain('"dir"');
    expect(JSON.stringify(wire)).not.toContain("repoUnknown");
  });

  it("an import path that never settled: a dir literally the session's own stays, anything else is dropped", () => {
    const turn = (dir: string, ref: string): RawTurn =>
      ({
        idx: 0,
        role: "assistant",
        kind: "tool_use",
        action: { verb: "viewed", ref, refKind: "issue", source: "cli", dir },
      }) as RawTurn;
    const session = {
      repo: { path: "/home/dev/billing" },
      turns: [turn("/home/dev/billing", "#1"), turn("/home/dev/billing/pkg", "#2"), turn("/srv/x", "#3")],
    } as unknown as RawCodeSession;
    const wire = sessionForWire(session);
    expect(wire.turns.map((t) => t.action)).toEqual([
      { verb: "viewed", ref: "#1", refKind: "issue", source: "cli" },
      undefined,
      undefined,
    ]);
    const child = sessionForWire({ ...session, parentSessionId: "p" } as RawCodeSession);
    expect(child.turns.every((t) => t.action === undefined)).toBe(true);
  });
});

describe("round 3", () => {
  it("R2-S2: a session in a worktree removed before import keeps its actions on the project", async () => {
    const gone = join(billing, ".claude", "worktrees", "gone");
    git(billing, "worktree", "add", "-q", gone, "-b", "gone-wt");
    await rm(gone, { recursive: true, force: true });
    const s = await importLike([
      user(gone, "x"),
      ...call(gone, "gh issue close 5", "✓ Closed issue #5"),
      ...call(gone, "git commit -m wip", "[gone-wt abc1234] wip"),
      ...call(gone, `cd ${join(root, "gone-elsewhere")} && gh issue view 6`),
    ]);
    const [close, commit, elsewhere] = actions(s);
    expect(close).toMatchObject({ verb: "closed", ref: "#5" });
    expect(close.repoUnknown).toBeUndefined();
    expect(commit).toMatchObject({ verb: "committed", sha: "abc1234" });
    expect(commit.repoUnknown).toBeUndefined();
    // A deleted directory outside the session's own path and the project's root is still unknown.
    expect(elsewhere).toMatchObject({ ref: "#6", repoUnknown: true });
  });

  it("R2-S2 does not apply when the session's own cwd resolved to no repo", async () => {
    const notes = join(root, "notes-gone");
    const s = await importLike([user(notes, "x"), ...call(notes, "gh issue view 5")]);
    expect(only(s)).toMatchObject({ ref: "#5", repoUnknown: true });
  });

  it("R2-N2: a local-path or file:// remote names no repo", async () => {
    for (const [name, url] of [
      ["local-a", "/srv/git/ledger.git"],
      ["local-b", "file:///srv/git/ledger.git"],
    ]) {
      const dir = await repo(join(root, name), { origin: url });
      const s = await importLike([user(billing, "x"), ...call(billing, `cd ${dir} && gh issue view 5`)]);
      expect(only(s), url).toMatchObject({ ref: "#5", repoUnknown: true });
    }
  });

  it("R2-S1 (review repro): a fork whose view body links the project's same-number issue stays unknown", async () => {
    const body = "title:\tFive\n--\nThis mirrors https://codehub.example/acme/billing/issues/5";
    for (const cmd of [`cd ${multi} && gh issue view 5`, `cd ${join(root, "deleted-x")} && gh issue view 5`]) {
      const s = await importLike([user(billing, "x"), ...call(billing, cmd, body)]);
      expect(only(s), cmd).toMatchObject({ ref: "#5", repoUnknown: true });
    }
  });
});

describe("v3 item 6: a cross-repo ref resolved from a directory keeps its remote's host", () => {
  it("remoteHost reads scp and URL remotes; an ssh alias or a local path names no host", () => {
    expect(remoteHost("git@github.com:acme/audiobooks.git")).toBe("github.com");
    expect(remoteHost("https://GitHub.com/acme/audiobooks")).toBe("github.com");
    expect(remoteHost("ssh://git@codehub.example:2222/acme/ledger.git")).toBe("codehub.example");
    expect(remoteHost("git@work:acme/ledger.git")).toBeUndefined();
    expect(remoteHost("/srv/git/ledger.git")).toBeUndefined();
  });
});
