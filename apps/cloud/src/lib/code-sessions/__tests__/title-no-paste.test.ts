// UX W6 review fix 3b: a session title never comes from pasted content — the
// owner's own words (stored `ownerText`, or the prompt with every
// <pasted_content> span stripped), else the summary.
import { describe, expect, it } from "vitest";
import { nonGitSessionTitle } from "../import";
import { firstLineTitle, sessionDisplayTitle, sessionPageTitle, titleSourceText } from "../view";

const PASTE =
  '<pasted_content id="c71c">## About this user\nCodeHub Person is interested in…</pasted_content id="c71c">';

describe("titleSourceText", () => {
  it("strips every paste span and keeps the owner's words", () => {
    expect(titleSourceText(`${PASTE}\nfix the billing retry`).trim()).toBe("fix the billing retry");
  });
  it("prefers the stored ownerText when given", () => {
    expect(titleSourceText(`${PASTE} x`, "the owner's words")).toBe("the owner's words");
  });
  it("drops everything after an unclosed paste tag", () => {
    expect(titleSourceText('look at this <pasted_content id="a">## About this user').trim()).toBe("look at this");
  });
  it("leaves paste-free text unchanged", () => {
    expect(titleSourceText("plain prompt")).toBe("plain prompt");
  });
});

describe("title paths never surface a paste", () => {
  it("firstLineTitle starts at the owner's words after a stripped paste", () => {
    expect(firstLineTitle(`${PASTE}\n\nfix the billing retry`)).toBe("fix the billing retry");
    expect(firstLineTitle(PASTE)).toBe("");
  });

  it("sessionDisplayTitle falls past a paste-only first prompt to Untitled, and prefers the summary", () => {
    expect(sessionDisplayTitle({ title: null, summary: null, firstUserMessage: PASTE })).toBe("Untitled session");
    expect(sessionDisplayTitle({ title: null, summary: "Fixed the retry", firstUserMessage: PASTE })).toBe(
      "Fixed the retry",
    );
    expect(sessionDisplayTitle({ title: PASTE, summary: "Fixed the retry" })).toBe("Fixed the retry");
  });

  it("sessionPageTitle ignores a stored title that is a paste", () => {
    const t = sessionPageTitle({
      title: PASTE,
      summary: "Fixed the retry",
      gitBranch: null,
      turnCount: 2,
      startedAt: null,
    });
    expect(t).toBe("Fixed the retry");
  });

  it("nonGitSessionTitle uses ownerText and skips a paste-only prompt", () => {
    const repo = { remoteUrl: null } as never;
    const title = nonGitSessionTitle({
      repo,
      turns: [
        { role: "user", kind: "prose", text: PASTE } as never,
        { role: "user", kind: "prose", text: `${PASTE} tidy the readme`, ownerText: " tidy the readme" } as never,
      ],
    });
    expect(title).toBe("tidy the readme");
    expect(title).not.toContain("About this user");
  });
});
