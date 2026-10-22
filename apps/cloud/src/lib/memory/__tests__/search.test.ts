import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateEmbedding = vi.fn();
vi.mock("@/lib/embeddings", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
  EmbeddingCeilingExceededError: class EmbeddingCeilingExceededError extends Error {},
}));
vi.mock("@/lib/feature-flags", () => ({
  FeatureDisabledError: class FeatureDisabledError extends Error {},
}));

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { EmbeddingCeilingExceededError } from "@/lib/embeddings";
import { log } from "@/lib/log";
import {
  AmbiguousProjectError,
  boostedRelevance,
  envMinSimilarity,
  matchProjectsByShortName,
  memorySearch,
  passesRelevanceFloor,
  RAW_SEED_RECORDS,
  RAW_TEXT_POINTER,
  recordQueryPrefixEnabled,
  resolveProjectId,
} from "../search";
import { fitToTokenBudget } from "../token-budget";

// W7 D3: search embeds only when a provider is configured (embeddingsConfigured); these tests mock the embedder, so give them a key.
beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
});

const USER = "user-1";
const PROJECT_A = "proj-a";
const PROJECT_B = "proj-b";

function baseRecord(overrides: Partial<Row> & { id: string }): Row {
  return {
    code_session_id: "sess-1",
    code_project_id: PROJECT_A,
    agent_id: null,
    source: "hook",
    kind: "decision",
    text: "keyed the cache on repo + branch",
    quote: "keyed the cache on repo + branch",
    turn_idx: 0,
    turn_role: "assistant",
    ref: null,
    ref_kind: null,
    branch: null,
    head_sha: null,
    thread: null,
    paths: [],
    verified: false,
    durable: true,
    observed_durable: false,
    recurrence_count: 1,
    scope: "project",
    confidence: 0.5,
    supersedes: null,
    retired_at: null,
    chat_conversation_id: null,
    created_at: "2026-09-10T00:00:00Z",
    ...overrides,
  };
}

// Stands in for memory_search_scored (migration 116): applies the project,
// kind and p_since filters, and gives every row passing per-leg signals unless
// the row sets its own (similarity / lex_hits / query_lexemes / observed_at).
const rpcCalls: Record<string, unknown>[] = [];
function makeRpc(rows: Row[]) {
  return {
    memory_search_scored: (args: Record<string, unknown>) => {
      rpcCalls.push(args);
      const filtered = rows
        .map(
          (r): Row => ({
            similarity: 0.6,
            lex_hits: 1,
            query_lexemes: 1,
            leg_score: 0.02,
            observed_at: r.created_at,
            ...r,
          }),
        )
        .filter((r) => {
          if (args.p_code_project_id && r.code_project_id !== args.p_code_project_id) return false;
          if (Array.isArray(args.p_kinds) && !args.p_kinds.includes(r.kind)) return false;
          if (args.p_since && String(r.observed_at) < String(args.p_since)) return false;
          return true;
        });
      return { data: filtered.slice(0, (args.p_limit as number) ?? 20), error: null };
    },
  };
}

describe("resolveProjectId", () => {
  it("returns the code-scoped key's bound project, ignoring a mismatched repo param", async () => {
    const supabase = makeFakeSupabase({
      code_projects: [{ id: PROJECT_A, user_id: USER, repo_identity: "github.com/acme/other" }],
    });
    const resolved = await resolveProjectId(supabase, USER, "github.com/acme/whatever", PROJECT_A);
    expect(resolved).toBe(PROJECT_A);
  });

  it("resolves an unscoped call's project string via repo-identity", async () => {
    const supabase = makeFakeSupabase({
      code_projects: [{ id: PROJECT_A, user_id: USER, repo_identity: "github.com/acme/membral" }],
    });
    const resolved = await resolveProjectId(supabase, USER, "https://github.com/acme/membral.git", null);
    expect(resolved).toBe(PROJECT_A);
  });

  it("returns null when unscoped and no project given", async () => {
    const supabase = makeFakeSupabase({ code_projects: [] });
    expect(await resolveProjectId(supabase, USER, undefined, null)).toBeNull();
  });

  // ---- G (2026-09-25): short repo name resolution ----
  it("resolves a short repo name (one path segment) when there's no exact repo-identity match", async () => {
    const supabase = makeFakeSupabase({
      code_projects: [{ id: PROJECT_A, user_id: USER, repo_identity: "github.com/acme/example-repo" }],
    });
    expect(await resolveProjectId(supabase, USER, "example-repo", null)).toBe(PROJECT_A);
  });

  it("resolves the two-segment owner/repo short form", async () => {
    const supabase = makeFakeSupabase({
      code_projects: [{ id: PROJECT_A, user_id: USER, repo_identity: "github.com/acme/example-repo" }],
    });
    expect(await resolveProjectId(supabase, USER, "acme/example-repo", null)).toBe(PROJECT_A);
  });

  it("resolves via display_name when it doesn't match any repo_identity segment", async () => {
    const supabase = makeFakeSupabase({
      code_projects: [
        { id: PROJECT_A, user_id: USER, repo_identity: "github.com/acme/repo", display_name: "the CodeHub app" },
      ],
    });
    expect(await resolveProjectId(supabase, USER, "the CodeHub app", null)).toBe(PROJECT_A);
  });

  it("is case-insensitive", async () => {
    const supabase = makeFakeSupabase({
      code_projects: [{ id: PROJECT_A, user_id: USER, repo_identity: "github.com/acme/Membral-Personal" }],
    });
    expect(await resolveProjectId(supabase, USER, "MEMBRAL-PERSONAL", null)).toBe(PROJECT_A);
  });

  it("throws AmbiguousProjectError naming every candidate when more than one project matches", async () => {
    const supabase = makeFakeSupabase({
      code_projects: [
        { id: PROJECT_A, user_id: USER, repo_identity: "github.com/acme/example-repo" },
        { id: PROJECT_B, user_id: USER, repo_identity: "gitlab.com/other/example-repo" },
      ],
    });
    await expect(resolveProjectId(supabase, USER, "example-repo", null)).rejects.toThrow(AmbiguousProjectError);
  });

  it("a code-scoped key's bound wins even when a short name is also passed", async () => {
    const supabase = makeFakeSupabase({
      code_projects: [{ id: PROJECT_A, user_id: USER, repo_identity: "github.com/acme/other-repo" }],
    });
    expect(await resolveProjectId(supabase, USER, "example-repo", PROJECT_A)).toBe(PROJECT_A);
  });

  it("no short-name match at all -> null, same as today's unresolvable case", async () => {
    const supabase = makeFakeSupabase({
      code_projects: [{ id: PROJECT_A, user_id: USER, repo_identity: "github.com/acme/other-repo" }],
    });
    expect(await resolveProjectId(supabase, USER, "no-such-project", null)).toBeNull();
  });
});

