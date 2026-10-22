// R5 5.12 (#201): branch coverage for the forge-actions helper modules that PR #199 listed as
// uncovered after the 2.6 split — shell tokenising, ranking, refs, repo env/url helpers, the
// per-segment directory tracker, digest privacy and the git verb table. Every case asserts the
// parsed value (verb / ref / refKind / dir / digest text), never mere execution. Fictional host
// `codehub.example`, project `acme/billing`.
import { describe, expect, it } from "vitest";
import { digestBashCommand, scrubFreeText, TEXT_PLACEHOLDER } from "../forge-actions/digest.js";
import { gitAction } from "../forge-actions/git.js";
import { primaryAction } from "../forge-actions/ranking.js";
import { hostFromRepoFlag, parseForgeUrl, projectFromRepoFlag, urlHost, withKnownHost } from "../forge-actions/refs.js";
import { ownResultUrls, substituteVars } from "../forge-actions/repo.js";
import {
  type DirState,
  foldAssignments,
  moveDir,
  normalizeAbsolute,
  resolveTarget,
  settleRepo,
  silentSegment,
  trackForgeEnv,
} from "../forge-actions/segment-repo.js";
import { chainSegments, shellWordSpans, shellWords, splitShellChain } from "../forge-actions/shell.js";
import type { ForgeAction, ForgeVerb } from "../forge-actions/types.js";

describe("shell tokenising edge cases", () => {
  it("an unterminated heredoc swallows the rest of the command", () => {
    expect(splitShellChain("cat <<EOF\nbody line\nmore body")).toEqual(["cat <<EOF"]);
  });

  it("a heredoc with a later terminator drops the body and keeps the chain after it", () => {
    expect(splitShellChain("cat <<EOF\nbody\nEOF\ngit push")).toEqual(["cat <<EOF", "git push"]);
  });

  it.each([
    ["single-quoted", "cat <<'END'\ngit push\nEND\ngit status", ["cat <<'END'", "git status"]],
    ["double-quoted", 'cat <<"END"\ngit push\nEND\ngit status', ['cat <<"END"', "git status"]],
    ["bare", "cat <<END\ngit push\nEND\ngit status", ["cat <<END", "git status"]],
    ["backslash-escaped", "cat <<\\END\ngit push\nEND\ngit status", ["cat <<\\END", "git status"]],
    ["dash form", "cat <<-END\n\tgit push\n\tEND\ngit status", ["cat <<-END", "git status"]],
  ])("a %s heredoc terminator hides the body from the chain", (_label, command, expected) => {
    expect(splitShellChain(command)).toEqual(expected);
  });

  it("a backtick opened inside a double-quoted string nests and closes without splitting the chain", () => {
    const cmd = 'echo "a `date; true` b" && git push';
    expect(splitShellChain(cmd)).toEqual(['echo "a `date; true` b"', "git push"]);
    expect(shellWords('echo "a `date; true` b"')).toEqual(["echo", "a `date; true` b"]);
  });

  it("reports an operator pair for each segment boundary", () => {
    const segs = chainSegments("a && b || c | d ; e");
    expect(segs.map((s) => [s.text, s.before, s.after])).toEqual([
      ["a", null, "&&"],
      ["b", "&&", "||"],
      ["c", "||", "|"],
      ["d", "|", ";"],
      ["e", ";", null],
    ]);
  });

  it("marks a word that starts with a quote and drops redirections with their target word", () => {
    expect(shellWordSpans('gh pr view "17"').map((w) => [w.text, w.quoted])).toEqual([
      ["gh", false],
      ["pr", false],
      ["view", false],
      ["17", true],
    ]);
    expect(shellWords("git push origin main 2>&1 > out.txt")).toEqual(["git", "push", "origin", "main"]);
  });
});

