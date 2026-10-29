import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db/types";
import { EMBEDDING_DIMENSIONS, EmbeddingDimensionError } from "@/lib/llm/embedding-client";
import { assertEmbeddingFamilyWritable, resetEmbeddingFamilyCacheForTests } from "@/lib/llm/embedding-family";
import { type UnitEmbedder, unitTextHash } from "@/lib/memory/raw-units/embed";
import {
  MAX_REEMBED_BATCH,
  REEMBED_TABLES,
  type ReembedError,
  type ReembedResult,
  reembedBatch,
  reembedFilter,
} from "../reembed";

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};

// --- A fake PostgREST: just the filter subset reembed.ts emits (is.null, not.is.null, neq."x", and(), or()). ---
function splitTop(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inQuote = false;
  let cur = "";
  for (const ch of s) {
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote && ch === "(") depth++;
    if (!inQuote && ch === ")") depth--;
    if (!inQuote && depth === 0 && ch === ",") {
      parts.push(cur);
      cur = "";
    } else cur += ch;
  }
  parts.push(cur);
  return parts;
}
function evalFilter(expr: string, r: Row): boolean {
  const m = /^(and|or)\((.*)\)$/.exec(expr);
  if (m) {
    const kids = splitTop(m[2]).map((k) => evalFilter(k, r));
    return m[1] === "and" ? kids.every(Boolean) : kids.some(Boolean);
  }
  const notNull = /^(\w+)\.not\.is\.null$/.exec(expr);
  if (notNull) return r[notNull[1]] != null;
  const isNull = /^(\w+)\.is\.null$/.exec(expr);
  if (isNull) return r[isNull[1]] == null;
  const neq = /^(\w+)\.neq\.(.*)$/.exec(expr);
  if (neq) return r[neq[1]] !== JSON.parse(neq[2]);
  throw new Error(`fake db: unsupported filter ${expr}`);
}

const updates: Array<{ table: string; id: unknown; payload: Row }> = [];
let failUpdateFor: Set<string>;

function query(table: string) {
  let op: "select" | "update" = "select";
  let payload: Row = {};
  let head = false;
  let limit = Infinity;
  const preds: ((r: Row) => boolean)[] = [];
  const f = (p: (r: Row) => boolean) => {
    preds.push(p);
    return b;
  };
  const run = () => {
    const matched = (tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
    if (op === "update") {
      const out = { data: [] as Array<{ id: unknown }>, error: null as { message: string } | null };
      for (const r of matched) {
        if (failUpdateFor.has(String(r.id))) out.error = { message: "boom" };
        else {
          Object.assign(r, payload);
          updates.push({ table, id: r.id, payload });
          out.data.push({ id: r.id });
        }
      }
      return out;
    }
    const sorted = [...matched].sort((a, c) => String(a.id).localeCompare(String(c.id)));
    return head
      ? { data: null, count: matched.length, error: null }
      : { data: sorted.slice(0, limit).map((r) => ({ ...r })), count: null, error: null };
  };
  const b = {
    select: (_c?: string, o?: { head?: boolean }) => {
      head = o?.head === true;
      return b;
    },
    update: (p: Row) => {
      op = "update";
      payload = p;
      return b;
    },
    or: (expr: string) => f((r) => evalFilter(`or(${expr})`, r)),
    neq: (c: string, v: unknown) => f((r) => r[c] !== v),
    gt: (c: string, v: unknown) => f((r) => String(r[c]) > String(v)),
    eq: (c: string, v: unknown) => f((r) => r[c] === v),
    is: (c: string, v: unknown) => f((r) => (r[c] ?? null) === v),
    not: (c: string, _o: string, v: unknown) => f((r) => (r[c] ?? null) !== v),
    order: () => b,
    limit: (n: number) => {
      limit = n;
      return b;
    },
    // biome-ignore lint/suspicious/noThenProperty: thenable query builder, like supabase-js.
    then: (resolve: (v: unknown) => unknown) => resolve(run()),
  };
  return b;
}
const db = { from: (t: string) => query(t) } as unknown as Db;

const vec = (seed: number): number[] =>
  Array.from({ length: EMBEDDING_DIMENSIONS }, (_, i) => (i === 0 ? seed : 0.001));
const OLD = "[0.5,0.5]";
const FAMILY = "nomic-embed-text";
const NOMIC_UNIT_MODEL = "nomic-embed-text+doc-v1";

function embedderFor(
  fn: (texts: string[]) => Promise<number[][]> = async (texts) => texts.map((_, i) => vec(i + 1)),
): UnitEmbedder & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    family: FAMILY,
    calls,
    embedBatch: async (texts) => {
      calls.push(texts);
      return fn(texts);
    },
  };
}
const ok = (r: ReembedResult | ReembedError): ReembedResult => {
  if (!r.ok) throw new Error(`expected ok, got ${r.code}: ${r.message}`);
  return r;
};

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k];
  updates.length = 0;
  failUpdateFor = new Set();
  resetEmbeddingFamilyCacheForTests();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const t of REEMBED_TABLES) tables[t] = [];
});