describe("matchProjectsByShortName", () => {
  const projects = [
    { id: "p1", display_name: null, repo_identity: "github.com/acme/example-repo" },
    { id: "p2", display_name: "sibling", repo_identity: "github.com/acme/sibling-repo" },
  ];

  it("matches the last repo_identity segment", () => {
    expect(matchProjectsByShortName(projects, "example-repo").map((p) => p.id)).toEqual(["p1"]);
  });

  it("matches owner/repo", () => {
    expect(matchProjectsByShortName(projects, "acme/example-repo").map((p) => p.id)).toEqual(["p1"]);
  });

  it("matches display_name over an unrelated repo_identity", () => {
    expect(matchProjectsByShortName(projects, "sibling").map((p) => p.id)).toEqual(["p2"]);
  });

  it("returns no matches for an unrelated string", () => {
    expect(matchProjectsByShortName(projects, "totally-unrelated")).toEqual([]);
  });

  it("returns no matches for an empty/whitespace string", () => {
    expect(matchProjectsByShortName(projects, "   ")).toEqual([]);
  });
});

describe("memorySearch", () => {
  beforeEach(() => {
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
  });

  it("respects project scope: a code-scoped key never sees another project's records", async () => {
    const rows = [
      baseRecord({ id: "a", code_project_id: PROJECT_A }),
      baseRecord({ id: "b", code_project_id: PROJECT_B }),
    ];
    const inserted: Row[] = [];
    const supabase = makeFakeSupabase(
      {
        code_session_turns: [{ session_id: "sess-1", idx: 0, text: "keyed the cache on repo + branch", props: {} }],
        code_projects: [{ id: PROJECT_A, display_name: "acme/a", repo_identity: "acme/a" }],
        memory_branch_state: [],
        conversations: [],
        memory_recall_events: [],
      },
      { rpc: makeRpc(rows), onInsert: (table, row) => table === "memory_recall_events" && inserted.push(row) },
    );

    const result = await memorySearch(supabase, USER, PROJECT_A, { query: "cache key" });

    expect(result.records.map((r) => r.id)).toEqual(["a"]);
  });

  it("writes exactly one memory_recall_events row per call, carrying the recall_token", async () => {
    const rows = [baseRecord({ id: "a" })];
    const inserted: Row[] = [];
    const supabase = makeFakeSupabase(
      {
        code_session_turns: [{ session_id: "sess-1", idx: 0, text: "keyed the cache on repo + branch", props: {} }],
        code_projects: [],
        memory_branch_state: [],
        conversations: [],
      },
      { rpc: makeRpc(rows), onInsert: (table, row) => table === "memory_recall_events" && inserted.push(row) },
    );

    await memorySearch(supabase, USER, null, { query: "cache key", recall_token: "v1.abc.def" });

    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ tool: "memory_search", user_id: USER, recall_token: "v1.abc.def" });
    expect(inserted[0].record_ids).toEqual(["a"]);
    // #361: an MCP read tool's event defaults to surface 'mcp' with no harness session id.
    expect(inserted[0]).toMatchObject({ surface: "mcp", harness_session_id: null });
  });

  it("marks a record verified when its quote grounds at the stored turn, and flags it verified:false otherwise", async () => {
    const rows = [
      // >= 40 chars and sharing a content word with `text`: the shared
      // grounding predicate's specificity gate (grounding.ts) applies here too.
      baseRecord({ id: "grounded", quote: "keyed the cache on repo + branch for every run" }),
      baseRecord({ id: "ungrounded", code_session_id: "sess-2", quote: "a sentence nobody wrote" }),
    ];
    const supabase = makeFakeSupabase(
      {
        code_session_turns: [
          { session_id: "sess-1", idx: 0, text: "keyed the cache on repo + branch for every run", props: {} },
          { session_id: "sess-2", idx: 0, text: "totally unrelated", props: {} },
        ],
        code_projects: [],
        memory_branch_state: [],
        conversations: [],
      },
      { rpc: makeRpc(rows) },
    );

    const result = await memorySearch(supabase, USER, null, { query: "cache", limit: 20 });
    const byId = new Map(result.records.map((r) => [r.id, r]));
    expect(byId.get("grounded")?.verified).toBe(true);
    expect(byId.get("ungrounded")?.verified).toBe(false);
    // unverified is never dropped -- both records are still returned.
    expect(result.records).toHaveLength(2);
  });

  it("serves the RPC's most relevant record first, over kind order (live pnpm finding, 2026-09-25)", async () => {
    const quote = "keyed the cache on repo + branch for every run";
    const rows = [
      // RPC order = relevance order; the exact hit is a learning, which §4's
      // tool kind order alone ranks below decisions and blockers.
      baseRecord({ id: "exact", kind: "learning", quote, leg_score: 0.033 }),
      baseRecord({ id: "loose-blocker", kind: "blocker", quote, leg_score: 0.02 }),
      baseRecord({ id: "loose-decision", kind: "decision", quote, leg_score: 0.02 }),
    ];
    const supabase = makeFakeSupabase(
      {
        code_session_turns: [{ session_id: "sess-1", idx: 0, text: quote, props: {} }],
        code_projects: [],
        memory_branch_state: [],
        conversations: [],
      },
      { rpc: makeRpc(rows) },
    );

    const result = await memorySearch(
      supabase,
      USER,
      null,
      { query: "always use pnpm" },
      { now: new Date("2026-09-12T00:00:00Z") },
    );
    expect(result.records.every((r) => r.verified)).toBe(true);
    // relevance first; the two tied on score fall back to kind order (decision > blocker).
    expect(result.records.map((r) => r.id)).toEqual(["exact", "loose-decision", "loose-blocker"]);
  });

  it("filters by kind when requested", async () => {
    const rows = [baseRecord({ id: "d", kind: "decision" }), baseRecord({ id: "b", kind: "blocker" })];
    const supabase = makeFakeSupabase(
      {
        code_session_turns: [{ session_id: "sess-1", idx: 0, text: "keyed the cache on repo + branch", props: {} }],
        code_projects: [],
        memory_branch_state: [],
        conversations: [],
      },
      { rpc: makeRpc(rows) },
    );

    const result = await memorySearch(
      supabase,
      USER,
      null,
      { query: "cache", kind: "blocker" },
      { now: new Date("2026-09-12T00:00:00Z") },
    );
    expect(result.records.map((r) => r.id)).toEqual(["b"]);
  });

  // #436: a blocker older than BLOCKER_FRESH_DAYS is hidden (never retired) and counted.
  it("hides an 8-day-old blocker and reports stale_blockers_hidden", async () => {
    const rows = [
      baseRecord({ id: "d", kind: "decision", created_at: "2026-09-01T00:00:00Z" }),
      baseRecord({ id: "old", kind: "blocker", created_at: "2026-09-04T00:00:00Z" }),
      baseRecord({ id: "new", kind: "blocker", created_at: "2026-09-10T00:00:00Z" }),
    ];
    const supabase = makeFakeSupabase(
      {
        code_session_turns: [{ session_id: "sess-1", idx: 0, text: "keyed the cache on repo + branch", props: {} }],
        code_projects: [],
        memory_branch_state: [],
        conversations: [],
      },
      { rpc: makeRpc(rows) },
    );
    const now = new Date("2026-09-12T00:00:00Z");
    const result = await memorySearch(supabase, USER, null, { query: "cache" }, { now });
    expect(result.records.map((r) => r.id).sort()).toEqual(["d", "new"]);
    expect(result.stale_blockers_hidden).toBe(1);
    const fresh = await memorySearch(
      supabase,
      USER,
      null,
      { query: "cache" },
      { now: new Date("2026-09-10T12:00:00Z") },
    );
    expect(fresh.stale_blockers_hidden).toBeUndefined();
    const archive = await memorySearch(supabase, USER, null, { query: "cache" }, { now, includeStaleBlockers: true });
    expect(archive.records.map((r) => r.id).sort()).toEqual(["d", "new", "old"]);
  });

  it("throws for an empty query rather than silently returning everything", async () => {
    const supabase = makeFakeSupabase({}, { rpc: makeRpc([]) });
    await expect(memorySearch(supabase, USER, null, { query: "   " })).rejects.toThrow(/query is required/);
  });
});

