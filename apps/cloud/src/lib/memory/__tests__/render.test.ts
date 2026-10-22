import { describe, expect, it } from "vitest";
import {
  detectOutcomeHints,
  isOffRepoStrict,
  renderSessionHeader,
  renderTurnLines,
  type TurnRow,
  topToolCounts,
} from "../render";

function turn(overrides: Partial<TurnRow> & Pick<TurnRow, "idx" | "role" | "kind">): TurnRow {
  return { text: null, tool_name: null, file_path: null, ts: null, props: null, ...overrides };
}

describe("renderTurnLines", () => {
  it("drops thinking turns entirely", () => {
    const turns: TurnRow[] = [
      turn({ idx: 0, role: "assistant", kind: "thinking", text: "pondering..." }),
      turn({ idx: 1, role: "user", kind: "prose", text: "hello" }),
    ];
    const lines = renderTurnLines(turns);
    expect(lines).toHaveLength(1);
    expect(lines[0].idx).toBe(1);
  });

  it("collapses tool_use to [tool: Name path]", () => {
    const turns: TurnRow[] = [
      turn({ idx: 2, role: "assistant", kind: "tool_use", tool_name: "Edit", file_path: "apps/x.ts" }),
    ];
    const [line] = renderTurnLines(turns);
    expect(line.line).toContain("[tool: Edit apps/x.ts]");
    expect(line.isProse).toBe(false);
  });

  it("renders a Write/Edit turn's written text on the lines under its tag", () => {
    const turns: TurnRow[] = [
      turn({
        idx: 3,
        role: "assistant",
        kind: "tool_use",
        tool_name: "Write",
        file_path: "docs/notes/cache.md",
        text: "Ruling: keep the cache TTL at 300 s.\nDo not lower it.",
      }),
    ];
    const [line] = renderTurnLines(turns);
    expect(line.line).toBe(
      "[#3 assistant tool_use] [tool: Write docs/notes/cache.md]\nRuling: keep the cache TTL at 300 s.\nDo not lower it.",
    );
    expect(line.isProse).toBe(false);
  });

  it("renders a tool_use turn with no text as the bare tag", () => {
    const [line] = renderTurnLines([
      turn({ idx: 4, role: "assistant", kind: "tool_use", tool_name: "Read", file_path: "a.ts" }),
    ]);
    expect(line.line).toBe("[#4 assistant tool_use] [tool: Read a.ts]");
  });

  it("renders prose verbatim for both roles", () => {
    const turns: TurnRow[] = [
      turn({ idx: 0, role: "user", kind: "prose", text: "fix the flaky test" }),
      turn({ idx: 1, role: "assistant", kind: "prose", text: "done, switched retries" }),
    ];
    const lines = renderTurnLines(turns);
    expect(lines[0].line).toContain("fix the flaky test");
    expect(lines[0].isProse).toBe(true);
    expect(lines[1].line).toContain("done, switched retries");
    expect(lines[1].isProse).toBe(true);
  });

  it("renders an already-elided tool_result as-is", () => {
    const turns: TurnRow[] = [turn({ idx: 3, role: "user", kind: "tool_result", text: "[tool_result elided: ok]" })];
    const [line] = renderTurnLines(turns);
    expect(line.line).toContain("[tool_result elided: ok]");
    expect(line.isProse).toBe(false);
  });
});

describe("topToolCounts", () => {
  it("counts tool_use turns by tool name, descending", () => {
    const turns: TurnRow[] = [
      turn({ idx: 0, role: "assistant", kind: "tool_use", tool_name: "Edit" }),
      turn({ idx: 1, role: "assistant", kind: "tool_use", tool_name: "Bash" }),
      turn({ idx: 2, role: "assistant", kind: "tool_use", tool_name: "Edit" }),
    ];
    expect(topToolCounts(turns)).toEqual([
      ["Edit", 2],
      ["Bash", 1],
    ]);
  });
});

describe("detectOutcomeHints", () => {
  it("detects a git push as a branch outcome hint", () => {
    const turns: TurnRow[] = [
      turn({
        idx: 5,
        role: "assistant",
        kind: "tool_use",
        tool_name: "Bash",
        props: { inputDigest: "git push origin main" },
      }),
    ];
    const hints = detectOutcomeHints(turns);
    expect(hints.some((h) => h.ref_kind === "branch" && h.turn_idx === 5)).toBe(true);
  });

  it("detects an mcp call as a generic outcome hint", () => {
    const turns: TurnRow[] = [
      turn({
        idx: 7,
        role: "assistant",
        kind: "tool_use",
        tool_name: "mcp__gmail__send",
        props: { mcpServer: "gmail", mcpTool: "send" },
      }),
    ];
    const hints = detectOutcomeHints(turns);
    expect(hints.some((h) => h.ref_kind === "other" && h.turn_idx === 7)).toBe(true);
  });

  it("returns no hints for a session with no forge/mcp calls", () => {
    const turns: TurnRow[] = [turn({ idx: 0, role: "user", kind: "prose", text: "hi" })];
    expect(detectOutcomeHints(turns)).toEqual([]);
  });
});

describe("renderSessionHeader", () => {
  it("includes repo/branch, usage and a delivered block", () => {
    const header = renderSessionHeader(
      {
        id: "s1",
        user_id: "u1",
        code_project_id: "p1",
        source: "claude-code",
        source_session_id: "s1",
        git_branch: "main",
        model: "claude-sonnet-5",
        started_at: "2026-01-01T00:00:00Z",
        ended_at: "2026-01-01T01:00:00Z",
        duration_seconds: 3600,
        files_touched: ["apps/x.ts"],
        props: { usage: { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
        project_display_name: "membral-personal",
      },
      [turn({ idx: 0, role: "user", kind: "prose", text: "hi" })],
    );
    expect(header.text).toContain("membral-personal");
    expect(header.text).toContain("main");
    expect(header.text).toContain("Usage:");
    expect(header.text).toContain("Delivered");
    expect(header.offRepoStrict).toBe(false); // files_touched is non-empty
  });

  it("flags offRepoStrict when files_touched is empty and prose names no path", () => {
    const header = renderSessionHeader(
      {
        id: "s1",
        user_id: "u1",
        code_project_id: "p1",
        source: "claude-code",
        source_session_id: "s1",
        git_branch: "main",
        model: "claude-sonnet-5",
        started_at: null,
        ended_at: null,
        duration_seconds: null,
        files_touched: [],
        props: null,
        project_display_name: "membral-personal",
      },
      [turn({ idx: 0, role: "user", kind: "prose", text: "should I take the FD ruling into account?" })],
    );
    expect(header.offRepoStrict).toBe(true);
  });
});

describe("isOffRepoStrict", () => {
  it("is false when files_touched is non-empty", () => {
    expect(isOffRepoStrict(["apps/x.ts"], [])).toBe(false);
  });

  it("is false when prose names a repo-relative path, even with no files_touched", () => {
    const turns: TurnRow[] = [turn({ idx: 0, role: "user", kind: "prose", text: "look at apps/cloud/src/foo.ts" })];
    expect(isOffRepoStrict([], turns)).toBe(false);
  });

  it("is true when files_touched is empty and no prose names a path", () => {
    const turns: TurnRow[] = [turn({ idx: 0, role: "user", kind: "prose", text: "what should I tell my advisor" })];
    expect(isOffRepoStrict([], turns)).toBe(true);
  });

  it("is true for a session with no turns at all", () => {
    expect(isOffRepoStrict([], [])).toBe(true);
  });
});
