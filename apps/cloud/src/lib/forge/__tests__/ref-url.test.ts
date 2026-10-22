// Goal 2026-09-26 W2 (P0b): the four host shapes a chip can link to, and the
// unknown-host case that must stay plain text.
import { describe, expect, it } from "vitest";
import { forgeFamilyOf, refToUrl } from "../ref-url";

describe("refToUrl", () => {
  it("shapes a GitHub-family issue as owner/repo/issues/N", () => {
    expect(refToUrl("github.com/acme/billing#12", "issue")).toBe("https://github.com/acme/billing/issues/12");
  });

  it("shapes a GitHub-family merge request as owner/repo/pull/N", () => {
    expect(refToUrl("github.com/acme/billing#45", "merge_request")).toBe("https://github.com/acme/billing/pull/45");
  });

  it("shapes a glab-family issue as project/-/issues/N (self-hosted forge included)", () => {
    expect(refToUrl("codehub.example/acme/billing#7", "issue")).toBe("https://codehub.example/acme/billing/-/issues/7");
    expect(refToUrl("gitlab.com/acme/billing#7", "issue")).toBe("https://gitlab.com/acme/billing/-/issues/7");
  });

  it("shapes a glab-family merge request as project/-/merge_requests/N, keeping nested groups", () => {
    expect(refToUrl("codehub.example/acme/billing#17049", "merge_request")).toBe(
      "https://codehub.example/acme/billing/-/merge_requests/17049",
    );
    expect(refToUrl("codehub.example/acme/platform/billing!3", "merge_request")).toBe(
      "https://codehub.example/acme/platform/billing/-/merge_requests/3",
    );
  });

  it("returns null for a ref with no resolvable host", () => {
    expect(refToUrl("#12", "issue")).toBeNull();
    expect(refToUrl("acme/billing#12", "issue")).toBeNull();
    expect(refToUrl("acme/billing!17049", "merge_request")).toBeNull();
    expect(refToUrl("", "issue")).toBeNull();
    expect(refToUrl("not a ref at all", "issue")).toBeNull();
  });

  it("returns an http(s) ref as written", () => {
    expect(refToUrl("https://codehub.example/acme/billing/-/issues/9", "issue")).toBe(
      "https://codehub.example/acme/billing/-/issues/9",
    );
  });

  it("forgeFamilyOf: github hosts are GitHub-shaped, any other hostname glab-shaped, non-hostnames null", () => {
    expect(forgeFamilyOf("github.com")).toBe("github");
    expect(forgeFamilyOf("github.acme.example")).toBe("github");
    expect(forgeFamilyOf("codehub.example")).toBe("gitlab");
    expect(forgeFamilyOf("acme")).toBeNull();
  });
});

describe("refToUrl — a known forge family wins over the host guess (F17)", () => {
  it("a GitHub Enterprise host not named github.* links GitHub-shaped when the family is given", () => {
    expect(refToUrl("git.acme.corp/team/app#12", "merge_request")).toBe(
      "https://git.acme.corp/team/app/-/merge_requests/12",
    );
    expect(refToUrl("git.acme.corp/team/app#12", "merge_request", { family: "github" })).toBe(
      "https://git.acme.corp/team/app/pull/12",
    );
    expect(refToUrl("git.acme.corp/team/app#12", "issue", { family: null })).toBe(
      "https://git.acme.corp/team/app/-/issues/12",
    );
  });
});
