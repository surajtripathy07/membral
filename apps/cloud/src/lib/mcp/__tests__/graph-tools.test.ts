import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateEmbedding = vi.fn();
// vi.mock factories are hoisted above the whole file, including any top-level
// `class` declarations here (unlike `function`, classes are NOT hoisted with
// their binding initialized) — so the error class must be declared INSIDE
// the factory itself, not referenced from outer scope.
vi.mock("@/lib/embeddings", () => {
  class EmbeddingCeilingExceededError extends Error {
    constructor(
      public readonly spentUsd: number,
      public readonly ceilingUsd: number,
    ) {
      super("ceiling exceeded");
      this.name = "EmbeddingCeilingExceededError";
    }
  }
  return {
    generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
    EmbeddingCeilingExceededError,
  };
});

// NOT mocked in this file — graph-tools.ts's `instanceof FeatureDisabledError`
// check is testing against the real class, since @/lib/feature-flags isn't
// touched by any vi.mock here.
import { BUNDLED_EMBEDDING_MODEL } from "@/lib/domain/embedding-model-ids";
// Import the (mocked) error class back from the module — same class
// graph-tools.ts's `instanceof` check is testing against, since vi.mock
// intercepts every import of this path, including this one.
import { EmbeddingCeilingExceededError as FakeEmbeddingCeilingExceededError } from "@/lib/embeddings";
import { FeatureDisabledError } from "@/lib/feature-flags";
import {
  getScopedConversation,
  resolveEffectiveScopeId,
  resolveScopeId,
  searchConversationsScoped,
  UnknownScopeError,
} from "../graph-tools";

// W7 D3: search embeds only when a provider is configured (embeddingsConfigured); these tests mock the embedder, so give them a key.
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
});

/**
 * Narrows the union return type of searchConversationsScoped (issue #92 adversarial review M3: they return a
 * `{conversations, degraded}` object instead of a bare array when the
 * ceiling degraded the call) down to the plain array — for tests that are
 * deliberately exercising the NON-degraded success path and know statically
 * that a bare array comes back. Throws loudly if that assumption is wrong,
 * rather than silently reading `.conversations` off an array (undefined).
 */
function asList<T>(result: T[] | { conversations: T[]; degraded: string }): T[] {
  if (Array.isArray(result)) return result;
  throw new Error(`asList: expected a bare array, got a degraded result: ${result.degraded}`);
}

// Fixture "graph": one scoped LifeArea ("Space", id "area-space") containing
// conv-2, and an out-of-scope conversation conv-1 that must never surface
// once a scope is requested. The fake rpc() mimics the migration-016
// SQL functions closely enough to prove the TS layer's scope wiring:
// resolveScopeId must run first, and its resolved p_scope_id must be the
// only thing that ever narrows a data RPC's result.
// Raw mcp_search_unified rows (migration 044/045 shape) — one out-of-scope
// chat hit, one in-scope chat hit, one code hit (source_type tagging + the
// unified-search DoD: "a code-related query returns a code-session hit").
const SEARCH_FIXTURE = [
  {
    source_type: "chat",
    conversation_id: "conv-1",
    session_id: null,
    turn_idx: null,
    code_project_id: null,
    project_name: null,
    title: "Out of scope",
    summary: null,
    similarity: 0.9,
    score: 0.9,
    recency: "2026-01-01",
    resolved: false,
    chunk_idx: null,
    message_start_idx: null,
    message_end_idx: null,
    snippet: "...out of scope...",
  },
  {
    source_type: "chat",
    conversation_id: "conv-2",
    session_id: null,
    turn_idx: null,
    code_project_id: null,
    project_name: null,
    title: "In scope",
    summary: null,
    similarity: 0.8,
    score: 0.8,
    recency: "2026-01-02",
    resolved: false,
    chunk_idx: null,
    message_start_idx: null,
    message_end_idx: null,
    snippet: "...in scope...",
  },
  {
    source_type: "code",
    conversation_id: null,
    session_id: "session-1",
    turn_idx: 3,
    code_project_id: "proj-1",
    project_name: "membral",
    title: "Fixing the hook",
    summary: null,
    similarity: null,
    score: 0.6,
    recency: "2026-01-03",
    resolved: true,
    chunk_idx: null,
    message_start_idx: null,
    message_end_idx: null,
    snippet: "...code turn snippet...",
  },
];

