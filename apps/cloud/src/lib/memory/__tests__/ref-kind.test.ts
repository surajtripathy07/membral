import { describe, expect, it } from "vitest";
import { classifyRef, isBranchShaped } from "../ref-kind";

describe("classifyRef", () => {
  it("classifies GitHub commit/PR/issue/comment/release/deploy URLs", () => {
    expect(classifyRef("https://github.com/o/r/commit/abc1234")).toBe("commit");
    expect(classifyRef("https://github.com/o/r/pull/12")).toBe("pr");
    expect(classifyRef("https://gitlab.com/o/r/-/merge_requests/9")).toBe("mr");
    expect(classifyRef("https://github.com/o/r/issues/151")).toBe("issue");
    expect(classifyRef("https://github.com/o/r/issues/151#issuecomment-5652648093")).toBe("comment");
    expect(classifyRef("https://github.com/o/r/actions/runs/123456")).toBe("deploy");
    expect(classifyRef("https://github.com/o/r/releases/tag/v1.2.3")).toBe("release");
  });

  it("classifies a claude.ai artifact URL as doc", () => {
    expect(classifyRef("https://claude.ai/public/artifacts/abc-123")).toBe("doc");
  });

  it("classifies an unrecognized https URL as other (not ambiguous)", () => {
    expect(classifyRef("https://example.com/some/random/page")).toBe("other");
  });

  it("classifies a bare 7-40 char hex string as a commit sha", () => {
    expect(classifyRef("a1b2c3d")).toBe("commit");
    expect(classifyRef("a1b2c3d4e5f60718293a4b5c6d7e8f9012345678")).toBe("commit");
  });

  it("classifies #N or a bare integer as an issue", () => {
    expect(classifyRef("#151")).toBe("issue");
    expect(classifyRef("151")).toBe("issue");
  });

  it("classifies a *.md path as a doc", () => {
    expect(classifyRef("docs/design/memory-v1.md")).toBe("doc");
    expect(classifyRef("README.md")).toBe("doc");
  });

  it("classifies origin/<x>, main, master as a branch", () => {
    expect(classifyRef("origin/feature-x")).toBe("branch");
    expect(classifyRef("main")).toBe("branch");
    expect(classifyRef("master")).toBe("branch");
  });

  it("classifies a known-prefix or hyphen/digit-bearing branch name as branch (issue #162)", () => {
    expect(classifyRef("feature/some-branch-adr")).toBe("branch");
    expect(classifyRef("fix/162-something")).toBe("branch");
    expect(classifyRef("release/1.2.0")).toBe("branch");
  });

  it("classifies vN.N.N as a tag", () => {
    expect(classifyRef("v1.2.3")).toBe("tag");
  });

  it("B1 (review round 2): a repo-relative FILE path is never classified branch, even one with a slash", () => {
    expect(classifyRef("src/foo.ts")).not.toBe("branch");
    expect(classifyRef("apps/cloud/src/lib/memory/merge.ts")).not.toBe("branch");
  });

  it("B1 (review round 2): TAG precedence wins over BRANCH for a v-prefixed slash ref", () => {
    expect(classifyRef("v1/api")).toBe("tag");
  });

  describe("isBranchShaped (review round 2, B1/S1)", () => {
    it("accepts real branch names", () => {
      expect(isBranchShaped("feature/some-branch-adr")).toBe(true);
      expect(isBranchShaped("fix/162-something")).toBe(true);
      expect(isBranchShaped("release/1.2.0")).toBe(true);
      expect(isBranchShaped("origin/main")).toBe(true);
      expect(isBranchShaped("main")).toBe(true);
    });

    it("B1: rejects repo-relative file paths (a letter-led extension is a real file, not a branch)", () => {
      expect(isBranchShaped("src/foo.ts")).toBe(false);
      expect(isBranchShaped("apps/cloud/src/lib/memory/merge.ts")).toBe(false);
    });

    it("S1: rejects plain multi-segment prose and paths that merely happen to be slash-shaped", () => {
      expect(isBranchShaped("github.com/acme/repo")).toBe(false); // domain-shaped first segment
      expect(isBranchShaped("www.example.com/path")).toBe(false); // scheme-less URL, domain-shaped
      expect(isBranchShaped("and/or")).toBe(false);
      expect(isBranchShaped("yes/no")).toBe(false);
      expect(isBranchShaped("Jane/Doe")).toBe(false); // a person's name
      expect(isBranchShaped("Users/jdoe/Documents")).toBe(false); // home path carrying a username
      expect(isBranchShaped("home/jdoe/notes")).toBe(false);
      expect(isBranchShaped("src/lib/memory")).toBe(false); // a bare directory
    });

    it("R2-N1 (review round 3, pinning current behaviour, no logic change): 'jdoe/wip' rejected, 'feature/add-v2.x' treated as a file", () => {
      // a common user/topic branch convention (no hyphen/digit anywhere) —
      // isBranchShaped requires one, so this is dropped as unscrubbed shape
      // upstream, not kept as a branch. Deferred per the review (low risk:
      // it would also need to be literally present in a turn to survive).
      expect(isBranchShaped("jdoe/wip")).toBe(false);
      // ends in a letter-led extension (".x"), so BRANCH_FILE_EXTENSION wins
      // and it classifies as a file-shaped ref, not a branch, even though
      // "feature/" is a known branch prefix.
      expect(isBranchShaped("feature/add-v2.x")).toBe(false);
      expect(classifyRef("feature/add-v2.x")).not.toBe("branch");
    });
  });

  it("returns undefined (ambiguous — keep the model's answer) for an unshaped ref", () => {
    expect(classifyRef("some-random-token")).toBeUndefined();
    expect(classifyRef("")).toBeUndefined();
  });

  it("falls through to shape checks rather than throwing on a malformed URL-looking string", () => {
    // Starts with http:// but URL() would throw on the embedded space — must not throw.
    expect(() => classifyRef("http:// not a real url")).not.toThrow();
  });
});
