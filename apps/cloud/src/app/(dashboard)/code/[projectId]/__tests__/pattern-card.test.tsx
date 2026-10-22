// Goal 2026-09-26 P9 / W10 — the project page's "draft a skill?" card.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { StoredPattern } from "@/lib/patterns/storage";
import { PatternCard } from "../pattern-card";

const pattern: StoredPattern = {
  key: "npm test → Edit ts → git commit",
  steps: ["npm test", "Edit ts", "git commit"],
  sessionCount: 9,
  sessionIds: ["s1"],
  lastSeenAt: "2026-09-24T10:00:00Z",
  minedAt: "2026-09-26T03:00:00Z",
  draft: {
    name: "test-edit-commit",
    description: "Run the tests, fix, commit.",
    steps: ["Run `npm test`", "Edit the .ts files", "Run `git commit`"],
    source: "heuristic",
    draftedAt: "2026-09-26T03:00:00Z",
    sources: [],
  },
};

describe("PatternCard", () => {
  it("the card renders the drafted skill and the count", () => {
    const html = renderToStaticMarkup(<PatternCard patterns={[pattern]} now="2026-09-26T12:00:00Z" />);
    expect(html).toContain("npm test");
    expect(html).toContain("Edit ts");
    expect(html).toContain("git commit");
    expect(html).toContain("9 sessions");
    expect(html).toContain("last 2d ago");
    expect(html).toContain("draft a skill?");
    expect(html).toContain("Show draft: test-edit-commit");
    // F12: the disclosure says whether it is open.
    expect(html).toMatch(/aria-expanded="false"[^>]*>Show draft/);
    expect(html).toContain("Copy SKILL.md");
    expect(html).toContain("Membral installs nothing");
  });

  it("renders nothing without patterns", () => {
    expect(renderToStaticMarkup(<PatternCard patterns={[]} now="2026-09-26T12:00:00Z" />)).toBe("");
  });

  it("uses tokens only — no raw gray utilities", () => {
    const html = renderToStaticMarkup(<PatternCard patterns={[pattern]} now="2026-09-26T12:00:00Z" />);
    expect(html).not.toMatch(/(bg|text|border)-(gray|slate|zinc|neutral)-\d+/);
  });
});
