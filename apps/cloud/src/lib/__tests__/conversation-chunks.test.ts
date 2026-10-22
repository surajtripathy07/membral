import { beforeEach, describe, expect, it, vi } from "vitest";

// --- Mocks (mirrors conversation-embeddings.test.ts's shape) ---

const mockGenerateEmbedding = vi.fn();
const mockCreateEmbeddingGuardContext = vi.fn();
const mockCheckMonthlyCeiling = vi.fn();
const mockLedgerOnSpend = vi.fn();
const mockLedgerFlush = vi.fn(async () => {});

vi.mock("@/lib/embeddings", () => {
  class EmbeddingTokenOverflowError extends Error {
    constructor(public readonly lastMessage: string) {
      super(`token overflow: ${lastMessage}`);
      this.name = "EmbeddingTokenOverflowError";
    }
  }
  return {
    generateEmbedding: (...args: unknown[]) => mockGenerateEmbedding(...args),
    EmbeddingTokenOverflowError,
    createEmbeddingGuardContext: (...args: unknown[]) => mockCreateEmbeddingGuardContext(...args),
  };
});

vi.mock("@/lib/llm/spend-ledger", () => ({
  checkMonthlyCeiling: (...args: unknown[]) => mockCheckMonthlyCeiling(...args),
}));

// Issue #126 (ADR 0047) — see conversation-embeddings.test.ts's identical
// mock/rationale: embedMissingChunks checks hasFeature once upfront, default
// enabled so pre-existing tests keep exercising the batch loop.
const mockHasFeature = vi.fn<(...args: unknown[]) => Promise<boolean>>(() => Promise.resolve(true));
vi.mock("@/lib/feature-flags", () => ({
  hasFeature: (...args: unknown[]) => mockHasFeature(...args),
}));

import { EmbeddingTokenOverflowError } from "@/lib/embeddings";
import {
  chunkConversation,
  chunkMissingConversations,
  embedMissingChunks,
  replaceConversationChunks,
} from "../conversation-chunks";

/**
 * True when `str` contains a UTF-16 surrogate code unit with no valid
 * pairing partner immediately adjacent — the exact defect a code-UNIT-based
 * string split (the pre-M7 bug) can introduce, and which Array.from /
 * JSON.stringify round-trips do NOT by themselves catch (both tolerate a
 * lone surrogate without erroring — only Postgres's UTF-8 encoding rejects
 * it, which this test suite cannot invoke directly).
 */
function hasLoneSurrogate(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    const isHigh = code >= 0xd800 && code <= 0xdbff;
    const isLow = code >= 0xdc00 && code <= 0xdfff;
    if (isHigh) {
      const next = str.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true; // unpaired high surrogate
      i++; // consume the paired low surrogate too
    } else if (isLow) {
      return true; // a low surrogate reached without having consumed a preceding high surrogate
    }
  }
  return false;
}

function guardedContext(): {
  supabase: object;
  ledger: { onSpend: typeof mockLedgerOnSpend; flush: typeof mockLedgerFlush };
} {
  return { supabase: { marker: "guard-supabase" }, ledger: { onSpend: mockLedgerOnSpend, flush: mockLedgerFlush } };
}

// ===========================================================================
// chunkConversation — pure, deterministic, zero-LLM (TS ORACLE for migration
// 045's chunker semantics: the DB never chunks, this module is the sole
// source of truth, so these tests are the primary spec, not a mirror of SQL).
// ===========================================================================