describe("primaryAction", () => {
  const act = (verb: ForgeVerb): ForgeAction => ({ verb, source: "cli" });

  it("returns undefined for no actions", () => {
    expect(primaryAction([])).toBeUndefined();
  });

  it("picks the strongest verb: closure beats delivery beats review", () => {
    expect(primaryAction([act("viewed"), act("pushed"), act("merged"), act("commented")])?.verb).toBe("merged");
    expect(primaryAction([act("commented"), act("committed")])?.verb).toBe("committed");
  });

  it("falls back to the first action when no verb is in the rank table", () => {
    const unknown = { verb: "not_a_verb", source: "cli" } as unknown as ForgeAction;
    expect(primaryAction([unknown, { verb: "also_unknown", source: "cli" } as unknown as ForgeAction])).toBe(unknown);
  });
});

describe("parseForgeUrl", () => {
  it.each([
    ["an unparseable string", "not a url"],
    ["a non-http protocol", "ftp://codehub.example/acme/billing/issues/4"],
    ["a path with no item segment", "https://codehub.example/acme/billing"],
    ["a non-numeric item id", "https://codehub.example/acme/billing/issues/new"],
    ["a non-hex commit id", "https://codehub.example/acme/billing/commit/zzzzzzz"],
    ["a too-short commit id", "https://codehub.example/acme/billing/commit/abc12"],
  ])("rejects %s", (_label, raw) => {
    expect(parseForgeUrl(raw)).toBeNull();
  });

  it("parses a commit URL: lower-cased sha, project, query dropped", () => {
    expect(parseForgeUrl("https://codehub.example/acme/billing/commit/ABCDEF1234?w=1")).toEqual({
      refKind: "commit",
      sha: "abcdef1234",
      url: "https://codehub.example/acme/billing/commit/ABCDEF1234",
      project: "acme/billing",
    });
  });

  it("a commit URL with no owner path has no project", () => {
    const parsed = parseForgeUrl("https://codehub.example/commit/abcdef1");
    expect(parsed?.project).toBeUndefined();
    expect(parsed?.sha).toBe("abcdef1");
  });

  it("an item URL with no owner path gives a bare ref", () => {
    expect(parseForgeUrl("https://codehub.example/issues/9")).toEqual({
      ref: "#9",
      refKind: "issue",
      url: "https://codehub.example/issues/9",
      project: undefined,
    });
  });

  it("a glab-style /-/ path is dropped from the project and trailing punctuation is trimmed", () => {
    expect(parseForgeUrl("http://codehub.example/acme/billing/-/merge_requests/17).")).toMatchObject({
      ref: "acme/billing!17",
      refKind: "merge_request",
      project: "acme/billing",
    });
  });
});

describe("repo flag and host helpers", () => {
  it.each([
    [undefined, undefined],
    ["", undefined],
    ["$REPO", undefined],
    ["https://CodeHub.Example/acme/billing", "codehub.example"],
    ["codehub.example/acme/billing", "codehub.example"],
    ["acme/billing", undefined],
    ["acme.io/billing", undefined],
  ])("hostFromRepoFlag(%j) -> %j", (value, host) => {
    expect(hostFromRepoFlag(value)).toBe(host);
  });

  it.each([
    [undefined, undefined],
    ["~/repo", undefined],
    ["acme", undefined],
    ["acme/billing", "acme/billing"],
    ["codehub.example/acme/billing", "acme/billing"],
    ["https://codehub.example/acme/billing.git", "acme/billing"],
    ["codehub.example/acme/group/billing", "acme/group/billing"],
  ])("projectFromRepoFlag(%j) -> %j", (value, project) => {
    expect(projectFromRepoFlag(value)).toBe(project);
  });

  it("urlHost lower-cases a host and is undefined for missing or unparseable input", () => {
    expect(urlHost(undefined)).toBeUndefined();
    expect(urlHost("nope")).toBeUndefined();
    expect(urlHost("https://CodeHub.Example:8443/x")).toBe("codehub.example:8443");
  });
});