function makeSupabase(
  opts: {
    scopeResolves?: boolean;
    withinBound?: boolean;
    scopedConvVisible?: boolean;
    codeProjectsRows?: unknown[];
    /** id -> conversations.source, consulted by excludeCodeLaneChatHits' `.from("conversations")` lookup (W6/D7 review round 2). Absent id -> "chatgpt" (a normal chat row). */
    conversationSources?: Record<string, string>;
    /** When true, the `.from("conversations")` lookup errors instead of resolving — exercises the fail-open path. */
    conversationSourceLookupFails?: boolean;
  } = {},
) {
  const scopeResolves = opts.scopeResolves ?? true;
  const withinBound = opts.withinBound ?? true;
  const scopedConvVisible = opts.scopedConvVisible ?? true;
  const codeProjectsRows = opts.codeProjectsRows ?? [];
  const conversationSources = opts.conversationSources ?? {};
  const conversationSourceLookupFails = opts.conversationSourceLookupFails ?? false;
  const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
    if (name === "mcp_resolve_scope") {
      if (!scopeResolves) return Promise.resolve({ data: null, error: null });
      return Promise.resolve({ data: { id: "area-space", label: args.p_scope as string }, error: null });
    }
    if (name === "mcp_scope_within") {
      return Promise.resolve({ data: withinBound, error: null });
    }
    if (name === "mcp_scoped_conversation") {
      // Out-of-scope / nonexistent -> null (404-equivalent). Mirrors the SQL:
      // a scoped fetch of an out-of-scope id returns null.
      const visible = args.p_scope_id == null || scopedConvVisible;
      return Promise.resolve({
        data: visible ? { id: args.p_conversation_id, source: "chatgpt", title: "c", messages: [] } : null,
        error: null,
      });
    }
    if (name === "mcp_search_unified") {
      // Scope (p_scope_id) restricts the CHAT leg only — code hits have no
      // LifeArea membership to check, so they're gated purely by
      // p_include_code, mirroring the real RPC's design (migration 044).
      const chatRows = args.p_scope_id
        ? SEARCH_FIXTURE.filter((r) => r.source_type === "chat" && r.conversation_id === "conv-2")
        : SEARCH_FIXTURE.filter((r) => r.source_type === "chat");
      const codeRows = args.p_include_code === false ? [] : SEARCH_FIXTURE.filter((r) => r.source_type === "code");
      return Promise.resolve({ data: [...chatRows, ...codeRows], error: null });
    }
    if (name === "code_projects_list") {
      return Promise.resolve({ data: codeProjectsRows, error: null });
    }
    throw new Error(`unexpected rpc: ${name}`);
  });
  // excludeCodeLaneChatHits' own `.from("conversations").select("id,
  // source").eq("user_id",...).in("id", ids)` lookup (W6/D7 review round 2).
  const from = vi.fn((table: string) => {
    if (table !== "conversations") throw new Error(`unexpected table: ${table}`);
    let ids: string[] = [];
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: (_col: string, values: string[]) => {
        ids = values;
        return builder;
      },
      // biome-ignore lint/suspicious/noThenProperty: mimics supabase-js's thenable query builder (real code awaits it directly) — same precedent as fake-supabase.ts / bridge/context/route.test.ts
      then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
        if (conversationSourceLookupFails) {
          return Promise.resolve({ data: null, error: { message: "permission denied" } }).then(resolve, reject);
        }
        const data = ids.map((id) => ({ id, source: conversationSources[id] ?? "chatgpt" }));
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return builder;
  });
  return { rpc, from } as unknown as SupabaseClient;
}

