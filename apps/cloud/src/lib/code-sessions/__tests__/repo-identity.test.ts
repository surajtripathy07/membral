import { describe, expect, it } from "vitest";
import {
  normalizeRepoArgument,
  normalizeRepoIdentity,
  sanitizeRemoteUrl,
  UNASSIGNED_REPO_IDENTITY,
} from "../repo-identity";

describe("normalizeRepoIdentity (ADR 0021 Q4)", () => {
  const cases: { name: string; repo: { path?: string; remoteUrl?: string }; want: string }[] = [
    {
      name: "https URL with .git suffix",
      repo: { remoteUrl: "https://github.com/acme/webapp.git" },
      want: "github.com/acme/webapp",
    },
    {
      name: "https URL without .git suffix",
      repo: { remoteUrl: "https://github.com/acme/webapp" },
      want: "github.com/acme/webapp",
    },
    {
      name: "scp-like ssh shorthand (git@host:owner/repo.git)",
      repo: { remoteUrl: "git@github.com:acme/webapp.git" },
      want: "github.com/acme/webapp",
    },
    {
      name: "ssh:// scheme URL",
      repo: { remoteUrl: "ssh://git@github.com/acme/webapp.git" },
      want: "github.com/acme/webapp",
    },
    {
      name: "git:// scheme URL",
      repo: { remoteUrl: "git://github.com/acme/webapp.git" },
      want: "github.com/acme/webapp",
    },
    {
      name: "credentialed https URL — credentials stripped",
      repo: { remoteUrl: "https://x-token-auth:abc123@github.com/acme/webapp.git" },
      want: "github.com/acme/webapp",
    },
    {
      name: "credentialed scp-like URL — user@ stripped",
      repo: { remoteUrl: "deploy@git.acme.internal:acme/webapp.git" },
      want: "git.acme.internal/acme/webapp",
    },
    {
      name: "self-hosted host, trailing slash",
      repo: { remoteUrl: "https://git.acme.internal/acme/webapp/" },
      want: "git.acme.internal/acme/webapp",
    },
    {
      name: "host case is normalized to lowercase",
      repo: { remoteUrl: "https://GitHub.com/acme/webapp.git" },
      want: "github.com/acme/webapp",
    },
    {
      name: "no remote — normalized absolute posix path",
      repo: { path: "/Users/dev/webapp" },
      want: "/Users/dev/webapp",
    },
    {
      name: "no remote — absolute path, trailing slash + doubled slashes collapsed",
      repo: { path: "/Users/dev//webapp/" },
      want: "/Users/dev/webapp",
    },
    {
      name: "no remote — Windows absolute path, backslashes normalized",
      repo: { path: "C:\\Users\\dev\\webapp" },
      want: "C:/Users/dev/webapp",
    },
    {
      name: "no remote, relative path — not a stable key, falls to unassigned",
      repo: { path: "webapp" },
      want: UNASSIGNED_REPO_IDENTITY,
    },
    {
      name: "malformed remote URL, no path — falls to unassigned",
      repo: { remoteUrl: "not a valid url" },
      want: UNASSIGNED_REPO_IDENTITY,
    },
    {
      name: "empty-string remote and path — falls to unassigned",
      repo: { remoteUrl: "", path: "" },
      want: UNASSIGNED_REPO_IDENTITY,
    },
    {
      name: "remote URL preferred over path when both present",
      repo: { remoteUrl: "https://github.com/acme/webapp.git", path: "/Users/dev/webapp" },
      want: "github.com/acme/webapp",
    },
  ];

  for (const { name, repo, want } of cases) {
    it(name, () => {
      expect(normalizeRepoIdentity(repo)).toBe(want);
    });
  }

  it("no cwd / no remote at all — the fallback bucket", () => {
    expect(normalizeRepoIdentity({})).toBe(UNASSIGNED_REPO_IDENTITY);
    expect(normalizeRepoIdentity(undefined)).toBe(UNASSIGNED_REPO_IDENTITY);
    expect(normalizeRepoIdentity(null)).toBe(UNASSIGNED_REPO_IDENTITY);
  });
});

describe("sanitizeRemoteUrl (adversarial fix: credentials at rest)", () => {
  it("strips user:token credentials from scheme URLs", () => {
    expect(sanitizeRemoteUrl("https://user:ghp_supersecrettoken1234567@codehub.example/acme/webapp.git")).toBe(
      "https://codehub.example/acme/webapp.git",
    );
    expect(sanitizeRemoteUrl("https://oauth2:glpat-tok123456789@codehub.example/acme/webapp.git")).toBe(
      "https://codehub.example/acme/webapp.git",
    );
  });

  it("leaves credential-free URLs and scp-like ssh remotes unchanged", () => {
    expect(sanitizeRemoteUrl("https://codehub.example/acme/webapp.git")).toBe(
      "https://codehub.example/acme/webapp.git",
    );
    expect(sanitizeRemoteUrl("git@codehub.example:acme/webapp.git")).toBe("git@codehub.example:acme/webapp.git");
  });

  it("returns null for empty or unparseable scheme URLs", () => {
    expect(sanitizeRemoteUrl(null)).toBeNull();
    expect(sanitizeRemoteUrl("   ")).toBeNull();
    expect(sanitizeRemoteUrl("https://")).toBeNull();
  });
});

// e2e C-1: the preamble hook and MCP `project` args pass ONE string that is
// either a remote or a cwd path; a path must not be parsed as a URL.
describe("normalizeRepoArgument", () => {
  it("keeps an absolute path a path (was: host 'private', identity 'private/tmp/…')", () => {
    const p = "/private/tmp/claude-501/-Users-someone/scratch-cwd/notes";
    expect(normalizeRepoArgument(p)).toBe(p);
    expect(normalizeRepoArgument(`${p}/`)).toBe(p);
    expect(normalizeRepoArgument(p)).toBe(normalizeRepoIdentity({ path: p }));
  });

  it("still normalizes remotes exactly as import does", () => {
    for (const r of ["https://github.com/acme/repo.git", "git@github.com:acme/repo.git", "github.com/acme/repo"]) {
      expect(normalizeRepoArgument(r)).toBe(normalizeRepoIdentity({ remoteUrl: r }));
    }
  });

  it("handles a Windows drive path and an empty argument", () => {
    expect(normalizeRepoArgument("C:\\Users\\someone\\notes")).toBe("C:/Users/someone/notes");
    expect(normalizeRepoArgument("")).toBe(UNASSIGNED_REPO_IDENTITY);
  });
});
