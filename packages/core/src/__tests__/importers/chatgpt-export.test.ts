import { describe, expect, it } from "vitest";
import { parseChatGptExport, renderChatgptContent, treeToLinearMessages } from "../../importers/chatgpt-export.js";

/**
 * A branching tree: root -> system -> user (msg1) -> [assistant A (msg2), assistant B (msg3, edited retry)]
 * current_node points at the assistant-B branch, so only root/system/user/assistantB should
 * appear in the linear transcript -- assistantA (the abandoned edit) must NOT appear.
 */
function branchingExport() {
  return {
    id: "conv-branch",
    title: "Branching chat",
    create_time: 1700000000,
    update_time: 1700000100,
    current_node: "node-assistantB",
    mapping: {
      "node-root": { id: "node-root", message: null, parent: null, children: ["node-system"] },
      "node-system": {
        id: "node-system",
        message: {
          id: "msg-system",
          author: { role: "system" },
          content: { content_type: "text", parts: ["You are ChatGPT."] },
          create_time: 1700000000,
        },
        parent: "node-root",
        children: ["node-user"],
      },
      "node-user": {
        id: "node-user",
        message: {
          id: "msg1",
          author: { role: "user" },
          content: { content_type: "text", parts: ["Hello there"] },
          create_time: 1700000001,
        },
        parent: "node-system",
        children: ["node-assistantA", "node-assistantB"],
      },
      "node-assistantA": {
        id: "node-assistantA",
        message: {
          id: "msg2",
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["Abandoned reply"] },
          create_time: 1700000002,
          metadata: { model_slug: "gpt-4o-mini" },
        },
        parent: "node-user",
        children: [],
      },
      "node-assistantB": {
        id: "node-assistantB",
        message: {
          id: "msg3",
          author: { role: "assistant" },
          content: { content_type: "text", parts: ["Final reply"] },
          create_time: 1700000003,
          metadata: { model_slug: "gpt-4o" },
        },
        parent: "node-user",
        children: [],
      },
    },
  };
}

describe("renderChatgptContent", () => {
  it("renders text and multimodal parts", () => {
    expect(renderChatgptContent({ content_type: "text", parts: ["Hello", "world"] })).toBe("Hello\nworld");
    const out = renderChatgptContent({
      content_type: "multimodal_text",
      parts: ["Look:", { asset_pointer: "file-service://abc" }],
    });
    expect(out).toContain("Look:");
    expect(out).toContain("[asset: file-service://abc]");
  });

  it("wraps code content in a language fence", () => {
    const out = renderChatgptContent({ content_type: "code", language: "python", text: "print(1)" });
    expect(out).toBe("```python\nprint(1)\n```");
  });

  it("falls back to a JSON-tagged dump for unknown content types rather than dropping it", () => {
    const out = renderChatgptContent({ content_type: "totally_new_type", weird: true });
    expect(out).toContain("[totally_new_type]");
    expect(out).toContain('"weird":true');
  });

  it("returns empty string for non-object content", () => {
    expect(renderChatgptContent(null)).toBe("");
    expect(renderChatgptContent(undefined)).toBe("");
    expect(renderChatgptContent("plain string")).toBe("");
  });
});