describe("chunkConversation", () => {
  it("returns no chunks for an empty message list", () => {
    expect(chunkConversation([])).toEqual([]);
  });

  it("packs several short messages into ONE chunk when they fit under the target, aligned to message boundaries", () => {
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello there" },
      { role: "user", content: "how are you" },
    ];
    const chunks = chunkConversation(messages);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ chunkIdx: 0, messageStartIdx: 0, messageEndIdx: 2 });
    expect(chunks[0].text).toContain("[user]: hi");
    expect(chunks[0].text).toContain("[assistant]: hello there");
    expect(chunks[0].text).toContain("[user]: how are you");
  });

  it("boundary alignment: splits into a new chunk on a MESSAGE boundary once the target size would be exceeded — never mid-message", () => {
    // Three messages of 800 chars each: msg0+msg1 ~ 1600+1(joiner) > 1500 target,
    // so msg1 must start a new chunk, not be torn mid-content.
    const big = (n: number) => "x".repeat(n);
    const messages = [
      { role: "user", content: big(800) },
      { role: "user", content: big(800) },
      { role: "user", content: big(100) },
    ];
    const chunks = chunkConversation(messages);
    // Chunk 0: message 0 alone (adding message 1 would overflow).
    expect(chunks[0].messageStartIdx).toBe(0);
    expect(chunks[0].messageEndIdx).toBe(0);
    // Every chunk's text always starts and ends on a whole `[role]: ` line —
    // never a fragment of one.
    for (const c of chunks) {
      const lines = c.text.split("\n");
      for (const line of lines) {
        expect(line).toMatch(/^\[\w+\]: /);
      }
    }
    // Every original message index is covered by exactly the chunk ranges,
    // contiguous and non-overlapping.
    const covered = chunks.flatMap((c) =>
      Array.from({ length: c.messageEndIdx - c.messageStartIdx + 1 }, (_, i) => c.messageStartIdx + i),
    );
    expect(covered).toEqual([0, 1, 2]);
  });

  it("a message between target and hard-split threshold (e.g. 2500 chars) becomes its own whole chunk, never split", () => {
    const messages = [{ role: "user", content: "y".repeat(2500) }];
    const chunks = chunkConversation(messages);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].messageStartIdx).toBe(0);
    expect(chunks[0].messageEndIdx).toBe(0);
    expect(chunks[0].text).toBe(`[user]: ${"y".repeat(2500)}`);
  });

  it("hard-split: a single message whose rendered line exceeds ~4000 chars is split into multiple pieces, each sharing messageStartIdx === messageEndIdx === that message's index", () => {
    const hugeContent = "z".repeat(5000);
    const messages = [
      { role: "user", content: "small message before" },
      { role: "user", content: hugeContent },
      { role: "user", content: "small message after" },
    ];
    const chunks = chunkConversation(messages);

    // The huge message (index 1) produces more than one chunk.
    const hugeChunks = chunks.filter((c) => c.messageStartIdx === 1 && c.messageEndIdx === 1);
    expect(hugeChunks.length).toBeGreaterThan(1);

    // The preceding small message got its own chunk first (never merged with
    // the hard-split message).
    const before = chunks.find((c) => c.messageStartIdx === 0);
    expect(before).toBeDefined();
    expect(before?.messageEndIdx).toBe(0);

    // The following small message starts fresh, not appended to the last
    // hard-split piece.
    const after = chunks.find((c) => c.messageStartIdx === 2);
    expect(after).toBeDefined();

    // Every hard-split piece's raw text, reassembled in order, reconstructs
    // the original rendered line exactly (no chars lost or duplicated).
    const reassembled = hugeChunks
      .sort((a, b) => a.chunkIdx - b.chunkIdx)
      .map((c) => c.text)
      .join("");
    expect(reassembled).toBe(`[user]: ${hugeContent}`);
  });

  it("M7 surrogate-safety: a hard-split boundary landing exactly inside an astral (surrogate-pair) character never severs it — every piece round-trips through JSON.stringify with no lone surrogate", () => {
    // "🎉" is a single Unicode code point (U+1F389) encoded as a UTF-16
    // surrogate pair. Repeat it densely around where TARGET_CHUNK_CHARS
    // (1500) would land a raw UTF-16 slice boundary if splitting were done
    // by code UNIT instead of code POINT.
    const emoji = "🎉";
    const hugeContent = emoji.repeat(3000); // 3000 code points, 6000 UTF-16 units
    const messages = [{ role: "user", content: hugeContent }];
    const chunks = chunkConversation(messages);

    expect(chunks.length).toBeGreaterThan(1);

    for (const c of chunks) {
      // The real invariant a code-UNIT split can violate: no lone surrogate
      // anywhere in the piece (see hasLoneSurrogate's doc comment — this is
      // the check that actually catches a severed surrogate pair; a bare
      // Array.from/JSON round-trip does not).
      expect(hasLoneSurrogate(c.text)).toBe(false);
      // Every code point in the piece is a whole emoji or part of the
      // "[user]: " prefix — never a bare surrogate half masquerading as a
      // length-1 astral entry.
      for (const cp of Array.from(c.text)) {
        expect(cp.length).toBeLessThanOrEqual(2); // 1 unit (ascii) or 2 units (a complete surrogate pair)
      }
      // JSON.stringify/parse round-trips exactly (sanity check requested
      // alongside the lone-surrogate check above).
      expect(JSON.parse(JSON.stringify(c.text))).toBe(c.text);
    }

    // Reassembling every piece belonging to this message reconstructs the
    // original content exactly, with no dropped/duplicated code points.
    const reassembled = chunks
      .sort((a, b) => a.chunkIdx - b.chunkIdx)
      .map((c) => c.text)
      .join("");
    expect(reassembled).toBe(`[user]: ${hugeContent}`);
  });

  it("chunkIdx is a 0-based, gapless, ascending sequence across the whole conversation", () => {
    const messages = Array.from({ length: 5 }, (_, i) => ({ role: "user", content: `msg ${i} ${"a".repeat(400)}` }));
    const chunks = chunkConversation(messages);
    expect(chunks.map((c) => c.chunkIdx)).toEqual(chunks.map((_, i) => i));
  });

  it("idempotent: calling chunkConversation twice on the identical input produces byte-identical output (pure function — the property replaceConversationChunks' diff convergence relies on)", () => {
    const messages = [
      { role: "user", content: "one" },
      { role: "assistant", content: "two ".repeat(500) },
      { role: "user", content: "three" },
    ];
    expect(chunkConversation(messages)).toEqual(chunkConversation(messages));
  });

  it("message index ranges are 0-based into the original messages array, inclusive on both ends", () => {
    const messages = [
      { role: "user", content: "a".repeat(700) },
      { role: "user", content: "b".repeat(700) },
      { role: "user", content: "c".repeat(700) },
      { role: "user", content: "d".repeat(700) },
    ];
    const chunks = chunkConversation(messages);
    for (const c of chunks) {
      expect(c.messageStartIdx).toBeGreaterThanOrEqual(0);
      expect(c.messageEndIdx).toBeGreaterThanOrEqual(c.messageStartIdx);
      expect(c.messageEndIdx).toBeLessThan(messages.length);
    }
  });
});

// ===========================================================================
// replaceConversationChunks — diff-based replace (embedding preservation) +
// zero-message sentinel (M3) + non-transactional delete/insert.
// ===========================================================================

