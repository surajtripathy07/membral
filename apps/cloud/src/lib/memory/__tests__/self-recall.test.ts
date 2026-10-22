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
import type { Db } from "@/lib/db/types";
import {
  buildPromptRecall,
  buildSessionStartSelfRecall,
  CONTINUATION_HEADER,
  CONTINUATION_MAX_RECORDS,
  PROMPT_RECALL_FOOTER_PREFIX,
  PROMPT_RECALL_HEADER,
  PROMPT_RECALL_LINE_MAX_CHARS,
  SESSION_SELF_HEADER,
} from "../prompt-recall";
import {
  CONTINUATION_FOCUS_MAX_CHARS,
  continuationFocusText,
  loadSessionSelfRecords,
  rankSelfRows,
  selfRecallTier,
} from "../self-recall";
import type { MemoryRow } from "../verify";

const USER = "user-1";
const OTHER_USER = "user-2";
const PROJECT = "proj-a";
const OTHER_PROJECT = "proj-b";
const NOW = new Date("2026-10-08T12:00:00Z");
const HARNESS_ID = "0a1b2c3d-1111-4222-8333-444455556666";
const MAIN = "cs-main";
const SUB = "cs-sub";
const UNRELATED = "cs-unrelated";
const TARGET = { sourceSessionId: HARNESS_ID, harness: "claude-code" as const };
const EXT = 4000;

function mem(o: Partial<Row> & { id: string; text: string }): Row {
  return {
    user_id: USER,
    code_session_id: MAIN,
    code_project_id: PROJECT,
    agent_id: null,
    source: "extractor",
    kind: "decision",
    quote: `${o.text} -- said`,
    turn_idx: 1,
    turn_role: "assistant",
    ref: null,
    ref_kind: null,
    branch: null,
    head_sha: null,
    thread: null,
    paths: [],
    verified: true,
    durable: true,
    observed_durable: false,
    recurrence_count: 1,
    scope: "project",
    confidence: 0.8,
    supersedes: null,
    retired_at: null,
    chat_conversation_id: null,
    created_at: "2026-10-07T12:00:00Z",
    priority: false,
    ...o,
  };
}

const sessions: Row[] = [
  {
    id: MAIN,
    user_id: USER,
    code_project_id: PROJECT,
    source: "claude-code",
    source_session_id: HARNESS_ID,
    parent_source_session_id: null,
    started_at: "2026-10-07T10:00:00Z",
    ended_at: "2026-10-07T11:00:00Z",
  },
  {
    id: SUB,
    user_id: USER,
    code_project_id: PROJECT,
    source: "claude-code",
    source_session_id: "agent-x",
    parent_source_session_id: HARNESS_ID,
    started_at: "2026-10-07T10:10:00Z",
    ended_at: null,
  },
  {
    id: UNRELATED,
    user_id: USER,
    code_project_id: PROJECT,
    source: "claude-code",
    source_session_id: "ffffffff-1111-4222-8333-444455556666",
    parent_source_session_id: null,
    started_at: "2026-10-01T10:00:00Z",
    ended_at: null,
  },
  // Same harness id under another user: never served.
  {
    id: "cs-foreign",
    user_id: OTHER_USER,
    code_project_id: PROJECT,
    source: "claude-code",
    source_session_id: HARNESS_ID,
    parent_source_session_id: null,
    started_at: null,
    ended_at: null,
  },
];

const rpcCalls: Record<string, unknown>[] = [];
function setup(
  memories: Row[],
  searchRows: Row[] = [],
  rpcOverride?: () => Promise<{ data: Row[]; error: null }>,
  extraSessions: Row[] = [],
): Db {
  return makeFakeSupabase(
    {
      code_sessions: [...sessions, ...extraSessions],
      session_memories: memories,
      code_projects: [
        { id: PROJECT, user_id: USER, display_name: null, repo_identity: "github.com/acme/app" },
        { id: OTHER_PROJECT, user_id: USER, display_name: null, repo_identity: "github.com/acme/other" },
      ],
      code_session_turns: searchRows.map((r) => ({ session_id: r.code_session_id, idx: 1, text: r.quote, props: {} })),
      memory_branch_state: [],
      conversations: [],
    },
    {
      rpc: {
        memory_search_scored: (args: Record<string, unknown>) => {
          rpcCalls.push(args);
          if (rpcOverride) return rpcOverride() as never;
          return { data: searchRows, error: null };
        },
      },
    },
  ) as Db;
}