describe("resolveScopeId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns null when no scope is requested (unscoped)", async () => {
    const supabase = makeSupabase();
    expect(await resolveScopeId(supabase, "user-1", undefined)).toBeNull();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("a scope string never resolves (LifeAreas went with the kg_* graph, migration 134) and makes no RPC", async () => {
    const supabase = makeSupabase();
    await expect(resolveScopeId(supabase, "user-1", "Space")).rejects.toThrow(UnknownScopeError);
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("throws UnknownScopeError for an unresolvable scope", async () => {
    const supabase = makeSupabase({ scopeResolves: false });
    await expect(resolveScopeId(supabase, "user-1", "Nonexistent")).rejects.toThrow(UnknownScopeError);
  });
});

describe("scoping correctness — in-scope-only results, no leakage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0.01));
  });

  it("searchConversationsScoped with a client scope errors (no scope can resolve after migration 134) before any data RPC", async () => {
    const supabase = makeSupabase();
    await expect(searchConversationsScoped(supabase, "user-1", "hooks", "Space", 10)).rejects.toThrow(
      UnknownScopeError,
    );
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("searchConversationsScoped tags every hit's source_type, and a code hit's id is its session_id (goal 2026-07-26 step 10 DoD: a code-related query returns a code-session hit through MCP)", async () => {
    const supabase = makeSupabase();
    const result = asList(await searchConversationsScoped(supabase, "user-1", "hooks", undefined, 10));
    const chat = result.find((r) => r.id === "conv-2");
    const code = result.find((r) => r.source_type === "code");
    expect(chat?.source_type).toBe("chat");
    expect(code).toBeDefined();
    expect(code?.id).toBe("session-1"); // id resolves to session_id, not conversation_id, on a code hit
    expect(code?.session_id).toBe("session-1");
    expect(code?.turn_idx).toBe(3);
    expect(code?.project_name).toBe("membral");
  });

  it("searchConversationsScoped with includeCode=false (an area-scoped API key) excludes code hits entirely", async () => {
    const supabase = makeSupabase();
    const result = asList(await searchConversationsScoped(supabase, "user-1", "hooks", undefined, 10, null, false));
    expect(result.every((r) => r.source_type === "chat")).toBe(true);
    expect(result.map((r) => r.id).sort()).toEqual(["conv-1", "conv-2"]);
  });

  describe("residual code-lane leak (W6/D7 review round 2) — a mirrored code session must never surface as a source_type:'chat' hit", () => {
    it("drops a chat-leg hit whose conversation is source='claude-code', keeping the genuine code-leg hit for the same session", async () => {
      // conv-2 (normally a plain chat hit in SEARCH_FIXTURE) is itself the
      // mirrored conversation for session-1 — the exact duplication
      // mcp_search_unified's chat leg can produce once code sessions are
      // mirrored into `conversations`.
      const supabase = makeSupabase({ conversationSources: { "conv-2": "claude-code" } });
      const result = asList(await searchConversationsScoped(supabase, "user-1", "hooks", undefined, 10));
      const ids = result.map((r) => r.id);
      expect(ids).not.toContain("conv-2");
      expect(ids).toContain("session-1"); // the genuine code-leg hit survives
      expect(ids).toContain("conv-1"); // a real chat hit is untouched
      expect(result.every((r) => !(r.source_type === "chat" && r.id === "conv-2"))).toBe(true);
    });

    it("filters the code lane even when includeCode=false (an area-scoped key) — a chat-type result must always mean genuine chat content", async () => {
      const supabase = makeSupabase({ conversationSources: { "conv-2": "claude-code" } });
      const result = asList(await searchConversationsScoped(supabase, "user-1", "hooks", undefined, 10, null, false));
      expect(result.every((r) => r.source_type === "chat")).toBe(true);
      expect(result.map((r) => r.id)).toEqual(["conv-1"]);
    });

    it("leaves every hit untouched when no chat hit is code-lane", async () => {
      const supabase = makeSupabase();
      const result = asList(await searchConversationsScoped(supabase, "user-1", "hooks", undefined, 10));
      expect(result.map((r) => r.id).sort()).toEqual(["conv-1", "conv-2", "session-1"]);
    });

    it("fails OPEN (keeps every hit, including the code-lane duplicate) when the source lookup itself errors", async () => {
      const supabase = makeSupabase({
        conversationSources: { "conv-2": "claude-code" },
        conversationSourceLookupFails: true,
      });
      const result = asList(await searchConversationsScoped(supabase, "user-1", "hooks", undefined, 10));
      expect(result.map((r) => r.id)).toContain("conv-2");
    });
  });

  it("searchConversationsScoped exposes a chunk-resolved chat hit's message span (goal step 11 DoD: a known-fact query returns the containing message span, not just a conversation title)", async () => {
    const rpc = vi.fn((name: string) => {
      if (name === "mcp_resolve_scope") return Promise.resolve({ data: null, error: null });
      if (name === "mcp_search_unified") {
        return Promise.resolve({
          data: [
            {
              source_type: "chat",
              conversation_id: "conv-9",
              session_id: null,
              turn_idx: null,
              code_project_id: null,
              project_name: null,
              title: "A long thread",
              summary: null,
              similarity: null,
              score: 0.7,
              recency: "2026-01-05",
              resolved: true,
              chunk_idx: 4,
              message_start_idx: 12,
              message_end_idx: 14,
              snippet: "...the buried fact...",
            },
          ],
          error: null,
        });
      }
      throw new Error(`unexpected rpc: ${name}`);
    });
    const supabase = { rpc } as unknown as SupabaseClient;

    const result = asList(await searchConversationsScoped(supabase, "user-1", "the buried fact", undefined, 10));
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      source_type: "chat",
      id: "conv-9",
      resolved: true,
      chunk_idx: 4,
      message_start_idx: 12,
      message_end_idx: 14,
      snippet: "...the buried fact...",
    });
  });

  it("MINOR-3: a code hit with no session title falls back to its summary via sessionDisplayTitle, instead of surfacing title: null", async () => {
    const rpc = vi.fn((name: string) => {
      if (name === "mcp_resolve_scope") return Promise.resolve({ data: null, error: null });
      if (name === "mcp_search_unified") {
        return Promise.resolve({
          data: [
            {
              source_type: "code",
              conversation_id: null,
              session_id: "session-untitled",
              turn_idx: 5,
              code_project_id: "proj-1",
              project_name: "membral",
              title: null,
              summary: "Fixed the flaky pre-commit hook by pinning the node version.",
              similarity: null,
              score: 0.5,
              recency: "2026-01-06",
              resolved: true,
              chunk_idx: null,
              message_start_idx: null,
              message_end_idx: null,
              snippet: "...pre-commit hook...",
            },
          ],
          error: null,
        });
      }
      throw new Error(`unexpected rpc: ${name}`);
    });
    const supabase = { rpc } as unknown as SupabaseClient;

    const result = asList(await searchConversationsScoped(supabase, "user-1", "pre-commit hook", undefined, 10));
    expect(result).toHaveLength(1);
    // sessionDisplayTitle falls back to the (untruncated, short) summary text.
    expect(result[0].title).toBe("Fixed the flaky pre-commit hook by pinning the node version.");
    // The public `summary` field keeps its documented "always null on a code
    // hit" contract — the raw RPC summary is consumed only for the title
    // fallback above, never re-exposed here.
    expect(result[0].summary).toBeNull();
  });

  it("an unknown scope on search_conversations also errors cleanly without calling the data RPC", async () => {
    const supabase = makeSupabase({ scopeResolves: false });
    await expect(searchConversationsScoped(supabase, "user-1", "hooks", "Nonexistent", 10)).rejects.toThrow(
      UnknownScopeError,
    );
    expect(supabase.rpc).not.toHaveBeenCalled();
  });
});

