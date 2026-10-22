import { describe, expect, it } from "vitest";
import { groundSessionIssues, type IssueGroundingTurn, qualifyIssueRef } from "../../attribution/grounding";
import type { SessionProfile } from "../../code-sessions/profile";
import * as refCanon from "../../code-sessions/ref-canon";
import { foldDiscussedKinds, githubItemKey, itemKeyResolver, itemReadKey } from "../ref-identity";

// R3 3.2/3.3 (D-064, #242 + #168): ONE key function for the write path and
// every read path. Key: `kind \0 [host/]owner/repo#N`; a host-less spelling
// takes a host only when exactly one host in scope holds that item.

describe("one home for item identity", () => {
  it("ref-canon no longer defines a second key function (no import cycle: ref-canon imports nothing back)", () => {
    const exported = Object.keys(refCanon);
    for (const name of ["itemKeyResolver", "itemReadKey", "githubItemKey", "foldDiscussedKinds", "issueMatchKey"]) {
      expect(exported).not.toContain(name);
    }
    expect(typeof foldDiscussedKinds).toBe("function");
    expect(typeof githubItemKey).toBe("function");
  });

  it("itemReadKey is the resolver over an empty scope", () => {
    const empty = itemKeyResolver([]);
    for (const [ref, kind] of [
      ["github.com/acme/api#5", "issue"],
      ["acme/api#5", "issue"],
      ["acme/billing!17049", "merge_request"],
      ["not a ref", "issue"],
    ] as const) {
      expect(itemReadKey(ref, kind)).toBe(empty(ref, kind));
    }
  });
});

describe("itemKeyResolver: the D-064 table", () => {
  const cases: Array<{
    label: string;
    scope: Array<{ ref: string; kind: string }>;
    a: [string, string];
    b: [string, string];
    same: boolean;
  }> = [
    {
      label: "same item on two forges stays two keys",
      scope: [
        { ref: "github.com/acme/api#5", kind: "issue" },
        { ref: "codehub.example/acme/api#5", kind: "issue" },
      ],
      a: ["github.com/acme/api#5", "issue"],
      b: ["codehub.example/acme/api#5", "issue"],
      same: false,
    },
    {
      label: "host-less ref with ONE in-scope host resolves to it",
      scope: [{ ref: "codehub.example/acme/billing#17049", kind: "merge_request" }],
      a: ["acme/billing!17049", "merge_request"],
      b: ["codehub.example/acme/billing#17049", "merge_request"],
      same: true,
    },
    {
      label: "host-less ref with TWO in-scope hosts stays host-less (vs github)",
      scope: [
        { ref: "github.com/acme/api#5", kind: "issue" },
        { ref: "codehub.example/acme/api#5", kind: "issue" },
      ],
      a: ["acme/api#5", "issue"],
      b: ["github.com/acme/api#5", "issue"],
      same: false,
    },
    {
      label: "host-less ref with TWO in-scope hosts stays host-less (vs codehub)",
      scope: [
        { ref: "github.com/acme/api#5", kind: "issue" },
        { ref: "codehub.example/acme/api#5", kind: "issue" },
      ],
      a: ["acme/api#5", "issue"],
      b: ["codehub.example/acme/api#5", "issue"],
      same: false,
    },
    {
      label: "kind stays in the key",
      scope: [{ ref: "codehub.example/acme/api#5", kind: "issue" }],
      a: ["codehub.example/acme/api#5", "issue"],
      b: ["codehub.example/acme/api#5", "merge_request"],
      same: false,
    },
    {
      label: "spelling variants (URL, case) of one hosted item are one key",
      scope: [],
      a: ["https://GitHub.com/Acme/API/pull/12/", "merge_request"],
      b: ["github.com/acme/api#12", "merge_request"],
      same: true,
    },
  ];
  for (const c of cases) {
    it(c.label, () => {
      const key = itemKeyResolver(c.scope);
      expect(key(...c.a) === key(...c.b)).toBe(c.same);
    });
  }

  it("a host-less spelling with one in-scope host keys exactly as the hosted one", () => {
    const key = itemKeyResolver([{ ref: "github.com/acme/api#5", kind: "issue" }]);
    expect(key("acme/api#5", "issue")).toBe("issue\u0000github.com/acme/api#5");
  });
});