beforeEach(() => {
  rpcCalls.length = 0;
  vi.stubEnv("OPENAI_API_KEY", "sk-test");
  mockGenerateEmbedding.mockReset();
  mockGenerateEmbedding.mockResolvedValue(new Array(1536).fill(0));
});

const asRow = (o: Partial<MemoryRow> & { id: string; priority?: boolean }): MemoryRow & { priority?: boolean } =>
  mem({ text: o.id, ...(o as Partial<Row>), id: o.id }) as unknown as MemoryRow & { priority?: boolean };

describe("selfRecallTier and rankSelfRows", () => {
  it("decisions and outcomes, then findings with paths, then ref-carrying records, then the rest", () => {
    expect(selfRecallTier({ kind: "decision", paths: [], ref: null, ref_kind: null })).toBe(0);
    expect(selfRecallTier({ kind: "outcome", paths: [], ref: null, ref_kind: null })).toBe(0);
    expect(selfRecallTier({ kind: "learning", paths: ["src/a.ts"], ref: null, ref_kind: null })).toBe(1);
    expect(selfRecallTier({ kind: "learning", paths: [], ref: "#12", ref_kind: "issue" })).toBe(2);
    expect(selfRecallTier({ kind: "blocker", paths: [], ref: "!3", ref_kind: "mr" })).toBe(2);
    expect(selfRecallTier({ kind: "learning", paths: [], ref: null, ref_kind: null })).toBe(3);
    expect(selfRecallTier({ kind: "learning", paths: [" "], ref: "abc", ref_kind: "commit" })).toBe(3);
  });

  it("within a tier: priority first, the session's own before its sub-agents', later turns first", () => {
    const rows = [
      asRow({ id: "finding", kind: "learning", paths: ["a.ts"], turn_idx: 99 }),
      asRow({ id: "sub-late", code_session_id: SUB, turn_idx: 50 }),
      asRow({ id: "main-early", turn_idx: 2 }),
      asRow({ id: "main-late", turn_idx: 9 }),
      asRow({ id: "flagged", turn_idx: 1, priority: true }),
      asRow({ id: "ref-only", kind: "learning", ref: "#4", ref_kind: "issue" }),
    ];
    expect(rankSelfRows(rows, new Set([MAIN])).map((r) => r.id)).toEqual([
      "flagged",
      "main-late",
      "main-early",
      "sub-late",
      "finding",
      "ref-only",
    ]);
  });
});

describe("loadSessionSelfRecords", () => {
  it("reads the session's and its sub-agents' verified, live records only, for this user", async () => {
    const db = setup([
      mem({ id: "own", text: "Keep the adapter behind the store interface" }),
      mem({ id: "sub", code_session_id: SUB, kind: "outcome", text: "Store tests pass after the adapter move" }),
      mem({ id: "unverified", text: "not grounded", verified: false }),
      mem({ id: "retired", text: "retired one", retired_at: "2026-10-07T12:30:00Z" }),
      mem({ id: "pref", text: "a preference", kind: "preference" }),
      mem({ id: "elsewhere", code_session_id: UNRELATED, text: "another session's ruling" }),
      mem({ id: "foreign", code_session_id: "cs-foreign", user_id: OTHER_USER, text: "another user's ruling" }),
    ]);
    const out = await loadSessionSelfRecords(db, USER, null, TARGET);
    expect(out.found).toBe(true);
    expect(out.sessions).toBe(2);
    expect(out.records.map((r) => r.id).sort()).toEqual(["own", "sub"]);
    const sub = out.records.find((r) => r.id === "sub");
    expect(sub?.when).toBe("2026-10-07T10:10:00Z");
  });

  it("an unknown session id, or a key bound to another project, finds nothing", async () => {
    const db = setup([mem({ id: "own", text: "Keep the adapter behind the store interface" })]);
    expect(await loadSessionSelfRecords(db, USER, null, { ...TARGET, sourceSessionId: "nope" })).toEqual({
      found: false,
      sessions: 0,
      records: [],
    });
    expect((await loadSessionSelfRecords(db, USER, OTHER_PROJECT, TARGET)).found).toBe(false);
    expect((await loadSessionSelfRecords(db, OTHER_USER, null, TARGET)).records).toEqual([]);
  });

  it("another user's sub-agent with the same parent id is never served", async () => {
    const foreignSub: Row = {
      id: "cs-foreign-sub",
      user_id: OTHER_USER,
      code_project_id: PROJECT,
      source: "claude-code",
      source_session_id: "agent-foreign",
      parent_source_session_id: HARNESS_ID,
      started_at: null,
      ended_at: null,
    };
    const db = setup(
      [
        mem({ id: "own", text: "Keep the adapter behind the store interface" }),
        mem({ id: "foreign-sub", code_session_id: "cs-foreign-sub", user_id: OTHER_USER, text: "another user's note" }),
      ],
      [],
      undefined,
      [foreignSub],
    );
    const out = await loadSessionSelfRecords(db, USER, null, TARGET);
    expect(out.sessions).toBe(2);
    expect(out.records.map((r) => r.id)).toEqual(["own"]);
  });

  it("blockers are not served", async () => {
    const db = setup([mem({ id: "blk", kind: "blocker", text: "Stuck on the fixture server" })]);
    expect((await loadSessionSelfRecords(db, USER, null, TARGET)).records).toEqual([]);
  });

  it("a big sub-agent family does not crowd out the main session; the main session is read on its own", async () => {
    const subRows = Array.from({ length: 520 }, (_, i) =>
      mem({ id: `s${String(i).padStart(4, "0")}`, code_session_id: SUB, turn_idx: i, text: `sub finding number ${i}` }),
    );
    const mainRow = mem({ id: "main-old", turn_idx: 0, text: "The main session's early ruling stands" });
    const out = await loadSessionSelfRecords(setup([...subRows, mainRow]), USER, null, TARGET);
    // Own rows rank ahead of the sub-agents' within a tier, so the main row is first only if it was read at all
    // (the shared 500-row chunk would have cut it: the fake keeps insertion order and ignores .order()).
    expect(out.records[0].id).toBe("main-old");
    expect(out.records).toHaveLength(40);
  });
});

