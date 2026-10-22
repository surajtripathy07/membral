// UX audit B0 / B1: the link a compact "owner/repo#N" ref renders to once
// the host prefix is dropped from the table.
import { describe, expect, it } from "vitest";
import { forgeUrl, glabFamilyOf, glabHostsFrom, turnPropsEvidence } from "../forge-url";

describe("forgeUrl", () => {
  it("links a hosted GitHub ref to its issues page", () => {
    expect(forgeUrl("github.com/acme/billing#12")).toBe("https://github.com/acme/billing/issues/12");
  });

  it("gives a host-less owner/repo#N no link, since its forge is unknown", () => {
    expect(forgeUrl("acme/billing#45")).toBeNull();
  });

  it("returns null for an unknown or fictional host", () => {
    expect(forgeUrl("codehub.example/acme/billing#7")).toBeNull();
    expect(forgeUrl("notreal.example/acme/billing!3")).toBeNull();
  });

  it("returns null for a host-less !N, which names no forge to link to", () => {
    expect(forgeUrl("acme/billing!17049")).toBeNull();
    expect(forgeUrl("!5")).toBeNull();
  });

  it("returns null for text that is not ref syntax", () => {
    expect(forgeUrl("review-17049.md")).toBeNull();
    expect(forgeUrl("not a ref")).toBeNull();
  });

  describe("glab family, host taken from data", () => {
    const hosts = new Set(["codehub.example"]);

    it("links a nested-group MR (!N) and issue (#N) on a known glab-family host", () => {
      expect(forgeUrl("codehub.example/acme/payments/core/ledger!17049", { glabHosts: hosts })).toBe(
        "https://codehub.example/acme/payments/core/ledger/-/merge_requests/17049",
      );
      expect(forgeUrl("codehub.example/acme/payments/core/ledger#88", { glabHosts: hosts })).toBe(
        "https://codehub.example/acme/payments/core/ledger/-/issues/88",
      );
    });

    it("takes the stored kind over the spelling (a stored MR reads `host/path#N`)", () => {
      expect(
        forgeUrl("codehub.example/acme/billing#7", { kind: "merge_request", glabHosts: ["codehub.example"] }),
      ).toBe("https://codehub.example/acme/billing/-/merge_requests/7");
      expect(forgeUrl("codehub.example/acme/billing#7", { kind: "issue", family: "gitlab" })).toBe(
        "https://codehub.example/acme/billing/-/issues/7",
      );
    });

    it("a nested-group path alone is not evidence: no host evidence, no link", () => {
      expect(forgeUrl("codehub.example/acme/payments/ledger!5")).toBeNull();
    });

    it("a dotted owner is never read as a host", () => {
      expect(forgeUrl("some.org/repo!5", { glabHosts: ["some.org"] })).toBeNull();
      expect(forgeUrl("some.org/repo#5", { family: "gitlab" })).toBeNull();
      expect([...glabHostsFrom([{ digest: "glab mr view 5", ref: "some.org/repo!5" }])]).toEqual([]);
    });

    it("an unknown host with owner/repo stays plain text, even as !N (gh writes PRs as !N too)", () => {
      expect(forgeUrl("codehub.example/acme/billing!7")).toBeNull();
      expect(forgeUrl("git.other.example/acme/billing#7", { glabHosts: hosts })).toBeNull();
    });

    it("github.com stays GitHub-shaped whatever the evidence says", () => {
      expect(forgeUrl("github.com/acme/billing#12", { family: "gitlab", glabHosts: ["github.com"] })).toBe(
        "https://github.com/acme/billing/issues/12",
      );
    });
  });

  describe("glabHostsFrom", () => {
    it("reads the host off a glab-grammar URL in any observed text", () => {
      const got = glabHostsFrom([
        { text: "see https://codehub.example/acme/payments/core/ledger/-/merge_requests/17049 please" },
        { text: "https://github.com/acme/billing/pull/3" },
        { text: "no url here" },
      ]);
      expect([...got]).toEqual(["codehub.example"]);
    });

    it("counts a glab command's host: the ref's host, else the session project's", () => {
      expect([...glabHostsFrom([{ digest: "glab mr view 5", ref: "codehub.example/acme/api!5" }])]).toEqual([
        "codehub.example",
      ]);
      expect([
        ...glabHostsFrom([{ digest: "glab mr view 5", ref: "!5", identity: "codehub.example/acme/api" }]),
      ]).toEqual(["codehub.example"]);
      expect([...glabHostsFrom([{ digest: "gh pr view 5", identity: "codehub.example/acme/api" }])]).toEqual([]);
      expect([...glabHostsFrom([{ digest: "glab mr view 5", identity: "github.com/acme/api" }])]).toEqual([]);
    });

    it("turnPropsEvidence pairs each action with the turn's digest; no action, no evidence", () => {
      const ev = turnPropsEvidence(
        { inputDigest: "glab mr note 9", actions: [{ verb: "commented", ref: "!9" }] },
        "codehub.example/acme/api",
      );
      expect([...glabHostsFrom(ev)]).toEqual(["codehub.example"]);
      expect(turnPropsEvidence({ inputDigest: "glab auth status" }, "codehub.example/acme/api")).toEqual([]);
    });

    it("a GHE host whose session ran `glab mr view -R other/repo` is not marked; its gh PRs stay unlinked", () => {
      const hosts = glabHostsFrom(
        turnPropsEvidence(
          { inputDigest: "glab mr view 5 -R other/repo", actions: [{ verb: "viewed", ref: "other/repo!5" }] },
          "git.acme.example/acme/api",
        ),
      );
      expect([...hosts]).toEqual([]);
      expect(forgeUrl("git.acme.example/acme/api#12", { kind: "merge_request", glabHosts: hosts })).toBeNull();
    });

    it("a repoUnknown bare ref does not credit the project host", () => {
      const ev = turnPropsEvidence(
        { inputDigest: "glab mr view 5", actions: [{ verb: "viewed", ref: "!5", repoUnknown: true }] },
        "git.acme.example/acme/api",
      );
      expect([...glabHostsFrom(ev)]).toEqual([]);
    });

    it("a chained glab && gh digest credits no host (the ref may be gh's)", () => {
      for (const digest of [
        "glab mr list && gh pr view 12 -R git.acme.example/acme/api",
        "glab mr list; gh pr view 12",
        "glab mr list | gh pr view 12",
      ]) {
        expect([...glabHostsFrom([{ digest, ref: "git.acme.example/acme/api!12" }])]).toEqual([]);
        expect([...glabHostsFrom([{ digest, ref: "!12", identity: "git.acme.example/acme/api" }])]).toEqual([]);
      }
      expect([...glabHostsFrom([{ digest: "glab mr view 12", ref: "codehub.example/acme/api!12" }])]).toEqual([
        "codehub.example",
      ]);
    });

    it("glabFamilyOf names the family only for a host in the set", () => {
      expect(glabFamilyOf("codehub.example/acme/api#9", new Set(["codehub.example"]))).toBe("gitlab");
      expect(glabFamilyOf("acme/api#9", new Set(["codehub.example"]))).toBeNull();
    });
  });
});