// ---- W3: dates, recency, relevance floor, token budget ----
describe("memorySearch W3", () => {
  const NOW = new Date("2026-10-03T12:00:00Z");
  const W3 = { now: NOW, floor: true, dateHints: true };
  const quote = "keyed the cache on repo + branch for every run";
  const seed = () => ({
    code_session_turns: [
      { session_id: "sess-1", idx: 0, text: quote, props: {} },
      { session_id: "sess-2", idx: 0, text: quote, props: {} },
    ],
    code_projects: [],
    memory_branch_state: [],
    conversations: [],
  });

  beforeEach(() => {
    rpcCalls.length = 0;
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
  });

  it("'last week' ranks the record from last week above a stronger older match, and strips the phrase", async () => {
    const rows = [
      // The older record is the RPC's better match (rank 1 vs rank 3 in RRF terms).
      baseRecord({ id: "old", quote, leg_score: 1 / 61 + 1 / 61, observed_at: "2026-07-01T10:00:00Z" }),
      baseRecord({ id: "recent", quote, leg_score: 1 / 63 + 1 / 63, observed_at: "2026-09-29T10:00:00Z" }),
    ];
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(rows) });

    const result = await memorySearch(supabase, USER, null, { query: "cache key decision last week" }, W3);

    expect(result.records.map((r) => r.id)).toEqual(["recent", "old"]); // a boost, not a filter: old still served
    expect(result.date_hint).toMatchObject({ phrase: "last week", applied: "boost" });
    expect(rpcCalls[0].p_query).toBe("cache key decision");
    expect(mockGenerateEmbedding.mock.calls[0][0]).toBe("cache key decision");
    expect(rpcCalls[0].p_since).toBeNull();
  });

  it("with no date, recency only breaks near-ties: a clearly better older match stays first", async () => {
    const rows = [
      baseRecord({ id: "old-strong", quote, leg_score: 2 / 61, observed_at: "2026-06-01T00:00:00Z" }),
      baseRecord({ id: "new-weak", quote, leg_score: 2 / 70, observed_at: "2026-10-02T00:00:00Z" }),
      baseRecord({ id: "old-tie", quote, leg_score: 2 / 75, observed_at: "2026-06-01T00:00:00Z" }),
      baseRecord({ id: "new-tie", quote, leg_score: 2 / 75, observed_at: "2026-10-02T00:00:00Z" }),
    ];
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(rows) });
    const result = await memorySearch(supabase, USER, null, { query: "cache key" }, W3);
    expect(result.records.map((r) => r.id)).toEqual(["old-strong", "new-weak", "new-tie", "old-tie"]);
    expect(result.date_hint).toBeUndefined();
  });

  it("days is a hard filter on observed time, passed to the RPC as p_since", async () => {
    const rows = [
      baseRecord({ id: "inside", quote, observed_at: "2026-10-01T00:00:00Z" }),
      baseRecord({ id: "outside", quote, observed_at: "2026-09-01T00:00:00Z" }),
    ];
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(rows) });
    const result = await memorySearch(supabase, USER, null, { query: "cache", days: 7 }, W3);
    expect(rpcCalls[0].p_since).toBe("2026-09-26T12:00:00.000Z");
    expect(result.since).toBe("2026-09-26T12:00:00.000Z");
    expect(result.records.map((r) => r.id)).toEqual(["inside"]);
  });

  describe("L2 history: replacement looked up outside the pool", () => {
    const withReplacement = (createdAt: string) => ({
      ...seed(),
      session_memories: [
        { id: "new", user_id: USER, supersedes: "old", retired_at: null, created_at: createdAt },
        // A retired replacement hides nothing.
        {
          id: "dead",
          user_id: USER,
          supersedes: "old",
          retired_at: "2026-09-30T00:00:00Z",
          created_at: "2026-09-29T00:00:00Z",
        },
        {
          id: "other-user",
          user_id: "user-2",
          supersedes: "old",
          retired_at: null,
          created_at: "2026-09-05T00:00:00Z",
        },
      ],
    });
    const pool = [baseRecord({ id: "old", quote, observed_at: "2026-09-01T10:00:00Z" })];

    it("include_superseded serves the replaced record WITH its superseded_by marker although the replacement is not in the pool", async () => {
      const supabase = makeFakeSupabase(withReplacement("2026-09-25T08:00:00Z"), { rpc: makeRpc(pool) });
      const result = await memorySearch(supabase, USER, null, { query: "cache", include_superseded: true }, W3);
      expect(rpcCalls[0].p_include_retired).toBe(true);
      expect(result.records.map((r) => r.id)).toEqual(["old"]);
      expect(result.records[0].superseded_by).toEqual({ id: "new", on: "2026-09-25" });
    });

    it("a past date phrase keeps the record only if its replacement came after that date", async () => {
      const kept = makeFakeSupabase(withReplacement("2026-09-25T08:00:00Z"), { rpc: makeRpc(pool) });
      const a = await memorySearch(kept, USER, null, { query: "cache on Sept 20" }, W3);
      expect(a.records.map((r) => r.id)).toEqual(["old"]);
      expect(a.records[0].superseded_by?.id).toBe("new");
      const hidden = makeFakeSupabase(withReplacement("2026-09-10T08:00:00Z"), { rpc: makeRpc(pool) });
      const b = await memorySearch(hidden, USER, null, { query: "cache on Sept 20" }, W3);
      expect(b.records).toEqual([]);
    });

    it("without history the RPC keeps excluding replaced rows and no replacement read happens", async () => {
      const supabase = makeFakeSupabase(withReplacement("2026-09-25T08:00:00Z"), { rpc: makeRpc(pool) });
      await memorySearch(supabase, USER, null, { query: "cache" }, W3);
      expect(rpcCalls[0].p_include_retired).toBe(false);
    });
  });

  it("since wins over days and rejects a bad date with a usable message", async () => {
    const rows = [baseRecord({ id: "a", quote, observed_at: "2026-09-21T00:00:00Z" })];
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(rows) });
    const result = await memorySearch(supabase, USER, null, { query: "cache", since: "2026-09-20", days: 1 }, W3);
    expect(rpcCalls[0].p_since).toBe("2026-09-20T00:00:00.000Z");
    expect(result.records.map((r) => r.id)).toEqual(["a"]);
    await expect(memorySearch(supabase, USER, null, { query: "cache", since: "last tuesday" })).rejects.toThrow(
      /Invalid since/,
    );
  });

  it("nothing relevant -> records [] plus a reason, not the nearest ten", async () => {
    // Shaped like the calibration's off-topic queries: cosine <= 0.47, one of four lexemes.
    const rows = Array.from({ length: 10 }, (_, i) =>
      baseRecord({ id: `weak-${i}`, quote, similarity: 0.46 - i * 0.01, lex_hits: i < 3 ? 1 : 0, query_lexemes: 4 }),
    );
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(rows) });
    const result = await memorySearch(supabase, USER, null, { query: "sourdough starter hydration ratio" }, W3);
    expect(result.records).toEqual([]);
    expect(result.reason).toMatch(/below the relevance floor/);
    expect(result.reason).toContain(RAW_TEXT_POINTER.trim());
  });

  it("an empty candidate set also explains itself", async () => {
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc([]) });
    const result = await memorySearch(supabase, USER, null, { query: "ukulele" }, W3);
    expect(result).toMatchObject({ records: [], reason: `No memory records match "ukulele".${RAW_TEXT_POINTER}` });
    expect(result.reason).toContain("search_conversations");
    expect(result.reason).toContain("true when said");
  });

  it("a query that is only a date searches its own words instead of nothing", async () => {
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc([baseRecord({ id: "a", quote })]) });
    const result = await memorySearch(supabase, USER, null, { query: "yesterday" }, W3);
    expect(rpcCalls[0].p_query).toBe("yesterday");
    expect(result.date_hint?.phrase).toBe("yesterday");
    expect(result.records.map((r) => r.id)).toEqual(["a"]);
  });

  it("embeddings down (no query vector): no floor, every keyword match served, with a degraded note", async () => {
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockRejectedValue(new EmbeddingCeilingExceededError(1, 1));
    // What the RPC returns keyword-only: similarity null, one of four lexemes.
    const rows = [
      baseRecord({ id: "kw-1", quote, similarity: null, lex_hits: 1, query_lexemes: 4 }),
      baseRecord({ id: "kw-2", quote, similarity: null, lex_hits: 1, query_lexemes: 4 }),
    ];
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(rows) });
    const result = await memorySearch(supabase, USER, null, { query: "cache key repo branch" }, W3);
    expect(rpcCalls[0].p_query_embedding).toBeNull();
    expect(result.records.map((r) => r.id).sort()).toEqual(["kw-1", "kw-2"]);
    expect(result.degraded).toMatch(/keyword-only/);
    expect(result.degraded).toMatch(/relevance floor is off/);
  });

  it("a database without memory_search_scored is an error, not a fallback (no memory_search_records call)", async () => {
    const oldCalls: Record<string, unknown>[] = [];
    const supabase = makeFakeSupabase(seed(), {
      rpc: {
        memory_search_scored: () => ({
          data: null,
          error: { code: "PGRST202", message: "Could not find the function public.memory_search_scored" },
        }),
        memory_search_records: (args: Record<string, unknown>) => {
          oldCalls.push(args);
          return { data: [], error: null };
        },
      },
    });
    await expect(memorySearch(supabase, USER, null, { query: "cache key" }, W3)).rejects.toThrow(
      /memory_search failed/,
    );
    await expect(memorySearch(supabase, USER, null, { query: "cache key", days: 7 }, W3)).rejects.toThrow(
      /memory_search failed/,
    );
    expect(oldCalls).toHaveLength(0);
  });

  it("defaults OFF (preamble relevance, dashboard): no floor, no date stripping, no boost, logs its own event", async () => {
    const inserted: Row[] = [];
    const rows = [
      baseRecord({ id: "old", quote, leg_score: 2 / 61, observed_at: "2026-07-01T00:00:00Z", similarity: 0.1 }),
      baseRecord({ id: "recent", quote, leg_score: 2 / 63, observed_at: "2026-09-29T00:00:00Z", similarity: 0.1 }),
    ];
    const supabase = makeFakeSupabase(seed(), {
      rpc: makeRpc(rows),
      onInsert: (table, row) => table === "memory_recall_events" && inserted.push(row),
    });
    const result = await memorySearch(supabase, USER, null, { query: "cache key last week" }, { now: NOW });
    expect(rpcCalls[0].p_query).toBe("cache key last week");
    expect(result.records.map((r) => r.id)).toEqual(["old", "recent"]);
    expect(result.date_hint).toBeUndefined();
    expect(result.reason).toBeUndefined();
    expect(inserted).toHaveLength(1);
  });

  it("logEvent: false writes no recall event (the MCP tool logs after its token budget)", async () => {
    const inserted: Row[] = [];
    const supabase = makeFakeSupabase(seed(), {
      rpc: makeRpc([baseRecord({ id: "a", quote })]),
      onInsert: (table, row) => table === "memory_recall_events" && inserted.push(row),
    });
    await memorySearch(supabase, USER, null, { query: "cache" }, { ...W3, logEvent: false });
    expect(inserted).toHaveLength(0);
  });
});

