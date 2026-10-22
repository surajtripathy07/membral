import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/embeddings", () => ({
  generateEmbedding: vi.fn(async () => [0.1, 0.2]),
  EmbeddingCeilingExceededError: class extends Error {},
}));

import {
  applyRelativeCutoff,
  collapseIdenticalSnippets,
  searchConversationsScoped,
  type UnifiedSearchResult,
} from "../graph-tools";

// W7 D3: search embeds only when a provider is configured (embeddingsConfigured); these tests mock the embedder, so give them a key.
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
});

function hit(
  id: string,
  score: number,
  snippet: string | null,
  source_type: "chat" | "code" = "code",
): UnifiedSearchResult {
  return {
    source_type,
    id,
    title: null,
    summary: null,
    similarity: null,
    score,
    recency: null,
    snippet,
    resolved: true,
    chunk_idx: null,
    message_start_idx: null,
    message_end_idx: null,
    session_id: source_type === "code" ? id : null,
    turn_idx: null,
    code_project_id: null,
    project_name: null,
  };
}

describe("applyRelativeCutoff — per call, per leg, relative to that leg's top score", () => {
  it("drops near-zero hits under 5% of the leg's top hit (the pasted-table case)", () => {
    const out = applyRelativeCutoff([hit("real", 0.07, "a"), hit("junk-1", 1.28e-9, "b"), hit("junk-2", 2.2e-13, "c")]);
    expect(out.map((r) => r.id)).toEqual(["real"]);
  });

  it("keeps a hit exactly at 5% and drops one just under it", () => {
    const out = applyRelativeCutoff([hit("top", 1, "a"), hit("at", 0.05, "b"), hit("under", 0.0499, "c")]);
    expect(out.map((r) => r.id)).toEqual(["top", "at"]);
  });

  it("never compares across legs: a chat title hit above 1.0 does not cut a real code hit", () => {
    const out = applyRelativeCutoff([hit("chat-title", 1.4, "a", "chat"), hit("code-real", 0.05, "b", "code")]);
    expect(out.map((r) => r.id)).toEqual(["chat-title", "code-real"]);
  });

  it("the cutoff scales with the call: tiny scores all survive when they are all this call has", () => {
    const out = applyRelativeCutoff([hit("a", 2e-9, "a"), hit("b", 1e-9, "b")]);
    expect(out.map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("always keeps the top hit, even at score 0", () => {
    expect(applyRelativeCutoff([hit("only", 0, "a")]).map((r) => r.id)).toEqual(["only"]);
  });
});

describe("collapseIdenticalSnippets — exact match after lowercase + whitespace collapse", () => {
  const table = "| !101 | Add <b>airgap</b> mode | merged |\n| !102 | Fix CodeHub runner | open |";

  it("folds identical snippets into the best-scoring hit, placed where the group first appeared, with also_in", () => {
    const out = collapseIdenticalSnippets([
      hit("s1", 0.05, table),
      hit("other", 0.04, "the airgap spike notes"),
      hit("s2", 0.09, table.toUpperCase().replace(/ \| /g, "   |   ")),
      hit("s3", 0.01, `  ${table}  `),
    ]);
    expect(out.map((r) => r.id)).toEqual(["s2", "other"]);
    expect(out[0].also_in).toEqual(["s1", "s3"]);
    expect(out[1].also_in).toBeUndefined();
  });

  it("keeps near-duplicate snippets that differ by one word as separate hits", () => {
    const out = collapseIdenticalSnippets([
      hit("s1", 0.05, "the airgap spike found three blockers"),
      hit("s2", 0.04, "the airgap spike found two blockers"),
    ]);
    expect(out.map((r) => r.id)).toEqual(["s1", "s2"]);
    expect(out.every((r) => r.also_in === undefined)).toBe(true);
  });

  it("never collapses empty or null snippets", () => {
    const out = collapseIdenticalSnippets([hit("a", 1, null), hit("b", 1, ""), hit("c", 1, "  ")]);
    expect(out.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});

describe("searchConversationsScoped applies both, and still honours the limit", () => {
  function rawRow(id: string, score: number, snippet: string) {
    return {
      source_type: "code",
      conversation_id: null,
      session_id: id,
      turn_idx: 1,
      code_project_id: "proj-1",
      project_name: "demo",
      title: "t",
      summary: null,
      similarity: null,
      score,
      recency: null,
      resolved: true,
      chunk_idx: null,
      message_start_idx: null,
      message_end_idx: null,
      snippet,
    };
  }

  it("over-fetches, cuts, collapses, then slices to the caller's limit", async () => {
    const rows = [
      rawRow("real-1", 0.07, "prose about the airgap spike"),
      rawRow("dup-1", 0.03, "| !101 | airgap |"),
      rawRow("dup-2", 0.02, "| !101 | AIRGAP |"),
      rawRow("junk", 1e-9, "| !9 | airgap |"),
      rawRow("real-2", 0.02, "another airgap note"),
      rawRow("real-3", 0.01, "a third airgap note"),
    ];
    const rpc = vi.fn(async () => ({ data: rows, error: null }));
    const supabase = { rpc } as unknown as SupabaseClient;
    const result = await searchConversationsScoped(supabase, "user-1", "airgap", undefined, 3);
    expect(Array.isArray(result)).toBe(true);
    const list = result as UnifiedSearchResult[];
    expect(rpc).toHaveBeenCalledWith("mcp_search_unified", expect.objectContaining({ p_limit: 6 }));
    expect(list.map((r) => r.id)).toEqual(["real-1", "dup-1", "real-2"]);
    expect(list[1].also_in).toEqual(["dup-2"]);
  });
});
