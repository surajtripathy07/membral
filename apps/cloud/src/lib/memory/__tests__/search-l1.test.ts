// L1 serve side (migration 124 projection) and the L2 follow-ups: history fails closed, the OLDEST live replacement
// wins, and a replacement belonging to another user never counts, even when it is the newer one.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockGenerateEmbedding = vi.fn();
vi.mock("@/lib/embeddings", () => ({
  generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
  EmbeddingCeilingExceededError: class EmbeddingCeilingExceededError extends Error {},
}));
vi.mock("@/lib/feature-flags", () => ({
  FeatureDisabledError: class FeatureDisabledError extends Error {},
}));

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { fetchValidity, mergeOldest, resetValidityProbeForTests } from "../reconcile/validity";
import { fetchReplacements, memorySearch } from "../search";

const USER = "user-1";
const NOW = new Date("2026-10-03T12:00:00Z");
const quote = "keyed the cache on repo + branch for every run";

beforeEach(() => {
  resetValidityProbeForTests();
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  mockGenerateEmbedding.mockReset();
  mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
});

function rec(id: string, over: Partial<Row> = {}): Row {
  return {
    id,
    user_id: USER,
    code_session_id: "sess-1",
    code_project_id: "proj-a",
    agent_id: null,
    source: "hook",
    kind: "decision",
    text: "keyed the cache on repo + branch",
    quote,
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
    similarity: 0.6,
    lex_hits: 1,
    query_lexemes: 1,
    leg_score: 0.02,
    observed_at: "2026-09-10T00:00:00Z",
    ...over,
  };
}

// A chainable PostgREST-shaped builder that resolves to a fixed error.
function failing(error: { code?: string; message: string }) {
  const q: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "in", "order", "not", "range", "limit"]) q[m] = () => q;
  // biome-ignore lint/suspicious/noThenProperty: a thenable stands in for a PostgREST builder
  q.then = (res: (v: unknown) => unknown) => res({ data: null, error });
  return q;
}

const rpc = (rows: Row[]) => ({
  memory_search_scored: () => ({ data: rows, error: null }),
});

const base = () => ({
  code_session_turns: [{ session_id: "sess-1", idx: 0, text: quote, props: {} }],
  code_projects: [],
  memory_branch_state: [],
  conversations: [],
});

describe("L1 projection on the serve path", () => {
  const OPTS = { now: NOW, floor: true, dateHints: true };

  it("hides a record whose live replacement is linked by superseded_by/valid_to", async () => {
    const supabase = makeFakeSupabase(
      {
        ...base(),
        session_memories: [
          rec("old", { superseded_by: "new", supersede_kind: "supersedes", valid_to: "2026-09-25T00:00:00Z" }),
          rec("new", { created_at: "2026-09-25T00:00:00Z" }),
        ],
      },
      { rpc: rpc([rec("old"), rec("keep", { text: "an unrelated cache fact" })]) },
    );
    const out = await memorySearch(supabase, USER, null, { query: "cache" }, OPTS);
    expect(out.records.map((r) => r.id)).toEqual(["keep"]);
  });

  it("a retired replacement hides nothing (D-078)", async () => {
    const supabase = makeFakeSupabase(
      {
        ...base(),
        session_memories: [
          rec("old", { superseded_by: "dead", supersede_kind: "supersedes", valid_to: "2026-09-25T00:00:00Z" }),
          rec("dead", { retired_at: "2026-09-30T00:00:00Z" }),
        ],
      },
      { rpc: rpc([rec("old")]) },
    );
    const out = await memorySearch(supabase, USER, null, { query: "cache" }, OPTS);
    expect(out.records.map((r) => r.id)).toEqual(["old"]);
  });

  it("include_superseded keeps it, marked with its replacement", async () => {
    const supabase = makeFakeSupabase(
      {
        ...base(),
        session_memories: [
          rec("old", { superseded_by: "new", supersede_kind: "supersedes", valid_to: "2026-09-25T00:00:00Z" }),
          rec("new", { created_at: "2026-09-25T00:00:00Z" }),
        ],
      },
      { rpc: rpc([rec("old")]) },
    );
    const out = await memorySearch(supabase, USER, null, { query: "cache", include_superseded: true }, OPTS);
    expect(out.records.map((r) => r.id)).toEqual(["old"]);
    expect(out.records[0].superseded_by).toEqual({ id: "new", on: "2026-09-25" });
  });

  it("a schema without the L1 columns is a no-op: rows are served as before", async () => {
    const base0 = makeFakeSupabase({ ...base(), session_memories: [rec("a")] }, { rpc: rpc([rec("a")]) });
    // Same client, but every session_memories read of the projection errors like a missing column.
    const supabase = new Proxy(base0, {
      get(t, p) {
        if (p !== "from") return t[p];
        return (table: string) => {
          const q = t.from(table);
          if (table !== "session_memories") return q;
          return new Proxy(q, {
            get(qt, qp) {
              if (qp !== "select") return qt[qp];
              return (cols: string) =>
                /superseded_by/.test(cols)
                  ? failing({ code: "42703", message: "column superseded_by does not exist" })
                  : qt.select(cols);
            },
          });
        };
      },
    });
    const out = await memorySearch(supabase, USER, null, { query: "cache" }, OPTS);
    expect(out.records.map((r) => r.id)).toEqual(["a"]);
  });
});