describe("passesRelevanceFloor", () => {
  it("passes a strong cosine alone, full lexical coverage alone, or partial coverage with a fair cosine", () => {
    expect(passesRelevanceFloor({ similarity: 0.5, lex_hits: 0, query_lexemes: 4 })).toBe(true);
    expect(passesRelevanceFloor({ similarity: null, lex_hits: 2, query_lexemes: 3 })).toBe(true);
    expect(passesRelevanceFloor({ similarity: null, lex_hits: 1, query_lexemes: 1 })).toBe(true);
    expect(passesRelevanceFloor({ similarity: 0.41, lex_hits: 2, query_lexemes: 5 })).toBe(true);
  });
  it("fails the off-topic shape: cosine under 0.5 with one hit of four lexemes, or one hit of two", () => {
    expect(passesRelevanceFloor({ similarity: 0.466, lex_hits: 1, query_lexemes: 4 })).toBe(false);
    expect(passesRelevanceFloor({ similarity: null, lex_hits: 1, query_lexemes: 2 })).toBe(false);
    expect(passesRelevanceFloor({ similarity: 0.3, lex_hits: 0, query_lexemes: 0 })).toBe(false);
  });
});

describe("boostedRelevance", () => {
  const now = new Date("2026-10-03T00:00:00Z");
  const window = { from: "2026-09-26T00:00:00Z", to: "2026-10-03T00:00:00Z" };
  it("at most doubles inside the date window and decays outside it", () => {
    expect(boostedRelevance(1, "2026-09-28T00:00:00Z", window, now)).toBe(2);
    const near = boostedRelevance(1, "2026-09-20T00:00:00Z", window, now);
    const far = boostedRelevance(1, "2026-06-01T00:00:00Z", window, now);
    expect(near).toBeLessThan(2);
    expect(far).toBeLessThan(near);
    expect(far).toBeGreaterThan(1);
  });
  it("without a window adds at most 5%", () => {
    expect(boostedRelevance(1, "2026-10-03T00:00:00Z", null, now)).toBeCloseTo(1.05);
    expect(boostedRelevance(1, "2026-09-03T00:00:00Z", null, now)).toBeCloseTo(1.025);
  });
});

