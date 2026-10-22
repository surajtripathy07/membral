// Chain-shape locks for the Memory repository (G3 step 3B-7a): each function
// must issue the exact chain its call site used to — table, select string,
// filters in order, order/limit — and hand back the PostgREST result
// unchanged. Matches the recording-chain pattern in
// lib/conversations/__tests__/queries.test.ts.
import { describe, expect, it, vi } from "vitest";
import type { MemoryInsert } from "@/lib/database.types";
import type { Db } from "@/lib/db/types";
import { insertMemories, listMemoriesByConfidence, listMemoriesForConversation } from "../queries";

type Call = [string, unknown[]];

/** A recording chain: every method logs `[name, args]` and returns the chain;
 * awaiting it resolves `result`. */
function recordingDb(result: Record<string, unknown>): { db: Db; calls: Call[] } {
  const calls: Call[] = [];
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order", "limit", "gte", "ilike", "insert", "contains"]) {
    chain[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return chain;
    };
  }
  // biome-ignore lint/suspicious/noThenProperty: mirrors supabase-js's directly-awaitable builder.
  chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
    Promise.resolve(result).then(resolve, reject);
  const from = vi.fn((table: string) => {
    calls.push(["from", [table]]);
    return chain;
  });
  return { db: { from } as unknown as Db, calls };
}

describe("Memory repository chain shapes", () => {
  it("listMemoriesByConfidence: select * eq user_id order confidence desc limit, no optional filters", async () => {
    const result = { data: [], error: null };
    const { db, calls } = recordingDb(result);
    expect(await listMemoriesByConfidence(db, "user-1", 50)).toEqual(result);
    expect(calls).toEqual([
      ["from", ["memories"]],
      ["select", ["*"]],
      ["eq", ["user_id", "user-1"]],
      ["order", ["confidence", { ascending: false }]],
      ["limit", [50]],
    ]);
  });

  it("listMemoriesByConfidence: appends type / min_confidence / q filters in order when given", async () => {
    const result = { data: [], error: null };
    const { db, calls } = recordingDb(result);
    expect(await listMemoriesByConfidence(db, "user-1", 10, "insight", 0.5, "header")).toEqual(result);
    expect(calls).toEqual([
      ["from", ["memories"]],
      ["select", ["*"]],
      ["eq", ["user_id", "user-1"]],
      ["order", ["confidence", { ascending: false }]],
      ["limit", [10]],
      ["eq", ["type", "insight"]],
      ["gte", ["confidence", 0.5]],
      ["ilike", ["content", "%header%"]],
    ]);
  });

  it("insertMemories: insert rows then select (single insert op, no separate read)", async () => {
    const rows: MemoryInsert[] = [{ user_id: "user-1", type: "insight", content: "Users skim the header." }];
    const result = { data: rows, error: null };
    const { db, calls } = recordingDb(result);
    expect(await insertMemories(db, rows)).toEqual(result);
    expect(calls).toEqual([
      ["from", ["memories"]],
      ["insert", [rows]],
      ["select", []],
    ]);
  });

  it("listMemoriesForConversation: select * eq user_id contains source_conversation_ids", async () => {
    const result = { data: [], error: null };
    const { db, calls } = recordingDb(result);
    expect(await listMemoriesForConversation(db, "user-1", "conv-1")).toEqual(result);
    expect(calls).toEqual([
      ["from", ["memories"]],
      ["select", ["*"]],
      ["eq", ["user_id", "user-1"]],
      ["contains", ["source_conversation_ids", ["conv-1"]]],
    ]);
  });
});
