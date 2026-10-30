import { describe, expect, it } from "vitest";
import { isMembralHeadlessRunDir } from "../sessions/headless-runs.js";

describe("isMembralHeadlessRunDir", () => {
  it.each([
    "/private/var/folders/ab/cd1234/T/membral-claude-AbC123",
    "/var/folders/ab/cd1234/T/membral-lab-claude-XyZ9",
    "/tmp/membral-claude-a1B2c3/",
    "C:\\Users\\me\\AppData\\Local\\Temp\\membral-claude-Q9w8E7",
  ])("matches %s", (p) => {
    expect(isMembralHeadlessRunDir(p)).toBe(true);
  });

  it.each([
    "/Users/me/dev/membral-claude-AbC123",
    "/tmp/membral-claude-cli-AbC123",
    "/tmp/membral-claude-",
    "/tmp/membral-claude-AbC123/sub",
    "/tmp/other-project",
    "membral-claude-AbC123",
    "",
    null,
    undefined,
  ])("does not match %s", (p) => {
    expect(isMembralHeadlessRunDir(p as string | null | undefined)).toBe(false);
  });
});