describe("fitToTokenBudget", () => {
  it("adds records in rank order until the next would pass the budget, and reports how many it dropped", () => {
    const records = Array.from({ length: 5 }, (_, i) => ({ id: `r${i}`, text: "x".repeat(380) })); // ~100 tokens each
    const fitted = fitToTokenBudget(records, 250);
    expect(fitted.records.map((r) => r.id)).toEqual(["r0", "r1"]);
    expect(fitted.dropped).toBe(3);
    expect(fitted.tokens).toBeLessThanOrEqual(250);
  });
  it("skips a record that does not fit and keeps filling with smaller ones, listing what it left out", () => {
    const records = [
      { id: "a", text: "x".repeat(380) },
      { id: "huge", text: "x".repeat(2000) },
      { id: "b", text: "x".repeat(380) },
      { id: "tiny", text: "y" },
    ];
    const fitted = fitToTokenBudget(records, 260);
    expect(fitted.records.map((r) => r.id)).toEqual(["a", "b", "tiny"]);
    expect(fitted.skipped.map((r) => r.id)).toEqual(["huge"]);
    expect(fitted.dropped).toBe(1);
  });
  it("always keeps the first record, even when it alone is over budget", () => {
    const records = [
      { id: "big", text: "x".repeat(4000) },
      { id: "small", text: "y" },
    ];
    const fitted = fitToTokenBudget(records, 200);
    expect(fitted.records.map((r) => r.id)).toEqual(["big"]);
    expect(fitted.dropped).toBe(1);
  });
  it("estimates tokens as JSON length / 4, rounded up", () => {
    const fitted = fitToTokenBudget([{ a: "abcd" }], 1000); // {"a":"abcd"} = 12 chars
    expect(fitted.tokens).toBe(3);
  });
});

describe("memorySearch embedding family (migration 118, D-072)", () => {
  const NOW = new Date("2026-10-03T12:00:00Z");
  const quote = "keyed the cache on repo + branch for every run";
  const seed = () => ({
    code_session_turns: [{ session_id: "sess-1", idx: 0, text: quote, props: {} }],
    code_projects: [],
    memory_branch_state: [],
    conversations: [],
  });
  // Weak cosine, no lexical coverage: the default floor drops it.
  const weak = () => [baseRecord({ id: "weak", quote, similarity: 0.2, lex_hits: 0, query_lexemes: 2 })];

  beforeEach(() => {
    rpcCalls.length = 0;
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
  });
  afterEach(() => vi.unstubAllEnvs());

  it("default family, no cut override: the RPC args carry no family keys (main's 116 call); TS floor applies", async () => {
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(weak()) });
    const result = await memorySearch(supabase, USER, null, { query: "cache key" }, { now: NOW, floor: true });
    expect(rpcCalls).toHaveLength(1);
    // Exactly main's 116 call: no family keys at all.
    expect(rpcCalls[0]).toEqual({
      p_user_id: USER,
      p_query: "cache key",
      p_query_embedding: `[${new Array(1536).fill(0).join(",")}]`,
      p_code_project_id: null,
      p_kinds: null,
      p_scope: null,
      p_path: null,
      p_include_retired: false,
      p_limit: 30,
      p_since: null,
    });
    expect(result.records).toHaveLength(0);
  });

  it("a database without the family params is an error: the call is made once, with them, and not retried", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "nomic-embed-text");
    const pre118 = {
      memory_search_scored: (args: Record<string, unknown>) => {
        rpcCalls.push(args);
        return { data: null, error: { code: "PGRST202", message: "Could not find the function" } };
      },
    };
    const supabase = makeFakeSupabase(seed(), { rpc: pre118 });
    await expect(memorySearch(supabase, USER, null, { query: "cache key" }, { now: NOW, floor: true })).rejects.toThrow(
      /memory_search failed/,
    );
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]).toHaveProperty("p_embedding_model", "nomic-embed-text");
  });

  it("MEMBRAL_EMBEDDING_MIN_SIMILARITY is clamped to [-1, 1]; non-numeric is ignored", () => {
    expect(envMinSimilarity({ MEMBRAL_EMBEDDING_MIN_SIMILARITY: "3" })).toBe(1);
    expect(envMinSimilarity({ MEMBRAL_EMBEDDING_MIN_SIMILARITY: "-7" })).toBe(-1);
    expect(envMinSimilarity({ MEMBRAL_EMBEDDING_MIN_SIMILARITY: "abc" })).toBeNull();
    expect(envMinSimilarity({})).toBeNull();
  });

  it("default family + MEMBRAL_EMBEDDING_MIN_SIMILARITY: the cut is passed through", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MIN_SIMILARITY", "0.45");
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(weak()) });
    await memorySearch(supabase, USER, null, { query: "cache key" }, { now: NOW, floor: true });
    expect(rpcCalls[0].p_min_similarity).toBe(0.45);
  });

  it("a calibrated family (nomic) without an override: its own SQL cut and TS floor (L8)", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "nomic-embed-text");
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(weak()) });
    const result = await memorySearch(supabase, USER, null, { query: "cache key" }, { now: NOW, floor: true });
    expect(rpcCalls[0].p_embedding_model).toBe("nomic-embed-text");
    expect(rpcCalls[0].p_min_similarity).toBe(0.51);
    expect(result.records).toEqual([]);
  });

  it("a calibrated family keeps a record at its own floor: 0.66 cosine passes, 0.65 alone does not", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "nomic-embed-text");
    const rows = [
      baseRecord({ id: "at", quote, similarity: 0.66, lex_hits: 0, query_lexemes: 3 }),
      baseRecord({ id: "under", quote, similarity: 0.65, lex_hits: 0, query_lexemes: 3 }),
    ];
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(rows) });
    const result = await memorySearch(supabase, USER, null, { query: "cache key" }, { now: NOW, floor: true });
    expect(result.records.map((r) => r.id)).toEqual(["at"]);
  });

  it("an uncalibrated family without an override: floor off in SQL (0) and in TS", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "mxbai-embed-large");
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(weak()) });
    const result = await memorySearch(supabase, USER, null, { query: "cache key" }, { now: NOW, floor: true });
    expect(rpcCalls[0].p_embedding_model).toBe("mxbai-embed-large");
    expect(rpcCalls[0].p_min_similarity).toBe(0);
    expect(result.records.map((r) => r.id)).toEqual(["weak"]);
  });

  it("another family with an override: that cut in SQL and TS", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "nomic-embed-text");
    vi.stubEnv("MEMBRAL_EMBEDDING_MIN_SIMILARITY", "0.15");
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(weak()) });
    const result = await memorySearch(supabase, USER, null, { query: "cache key" }, { now: NOW, floor: true });
    expect(rpcCalls[0].p_min_similarity).toBe(0.15);
    expect(result.records.map((r) => r.id)).toEqual(["weak"]);
  });
});