// The former divergence (#242): the write path stripped the host and merged a
// bare `acme/api#5` (and a second forge's `#5`) into the github row, while the
// read path kept them apart. Both now go through itemKeyResolver.
describe("write path and read path agree (#242)", () => {
  const PROJECT = "github.com/acme/api";
  const turn = (idx: number, text: string): IssueGroundingTurn => ({ idx, role: "user", text }) as IssueGroundingTurn;
  const profileWith = (refs: Array<{ ref: string; kind: "issue" | "merge_request" }>): SessionProfile =>
    ({
      refs: refs.map((r) => ({
        ref: r.ref,
        refKind: r.kind,
        tier: "observed",
        turn_share: 0.5,
        review_verb: "viewed",
        build_verb: null,
        triaged: false,
        discussed: false,
        turns: 1,
        related_to: [],
        first_turn_idx: 0,
        last_turn_idx: 0,
        evidence: { viewed: { idx: 0 } },
        shas: [],
      })),
    }) as unknown as SessionProfile;

  it("model github.com/acme/api#5 plus observed codehub.example/acme/api#5 gives two rows", () => {
    const rows = groundSessionIssues(
      [
        {
          ref: "https://github.com/acme/api/issues/5",
          kind: "issue",
          role: "worked_on",
          evidence_quote: "please look at https://github.com/acme/api/issues/5 today",
        } as never,
      ],
      [turn(0, "please look at https://github.com/acme/api/issues/5 today")],
      PROJECT,
      { profile: profileWith([{ ref: "codehub.example/acme/api#5", kind: "issue" }]), actionsVersion: 1 },
    );
    const refs = rows.map((r) => r.ref.toLowerCase()).sort();
    expect(refs).toEqual(["codehub.example/acme/api#5", "github.com/acme/api#5"]);

    // The read path keys the stored rows the same way: two items.
    const read = itemKeyResolver(rows);
    expect(new Set(rows.map((r) => read(r.ref, r.kind))).size).toBe(2);
  });

  it("one model ref and its one observed hosted spelling still merge into one row", () => {
    const rows = groundSessionIssues(
      [
        {
          ref: "https://github.com/acme/api/issues/5",
          kind: "issue",
          role: "worked_on",
          evidence_quote: "please look at https://github.com/acme/api/issues/5 today",
        } as never,
      ],
      [turn(0, "please look at https://github.com/acme/api/issues/5 today")],
      PROJECT,
      { profile: profileWith([{ ref: "github.com/acme/api#5", kind: "issue" }]), actionsVersion: 1 },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].tier).toBe("observed");
  });
});

// R3 ADV findings 1-3 (driver ruling: a port and a leading `www.` are not part of item identity).
describe("ADV: port and www. never split one item", () => {
  it("keys", () => {
    expect(itemReadKey("https://codehub.example:8443/acme/api/-/issues/5", "issue")).toBe(
      itemReadKey("codehub.example/acme/api#5", "issue"),
    );
    expect(itemReadKey("https://www.github.com/acme/api/issues/5", "issue")).toBe(
      itemReadKey("github.com/acme/api#5", "issue"),
    );
    // A stored ported row (written before normalisation) keys as its port-less spelling, and resolves a host-less one.
    expect(itemReadKey("codehub.example:8443/acme/api#5", "issue")).toBe("issue\u0000codehub.example/acme/api#5");
    expect(itemKeyResolver([{ ref: "codehub.example:8443/acme/api#5", kind: "issue" }])("acme/api#5", "issue")).toBe(
      "issue\u0000codehub.example/acme/api#5",
    );
  });

  it("the write path qualifies to the normalised host", () => {
    expect(qualifyIssueRef("https://www.github.com/acme/api/issues/5", "github.com/acme/api", 5)).toBe(
      "github.com/acme/api#5",
    );
    expect(qualifyIssueRef("https://codehub.example:8443/acme/api/-/issues/5", "codehub.example/acme/api", 5)).toBe(
      "codehub.example/acme/api#5",
    );
  });
});

