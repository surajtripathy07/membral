// G2 step 2.4a: planInsert, the pure half of insertMemoryRecords. The first
// case is seeded from the pipeline golden (claude-code-rich's one
// session_memories upsert); the rest pin each branch of the M4 merge rule.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DUPLICATE_RETIRE_REASON,
  RERUN_RETIRE_REASON,
  RESOLVED_IN_SESSION_RETIRE_REASON,
} from "@/lib/domain/retire-reasons";
import { type ExistingRow, type InsertableRecord, type InsertContext, planInsert } from "../insert";

const ctx: InsertContext = {
  userId: "u1",
  codeProjectId: "p1",
  sessionId: "s1",
  branch: "main",
  retiredAt: "2026-09-28T00:00:00.000Z",
};

function rec(over: Partial<InsertableRecord>): InsertableRecord {
  return {
    windowIndex: 0,
    kind: "decision",
    text: "Cache keyed on repo and branch",
    quote: "keyed the cache on repo + branch",
    turn_idx: 1,
    turn_role: "assistant",
    ref: null,
    ref_kind: null,
    durable: true,
    thread: null,
    scope: "project",
    confidence: 0.9,
    verified: true,
    unverifiedReason: null,
    contentHash: "h1",
    paths: [],
    dangling: false,
    priority: false,
    embedding: null,
    ...over,
  };
}

function existing(...rows: ExistingRow[]): Map<string, ExistingRow> {
  return new Map(rows.map((r) => [r.content_hash, r]));
}

describe("planInsert", () => {
  it("reproduces the pipeline golden's upsert payload (claude-code-rich)", () => {
    const oplogPath = fileURLToPath(
      new URL("../../../../__golden__/pipeline/claude-code-rich/db-oplog.json", import.meta.url),
    );
    const oplog = JSON.parse(readFileSync(oplogPath, "utf8")) as Array<{
      table: string;
      op: string;
      payload: Array<Record<string, unknown>>;
    }>;
    const upsert = oplog.find((o) => o.table === "session_memories" && o.op === "upsert");
    expect(upsert?.payload.length).toBe(2);
    const payload = upsert?.payload ?? [];
    const records = payload.map((p) =>
      rec({
        kind: p.kind as InsertableRecord["kind"],
        text: p.text as string,
        quote: p.quote as string,
        turn_idx: p.turn_idx as number,
        turn_role: p.turn_role as InsertableRecord["turn_role"],
        ref: p.ref as string | null,
        ref_kind: p.ref_kind as InsertableRecord["ref_kind"],
        durable: p.durable as boolean,
        thread: p.thread as string | null,
        scope: p.scope as InsertableRecord["scope"],
        confidence: p.confidence as number,
        verified: p.verified as boolean,
        contentHash: p.content_hash as string,
        paths: p.paths as string[],
        priority: p.priority as boolean,
        embedding: JSON.parse(p.embedding as string) as number[],
      }),
    );
    const plan = planInsert(records, new Map(), {
      userId: payload[0].user_id as string,
      codeProjectId: payload[0].code_project_id as string,
      sessionId: payload[0].code_session_id as string,
      branch: payload[0].branch as string,
      retiredAt: ctx.retiredAt,
    });
    expect(plan.keepLive).toEqual(payload);
    expect(plan.lift).toEqual([]);
    expect(plan.insertRetired).toEqual([]);
    expect(plan.matchedOnly).toEqual([]);
    expect(plan.reasonBack.size).toBe(0);
    expect(plan.recurrenceIncrements.size).toBe(0);
  });

  it("writes session_title only when the session has a title (migration 122)", () => {
    expect(planInsert([rec({})], new Map(), ctx).keepLive[0]).not.toHaveProperty("session_title");
    const titled = planInsert([rec({})], new Map(), { ...ctx, sessionTitle: "Import retry design" });
    expect(titled.keepLive[0].session_title).toBe("Import retry design");
  });

  it("inserts an ungrounded record with no prior row already retired as unverified", () => {
    const plan = planInsert([rec({ verified: false, unverifiedReason: "quote_not_found" })], new Map(), ctx);
    expect(plan.insertRetired).toHaveLength(1);
    expect(plan.insertRetired[0]).toMatchObject({
      retired_at: ctx.retiredAt,
      retire_reason: "unverified:quote_not_found",
      verified: false,
    });
    expect(plan.keepLive).toEqual([]);
  });

  it("lifts a prior row retired rerun when the fact grounds again", () => {
    const prior = { id: "r1", content_hash: "h1", retired_at: "2026-01-01", retire_reason: RERUN_RETIRE_REASON };
    const plan = planInsert([rec({})], existing(prior), ctx);
    expect(plan.lift).toHaveLength(1);
    expect(plan.lift[0]).toMatchObject({ retired_at: null, retire_reason: null, content_hash: "h1" });
    expect(plan.keepLive).toEqual([]);
  });

  it("upserts a verified record over a row retired duplicate without un-retiring it", () => {
    const prior = { id: "r1", content_hash: "h1", retired_at: "2026-01-01", retire_reason: DUPLICATE_RETIRE_REASON };
    const plan = planInsert([rec({})], existing(prior), ctx);
    expect(plan.keepLive).toHaveLength(1);
    expect(plan.keepLive[0]).not.toHaveProperty("retired_at");
    expect(plan.lift).toEqual([]);
  });

  it("writes nothing for an explicit retireReason over a row retired otherwise", () => {
    const prior = { id: "r1", content_hash: "h1", retired_at: "2026-01-01", retire_reason: DUPLICATE_RETIRE_REASON };
    const plan = planInsert([rec({ retireReason: RESOLVED_IN_SESSION_RETIRE_REASON })], existing(prior), ctx);
    expect(plan.matchedOnly).toEqual([prior]);
    expect(plan.insertRetired).toEqual([]);
  });

  it("re-tags a prior rerun row with the ungrounded record's reason and writes nothing else", () => {
    const prior = { id: "r1", content_hash: "h1", retired_at: "2026-01-01", retire_reason: RERUN_RETIRE_REASON };
    const plan = planInsert([rec({ verified: false, unverifiedReason: "no_quote" })], existing(prior), ctx);
    expect(plan.matchedOnly).toEqual([prior]);
    expect([...plan.reasonBack]).toEqual([["unverified:no_quote", ["r1"]]]);
    expect(plan.insertRetired).toEqual([]);
  });

  it("counts a recurrence only for a new, verified, counting record", () => {
    const prior = { id: "r2", content_hash: "h2", retired_at: null, retire_reason: null };
    const plan = planInsert(
      [
        rec({ contentHash: "h1", recursOf: "root" }),
        rec({ contentHash: "h2", recursOf: "root" }),
        rec({ contentHash: "h3", recursOf: "root", countsRecurrence: false }),
        rec({ contentHash: "h4", recursOf: "root", verified: false }),
        rec({ contentHash: "h5", recursOf: "root2" }),
      ],
      existing(prior),
      ctx,
    );
    expect([...plan.recurrenceIncrements]).toEqual([
      ["root", 1],
      ["root2", 1],
    ]);
    expect(plan.keepLive.map((r) => r.recurs_of)).toEqual(["root", "root", "root", "root2"]);
  });
});