describe("memorySearch with no embedding provider (W7 D3)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns keyword hits with a degraded note, never calls the embedder or errors", async () => {
    for (const k of ["OPENAI_API_KEY", "OPENROUTER_API_KEY", "MEMBRAL_EMBEDDINGS_BASE_URL", "MEMBRAL_MODEL_BASE_URL"])
      vi.stubEnv(k, "");
    rpcCalls.length = 0;
    mockGenerateEmbedding.mockReset();
    const quote = "keyed the cache on repo + branch";
    const supabase = makeFakeSupabase(
      {
        code_session_turns: [{ session_id: "sess-1", idx: 0, text: quote, props: {} }],
        code_projects: [],
        memory_branch_state: [],
        conversations: [],
      },
      { rpc: makeRpc([baseRecord({ id: "kw", quote, similarity: null, lex_hits: 1, query_lexemes: 1 })]) },
    );
    const result = await memorySearch(supabase, USER, null, { query: "cache" }, { floor: true });
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(rpcCalls[0].p_query_embedding).toBeNull();
    expect(result.records.map((r) => r.id)).toEqual(["kw"]);
    expect(result.degraded).toMatch(/no embedding provider is configured/);
  });

  it("a real embedding failure with a key set still throws (no catch-all)", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test");
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockRejectedValue(new Error("upstream 500"));
    const supabase = makeFakeSupabase({}, { rpc: makeRpc([]) });
    await expect(memorySearch(supabase, USER, null, { query: "cache" })).rejects.toThrow("upstream 500");
  });
});

// Prompt-time recall (docs/design/prompt-time-recall.md): measured 2026-10-08,
// a "do X" prompt naming a file found the generic env-rule memories first and
// the one ruling that made that very file the exception last.
describe("memorySearch exact anchors (prompt-time recall)", () => {
  const NOW = new Date("2026-10-08T12:00:00Z");
  const PROMPT =
    "lib/kg/queue.ts still reads process.env directly. Convert it to the env accessors like the rest of cloud, and make sure tests pass.";
  const rule = (id: string, text: string, leg: number) =>
    baseRecord({
      id,
      code_session_id: `s-${id}`,
      kind: "decision",
      text,
      quote: `${text} -- recorded in review`,
      leg_score: leg,
      similarity: 0.62,
      lex_hits: 4,
      query_lexemes: 12,
    });
  const rows = [
    rule("env-rule-1", "Cloud code reads env through the lib/env accessors, never process.env directly", 2 / 61),
    rule("env-rule-2", "Converted the cloud API routes to the env accessors; tests pass", 2 / 62),
    rule("env-rule-3", "G1 ratchet counts direct process.env reads in apps/cloud and must only go down", 2 / 63),
    rule("env-rule-4", "Env accessors live in apps/cloud/src/lib/env.ts and validate at first read", 2 / 64),
    rule(
      "queue-exception",
      "Keep lib/kg/queue.ts as the single G1 env exception: #157 deletes lib/kg, so converting it is wasted work",
      1 / 70,
    ),
  ];
  const seed = () => ({
    code_session_turns: rows.map((r) => ({ session_id: r.code_session_id, idx: 0, text: r.quote, props: {} })),
    code_projects: [],
    memory_branch_state: [],
    conversations: [],
  });

  beforeEach(() => {
    rpcCalls.length = 0;
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
  });

  it("ranks the record naming the prompt's file path first, above stronger generic matches", async () => {
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(rows) });
    const result = await memorySearch(supabase, USER, null, { query: PROMPT, limit: 3 }, { now: NOW, floor: true });
    expect(result.records.every((r) => r.verified)).toBe(true);
    expect(result.records[0]?.id).toBe("queue-exception");
    expect(result.records).toHaveLength(3);
  });

  it("widens the candidate pool when the query carries an anchor, so a low-fused match is still read", async () => {
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(rows) });
    await memorySearch(supabase, USER, null, { query: PROMPT, limit: 1 }, { now: NOW, floor: true });
    expect(rpcCalls[0].p_limit).toBe(60);
  });

  it("an anchored record passes the relevance floor even with weak per-leg signals", async () => {
    const weak = [
      baseRecord({
        id: "anchored",
        text: "Ruling on #157: lib/kg stays until it is deleted",
        quote: "keyed the cache on repo + branch for every run",
        similarity: 0.2,
        lex_hits: 1,
        query_lexemes: 6,
      }),
      baseRecord({ id: "unanchored", code_session_id: "sess-1", similarity: 0.2, lex_hits: 1, query_lexemes: 6 }),
    ];
    const supabase = makeFakeSupabase(
      {
        code_session_turns: [
          { session_id: "sess-1", idx: 0, text: "keyed the cache on repo + branch for every run", props: {} },
        ],
        code_projects: [],
        memory_branch_state: [],
        conversations: [],
      },
      { rpc: makeRpc(weak) },
    );
    const result = await memorySearch(
      supabase,
      USER,
      null,
      { query: "what did we decide about #157" },
      { now: NOW, floor: true },
    );
    expect(result.records.map((r) => r.id)).toEqual(["anchored"]);
  });

  it("a query with no anchors keeps the plain fused order", async () => {
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(rows) });
    const result = await memorySearch(supabase, USER, null, { query: "env accessors rule", limit: 2 }, { now: NOW });
    expect(result.records.map((r) => r.id)).toEqual(["env-rule-1", "env-rule-2"]);
    expect(rpcCalls[0].p_limit).toBe(6);
  });
});

describe("memorySearch anchor strengths (ADV findings 2026-10-08)", () => {
  const NOW = new Date("2026-10-08T12:00:00Z");
  const quote = "keyed the cache on repo + branch for every run";
  const seed = () => ({
    code_session_turns: [{ session_id: "sess-1", idx: 0, text: quote, props: {} }],
    code_projects: [],
    memory_branch_state: [],
    conversations: [],
  });
  beforeEach(() => {
    rpcCalls.length = 0;
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
  });

  it("a record matching only a code anchor does not beat a clearly stronger unanchored one", async () => {
    const rows = [
      baseRecord({ id: "strong", quote, text: "rate limiter decision", leg_score: 2 / 61 }),
      baseRecord({ id: "weak-code", quote, text: "touched rateLimiter once", leg_score: 1 / 80 }),
    ];
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(rows) });
    const result = await memorySearch(supabase, USER, null, { query: "how does `rateLimiter` back off" }, { now: NOW });
    expect(result.records.map((r) => r.id)).toEqual(["strong", "weak-code"]);
  });

  it("a code anchor breaks a near-tie toward the record naming it", async () => {
    const rows = [
      baseRecord({ id: "plain", quote, text: "rate limiter decision", leg_score: 2 / 61 }),
      baseRecord({ id: "named", quote, text: "rateLimiter backs off", leg_score: 2 / 63 }),
    ];
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(rows) });
    const result = await memorySearch(supabase, USER, null, { query: "how does `rateLimiter` back off" }, { now: NOW });
    expect(result.records.map((r) => r.id)).toEqual(["named", "plain"]);
  });

  it("a code-anchor hit alone never clears the relevance floor", async () => {
    const rows = [
      baseRecord({ id: "weak-code", quote, text: "rateLimiter", similarity: 0.2, lex_hits: 1, query_lexemes: 6 }),
    ];
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(rows) });
    const result = await memorySearch(
      supabase,
      USER,
      null,
      { query: "how does `rateLimiter` back off" },
      { now: NOW, floor: true },
    );
    expect(result.records).toEqual([]);
  });
});