describe("ADV: grounding stores one row per item, hosted spelling", () => {
  const turn = (idx: number, text: string): IssueGroundingTurn => ({ idx, role: "user", text }) as IssueGroundingTurn;
  const profileWith = (refs: Array<{ ref: string; kind: "issue" | "merge_request" }>): SessionProfile =>
    ({
      refs: refs.map((r) => ({
        ref: r.ref,
        refKind: r.kind,
        tier: "observed",
        turn_share: 0.5,
        review_verb: "viewed",
        build_verb: null,
        triaged: false,
        discussed: false,
        turns: 1,
        related_to: [],
        first_turn_idx: 0,
        last_turn_idx: 0,
        evidence: { viewed: { idx: 0 } },
        shas: [],
      })),
    }) as unknown as SessionProfile;
  const ground = (
    project: string,
    modelRef: string,
    quote: string,
    obs: Array<{ ref: string; kind: "issue" | "merge_request" }>,
  ) =>
    groundSessionIssues(
      [{ ref: modelRef, kind: "issue", role: "worked_on", evidence_quote: quote } as never],
      [turn(0, quote)],
      project,
      { profile: profileWith(obs), actionsVersion: 1 },
    ).map((r) => `${r.kind}:${r.ref}:${r.tier}`);

  it("a ported model URL and the observed #5 are one row (finding 1)", () => {
    expect(
      ground(
        "codehub.example/acme/api",
        "https://codehub.example:8443/acme/api/-/issues/5",
        "see https://codehub.example:8443/acme/api/-/issues/5 now",
        [{ ref: "#5", kind: "issue" }],
      ),
    ).toEqual(["issue:codehub.example/acme/api#5:observed"]);
  });

  it("a www. model URL and the observed #5 are one row (finding 2)", () => {
    expect(
      ground(
        "github.com/acme/api",
        "https://www.github.com/acme/api/issues/5",
        "see https://www.github.com/acme/api/issues/5 now",
        [{ ref: "#5", kind: "issue" }],
      ),
    ).toEqual(["issue:github.com/acme/api#5:observed"]);
  });

  it("a www. project identity grounds to the canonical host (re-check 2)", () => {
    expect(ground("www.github.com/acme/api", "#5", "working on #5 now", [{ ref: "#5", kind: "issue" }])).toEqual([
      "issue:github.com/acme/api#5:observed",
    ]);
  });

  it("a host-less model ref matched to an observed hosted ref stores the hosted spelling (finding 3)", () => {
    expect(
      ground("github.com/acme/api", "other/lib#5", "fix other/lib#5 now", [
        { ref: "github.com/other/lib#5", kind: "issue" },
      ]),
    ).toEqual(["issue:github.com/other/lib#5:observed"]);
  });
});

// W3 D9 (docs/design/observed-forge-refs.md §3): branches, commits and project identities.
describe("itemKeyResolver — D9 extension", () => {
  const show = (k: string) => k.replace("\u0000", " ");

  it("binds a host-less item through a single hosted project identity, never through two", () => {
    const one = itemKeyResolver([], { projectIdentities: ["codehub.example/acme/api"] });
    expect(show(one("acme/api#5", "issue"))).toBe("issue codehub.example/acme/api#5");
    const two = itemKeyResolver([], { projectIdentities: ["codehub.example/acme/api", "github.com/acme/api"] });
    expect(show(two("acme/api#5", "issue"))).toBe("issue acme/api#5");
    // Without the option the behaviour is unchanged.
    expect(show(itemKeyResolver([])("acme/api#5", "issue"))).toBe("issue acme/api#5");
  });

  it("keys branches and commits as [host/]owner/repo@name, binding a short sha to the one longer sha", () => {
    const keyOf = itemKeyResolver([
      { ref: "codehub.example/acme/api@a1b2c3d4e5", kind: "commit" },
      { ref: "codehub.example/acme/api@Fix-4", kind: "branch" },
    ]);
    expect(show(keyOf("acme/api@a1b2c3d", "commit"))).toBe("commit codehub.example/acme/api@a1b2c3d4e5");
    expect(show(keyOf("acme/api@Fix-4", "branch"))).toBe("branch codehub.example/acme/api@Fix-4");
    const ambiguous = itemKeyResolver([
      { ref: "acme/api@a1b2c3d4e5", kind: "commit" },
      { ref: "acme/api@a1b2c3d999", kind: "commit" },
    ]);
    expect(show(ambiguous("acme/api@a1b2c3d", "commit"))).toBe("commit acme/api@a1b2c3d");
  });
});