describe("withKnownHost", () => {
  it("leaves a ref whose owner segment already looks like a host", () => {
    const p = {
      verb: "viewed" as const,
      refKind: "issue" as const,
      ref: "codehub.example/acme/billing#5",
      toolHost: "github.com",
    };
    withKnownHost(p, undefined);
    expect(p.ref).toBe("codehub.example/acme/billing#5");
  });

  it("ignores a bare ref, a commit and a ref with no repo part", () => {
    for (const ref of ["#5", "billing#5"]) {
      const p = { verb: "viewed" as const, refKind: "issue" as const, ref, toolHost: "github.com" };
      withKnownHost(p, undefined);
      expect(p.ref).toBe(ref);
    }
    const c = { verb: "committed" as const, refKind: "commit" as const, ref: "acme/billing#5", toolHost: "github.com" };
    withKnownHost(c, undefined);
    expect(c.ref).toBe("acme/billing#5");
  });

  it("prefers the host of the action's own URL when it names the same item", () => {
    const p = {
      verb: "viewed" as const,
      refKind: "issue" as const,
      ref: "acme/billing#5",
      url: "https://codehub.example/acme/billing/issues/5",
      toolHost: "github.com",
    };
    withKnownHost(p, undefined);
    expect(p.ref).toBe("codehub.example/acme/billing#5");
  });

  it("a URL naming a different item is no evidence; the result line and then the tool host decide", () => {
    const base = {
      verb: "closed" as const,
      refKind: "issue" as const,
      ref: "acme/billing#5",
      url: "https://elsewhere.example/acme/billing/issues/6",
    };
    const fromResult = { ...base, toolHost: "github.com" };
    withKnownHost(fromResult, "https://codehub.example/acme/billing/issues/5\n");
    expect(fromResult.ref).toBe("codehub.example/acme/billing#5");

    const fromTool = { ...base, toolHost: "github.com" };
    withKnownHost(fromTool, "no urls here");
    expect(fromTool.ref).toBe("github.com/acme/billing#5");

    const noEvidence = { ...base };
    withKnownHost(noEvidence, undefined);
    expect(noEvidence.ref).toBe("acme/billing#5");
  });

  it("two different hosts in the result, or other segments' output, give no host", () => {
    const two = { verb: "closed" as const, refKind: "issue" as const, ref: "acme/billing#5" };
    withKnownHost(two, "https://a.example/acme/billing/issues/5\nhttps://b.example/acme/billing/issues/5\n");
    expect(two.ref).toBe("acme/billing#5");
    const other = { verb: "closed" as const, refKind: "issue" as const, ref: "acme/billing#5", otherOutput: true };
    withKnownHost(other, "https://a.example/acme/billing/issues/5\n");
    expect(other.ref).toBe("acme/billing#5");
  });

  it("a merge request URL for the same number but another kind does not count", () => {
    const p = { verb: "closed" as const, refKind: "issue" as const, ref: "acme/billing#5" };
    withKnownHost(p, "https://codehub.example/acme/billing/-/merge_requests/5\n");
    expect(p.ref).toBe("acme/billing#5");
  });
});

describe("substituteVars and ownResultUrls", () => {
  it("substitutes bare and braced variable names, keeps unknown names, and passes words through with no vars", () => {
    const vars = new Map([["R", "acme/billing"]]);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal shell `${NAME}` word, not a template
    expect(substituteVars(["-R", "$R", "${R}/x", "$MISSING", "plain"], vars)).toEqual([
      "-R",
      "acme/billing",
      "acme/billing/x",
      "$MISSING",
      "plain",
    ]);
    const words = ["$R"];
    expect(substituteVars(words, undefined)).toBe(words);
    expect(substituteVars(words, new Map())).toBe(words);
  });

  it("reads the top-level url of a JSON object result, and nothing from arrays, bad JSON or a non-string url", () => {
    expect(ownResultUrls('{"url":"https://codehub.example/acme/billing/issues/5","body":"x"}', false)).toEqual([
      "https://codehub.example/acme/billing/issues/5",
    ]);
    expect(ownResultUrls('[{"url":"https://codehub.example/acme/billing/issues/5"}]', false)).toEqual([]);
    expect(ownResultUrls("{not json", false)).toEqual([]);
    expect(ownResultUrls('{"url":42}', false)).toEqual([]);
  });

  it("reads url: fields and View-this lines, stops at the -- separator, and takes a bare URL line only off a view", () => {
    const text = [
      "title: x",
      "url: https://codehub.example/acme/billing/issues/5",
      "View this issue on CodeHub: https://codehub.example/acme/billing/issues/5",
      "https://codehub.example/acme/billing/issues/5",
      "--",
      "url: https://other.example/acme/billing/issues/5",
    ].join("\n");
    expect(ownResultUrls(text, false)).toEqual([
      "https://codehub.example/acme/billing/issues/5",
      "https://codehub.example/acme/billing/issues/5",
      "https://codehub.example/acme/billing/issues/5",
    ]);
    expect(ownResultUrls(text, true)).toHaveLength(2);
  });
});