describe("resolveEffectiveScopeId — per-token area bound (issue #83)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unscoped token (null bound) behaves like resolveScopeId: no scope -> null", async () => {
    const supabase = makeSupabase();
    expect(await resolveEffectiveScopeId(supabase, "user-1", undefined, null)).toBeNull();
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("unscoped token with a client scope throws UnknownScopeError (nothing can resolve)", async () => {
    const supabase = makeSupabase();
    await expect(resolveEffectiveScopeId(supabase, "user-1", "Space", null)).rejects.toThrow(UnknownScopeError);
  });

  it("scoped token with NO client scope returns the token bound itself", async () => {
    const supabase = makeSupabase();
    expect(await resolveEffectiveScopeId(supabase, "user-1", undefined, "area-bound")).toBe("area-bound");
    // Never even resolves a scope — the bound is used directly.
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("ESCAPE ATTEMPT: a client scope OUTSIDE the bound throws UnknownScopeError (no existence leak)", async () => {
    const supabase = makeSupabase({ withinBound: false });
    await expect(resolveEffectiveScopeId(supabase, "user-1", "someone-elses-area", "area-bound")).rejects.toThrow(
      UnknownScopeError,
    );
  });

  it("ESCAPE ATTEMPT via a nonexistent scope throws the SAME UnknownScopeError as an out-of-bound one", async () => {
    const supabase = makeSupabase({ scopeResolves: false });
    await expect(resolveEffectiveScopeId(supabase, "user-1", "no-such-area", "area-bound")).rejects.toThrow(
      UnknownScopeError,
    );
  });

  it("search forwards p_since: null when absent, the ISO bound when given (migration 095)", async () => {
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0.01));
    const supabase = makeSupabase();
    await searchConversationsScoped(supabase, "user-1", "hooks");
    expect(supabase.rpc).toHaveBeenLastCalledWith("mcp_search_unified", expect.objectContaining({ p_since: null }));
    await searchConversationsScoped(supabase, "user-1", "hooks", undefined, 10, null, true, "2026-09-24T00:00:00.000Z");
    expect(supabase.rpc).toHaveBeenLastCalledWith(
      "mcp_search_unified",
      expect.objectContaining({ p_since: "2026-09-24T00:00:00.000Z" }),
    );
  });

  it("scoped-token data tools forward the bound as p_scope_id to the SQL RPC", async () => {
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0.01));
    const supabase = makeSupabase();
    await searchConversationsScoped(supabase, "user-1", "hooks", undefined, 10, "area-bound");
    expect(supabase.rpc).toHaveBeenCalledWith(
      "mcp_search_unified",
      expect.objectContaining({ p_scope_id: "area-bound" }),
    );
  });
});

