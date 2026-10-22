import { describe, expect, it } from "vitest";
import { formatDate } from "@/lib/format/dates";
import { formatSimilarity } from "@/lib/format/numbers";
import type { SearchResultData } from "../search-result";

function makeResult(overrides: Partial<SearchResultData> = {}): SearchResultData {
  return {
    id: "abc-123",
    source: "chatgpt",
    title: "Test Conversation",
    created_at: "2025-06-15T10:30:00Z",
    summary: null,
    similarity: null,
    ...overrides,
  };
}

describe("SearchResult data helpers", () => {
  it("renders title and source from result data", () => {
    const result = makeResult({ title: "My Chat", source: "claude" });
    expect(result.title).toBe("My Chat");
    expect(result.source).toBe("claude");
  });

  it("shows similarity percentage when provided", () => {
    const pct = formatSimilarity(0.87);
    expect(pct).toBe("87%");
  });

  it("returns null similarity when not provided", () => {
    expect(formatSimilarity(null)).toBeNull();
  });

  it("shows summary when available", () => {
    const result = makeResult({ summary: "A discussion about React hooks" });
    expect(result.summary).toBe("A discussion about React hooks");
  });

  it("formats date correctly", () => {
    const formatted = formatDate("2025-06-15T10:30:00Z");
    expect(formatted).toContain("Jun");
    expect(formatted).toContain("15");
    expect(formatted).toContain("2025");
  });

  it("returns empty string for null date", () => {
    expect(formatDate(null)).toBe("");
  });

  it("rounds similarity to nearest percent", () => {
    expect(formatSimilarity(0.856)).toBe("86%");
    expect(formatSimilarity(0.994)).toBe("99%");
    expect(formatSimilarity(1.0)).toBe("100%");
  });

  it("handles all source types", () => {
    const sources = ["claude", "chatgpt", "grok"];
    sources.forEach((s) => {
      const result = makeResult({ source: s });
      expect(result.source).toBe(s);
    });
  });
});