describe("continuationFocusText (route)", () => {
  const summary = [
    "This session is being continued from a previous conversation that ran out of context.",
    "Summary:",
    "1. Goal:",
    "   Rename the widget store.",
    "## Next steps",
    "Run the store tests.",
    "If you need specific details from before compaction, read the full transcript at: /x/y.jsonl",
  ].join("\n");

  it("keeps the next-step section and drops the rest and the closing pointer", () => {
    expect(continuationFocusText(summary)).toBe("Run the store tests.");
  });

  it("uses the LAST next-step section, even with a quoted pointer earlier in the body", () => {
    const text = [
      "This session is being continued from a previous conversation that ran out of context.",
      "## Next steps",
      "Old quoted plan.",
      "Quoted: read the full transcript at: /x/a.jsonl",
      "## Next steps",
      "Real plan: run the store tests.",
      "If you need specific details, read the full transcript at: /x/b.jsonl",
    ].join("\n");
    expect(continuationFocusText(text)).toBe("Real plan: run the store tests.");
  });

  it("falls back to the last 800 chars and is idempotent", () => {
    const plain = `${"word ".repeat(400)}tail end`;
    const once = continuationFocusText(plain);
    expect(once.length).toBeLessThanOrEqual(CONTINUATION_FOCUS_MAX_CHARS);
    expect(once.endsWith("tail end")).toBe(true);
    expect(continuationFocusText(once)).toBe(once);
  });
});

