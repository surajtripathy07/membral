// Chain-shape locks for the Conversation repository (G3 step 3B-6b): each
// function must issue the exact chain its call site used to — table, select
// string, filters in order, order/limit/range, single/maybeSingle, upsert
// payload + options — and hand back the PostgREST result unchanged.
import { describe, expect, it, vi } from "vitest";
import type { ConversationInsert } from "@/lib/database.types";
import type { TypedDb } from "@/lib/db/types";
import {
  getConversationForPage,
  getConversationIdById,
  getLatestConversationForSource,
  listConversationManifestPage,
  pageConversationsForExport,
  pingConversations,
  upsertConversations,
} from "../queries";

type Call = [string, unknown[]];

/** A recording chain: every method logs `[name, args]` and returns the chain;
 * awaiting it (or `.single()` / `.maybeSingle()`) resolves `result`. */
function recordingDb(result: Record<string, unknown>): { db: TypedDb; calls: Call[] } {
  const calls: Call[] = [];
  const chain: Record<string, unknown> = {};
  for (const name of ["select", "eq", "order", "limit", "range", "upsert"]) {
    chain[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return chain;
    };
  }
  for (const name of ["single", "maybeSingle"]) {
    chain[name] = (...args: unknown[]) => {
      calls.push([name, args]);
      return Promise.resolve(result);
    };
  }
  // biome-ignore lint/suspicious/noThenProperty: mirrors supabase-js's directly-awaitable builder.
  chain.then = (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
    Promise.resolve(result).then(resolve, reject);
  const from = vi.fn((table: string) => {
    calls.push(["from", [table]]);
    return chain;
  });
  return { db: { from } as unknown as TypedDb, calls };
}

describe("Conversation repository chain shapes", () => {
  it("pingConversations: HEAD exact count on conversations", async () => {
    const { db, calls } = recordingDb({ error: null });
    expect(await pingConversations(db)).toEqual({ error: null });
    expect(calls).toEqual([
      ["from", ["conversations"]],
      ["select", ["id", { head: true, count: "exact" }]],
    ]);
  });

  it("getLatestConversationForSource: counted newest updated_at for one source", async () => {
    const result = { data: [{ updated_at: "2026-09-01T00:00:00Z" }], count: 3, error: null };
    const { db, calls } = recordingDb(result);
    expect(await getLatestConversationForSource(db, "u1", "claude")).toEqual(result);
    expect(calls).toEqual([
      ["from", ["conversations"]],
      ["select", ["updated_at", { count: "exact" }]],
      ["eq", ["user_id", "u1"]],
      ["eq", ["source", "claude"]],
      ["order", ["updated_at", { ascending: false, nullsFirst: false }]],
      ["limit", [1]],
    ]);
  });

  it("listConversationManifestPage: optional source filter, id order, range", async () => {
    const result = { data: [], error: null };
    const withSource = recordingDb(result);
    expect(await listConversationManifestPage(withSource.db, "u1", "chatgpt", 0, 999)).toEqual(result);
    expect(withSource.calls).toEqual([
      ["from", ["conversations"]],
      ["select", ["source, source_id, updated_at"]],
      ["eq", ["user_id", "u1"]],
      ["eq", ["source", "chatgpt"]],
      ["order", ["id", { ascending: true }]],
      ["range", [0, 999]],
    ]);
    const noSource = recordingDb(result);
    await listConversationManifestPage(noSource.db, "u1", null, 1000, 1999);
    expect(noSource.calls.map(([name]) => name)).toEqual(["from", "select", "eq", "order", "range"]);
  });

  it("upsertConversations: passes the rows and options through untouched", async () => {
    const { db, calls } = recordingDb({ error: null });
    const rows: ConversationInsert[] = [{ user_id: "u1", source: "claude", source_id: "s1", title: "t" }];
    const options = { onConflict: "user_id,source,source_id", ignoreDuplicates: false };
    expect(await upsertConversations(db, rows, options)).toEqual({ error: null });
    expect(calls).toEqual([
      ["from", ["conversations"]],
      ["upsert", [rows, options]],
    ]);
    expect(calls[1][1][0]).toBe(rows);
  });

  it("pageConversationsForExport: created_at then id ascending, range", async () => {
    const result = { data: [], error: null };
    const { db, calls } = recordingDb(result);
    expect(await pageConversationsForExport(db, "u1", 0, 999)).toEqual(result);
    expect(calls).toEqual([
      ["from", ["conversations"]],
      ["select", ["id, source, source_id, title, model, messages, metadata, created_at, updated_at"]],
      ["eq", ["user_id", "u1"]],
      ["order", ["created_at", { ascending: true }]],
      ["order", ["id", { ascending: true }]],
      ["range", [0, 999]],
    ]);
  });

  it("getConversationForPage: id then user_id, single", async () => {
    const result = { data: null, error: { message: "no rows" } };
    const { db, calls } = recordingDb(result);
    expect(await getConversationForPage(db, "u1", "c1")).toEqual(result);
    expect(calls).toEqual([
      ["from", ["conversations"]],
      ["select", ["id, source, title, created_at, updated_at, model, messages, metadata"]],
      ["eq", ["id", "c1"]],
      ["eq", ["user_id", "u1"]],
      ["single", []],
    ]);
  });

  it("getConversationIdById: id only, maybeSingle", async () => {
    const result = { data: { id: "c1" }, error: null };
    const { db, calls } = recordingDb(result);
    expect(await getConversationIdById(db, "c1")).toEqual(result);
    expect(calls).toEqual([
      ["from", ["conversations"]],
      ["select", ["id"]],
      ["eq", ["id", "c1"]],
      ["maybeSingle", []],
    ]);
  });
});