describe("directory tracking", () => {
  const state = (dir?: string, lost = false): DirState => ({ dir, lost, stack: [] });

  it.each([
    ["relative", "a/b", null],
    ["climbing above root", "/a/../..", null],
    ["leading ..", "/..", null],
    ["dots and duplicate slashes", "/a//b/./c/../d", "/a/b/d"],
    ["root", "/", "/"],
  ])("normalizeAbsolute: %s", (_label, input, expected) => {
    expect(normalizeAbsolute(input)).toBe(expected);
  });

  it("resolveTarget follows absolute and relative targets and gives up on the unreadable ones", () => {
    expect(resolveTarget("/srv/../opt", state())).toEqual({ dir: "/opt" });
    expect(resolveTarget("/../x", state())).toBeNull();
    expect(resolveTarget("sub", state("/work"))).toEqual({ dir: "/work/sub" });
    expect(resolveTarget("../../..", state("/work"))).toBeNull();
    expect(resolveTarget("sub", state("/work", true))).toBeNull();
    expect(resolveTarget("sub", state())).toBeNull();
    expect(resolveTarget(undefined, state("/work"))).toBeNull();
    expect(resolveTarget("-", state("/work"))).toBeNull();
    expect(resolveTarget("$HOME/x", state("/work"))).toBeNull();
  });

  it("cd to the repo toplevel keeps the directory, unless the directory was already lost", () => {
    expect(resolveTarget("$(git rev-parse --show-toplevel)", state("/work"))).toEqual({ dir: "/work" });
    expect(resolveTarget("`git rev-parse --show-toplevel`", state("/work"))).toEqual({ dir: "/work" });
    expect(resolveTarget("$(git rev-parse --show-toplevel)", state("/work", true))).toBeNull();
  });

  it("moveDir handles pushd/popd, an empty popd and an unresolvable cd", () => {
    const s = state("/work");
    moveDir(s, "pushd", ["/opt"]);
    expect(s).toMatchObject({ dir: "/opt", lost: false });
    moveDir(s, "popd", []);
    expect(s).toMatchObject({ dir: "/work", lost: false });
    moveDir(s, "popd", []);
    expect(s.lost).toBe(true);
    moveDir(s, "cd", ["/again"]);
    expect(s).toMatchObject({ dir: "/again", lost: false });
    moveDir(s, "cd", ["$X"]);
    expect(s.lost).toBe(true);
  });

  it("silentSegment: cd, export, unset, true, bare assignments and empty segments print nothing", () => {
    for (const seg of ["", "cd /x", "builtin cd /x", "export A=1", "unset A", "true", "A=1 B=2"])
      expect(silentSegment(seg), seg).toBe(true);
    expect(silentSegment("git status")).toBe(false);
  });
});