describe("buildPromptRecall continuation", () => {
  const many = Array.from({ length: 9 }, (_, i) =>
    mem({
      id: `d${i}`,
      turn_idx: i,
      text: [
        "Widget ids stay opaque strings across the public API",
        "Cache entries expire on write, never on a timer",
        "The adapter owns retries; callers never loop",
        "Legacy importer is frozen until the rename lands",
        "Errors surface as typed results instead of throws",
        "Pagination uses cursors, offsets are removed",
        "Feature toggles live in one config module",
        "Logs carry the request id on every line",
        "Fixtures are generated, never hand edited",
      ][i],
    }),
  );

  it("serves the session's own records first under the continuation header, capped at six, with links", async () => {
    const withRef = mem({
      id: "pr",
      kind: "outcome",
      turn_idx: 100,
      text: "Opened the store rename PR",
      ref: "#77",
      ref_kind: "pr",
    });
    const out = await buildPromptRecall(
      setup([...many, withRef]),
      USER,
      null,
      { prompt: "Run the store tests next.", repo: "github.com/acme/app", clientBudgetMs: EXT, continuation: TARGET },
      { now: NOW },
    );
    expect(out.mode).toBe("continuation");
    expect(out.lines[0]).toBe(CONTINUATION_HEADER);
    expect(out.record_ids).toHaveLength(CONTINUATION_MAX_RECORDS);
    expect(out.self_records).toBe(CONTINUATION_MAX_RECORDS);
    // Latest turn first within decisions/outcomes.
    expect(out.record_ids[0]).toBe("pr");
    expect(out.lines[1]).toContain("→ https://github.com/acme/app/pull/77");
    for (const l of out.lines) expect(l.length).toBeLessThanOrEqual(PROMPT_RECALL_LINE_MAX_CHARS);
    expect(out.lines.at(-1)?.startsWith(PROMPT_RECALL_FOOTER_PREFIX)).toBe(true);
    // Six self records fill every slot: no topic search.
    expect(rpcCalls).toHaveLength(0);
  });

  it("collapses a ruling restated across turns into one slot", async () => {
    const out = await buildPromptRecall(
      setup([
        mem({ id: "a", turn_idx: 1, text: "Keep the adapter behind the store interface for every caller now" }),
        mem({ id: "b", turn_idx: 5, text: "Keep the adapter behind the store interface for every caller" }),
      ]),
      USER,
      null,
      { prompt: "x", repo: "github.com/acme/app", clientBudgetMs: EXT, continuation: TARGET },
      { now: NOW },
    );
    expect(out.record_ids).toHaveLength(1);
  });

  it("fills leftover slots from a topic search on the focus text only, never re-serving a self record", async () => {
    const other = mem({
      id: "other",
      code_session_id: UNRELATED,
      text: "Store tests need the fixture server running first",
      similarity: 0.9,
      lex_hits: 4,
      query_lexemes: 6,
      leg_score: 0.05,
    });
    const own = mem({ id: "own", text: "Keep the adapter behind the store interface" });
    const summary = [
      "This session is being continued from a previous conversation that ran out of context.",
      "1. Goal:",
      "   Something long the search must not see.",
      "6. Next step:",
      "   Run the store tests and fix the adapter import.",
    ].join("\n");
    const out = await buildPromptRecall(
      setup([own], [{ ...own, similarity: 0.9, lex_hits: 4, query_lexemes: 6, leg_score: 0.06 }, other]),
      USER,
      null,
      { prompt: summary, repo: "github.com/acme/app", clientBudgetMs: EXT, continuation: TARGET },
      { now: NOW },
    );
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0].p_query).toBe("Run the store tests and fix the adapter import.");
    expect(out.record_ids).toEqual(["own", "other"]);
    expect(out.self_records).toBe(1);
  });

  it("an unknown session with no topic match answers empty with no_session_records", async () => {
    const out = await buildPromptRecall(
      setup([]),
      USER,
      null,
      {
        prompt: "Run the store tests next.",
        repo: "github.com/acme/app",
        clientBudgetMs: EXT,
        continuation: { ...TARGET, sourceSessionId: "nope" },
      },
      { now: NOW },
    );
    expect(out).toMatchObject({ lines: [], record_ids: [], skipped: "not_uploaded", mode: "continuation" });
  });

  it("topic results with no self records use the plain recall header, not the continuation one", async () => {
    const other = mem({
      id: "other",
      code_session_id: UNRELATED,
      text: "Store tests need the fixture server running first",
      similarity: 0.9,
      lex_hits: 4,
      query_lexemes: 6,
      leg_score: 0.05,
    });
    const out = await buildPromptRecall(
      setup([], [other]),
      USER,
      null,
      {
        prompt: "Run the store tests and fix the adapter import.",
        repo: "github.com/acme/app",
        clientBudgetMs: EXT,
        continuation: TARGET,
      },
      { now: NOW },
    );
    expect(out.record_ids).toEqual(["other"]);
    expect(out.self_records).toBe(0);
    expect(out.self_skipped).toBe("no_session_records");
    expect(out.lines[0]).toBe(PROMPT_RECALL_HEADER);
    expect(out.lines.join("\n")).not.toContain("what this session recorded");
  });

  it("a topic search that times out keeps the self records", async () => {
    const out = await buildPromptRecall(
      setup([mem({ id: "own", text: "Keep the adapter behind the store interface" })], [], () => new Promise(() => {})),
      USER,
      null,
      {
        prompt: "Run the store tests and fix the adapter import.",
        repo: "github.com/acme/app",
        clientBudgetMs: EXT,
        continuation: TARGET,
      },
      { now: NOW, secondHopBudgetMs: 20 },
    );
    expect(rpcCalls).toHaveLength(1);
    expect(out.mode).toBe("continuation");
    expect(out.record_ids).toEqual(["own"]);
    expect(out.lines[0]).toBe(CONTINUATION_HEADER);
  });

  describe("when the self read fails", () => {
    const other = mem({
      id: "other",
      code_session_id: UNRELATED,
      text: "Store tests need the fixture server running first",
      similarity: 0.9,
      lex_hits: 4,
      query_lexemes: 6,
      leg_score: 0.05,
    });
    /** A db whose first two code_sessions reads (the self read's) hang or throw; everything else works. */
    function failingSelfRead(mode: "hang" | "throw"): Db {
      const base = setup([], [other]);
      let calls = 0;
      return {
        ...base,
        from: (t: string) => {
          if (t === "code_sessions" && calls++ < 2) {
            if (mode === "throw") throw new Error("db down");
            const chain: Record<string, unknown> = {};
            for (const m of ["select", "eq", "in", "is", "order"]) chain[m] = () => chain;
            chain.limit = () => new Promise(() => {});
            return chain;
          }
          return (base as unknown as { from: (t: string) => unknown }).from(t);
        },
      } as unknown as Db;
    }
    const focus = "Run the store tests and fix the adapter import.";

    it("a hung self read: the topic search still serves, and the reason is timeout", async () => {
      const out = await buildPromptRecall(
        failingSelfRead("hang"),
        USER,
        null,
        { prompt: focus, repo: "github.com/acme/app", clientBudgetMs: EXT, continuation: TARGET },
        { now: NOW, budgetMs: 20 },
      );
      expect(out.record_ids).toEqual(["other"]);
      expect(out.self_skipped).toBe("timeout");
      expect(out.lines[0]).toBe(PROMPT_RECALL_HEADER);
    });

    it("a throwing self read with no topic fallback: skipped is error, not no_session_records", async () => {
      const out = await buildPromptRecall(
        failingSelfRead("throw"),
        USER,
        null,
        { prompt: "Run it.", repo: "github.com/acme/app", clientBudgetMs: EXT, continuation: TARGET },
        { now: NOW },
      );
      expect(out).toMatchObject({ lines: [], skipped: "error", self_skipped: "error", mode: "continuation" });
    });
  });

  it("a continuation is never skipped as a short prompt", async () => {
    const out = await buildPromptRecall(
      setup([mem({ id: "own", text: "Keep the adapter behind the store interface" })]),
      USER,
      null,
      { prompt: "", repo: "github.com/acme/app", clientBudgetMs: EXT, continuation: TARGET },
      { now: NOW },
    );
    expect(out.record_ids).toEqual(["own"]);
  });
});

