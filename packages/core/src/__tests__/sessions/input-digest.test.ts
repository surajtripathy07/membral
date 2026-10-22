// R3 3.7 (#208): both parsers' tool-input digest, pinned as a table so the
// shared helper is provably byte-identical to the two copies it replaced.
import { describe, expect, it } from "vitest";
import { INPUT_DIGEST_CONFIG as CC_CONFIG } from "../../sessions/claude-code.js";
import { INPUT_DIGEST_CONFIG as CP_CONFIG } from "../../sessions/copilot-cli.js";
import { MAX_DIGEST_CHARS } from "../../sessions/forge-actions.js";
import { buildInputDigest } from "../../sessions/input-digest.js";
import { INPUT_DIGEST_CONFIG as OC_CONFIG } from "../../sessions/opencode.js";

const copilotCli = (t: string, i: Record<string, unknown> | undefined) => buildInputDigest(CP_CONFIG, t, i);
const claudeCode = (t: string, i: Record<string, unknown> | undefined) => buildInputDigest(CC_CONFIG, t, i);
const opencode = (t: string, i: Record<string, unknown> | undefined) => buildInputDigest(OC_CONFIG, t, i);

type In = Record<string, unknown> | undefined;
const long = "x".repeat(MAX_DIGEST_CHARS + 50);

// [label, toolName, input, claude-code expected, opencode expected, copilot-cli expected]
const cases: Array<[string, string, In, string | undefined, string | undefined, string | undefined]> = [
  ["no input", "Bash", undefined, undefined, undefined, undefined],
  ["bash gh command (CC name)", "Bash", { command: "gh pr list" }, "gh pr list", undefined, undefined],
  ["bash gh command (lowercase)", "bash", { command: "gh pr list" }, "gh pr list", "gh pr list", "gh pr list"],
  ["bash non-forge command", "bash", { command: "ls -la" }, undefined, undefined, undefined],
  ["bash missing command", "bash", {}, undefined, undefined, undefined],
  ["Agent description", "Agent", { description: "do it", prompt: "p" }, "do it", undefined, undefined],
  ["Task prompt fallback", "Task", { prompt: "the prompt" }, "the prompt", undefined, undefined],
  ["task (opencode name) description", "task", { description: "do it" }, undefined, "do it", "do it"],
  ["task prompt fallback", "task", { prompt: "the prompt" }, undefined, "the prompt", "the prompt"],
  ["Agent no desc/prompt", "Agent", { other: 1 }, undefined, undefined, undefined],
  ["Agent description capped", "Agent", { description: long }, "x".repeat(MAX_DIGEST_CHARS), undefined, undefined],
  [
    "task description capped",
    "task",
    { description: long },
    undefined,
    "x".repeat(MAX_DIGEST_CHARS),
    "x".repeat(MAX_DIGEST_CHARS),
  ],
  ["Agent secret redacted", "Agent", { description: "token=abc123secretvalue" }, undefined, undefined, undefined],
  ["WebFetch url", "WebFetch", { url: "https://example.com/a" }, "https://example.com/a", undefined, undefined],
  ["webfetch url", "webfetch", { url: "https://example.com/a" }, undefined, "https://example.com/a", undefined],
  ["WebFetch non-string url", "WebFetch", { url: 5 }, undefined, undefined, undefined],
  ["powershell gh command", "powershell", { command: "gh pr list" }, undefined, undefined, "gh pr list"],
  ["shell gh command", "shell", { command: "gh pr list" }, undefined, undefined, "gh pr list"],
  ["task empty description falls to prompt", "task", { description: "", prompt: "p" }, undefined, undefined, "p"],
  ["Task empty description (no fallback)", "Task", { description: "", prompt: "p" }, undefined, undefined, undefined],
  ["unknown tool", "Read", { file_path: "/a" }, undefined, undefined, undefined],
];

describe("buildInputDigest (claude-code vs opencode)", () => {
  it.each(cases)("%s", (_label, tool, input, cc, oc, cp) => {
    if (_label === "Agent secret redacted") {
      const out = claudeCode(tool, input);
      expect(out).toBeDefined();
      expect(out).not.toContain("abc123secretvalue");
      expect(copilotCli("task", input)).not.toContain("abc123secretvalue");
      return;
    }
    expect(claudeCode(tool, input)).toBe(cc);
    expect(opencode(tool, input)).toBe(oc);
    expect(copilotCli(tool, input)).toBe(cp);
  });
});