describe("reembedFilter", () => {
  it("default target: foreign means any named model", () => {
    expect(reembedFilter(null, true)).toBe(
      "and(embedding.is.null,embedding_failed_at.is.null),and(embedding.not.is.null,embedding_model.not.is.null)",
    );
  });
  it("named target quotes the value and counts NULL (default family) as foreign", () => {
    expect(reembedFilter("qwen3-embedding:0.6b", true)).toBe(
      'and(embedding.is.null,embedding_failed_at.is.null),and(embedding.not.is.null,or(embedding_model.is.null,embedding_model.neq."qwen3-embedding:0.6b"))',
    );
  });
  it("without embedding_failed_at only foreign-family rows are selected, never rows without a vector", () => {
    expect(reembedFilter(null, false)).toBe("and(embedding.not.is.null,embedding_model.not.is.null)");
    expect(reembedFilter("qwen3-embedding:0.6b", false)).toBe(
      'and(embedding.not.is.null,or(embedding_model.is.null,embedding_model.neq."qwen3-embedding:0.6b"))',
    );
  });
});

describe("reembedBatch", () => {
  it("selects only missing or foreign rows and never touches rows of the configured family", async () => {
    tables.session_memories = [
      { id: "a", text: "default-family row", embedding: OLD, embedding_model: null },
      { id: "b", text: "already nomic", embedding: OLD, embedding_model: FAMILY },
      { id: "c", text: "no vector yet", embedding: null, embedding_model: null },
      { id: "d", text: "other model", embedding: OLD, embedding_model: "all-minilm" },
    ];
    const e = embedderFor();
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: e }));
    expect(r.table).toBe("session_memories");
    expect(r.done).toBe(2);
    // session_memories has no failed marker, so a never-embedded row ("c") is left to the normal write path.
    expect(e.calls[0]).toEqual(["default-family row", "other model"]);
    expect(tables.session_memories.find((x) => x.id === "b")?.embedding).toBe(OLD);
    expect(tables.session_memories.find((x) => x.id === "c")?.embedding).toBeNull();
    expect(updates.map((u) => u.id).sort()).toEqual(["a", "d"]);
    for (const u of updates) expect(u.payload.embedding_model).toBe(FAMILY);
    expect(r.remaining_by_table?.session_memories).toBe(0);
  });

  it("writes embedding_model NULL (explicit) when the target is the default family", async () => {
    tables.session_memories = [{ id: "a", text: "x", embedding: OLD, embedding_model: FAMILY }];
    const e = { ...embedderFor(), family: "text-embedding-3-small" };
    const r = ok(await reembedBatch(db, { family: "text-embedding-3-small", embedder: e }));
    expect(r.done).toBe(1);
    expect(updates[0].payload).toHaveProperty("embedding_model", null);
  });

  it("writes a padded-width vector string and clears embedding_failed_at on success", async () => {
    tables.conversation_chunks = [
      { id: "k1", text: "chunk", embedding: null, embedding_model: null, embedding_failed_at: null },
    ];
    // Cursor into the third table: the first two are empty anyway.
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: embedderFor() }));
    expect(r.table).toBe("conversation_chunks");
    const u = updates[0].payload;
    expect(String(u.embedding).split(",")).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(u.embedding_failed_at).toBeNull();
  });

  it("skips empty-text sentinel chunks", async () => {
    tables.conversation_chunks = [
      { id: "s", text: "", embedding: null, embedding_model: null, embedding_failed_at: null },
    ];
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: embedderFor() }));
    expect(r.finished).toBe(true);
    expect(updates).toHaveLength(0);
  });

  it("re-keys raw units: model id, text_hash of the prefixed string, nothing else touched", async () => {
    tables.session_raw_units = [
      {
        id: "u1",
        text: "unit text",
        embedding: OLD,
        embedding_model: "text-embedding-3-small",
        text_hash: "old",
        embedding_failed_at: null,
      },
    ];
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: embedderFor() }));
    expect(r.table).toBe("session_raw_units");
    expect(updates[0].payload).toMatchObject({
      embedding_model: NOMIC_UNIT_MODEL,
      text_hash: unitTextHash("unit text", FAMILY),
      embedding_failed_at: null,
    });
  });

  it("embeds the nomic document prefix for raw units only", async () => {
    tables.session_memories = [{ id: "m", text: "memory", embedding: OLD, embedding_model: null }];
    tables.session_raw_units = [
      { id: "u", text: "unit", embedding: null, embedding_model: null, embedding_failed_at: null },
    ];
    const e = embedderFor();
    let cursor = null as ReembedResult["next"];
    for (let i = 0; i < 6; i++) {
      const r = ok(await reembedBatch(db, { family: FAMILY, embedder: e, cursor }));
      if (r.finished) break;
      cursor = r.next;
    }
    expect(e.calls.flat()).toEqual(["memory", "search_document: unit"]);
  });

  it("is resumable: walks tables in order via the cursor and ends finished with nothing left", async () => {
    tables.session_memories = [
      { id: "m1", text: "a", embedding: OLD, embedding_model: null },
      { id: "m2", text: "b", embedding: OLD, embedding_model: null },
      { id: "m3", text: "c", embedding: OLD, embedding_model: null },
    ];
    tables.conversations = [
      { id: "c1", title: "t", messages: [{ role: "user", content: "hi" }], embedding: OLD, embedding_model: null },
    ];
    const e = embedderFor();
    let cursor = null as ReembedResult["next"];
    const seen: Array<[string | null, number]> = [];
    for (let i = 0; i < 10; i++) {
      const r = ok(await reembedBatch(db, { family: FAMILY, embedder: e, batch: 2, cursor }));
      seen.push([r.table, r.done]);
      if (r.finished) break;
      cursor = r.next;
    }
    expect(seen.slice(0, 3)).toEqual([
      ["session_memories", 2],
      ["session_memories", 1],
      ["conversations", 1],
    ]);
    expect(seen.at(-1)?.[1]).toBe(0);
    // A second full run is a no-op (idempotent).
    const again = ok(await reembedBatch(db, { family: FAMILY, embedder: e }));
    expect(again.finished).toBe(true);
    expect(again.done).toBe(0);
    expect(Object.values(again.remaining_by_table ?? {})).toEqual([0, 0, 0, 0]);
  });

  it("caps the batch size", async () => {
    tables.session_memories = Array.from({ length: MAX_REEMBED_BATCH + 20 }, (_, i) => ({
      id: `m${String(i).padStart(4, "0")}`,
      text: `t${i}`,
      embedding: OLD,
      embedding_model: null,
    }));
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: embedderFor(), batch: 100000 }));
    expect(r.done).toBe(MAX_REEMBED_BATCH);
  });

  it("retires a row whose own text cannot embed: vector cleared, failed marker set, loop still ends", async () => {
    tables.conversation_chunks = [
      { id: "g", text: "good", embedding: OLD, embedding_model: null, embedding_failed_at: null },
      { id: "x", text: "bad", embedding: OLD, embedding_model: null, embedding_failed_at: null },
    ];
    const e = embedderFor(async (texts) => {
      if (texts.length > 1 || texts[0] === "bad") throw Object.assign(new Error("invalid input"), { status: 400 });
      return [vec(1)];
    });
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: e }));
    expect(r.done).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.deferred).toBe(0);
    const bad = tables.conversation_chunks.find((x) => x.id === "x");
    expect(bad?.embedding).toBeNull();
    expect(bad?.embedding_model).toBeNull();
    expect(bad?.embedding_failed_at).toEqual(expect.any(String));
    // Retired rows are no longer selected, so the store stops blocking on a foreign vector.
    expect(r.remaining_by_table?.conversation_chunks).toBe(0);
  });

  it("changes nothing when no text embeds (provider down)", async () => {
    tables.session_memories = [{ id: "a", text: "x", embedding: OLD, embedding_model: null }];
    const e = embedderFor(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r = await reembedBatch(db, { family: FAMILY, embedder: e });
    expect(r).toMatchObject({ ok: false, code: "embedder_unavailable" });
    expect(updates).toHaveLength(0);
    expect(tables.session_memories[0].embedding).toBe(OLD);
  });

  it("hands a 429 back before writing anything, with Retry-After", async () => {
    tables.session_memories = [{ id: "a", text: "x", embedding: OLD, embedding_model: null }];
    const e = embedderFor(async () => {
      throw Object.assign(new Error("slow down"), { status: 429, headers: { "retry-after": "7" } });
    });
    const r = await reembedBatch(db, { family: FAMILY, embedder: e });
    expect(r).toMatchObject({ ok: false, code: "rate_limited", retryAfterMs: 7000 });
    expect(updates).toHaveLength(0);
    // A 429 must not be retried one text at a time.
    expect(e.calls).toHaveLength(1);
  });

  it("leaves a row selected when its write fails, so the next run retries it", async () => {
    tables.session_memories = [{ id: "a", text: "x", embedding: OLD, embedding_model: null }];
    failUpdateFor.add("a");
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: embedderFor() }));
    expect(r.done).toBe(0);
    expect(r.remaining_by_table?.session_memories).toBe(1);
  });

  it("answers no_embedder when none is configured or its family differs, but still counts on dry run", async () => {
    tables.session_memories = [{ id: "a", text: "x", embedding: OLD, embedding_model: null }];
    expect(await reembedBatch(db, { family: FAMILY, embedder: null })).toMatchObject({ code: "no_embedder" });
    expect(await reembedBatch(db, { family: FAMILY, embedder: { ...embedderFor(), family: "other" } })).toMatchObject({
      code: "no_embedder",
    });
    const dry = ok(await reembedBatch(db, { family: FAMILY, embedder: null, dryRun: true }));
    expect(dry.remaining_by_table?.session_memories).toBe(1);
  });

  it("dry run writes nothing and splits counts into missing / default-family / other-family", async () => {
    tables.session_memories = [
      { id: "a", text: "a", embedding: OLD, embedding_model: null },
      { id: "b", text: "b", embedding: OLD, embedding_model: "all-minilm" },
      { id: "c", text: "c", embedding: null, embedding_model: null },
      { id: "d", text: "d", embedding: OLD, embedding_model: FAMILY },
    ];
    const e = embedderFor();
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: e, dryRun: true }));
    expect(r.dry_run).toBe(true);
    // "c" (never embedded) is reported but not in `remaining`: session_memories has no failed marker.
    expect(r.counts?.session_memories).toEqual({ remaining: 2, missing: 1, foreign_default: 1, foreign_other: 1 });
    expect(e.calls).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it("drops the cached family check so writes resume right after the store is converted", async () => {
    tables.session_memories = [{ id: "a", text: "x", embedding: OLD, embedding_model: null }];
    const env = { MEMBRAL_LOCAL: "1" };
    await expect(assertEmbeddingFamilyWritable(db, FAMILY, { env })).rejects.toThrow(/membral local reembed/);
    ok(await reembedBatch(db, { family: FAMILY, embedder: embedderFor() }));
    await expect(assertEmbeddingFamilyWritable(db, FAMILY, { env })).resolves.toBeUndefined();
  });
});

