// C-9: five non-git sessions in scratch-cwd/notes all read "scratch-cwd/notes · HEAD · 2026-09-26".
// A session with no git remote is titled by its first prompt line instead.
import { describe, expect, it } from "vitest";
import { nonGitSessionTitle } from "../import";

type Turn = { role: "user" | "assistant"; kind: "prose" | "tool_use" | "tool_result"; text?: string };
const session = (turns: Turn[], remoteUrl?: string) =>
  ({ repo: { path: "/private/tmp/scratch-cwd/notes", branch: "HEAD", remoteUrl }, turns }) as unknown as Parameters<
    typeof nonGitSessionTitle
  >[0];

describe("nonGitSessionTitle", () => {
  it("uses the first real user prompt's first line, skipping tool results", () => {
    const title = nonGitSessionTitle(
      session([
        { role: "user", kind: "tool_result", text: "[tool_result elided: ok]" },
        { role: "user", kind: "prose", text: "jot down three podcast names for a show about debugging\nthen pick one" },
        { role: "assistant", kind: "prose", text: "Here are three" },
      ]),
    );
    expect(title).toBe("jot down three podcast names for a show about debugging");
  });

  it("two sessions in the same dir get distinct titles", () => {
    const a = nonGitSessionTitle(session([{ role: "user", kind: "prose", text: "check my inbox" }]));
    const b = nonGitSessionTitle(session([{ role: "user", kind: "prose", text: "summarise my notes" }]));
    expect(a).not.toBe(b);
  });

  it("a git-remote session keeps a null title, and a session with no prompt stays null", () => {
    expect(
      nonGitSessionTitle(session([{ role: "user", kind: "prose", text: "fix #5" }], "https://codehub.example/a/b.git")),
    ).toBeNull();
    expect(nonGitSessionTitle(session([]))).toBeNull();
  });
});
