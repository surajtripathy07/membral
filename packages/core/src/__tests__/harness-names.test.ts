import { describe, expect, it } from "vitest";
import { harnessDisplayName } from "../sessions/harness-names.js";

describe("harnessDisplayName", () => {
  it("maps every known harness id to its display name", () => {
    expect(harnessDisplayName("claude-code")).toBe("Claude Code");
    expect(harnessDisplayName("opencode")).toBe("opencode");
    expect(harnessDisplayName("copilot-cli")).toBe("Copilot CLI");
    expect(harnessDisplayName("codex")).toBe("Codex");
  });

  it("renders an unknown id as itself", () => {
    expect(harnessDisplayName("future-harness")).toBe("future-harness");
  });
});