describe("shell variable and forge env tracking", () => {
  it("foldAssignments keeps a literal, blocks an expansion or a reassignment, ignores non-assignments", () => {
    const vars = new Map<string, string>();
    const blocked = new Set<string>();
    foldAssignments(["export", "R=acme/billing", "N=5"], vars, blocked);
    expect(Object.fromEntries(vars)).toEqual({ R: "acme/billing", N: "5" });
    foldAssignments(["R=other/x"], vars, blocked);
    expect(vars.has("R")).toBe(false);
    expect(blocked.has("R")).toBe(true);
    foldAssignments(["X=$(date)", "E="], vars, blocked);
    expect(blocked.has("X") && blocked.has("E")).toBe(true);
    foldAssignments(["echo", "Z=1"], vars, blocked);
    foldAssignments([], vars, blocked);
    expect(vars.has("Z")).toBe(false);
    expect([...vars.keys()]).toEqual(["N"]);
  });

  it("trackForgeEnv: export of a literal is readable; plain assignment, expansion or bare export are not new", () => {
    const env = new Map<string, string | null>();
    trackForgeEnv(["export", "GH_REPO=acme/billing"], env);
    expect(env.get("GH_REPO")).toBe("acme/billing");
    trackForgeEnv(["GH_HOST=codehub.example"], env);
    expect(env.get("GH_HOST")).toBeNull();
    trackForgeEnv(["export", "GH_REPO"], env);
    expect(env.get("GH_REPO")).toBe("acme/billing");
    trackForgeEnv(["export", "GITLAB_HOST=$H"], env);
    expect(env.get("GITLAB_HOST")).toBeNull();
    trackForgeEnv(["export", "OTHER=1"], env);
    expect(env.has("OTHER")).toBe(false);
    trackForgeEnv(["echo", "GH_HOST=x"], env);
    trackForgeEnv([], env);
    trackForgeEnv(["export", "GH_REPO=again"], env);
    expect(env.get("GH_REPO")).toBeNull();
    trackForgeEnv(["unset", "GH_REPO", "GH_HOST"], env);
    expect(env.has("GH_REPO") || env.has("GH_HOST")).toBe(false);
  });
});

describe("settleRepo", () => {
  const OWN = "https://codehub.example/acme/billing/-/issues/5\n";

  it("an already-qualified item ref is settled and loses its dir", () => {
    const p = { verb: "closed" as const, refKind: "issue" as const, ref: "acme/billing#5", dir: "/work" };
    settleRepo(p, undefined);
    expect(p.dir).toBeUndefined();
    expect(p).not.toHaveProperty("repoUnknown");
  });

  it("keeps the dir and records the result URL's repo as the fallback shownRepo", () => {
    const p = { verb: "closed" as const, refKind: "issue" as const, ref: "#5", dir: "/work" };
    settleRepo(p, OWN);
    expect(p).toMatchObject({ dir: "/work", shownRepo: "codehub.example/acme/billing" });
  });

  it("an unreadable -R with a matching result URL qualifies the ref; without one the repo is unknown", () => {
    const withUrl = { verb: "closed" as const, refKind: "issue" as const, ref: "#5", repoUnread: true, dir: "/w" };
    settleRepo(withUrl, OWN);
    expect(withUrl).toMatchObject({ ref: "acme/billing#5", url: "https://codehub.example/acme/billing/-/issues/5" });
    expect(withUrl.dir).toBeUndefined();

    const lost = { verb: "closed" as const, refKind: "issue" as const, ref: "#5", dirLost: true };
    settleRepo(lost, undefined);
    expect(lost).toMatchObject({ repoUnknown: true });

    const other = { verb: "closed" as const, refKind: "issue" as const, ref: "#5", dirLost: true, otherOutput: true };
    settleRepo(other, OWN);
    expect(other).toMatchObject({ repoUnknown: true });
    expect(other.ref).toBe("#5");
  });

  it("a result naming two repos for the item is no evidence", () => {
    const p = { verb: "closed" as const, refKind: "issue" as const, ref: "#5", dirLost: true };
    settleRepo(p, `${OWN}https://codehub.example/other/proj/-/issues/5\n`);
    expect(p).toMatchObject({ repoUnknown: true });
  });
});