describe("buildSessionStartSelfRecall", () => {
  it("serves the session's own records under the session-start header", async () => {
    const out = await buildSessionStartSelfRecall(
      setup([mem({ id: "own", text: "Keep the adapter behind the store interface" })]),
      USER,
      null,
      TARGET,
      { now: NOW },
    );
    expect(out.lines[0]).toBe(SESSION_SELF_HEADER);
    expect(out.record_ids).toEqual(["own"]);
    expect(rpcCalls).toHaveLength(0);
  });

  it("nothing stored yet -> no lines, no_session_records", async () => {
    const out = await buildSessionStartSelfRecall(setup([]), USER, null, TARGET, { now: NOW });
    expect(out).toEqual({ lines: [], record_ids: [], skipped: "no_session_records" });
  });

  it("a session the store never had -> not_uploaded", async () => {
    const out = await buildSessionStartSelfRecall(setup([]), USER, null, { ...TARGET, sourceSessionId: "nope" });
    expect(out).toEqual({ lines: [], record_ids: [], skipped: "not_uploaded" });
  });

  it("past its budget -> no lines, timeout, never an error", async () => {
    // A read that never answers.
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "in", "is", "order"]) chain[m] = () => chain;
    chain.limit = () => new Promise(() => {});
    const hanging = { from: () => chain } as unknown as Db;
    const out = await buildSessionStartSelfRecall(hanging, USER, null, TARGET, { now: NOW, budgetMs: 20 });
    expect(out).toEqual({ lines: [], record_ids: [], skipped: "timeout" });
  });
});
