import { describe, expect, it } from "vitest";
import { buildProjectContentSignal, cosineSimilarity, scoreConversationCandidates } from "../content-match";

describe("buildProjectContentSignal", () => {
  it("combines repo name, display name, summary, rollup prose, and recurring file/tool basenames", () => {
    const signal = buildProjectContentSignal({
      repoIdentity: "github.com/acme/widget-catalog",
      displayName: "acme/widget-catalog",
      summary: "A catalog service.",
      whatBuilt: "Search and checkout flows.",
      keyDecisions: "Chose Postgres over Mongo.",
      openThreads: "Payments integration pending.",
      recurringFilesTools: ["apps/api/src/checkout.ts", "apps/api/src/search.ts"],
    });

    expect(signal).toContain("widget-catalog");
    expect(signal).toContain("acme/widget-catalog");
    expect(signal).toContain("A catalog service.");
    expect(signal).toContain("Search and checkout flows.");
    expect(signal).toContain("Chose Postgres over Mongo.");
    expect(signal).toContain("Payments integration pending.");
    // basenames only, not full paths
    expect(signal).toContain("checkout.ts search.ts");
    expect(signal).not.toContain("apps/api/src/checkout.ts");
  });

  it("degrades to just repo/display name when every prose field is empty", () => {
    const signal = buildProjectContentSignal({
      repoIdentity: "github.com/acme/empty",
      displayName: null,
      summary: null,
      whatBuilt: null,
      keyDecisions: null,
      openThreads: null,
      recurringFilesTools: [],
    });
    expect(signal.trim()).toBe("empty");
  });
});

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("is 0 for empty, mismatched-length, or zero vectors (defensive, never throws/NaN)", () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

describe("scoreConversationCandidates", () => {
  const candidates = [
    { conversationId: "a", title: "On-topic", embedding: [1, 0] },
    { conversationId: "b", title: "Off-topic", embedding: [0, 1] },
    { conversationId: "c", title: "Also on-topic", embedding: [0.9, 0.1] },
  ];

  it("keeps only candidates clearing the threshold, strongest first", () => {
    const out = scoreConversationCandidates([1, 0], candidates, { threshold: 0.5, topK: 10 });
    expect(out.map((m) => m.conversationId)).toEqual(["a", "c"]);
    expect(out[0].sim).toBeGreaterThan(out[1].sim);
  });

  it("caps at topK", () => {
    const out = scoreConversationCandidates([1, 0], candidates, { threshold: 0, topK: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].conversationId).toBe("a");
  });

  it("returns [] for an empty project embedding", () => {
    expect(scoreConversationCandidates([], candidates, { threshold: 0, topK: 10 })).toEqual([]);
  });

  it("skips candidates with an empty embedding", () => {
    const out = scoreConversationCandidates([1, 0], [{ conversationId: "z", title: "no embedding", embedding: [] }], {
      threshold: 0,
      topK: 10,
    });
    expect(out).toEqual([]);
  });
});
