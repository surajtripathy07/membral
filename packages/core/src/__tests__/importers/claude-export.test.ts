import { describe, expect, it } from "vitest";
import { extractMessages, parseClaudeExport } from "../../importers/claude-export.js";

function wellFormedExport() {
  return {
    uuid: "conv-1",
    name: "Planning chat",
    created_at: "2024-01-01T00:00:00.000Z",
    updated_at: "2024-01-02T00:00:00.000Z",
    chat_messages: [
      {
        uuid: "m1",
        sender: "human",
        created_at: "2024-01-01T00:00:00.000Z",
        content: [{ type: "text", text: "Hello" }],
      },
      {
        uuid: "m2",
        sender: "assistant",
        created_at: "2024-01-01T00:01:00.000Z",
        content: [{ type: "text", text: "Hi there" }],
      },
    ],
  };
}

describe("extractMessages", () => {
  it("prefers content[] blocks when present", () => {
    const out = extractMessages({
      chat_messages: [{ sender: "human", content: [{ type: "text", text: "from content[]" }], text: "from text" }],
    });
    expect(out[0].content).toBe("from content[]");
  });

  it("falls back to the plain text field when content[] is absent", () => {
    const out = extractMessages({
      chat_messages: [{ sender: "assistant", text: "plain text only" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("plain text only");
  });

  it("maps sender human/assistant to role user/assistant", () => {
    const out = extractMessages(wellFormedExport());
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("renders an unknown block type as a JSON-tagged marker rather than dropping it", () => {
    const out = extractMessages({
      chat_messages: [{ sender: "assistant", content: [{ type: "some_future_block", payload: { x: 1 } }] }],
    });
    expect(out[0].content).toContain("[some_future_block]");
    expect(out[0].content).toContain('"x":1');
    expect(out[0].content).toContain("[/some_future_block]");
  });

  it("emits an explicit closing marker per non-text block so a renderer never has to guess a block's end", () => {
    const out = extractMessages({
      chat_messages: [
        {
          sender: "assistant",
          content: [
            { type: "thinking", thinking: "weighing options" },
            { type: "tool_use", name: "web_search", input: { query: "codehub" } },
            { type: "tool_result", content: "search done" },
          ],
        },
      ],
    });
    const content = out[0].content;
    expect(content).toContain("[thinking]\nweighing options\n[/thinking]");
    expect(content).toContain('[tool_use: web_search]\n{"query":"codehub"}\n[/tool_use]');
    expect(content).toContain("[tool_result]\nsearch done\n[/tool_result]");
    // Opening format is unchanged, so old parsing (matching just the opening
    // "[tag]"/"[tag: detail]" line) still matches.
    expect(content).toMatch(/^\[thinking\]\n/);
  });

  it("hoists an artifact tool_use block's body", () => {
    const out = extractMessages({
      chat_messages: [
        {
          sender: "assistant",
          content: [
            {
              type: "tool_use",
              name: "artifacts",
              input: { type: "text/markdown", title: "Notes", content: "# Notes\nBody." },
            },
          ],
        },
      ],
    });
    expect(out[0].content).toContain("[artifact: text/markdown — Notes]");
    expect(out[0].content).toContain("# Notes");
  });

  it("returns an empty array for a missing/malformed chat_messages field, never throws", () => {
    expect(extractMessages({})).toEqual([]);
    expect(extractMessages({ chat_messages: "not an array" })).toEqual([]);
    expect(extractMessages(null)).toEqual([]);
    expect(extractMessages(42)).toEqual([]);
  });

  it("skips individual messages with empty/no content but keeps the rest", () => {
    const out = extractMessages({
      chat_messages: [
        { sender: "assistant", content: [] },
        { sender: "human", content: [{ type: "text", text: "valid" }] },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe("user");
  });

  it("tolerates a non-object entry inside chat_messages", () => {
    const out = extractMessages({ chat_messages: [null, 42, { sender: "human", text: "ok" }] });
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe("ok");
  });
});

describe("parseClaudeExport", () => {
  it("parses a well-formed export array into normalized conversations", () => {
    const { conversations, skipped } = parseClaudeExport([wellFormedExport()]);
    expect(skipped).toEqual([]);
    expect(conversations).toHaveLength(1);
    const conv = conversations[0];
    expect(conv.source).toBe("claude");
    expect(conv.source_id).toBe("conv-1");
    expect(conv.title).toBe("Planning chat");
    expect(conv.messages.map((m) => m.content)).toEqual(["Hello", "Hi there"]);
    expect(conv.created_at).toBe("2024-01-01T00:00:00.000Z");
  });

  it("skips malformed entries instead of throwing, and keeps parsing the rest", () => {
    const good = wellFormedExport();
    const { conversations, skipped } = parseClaudeExport([null, { name: "no uuid" }, good, { uuid: "" }]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].source_id).toBe("conv-1");
    expect(skipped).toHaveLength(3);
    expect(skipped.map((s) => s.reason)).toEqual(["entry is not an object", "missing uuid", "missing uuid"]);
  });

  it("returns an empty result with a skip note when the root is not an array", () => {
    const { conversations, skipped } = parseClaudeExport({ chat_messages: [] });
    expect(conversations).toEqual([]);
    expect(skipped).toEqual([{ id: "<root>", reason: "export root is not an array" }]);
  });

  it("defaults an empty/missing name to Untitled", () => {
    const raw = wellFormedExport();
    delete (raw as { name?: string }).name;
    const { conversations } = parseClaudeExport([raw]);
    expect(conversations[0].title).toBe("Untitled");
  });

  it("a conversation with zero renderable messages still parses (empty message list, not skipped)", () => {
    const raw = { uuid: "conv-empty", name: "Empty", chat_messages: [] };
    const { conversations, skipped } = parseClaudeExport([raw]);
    expect(skipped).toEqual([]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].messages).toEqual([]);
  });
});