describe("getScopedConversation — direct-id fetch is bounded in SQL (issue #83)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("unscoped token (null bound) returns the conversation", async () => {
    const supabase = makeSupabase();
    const conv = await getScopedConversation(supabase, "user-1", "conv-1", null);
    expect(conv).not.toBeNull();
    expect(supabase.rpc).toHaveBeenCalledWith("mcp_scoped_conversation", {
      p_user_id: "user-1",
      p_conversation_id: "conv-1",
      p_scope_id: null,
    });
  });

  it("DIRECT-ID ATTACK: an out-of-scope id under a scoped token returns null (404-equivalent, no leak)", async () => {
    const supabase = makeSupabase({ scopedConvVisible: false });
    const conv = await getScopedConversation(supabase, "user-1", "out-of-scope-conv", "area-bound");
    expect(conv).toBeNull();
    expect(supabase.rpc).toHaveBeenCalledWith("mcp_scoped_conversation", {
      p_user_id: "user-1",
      p_conversation_id: "out-of-scope-conv",
      p_scope_id: "area-bound",
    });
  });

  it("an in-scope id under a scoped token returns the conversation", async () => {
    const supabase = makeSupabase({ scopedConvVisible: true });
    const conv = await getScopedConversation(supabase, "user-1", "in-scope-conv", "area-bound");
    expect(conv).not.toBeNull();
  });
});

describe("query-time embedding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
  });

  it("embeds only the query/topic string, formatted as a pgvector literal", async () => {
    const supabase = makeSupabase();
    await searchConversationsScoped(supabase, "user-1", "rockets and Mars", undefined, 5);
    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      "rockets and Mars",
      expect.objectContaining({ userId: "user-1", pass: "query_embedding" }),
    );
    expect(supabase.rpc).toHaveBeenCalledWith(
      "mcp_search_unified",
      expect.objectContaining({ p_query_embedding: "[0.1,0.2,0.3]" }),
    );
  });

  it("default family: sends neither p_embedding_model nor p_min_similarity (migration 139 params stay unset)", async () => {
    const supabase = makeSupabase();
    await searchConversationsScoped(supabase, "user-1", "rockets and Mars", undefined, 5);
    const args = vi.mocked(supabase.rpc).mock.calls[0][1] as Record<string, unknown>;
    expect(args).not.toHaveProperty("p_embedding_model");
    expect(args).not.toHaveProperty("p_min_similarity");
  });
});

describe("issue #92 — monthly cost ceiling degrades tool calls instead of failing them", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockRejectedValue(new FakeEmbeddingCeilingExceededError(5, 5));
  });

  it("searchConversationsScoped passes a null embedding through (FTS-only degrade) and flags the result as degraded (M3)", async () => {
    const supabase = makeSupabase();
    const result = await searchConversationsScoped(supabase, "user-1", "hooks", undefined, 10);
    // The RPC IS still called — this is the "degrade, don't fail" path since
    // the SQL's OR clause on cosine similarity short-circuits false on a null
    // embedding, leaving plain FTS matching in effect.
    expect(supabase.rpc).toHaveBeenCalledWith(
      "mcp_search_unified",
      expect.objectContaining({ p_query_embedding: null, p_query: "hooks" }),
    );
    expect(result).not.toBeInstanceOf(Array);
    if (Array.isArray(result)) throw new Error("unreachable — narrows the type for the assertions below");
    expect(result.degraded).toBe(
      "SEARCH DEGRADED: results are keyword-only (no semantic ranking) — the monthly embedding budget is exceeded",
    );
    expect(result.conversations.map((r) => r.id).sort()).toEqual(["conv-1", "conv-2", "session-1"]);
  });

  it("a NON-ceiling embedding failure is NOT flagged as degraded — it propagates as a real tool error", async () => {
    mockGenerateEmbedding.mockRejectedValue(new Error("OpenAI quota exceeded"));
    const supabase = makeSupabase();
    await expect(searchConversationsScoped(supabase, "user-1", "rockets", undefined, 10)).rejects.toThrow(
      "OpenAI quota exceeded",
    );
  });
});