describe("memorySearch bare file names are weak (re-check 2026-10-08)", () => {
  const NOW = new Date("2026-10-08T12:00:00Z");
  const quote = "keyed the cache on repo + branch for every run";
  const seed = () => ({
    code_session_turns: [{ session_id: "sess-1", idx: 0, text: quote, props: {} }],
    code_projects: [],
    memory_branch_state: [],
    conversations: [],
  });
  beforeEach(() => {
    rpcCalls.length = 0;
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
  });

  it("a record naming only README.md neither clears the floor nor outranks a stronger match", async () => {
    const rows = [
      baseRecord({ id: "strong", quote, text: "docs layout decision", leg_score: 2 / 61 }),
      baseRecord({
        id: "readme",
        quote,
        text: "touched README.md",
        leg_score: 1 / 80,
        similarity: 0.2,
        lex_hits: 1,
        query_lexemes: 6,
      }),
    ];
    const supabase = makeFakeSupabase(seed(), { rpc: makeRpc(rows) });
    const floored = await memorySearch(
      supabase,
      USER,
      null,
      { query: "update README.md for the docs layout" },
      { now: NOW, floor: true },
    );
    expect(floored.records.map((r) => r.id)).toEqual(["strong"]);
    const open = await memorySearch(
      supabase,
      USER,
      null,
      { query: "update README.md for the docs layout" },
      { now: NOW },
    );
    expect(open.records.map((r) => r.id)).toEqual(["strong", "readme"]);
  });
});