describe("replaceConversationChunks", () => {
  interface ExistingRow {
    chunk_idx: number;
    text: string;
  }

  function makeSupabase(
    opts: {
      existing?: ExistingRow[];
      fetchError?: { message: string };
      deleteError?: { message: string };
      insertError?: { message: string };
    } = {},
  ) {
    const existing = opts.existing ?? [];
    let deletedIdxs: number[] | undefined;
    let insertedRows: Record<string, unknown>[] | undefined;
    let deleteCalled = false;
    let insertCalled = false;

    const fetchEq2 = vi.fn((_col: string, _val: string) =>
      Promise.resolve({ data: opts.fetchError ? null : existing, error: opts.fetchError ?? null }),
    );
    const fetchEq1 = vi.fn((_col: string, _val: string) => ({ eq: fetchEq2 }));
    const selectMock = vi.fn((_cols: string) => ({ eq: fetchEq1 }));

    const deleteInMock = vi.fn((_col: string, idxs: number[]) => {
      deleteCalled = true;
      deletedIdxs = idxs;
      return Promise.resolve({ error: opts.deleteError ?? null });
    });
    const deleteEq2 = vi.fn((_col: string, _val: string) => ({ in: deleteInMock }));
    const deleteEq1 = vi.fn((_col: string, _val: string) => ({ eq: deleteEq2 }));
    const deleteMock = vi.fn(() => ({ eq: deleteEq1 }));

    const insertMock = vi.fn((rows: Record<string, unknown>[]) => {
      insertCalled = true;
      insertedRows = rows;
      return Promise.resolve({ error: opts.insertError ?? null });
    });

    const from = vi.fn(() => ({ select: selectMock, delete: deleteMock, insert: insertMock }));
    return {
      from,
      selectMock,
      fetchEq1,
      fetchEq2,
      deleteMock,
      deleteEq1,
      deleteEq2,
      deleteInMock,
      insertMock,
      getDeletedIdxs: () => deletedIdxs,
      getInsertedRows: () => insertedRows,
      wasDeleteCalled: () => deleteCalled,
      wasInsertCalled: () => insertCalled,
    };
  }

  it("fetches existing rows scoped to user_id + conversation_id before diffing", async () => {
    const supabase = makeSupabase();
    const chunks = [{ chunkIdx: 0, messageStartIdx: 0, messageEndIdx: 1, text: "hello" }];

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await replaceConversationChunks(supabase as any, "user-1", "conv-1", chunks);

    expect(supabase.selectMock).toHaveBeenCalledWith("chunk_idx, text");
    expect(supabase.fetchEq1).toHaveBeenCalledWith("user_id", "user-1");
    expect(supabase.fetchEq2).toHaveBeenCalledWith("conversation_id", "conv-1");
  });

  it("no existing coverage: inserts every fresh chunk and issues no delete (nothing to remove)", async () => {
    const supabase = makeSupabase({ existing: [] });
    const chunks = [{ chunkIdx: 0, messageStartIdx: 0, messageEndIdx: 1, text: "hello" }];

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await replaceConversationChunks(supabase as any, "user-1", "conv-1", chunks);

    expect(supabase.wasDeleteCalled()).toBe(false);
    expect(supabase.getInsertedRows()).toEqual([
      {
        user_id: "user-1",
        conversation_id: "conv-1",
        chunk_idx: 0,
        message_start_idx: 0,
        message_end_idx: 1,
        text: "hello",
      },
    ]);
  });

  it("EMBEDDING PRESERVATION: an unchanged (chunk_idx, text) pair diffs to a complete no-op — no delete, no insert", async () => {
    const supabase = makeSupabase({ existing: [{ chunk_idx: 0, text: "hello" }] });
    const chunks = [{ chunkIdx: 0, messageStartIdx: 0, messageEndIdx: 1, text: "hello" }];

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await replaceConversationChunks(supabase as any, "user-1", "conv-1", chunks);

    expect(supabase.wasDeleteCalled()).toBe(false);
    expect(supabase.wasInsertCalled()).toBe(false);
  });

  it("a changed chunk's text triggers delete+insert for ONLY that idx — an unrelated unchanged idx is left untouched (embedding preserved)", async () => {
    const supabase = makeSupabase({
      existing: [
        { chunk_idx: 0, text: "unchanged" },
        { chunk_idx: 1, text: "old text" },
      ],
    });
    const chunks = [
      { chunkIdx: 0, messageStartIdx: 0, messageEndIdx: 0, text: "unchanged" },
      { chunkIdx: 1, messageStartIdx: 1, messageEndIdx: 1, text: "new text" },
    ];

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await replaceConversationChunks(supabase as any, "user-1", "conv-1", chunks);

    expect(supabase.getDeletedIdxs()).toEqual([1]);
    expect(supabase.getInsertedRows()).toEqual([
      {
        user_id: "user-1",
        conversation_id: "conv-1",
        chunk_idx: 1,
        message_start_idx: 1,
        message_end_idx: 1,
        text: "new text",
      },
    ]);
  });

  it("an idx removed from the fresh set is deleted but never re-inserted", async () => {
    const supabase = makeSupabase({
      existing: [
        { chunk_idx: 0, text: "keep" },
        { chunk_idx: 1, text: "gone" },
      ],
    });
    const chunks = [{ chunkIdx: 0, messageStartIdx: 0, messageEndIdx: 0, text: "keep" }];

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await replaceConversationChunks(supabase as any, "user-1", "conv-1", chunks);

    expect(supabase.getDeletedIdxs()).toEqual([1]);
    expect(supabase.wasInsertCalled()).toBe(false);
  });

  it("M3 sentinel: zero computed chunks (a zero-message conversation) inserts ONE sentinel row (chunk_idx 0, empty text, degenerate -1/-1 span) instead of leaving the conversation uncovered", async () => {
    const supabase = makeSupabase({ existing: [] });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await replaceConversationChunks(supabase as any, "user-1", "conv-empty", []);

    expect(supabase.getInsertedRows()).toEqual([
      {
        user_id: "user-1",
        conversation_id: "conv-empty",
        chunk_idx: 0,
        message_start_idx: -1,
        message_end_idx: -1,
        text: "",
      },
    ]);
  });

  it("M3 sentinel already present and unchanged: re-running with zero chunks is a no-op (does not re-insert or delete)", async () => {
    const supabase = makeSupabase({ existing: [{ chunk_idx: 0, text: "" }] });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await replaceConversationChunks(supabase as any, "user-1", "conv-empty", []);

    expect(supabase.wasDeleteCalled()).toBe(false);
    expect(supabase.wasInsertCalled()).toBe(false);
  });

  it("throws on a fetch-existing error without attempting delete or insert", async () => {
    const supabase = makeSupabase({ fetchError: { message: "db down" } });
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
      replaceConversationChunks(supabase as any, "user-1", "conv-1", [
        { chunkIdx: 0, messageStartIdx: 0, messageEndIdx: 0, text: "x" },
      ]),
    ).rejects.toThrow("db down");
    expect(supabase.wasDeleteCalled()).toBe(false);
    expect(supabase.wasInsertCalled()).toBe(false);
  });

  it("throws on a delete error without attempting the insert", async () => {
    const supabase = makeSupabase({ existing: [{ chunk_idx: 0, text: "old" }], deleteError: { message: "db down" } });
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
      replaceConversationChunks(supabase as any, "user-1", "conv-1", [
        { chunkIdx: 0, messageStartIdx: 0, messageEndIdx: 0, text: "new" },
      ]),
    ).rejects.toThrow("db down");
    expect(supabase.wasInsertCalled()).toBe(false);
  });

  it("throws on an insert error", async () => {
    const supabase = makeSupabase({ insertError: { message: "constraint violation" } });
    await expect(
      // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
      replaceConversationChunks(supabase as any, "user-1", "conv-1", [
        { chunkIdx: 0, messageStartIdx: 0, messageEndIdx: 0, text: "x" },
      ]),
    ).rejects.toThrow("constraint violation");
  });
});

