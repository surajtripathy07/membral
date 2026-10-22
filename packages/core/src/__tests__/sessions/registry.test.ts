import { describe, expect, it } from "vitest";
import { agyParser } from "../../sessions/agy.js";
import { claudeCodeParser } from "../../sessions/claude-code.js";
import { codexParser } from "../../sessions/codex.js";
import { copilotCliParser } from "../../sessions/copilot-cli.js";
import { opencodeParser } from "../../sessions/opencode.js";
import { HARNESS_IDS, PARSERS } from "../../sessions/registry.js";

describe("harness registry", () => {
  it("keeps the default import order: claude-code first", () => {
    expect(Object.keys(PARSERS)).toEqual(["claude-code", "opencode", "copilot-cli", "codex", "agy"]);
    expect(HARNESS_IDS).toEqual(Object.keys(PARSERS));
  });

  it("maps each harness id to the existing parser object", () => {
    expect(PARSERS["claude-code"]).toBe(claudeCodeParser);
    expect(PARSERS.opencode).toBe(opencodeParser);
    expect(PARSERS["copilot-cli"]).toBe(copilotCliParser);
    expect(PARSERS.codex).toBe(codexParser);
    expect(PARSERS.agy).toBe(agyParser);
  });

  it("wires agy as its own harness id", () => {
    expect(HARNESS_IDS).toContain("agy");
    expect(PARSERS.agy.source).toBe("agy");
  });
});