describe("D-072 / migration 139 — chat search by embedding family", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("nomic-embed-text (chat floors measured): embeds and sends its family and sem_floor as the cut", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "nomic-embed-text");
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue([0.1, 0.2, 0.3]);
    const supabase = makeSupabase();
    const result = await searchConversationsScoped(supabase, "user-1", "hooks", undefined, 10);
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith(
      "mcp_search_unified",
      expect.objectContaining({
        p_query_embedding: "[0.1,0.2,0.3]",
        p_embedding_model: "nomic-embed-text",
        p_min_similarity: 0.68,
      }),
    );
    expect(Array.isArray(result)).toBe(true);
  });

  it("an uncalibrated family (bundled ONNX): sends a null query vector, never embeds, and flags degraded", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", BUNDLED_EMBEDDING_MODEL);
    mockGenerateEmbedding.mockReset();
    const supabase = makeSupabase();
    const result = await searchConversationsScoped(supabase, "user-1", "hooks", undefined, 10);
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    const args = vi.mocked(supabase.rpc).mock.calls[0][1] as Record<string, unknown>;
    expect(args.p_query_embedding).toBeNull();
    expect(args).not.toHaveProperty("p_embedding_model");
    expect(args).not.toHaveProperty("p_min_similarity");
    if (Array.isArray(result)) throw new Error("expected the degraded shape");
    expect(result.degraded).toMatch(/local embedding model/);
  });
});

describe("W7 D3 — no embedding provider configured", () => {
  it("searchConversationsScoped returns keyword hits flagged degraded, never calling the embedder", async () => {
    for (const k of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "MEMBRAL_EMBEDDINGS_BASE_URL", "MEMBRAL_MODEL_BASE_URL"])
      vi.stubEnv(k, "");
    mockGenerateEmbedding.mockReset();
    const supabase = makeSupabase();
    const result = await searchConversationsScoped(supabase, "user-1", "hooks", undefined, 10);
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(supabase.rpc).toHaveBeenCalledWith(
      "mcp_search_unified",
      expect.objectContaining({ p_query_embedding: null, p_query: "hooks" }),
    );
    if (Array.isArray(result)) throw new Error("expected the degraded shape");
    expect(result.degraded).toMatch(/no embedding provider is configured/);
    expect(result.conversations.map((r) => r.id).sort()).toEqual(["conv-1", "conv-2", "session-1"]);
  });
});

describe("issue #92 adversarial review M3 — embedQuery logs a warning on ceiling degradation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockRejectedValue(new FakeEmbeddingCeilingExceededError(5, 5));
  });

  it("logs a warning when the ceiling degrades a tool call (issue #63-class silent-degradation guard)", async () => {
    const logModule = await import("@/lib/log");
    const warnSpy = vi.spyOn(logModule.log, "warn").mockImplementation(() => {});
    const supabase = makeSupabase();

    await searchConversationsScoped(supabase, "user-1", "rockets", undefined, 10);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("monthly embedding cost ceiling exceeded"),
      expect.objectContaining({ user_id: "user-1" }),
    );
    warnSpy.mockRestore();
  });
});

describe("issue #126 verification finding 6 — a flagged-off user degrades like the ceiling path, not an error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateEmbedding.mockRejectedValue(new FeatureDisabledError("llm"));
  });

  it("searchConversationsScoped still degrades to FTS-only rather than erroring", async () => {
    const supabase = makeSupabase();
    const result = await searchConversationsScoped(supabase, "user-1", "hooks", undefined, 10);
    expect(result).not.toBeInstanceOf(Array);
    if (Array.isArray(result)) throw new Error("unreachable — narrows the type for the assertions below");
    expect(result.degraded).toBe("AI features are not enabled for this account — keyword/empty results only");
  });

  it("logs a warning distinct from the ceiling message", async () => {
    const logModule = await import("@/lib/log");
    const warnSpy = vi.spyOn(logModule.log, "warn").mockImplementation(() => {});
    const supabase = makeSupabase();

    await searchConversationsScoped(supabase, "user-1", "rockets", undefined, 10);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("embeddings feature not enabled"),
      expect.objectContaining({ user_id: "user-1" }),
    );
    warnSpy.mockRestore();
  });
});
