import { describe, expect, it } from "vitest";
import { extractMessages } from "../providers/claude.js";

describe("Claude extractMessages", () => {
  it("extracts plain text blocks", () => {
    const raw = {
      chat_messages: [
        { sender: "human", content: [{ type: "text", text: "Hello" }], uuid: "u1", created_at: "2024-01-01" },
        { sender: "assistant", content: [{ type: "text", text: "Hi there" }], uuid: "a1", created_at: "2024-01-02" },
      ],
    };
    const out = extractMessages(raw);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ role: "user", content: "Hello" });
    expect(out[1]).toMatchObject({ role: "assistant", content: "Hi there" });
  });

  it("preserves artifact tool_use blocks", () => {
    const raw = {
      chat_messages: [
        {
          sender: "assistant",
          uuid: "a1",
          created_at: "2024-01-01",
          content: [
            { type: "text", text: "I'll create a doc for you." },
            {
              type: "tool_use",
              name: "artifacts",
              input: {
                command: "create",
                type: "text/markdown",
                title: "Project brief",
                content: "# Project Brief\n\nFull body here.",
              },
            },
          ],
        },
      ],
    };
    const out = extractMessages(raw);
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain("I'll create a doc for you.");
    expect(out[0].content).toContain("[artifact: text/markdown — Project brief]");
    expect(out[0].content).toContain("# Project Brief");
    expect(out[0].content).toContain("Full body here.");
  });

  it("falls back to JSON for unknown block types", () => {
    const raw = {
      chat_messages: [
        {
          sender: "assistant",
          uuid: "a1",
          content: [{ type: "mystery_block", payload: { foo: "bar" } }],
        },
      ],
    };
    const out = extractMessages(raw);
    expect(out).toHaveLength(1);
    expect(out[0].content).toContain("[mystery_block]");
    expect(out[0].content).toContain("foo");
  });

  it("renders a code-language artifact in a fenced block", () => {
    const raw = {
      chat_messages: [
        {
          sender: "assistant",
          uuid: "a1",
          content: [
            {
              type: "tool_use",
              name: "artifacts",
              input: {
                type: "application/vnd.ant.code",
                language: "ts",
                title: "snippet",
                content: "const x: number = 1;\nconsole.log(x);",
              },
            },
          ],
        },
      ],
    };
    const out = extractMessages(raw);
    expect(out[0].content).toContain("```ts");
    expect(out[0].content).toContain("console.log(x);");
    expect(out[0].content).toContain("```");
  });

  it("handles thinking blocks", () => {
    const raw = {
      chat_messages: [
        {
          sender: "assistant",
          uuid: "a1",
          content: [
            { type: "thinking", thinking: "let me reason about this..." },
            { type: "text", text: "Here's the answer." },
          ],
        },
      ],
    };
    const out = extractMessages(raw);
    expect(out[0].content).toContain("[thinking]");
    expect(out[0].content).toContain("let me reason about this");
    expect(out[0].content).toContain("Here's the answer.");
  });

  it("hoists create_file tool body into a labelled artifact block", () => {
    const raw = {
      chat_messages: [
        {
          sender: "assistant",
          uuid: "a1",
          content: [
            { type: "text", text: "Here's the doc." },
            {
              type: "tool_use",
              name: "create_file",
              input: {
                description: "Planning writeup",
                path: "/mnt/user-data/outputs/plan.md",
                file_text: "# Plan\n\nSection body.",
              },
            },
          ],
        },
      ],
    };
    const out = extractMessages(raw);
    expect(out).toHaveLength(1);
    const c = out[0].content;
    expect(c).toContain("Here's the doc.");
    expect(c).toContain("[artifact: create_file");
    expect(c).toContain("/mnt/user-data/outputs/plan.md");
    expect(c).toContain("```md");
    expect(c).toContain("# Plan");
    expect(c).toContain("Section body.");
  });

  it("ignores messages with empty content", () => {
    const raw = {
      chat_messages: [
        { sender: "assistant", uuid: "a1", content: [] },
        { sender: "human", uuid: "u1", content: [{ type: "text", text: "valid" }] },
      ],
    };
    const out = extractMessages(raw);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });
});