describe("treeToLinearMessages", () => {
  it("follows current_node's parent chain and picks the active branch, dropping the abandoned edit", () => {
    const messages = treeToLinearMessages(branchingExport());
    expect(messages.map((m) => m.content)).toEqual(["Hello there", "Final reply"]);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  });

  it("skips system messages and null-message placeholder nodes without throwing", () => {
    const messages = treeToLinearMessages(branchingExport());
    expect(messages.some((m) => m.content.includes("You are ChatGPT"))).toBe(false);
  });

  it("carries model_slug and message id into metadata", () => {
    const messages = treeToLinearMessages(branchingExport());
    const reply = messages.find((m) => m.role === "assistant");
    expect(reply?.metadata).toMatchObject({ model: "gpt-4o", message_id: "msg3" });
  });

  it("maps a tool-author message to role assistant with a tool_role marker", () => {
    const raw = {
      current_node: "n2",
      mapping: {
        n1: {
          message: {
            id: "m1",
            author: { role: "user" },
            content: { content_type: "text", parts: ["run code"] },
          },
          parent: null,
        },
        n2: {
          message: {
            id: "m2",
            author: { role: "tool" },
            content: { content_type: "execution_output", text: "42" },
          },
          parent: "n1",
        },
      },
    };
    const messages = treeToLinearMessages(raw);
    expect(messages[1]).toMatchObject({ role: "assistant", metadata: { tool_role: true } });
  });

  it("renders code/multimodal parts within the tree walk", () => {
    const raw = {
      current_node: "n1",
      mapping: {
        n1: {
          message: {
            id: "m1",
            author: { role: "assistant" },
            content: { content_type: "code", language: "ts", text: "const x = 1;" },
          },
          parent: null,
        },
      },
    };
    const messages = treeToLinearMessages(raw);
    expect(messages[0].content).toContain("```ts");
    expect(messages[0].content).toContain("const x = 1;");
  });

  it("returns an empty array for missing/malformed mapping or current_node, never throws", () => {
    expect(treeToLinearMessages({})).toEqual([]);
    expect(treeToLinearMessages({ current_node: "missing", mapping: {} })).toEqual([]);
    expect(treeToLinearMessages(null)).toEqual([]);
    expect(treeToLinearMessages("not an object")).toEqual([]);
  });

  it("does not infinite-loop on a cyclic parent chain (malformed/hostile export data)", () => {
    const raw = {
      current_node: "a",
      mapping: {
        a: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["a"] } }, parent: "b" },
        b: { message: { author: { role: "user" }, content: { content_type: "text", parts: ["b"] } }, parent: "a" },
      },
    };
    const messages = treeToLinearMessages(raw);
    // Must terminate and return at most the two distinct nodes, not hang or grow unbounded.
    expect(messages.length).toBeLessThanOrEqual(2);
  });
});

describe("parseChatGptExport", () => {
  it("parses a well-formed export array into normalized conversations", () => {
    const { conversations, skipped } = parseChatGptExport([branchingExport()]);
    expect(skipped).toEqual([]);
    expect(conversations).toHaveLength(1);
    const conv = conversations[0];
    expect(conv.source).toBe("chatgpt");
    expect(conv.source_id).toBe("conv-branch");
    expect(conv.title).toBe("Branching chat");
    expect(conv.messages.map((m) => m.content)).toEqual(["Hello there", "Final reply"]);
    expect(conv.model).toBe("gpt-4o");
    expect(conv.created_at).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it("skips malformed entries instead of throwing, and keeps parsing the rest", () => {
    const good = branchingExport();
    const { conversations, skipped } = parseChatGptExport([
      null,
      42,
      { title: "no id" },
      good,
      { id: "", title: "empty id" },
    ]);
    expect(conversations).toHaveLength(1);
    expect(conversations[0].source_id).toBe("conv-branch");
    expect(skipped).toHaveLength(4);
    expect(skipped.map((s) => s.reason)).toEqual([
      "entry is not an object",
      "entry is not an object",
      "missing id",
      "missing id",
    ]);
  });

  it("returns an empty result with a skip note when the root is not an array", () => {
    const { conversations, skipped } = parseChatGptExport({ not: "an array" });
    expect(conversations).toEqual([]);
    expect(skipped).toEqual([{ id: "<root>", reason: "export root is not an array" }]);
  });

  it("defaults an empty/missing title to Untitled", () => {
    const raw = branchingExport();
    delete (raw as { title?: string }).title;
    const { conversations } = parseChatGptExport([raw]);
    expect(conversations[0].title).toBe("Untitled");
  });
});
