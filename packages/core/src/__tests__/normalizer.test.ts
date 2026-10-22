import { describe, expect, it } from "vitest";
import { normalizeConversation, normalizeMessage, toISO } from "../normalizer.js";

describe("toISO", () => {
  it("returns null for null/undefined", () => {
    expect(toISO(null)).toBeNull();
    expect(toISO(undefined)).toBeNull();
  });

  it("passes through strings unchanged", () => {
    expect(toISO("2024-01-15T10:30:00.000Z")).toBe("2024-01-15T10:30:00.000Z");
  });

  it("converts unix seconds to ISO string", () => {
    // 1700000000 seconds = 2023-11-14T22:13:20.000Z
    const result = toISO(1700000000);
    expect(result).toBe("2023-11-14T22:13:20.000Z");
  });

  it("converts milliseconds to ISO string", () => {
    // 1700000000000 ms = same date
    const result = toISO(1700000000000);
    expect(result).toBe("2023-11-14T22:13:20.000Z");
  });

  it("converts Date objects to ISO string", () => {
    const date = new Date("2024-06-01T12:00:00.000Z");
    expect(toISO(date)).toBe("2024-06-01T12:00:00.000Z");
  });

  it("returns null for garbage string input", () => {
    expect(toISO("not-a-date")).toBeNull();
    expect(toISO("garbage")).toBeNull();
    expect(toISO("")).toBeNull();
  });

  it("returns epoch ISO string for value 0", () => {
    expect(toISO(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("returns null for NaN, Infinity, and -Infinity", () => {
    expect(toISO(NaN)).toBeNull();
    expect(toISO(Infinity)).toBeNull();
    expect(toISO(-Infinity)).toBeNull();
  });

  it("returns null for negative numbers", () => {
    expect(toISO(-1)).toBeNull();
    expect(toISO(-1700000000)).toBeNull();
  });
});

describe("normalizeMessage", () => {
  it("normalizes a message with all fields", () => {
    const msg = normalizeMessage({
      role: "assistant",
      content: "Hello!",
      timestamp: "2024-01-15T10:30:00.000Z",
      metadata: { model: "gpt-4" },
    });

    expect(msg).toEqual({
      role: "assistant",
      content: "Hello!",
      timestamp: "2024-01-15T10:30:00.000Z",
      metadata: { model: "gpt-4" },
    });
  });

  it("fills defaults for missing fields", () => {
    const msg = normalizeMessage({} as any);

    expect(msg.role).toBe("unknown");
    expect(msg.content).toBe("");
    expect(msg.timestamp).toBeNull();
    expect(msg.metadata).toEqual({});
  });

  it("F4: coerces a role outside the closed MessageRole vocabulary to unknown", () => {
    const msg = normalizeMessage({ role: "human", content: "hi" } as any);
    expect(msg.role).toBe("unknown");
    expect(msg.content).toBe("hi");
  });
});

describe("normalizeConversation", () => {
  it("normalizes a conversation with all fields", () => {
    const conv = normalizeConversation({
      source: "chatgpt",
      source_id: "abc-123",
      title: "My Chat",
      created_at: "2024-01-15T10:00:00.000Z",
      updated_at: "2024-01-15T11:00:00.000Z",
      model: "gpt-4",
      messages: [{ role: "user", content: "Hi", timestamp: null, metadata: {} }],
      metadata: { tags: ["test"] },
    });

    expect(conv.id).toBe("chatgpt:abc-123");
    expect(conv.source).toBe("chatgpt");
    expect(conv.source_id).toBe("abc-123");
    expect(conv.title).toBe("My Chat");
    expect(conv.created_at).toBe("2024-01-15T10:00:00.000Z");
    expect(conv.updated_at).toBe("2024-01-15T11:00:00.000Z");
    expect(conv.model).toBe("gpt-4");
    expect(conv.messages).toHaveLength(1);
    expect(conv.metadata).toEqual({ tags: ["test"] });
    expect(conv.synced_at).toBeDefined();
  });

  it("fills defaults for missing optional fields", () => {
    const conv = normalizeConversation({
      source: "claude",
      source_id: "xyz",
    } as any);

    expect(conv.title).toBe("Untitled");
    expect(conv.model).toBeNull();
    expect(conv.messages).toEqual([]);
    expect(conv.metadata).toEqual({});
    expect(conv.created_at).toBeNull();
    expect(conv.updated_at).toBeNull();
  });

  it("handles null input fields gracefully", () => {
    const conv = normalizeConversation({
      source: "grok",
      source_id: "1",
      title: null as any,
      created_at: null,
      updated_at: null,
      model: null,
      messages: null as any,
      metadata: null as any,
    });

    expect(conv.title).toBe("Untitled");
    expect(conv.model).toBeNull();
    expect(conv.messages).toEqual([]);
    expect(conv.metadata).toEqual({});
  });

  it("uses provided synced_at instead of wall-clock time", () => {
    const conv = normalizeConversation({ source: "claude", source_id: "x" }, { synced_at: "2025-01-01T00:00:00Z" });
    expect(conv.synced_at).toBe("2025-01-01T00:00:00.000Z");
  });

  it("defaults synced_at to a valid ISO string when not provided", () => {
    const conv = normalizeConversation({ source: "claude", source_id: "y" });
    expect(conv.synced_at).toBeDefined();
    expect(new Date(conv.synced_at).toISOString()).toBe(conv.synced_at);
  });

  it("falls back to wall-clock synced_at when garbage synced_at is provided", () => {
    const conv = normalizeConversation({ source: "claude", source_id: "z" }, { synced_at: "not-a-date" });
    expect(conv.synced_at).toBeDefined();
    expect(new Date(conv.synced_at).toISOString()).toBe(conv.synced_at);
  });
});