// ===========================================================================
// chunkMissingConversations — batch entry: B1 (coverage probe correctness
// under a 1000-row response cap), M3 (zero-message sentinel convergence),
// M4 (stale-covered re-chunk), M5 (scan payload), pagination.
// ===========================================================================

describe("chunkMissingConversations", () => {
  interface FakeConv {
    id: string;
    updated_at: string;
    messages: Array<{ role: string; content: string }>;
  }

  /**
   * Full-fidelity fake modeling both `conversations` query shapes
   * (scan: `id, updated_at`; batched fetch: `id, messages`) and
   * `conversation_chunks`' coverage-probe shape (`conversation_id,
   * created_at`, filtered on `chunk_idx = 0`) PLUS replaceConversationChunks'
   * own select/delete/insert shape — so a full chunkMissingConversations call
   * exercises the real write path end to end.
   *
   * `chunkRowCounts` lets a test simulate a conversation that has MANY
   * underlying chunk rows (not just the one chunk_idx=0 row) — used to prove
   * the coverage probe's `.eq("chunk_idx", 0)` filter keeps the raw result
   * set at exactly one row per covered conversation even when the
   * unfiltered chunk-row population for that same id set would blow past
   * PostgREST's 1000-row response cap (B1).
   */
  function makeSupabase(opts: {
    pages: FakeConv[][];
    coveredIds?: Map<string, string>; // conversation_id -> chunk_idx=0 row's created_at
    chunkRowCounts?: Map<string, number>; // conversation_id -> total underlying chunk rows (>=1 when covered)
    existingChunkRows?: Map<string, { chunk_idx: number; text: string }[]>; // conversation_id -> replaceConversationChunks' existing rows, for embedding-preservation tests
  }) {
    const coverage = new Map(opts.coveredIds ?? []);
    const chunkRowCounts = opts.chunkRowCounts ?? new Map<string, number>();
    const existingChunkRows = opts.existingChunkRows ?? new Map<string, { chunk_idx: number; text: string }[]>();
    const allConvs = new Map(opts.pages.flat().map((c) => [c.id, c]));

    let scanPageCall = 0;
    const scanRangeCalls: Array<[number, number]> = [];
    const orderCalls: Array<[string, unknown]> = [];
    const coverageOrderCalls: string[] = [];
    const insertedByConv = new Map<string, Record<string, unknown>[]>();
    const deletedByConv = new Map<string, number[]>();

    const from = vi.fn((table: string) => {
      if (table === "conversations") {
        return {
          select: vi.fn((cols: string) => {
            if (cols === "id, updated_at") {
              return {
                eq: vi.fn(() => ({
                  order: vi.fn((col: string, ord: unknown) => {
                    orderCalls.push([col, ord]);
                    return {
                      range: vi.fn((start: number, end: number) => {
                        scanRangeCalls.push([start, end]);
                        const page = opts.pages[scanPageCall] ?? [];
                        scanPageCall++;
                        return Promise.resolve({
                          data: page.map((c) => ({ id: c.id, updated_at: c.updated_at })),
                          error: null,
                        });
                      }),
                    };
                  }),
                })),
              };
            }
            if (cols === "id, messages") {
              return {
                eq: vi.fn(() => ({
                  in: vi.fn((_col: string, ids: string[]) => {
                    const rows = ids.map((id) => ({ id, messages: allConvs.get(id)?.messages ?? [] }));
                    return Promise.resolve({ data: rows, error: null });
                  }),
                })),
              };
            }
            throw new Error(`unexpected conversations select: ${cols}`);
          }),
        };
      }
      if (table === "conversation_chunks") {
        return {
          select: vi.fn((cols: string) => {
            if (cols === "conversation_id, created_at") {
              // Coverage probe (chunkMissingConversations -> probeCoverage).
              return {
                eq: vi.fn((_c1: string, _v1: string) => ({
                  eq: vi.fn((col2: string, val2: unknown) => ({
                    in: vi.fn((_c3: string, ids: string[]) => ({
                      // MINOR-4 fix: probeCoverage now orders by
                      // conversation_id before `.range()` for deterministic
                      // pagination — the fake chain models that extra link
                      // without changing any of this test's row data.
                      order: vi.fn((orderCol: string) => {
                        coverageOrderCalls.push(orderCol);
                        return {
                          range: vi.fn((start: number) => {
                            if (start > 0) return Promise.resolve({ data: [], error: null }); // single page in these tests
                            let raw: { conversation_id: string; created_at: string }[];
                            if (col2 === "chunk_idx" && val2 === 0) {
                              // Correct query: exactly one row per covered id.
                              raw = ids
                                .filter((id) => coverage.has(id))
                                .map((id) => ({
                                  conversation_id: id,
                                  created_at: coverage.get(id) as string,
                                }));
                            } else {
                              // Simulates the OLD buggy query (no chunk_idx=0
                              // filter): one row PER CHUNK, exploding with
                              // chunkRowCounts.
                              raw = ids
                                .filter((id) => coverage.has(id))
                                .flatMap((id) =>
                                  Array.from({ length: chunkRowCounts.get(id) ?? 1 }, () => ({
                                    conversation_id: id,
                                    created_at: coverage.get(id) as string,
                                  })),
                                );
                            }
                            // Simulate PostgREST's max_rows=1000 response cap.
                            return Promise.resolve({ data: raw.slice(0, 1000), error: null });
                          }),
                        };
                      }),
                    })),
                  })),
                })),
              };
            }
            if (cols === "chunk_idx, text") {
              // replaceConversationChunks' fetch-existing step — reports
              // whatever `existingChunkRows` seeded for this conversation
              // (empty by default), letting a test prove embedding
              // preservation (an unchanged idx+text is never deleted) across
              // a full chunkMissingConversations -> replaceConversationChunks
              // call.
              return {
                eq: vi.fn(() => ({
                  eq: vi.fn((_c: string, convId: string) =>
                    Promise.resolve({ data: existingChunkRows.get(convId) ?? [], error: null }),
                  ),
                })),
              };
            }
            throw new Error(`unexpected conversation_chunks select: ${cols}`);
          }),
          delete: vi.fn(() => ({
            eq: vi.fn(() => ({
              eq: vi.fn((_c: string, convId: string) => ({
                in: vi.fn((_c2: string, idxs: number[]) => {
                  deletedByConv.set(convId, idxs);
                  return Promise.resolve({ error: null });
                }),
              })),
            })),
          })),
          insert: vi.fn((rows: Record<string, unknown>[]) => {
            const convId = rows[0]?.conversation_id as string;
            insertedByConv.set(convId, rows);
            // Update coverage state so a SECOND call against this SAME mock
            // instance sees this conversation as covered from now on
            // (models the real DB: an insert makes the row visible to the
            // next probeCoverage call) — needed for the "second run selects
            // zero candidates" convergence test.
            const zeroRow = rows.find((r) => r.chunk_idx === 0);
            if (zeroRow) coverage.set(convId, "2026-01-01T00:00:00.000Z");
            return Promise.resolve({ error: null });
          }),
        };
      }
      throw new Error(`unexpected table: ${table}`);
    });

    return {
      from,
      scanRangeCalls,
      orderCalls,
      coverageOrderCalls,
      insertedByConv,
      deletedByConv,
      coverage,
    };
  }

  function makeConv(id: string, opts: { updatedAt?: string; text?: string } = {}): FakeConv {
    return {
      id,
      updated_at: opts.updatedAt ?? "2026-01-01T00:00:00.000Z",
      messages: [{ role: "user", content: opts.text ?? "hello" }],
    };
  }

  it("chunks conversations that have zero coverage, up to `limit`", async () => {
    const supabase = makeSupabase({ pages: [[makeConv("c1"), makeConv("c2"), makeConv("c3")]] });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await chunkMissingConversations(supabase as any, "user-1", 10);

    expect(result.processed).toBe(3);
    expect(result.errors).toEqual([]);
    expect([...supabase.insertedByConv.keys()].sort()).toEqual(["c1", "c2", "c3"]);
  });

  it("orders the scan by synced_at DESC, matching embedMissingConversations' ingest-recency convention", async () => {
    const supabase = makeSupabase({ pages: [[]] });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await chunkMissingConversations(supabase as any, "user-1", 10);
    expect(supabase.orderCalls).toEqual([["synced_at", { ascending: false }]]);
  });

  it("MINOR-4: the coverage probe orders by conversation_id before paginating (deterministic pagination, no page-boundary skip/repeat risk)", async () => {
    const supabase = makeSupabase({ pages: [[makeConv("c1"), makeConv("c2")]] });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await chunkMissingConversations(supabase as any, "user-1", 10);
    expect(supabase.coverageOrderCalls).toEqual(["conversation_id"]);
  });

  it("skips an already-covered AND fresh conversation without re-chunking it", async () => {
    const supabase = makeSupabase({
      pages: [[makeConv("c1"), makeConv("c2")]],
      coveredIds: new Map([["c1", "2026-06-01T00:00:00.000Z"]]), // covered AFTER c1's updated_at — fresh
    });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await chunkMissingConversations(supabase as any, "user-1", 10);

    expect(result.processed).toBe(1);
    expect([...supabase.insertedByConv.keys()]).toEqual(["c2"]);
  });

  it("M4 STALE-COVERED RE-CHUNK: a covered conversation whose updated_at is NEWER than its coverage row's created_at is re-chunked", async () => {
    const supabase = makeSupabase({
      pages: [[makeConv("c1", { updatedAt: "2026-06-01T00:00:00.000Z" })]],
      coveredIds: new Map([["c1", "2026-01-01T00:00:00.000Z"]]), // coverage predates the resync — stale
    });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await chunkMissingConversations(supabase as any, "user-1", 10);

    expect(result.processed).toBe(1);
    expect(supabase.insertedByConv.has("c1")).toBe(true);
  });

  it("TEST (6): a stale-covered re-chunk preserves an UNCHANGED chunk's row (no delete/re-insert for it) while replacing only the chunk whose text actually changed", async () => {
    // Two messages, each 800 chars, land in two SEPARATE chunks (per
    // chunkConversation's boundary-alignment rule: two 800-char messages
    // together would exceed TARGET_CHUNK_CHARS=1500, so the second message
    // starts a fresh chunk) — giving this test two independently-diffable
    // chunk_idx values.
    const conv: FakeConv = {
      id: "stale-conv",
      updated_at: "2026-06-01T00:00:00.000Z", // resynced AFTER coverage below -> stale
      messages: [
        { role: "user", content: "a".repeat(800) },
        { role: "user", content: "b".repeat(800) },
      ],
    };
    const unchangedChunk0Text = `[user]: ${"a".repeat(800)}`; // byte-identical to what chunkConversation will recompute for idx 0

    const supabase = makeSupabase({
      pages: [[conv]],
      coveredIds: new Map([["stale-conv", "2026-01-01T00:00:00.000Z"]]), // predates updated_at -> stale, triggers re-chunk
      existingChunkRows: new Map([
        [
          "stale-conv",
          [
            { chunk_idx: 0, text: unchangedChunk0Text }, // unchanged — must be preserved (embedding intact)
            { chunk_idx: 1, text: "STALE OLD TEXT that no longer matches" }, // changed — must be replaced
          ],
        ],
      ]),
    });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await chunkMissingConversations(supabase as any, "user-1", 10);

    expect(result.processed).toBe(1);
    expect(result.errors).toEqual([]);
    // Only chunk_idx 1 (the changed one) was deleted — chunk_idx 0's
    // existing row (and therefore any embedding it carries) was left alone.
    expect(supabase.deletedByConv.get("stale-conv")).toEqual([1]);
    // Only the changed chunk was re-inserted — the unchanged chunk_idx 0 was
    // never re-written (its embedding survives untouched).
    const inserted = supabase.insertedByConv.get("stale-conv") ?? [];
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ chunk_idx: 1 });
  });

  it("a covered conversation whose updated_at PREDATES its coverage row is NOT re-chunked (not stale)", async () => {
    const supabase = makeSupabase({
      pages: [[makeConv("c1", { updatedAt: "2026-01-01T00:00:00.000Z" })]],
      coveredIds: new Map([["c1", "2026-06-01T00:00:00.000Z"]]),
    });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await chunkMissingConversations(supabase as any, "user-1", 10);

    expect(result.processed).toBe(0);
    expect(supabase.insertedByConv.size).toBe(0);
  });

  it("is idempotent from the caller's point of view: a fully-covered, fresh corpus chunks nothing", async () => {
    const supabase = makeSupabase({
      pages: [[makeConv("c1"), makeConv("c2")]],
      coveredIds: new Map([
        ["c1", "2026-06-01T00:00:00.000Z"],
        ["c2", "2026-06-01T00:00:00.000Z"],
      ]),
    });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await chunkMissingConversations(supabase as any, "user-1", 10);

    expect(result.processed).toBe(0);
    expect(result.errors).toEqual([]);
    expect(supabase.insertedByConv.size).toBe(0);
  });

  it("PAGINATION: when the most-recent page is fully covered, scans a SECOND page to find uncovered conversations further back (backfill convergence)", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => makeConv(`recent-${i}`));
    const page2 = [makeConv("older-uncovered")];
    const supabase = makeSupabase({
      pages: [page1, page2],
      coveredIds: new Map(page1.map((c) => [c.id, "2026-06-01T00:00:00.000Z"])), // every recent one already chunked, fresh
    });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await chunkMissingConversations(supabase as any, "user-1", 1);

    expect(result.processed).toBe(1);
    expect([...supabase.insertedByConv.keys()]).toEqual(["older-uncovered"]);
    expect(supabase.scanRangeCalls).toEqual([
      [0, 99],
      [100, 199],
    ]);
  });

  it("B1: coverage probe stays correct even when covered conversations collectively carry far more than 1000 underlying chunk rows (PostgREST's response cap would silently truncate the OLD one-row-per-chunk query)", async () => {
    // 100 covered conversations, each with 11 underlying chunk rows (1100
    // total) — well past the 1000-row response cap the fake enforces. The
    // real query filters chunk_idx=0, so it only ever asks for (and gets)
    // the 100 single coverage rows, never the 1100 raw chunk rows.
    const covered = Array.from({ length: 100 }, (_, i) => makeConv(`c${i}`));
    const supabase = makeSupabase({
      pages: [covered],
      coveredIds: new Map(covered.map((c) => [c.id, "2026-06-01T00:00:00.000Z"])),
      chunkRowCounts: new Map(covered.map((c) => [c.id, 11])),
    });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await chunkMissingConversations(supabase as any, "user-1", 10);

    // All 100 correctly recognized as covered+fresh -> nothing to chunk.
    // (The old one-row-per-chunk probe would have seen only a
    // cap-truncated ~90 conversations' worth of rows and mis-derived
    // coverage for the rest, wrongly re-chunking them.)
    expect(result.processed).toBe(0);
    expect(supabase.insertedByConv.size).toBe(0);
  });

  it("M3 + M5: a zero-message conversation is covered via a sentinel row on the first run; a second run against the same corpus selects zero candidates", async () => {
    const zeroMsgConv: FakeConv = { id: "empty-conv", updated_at: "2026-01-01T00:00:00.000Z", messages: [] };
    // Two identical pages: each chunkMissingConversations CALL independently
    // scans the corpus from offset 0 (it keeps no cross-call cursor state),
    // so "the caller invokes this again later" is modeled as a second,
    // fresh page-0 fetch returning the same underlying corpus — this mock's
    // `insert` handler updates its shared `coverage` map, so the SECOND
    // call's coverage probe sees the sentinel this suite's first call wrote.
    const supabase = makeSupabase({ pages: [[zeroMsgConv], [zeroMsgConv]] });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const first = await chunkMissingConversations(supabase as any, "user-1", 10);
    expect(first.processed).toBe(1);
    expect(supabase.insertedByConv.get("empty-conv")).toEqual([
      {
        user_id: "user-1",
        conversation_id: "empty-conv",
        chunk_idx: 0,
        message_start_idx: -1,
        message_end_idx: -1,
        text: "",
      },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const second = await chunkMissingConversations(supabase as any, "user-1", 10);
    expect(second.processed).toBe(0);
    expect(second.errors).toEqual([]);
  });

  it("one conversation's chunking failure does not abort the batch — the rest are processed and the failure lands in errors", async () => {
    const supabase = makeSupabase({ pages: [[makeConv("c-bad"), makeConv("c-ok")]] });
    const originalFrom = supabase.from;
    supabase.from = vi.fn((table: string) => {
      const base = originalFrom(table);
      if (table === "conversation_chunks") {
        return {
          ...base,
          insert: vi.fn((rows: Record<string, unknown>[]) => {
            if (rows[0]?.conversation_id === "c-bad") {
              return Promise.resolve({ error: { message: "insert failed" } });
            }
            return Promise.resolve({ error: null });
          }),
        };
      }
      return base;
    });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await chunkMissingConversations(supabase as any, "user-1", 10);

    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("c-bad");
  });

  it("propagates a conversations scan-query error without throwing, surfacing it via queryError", async () => {
    const from = vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          order: vi.fn(() => ({
            range: vi.fn(() => Promise.resolve({ data: null, error: { message: "connection refused" } })),
          })),
        })),
      })),
    }));

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await chunkMissingConversations({ from } as any, "user-1", 10);
    expect(result.processed).toBe(0);
    expect(result.queryError).toBe("connection refused");
  });

  it("scans only `id, updated_at` (M5) — never the full `messages` payload — on the coverage scan itself", async () => {
    const supabase = makeSupabase({ pages: [[makeConv("c1")]] });
    const selectSpy = vi.fn(supabase.from);
    // Confirm the scan's own select call used the slim column list by
    // re-deriving it from the mock's dispatch: the mock throws on any other
    // column list for the "conversations" table, so simply completing
    // without throwing already proves this — assert explicitly too via a
    // fresh spy-wrapped from().
    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await chunkMissingConversations({ from: selectSpy } as any, "user-1", 10);
    expect(selectSpy).toHaveBeenCalledWith("conversations");
  });
});