describe("digest privacy", () => {
  it("scrubs the commit message with git -C / -c prefixes before the subcommand", () => {
    expect(scrubFreeText('git -C /srv/app commit -m "secret plan"')).toBe(
      `git -C /srv/app commit -m ${TEXT_PLACEHOLDER}`,
    );
    expect(scrubFreeText('git -c user.name=x commit -m "secret plan"')).toBe(
      `git -c user.name=x commit -m ${TEXT_PLACEHOLDER}`,
    );
  });

  it("skips bare flags before the subcommand and scrubs the heredoc body of a trailing heredoc", () => {
    expect(scrubFreeText('git --no-pager commit -m "secret"')).toBe(`git --no-pager commit -m ${TEXT_PLACEHOLDER}`);
    expect(scrubFreeText("git commit -m x <<EOF\nbody\nEOF")).toBe(
      `git commit -m ${TEXT_PLACEHOLDER} <<EOF\n${TEXT_PLACEHOLDER}\nEOF`,
    );
  });

  it("scrubs a glued -mTEXT message and a combined -am flag", () => {
    expect(scrubFreeText("git commit -msecret")).toBe(`git commit -m${TEXT_PLACEHOLDER}`);
    expect(scrubFreeText('git commit -am "secret"')).toBe(`git commit -am ${TEXT_PLACEHOLDER}`);
  });

  it("scrubs a heredoc commit message but keeps the chain after it", () => {
    const cmd = "git commit -m \"$(cat <<'EOF'\nprivate body\nEOF\n)\" && git push";
    const out = scrubFreeText(cmd);
    expect(out).not.toContain("private body");
    expect(out).toContain("git push");
  });

  it("scrubs gh api prose fields and --flag=value forms but keeps the key", () => {
    expect(scrubFreeText('gh api repos/acme/billing/issues -f title="private" -f labels=bug')).toBe(
      `gh api repos/acme/billing/issues -f title=${TEXT_PLACEHOLDER} -f labels=bug`,
    );
    // A fully quoted `key=value` word keeps its quote balanced around the placeholder.
    expect(scrubFreeText('gh api repos/acme/billing/issues -f "note=looks wrong"')).toBe(
      `gh api repos/acme/billing/issues -f "note=${TEXT_PLACEHOLDER}"`,
    );
    expect(scrubFreeText("gh pr create --title=private --base main")).toBe(
      `gh pr create --title=${TEXT_PLACEHOLDER} --base main`,
    );
  });

  it("digestBashCommand rejects non-allowlisted and non-string input, keeps tests short and forge long", () => {
    expect(digestBashCommand(undefined)).toBeUndefined();
    expect(digestBashCommand("   ")).toBeUndefined();
    expect(digestBashCommand("ls -la")).toBeUndefined();
    expect(digestBashCommand(`npx vitest run ${"x".repeat(500)}`)?.length).toBe(400);
    expect(digestBashCommand(`git log ${"x".repeat(1500)}`)?.length).toBe(1200);
  });
});

