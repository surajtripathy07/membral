import { describe, expect, it } from "vitest";
import { AREA_STATUS, deriveAreaStatus, displayKind, displayLabel, isUnnamedLabel, summarySnippet } from "../palette";

describe("displayKind", () => {
  it("passes through a real kind", () => {
    expect(displayKind("project")).toBe("project");
    expect(displayKind("  goal  ")).toBe("goal");
  });

  it("guards the literal junk strings the extraction pipeline can emit (case-insensitive)", () => {
    expect(displayKind("null")).toBeNull();
    expect(displayKind("Null")).toBeNull();
    expect(displayKind("NONE")).toBeNull();
    expect(displayKind("undefined")).toBeNull();
  });

  it("guards empty/whitespace and nullish input", () => {
    expect(displayKind("")).toBeNull();
    expect(displayKind("   ")).toBeNull();
    expect(displayKind(null)).toBeNull();
    expect(displayKind(undefined)).toBeNull();
  });
});

describe("displayLabel (issue #79)", () => {
  it("passes through a real label, trimmed", () => {
    expect(displayLabel("Career")).toBe("Career");
    expect(displayLabel("  Side Projects  ")).toBe("Side Projects");
  });

  it("substitutes the fallback for the literal junk strings the pipeline can emit (case-insensitive)", () => {
    expect(displayLabel("null")).toBe("Unnamed");
    expect(displayLabel("Null")).toBe("Unnamed");
    expect(displayLabel("NONE")).toBe("Unnamed");
    expect(displayLabel("undefined")).toBe("Unnamed");
  });

  it("substitutes the fallback for empty/whitespace and nullish input", () => {
    expect(displayLabel("")).toBe("Unnamed");
    expect(displayLabel("   ")).toBe("Unnamed");
    expect(displayLabel(null)).toBe("Unnamed");
    expect(displayLabel(undefined)).toBe("Unnamed");
  });

  it("accepts a caller-supplied fallback (e.g. the observed founder-1k LifeArea case)", () => {
    expect(displayLabel("null", "Unnamed area")).toBe("Unnamed area");
    expect(displayLabel(null, "Unnamed item")).toBe("Unnamed item");
  });

  it("never renders the literal word null even for a real label that happens to contain it as a substring", () => {
    // "null" as the WHOLE label is junk; "Null Island" is a real label and must survive.
    expect(displayLabel("Null Island")).toBe("Null Island");
  });
});

describe("isUnnamedLabel", () => {
  it("agrees with displayLabel's substitution decision", () => {
    expect(isUnnamedLabel("null")).toBe(true);
    expect(isUnnamedLabel("")).toBe(true);
    expect(isUnnamedLabel(null)).toBe(true);
    expect(isUnnamedLabel("Career")).toBe(false);
  });
});

describe("summarySnippet (issue #89 — Person 'who this is' subtitle)", () => {
  it("returns short text unchanged", () => {
    expect(summarySnippet("A close collaborator on the roadmap.")).toBe("A close collaborator on the roadmap.");
  });
  it("returns empty string for null/undefined/blank", () => {
    expect(summarySnippet(null)).toBe("");
    expect(summarySnippet(undefined)).toBe("");
    expect(summarySnippet("   ")).toBe("");
  });
  it("truncates long text at a word boundary with an ellipsis, never mid-word", () => {
    const long =
      "A frequent collaborator you brainstorm product direction with, most recently about the onboarding redesign and pricing experiments.";
    const snippet = summarySnippet(long, 60);
    expect(snippet.length).toBeLessThanOrEqual(61); // 60 + ellipsis
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.slice(0, -1).endsWith(" ")).toBe(false); // no trailing space before the ellipsis
    expect(long.startsWith(snippet.slice(0, -1))).toBe(true); // a clean prefix, not a mangled cut
  });
  it("hard-cuts when there is no reasonable word boundary near the limit", () => {
    const noSpaces = "x".repeat(200);
    const snippet = summarySnippet(noSpaces, 50);
    expect(snippet).toBe(`${"x".repeat(50)}…`);
  });
});

describe("deriveAreaStatus — empty-seeded areas (issue #82 Part B)", () => {
  it("surfaces a user-seeded area with zero conversations as 'Awaiting content'", () => {
    expect(deriveAreaStatus({ convs: 0, lastTouchedIso: null, isEmptySeeded: true })).toBe(AREA_STATUS.awaitingContent);
  });

  it("isDuplicate still takes precedence over isEmptySeeded", () => {
    expect(deriveAreaStatus({ convs: 0, lastTouchedIso: null, isEmptySeeded: true, isDuplicate: true })).toBe(
      AREA_STATUS.duplicate,
    );
  });

  it("falls through to the normal derivation once an empty-seeded area gathers conversations", () => {
    expect(deriveAreaStatus({ convs: 3, lastTouchedIso: null, isEmptySeeded: true })).toBe(AREA_STATUS.curious);
  });

  it("isEmptySeeded is a no-op when false/absent", () => {
    expect(deriveAreaStatus({ convs: 0, lastTouchedIso: null, isEmptySeeded: false })).toBe(AREA_STATUS.curious);
    expect(deriveAreaStatus({ convs: 0, lastTouchedIso: null })).toBe(AREA_STATUS.curious);
  });
});