// ===========================================================================
// embedMissingChunks — mirrors conversation-embeddings.test.ts's coverage
// (ceiling stop + per-row failure isolation + #90 retirement pattern), swapped
// onto conversation_chunks.
// ===========================================================================

describe("embedMissingChunks", () => {
  interface FakeChunk {
    id: string;
    text: string;
  }

  function makeSupabase(opts: {
    selectData: FakeChunk[] | null;
    selectError?: { message: string } | null;
    updateErrorFor?: Record<string, { message: string }>;
  }) {
    const updateCalls: Array<{ id: string; userId: string; payload: Record<string, unknown> }> = [];

    const limitMock = vi.fn().mockResolvedValue({ data: opts.selectData, error: opts.selectError ?? null });
    const orderMock = vi.fn(() => ({ limit: limitMock }));
    const neqMock = vi.fn(() => ({ order: orderMock }));
    const isMock2 = vi.fn(() => ({ neq: neqMock }));
    const isMock1 = vi.fn(() => ({ is: isMock2 }));
    const selectEqMock = vi.fn(() => ({ is: isMock1 }));
    const selectMock = vi.fn(() => ({ eq: selectEqMock }));

    const updateMock = vi.fn((payload: Record<string, unknown>) => ({
      eq: vi.fn((_col1: string, id: string) => ({
        eq: vi.fn((_col2: string, userId: string) => {
          updateCalls.push({ id, userId, payload });
          const err = opts.updateErrorFor?.[id];
          return Promise.resolve({ error: err ?? null });
        }),
      })),
    }));

    const from = vi.fn(() => ({ select: selectMock, update: updateMock }));
    return {
      from,
      selectMock,
      selectEqMock,
      isMock1,
      isMock2,
      neqMock,
      orderMock,
      limitMock,
      updateMock,
      updateCalls,
    };
  }

  function makeFakeEmbedding(): number[] {
    return Array.from({ length: 1536 }, (_, i) => i * 0.001);
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mockCreateEmbeddingGuardContext.mockReturnValue(guardedContext());
    mockCheckMonthlyCeiling.mockResolvedValue({ allowed: true, spentUsd: 0, ceilingUsd: null });
    mockLedgerFlush.mockResolvedValue(undefined);
    mockHasFeature.mockResolvedValue(true);
  });

  it("embeds chunks with a null embedding, writing a 1536-dim '[...]' vector, tagged pass 'chunk_embedding'", async () => {
    const fakeEmbedding = makeFakeEmbedding();
    mockGenerateEmbedding.mockResolvedValueOnce(fakeEmbedding);
    const supabase = makeSupabase({ selectData: [{ id: "chunk-1", text: "some excerpt" }] });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await embedMissingChunks({ from: supabase.from } as any, "user-1", 50);

    expect(result.processed).toBe(1);
    expect(mockGenerateEmbedding).toHaveBeenCalledWith(
      "some excerpt",
      expect.objectContaining({ userId: "user-1", pass: "chunk_embedding" }),
    );
    expect(supabase.updateCalls[0].payload).not.toHaveProperty("embedding_model"); // migration 118: default family omits it
    const written = supabase.updateCalls[0].payload.embedding as string;
    expect(written).toBe(`[${fakeEmbedding.join(",")}]`);
  });

  it("selects only rows with embedding is null, embedding_failed_at is null, text <> '', ordered by created_at ASC (MAJOR-1 fix: oldest-first drains the backlog instead of starving it forever)", async () => {
    const supabase = makeSupabase({ selectData: [] });
    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    await embedMissingChunks({ from: supabase.from } as any, "user-1", 50);
    expect(supabase.selectEqMock).toHaveBeenCalledWith("user_id", "user-1");
    expect(supabase.isMock1).toHaveBeenCalledWith("embedding", null);
    expect(supabase.isMock2).toHaveBeenCalledWith("embedding_failed_at", null);
    expect(supabase.neqMock).toHaveBeenCalledWith("text", "");
    expect(supabase.orderMock).toHaveBeenCalledWith("created_at", { ascending: true });
  });

  it("is idempotent: no eligible chunks makes zero OpenAI calls and never builds a guard context", async () => {
    const supabase = makeSupabase({ selectData: [] });
    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await embedMissingChunks({ from: supabase.from } as any, "user-1", 50);
    expect(result.processed).toBe(0);
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
    expect(mockCreateEmbeddingGuardContext).not.toHaveBeenCalled();
  });

  it("one chunk throwing does not abort the batch — the rest are processed and the failure lands in errors", async () => {
    mockGenerateEmbedding
      .mockRejectedValueOnce(new Error("OpenAI quota exceeded"))
      .mockResolvedValueOnce(makeFakeEmbedding());
    const supabase = makeSupabase({
      selectData: [
        { id: "chunk-fail", text: "a" },
        { id: "chunk-ok", text: "b" },
      ],
    });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await embedMissingChunks({ from: supabase.from } as any, "user-1", 50);

    expect(result.processed).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("chunk-fail");
    expect(supabase.updateCalls.map((c) => c.id)).toEqual(["chunk-ok"]);
  });

  it("#90 RETIREMENT PATTERN: a token-overflow error retires the chunk via embedding_failed_at (not a transient/429-style failure — never retired for those)", async () => {
    mockGenerateEmbedding.mockRejectedValueOnce(new EmbeddingTokenOverflowError("still too long"));
    const supabase = makeSupabase({ selectData: [{ id: "chunk-huge", text: "z".repeat(4000) }] });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await embedMissingChunks({ from: supabase.from } as any, "user-1", 50);

    expect(result.processed).toBe(0);
    expect(result.errors[0]).toContain("chunk-huge");
    expect(supabase.updateCalls).toHaveLength(1);
    expect(supabase.updateCalls[0].id).toBe("chunk-huge");
    expect(supabase.updateCalls[0].payload).toHaveProperty("embedding_failed_at");
  });

  it("ceiling exceeded mid-batch stops cleanly, leaves remaining chunks untouched, still flushes the ledger", async () => {
    mockGenerateEmbedding.mockResolvedValue(makeFakeEmbedding());
    mockCheckMonthlyCeiling
      .mockResolvedValueOnce({ allowed: true, spentUsd: 1, ceilingUsd: 5 })
      .mockResolvedValueOnce({ allowed: false, spentUsd: 5, ceilingUsd: 5 });
    const chunks = Array.from({ length: 15 }, (_, i) => ({ id: `chunk-${i}`, text: `t${i}` }));
    const supabase = makeSupabase({ selectData: chunks });

    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await embedMissingChunks({ from: supabase.from } as any, "user-1", 50);

    expect(result.processed).toBe(10);
    expect(result.errors).toEqual([]);
    expect(mockGenerateEmbedding).toHaveBeenCalledTimes(10);
    expect(mockLedgerFlush).toHaveBeenCalled();
  });

  it("propagates a query error without throwing, surfacing it via queryError", async () => {
    const supabase = makeSupabase({ selectData: null, selectError: { message: "connection refused" } });
    // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
    const result = await embedMissingChunks({ from: supabase.from } as any, "user-1", 50);
    expect(result.processed).toBe(0);
    expect(result.queryError).toBe("connection refused");
    expect(mockGenerateEmbedding).not.toHaveBeenCalled();
  });

  describe("issue #126 (ADR 0047) — llm feature flag", () => {
    it("skips the whole batch — never calls generateEmbedding — when the flag is disabled", async () => {
      mockHasFeature.mockResolvedValue(false);
      const chunks = Array.from({ length: 3 }, (_, i) => ({ id: `chunk-${i}`, text: `t${i}` }));
      const supabase = makeSupabase({ selectData: chunks });

      // biome-ignore lint/suspicious/noExplicitAny: test double, not a real SupabaseClient
      const result = await embedMissingChunks({ from: supabase.from } as any, "user-1", 50);

      expect(result).toEqual({ processed: 0, errors: [] });
      expect(mockGenerateEmbedding).not.toHaveBeenCalled();
      expect(mockCheckMonthlyCeiling).not.toHaveBeenCalled();
    });
  });
});