const chunk = (id: string, text: string, over: Row = {}): Row => ({
  id,
  text,
  embedding: OLD,
  embedding_model: null,
  embedding_failed_at: null,
  ...over,
});
const status = (code: number, msg = "failed") => Object.assign(new Error(msg), { status: code });
const overflow = () => status(400, "This model's maximum context length is 8192 tokens");
const untouched = (id: string) => {
  const r = tables.conversation_chunks.find((x) => x.id === id);
  expect(r).toMatchObject({ embedding: OLD, embedding_model: null, embedding_failed_at: null });
};

describe("reembedBatch: transient failures never destroy a vector (finding 1)", () => {
  it("defers a text that failed with a 5xx or no status, leaves the row as it was, and a re-run picks it up", async () => {
    tables.conversation_chunks = [chunk("a", "good"), chunk("b", "flaky"), chunk("c", "reset")];
    let flaky = true;
    const e = embedderFor(async (texts) => {
      if (texts.length > 1) throw status(503);
      if (flaky && texts[0] === "flaky") throw status(503);
      if (flaky && texts[0] === "reset") throw new Error("socket hang up");
      return [vec(1)];
    });
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: e }));
    expect(r).toMatchObject({ done: 1, failed: 0, deferred: 2, finished: false });
    untouched("b");
    untouched("c");
    expect(r.next).toEqual({ table: "conversation_chunks", after: "c" }); // the cursor moved past the deferred rows
    expect(r.remaining_by_table?.conversation_chunks).toBe(2); // still foreign: a re-run selects them
    flaky = false;
    const again = ok(await reembedBatch(db, { family: FAMILY, embedder: e }));
    expect(again).toMatchObject({ done: 2, failed: 0, deferred: 0 });
    expect(tables.conversation_chunks.every((x) => x.embedding_model === FAMILY || x.embedding_model === null)).toBe(
      true,
    );
    expect(tables.conversation_chunks.every((x) => x.embedding !== null)).toBe(true);
  });

  it("is embedder_unavailable, with nothing written, when every text failed transiently", async () => {
    tables.conversation_chunks = [chunk("a", "x"), chunk("b", "y")];
    const e = embedderFor(async () => {
      throw status(500);
    });
    expect(await reembedBatch(db, { family: FAMILY, embedder: e })).toMatchObject({
      ok: false,
      code: "embedder_unavailable",
    });
    expect(updates).toHaveLength(0);
  });

  it("retires on a per-text 4xx only when a canary text proves the provider works", async () => {
    tables.conversation_chunks = [chunk("a", "bad one"), chunk("b", "bad two")];
    const refuse = async (texts: string[]) => {
      if (texts[0].startsWith("bad") || texts.length > 1) throw status(400, "invalid input");
      return [vec(1)];
    };
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: embedderFor(refuse) }));
    expect(r).toMatchObject({ done: 0, failed: 2, deferred: 0 });
    expect(tables.conversation_chunks.every((x) => x.embedding === null && x.embedding_failed_at)).toBe(true);
  });

  it("does not retire anything when even the canary is refused (a misconfigured model 400s everything)", async () => {
    tables.conversation_chunks = [chunk("a", "x"), chunk("b", "y")];
    const e = embedderFor(async () => {
      throw status(400, "model does not support this");
    });
    expect(await reembedBatch(db, { family: FAMILY, embedder: e })).toMatchObject({
      ok: false,
      code: "embedder_unavailable",
    });
    expect(updates).toHaveLength(0);
    untouched("a");
    untouched("b");
  });

  it("treats auth and not-found answers as provider faults, never as a verdict on the text", async () => {
    tables.conversation_chunks = [chunk("a", "x"), chunk("b", "y")];
    for (const code of [401, 403, 404, 408]) {
      const e = embedderFor(async () => {
        throw status(code);
      });
      expect(await reembedBatch(db, { family: FAMILY, embedder: e })).toMatchObject({ code: "embedder_unavailable" });
    }
    expect(updates).toHaveLength(0);
  });
});

