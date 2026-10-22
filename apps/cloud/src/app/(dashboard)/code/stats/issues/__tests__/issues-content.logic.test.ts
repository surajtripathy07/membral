// Step 3D-5 lock for the functions moved verbatim into issues-content.logic.ts
// — a small table per function so a future move stays honest.
import { describe, expect, it } from "vitest";
import type { IssueAttribution } from "@/lib/agent-stats/attribution";
import {
  compactRefLabel,
  formatTokens,
  groupByRepo,
  hasCost,
  isMentionWithoutWork,
  repoGroupKey,
  repoGroupLabel,
  shortSha,
  untitledLine,
} from "../issues-content.logic";

function issue(overrides: Partial<IssueAttribution> = {}): IssueAttribution {
  return {
    issue: "codehub.example/acme/billing#7",
    kind: "issue",
    sessions: 1,
    mentions: 0,
    turns: 3,
    tokens: { input: 10, output: 5, cache_read: 0, cache_creation: 0 },
    costUsd: 0.01,
    estimated: true,
    role: "worked_on",
    reviewVerb: null,
    buildVerb: "committed",
    commits: [],
    unpricedSessions: 0,
    inferredRef: false,
    sessionIds: [],
    turnIdxBySession: {},
    ...overrides,
  };
}

describe("hasCost", () => {
  it.each([
    ["null", null, false],
    ["zero", 0, false],
    ["negative", -1, false],
    ["NaN", Number.NaN, false],
    ["positive finite", 1.5, true],
  ] as const)("%s -> %s", (_label, n, expected) => {
    expect(hasCost(n)).toBe(expected);
  });
});

describe("formatTokens", () => {
  const t = (input: number) => ({ input, output: 0, cache_read: 0, cache_creation: 0 });
  it.each([
    ["under 1000: plain locale string", t(999), "999"],
    ["thousands: one decimal + K", t(1_500), "1.5K"],
    ["millions: one decimal + M", t(2_000_000), "2.0M"],
    ["zero", t(0), "0"],
  ] as const)("%s", (_label, tokens, expected) => {
    expect(formatTokens(tokens)).toBe(expected);
  });
});

describe("shortSha", () => {
  it.each([
    ["null -> em dash", null, "—"],
    ["short sha unchanged", "abc123", "abc123"],
    ["long sha truncated to 7", "abcdef1234567", "abcdef1"],
    ["exactly 7 chars", "1234567", "1234567"],
  ] as const)("%s", (_label, sha, expected) => {
    expect(shortSha(sha)).toBe(expected);
  });
});

describe("untitledLine", () => {
  it.each([
    ["undefined -> null", undefined, null],
    ["zero -> null", 0, null],
    ["negative -> null", -1, null],
    ["one -> singular", 1, "+1 commit without a recorded subject"],
    ["plural", 3, "+3 commits without a recorded subject"],
  ] as const)("%s", (_label, n, expected) => {
    expect(untitledLine(n)).toBe(expected);
  });
});

describe("repoGroupLabel / repoGroupKey", () => {
  it.each([
    ["host-qualified GitHub issue drops the host", "github.com/acme/billing#7", "issue" as const, "acme/billing"],
    ["glab-family MR drops the host", "codehub.example/acme/billing!12", "merge_request" as const, "acme/billing"],
    ["bare repo#N with no owner", "bare-repo#3", "issue" as const, "bare-repo"],
    ["unparseable ref falls back to itself", "not-a-ref-at-all", "issue" as const, "not-a-ref-at-all"],
  ] as const)("%s", (_label, ref, kind, expectedLabel) => {
    expect(repoGroupLabel(ref, kind)).toBe(expectedLabel);
  });

  it("repoGroupKey lower-cases and includes the host", () => {
    expect(repoGroupKey("GitHub.com/Acme/Billing#7", "issue")).toEqual({
      key: "github.com/acme/billing",
      host: "github.com",
      path: "acme/billing",
    });
  });

  it("repoGroupKey with no host has a null host", () => {
    expect(repoGroupKey("bare-repo#3", "issue")).toEqual({ key: "bare-repo", host: null, path: "bare-repo" });
  });
});

describe("compactRefLabel", () => {
  it.each([
    ["GitHub issue -> #N", "github.com/acme/billing#7", "issue" as const, "#7"],
    ["glab-family MR (host in glabHosts) -> !N", "codehub.example/acme/billing!12", "merge_request" as const, "!12"],
    ["GitHub MR still uses #N", "github.com/acme/billing#12", "merge_request" as const, "#12"],
    // D-065: a host no data proves glab-family has no link, so the label carries the repo.
    [
      "unknown-family host MR -> owner/repo!N",
      "forge.unknown.example/acme/billing!12",
      "merge_request" as const,
      "acme/billing!12",
    ],
    [
      "unknown-family host issue -> owner/repo#N",
      "forge.unknown.example/acme/billing#12",
      "issue" as const,
      "acme/billing#12",
    ],
    ["unparseable ref returns itself", "no-number-here", "issue" as const, "no-number-here"],
  ] as const)("%s", (_label, ref, kind, expected) => {
    expect(compactRefLabel(ref, kind, ["codehub.example"])).toBe(expected);
  });
});

describe("groupByRepo", () => {
  it("one repo, host-qualified ref -> one group named without the host", () => {
    const groups = groupByRepo([
      issue({ issue: "github.com/acme/billing#1" }),
      issue({ issue: "github.com/acme/billing#2" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].repo).toBe("acme/billing");
    expect(groups[0].rows).toHaveLength(2);
  });

  it("a host-less owner/repo folds into the one host-qualified group for the same path", () => {
    const groups = groupByRepo([issue({ issue: "github.com/acme/billing#1" }), issue({ issue: "acme/billing#2" })]);
    expect(groups).toHaveLength(1);
  });

  it("null issue (unattributed row) goes into an 'Other' group", () => {
    const groups = groupByRepo([issue({ issue: null })]);
    expect(groups).toHaveLength(1);
    expect(groups[0].repo).toBe("Other");
  });

  it("distinct repos produce distinct groups", () => {
    const groups = groupByRepo([
      issue({ issue: "github.com/acme/billing#1" }),
      issue({ issue: "github.com/acme/other#2" }),
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe("isMentionWithoutWork", () => {
  it.each([
    ["referenced, no sessions, no cost -> true", issue({ role: "referenced", sessions: 0, costUsd: null }), true],
    ["referenced but has sessions -> false", issue({ role: "referenced", sessions: 1, costUsd: null }), false],
    ["referenced but has cost -> false", issue({ role: "referenced", sessions: 0, costUsd: 1.2 }), false],
    ["worked_on -> false regardless", issue({ role: "worked_on", sessions: 0, costUsd: null }), false],
  ] as const)("%s", (_label, row, expected) => {
    expect(isMentionWithoutWork(row)).toBe(expected);
  });
});