describe("planInsert embedding_model (migration 118, D-072)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("records the canonical family with a vector and null without one", () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "openai/nomic-embed-text");
    const plan = planInsert(
      [rec({ contentHash: "a", embedding: [1, 0] }), rec({ contentHash: "b", text: "other", embedding: null })],
      existing(),
      ctx,
    );
    const byHash = new Map(plan.keepLive.map((r) => [r.content_hash, r]));
    expect(byHash.get("a")?.embedding_model).toBe("nomic-embed-text");
    expect(byHash.get("b")).not.toHaveProperty("embedding_model");
  });

  it("omits the column for the default family (NULL = default; works on a pre-118 DB)", () => {
    const plan = planInsert([rec({ embedding: [1, 0] })], existing(), ctx);
    expect(plan.keepLive[0]).not.toHaveProperty("embedding_model");
  });
});

describe("planInsert embedding_failed_at (migration 138, #598)", () => {
  it("stamps a record whose embed failed and nulls its siblings, so the batch stays column-homogeneous", () => {
    const plan = planInsert(
      [
        rec({ contentHash: "bad", embedding: null, embeddingFailed: true }),
        rec({ contentHash: "ok", text: "other", embedding: [1, 0] }),
        rec({ contentHash: "unconfigured", text: "third", embedding: null }),
      ],
      existing(),
      ctx,
    );
    const byHash = new Map(plan.keepLive.map((r) => [r.content_hash, r]));
    expect(byHash.get("bad")?.embedding_failed_at).toBe(ctx.retiredAt);
    expect(byHash.get("ok")?.embedding_failed_at).toBeNull();
    expect(byHash.get("unconfigured")?.embedding_failed_at).toBeNull();
  });

  it("omits the key when nothing failed (unconfigured or blocked embeddings; works on a pre-138 DB)", () => {
    const plan = planInsert([rec({ embedding: null }), rec({ contentHash: "h2", embedding: [1, 0] })], existing(), ctx);
    for (const row of plan.keepLive) expect(row).not.toHaveProperty("embedding_failed_at");
  });

  it("carries the marker on lifted and retired-insert rows too", () => {
    const plan = planInsert(
      [rec({ contentHash: "u", verified: false, embedding: null, embeddingFailed: true })],
      existing(),
      ctx,
    );
    expect(plan.insertRetired[0].embedding_failed_at).toBe(ctx.retiredAt);
  });
});