describe("reembedBatch: token overflow, breaker and time budget (finding 2)", () => {
  it("halves an overflowing text until it fits and stores that vector", async () => {
    tables.conversation_chunks = [chunk("a", "x".repeat(2000)), chunk("b", "short")];
    const e = embedderFor(async (texts) => {
      if (texts.length > 1) throw status(503);
      if (texts[0].length > 600) throw overflow();
      return [vec(1)];
    });
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: e }));
    expect(r).toMatchObject({ done: 2, failed: 0, deferred: 0 });
    expect(e.calls.map((c) => c[0].length)).toEqual([2000, 2000, 1000, 500, 5]); // batch, then 2000 -> 1000 -> 500
  });

  it("retires a text that still overflows after MAX_HALVINGS halvings", async () => {
    tables.conversation_chunks = [chunk("a", "x".repeat(4000))];
    const e = embedderFor(async (texts) => {
      if (texts[0].length > 100) throw overflow(); // the short canary text fits
      return [vec(1)];
    });
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: e }));
    expect(r).toMatchObject({ done: 0, failed: 1 });
    expect(tables.conversation_chunks[0].embedding).toBeNull();
    // batch + original + three halvings (2000, 1000, 500), then retired.
    expect(e.calls.slice(0, 5).map((c) => c[0].length)).toEqual([4000, 4000, 2000, 1000, 500]);
  });

  it("stops after EMBED_BREAKER_FAILURES consecutive transient failures and leaves the rest for the next call", async () => {
    tables.conversation_chunks = Array.from({ length: 8 }, (_, i) => chunk(`r${i}`, `t${i}`));
    const e = embedderFor(async (texts) => {
      if (texts.length > 1 || texts[0] !== "t0") throw status(503);
      return [vec(1)];
    });
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: e }));
    // batch (streak 1), t0 ok (0), t1, t2, t3 fail (3): stop. t4..t7 were never tried.
    expect(e.calls).toHaveLength(5);
    expect(r).toMatchObject({ done: 1, deferred: 3, failed: 0, finished: false });
    expect(r.next).toEqual({ table: "conversation_chunks", after: "r3" });
  });

  it("stops at the time budget, writes what is done and returns the cursor past the last text tried", async () => {
    tables.conversation_chunks = Array.from({ length: 5 }, (_, i) => chunk(`r${i}`, `t${i}`));
    let clock = 0;
    const e = embedderFor(async (texts) => {
      clock += 100_000; // every call takes 100 s
      if (texts.length > 1) throw status(503);
      return [vec(1)];
    });
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: e, budgetMs: 250_000, now: () => clock }));
    // batch (100 s), r0 (200 s), r1 (300 s, tried because 200 s < 250 s), then over budget.
    expect(r).toMatchObject({ done: 2, deferred: 0, finished: false });
    expect(r.next).toEqual({ table: "conversation_chunks", after: "r1" });
    expect(tables.conversation_chunks.filter((x) => x.embedding_model === FAMILY).map((x) => x.id)).toEqual([
      "r0",
      "r1",
    ]);
    // The next call carries on from the cursor.
    clock = 0;
    const next = ok(
      await reembedBatch(db, { family: FAMILY, embedder: e, budgetMs: 250_000, now: () => clock, cursor: r.next }),
    );
    expect(next.done).toBe(2);
  });

  it("always makes progress, even when the budget is already spent", async () => {
    tables.conversation_chunks = [chunk("a", "x"), chunk("b", "y")];
    const e = embedderFor(async (texts) => {
      if (texts.length > 1) throw status(503);
      return [vec(1)];
    });
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: e, budgetMs: -1 }));
    expect(r.done).toBe(1);
    expect(r.next?.after).toBe("a");
  });
});

