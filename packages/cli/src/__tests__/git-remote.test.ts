import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createGitRemoteCache, resolveGitRemote } from "../git-remote.js";

describe("resolveGitRemote", () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "membral-git-remote-"));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("returns undefined for undefined/relative cwd without touching the filesystem", async () => {
    expect(await resolveGitRemote(undefined)).toBeUndefined();
    expect(await resolveGitRemote("relative/path")).toBeUndefined();
  });

  it("reads the origin remote URL from a normal .git/config at the repo root", async () => {
    const repo = join(root, "webapp");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(
      join(repo, ".git", "config"),
      [
        "[core]",
        "\trepositoryformatversion = 0",
        '[remote "origin"]',
        "\turl = https://codehub.example/acme/webapp.git",
        "\tfetch = +refs/heads/*:refs/remotes/origin/*",
        '[branch "main"]',
        "\tremote = origin",
      ].join("\n"),
    );

    expect(await resolveGitRemote(repo)).toBe("https://codehub.example/acme/webapp.git");
  });

  it("walks up from a nested cwd to find the repo root's .git", async () => {
    const repo = join(root, "webapp");
    const nested = join(repo, "src", "components", "deep");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(nested, { recursive: true });
    await writeFile(join(repo, ".git", "config"), '[remote "origin"]\n\turl = git@codehub.example:acme/webapp.git\n');

    expect(await resolveGitRemote(nested)).toBe("git@codehub.example:acme/webapp.git");
  });

  it("returns undefined when .git/config has no origin remote", async () => {
    const repo = join(root, "no-remote");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(join(repo, ".git", "config"), "[core]\n\trepositoryformatversion = 0\n");

    expect(await resolveGitRemote(repo)).toBeUndefined();
  });

  it("returns undefined when there is no .git anywhere up to the walk limit", async () => {
    const noRepo = join(root, "not-a-repo", "nested");
    await mkdir(noRepo, { recursive: true });

    expect(await resolveGitRemote(noRepo)).toBeUndefined();
  });

  it("resolves a worktree's .git FILE through commondir back to the main repo's config", async () => {
    const main = join(root, "main-repo");
    const worktree = join(root, "webapp-feature-worktree");
    const worktreeGitDir = join(main, ".git", "worktrees", "feature-x");

    await mkdir(join(main, ".git"), { recursive: true });
    await writeFile(
      join(main, ".git", "config"),
      '[remote "origin"]\n\turl = https://codehub.example/acme/webapp.git\n',
    );

    await mkdir(worktreeGitDir, { recursive: true });
    await writeFile(join(worktreeGitDir, "commondir"), `${join(main, ".git")}\n`);

    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, ".git"), `gitdir: ${worktreeGitDir}\n`);

    expect(await resolveGitRemote(worktree)).toBe("https://codehub.example/acme/webapp.git");
  });

  it("resolves a worktree with a relative gitdir/commondir pointer", async () => {
    const main = join(root, "main-repo-2");
    const worktree = join(root, "webapp-feature-worktree-2");
    const worktreeGitDir = join(main, ".git", "worktrees", "feature-y");

    await mkdir(join(main, ".git"), { recursive: true });
    await writeFile(join(main, ".git", "config"), '[remote "origin"]\n\turl = git@codehub.example:acme/webapp.git\n');

    await mkdir(worktreeGitDir, { recursive: true });
    // commondir relative to the worktree gitdir, pointing back at <main>/.git
    await writeFile(join(worktreeGitDir, "commondir"), "../..\n");

    await mkdir(worktree, { recursive: true });
    // gitdir relative to the worktree checkout directory
    await writeFile(join(worktree, ".git"), `gitdir: ../main-repo-2/.git/worktrees/feature-y\n`);

    expect(await resolveGitRemote(worktree)).toBe("git@codehub.example:acme/webapp.git");
  });

  it("caches resolved values across calls with the same cache instance", async () => {
    const repo = join(root, "cached-repo");
    await mkdir(join(repo, ".git"), { recursive: true });
    await writeFile(
      join(repo, ".git", "config"),
      '[remote "origin"]\n\turl = https://codehub.example/acme/cached.git\n',
    );

    const cache = createGitRemoteCache();
    const first = await resolveGitRemote(repo, cache);
    expect(first).toBe("https://codehub.example/acme/cached.git");
    expect(cache.get(repo)).toBe("https://codehub.example/acme/cached.git");

    // Even if the config changes on disk, the cached value is returned.
    await writeFile(
      join(repo, ".git", "config"),
      '[remote "origin"]\n\turl = https://codehub.example/acme/changed.git\n',
    );
    const second = await resolveGitRemote(repo, cache);
    expect(second).toBe("https://codehub.example/acme/cached.git");
  });

  it("caches a no-remote result as well (not just successes)", async () => {
    const repo = join(root, "no-remote-cached");
    await mkdir(repo, { recursive: true }); // no .git at all

    const cache = createGitRemoteCache();
    expect(await resolveGitRemote(repo, cache)).toBeUndefined();
    expect(cache.has(repo)).toBe(true);
    expect(cache.get(repo)).toBeNull();
  });
});
