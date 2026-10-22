import { toISO } from "@membral/core";
import { describe, expect, it } from "vitest";
import { renderChatgptContent, resolveConvTimestamps } from "../providers/chatgpt.js";

describe("ChatGPT renderChatgptContent", () => {
  it("renders plain text content", () => {
    expect(renderChatgptContent({ content_type: "text", parts: ["Hello", "world"] })).toBe("Hello\nworld");
  });

  it("renders multimodal text + asset references", () => {
    const out = renderChatgptContent({
      content_type: "multimodal_text",
      parts: ["Look at this:", { asset_pointer: "file-service://abc" }],
    });
    expect(out).toContain("Look at this:");
    expect(out).toContain("[asset: file-service://abc]");
  });

  it("wraps code blocks with language fence", () => {
    const out = renderChatgptContent({ content_type: "code", language: "python", text: "print('hi')" });
    expect(out).toContain("```python");
    expect(out).toContain("print('hi')");
    expect(out).toContain("```");
  });

  it("labels execution output", () => {
    const out = renderChatgptContent({ content_type: "execution_output", text: "result: 42" });
    expect(out).toContain("[execution_output]");
    expect(out).toContain("result: 42");
  });

  it("formats tether quotes with title and url", () => {
    const out = renderChatgptContent({
      content_type: "tether_quote",
      title: "Wikipedia: Foo",
      url: "https://en.wikipedia.org/foo",
      text: "Foo is a thing.",
    });
    expect(out).toContain("[quote: Wikipedia: Foo — https://en.wikipedia.org/foo]");
    expect(out).toContain("Foo is a thing.");
  });

  it("falls back to JSON for unknown content types", () => {
    const out = renderChatgptContent({ content_type: "made_up_type", payload: { x: 1 } });
    expect(out).toContain("[made_up_type]");
    expect(out).toContain('"payload"');
  });

  it("returns empty string for invalid content", () => {
    expect(renderChatgptContent(null)).toBe("");
    expect(renderChatgptContent(undefined)).toBe("");
    expect(renderChatgptContent(42)).toBe("");
  });
});

describe("resolveConvTimestamps (M4 regression)", () => {
  it("prefers the full conversation payload's own timestamps over convMeta", () => {
    const result = resolveConvTimestamps(
      { create_time: 1700000000, update_time: 1710000000 },
      { created_at: 1600000000, updated_at: 1600000000 },
    );
    expect(result).toEqual({ created_at: 1700000000, updated_at: 1710000000 });
  });

  it("falls back to convMeta when the full payload lacks timestamps", () => {
    const result = resolveConvTimestamps({}, { created_at: 1600000000, updated_at: 1650000000 });
    expect(result).toEqual({ created_at: 1600000000, updated_at: 1650000000 });
  });

  it("a retry item's null convMeta timestamps stay null (never the epoch-0 placeholder) when the full payload also lacks them, and the core normalizer turns that into a null ISO timestamp without throwing", () => {
    const result = resolveConvTimestamps({}, { created_at: null, updated_at: null });
    expect(result).toEqual({ created_at: null, updated_at: null });
    expect(toISO(result.created_at)).toBeNull();
    expect(toISO(result.updated_at)).toBeNull();
  });

  it("never resurrects the old epoch-0 placeholder even when raw.update_time is literally 0 (guards a regression from `??` back to `||`, which would incorrectly discard a legitimate 0)", () => {
    const result = resolveConvTimestamps({ update_time: 0 }, { created_at: null, updated_at: 999 });
    expect(result.updated_at).toBe(0);
  });
});