describe("fetchValidity", () => {
  it("is scoped to the user and reads a missing column as no projection", async () => {
    const db = makeFakeSupabase({
      session_memories: [
        { id: "x", user_id: USER, superseded_by: "y", supersede_kind: "resolves", valid_to: "2026-09-25T00:00:00Z" },
        { id: "y", user_id: USER, retired_at: null },
        {
          id: "z",
          user_id: "user-2",
          superseded_by: "y",
          supersede_kind: "supersedes",
          valid_to: "2026-09-25T00:00:00Z",
        },
      ],
    });
    const r = await fetchValidity(db, USER, ["x", "z"]);
    expect([...r.map.keys()]).toEqual(["x"]);
    expect(r.failed).toBe(false);
  });
});

describe("mergeOldest", () => {
  it("keeps the oldest replacement per id", () => {
    const a = new Map([["o", { id: "late", at: "2026-10-01T00:00:00Z" }]]);
    const b = new Map([["o", { id: "early", at: "2026-09-01T00:00:00Z" }]]);
    expect(mergeOldest(a, b).get("o")?.id).toBe("early");
  });
});

describe("fetchReplacements (L2 follow-ups)", () => {
  it("(b) several live replacements: the OLDEST wins per id", async () => {
    const db = makeFakeSupabase({
      session_memories: [
        { id: "late", user_id: USER, supersedes: "old", retired_at: null, created_at: "2026-09-28T00:00:00Z" },
        { id: "early", user_id: USER, supersedes: "old", retired_at: null, created_at: "2026-09-12T00:00:00Z" },
      ],
    });
    const out = await fetchReplacements(db, USER, ["old"]);
    expect(out.get("old")).toEqual({ id: "early", at: "2026-09-12T00:00:00Z" });
  });

  it("(c) another user's replacement is ignored whether it is newer or older than the real one", async () => {
    const table = (otherAt: string) => ({
      session_memories: [
        { id: "mine", user_id: USER, supersedes: "old", retired_at: null, created_at: "2026-09-20T00:00:00Z" },
        { id: "theirs", user_id: "user-2", supersedes: "old", retired_at: null, created_at: otherAt },
      ],
    });
    for (const otherAt of ["2026-09-30T00:00:00Z", "2026-09-01T00:00:00Z"]) {
      const out = await fetchReplacements(makeFakeSupabase(table(otherAt)), USER, ["old"]);
      expect(out.get("old")?.id).toBe("mine");
    }
  });

  it("(a) a failed read throws, so history never serves replaced rows unmarked", async () => {
    const db = {
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "is", "in", "order"]) q[m] = () => q;
        // biome-ignore lint/suspicious/noThenProperty: a thenable stands in for a PostgREST builder
        q.then = (res: (v: unknown) => unknown) => res({ data: null, error: { message: "boom" } });
        return q;
      },
    } as never;
    await expect(fetchReplacements(db, USER, ["old"])).rejects.toThrow(/fails closed|failed/);
  });

  it("(a) memorySearch in history mode fails instead of serving the row unmarked", async () => {
    const real = makeFakeSupabase({ ...base(), session_memories: [] }, { rpc: rpc([rec("old")]) });
    const supabase = new Proxy(real, {
      get(t, p) {
        if (p !== "from") return t[p];
        return (table: string) => {
          const q = t.from(table);
          if (table !== "session_memories") return q;
          return new Proxy(q, {
            get(qt, qp) {
              if (qp !== "select") return qt[qp];
              return (cols: string) =>
                /supersedes/.test(cols) && /created_at/.test(cols) ? failing({ message: "timeout" }) : qt.select(cols);
            },
          });
        };
      },
    });
    await expect(
      memorySearch(supabase, USER, null, { query: "cache", include_superseded: true }, { now: NOW }),
    ).rejects.toThrow(/history/);
  });
});
