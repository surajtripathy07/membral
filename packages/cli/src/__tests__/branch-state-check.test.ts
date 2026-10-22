// branch-state-check.ts — the sweep's ref-keyed git check (goal 2026-09-26 W6 / P4; B4, B6, B9, B14).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Hermetic: never read the developer's real ~/.membral/credentials.json
// (same isolation as code-session-upload.test.ts / memory-kick.test.ts).
vi.mock("../credentials.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../credentials.js")>();
  return {
    ...actual,
    resolveCredentials: vi.fn((input: Parameters<typeof actual.resolveCredentials>[0]) =>
      actual.resolveCredentials({ ...input, credsPath: input.credsPath ?? "/nonexistent/credentials.json" }),
    ),
    loadCredentials: vi.fn((path?: string) => actual.loadCredentials(path ?? "/nonexistent/credentials.json")),
  };
});

const {
  assertRefKeyedGitArgs,
  checkRepoGroup,
  createGitRunner,
  gitChildEnv,
  groupReposByCommonDir,
  mergeCloneResults,
  repoPathFromRemote,
  resolveDefaultBranch,
  runBranchStateCheck,
} = await import("../branch-state-check.js");

import type { BranchCheckResult, ExecFileLike, GitResult, GitRunner, RepoRefsToCheck } from "../branch-state-check.js";

const A1 = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const B2 = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const HEAD = "9999999999999999999999999999999999999999";

/**
 * A scripted git: `answer(dir, args)` decides each call. Records every argv
 * so tests can assert on the whole surface.
 */
function scriptedGit(answer: (dir: string, args: string[]) => Partial<GitResult> | undefined) {
  const calls: { dir: string; args: string[] }[] = [];
  const git: GitRunner = async (dir, args) => {
    calls.push({ dir, args });
    assertRefKeyedGitArgs(args);
    const a = answer(dir, args) ?? { code: 1 };
    return { code: a.code ?? 0, stdout: a.stdout ?? "", stderr: a.stderr ?? "" };
  };
  return { git, calls };
}

/** A repo whose default branch is origin/main, where A1 is merged, B2 is not, `feat-1` exists and `gone-branch` does not. */
function typicalRepo(dir: string, args: string[]): Partial<GitResult> | undefined {
  const [sub, ...rest] = args;
  if (sub === "rev-parse" && rest[0] === "--git-common-dir") {
    if (dir.includes("not-a-repo")) return { code: 128, stderr: "fatal: not a git repository" };
    return { code: 0, stdout: dir.includes("-wt") ? "/home/dev/src/billing/.git\n" : ".git\n" };
  }
  if (sub === "remote") return { code: 0, stdout: "git@codehub.example:acme/billing.git\n" };
  if (sub === "rev-parse" && rest[0] === "--show-toplevel") return { code: 0, stdout: `${dir}\n` };
  if (sub === "symbolic-ref") return { code: 0, stdout: "origin/main\n" };
  if (sub === "show-ref") {
    const ref = rest[rest.length - 1];
    return { code: ref === "refs/heads/feat-1" || ref === "refs/heads/rewritten" ? 0 : 1 };
  }
  if (sub === "rev-parse" && rest[0] === "--verify") {
    const ref = rest[rest.length - 1];
    if (ref === "refs/heads/feat-1") return { code: 0, stdout: `${B2}\n` };
    if (ref === "refs/heads/rewritten") return { code: 0, stdout: `${HEAD}\n` };
    return { code: 1 };
  }
  if (sub === "cat-file") {
    const sha = rest[1].replace(/\^\{commit\}$/, "");
    return { code: sha === A1 || sha === B2 || sha === HEAD ? 0 : 1 };
  }
  if (sub === "merge-base") return { code: rest[1] === A1 ? 0 : 1 };
  return undefined;
}

function repo(over: Partial<RepoRefsToCheck> = {}): RepoRefsToCheck {
  return {
    codeProjectId: "p1",
    repoIdentity: "codehub.example/acme/billing",
    paths: ["/home/dev/src/billing"],
    shas: [],
    branches: [],
    openRefs: [],
    ...over,
  };
}

const byBranch = (results: BranchCheckResult[]) => Object.fromEntries(results.map((r) => [r.branch, r]));

