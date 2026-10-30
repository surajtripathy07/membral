import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/types";
import { EMBEDDING_DIMENSIONS } from "@/lib/llm/embedding-client";
import { resetEmbeddingFamilyCacheForTests } from "@/lib/llm/embedding-family";
import { retryMemoryEmbeddings, retryMemoryEmbeddingsForUser } from "../embed-retry";
import type { UnitEmbedder } from "../raw-units/embed";

vi.mock("@/lib/log", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const U = "00000000-0000-0000-0000-0000000000a1";
const vec = (n: number) => Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? n : 0.5));

interface Rpc {
  name: string;
  args: Record<string, unknown>;
}
let calls: Rpc[];
let due: { id: string; text: string }[];
let users: string[];

// Fake PostgREST: only rpc(), plus the family check's table read (an empty store: any family is writable).
function fakeDb(): Db {
  const empty = { data: [], error: null, count: 0 };
  const chain: Record<string, unknown> = {};
  for (const m of ["select", "not", "is", "neq", "eq", "limit", "or"]) chain[m] = () => chain;
  // biome-ignore lint/suspicious/noThenProperty: the fake query builder is awaited like PostgREST's
  chain.then = (res: (v: unknown) => unknown) => Promise.resolve(empty).then(res);
  return {
    from: () => chain,
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "memory_embed_retry_users") return Promise.resolve({ data: users, error: null });
      if (name === "memory_embed_retry_batch") return Promise.resolve({ data: due, error: null });
      return Promise.resolve({ data: 1, error: null });
    },
  } as unknown as Db;
}

const embedder = (fn: UnitEmbedder["embedBatch"]): UnitEmbedder => ({
  family: "text-embedding-3-small",
  embedBatch: fn,
});
const apply = () => calls.find((c) => c.name === "memory_embed_retry_apply");
const appliedRows = () => (apply()?.args.p_rows as { id: string; embedding: string | null }[]) ?? [];

beforeEach(() => {
  calls = [];
  due = [];
  users = [];
  resetEmbeddingFamilyCacheForTests();
});

describe("retryMemoryEmbeddingsForUser", () => {
  it("embeds due rows with the plain record text and applies the vectors", async () => {
    due = [
      { id: "a", text: "first" },
      { id: "b", text: "second" },
    ];
    const seen: string[][] = [];
    const r = await retryMemoryEmbeddingsForUser(fakeDb(), U, {
      embedder: embedder(async (t) => {
        seen.push(t);
        return t.map((_, i) => vec(i + 1));
      }),
    });
    expect(r).toEqual({ embedded: 2, failed: 0 });
    expect(seen).toEqual([["first", "second"]]); // no task prefix, same input as extraction
    expect(appliedRows().map((x) => x.id)).toEqual(["a", "b"]);
    expect(appliedRows().every((x) => typeof x.embedding === "string")).toBe(true);
    expect(apply()?.args.p_user_id).toBe(U);
  });

  it("passes the user, the window and a bounded limit to the due selection", async () => {
    await retryMemoryEmbeddingsForUser(fakeDb(), U, {
      embedder: embedder(async () => []),
      retrySeconds: 900,
      batchSize: 7,
    });
    expect(calls[0]).toEqual({
      name: "memory_embed_retry_batch",
      args: { p_user_id: U, p_retry_seconds: 900, p_limit: 7 },
    });
  });

  it("bumps the marker (null vector) for every row when the embed call fails", async () => {
    due = [{ id: "a", text: "first" }];
    const r = await retryMemoryEmbeddingsForUser(fakeDb(), U, {
      embedder: embedder(async () => {
        throw new Error("provider down");
      }),
    });
    expect(r).toEqual({ embedded: 0, failed: 1 });
    expect(appliedRows()).toEqual([{ id: "a", embedding: null }]);
  });

  it("treats an unusable vector (zero or wrong width) as a failure, never stores it", async () => {
    due = [
      { id: "a", text: "zero" },
      { id: "b", text: "short" },
      { id: "c", text: "good" },
    ];
    const r = await retryMemoryEmbeddingsForUser(fakeDb(), U, {
      embedder: embedder(async () => [new Array(EMBEDDING_DIMENSIONS).fill(0), [1, 2, 3], vec(1)]),
    });
    expect(r).toEqual({ embedded: 1, failed: 2 });
    expect(appliedRows().map((x) => x.embedding === null)).toEqual([true, true, false]);
  });

  it("skips rows with empty text (never embedded, never bumped)", async () => {
    due = [
      { id: "a", text: "   " },
      { id: "b", text: "real" },
    ];
    const seen: string[][] = [];
    await retryMemoryEmbeddingsForUser(fakeDb(), U, {
      embedder: embedder(async (t) => {
        seen.push(t);
        return t.map(() => vec(1));
      }),
    });
    expect(seen).toEqual([["real"]]);
    expect(appliedRows().map((x) => x.id)).toEqual(["b"]);
  });

  it("does nothing when no row is due (no embed call, no apply)", async () => {
    const embed = vi.fn(async () => []);
    const r = await retryMemoryEmbeddingsForUser(fakeDb(), U, { embedder: embedder(embed) });
    expect(r).toEqual({ embedded: 0, failed: 0 });
    expect(embed).not.toHaveBeenCalled();
    expect(apply()).toBeUndefined();
  });

  it("does nothing when embeddings are unconfigured (no embedder): nothing failed, markers untouched", async () => {
    due = [{ id: "a", text: "first" }];
    const r = await retryMemoryEmbeddingsForUser(fakeDb(), U, { embedder: null });
    expect(r).toEqual({ embedded: 0, failed: 0 });
    expect(calls).toEqual([]);
  });
});

describe("retryMemoryEmbeddings", () => {
  it("repairs each user with due rows, bounded by maxUsers in the selection", async () => {
    users = [U, "00000000-0000-0000-0000-0000000000a2"];
    due = [{ id: "a", text: "t" }];
    const s = await retryMemoryEmbeddings(fakeDb(), {
      embedder: embedder(async (t) => t.map(() => vec(1))),
      maxUsers: 5,
    });
    expect(s).toMatchObject({ users: 2, embedded: 2, failed: 0, skipped: false });
    expect(calls[0]).toEqual({ name: "memory_embed_retry_users", args: { p_retry_seconds: 900, p_limit: 5 } });
  });

  it("stops at the deadline and reports skipped", async () => {
    users = [U];
    const s = await retryMemoryEmbeddings(fakeDb(), { embedder: embedder(async () => []), deadlineMs: Date.now() - 1 });
    expect(s).toMatchObject({ users: 0, skipped: true });
  });

  it("is a quiet no-op when the functions do not exist yet (pre-138 database)", async () => {
    const db = {
      rpc: () => Promise.resolve({ data: null, error: { message: "function not found" } }),
    } as unknown as Db;
    await expect(retryMemoryEmbeddings(db)).resolves.toMatchObject({ users: 0, skipped: true });
  });
});