describe("gitAction verb table", () => {
  it.each([
    ["cherry-pick --abort", ["cherry-pick", "--abort"], "navigated"],
    ["revert --continue", ["revert", "--continue"], "navigated"],
    ["cherry-pick abc1234", ["cherry-pick", "abc1234"], "committed"],
    ["merge --abort", ["merge", "--abort"], "navigated"],
    ["merge feature", ["merge", "feature"], "committed"],
    ["rebase --abort", ["rebase", "--abort"], "navigated"],
    ["filter-repo --quit", ["filter-repo", "--quit"], "navigated"],
    ["rebase main", ["rebase", "main"], "rewrote"],
    ["reset --hard", ["reset", "--hard"], "rewrote"],
    ["reset HEAD~1", ["reset", "HEAD~1"], "rewrote"],
    ["reset file", ["reset", "file.txt"], "navigated"],
    ["status", ["status"], "navigated"],
  ] as const)("%s -> %s", (_label, args, verb) => {
    expect(gitAction([...args])?.verb).toBe(verb);
  });

  it("returns null for no subcommand, skipping -C / -c / other flags before it", () => {
    expect(gitAction([])).toBeNull();
    expect(gitAction(["--no-pager"])).toBeNull();
    expect(gitAction(["-C", "/x", "-c", "k=v", "--no-pager", "commit", "--amend"])).toEqual({
      verb: "rewrote",
      refKind: "commit",
    });
  });

  it("push: plain, refspec, forced, delete and colon-delete forms", () => {
    expect(gitAction(["push", "origin", "feat"])).toEqual({
      verb: "pushed",
      refKind: "branch",
      ref: "feat",
      branch: "feat",
      fromPush: true,
    });
    expect(gitAction(["push", "origin", "HEAD:refs/heads/feat"])).toMatchObject({ verb: "pushed", branch: "feat" });
    expect(gitAction(["push", "origin", "src:dst"])).toMatchObject({ verb: "pushed", branch: "dst" });
    expect(gitAction(["push", "origin", "+feat"])).toMatchObject({ verb: "rewrote", branch: "feat" });
    for (const flag of ["-f", "--force", "--force-with-lease", "--force-with-lease=feat", "--force-if-includes", "-fu"])
      expect(gitAction(["push", flag, "origin", "feat"]), flag).toMatchObject({ verb: "rewrote" });
    expect(gitAction(["push", "-u", "origin", "feat"])).toMatchObject({ verb: "pushed" });
    expect(gitAction(["push"])).toMatchObject({ verb: "pushed", ref: undefined, branch: undefined });
    expect(gitAction(["push", "--delete", "origin", "old"])).toEqual({
      verb: "closed",
      refKind: "branch",
      ref: "old",
      branch: "old",
      fromPush: true,
    });
    expect(gitAction(["push", "origin", ":old"])).toEqual({
      verb: "closed",
      refKind: "branch",
      ref: "old",
      branch: "old",
      fromPush: true,
    });
  });

  it("branch -d closes the branch; a bare branch listing only navigates", () => {
    expect(gitAction(["branch", "-D", "old"])).toEqual({
      verb: "closed",
      refKind: "branch",
      ref: "old",
      branch: "old",
    });
    expect(gitAction(["branch"])).toEqual({ verb: "navigated" });
  });

  it("checkout / switch: -- is a path restore, a create flag confirms the branch, a plain name is unconfirmed", () => {
    expect(gitAction(["checkout", "--", "file.txt"])).toEqual({ verb: "navigated" });
    expect(gitAction(["checkout", "main", "--", "file.txt"])).toEqual({ verb: "navigated" });
    expect(gitAction(["checkout"])).toEqual({ verb: "navigated" });
    expect(gitAction(["switch", "-c", "feat"])).toEqual({
      verb: "navigated",
      refKind: "branch",
      ref: "feat",
      branch: "feat",
      branchConfirmed: true,
    });
    expect(gitAction(["checkout", "--orphan", "gh-pages"])).toMatchObject({
      branchConfirmed: true,
      branch: "gh-pages",
    });
    expect(gitAction(["checkout", "main"])).toEqual({
      verb: "navigated",
      refKind: "branch",
      ref: "main",
      branch: "main",
      plainCheckout: true,
    });
  });

  it("worktree add: -b confirms the branch, a trailing commit-ish names one, a bare path names none", () => {
    expect(gitAction(["worktree", "add", "-b", "feat", "../wt-feat"])).toEqual({
      verb: "navigated",
      refKind: "branch",
      ref: "feat",
      branch: "feat",
      branchConfirmed: true,
    });
    expect(gitAction(["worktree", "add", "-B", "feat2", "../wt"])).toMatchObject({
      branch: "feat2",
      branchConfirmed: true,
    });
    expect(gitAction(["worktree", "add", "../wt-x", "feature"])).toEqual({
      verb: "navigated",
      refKind: "branch",
      ref: "feature",
      branch: "feature",
    });
    const bare = gitAction(["worktree", "add", "../wt-x"]);
    expect(bare).toMatchObject({ verb: "navigated" });
    expect(bare?.refKind).toBeUndefined();
    expect(bare?.branch).toBeUndefined();
    expect(gitAction(["worktree", "list"])).toEqual({ verb: "navigated" });
  });
});