describe("assertRefKeyedGitArgs / createGitRunner", () => {
  it("refuses time-keyed arguments, reflog and @{...} and any subcommand off the read-only list", () => {
    for (const bad of [
      ["log", "--since=yesterday"],
      ["rev-list", "--after", "2026-09-01"],
      ["log", "--until=now"],
      ["log", "--before=1.day"],
      ["reflog", "show"],
      ["rev-parse", "main@{yesterday}"],
      ["commit", "-m", "x"],
      ["push", "origin", "main"],
      ["checkout", "main"],
      ["log", "-1"],
      [],
    ]) {
      expect(() => assertRefKeyedGitArgs(bad), bad.join(" ")).toThrow(/refusing/);
    }
    expect(() => assertRefKeyedGitArgs(["merge-base", "--is-ancestor", A1, "refs/remotes/origin/main"])).not.toThrow();
    expect(() => assertRefKeyedGitArgs(["cat-file", "-e", `${A1}^{commit}`])).not.toThrow();
    // `remote` only as the exact read-only `remote get-url origin`.
    expect(() => assertRefKeyedGitArgs(["remote", "get-url", "origin"])).not.toThrow();
    for (const bad of [["remote", "add", "x", "y"], ["remote", "get-url", "--push", "origin"], ["remote"]]) {
      expect(() => assertRefKeyedGitArgs(bad), bad.join(" ")).toThrow(/refusing/);
    }
  });

  it("child git never inherits GIT_DIR/GIT_WORK_TREE and ssh runs in batch mode (a launchd fetch can never prompt)", () => {
    const env = gitChildEnv({ PATH: "/bin", GIT_DIR: "/elsewhere/.git", GIT_WORK_TREE: "/elsewhere" });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
    expect(env.GIT_TERMINAL_PROMPT).toBe("0");
    expect(env.PATH).toBe("/bin");
  });

  it("runs `git -C <dir> ...` through execFile with prompts and optional locks off, and maps exit codes", async () => {
    const execFileImpl = vi.fn<ExecFileLike>((_file, _args, _opts, cb) => {
      const args = _args as string[];
      if (args.includes("--is-ancestor")) cb(Object.assign(new Error("exit 1"), { code: 1 }), "", "");
      else cb(null, "origin/main\n", "");
    });
    const git = createGitRunner(execFileImpl);
    const ok = await git("/repo", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    expect(ok).toEqual({ code: 0, stdout: "origin/main\n", stderr: "" });
    const no = await git("/repo", ["merge-base", "--is-ancestor", A1, "refs/remotes/origin/main"]);
    expect(no.code).toBe(1);
    const call = execFileImpl.mock.calls[0];
    expect(call[0]).toBe("git");
    expect(call[1]).toEqual(["-C", "/repo", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
    expect(call[2].env?.GIT_TERMINAL_PROMPT).toBe("0");
    expect(call[2].env?.GIT_OPTIONAL_LOCKS).toBe("0");
    expect(call[2].env?.GIT_SSH_COMMAND).toBe("ssh -o BatchMode=yes");
  });

  it("a spawn failure (git missing) and a forbidden argv both resolve to code -1 instead of throwing", async () => {
    const enoent: ExecFileLike = (_f, _a, _o, cb) =>
      cb(Object.assign(new Error("spawn git ENOENT"), { code: "ENOENT" }), "", "");
    expect((await createGitRunner(enoent)("/repo", ["rev-parse", "--git-common-dir"])).code).toBe(-1);
    const spy = vi.fn<ExecFileLike>();
    const r = await createGitRunner(spy)("/repo", ["log", "--since=1.day"]);
    expect(r.code).toBe(-1);
    expect(r.stderr).toMatch(/refusing/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("groupReposByCommonDir", () => {
  it("worktrees of one repo are checked once: two paths sharing a --git-common-dir land in one group", async () => {
    const { git, calls } = scriptedGit(typicalRepo);
    const log = vi.fn();
    const r1 = repo({ paths: ["/home/dev/src/billing"] });
    // Same owner/repo reached through another host alias: host-stripped identity still matches.
    const r2 = repo({
      codeProjectId: "p2",
      repoIdentity: "ssh-alias.example/Acme/billing",
      paths: ["/home/dev/src/billing-wt2"],
    });
    const { groups, skippedRepos } = await groupReposByCommonDir([r1, r2], git, log);
    expect(groups).toHaveLength(1);
    expect(groups[0].commonDir).toBe("/home/dev/src/billing/.git");
    expect(groups[0].repos).toEqual([r1, r2]);
    expect(skippedRepos).toBe(0);
    expect(calls.map((c) => c.args)).toEqual([
      ["rev-parse", "--git-common-dir"],
      ["remote", "get-url", "origin"],
      ["rev-parse", "--git-common-dir"],
      ["remote", "get-url", "origin"],
    ]);
  });

  it("a repo path that is not a git checkout is skipped without failing; the next path of the same repo is tried", async () => {
    const { git } = scriptedGit(typicalRepo);
    const log = vi.fn();
    const { groups, skippedRepos } = await groupReposByCommonDir(
      [
        repo({ paths: ["/tmp/not-a-repo", "/home/dev/src/billing"] }),
        repo({ codeProjectId: "p3", repoIdentity: "gone", paths: ["/tmp/not-a-repo-either"] }),
      ],
      git,
      log,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].dir).toBe("/home/dev/src/billing");
    expect(skippedRepos).toBe(1);
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/not-a-repo is not a git checkout — skipped/);
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/no git checkout found for gone/);
  });

  it("only this project's checkout is checked: a removed clone inside a dotfiles repo at ~ is skipped, never checked as the project", async () => {
    // /home/dev/src/billing was deleted; the path now resolves into the dotfiles repo at /home/dev.
    const { git, calls } = scriptedGit((_d, a) => {
      if (a[0] === "rev-parse" && a[1] === "--git-common-dir") return { code: 0, stdout: "/home/dev/.git\n" };
      if (a[0] === "rev-parse" && a[1] === "--show-toplevel") return { code: 0, stdout: "/home/dev\n" };
      if (a[0] === "remote") return { code: 0, stdout: "https://codehub.example/dev/dotfiles.git\n" };
      return { code: 1 };
    });
    const log = vi.fn();
    const { groups, skippedRepos } = await groupReposByCommonDir(
      [
        repo({ paths: ["/home/dev/src/billing"] }),
        // A no-remote project keyed by its path: the enclosing repo's top level is not that path.
        repo({ codeProjectId: "p4", repoIdentity: "/home/dev/src/scratch", paths: ["/home/dev/src/scratch"] }),
      ],
      git,
      log,
    );
    expect(groups).toHaveLength(0);
    expect(skippedRepos).toBe(2);
    const text = log.mock.calls.map((c) => c[0]).join("\n");
    expect(text).toMatch(/billing is not codehub.example\/acme\/billing \(origin is dev\/dotfiles\) — skipped/);
    expect(text).toMatch(/scratch is not \/home\/dev\/src\/scratch \(top level \/home\/dev\) — skipped/);
    expect(calls.some((c) => c.args[0] === "show-ref" || c.args[0] === "merge-base")).toBe(false);

    // No origin at all: cannot prove it is the project, so skipped too.
    const noOrigin = scriptedGit((d, a) =>
      a[0] === "remote" ? { code: 2, stderr: "error: No such remote" } : typicalRepo(d, a),
    );
    expect((await groupReposByCommonDir([repo()], noOrigin.git, vi.fn())).groups).toHaveLength(0);
  });

  it("remote URL forms normalise to the same owner/repo: scp-ssh, ssh://, https, trailing .git and case", () => {
    for (const u of [
      "git@codehub.example:acme/billing.git",
      "ssh://git@codehub.example:2222/acme/billing",
      "https://codehub.example/Acme/Billing.git",
      "https://user:tok@codehub.example/acme/billing/",
      "codehub.example:acme/billing",
    ]) {
      expect(repoPathFromRemote(u), u).toBe("acme/billing");
    }
    expect(repoPathFromRemote("")).toBeNull();
  });
});

describe("resolveDefaultBranch", () => {
  it("prefers origin/HEAD, falls back to origin/main|master then local main|master, else null", async () => {
    const viaHead = scriptedGit((_d, a) =>
      a[0] === "symbolic-ref" ? { code: 0, stdout: "origin/trunk\n" } : { code: 1 },
    );
    expect(await resolveDefaultBranch(viaHead.git, "/r")).toEqual({ name: "trunk", ref: "refs/remotes/origin/trunk" });

    const localMaster = scriptedGit((_d, a) => ({ code: a[0] === "show-ref" && a[3] === "refs/heads/master" ? 0 : 1 }));
    expect(await resolveDefaultBranch(localMaster.git, "/r")).toEqual({ name: "master", ref: "refs/heads/master" });

    const none = scriptedGit(() => ({ code: 1 }));
    expect(await resolveDefaultBranch(none.git, "/r")).toBeNull();
  });
});

describe("checkRepoGroup", () => {
  const env = {} as NodeJS.ProcessEnv;

  it("B4 fixture: two overlapping sessions in one cwd — the commit's sha and the review's branch are checked by ref, never by time", async () => {
    const { git, calls } = scriptedGit(typicalRepo);
    const r = repo({
      shas: [{ sha: A1, branch: "feat-1", ref: "acme/billing#1", sessionId: "s-commit" }],
      branches: ["feat-1", "gone-branch"], // gone-branch: the review session's `glab mr checkout !2` branch, since deleted
      // The server has seen it before — but without a fetch this checkout cannot prove it is gone.
      known: [{ branch: "gone-branch", last_seen_sha: B2, branch_gone_at: null }],
    });
    const results = await checkRepoGroup(
      { commonDir: "/home/dev/src/billing/.git", dir: "/home/dev/src/billing", repos: [r] },
      git,
      env,
      vi.fn(),
    );
    const rows = byBranch(results);
    expect(rows["feat-1"]).toEqual<BranchCheckResult>({
      code_project_id: "p1",
      branch: "feat-1",
      default_branch: "main",
      last_seen_sha: A1,
      merged_into_default: true,
      sha_superseded_by: null,
      branch_gone: false,
    });
    expect(rows["gone-branch"]).toEqual<BranchCheckResult>({
      code_project_id: "p1",
      branch: "gone-branch",
      default_branch: "main",
      last_seen_sha: null,
      merged_into_default: null,
      sha_superseded_by: null,
      branch_gone: null,
    });
    // Every git argument names a ref/sha the server sent or a fixed flag — none is a time.
    for (const c of calls) {
      for (const a of c.args) expect(a).not.toMatch(/--since|--after|--until|--before|reflog|@\{/);
    }
    expect(calls.map((c) => c.args)).toContainEqual(["cat-file", "-e", `${A1}^{commit}`]);
    expect(calls.map((c) => c.args)).toContainEqual(["merge-base", "--is-ancestor", A1, "refs/remotes/origin/main"]);
    expect(calls.map((c) => c.args)).toContainEqual(["show-ref", "--verify", "--quiet", "refs/heads/gone-branch"]);
    expect(calls.map((c) => c.args)).toContainEqual([
      "show-ref",
      "--verify",
      "--quiet",
      "refs/remotes/origin/gone-branch",
    ]);
    // No network without MEMBRAL_SWEEP_FETCH=1.
    expect(calls.some((c) => c.args[0] === "fetch" || c.args[0] === "ls-remote")).toBe(false);
  });

  it("B6: checks the NEWEST sha per branch; a newest sha missing from this checkout is unknown — the branch head is never substituted", async () => {
    const { git, calls } = scriptedGit(typicalRepo);
    const r = repo({
      // Planner order: A1 then B2 on feat-1 (B2 newest). Both exist; B2 is not merged, A1 is.
      shas: [
        { sha: A1, branch: "feat-1", ref: null, sessionId: "s" },
        { sha: B2, branch: "feat-1", ref: null, sessionId: "s" },
      ],
    });
    const [row] = await checkRepoGroup(
      { commonDir: "/x/.git", dir: "/home/dev/src/billing", repos: [r] },
      git,
      env,
      vi.fn(),
    );
    expect(row.last_seen_sha).toBe(B2);
    expect(row.merged_into_default).toBe(false); // the newest sha decides, not A1's "yes"
    expect(calls.map((c) => c.args)).not.toContainEqual([
      "merge-base",
      "--is-ancestor",
      A1,
      "refs/remotes/origin/main",
    ]);

    // The planned sha is not here (cat-file fails) but the branch exists with another head:
    // rewritten, or simply made on another machine — this checkout cannot tell, so all null.
    const gone = "0000000000000000000000000000000000000000";
    const { git: git2 } = scriptedGit(typicalRepo);
    const [rw] = await checkRepoGroup(
      {
        commonDir: "/x/.git",
        dir: "/home/dev/src/billing",
        repos: [repo({ shas: [{ sha: gone, branch: "rewritten", ref: null, sessionId: "s" }] })],
      },
      git2,
      env,
      vi.fn(),
    );
    expect(rw.sha_superseded_by).toBeNull();
    expect(rw.last_seen_sha).toBeNull();
    expect(rw.merged_into_default).toBeNull();
    expect(rw.branch_gone).toBe(false); // the branch itself is present here
    expect(calls.length).toBeGreaterThan(0);
  });

  it("a branch never fetched in this checkout is not branch-gone evidence: neither ref exists and no row carries a sha -> null", async () => {
    const { git, calls } = scriptedGit(typicalRepo);
    const results = await checkRepoGroup(
      {
        commonDir: "/x/.git",
        dir: "/home/dev/src/billing",
        repos: [
          repo({
            branches: ["gone-branch", "other-clone-branch"],
            // A row with no sha (a previous sweep could not tell either) proves nothing.
            known: [{ branch: "gone-branch", last_seen_sha: null, branch_gone_at: "2026-09-20T00:00:00.000Z" }],
          }),
        ],
      },
      git,
      env,
      vi.fn(),
    );
    const rows = byBranch(results);
    expect(rows["gone-branch"].branch_gone).toBeNull();
    expect(rows["other-clone-branch"].branch_gone).toBeNull();
    // Both refs were still asked for; no network was used.
    expect(calls.map((c) => c.args)).toContainEqual([
      "show-ref",
      "--verify",
      "--quiet",
      "refs/heads/other-clone-branch",
    ]);
    expect(calls.map((c) => c.args)).toContainEqual([
      "show-ref",
      "--verify",
      "--quiet",
      "refs/remotes/origin/other-clone-branch",
    ]);
    expect(calls.some((c) => c.args[0] === "fetch" || c.args[0] === "ls-remote")).toBe(false);

    // An older server that sends no `known` at all: the same answer.
    const legacy = await checkRepoGroup(
      {
        commonDir: "/x/.git",
        dir: "/home/dev/src/billing",
        repos: [{ ...repo({ branches: ["gone-branch"] }), known: undefined }],
      },
      git,
      env,
      vi.fn(),
    );
    expect(legacy[0].branch_gone).toBeNull();
  });

  it("a sha tied to no branch (commit:<sha>) gets only the sha checks; unknown default branch reports merged=null", async () => {
    const { git, calls } = scriptedGit((d, a) =>
      a[0] === "symbolic-ref" || a[0] === "show-ref" ? { code: 1 } : typicalRepo(d, a),
    );
    const [row] = await checkRepoGroup(
      {
        commonDir: "/x/.git",
        dir: "/home/dev/src/billing",
        repos: [repo({ shas: [{ sha: A1, branch: `commit:${A1}`, ref: null, sessionId: "s" }] })],
      },
      git,
      env,
      vi.fn(),
    );
    expect(row).toEqual<BranchCheckResult>({
      code_project_id: "p1",
      branch: `commit:${A1}`,
      default_branch: null,
      last_seen_sha: A1,
      merged_into_default: null,
      sha_superseded_by: null,
      branch_gone: null,
    });
    expect(calls.some((c) => c.args[0] === "merge-base")).toBe(false);
  });

  it("branch gone only with MEMBRAL_SWEEP_FETCH=1: origin lacks refs/heads/<b> AND the server's row shows it existed", async () => {
    const { git, calls } = scriptedGit((d, a) => {
      if (a[0] === "fetch") return { code: 0 };
      if (a[0] === "ls-remote")
        return { code: 0, stdout: a[3] === "refs/heads/still-remote" ? `${B2}\trefs/heads/still-remote\n` : "" };
      return typicalRepo(d, a);
    });
    const results = await checkRepoGroup(
      {
        commonDir: "/x/.git",
        dir: "/home/dev/src/billing",
        repos: [
          repo({
            branches: ["still-remote", "gone-branch", "never-seen"],
            known: [{ branch: "gone-branch", last_seen_sha: B2, branch_gone_at: null }],
          }),
        ],
      },
      git,
      { MEMBRAL_SWEEP_FETCH: "1" } as NodeJS.ProcessEnv,
      vi.fn(),
    );
    const rows = byBranch(results);
    expect(rows["still-remote"].branch_gone).toBe(false);
    expect(rows["gone-branch"].branch_gone).toBe(true);
    expect(rows["never-seen"].branch_gone).toBeNull(); // absent on origin, but never known to exist
    // Before the fetch only remote-tracking refs are read; every ls-remote comes after it.
    const fetchAt = calls.findIndex((c) => c.args[0] === "fetch");
    expect(calls[fetchAt].args).toEqual(["fetch", "--quiet", "--prune", "origin"]);
    for (const c of calls.slice(0, fetchAt)) expect(c.args.slice(0, 3)).toEqual(["show-ref", "--verify", "--quiet"]);
    expect(calls.findIndex((c) => c.args[0] === "ls-remote")).toBeGreaterThan(fetchAt);
    expect(calls.map((c) => c.args)).toContainEqual(["ls-remote", "--heads", "origin", "refs/heads/gone-branch"]);
  });

  it("only show-ref exit 1 means absent: a fatal (128) or a timeout (-1) is unknown, never branch gone", async () => {
    for (const failure of [128, -1]) {
      const { git, calls } = scriptedGit((d, a) => {
        if (a[0] === "show-ref" && a[3].endsWith("/flaky")) return { code: failure };
        if (a[0] === "fetch" || a[0] === "ls-remote") return { code: 0, stdout: "" };
        return typicalRepo(d, a);
      });
      const [row] = await checkRepoGroup(
        {
          commonDir: "/x/.git",
          dir: "/home/dev/src/billing",
          repos: [repo({ branches: ["flaky"], known: [{ branch: "flaky", last_seen_sha: B2, branch_gone_at: null }] })],
        },
        git,
        { MEMBRAL_SWEEP_FETCH: "1" } as NodeJS.ProcessEnv,
        vi.fn(),
      );
      expect(row.branch_gone, `show-ref exit ${failure}`).toBeNull();
      expect(calls.some((c) => c.args[0] === "ls-remote")).toBe(false);
    }
  });
});

describe("runBranchStateCheck", () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.MEMBRAL_API_KEY = "lls_test";
    process.env.MEMBRAL_API_URL = "http://localhost:3000";
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  function fetchStub(repos: RepoRefsToCheck[], opts: { getStatus?: number; postStatus?: number } = {}) {
    const posts: unknown[] = [];
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      // The policy client sends a GET with no `method` key (R4 4.3 site 4).
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ checked_window_days: 30, repos }), { status: opts.getStatus ?? 200 });
      }
      posts.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ ok: true, upserted: 2, rejected: 0 }), { status: opts.postStatus ?? 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, posts };
  }

  it("the sweep never runs a git command that takes a time range: every execFile argv is asserted", async () => {
    const execFileImpl = vi.fn<ExecFileLike>((_file, args, _opts, cb) => {
      const gitArgs = (args as string[]).slice(2);
      const a = typicalRepo((args as string[])[1], gitArgs) ?? { code: 1 };
      cb(a.code ? Object.assign(new Error(`exit ${a.code}`), { code: a.code }) : null, a.stdout ?? "", a.stderr ?? "");
    });
    const { fetchImpl, posts } = fetchStub([
      repo({
        paths: ["/home/dev/src/billing", "/home/dev/src/billing-wt2"],
        shas: [{ sha: A1, branch: "feat-1", ref: "acme/billing#1", sessionId: "s" }],
        branches: ["feat-1", "gone-branch"],
        known: [{ branch: "gone-branch", last_seen_sha: B2, branch_gone_at: null }],
      }),
    ]);
    const log = vi.fn();
    const outcome = await runBranchStateCheck(
      { fetchImpl, execFileImpl, env: {} as NodeJS.ProcessEnv, now: () => new Date("2026-09-26T17:30:00Z") },
      log,
    );
    expect(outcome).toEqual({ ok: true, ran: true, checked: 2, repos: 1, skippedRepos: 0 });

    expect(execFileImpl.mock.calls.length).toBeGreaterThan(0);
    for (const [file, args] of execFileImpl.mock.calls) {
      expect(file).toBe("git");
      const argv = args as string[];
      expect(argv.slice(0, 2)).toEqual(["-C", expect.any(String)]);
      for (const a of argv) {
        expect(a, argv.join(" ")).not.toMatch(/^--(since|after|until|before|max-age|min-age|date)(=|$)/);
        expect(a, argv.join(" ")).not.toMatch(/reflog|@\{/);
      }
      expect(["rev-parse", "remote", "symbolic-ref", "show-ref", "cat-file", "merge-base"]).toContain(argv[2]);
    }
    // Every path is resolved (another clone may hold the sha), but the worktree shares its
    // common dir with the first path, so the ref checks ran once, in one checkout.
    expect(
      execFileImpl.mock.calls.filter(
        ([, a]) => (a as string[])[2] === "rev-parse" && (a as string[])[3] === "--git-common-dir",
      ),
    ).toHaveLength(2);
    const checkDirs = new Set(
      execFileImpl.mock.calls.filter(([, a]) => (a as string[])[2] === "cat-file").map(([, a]) => (a as string[])[1]),
    );
    expect([...checkDirs]).toEqual(["/home/dev/src/billing"]);

    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      checked_at: "2026-09-26T17:30:00.000Z",
      results: expect.arrayContaining([
        expect.objectContaining({ branch: "feat-1", last_seen_sha: A1, merged_into_default: true, branch_gone: false }),
        expect.objectContaining({ branch: "gone-branch", branch_gone: null }), // no fetch → never "gone"
      ]),
    });
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toMatch(
      /ref checks — 2 branch\(es\) in 1 repo\(s\) reported \(2 stored\)/,
    );
  });

  it("a repo path that is not a git checkout is skipped without failing the check; nothing is posted when nothing could be checked", async () => {
    const execFileImpl = vi.fn<ExecFileLike>((_file, _args, _opts, cb) =>
      cb(Object.assign(new Error("fatal: not a git repository"), { code: 128 }), "", "fatal: not a git repository"),
    );
    const { fetchImpl, posts } = fetchStub([repo({ paths: ["/tmp/not-a-repo"], branches: ["x"] })]);
    const log = vi.fn();
    const outcome = await runBranchStateCheck({ fetchImpl, execFileImpl, env: {} as NodeJS.ProcessEnv }, log);
    expect(outcome).toEqual({ ok: true, ran: true, checked: 0, repos: 0, skippedRepos: 1 });
    expect(posts).toHaveLength(0);
    expect(log.mock.calls.map((c) => c[0]).join("\n")).toMatch(/not a git checkout — skipped/);
  });

  it("without an API key nothing runs; a failed GET or POST is one logged line and ok:false, never a throw", async () => {
    delete process.env.MEMBRAL_API_KEY;
    const noKey = await runBranchStateCheck(
      { fetchImpl: vi.fn() as unknown as typeof fetch, execFileImpl: vi.fn<ExecFileLike>() },
      vi.fn(),
    );
    expect(noKey).toEqual({ ok: true, ran: false, checked: 0, repos: 0, skippedRepos: 0 });

    process.env.MEMBRAL_API_KEY = "lls_test";
    const log = vi.fn();
    const bad = fetchStub([], { getStatus: 503 });
    expect((await runBranchStateCheck({ fetchImpl: bad.fetchImpl, execFileImpl: vi.fn<ExecFileLike>() }, log)).ok).toBe(
      false,
    );
    expect(log.mock.calls[0][0]).toMatch(/refs-to-check request failed: server returned 503/);

    const execFileImpl = vi.fn<ExecFileLike>((_file, args, _opts, cb) => {
      const a = typicalRepo((args as string[])[1], (args as string[]).slice(2)) ?? { code: 1 };
      cb(a.code ? Object.assign(new Error("x"), { code: a.code }) : null, a.stdout ?? "", "");
    });
    const badPost = fetchStub([repo({ branches: ["feat-1"] })], { postStatus: 500 });
    const outcome = await runBranchStateCheck(
      { fetchImpl: badPost.fetchImpl, execFileImpl, env: {} as NodeJS.ProcessEnv },
      log,
    );
    expect(outcome).toEqual({ ok: false, ran: true, checked: 1, repos: 1, skippedRepos: 0 });
    expect(log.mock.calls.at(-1)?.[0]).toMatch(/branch-state upload failed: server returned 500/);

    const empty = fetchStub([]);
    expect(await runBranchStateCheck({ fetchImpl: empty.fetchImpl, execFileImpl: vi.fn<ExecFileLike>() }, log)).toEqual(
      {
        ok: true,
        ran: true,
        checked: 0,
        repos: 0,
        skippedRepos: 0,
      },
    );
  });
});

