import { describe, expect, it } from "vitest";
import { compactRefLabel } from "@/app/(dashboard)/code/stats/issues/issues-content.logic";
import { threadRefLabel } from "@/lib/threads/view";
import { forgeUrl, glabFamilyOf } from "../forge-url";
import { refLabel } from "../ref-label";

// R3 3.4 (D-065, #169): Today and Issues share one ref-label rule. Today's
// threads carry `forge_family` (open-threads.ts: glabFamilyOf over the glab
// hosts its data proves); Issues passes the route's `glab_hosts`. Same refs,
// same glab hosts -> same label in both views, and the label is short exactly
// when the chip links.

const GLAB_HOSTS = ["codehub.com", "git.acme.corp"];
const glabSet = new Set(GLAB_HOSTS);

const REFS: Array<{ label: string; ref: string; kind: "issue" | "merge_request"; expected: string }> = [
  { label: "github.com issue", ref: "github.com/acme/api#5", kind: "issue", expected: "#5" },
  { label: "github.com pull request", ref: "github.com/acme/api#12", kind: "merge_request", expected: "#12" },
  { label: "glab-family hosted issue", ref: "codehub.com/acme/billing#7", kind: "issue", expected: "#7" },
  { label: "glab-family hosted MR", ref: "codehub.com/acme/billing#17049", kind: "merge_request", expected: "!17049" },
  {
    label: "glab-family self-hosted MR (nested group)",
    ref: "git.acme.corp/platform/infra/deploy#31",
    kind: "merge_request",
    expected: "!31",
  },
  { label: "other host issue", ref: "forge.unknown.example/acme/api#5", kind: "issue", expected: "acme/api#5" },
  { label: "other host MR", ref: "github.acme.corp/acme/api#9", kind: "merge_request", expected: "acme/api!9" },
  // A glab-family host the data does not prove (not in glabHosts): unknown family, MR keeps `!`.
  {
    label: "glab MR whose host is not in glabHosts",
    ref: "codehub.example/g/p#5",
    kind: "merge_request",
    expected: "g/p!5",
  },
  { label: "host-less MR", ref: "acme/api#5", kind: "merge_request", expected: "acme/api!5" },
  { label: "host-less ref", ref: "acme/api#5", kind: "issue", expected: "acme/api#5" },
];

describe("refLabel: the D-065 table", () => {
  for (const r of REFS) {
    it(r.label, () => {
      expect(refLabel(r.ref, { kind: r.kind, glabHosts: GLAB_HOSTS })).toBe(r.expected);
    });
  }

  it("a spelling that is not ref syntax comes back as written", () => {
    expect(refLabel("#12", { kind: "issue" })).toBe("#12");
    expect(refLabel("no-number-here", { kind: "issue" })).toBe("no-number-here");
  });
});

describe("Today and Issues produce the same label for the same ref set", () => {
  for (const r of REFS) {
    it(r.label, () => {
      const today = threadRefLabel({ ref: r.ref, refKind: r.kind, forge_family: glabFamilyOf(r.ref, glabSet) });
      const issues = compactRefLabel(r.ref, r.kind, GLAB_HOSTS);
      expect(today).toBe(r.expected);
      expect(issues).toBe(today);
    });
  }
});

describe("chip text and link come from the same host check", () => {
  for (const r of REFS) {
    it(r.label, () => {
      const href = forgeUrl(r.ref, { kind: r.kind, glabHosts: GLAB_HOSTS });
      const qualified = refLabel(r.ref, { kind: r.kind, glabHosts: GLAB_HOSTS }).includes("/");
      // A short label exactly when the chip links; a qualified label exactly when it does not.
      expect(href === null).toBe(qualified);
    });
  }
});

describe("ADV: ported and www. hosts (keys port-less; links keep the ref's own port)", () => {
  it("a ported glab ref labels short and links WITH its port (finding 1, re-check 1)", () => {
    const opts = { kind: "merge_request" as const, glabHosts: ["codehub.example:8443"] };
    expect(refLabel("codehub.example:8443/g/p!5", opts)).toBe("!5");
    expect(forgeUrl("codehub.example:8443/g/p!5", opts)).toBe("https://codehub.example:8443/g/p/-/merge_requests/5");
    expect(forgeUrl("https://codehub.example:8443/g/p/-/merge_requests/5", opts)).toBe(
      "https://codehub.example:8443/g/p/-/merge_requests/5",
    );
    // The glab host proven port-less still matches the ported spelling, and vice versa.
    expect(forgeUrl("codehub.example:8443/g/p!5", { kind: "merge_request", glabHosts: ["codehub.example"] })).toBe(
      "https://codehub.example:8443/g/p/-/merge_requests/5",
    );
  });
  it("www.github.com is github.com (finding 2)", () => {
    expect(refLabel("www.github.com/o/r#5")).toBe("#5");
    expect(forgeUrl("www.github.com/o/r#5")).toBe("https://github.com/o/r/issues/5");
  });
  it("glab hosts proven from a ported URL match the port-less ref", () => {
    expect(glabFamilyOf("codehub.example/o/r#5", new Set(["codehub.example:8443"]))).toBe("gitlab");
  });
});

describe("the glab family's hosted .com counts by name, like github.com (re-check 3)", () => {
  it("labels short and links with no glabHosts", () => {
    expect(refLabel("gitlab.com/g/p#5", { kind: "merge_request" })).toBe("!5");
    expect(refLabel("gitlab.com/g/p#6", { kind: "issue" })).toBe("#6");
    expect(forgeUrl("gitlab.com/g/p#5", { kind: "merge_request" })).toBe("https://gitlab.com/g/p/-/merge_requests/5");
    expect(glabFamilyOf("gitlab.com/g/p#5", new Set())).toBe("gitlab");
  });
  it("Today and Issues agree on it", () => {
    const ref = "gitlab.com/acme/billing#3";
    expect(threadRefLabel({ ref, refKind: "merge_request", forge_family: glabFamilyOf(ref, new Set()) })).toBe("!3");
    expect(compactRefLabel(ref, "merge_request", [])).toBe("!3");
  });
  it("a self-hosted glab host still needs proof", () => {
    expect(refLabel("git.acme.corp/g/p#5", { kind: "merge_request" })).toBe("g/p!5");
    expect(forgeUrl("git.acme.corp/g/p#5", { kind: "merge_request" })).toBeNull();
  });
});