describe("reembedBatch: counting, caps and clobber guards (findings 3-6)", () => {
  it("remaining reaches 0 for session_memories even with a never-embedded row (finding 3)", async () => {
    tables.session_memories = [
      { id: "a", text: "foreign", embedding: OLD, embedding_model: "all-minilm" },
      { id: "b", text: "never embedded", embedding: null, embedding_model: null },
    ];
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: embedderFor() }));
    expect(r.remaining_by_table?.session_memories).toBe(0);
    const again = ok(await reembedBatch(db, { family: FAMILY, embedder: embedderFor() }));
    expect(again.finished).toBe(true);
  });

  it("counts remaining only on the first call, a dry run and the last call (finding 4)", async () => {
    tables.session_memories = ["a", "b", "c"].map((id) => ({ id, text: id, embedding: OLD, embedding_model: null }));
    const e = embedderFor();
    const first = ok(await reembedBatch(db, { family: FAMILY, embedder: e, batch: 2 }));
    expect(first.remaining_by_table).not.toBeNull();
    const mid = ok(await reembedBatch(db, { family: FAMILY, embedder: e, batch: 2, cursor: first.next }));
    expect(mid.done).toBe(1);
    expect(mid.remaining_by_table).toBeNull();
    const last = ok(await reembedBatch(db, { family: FAMILY, embedder: e, batch: 2, cursor: mid.next }));
    expect(last.finished).toBe(true);
    expect(last.remaining_by_table).toEqual({
      session_memories: 0,
      conversations: 0,
      conversation_chunks: 0,
      session_raw_units: 0,
    });
  });

  it("caps a conversations batch at 32 rows (finding 5)", async () => {
    tables.conversations = Array.from({ length: 40 }, (_, i) => ({
      id: `c${String(i).padStart(3, "0")}`,
      title: "t",
      messages: [{ role: "user", content: "hi" }],
      embedding: OLD,
      embedding_model: null,
      embedding_failed_at: null,
    }));
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: embedderFor(), batch: 256 }));
    expect(r.table).toBe("conversations");
    expect(r.done).toBe(32);
  });

  it("does not clobber a row another writer refreshed since it was read, and does not count it (finding 6)", async () => {
    tables.session_memories = [
      { id: "a", text: "a", embedding: OLD, embedding_model: null },
      { id: "b", text: "b", embedding: OLD, embedding_model: null },
    ];
    const e = embedderFor(async (texts) => {
      // Another writer converts "a" while this call is embedding.
      Object.assign(tables.session_memories[0], { embedding: "[9,9]", embedding_model: FAMILY });
      return texts.map(() => vec(1));
    });
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: e }));
    expect(r.done).toBe(1);
    expect(tables.session_memories[0].embedding).toBe("[9,9]");
    expect(updates.map((u) => u.id)).toEqual(["b"]);
  });

  it("does not retire a row another writer refreshed either", async () => {
    tables.conversation_chunks = [chunk("a", "bad"), chunk("b", "good")];
    const e = embedderFor(async (texts) => {
      Object.assign(tables.conversation_chunks[0], { embedding: "[9,9]", embedding_model: FAMILY });
      if (texts.length > 1 || texts[0] === "bad") throw status(400, "invalid input");
      return [vec(1)];
    });
    const r = ok(await reembedBatch(db, { family: FAMILY, embedder: e }));
    expect(r).toMatchObject({ done: 1, failed: 0 });
    expect(tables.conversation_chunks[0].embedding).toBe("[9,9]");
  });
});

describe("reembedBatch: a model wider than the store (finding 8)", () => {
  it("answers embedding_dimension and writes nothing, not even the no-text retirements", async () => {
    tables.session_memories = [
      { id: "a", text: "", embedding: OLD, embedding_model: null },
      { id: "b", text: "real", embedding: OLD, embedding_model: null },
    ];
    const e = embedderFor(async () => {
      throw new EmbeddingDimensionError(2048);
    });
    const r = await reembedBatch(db, { family: FAMILY, embedder: e });
    expect(r).toMatchObject({ ok: false, code: "embedding_dimension", dimensions: 2048 });
    expect(updates).toHaveLength(0);
    expect(tables.session_memories.every((x) => x.embedding === OLD)).toBe(true);
  });

  it("also catches a custom embedder that returns too-wide vectors", async () => {
    tables.session_memories = [{ id: "a", text: "x", embedding: OLD, embedding_model: null }];
    const e = embedderFor(async (texts) => texts.map(() => new Array(2048).fill(0.1)));
    expect(await reembedBatch(db, { family: FAMILY, embedder: e })).toMatchObject({
      code: "embedding_dimension",
    });
    expect(updates).toHaveLength(0);
  });
});