// I33 PR 4: raw session excerpts beside the records (docs/design/i33-port.md section 5).
describe("memorySearch raw excerpts (I33)", () => {
  const NOW = new Date("2026-10-03T12:00:00Z");
  const SESSION = "abcdef12-0000-4000-8000-000000000001";
  const seed = () => ({ code_session_turns: [], code_projects: [], memory_branch_state: [], conversations: [] });
  const poolRow = (over: Record<string, unknown> = {}) => ({
    pool: "r1",
    id: "unit-1",
    code_session_id: SESSION,
    code_project_id: null,
    unit: "c700",
    ord: 0,
    turn_idx: null,
    turn_from: 3,
    turn_to: 4,
    parts: [[3, 0, 80]],
    win: null,
    text: "assistant: the sync client retries with backoff and never resets the delay on success",
    similarity: 0.9,
    lex_score: null,
    sem_rank: 1,
    lex_rank: null,
    rrf: 0.03,
    session_time: "2026-10-01T10:00:00Z",
    lex_hits: 0,
    query_lexemes: 3,
    full_text: null,
    ...over,
  });
  const rawCalls: Record<string, Record<string, unknown>[]> = {};
  const rawRpc = (overrides: Record<string, (args: Record<string, unknown>) => unknown> = {}) => {
    const handler = (name: string, data: unknown) => (args: Record<string, unknown>) => {
      rawCalls[name] = [...(rawCalls[name] ?? []), args];
      return { data, error: null };
    };
    return {
      ...makeRpc([]),
      memory_raw_pools: handler("memory_raw_pools", [poolRow()]),
      memory_raw_cover: handler("memory_raw_cover", []),
      memory_raw_term_stats: handler("memory_raw_term_stats", []),
      ...overrides,
    };
  };

  beforeEach(() => {
    rpcCalls.length = 0;
    for (const k of Object.keys(rawCalls)) delete rawCalls[k];
    mockGenerateEmbedding.mockReset();
    mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0.01));
    vi.stubEnv("MEMBRAL_LOCAL", "1");
    vi.stubEnv("VERCEL", "");
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "nomic-embed-text");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("local, prefix flag off (default): the records query is embedded as written, the raw query with its own search_query prefix", async () => {
    const supabase = makeFakeSupabase(seed(), { rpc: rawRpc() });
    const result = await memorySearch(supabase, USER, null, { query: "sync retry backoff" }, { now: NOW, raw: true });
    const embedded = mockGenerateEmbedding.mock.calls.map((c) => c[0]);
    expect(embedded.sort()).toEqual(["search_query: sync retry backoff", "sync retry backoff"]);
    expect(rpcCalls[0].p_query).toBe("sync retry backoff");
    expect(recordQueryPrefixEnabled({})).toBe(false);
    expect(recordQueryPrefixEnabled({ MEMBRAL_RECORD_QUERY_PREFIX: "0" })).toBe(false);
    expect(recordQueryPrefixEnabled({ MEMBRAL_RECORD_QUERY_PREFIX: "1" })).toBe(true);
    expect(rawCalls.memory_raw_pools).toHaveLength(1);
    expect(result.served).toHaveLength(1);
  });

  it("flag on, hosted: the query is embedded as written, once", async () => {
    vi.stubEnv("MEMBRAL_RECORD_QUERY_PREFIX", "1");
    vi.stubEnv("MEMBRAL_LOCAL", "");
    const supabase = makeFakeSupabase(seed(), { rpc: { ...rawRpc(), ...makeRpc([baseRecord({ id: "rec-1" })]) } });
    await memorySearch(supabase, USER, null, { query: "cache key" }, { now: NOW, raw: true });
    expect(mockGenerateEmbedding.mock.calls.map((c) => c[0])).toEqual(["cache key"]);
  });

  it("local, MEMBRAL_RECORD_QUERY_PREFIX=1: one embedding with the search_query prefix serves records and units alike", async () => {
    vi.stubEnv("MEMBRAL_RECORD_QUERY_PREFIX", "1");
    const supabase = makeFakeSupabase(seed(), { rpc: rawRpc() });
    const result = await memorySearch(supabase, USER, null, { query: "sync retry backoff" }, { now: NOW, raw: true });
    const embedded = mockGenerateEmbedding.mock.calls.map((c) => c[0]);
    expect(embedded).toEqual(["search_query: sync retry backoff"]);
    // The prefix goes to the embedder only: the lexical leg still searches the text as written.
    expect(rpcCalls[0].p_query).toBe("sync retry backoff");
    expect(String(rpcCalls[0].p_query_embedding)).toMatch(/^\[0\.01,/);
    expect(rawCalls.memory_raw_pools).toHaveLength(1);
    expect(rawCalls.memory_raw_pools[0]).toMatchObject({
      p_user_id: USER,
      p_embedding_model: "nomic-embed-text+doc-v1",
      p_min_similarity: 0.51,
    });
    expect(result.raw_reason).toBeUndefined();
    expect(result.served).toHaveLength(1);
    expect(result.served[0]).toMatchObject({ type: "raw", id8: "abcdef12", members: ["unit-1"] });
    expect(result.served[0].text).toMatch(/^\[session abcdef12 turns 3-4, 2026-10-01\] raw excerpt: /);
  });

  it("without raw: true no raw RPC and no second embedding happen, even on a local runtime", async () => {
    const supabase = makeFakeSupabase(seed(), { rpc: { ...rawRpc(), ...makeRpc([baseRecord({ id: "rec-1" })]) } });
    const result = await memorySearch(supabase, USER, null, { query: "cache key" }, { now: NOW });
    expect(rawCalls.memory_raw_pools).toBeUndefined();
    expect(rawCalls.memory_raw_cover).toBeUndefined();
    expect(rawCalls.memory_raw_term_stats).toBeUndefined();
    expect(mockGenerateEmbedding.mock.calls.map((c) => c[0])).toEqual(["cache key"]);
    expect(result.records.map((r) => r.id)).toEqual(["rec-1"]);
    expect(result.served).toEqual([]);
    expect(result.raw_reason).toBeUndefined();
  });

  it("a family without calibrated raw cuts: no raw lines, no raw RPC, one warning across calls", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "mxbai-embed-large");
    const warn = vi.spyOn(log, "warn");
    const supabase = makeFakeSupabase(seed(), { rpc: rawRpc() });
    const a = await memorySearch(supabase, USER, null, { query: "sync retry backoff" }, { now: NOW, raw: true });
    const b = await memorySearch(supabase, USER, null, { query: "sync retry backoff" }, { now: NOW, raw: true });
    const rawWarns = warn.mock.calls.filter((c) => String(c[0]).includes("no calibrated raw-unit floors"));
    warn.mockRestore();
    expect(rawWarns).toHaveLength(1);
    // A family without a retrieval prefix embeds the query as written, once per request.
    expect(mockGenerateEmbedding.mock.calls.map((c) => c[0])).toEqual(["sync retry backoff", "sync retry backoff"]);
    expect(rawCalls.memory_raw_pools).toBeUndefined();
    expect(a.served).toEqual([]);
    expect(a.raw_reason).toMatch(/no calibrated raw-unit floors/);
    expect(b.raw_reason).toMatch(/no calibrated raw-unit floors/);
  });

  it("a failing raw RPC degrades: records still come back, no throw, the reason is set", async () => {
    const rows = [baseRecord({ id: "rec-1" })];
    const supabase = makeFakeSupabase(seed(), {
      rpc: {
        ...rawRpc({ memory_raw_pools: () => ({ data: null, error: { message: "boom" } }) }),
        ...makeRpc(rows),
      },
    });
    const result = await memorySearch(supabase, USER, null, { query: "cache key" }, { now: NOW, raw: true });
    expect(result.records.map((r) => r.id)).toEqual(["rec-1"]);
    expect(result.served.map((l) => l.type)).toEqual(["record"]);
    expect(result.raw_reason).toMatch(/memory_raw_pools failed: boom/);
    expect(result.degraded).toBe("RAW SEARCH DEGRADED");
    expect(result.degraded).not.toMatch(/boom/);
  });

  it("flag off: a failing embedding for the raw query degrades, records still come back", async () => {
    mockGenerateEmbedding.mockImplementation(async (text: string) => {
      if (text.startsWith("search_query: ")) throw new Error("embedder down");
      return new Array(1536).fill(0.01);
    });
    const supabase = makeFakeSupabase(seed(), { rpc: rawRpc() });
    const result = await memorySearch(supabase, USER, null, { query: "sync retry backoff" }, { now: NOW, raw: true });
    expect(rawCalls.memory_raw_pools).toBeUndefined();
    expect(result.served).toEqual([]);
    expect(result.raw_reason).toMatch(/embedder down/);
  });

  it("flag on: an embedder outage fails the search as it does for any records query", async () => {
    vi.stubEnv("MEMBRAL_RECORD_QUERY_PREFIX", "1");
    mockGenerateEmbedding.mockRejectedValue(new Error("embedder down"));
    const supabase = makeFakeSupabase(seed(), { rpc: rawRpc() });
    await expect(
      memorySearch(supabase, USER, null, { query: "sync retry backoff" }, { now: NOW, raw: true }),
    ).rejects.toThrow(/embedder down/);
    expect(rawCalls.memory_raw_pools).toBeUndefined();
  });

  it("hosted (no MEMBRAL_LOCAL): no raw RPC call at all; served is the records alone", async () => {
    vi.stubEnv("MEMBRAL_LOCAL", "");
    const supabase = makeFakeSupabase(seed(), {
      rpc: { ...rawRpc(), ...makeRpc([baseRecord({ id: "rec-1" })]) },
    });
    const result = await memorySearch(supabase, USER, null, { query: "cache key" }, { now: NOW, raw: true });
    expect(rawCalls.memory_raw_pools).toBeUndefined();
    expect(rawCalls.memory_raw_cover).toBeUndefined();
    expect(result.raw_reason).toBeUndefined();
    expect(result.served.map((l) => [l.type, l.members])).toEqual([["record", ["rec-1"]]]);
    // The query is embedded once, unprefixed.
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(1);
  });

  it("the raw walk is seeded with the top RAW_SEED_RECORDS records while all `limit` records are still served", async () => {
    const rows = Array.from({ length: 14 }, (_, i) => baseRecord({ id: `rec-${i + 1}` }));
    const supabase = makeFakeSupabase(seed(), { rpc: { ...rawRpc(), ...makeRpc(rows) } });
    const result = await memorySearch(supabase, USER, null, { query: "cache key", limit: 14 }, { now: NOW, raw: true });
    expect(RAW_SEED_RECORDS).toBe(10);
    expect(result.records).toHaveLength(14);
    // The served list is still fused with the raw excerpt and cut at `limit` (as before the seed cut).
    expect(result.served).toHaveLength(14);
    // The cover test (and the triggers, cards and cuts of the walk) see the first ten ranked records only.
    const seeded = rawCalls.memory_raw_cover?.[0]?.p_record_ids as string[];
    expect(seeded).toEqual(result.records.slice(0, RAW_SEED_RECORDS).map((r) => r.id));
    expect(seeded).toHaveLength(10);
  });

  it("records and raw lines are fused by rank and cut at the limit", async () => {
    const rows = [baseRecord({ id: "rec-1" }), baseRecord({ id: "rec-2" })];
    const supabase = makeFakeSupabase(seed(), {
      rpc: { ...rawRpc(), ...makeRpc(rows) },
    });
    const result = await memorySearch(supabase, USER, null, { query: "cache key", limit: 2 }, { now: NOW, raw: true });
    expect(result.records).toHaveLength(2);
    expect(result.served).toHaveLength(2);
    // Rank 1 of each side ties: the record (card) side first, then the raw excerpt.
    expect(result.served.map((l) => l.type)).toEqual(["record", "raw"]);
  });
});
