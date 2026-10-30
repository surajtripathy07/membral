import { FakeSupabase } from "@membral/test-kit";
import { describe, expect, it, vi } from "vitest";
import { EmbeddingCeilingExceededError } from "@/lib/embeddings";
import { dedupeAndCap, matchCodeProjectCrossLinks } from "../cross-links";

const mockQueryVectorsAllowed = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/lib/llm/embedding-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/llm/embedding-client")>()),
  queryVectorsAllowed: mockQueryVectorsAllowed,
}));

const USER_ID = "user-1";

function seedProject(db: FakeSupabase, id: string, overrides: Record<string, unknown> = {}) {
  db.seed("code_projects", [
    {
      id,
      user_id: USER_ID,
      display_name: "webapp",
      repo_identity: "github.com/acme/webapp",
      summary: null,
      props: {},
      ...overrides,
    },
  ]);
}

/** Seed a conversation with a cached embedding — the content-match candidate
 *  shape post-migration-084 (conversations.embedding, populated by
 *  lib/conversation-embeddings.ts; no more kg_nodes/kg_conv_embeddings
 *  indirection — see cross-links.ts's HISTORY note). Defaults `source` to
 *  'chatgpt' (a real chat source, in CHAT_SOURCES) so every existing test
 *  keeps exercising the candidate pool by default; pass an explicit source
 *  (e.g. 'claude-code') to test the allowlist itself — review-084.md
 *  finding 2. */
function seedConversation(db: FakeSupabase, convId: string, title: string, embedding: number[], source = "chatgpt") {
  db.seed("conversations", [{ id: convId, user_id: USER_ID, title, embedding, source }]);
}

/** A no-op-by-default fake embed: returns `vec` regardless of the signal
 *  text it's called with (content-match tests only need to control the
 *  RESULTING similarity, not the text->vector mapping itself). */
function fakeEmbed(vec: number[]): (text: string) => Promise<number[]> {
  return async () => vec;
}

