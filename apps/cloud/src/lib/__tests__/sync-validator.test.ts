import { describe, expect, it } from "vitest";
import { CHAT_SOURCES, validateConversations } from "../sync-validator";

describe("CHAT_SOURCES (goal 2026-07-26 step 2, MAJOR 2 fix)", () => {
  it("contains exactly the three chat providers, never 'code'", () => {
    expect(CHAT_SOURCES).toEqual(new Set(["claude", "chatgpt", "grok"]));
    expect(CHAT_SOURCES.has("code")).toBe(false);
  });
});

describe("validateConversations", () => {
  const validConversation = {
    source: "claude",
    source_id: "conv-123",
    title: "Test conversation",
    messages: [
      {
        role: "user",
        content: "Hello",
        timestamp: null,
        metadata: {},
      },
    ],
    metadata: {},
    created_at: null,
    updated_at: null,
    model: null,
    synced_at: new Date().toISOString(),
  };

  it("valid conversations pass through", () => {
    const { valid, errors } = validateConversations([validConversation]);
    expect(valid).toHaveLength(1);
    expect(errors).toHaveLength(0);
    expect(valid[0].source).toBe("claude");
  });

  it("missing source is rejected", () => {
    const { source, ...noSource } = validConversation;
    const { valid, errors } = validateConversations([noSource]);
    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("source");
  });

  it("invalid source value is rejected", () => {
    const { valid, errors } = validateConversations([{ ...validConversation, source: "bard" }]);
    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("source");
  });

  it("missing source_id is rejected", () => {
    const { source_id, ...noSourceId } = validConversation;
    const { valid, errors } = validateConversations([noSourceId]);
    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("source_id");
  });

  it("non-array messages rejected", () => {
    const { valid, errors } = validateConversations([{ ...validConversation, messages: "not-an-array" }]);
    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("messages");
  });

  it("empty array returns empty valid array", () => {
    const { valid, errors } = validateConversations([]);
    expect(valid).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it("accepts all valid source values", () => {
    for (const source of ["claude", "chatgpt", "grok"]) {
      const { valid, errors } = validateConversations([{ ...validConversation, source }]);
      expect(valid).toHaveLength(1);
      expect(errors).toHaveLength(0);
    }
  });

  it("filters valid from invalid in mixed input", () => {
    const invalid = { ...validConversation, source: "invalid" };
    const { valid, errors } = validateConversations([validConversation, invalid]);
    expect(valid).toHaveLength(1);
    expect(errors).toHaveLength(1);
  });

  it("F4: coerces an unrecognized message role to unknown at the server ingest boundary", () => {
    const { valid, errors } = validateConversations([
      {
        ...validConversation,
        messages: [{ role: "human", content: "hi", timestamp: null, metadata: {} }],
      },
    ]);
    expect(errors).toHaveLength(0);
    expect(valid).toHaveLength(1);
    expect(valid[0].messages[0].role).toBe("unknown");
    // Other message fields survive the coercion untouched.
    expect(valid[0].messages[0].content).toBe("hi");
  });

  it("F4: leaves every valid role untouched", () => {
    for (const role of ["user", "assistant", "system", "unknown"]) {
      const { valid } = validateConversations([
        { ...validConversation, messages: [{ role, content: "hi", timestamp: null, metadata: {} }] },
      ]);
      expect(valid[0].messages[0].role).toBe(role);
    }
  });
});
