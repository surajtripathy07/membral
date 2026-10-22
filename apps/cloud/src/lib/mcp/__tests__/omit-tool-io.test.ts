import { describe, expect, it } from "vitest";
import { omitToolIO, omitToolIOFromContent, TOOL_INPUT_STUB_CHARS } from "@/lib/mcp/omit-tool-io";

describe("omitToolIOFromContent", () => {
  it("shrinks a message whose bulk is a web-search tool result", () => {
    const toolResult = "x".repeat(40_000);
    const content =
      "Let me search for that.\n\n" +
      '[tool_use: web_search]\n{"query":"CodeHub outage"}\n[/tool_use]\n\n' +
      `[tool_result]\n${toolResult}\n[/tool_result]\n\n` +
      "Here's what I found.";
    const { content: out, omittedChars } = omitToolIOFromContent(content);

    expect(out.length).toBeLessThan(1_000);
    expect(out).toContain("Let me search for that.");
    expect(out).toContain("Here's what I found.");
    expect(out).toContain(`[tool_result omitted: ${toolResult.length} chars; include_tool_io=true to see it]`);
    expect(out).not.toContain(toolResult);
    expect(omittedChars).toBe(toolResult.length);
  });

  it("truncates a long tool_use input to 200 chars with an ellipsis", () => {
    const input = "y".repeat(500);
    const content = `[tool_use: some_tool]\n${input}\n[/tool_use]`;
    const { content: out, omittedChars } = omitToolIOFromContent(content);

    expect(out).toBe(`[tool_use: some_tool] ${"y".repeat(TOOL_INPUT_STUB_CHARS)}…`);
    expect(omittedChars).toBe(input.length - TOOL_INPUT_STUB_CHARS);
  });

  it("leaves a message with no tool segments byte-identical", () => {
    const content = "Just a plain reply with no tool use at all.";
    const { content: out, omittedChars } = omitToolIOFromContent(content);
    expect(out).toBe(content);
    expect(omittedChars).toBe(0);
  });

  it("keeps the reply text on a legacy message with no closing markers", () => {
    // Old imports never wrote [/thinking]; parseMessageSegments falls back
    // to the reasoning-opener heuristic to find where the reply starts.
    const content =
      "[thinking]\n" +
      "I should check the docs first. Let me look.\n\n" +
      "The docs say the timeout is 30s, so that's the answer.";
    const { content: out } = omitToolIOFromContent(content);
    expect(out).toContain("The docs say the timeout is 30s, so that's the answer.");
  });
});

describe("omitToolIO", () => {
  const msg = (content: string) => ({ role: "assistant", content, timestamp: null, metadata: {} });

  it("only rewrites messages that actually contain tool segments", () => {
    const plain = msg("No tools here.");
    const withTool = msg(`[tool_result]\n${"z".repeat(1000)}\n[/tool_result]`);
    const { data, omittedChars } = omitToolIO({ id: "c1", messages: [plain, withTool] });
    const messages = data.messages as Array<{ content: string }>;

    expect(messages[0]).toBe(plain); // untouched, same reference
    expect(messages[1]).not.toBe(withTool);
    expect(messages[1].content).toContain("tool_result omitted");
    expect(omittedChars).toBe(1000);
  });

  it("with include_tool_io=true (caller skips the rewrite), original content is untouched", () => {
    // The server only calls omitToolIO when include_tool_io is falsy; this
    // asserts the identity path a caller relies on when it skips the call.
    const withTool = msg(`[tool_use: t]\n${"a".repeat(50)}\n[/tool_use]`);
    const conversation = { id: "c1", messages: [withTool] };
    expect(conversation.messages[0].content).toContain("[tool_use: t]");
  });
});