describe("matchCodeProjectCrossLinks", () => {
  it("skips the unassigned fallback bucket entirely (ADR Q4)", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-unassigned", { display_name: "Unassigned", repo_identity: "code-project:unassigned" });
    seedConversation(db, "conv-1", "Unassigned", [1, 0]);

    const result = await matchCodeProjectCrossLinks({
      supabase: db.asClient(),
      userId: USER_ID,
      embed: fakeEmbed([1, 0]),
    });
    expect(result.evaluated).toBe(0);
    expect(result.created).toBe(0);
  });

  it("CONTENT MATCH: links a project to a conversation whose cached embedding is similar to the project's rollup signal", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", {
      display_name: "acme/foo",
      repo_identity: "github.com/acme/foo",
      props: { rollup: { summary: "Built a widget catalog with search and checkout." } },
    });
    seedConversation(db, "conv-1", "Widget catalog search design", [1, 0, 0]);

    const result = await matchCodeProjectCrossLinks({
      supabase: db.asClient(),
      userId: USER_ID,
      embed: fakeEmbed([1, 0, 0]), // cosine sim 1.0 vs the seeded conversation embedding
    });

    expect(result.created).toBe(1);
    const links = db.getRows("code_cross_links");
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      user_id: USER_ID,
      code_project_id: "proj-1",
      conversation_id: "conv-1",
      rel_type: "relates_to",
    });
    expect(links[0].confidence).toBeGreaterThan(0);
    expect(links[0].confidence).toBeLessThanOrEqual(0.7); // content path capped
  });

  it("review-084.md finding 2: a source='claude-code' conversation (a mirrored code session, not a chat) never becomes a cross-link candidate, even with a perfect embedding match", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", {
      display_name: "acme/foo",
      repo_identity: "github.com/acme/foo",
      props: { rollup: { summary: "Built a widget catalog with search and checkout." } },
    });
    // mirrorCodeSessionsToConversations writes the project's own sessions
    // into `conversations` with source='claude-code' — an identical (or
    // near-identical) embedding to the project's own rollup prose would
    // otherwise score ~1.0 and self-link.
    seedConversation(db, "conv-mirrored", "webapp session", [1, 0, 0], "claude-code");

    const result = await matchCodeProjectCrossLinks({
      supabase: db.asClient(),
      userId: USER_ID,
      embed: fakeEmbed([1, 0, 0]), // cosine sim 1.0 — would match if not filtered by source
    });

    expect(result.created).toBe(0);
    expect(db.getRows("code_cross_links")).toHaveLength(0);
  });

  it("CONTENT MATCH: a name-different-but-content-related pair links (the membral case)", async () => {
    // A CodeProject named after its repo and a conversation with a totally
    // different title still link when their CONTENT is about the same thing
    // — a name-overlap heuristic could never do this.
    const db = new FakeSupabase();
    seedProject(db, "proj-membral", {
      display_name: "surajtripathy07/membral",
      repo_identity: "github.com/surajtripathy07/membral",
      props: {
        rollup: {
          summary: "Manages AI conversation history across providers with a sync pipeline.",
        },
      },
    });
    // On-topic conversation: shares no name tokens with "membral" at all.
    seedConversation(db, "conv-ontopic", "Synchronization tool for AI project management", [1, 0]);
    // Off-topic conversation, also unrelated by name.
    seedConversation(db, "conv-offtopic", "Marathon training plan", [0, 1]);

    const result = await matchCodeProjectCrossLinks({
      supabase: db.asClient(),
      userId: USER_ID,
      embed: fakeEmbed([1, 0]), // matches only the on-topic conversation's embedding
    });

    expect(result.created).toBe(1);
    const links = db.getRows("code_cross_links");
    expect(links).toHaveLength(1);
    expect(links[0].conversation_id).toBe("conv-ontopic");
  });

  it("NO MATCH: content score below the similarity threshold stays unlinked", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", {
      props: { rollup: { summary: "Built a widget catalog with search and checkout." } },
    });
    seedConversation(db, "conv-1", "Completely unrelated topic", [0, 1, 0]);

    const result = await matchCodeProjectCrossLinks({
      supabase: db.asClient(),
      userId: USER_ID,
      embed: fakeEmbed([1, 0, 0]), // orthogonal -> cosine sim 0, well under threshold
    });

    expect(result.created).toBe(0);
    expect(db.getRows("code_cross_links")).toHaveLength(0);
  });

  it("NO MATCH: a project with no rollup/summary/repo text produces no signal and is never embedded", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", { display_name: null, repo_identity: "" });
    seedConversation(db, "conv-1", "Widget topic", [1, 0]);

    const embed = vi.fn();
    await matchCodeProjectCrossLinks({ supabase: db.asClient(), userId: USER_ID, embed });
    expect(embed).not.toHaveBeenCalled();
  });

  it("CAP: no more than 5 links form per project even with many qualifying content candidates", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", { props: { rollup: { summary: "Widget catalog." } } });
    for (let i = 0; i < 8; i++) {
      seedConversation(db, `conv-${i}`, `Widget topic ${i}`, [1, 0]);
    }

    const result = await matchCodeProjectCrossLinks({
      supabase: db.asClient(),
      userId: USER_ID,
      embed: fakeEmbed([1, 0]), // all 8 candidates score identically (cosine sim 1.0)
    });

    expect(result.created).toBe(5);
    expect(db.getRows("code_cross_links")).toHaveLength(5);
  });

  it("does not recreate an equivalent NON-dismissed link that already exists", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", { props: { rollup: { summary: "Widget catalog." } } });
    seedConversation(db, "conv-1", "Widget topic", [1, 0]);
    db.seed("code_cross_links", [
      {
        id: "link-existing",
        user_id: USER_ID,
        code_project_id: "proj-1",
        conversation_id: "conv-1",
        rel_type: "relates_to",
        confidence: 0.5,
        dismissed_at: null,
      },
    ]);

    const result = await matchCodeProjectCrossLinks({
      supabase: db.asClient(),
      userId: USER_ID,
      embed: fakeEmbed([1, 0]),
    });

    expect(result.created).toBe(0);
    expect(db.getRows("code_cross_links")).toHaveLength(1);
  });

  it("DISMISSED LINKS ARE NOT RECREATED: a dismissed link stays gone across re-runs", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", { props: { rollup: { summary: "Widget catalog." } } });
    seedConversation(db, "conv-1", "Widget topic", [1, 0]);
    db.seed("code_cross_links", [
      {
        id: "link-dismissed",
        user_id: USER_ID,
        code_project_id: "proj-1",
        conversation_id: "conv-1",
        rel_type: "relates_to",
        confidence: 0.5,
        dismissed_at: "2026-07-01T00:00:00.000Z",
      },
    ]);

    const result = await matchCodeProjectCrossLinks({
      supabase: db.asClient(),
      userId: USER_ID,
      embed: fakeEmbed([1, 0]),
    });

    expect(result.created).toBe(0);
    expect(db.getRows("code_cross_links")).toHaveLength(1); // still just the dismissed row — not recreated
  });

  it("GRACEFUL DEGRADATION: an embed() failure (e.g. missing API key) skips content matches, no crash", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", { props: { rollup: { summary: "Widget catalog." } } });
    seedConversation(db, "conv-1", "Widget topic", [1, 0]);

    const failingEmbed = vi.fn().mockRejectedValue(new Error("Missing OPENAI_API_KEY"));
    const result = await matchCodeProjectCrossLinks({
      supabase: db.asClient(),
      userId: USER_ID,
      embed: failingEmbed,
    });

    expect(failingEmbed).toHaveBeenCalled();
    expect(result.created).toBe(0);
    expect(db.getRows("code_cross_links")).toHaveLength(0);
  });

  it("never calls embed() when there are no conversation candidates at all", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", { props: { rollup: { summary: "Widget catalog." } } });

    const embed = vi.fn();
    await matchCodeProjectCrossLinks({ supabase: db.asClient(), userId: USER_ID, embed });

    expect(embed).not.toHaveBeenCalled();
  });

  it("issue #92 adversarial review m-cross-links: an EmbeddingCeilingExceededError from embed() disables content-matching for all remaining projects after the first preflight", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", { props: { rollup: { summary: "Widget catalog." } } });
    seedProject(db, "proj-2", { props: { rollup: { summary: "Infra rollout." } } });
    seedConversation(db, "conv-1", "Widget topic", [1, 0]); // shared content-match candidate pool

    const ceilingEmbed = vi.fn().mockRejectedValue(new EmbeddingCeilingExceededError(5, 5));
    const result = await matchCodeProjectCrossLinks({
      supabase: db.asClient(),
      userId: USER_ID,
      embed: ceilingEmbed,
    });

    // embed() was preflighted exactly ONCE for the whole run — proj-2 never
    // independently attempted its own content-match call and re-hit the
    // same ceiling (the "N preflights/throws" bug this fixes).
    expect(ceilingEmbed).toHaveBeenCalledTimes(1);
    // Both projects were still evaluated (the count itself costs nothing);
    // neither got a match once content-matching was disabled after proj-1's
    // ceiling hit.
    expect(result.evaluated).toBe(2);
    expect(db.getRows("code_cross_links")).toHaveLength(0);
  });

  it("CHANGED ONLY: with 3 projects and 1 listed in projectIds, embed() runs once, for that project", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", { props: { rollup: { summary: "Widget catalog." } } });
    seedProject(db, "proj-2", { props: { rollup: { summary: "Infra rollout." } } });
    seedProject(db, "proj-3", { props: { rollup: { summary: "Billing." } } });
    seedConversation(db, "conv-1", "Widget topic", [1, 0]);

    const embed = vi.fn(async () => [1, 0]);
    const result = await matchCodeProjectCrossLinks({
      supabase: db.asClient(),
      userId: USER_ID,
      embed,
      projectIds: ["proj-2"],
    });

    expect(embed).toHaveBeenCalledTimes(1);
    expect(result.evaluated).toBe(1);
    expect(result.matches.map((m) => m.codeProjectId)).toEqual(["proj-2"]);
  });

  it("CHANGED ONLY: an empty projectIds list embeds nothing and reads nothing", async () => {
    const db = new FakeSupabase();
    seedProject(db, "proj-1", { props: { rollup: { summary: "Widget catalog." } } });
    seedConversation(db, "conv-1", "Widget topic", [1, 0]);

    const embed = vi.fn(async () => [1, 0]);
    const result = await matchCodeProjectCrossLinks({
      supabase: db.asClient(),
      userId: USER_ID,
      embed,
      projectIds: [],
    });

    expect(embed).not.toHaveBeenCalled();
    expect(result).toEqual({ evaluated: 0, created: 0, matches: [] });
  });

  it("FAMILY GATE: when query vectors are not allowed (non-default embedding family), embed() is never called", async () => {
    mockQueryVectorsAllowed.mockReturnValueOnce(false);
    const db = new FakeSupabase();
    seedProject(db, "proj-1", { props: { rollup: { summary: "Widget catalog." } } });
    seedProject(db, "proj-2", { props: { rollup: { summary: "Infra rollout." } } });
    seedConversation(db, "conv-1", "Widget topic", [1, 0]);

    const embed = vi.fn(async () => [1, 0]);
    const result = await matchCodeProjectCrossLinks({ supabase: db.asClient(), userId: USER_ID, embed });

    expect(embed).not.toHaveBeenCalled();
    expect(result).toEqual({ evaluated: 0, created: 0, matches: [] });
    expect(db.getRows("code_cross_links")).toHaveLength(0);
  });

  // --- dedupeAndCap (pure) --------------------------------------------------

  describe("dedupeAndCap", () => {
    function match(conversationId: string, confidence: number): ReturnType<typeof Object> {
      return { codeProjectId: "proj-1", conversationId, conversationTitle: conversationId, confidence };
    }

    it("drops matches under the min-confidence floor (0.2)", () => {
      const out = dedupeAndCap([match("a", 0.19), match("b", 0.2), match("c", 0.5)]);
      expect(out.map((m) => m.conversationId).sort()).toEqual(["b", "c"]);
    });

    it("caps at 5 links, keeping the highest-confidence ones", () => {
      const matches = Array.from({ length: 8 }, (_, i) => match(`conv-${i}`, 0.3 + i * 0.05));
      const out = dedupeAndCap(matches);
      expect(out).toHaveLength(5);
      expect(out.map((m) => m.conversationId)).toEqual(["conv-7", "conv-6", "conv-5", "conv-4", "conv-3"]);
    });

    it("dedupes by conversation, keeping the higher-confidence match", () => {
      const out = dedupeAndCap([match("a", 0.4), match("a", 0.9)]);
      expect(out).toHaveLength(1);
      expect(out[0].confidence).toBe(0.9);
    });
  });
});