// Two machines, same absolute paths, one origin: the desktop pushed `feat`,
// committed Z on `feat2` and Y on `main` without pushing; the laptop cloned
// earlier and never fetched. The laptop's sweep must report only what the
// laptop's own checkout proves — never the desktop's work as merged or gone.
// 30s: real git spawns under the full-parallel gate can outrun vitest's 5s
// default (#310 — 5014ms under the gate, 5010ms in one standalone run).
describe("two clones, laptop never fetched (real git)", () => {
  let root: string;
  const g = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Dev",
        "-c",
        "user.email=dev@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "init.defaultBranch=main",
        ...args,
      ],
      { cwd, env: gitChildEnv(process.env), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), file);
    g(cwd, "add", file);
    g(cwd, "commit", "-q", "-m", file);
    return g(cwd, "rev-parse", "HEAD");
  };
  let X: string;
  let Y: string;
  let Z: string;
  let laptop: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "membral-two-clones-"));
    const origin = join(root, "origin.git");
    g(root, "init", "-q", "--bare", origin);
    const seed = join(root, "seed");
    g(root, "clone", "-q", origin, seed);
    commit(seed, "m1");
    g(seed, "push", "-q", "origin", "main");
    const desktop = join(root, "desktop");
    laptop = join(root, "laptop");
    g(root, "clone", "-q", origin, desktop);
    g(root, "clone", "-q", origin, laptop);
    // Laptop has its own feat2 at M1 (same name, different history).
    g(laptop, "branch", "feat2");
    // Desktop: feat pushed, feat2 and main unpushed.
    g(desktop, "checkout", "-q", "-b", "feat");
    X = commit(desktop, "x");
    g(desktop, "push", "-q", "origin", "feat");
    g(desktop, "checkout", "-q", "-b", "feat2", "main");
    Z = commit(desktop, "z");
    g(desktop, "checkout", "-q", "main");
    Y = commit(desktop, "y");
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  const plan = () =>
    ({
      codeProjectId: "p1",
      repoIdentity: "codehub.example/acme/billing",
      paths: [laptop],
      shas: [
        { sha: X, branch: "feat", ref: null, sessionId: "s1" },
        { sha: Z, branch: "feat2", ref: null, sessionId: "s2" },
        { sha: Y, branch: "main", ref: null, sessionId: "s3" },
      ],
      branches: ["feat", "feat2"],
      openRefs: [],
      // What the desktop's earlier sweep stored for feat.
      known: [{ branch: "feat", last_seen_sha: X, branch_gone_at: null }],
    }) satisfies RepoRefsToCheck;

  it("a sha missing from this checkout is unknown (null), never the local head; an unfetched branch is never gone", async () => {
    const git = createGitRunner();
    const rows = byBranch(
      await checkRepoGroup({ commonDir: join(laptop, ".git"), dir: laptop, repos: [plan()] }, git, {}, vi.fn()),
    );
    for (const key of ["feat", "feat2", "main"]) {
      expect(rows[key].last_seen_sha, key).toBeNull();
      expect(rows[key].merged_into_default, key).toBeNull();
      expect(rows[key].sha_superseded_by, key).toBeNull();
    }
    expect(rows.feat.branch_gone).toBeNull(); // alive on origin, just never fetched here
    expect(rows.feat2.branch_gone).toBe(false); // the laptop's own feat2 exists
  });

  it("a branch key with no sha named never reports merged: a same-named branch freshly cut from main on the laptop is null, not merged", async () => {
    g(laptop, "branch", "fresh", "main"); // points at main's tip: an ancestor of main, trivially
    const git = createGitRunner();
    const [row] = await checkRepoGroup(
      {
        commonDir: join(laptop, ".git"),
        dir: laptop,
        repos: [{ ...plan(), shas: [], branches: ["fresh"], known: [] }],
      },
      git,
      {},
      vi.fn(),
    );
    expect(row.branch).toBe("fresh");
    expect(row.merged_into_default).toBeNull();
    expect(row.last_seen_sha).toBeNull();
    expect(row.branch_gone).toBe(false); // presence is still reported
  });

  it("with MEMBRAL_SWEEP_FETCH=1 the laptop learns feat is alive on origin and sees X — still never gone", async () => {
    const lap2 = join(root, "laptop2");
    g(root, "clone", "-q", join(root, "origin.git"), lap2);
    const git = createGitRunner();
    const rows = byBranch(
      await checkRepoGroup(
        { commonDir: join(lap2, ".git"), dir: lap2, repos: [{ ...plan(), paths: [lap2] }] },
        git,
        { MEMBRAL_SWEEP_FETCH: "1" },
        vi.fn(),
      ),
    );
    expect(rows.feat.branch_gone).toBe(false);
    expect(rows.feat.last_seen_sha).toBe(X);
    expect(rows.feat.merged_into_default).toBe(false);
    expect(rows.main.last_seen_sha).toBeNull(); // Y was never pushed
  });
}, 30_000);

