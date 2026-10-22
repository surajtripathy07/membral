// v3 item 6: a ref keeps the forge host already known for it, so Today's chips
// link, and a hosted and a host-less spelling of one item stay one item.
// Fictional owners/repos throughout; github.com is the only real host named
// because forgeUrl links only GitHub.
import { describe, expect, it } from "vitest";
import { itemKeyResolver } from "@/lib/domain/ref-identity";
import { forgeUrl } from "@/lib/format/forge-url";
import { canonicalItemRef, hostlessRefQualifier, qualifyBareRepoRef } from "../ref-canon";

describe("(a) refs in the session's own project take the project's repo_identity host", () => {
  it("a bare #N and an owner/repo#N naming the project both qualify to host/owner/repo#N, and link", () => {
    const project = "github.com/acme/audiobooks";
    expect(canonicalItemRef("#10", project)?.ref).toBe("github.com/acme/audiobooks#10");
    expect(canonicalItemRef("acme/audiobooks#10", project)?.ref).toBe("github.com/acme/audiobooks#10");
    expect(forgeUrl("github.com/acme/audiobooks#10")).toBe("https://github.com/acme/audiobooks/issues/10");
  });
});

describe("(c) a gh cross-repo ref is github.com-qualified and links; a glab one does not", () => {
  it("forgeUrl links the host-qualified gh ref, never a host-less or non-GitHub one", () => {
    expect(forgeUrl("github.com/acme/ledger#7")).toBe("https://github.com/acme/ledger/issues/7");
    expect(forgeUrl("acme/ledger#7")).toBeNull();
    expect(forgeUrl("codehub.example/acme/ledger#7")).toBeNull();
  });
});

describe("(d) stored host-less rows take their known host at read time", () => {
  const q = hostlessRefQualifier(["github.com/acme/audiobooks", "codehub.example/group/sub/ledger", null]);

  it("a matching project of the user supplies the host", () => {
    expect(q("acme/audiobooks#10")).toBe("github.com/acme/audiobooks#10");
    expect(q("group/sub/ledger#4")).toBe("codehub.example/group/sub/ledger#4");
  });

  it("with no matching project, a GitHub-sourced receipt gives github.com; anything else stays host-less", () => {
    expect(q("other/tool#5", "gh issue view 5 -R other/tool")).toBe("github.com/other/tool#5");
    expect(q("other/tool#5", "see https://github.com/other/tool/issues/5")).toBe("github.com/other/tool#5");
    expect(q("other/tool#5", "glab issue view 5 -R other/tool")).toBe("other/tool#5");
    expect(q("other/tool#5", null)).toBe("other/tool#5");
  });

  it("an owner/repo on two of the user's hosts is never guessed; hosted, bare and non-ref text are unchanged", () => {
    const two = hostlessRefQualifier(["github.com/acme/api", "codehub.example/acme/api"]);
    expect(two("acme/api#5", "gh issue view 5")).toBe("acme/api#5");
    expect(q("github.com/acme/audiobooks#10")).toBe("github.com/acme/audiobooks#10");
    expect(q("#10")).toBe("#10");
    expect(q("review-10")).toBe("review-10");
  });

  it("the page's read path (bare repo name, then host) makes a stored `audiobooks#10` in its own project link", () => {
    const id = "github.com/acme/audiobooks";
    expect(forgeUrl(q(qualifyBareRepoRef("audiobooks#10", id)))).toBe("https://github.com/acme/audiobooks/issues/10");
  });
});

describe("canonicalization: hosted and host-less spellings of one item are one item", () => {
  it("itemKeyResolver merges `owner/repo#N` into the one hosted `github.com/owner/repo#N`", () => {
    const rows = [
      { ref: "github.com/acme/audiobooks#10", kind: "issue" },
      { ref: "acme/audiobooks#10", kind: "issue" },
    ];
    const key = itemKeyResolver(rows);
    expect(key(rows[1].ref, "issue")).toBe(key(rows[0].ref, "issue"));
  });
});

describe("review B1: a row's own evidence outranks the project host at read time", () => {
  it("a receipt URL on github.com wins over a same-named project on another host", () => {
    const q = hostlessRefQualifier(["codehub.example/acme/api"]);
    expect(q("acme/api#5", "see https://github.com/acme/api/issues/5")).toBe("github.com/acme/api#5");
    expect(q("acme/api#5", "gh issue view 5 -R forge.example/acme/api")).toBe("forge.example/acme/api#5");
  });

  it("a gh receipt with a non-GitHub project of the same name is a conflict: no host, no link", () => {
    const q = hostlessRefQualifier(["codehub.example/acme/api"]);
    expect(q("acme/api#5", "gh issue view 5 -R acme/api")).toBe("acme/api#5");
    expect(forgeUrl(q("acme/api#5", "gh issue view 5 -R acme/api"))).toBeNull();
    // glab against a github.com project likewise.
    expect(hostlessRefQualifier(["github.com/acme/api"])("acme/api#5", "glab issue view 5 -R acme/api")).toBe(
      "acme/api#5",
    );
  });

  it("two receipt hosts for the item, or two project hosts, give no host", () => {
    const q = hostlessRefQualifier([]);
    expect(q("acme/api#5", "https://github.com/acme/api/issues/5 https://codehub.example/acme/api/issues/5")).toBe(
      "acme/api#5",
    );
    const two = hostlessRefQualifier(["github.com/acme/api", "codehub.example/acme/api"]);
    expect(two("acme/api#5", "")).toBe("acme/api#5");
  });

  it("a receipt URL for another number or repo is no evidence for this item", () => {
    const q = hostlessRefQualifier([]);
    expect(q("acme/api#5", "https://ghe.corp.example/acme/api/issues/6")).toBe("acme/api#5");
    expect(q("acme/api#5", "gh issue view 5 -R acme/api; https://ghe.corp.example/acme/other/issues/5")).toBe(
      "github.com/acme/api#5",
    );
  });
});