// Real git, one bare origin and several clones of the same project (the e2e
// laptop / laptop3 layout). Each clone reports only what it proves; the rows
// are merged so proof in any clone counts (B3), and a branch deleted on
// origin is "gone" once the fetch shows it (B6).
// 30s: real git spawns under the full-parallel gate can outrun vitest's 5s
// default (#310 — 5014ms under the gate, 5010ms in one standalone run).
describe("several clones of one project, one origin (real git)", () => {
  let root: string;
  const g = (cwd: string, ...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Dev",
        "-c",
        "user.email=dev@example.test",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "init.defaultBranch=main",
        ...args,
      ],
      { cwd, env: gitChildEnv(process.env), encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), file);
    g(cwd, "add", file);
    g(cwd, "commit", "-q", "-m", file);
    return g(cwd, "rev-parse", "HEAD");
  };
  // The clones' origin is a local path; answer `remote get-url` as the forge URL the project is keyed by.
  const real = createGitRunner();
  const git: GitRunner = (dir, args) =>
    args[0] === "remote"
      ? Promise.resolve({ code: 0, stdout: "git@codehub.example:acme/billing.git\n", stderr: "" })
      : real(dir, args);
  const sweep = async (plan: RepoRefsToCheck, env: NodeJS.ProcessEnv = {}) => {
    const { groups } = await groupReposByCommonDir([plan], git, vi.fn());
    const rows: BranchCheckResult[] = [];
    for (const group of groups) rows.push(...(await checkRepoGroup(group, git, env, vi.fn())));
    return { groups, rows: byBranch(mergeCloneResults(rows)), perClone: rows };
  };
  let origin: string;
  let laptop: string;
  let laptop3: string;
  let forge: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "membral-clones-"));
    origin = join(root, "origin.git");
    g(root, "init", "-q", "--bare", origin);
    forge = join(root, "forge");
    g(root, "clone", "-q", origin, forge);
    commit(forge, "m1");
    g(forge, "push", "-q", "origin", "main");
    laptop = join(root, "laptop");
    laptop3 = join(root, "laptop3");
    g(root, "clone", "-q", origin, laptop);
    g(root, "clone", "-q", origin, laptop3);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("a merge only the second clone has pulled is proven; the first clone, lacking the sha, adds nothing", async () => {
    g(laptop3, "checkout", "-q", "-b", "e2e/ic-sanity-check");
    const S = commit(laptop3, "sanity");
    g(laptop3, "push", "-q", "origin", "e2e/ic-sanity-check");
    // Merged on the forge (a merge commit), then `git pull` in laptop3 only.
    g(forge, "fetch", "-q", "origin");
    g(forge, "merge", "-q", "--no-ff", "-m", "merge", "origin/e2e/ic-sanity-check");
    g(forge, "push", "-q", "origin", "main");
    g(laptop3, "checkout", "-q", "main");
    g(laptop3, "pull", "-q", "origin", "main");

    const { groups, rows, perClone } = await sweep({
      codeProjectId: "p1",
      repoIdentity: "codehub.example/acme/billing",
      paths: [laptop, laptop3],
      shas: [{ sha: S, branch: "e2e/ic-sanity-check", ref: "acme/billing!17", sessionId: "s1" }],
      branches: ["e2e/ic-sanity-check"],
      openRefs: [],
    });
    expect(groups.map((gr) => gr.dir)).toEqual([laptop, laptop3]);
    // laptop never fetched: its own row is unknown, not "not merged".
    expect(perClone[0]).toMatchObject({ last_seen_sha: null, merged_into_default: null });
    expect(rows["e2e/ic-sanity-check"]).toMatchObject({ last_seen_sha: S, merged_into_default: true });
  });

  it("with MEMBRAL_SWEEP_FETCH=1 a squash-merged branch deleted on origin is gone, whether or not a local branch is left", async () => {
    // Clone A keeps its local branch (merged in the forge UI); clone B deleted it (`gh pr merge --delete-branch`).
    g(laptop, "fetch", "-q", "origin");
    g(laptop, "checkout", "-q", "-b", "e2e/s14-credits", "origin/main");
    const T = commit(laptop, "credits");
    g(laptop, "push", "-q", "origin", "e2e/s14-credits");
    g(laptop3, "fetch", "-q", "origin");
    g(laptop3, "checkout", "-q", "-b", "e2e/ib-ffmpeg-hint", "origin/main");
    const U = commit(laptop3, "ffmpeg");
    g(laptop3, "push", "-q", "origin", "e2e/ib-ffmpeg-hint");
    // A never-pushed local branch: absent on origin, but not gone.
    g(laptop3, "branch", "local-only");
    for (const b of ["e2e/s14-credits", "e2e/ib-ffmpeg-hint"]) {
      g(forge, "fetch", "-q", "origin");
      g(forge, "merge", "-q", "--squash", `origin/${b}`);
      g(forge, "commit", "-q", "-m", `squash ${b}`);
      g(forge, "push", "-q", "origin", "main", `:${b}`);
    }
    g(laptop3, "checkout", "-q", "main");
    g(laptop3, "branch", "-q", "-D", "e2e/ib-ffmpeg-hint");
    g(laptop3, "fetch", "-q", "--prune", "origin");

    const plan: RepoRefsToCheck = {
      codeProjectId: "p1",
      repoIdentity: "codehub.example/acme/billing",
      paths: [laptop, laptop3],
      shas: [
        { sha: T, branch: "e2e/s14-credits", ref: "acme/billing!15", sessionId: "s2" },
        { sha: U, branch: "e2e/ib-ffmpeg-hint", ref: "acme/billing!13", sessionId: "s3" },
      ],
      branches: ["e2e/s14-credits", "e2e/ib-ffmpeg-hint", "local-only"],
      openRefs: [],
      known: [],
    };
    const noFetch = await sweep(plan);
    expect(noFetch.rows["e2e/s14-credits"].branch_gone).toBe(false); // without fetch, never gone
    expect(noFetch.rows["e2e/ib-ffmpeg-hint"].branch_gone).toBeNull();

    const { rows } = await sweep(plan, { MEMBRAL_SWEEP_FETCH: "1" });
    expect(rows["e2e/s14-credits"]).toMatchObject({ branch_gone: true, last_seen_sha: T, merged_into_default: false });
    expect(rows["e2e/ib-ffmpeg-hint"]).toMatchObject({ branch_gone: true, last_seen_sha: U });
    expect(rows["local-only"].branch_gone).toBe(false);
  });
}, 30_000);
