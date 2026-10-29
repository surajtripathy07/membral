// Box 2.4 / V4: the gap diff marks records the handoff note does not cover. Fakes only: no network, no paid API.

import { createFakeDb, type Row } from "@membral/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HANDOFF_GAP_MAX_SEGMENTS, handoffSegments, markHandoffGaps } from "../session-handoff-gap";

const USER = "u1";
const SESSION = "s1";

const rec = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  user_id: USER,
  code_session_id: SESSION,
  kind: "decision",
  text: `text ${id}`,
  verified: true,
  retired_at: null,
  embedding: null,
  embedding_model: null,
  covered_by_handoff: null,
  ...over,
});

const dbOf = (rows: Row[]) => createFakeDb({ flavour: "db", tables: { session_memories: rows } });
const marks = (db: ReturnType<typeof dbOf>) =>
  Object.fromEntries(db.getRows("session_memories").map((r) => [r.id as string, r.covered_by_handoff]));

/** An embedder that maps each segment text to a vector via `table`; records the call. */
function embedder(table: Record<string, number[]>, costUsd = 0) {
  const embedMany = vi.fn(async (o: { texts: string[] }) => ({
    vectors: o.texts.map((t) => table[t] ?? [0, 0, 1]),
    record: { cost_usd: costUsd } as never,
  }));
  return { embedMany } as never as Parameters<typeof markHandoffGaps>[0]["llm"] & { embedMany: typeof embedMany };
}

afterEach(() => vi.unstubAllEnvs());

describe("handoff gap diff", () => {
  it("covers a record the plain note renders, by id, with no embedding call", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "text-embedding-3-small");
    const db = dbOf([rec("a"), rec("b")]);
    const llm = embedder({});
    const res = await markHandoffGaps({ supabase: db.client, llm }, USER, SESSION, {
      text: "Decisions:\n- text a",
      renderedRecordIds: new Set(["a"]),
    });
    // b is not rendered and has no stored embedding: unknown (null), never "uncovered".
    expect(marks(db)).toEqual({ a: true, b: null });
    expect(res).toMatchObject({ status: "marked", covered: 1, uncovered: 0, unknown: 1 });
    // Nothing comparable (b has no vector): no embedding call at all.
    expect(llm.embedMany).not.toHaveBeenCalled();
  });

  it("covers by embedding at the family cut and marks the rest false", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "text-embedding-3-small"); // semantic_dedup cut 0.8
    const db = dbOf([
      rec("near", { embedding: [1, 0, 0], embedding_model: null }),
      rec("far", { embedding: [0, 1, 0], embedding_model: null }),
      rec("edge", { embedding: JSON.stringify([0.79, 0.613, 0]) as never }), // cosine ~0.79 to [1,0,0]: below the cut
      rec("retired", { retired_at: "2026-10-01T00:00:00Z", embedding: [1, 0, 0] }),
      rec("unverified", { verified: false, embedding: [0, 1, 0] }),
    ]);
    const llm = embedder({ "Cache the importer": [1, 0, 0] });
    const res = await markHandoffGaps({ supabase: db.client, llm }, USER, SESSION, {
      text: "Next steps:\n- Cache the importer",
      renderedRecordIds: new Set(),
    });
    expect(marks(db)).toEqual({ near: true, far: false, edge: false, retired: null, unverified: null });
    expect(res).toMatchObject({ status: "marked", covered: 1, uncovered: 2, segments: 1 });
  });

  it("does not diff when the family has no calibrated cut: marks stay null and old marks are cleared", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "some-uncalibrated-embed");
    const db = dbOf([rec("a", { embedding: [1, 0, 0], covered_by_handoff: false }), rec("b")]);
    const llm = embedder({});
    const res = await markHandoffGaps({ supabase: db.client, llm }, USER, SESSION, {
      text: "- x",
      renderedRecordIds: new Set(["b"]),
    });
    expect(res).toMatchObject({ status: "skipped", reason: "uncalibrated_family" });
    expect(llm.embedMany).not.toHaveBeenCalled();
    expect(marks(db)).toEqual({ a: null, b: null });
  });

  it("does not diff when embeddings are down: marks stay null", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "text-embedding-3-small");
    const db = dbOf([rec("a", { embedding: [1, 0, 0] })]);
    const llm = {
      embedMany: vi.fn(async () => {
        throw new Error("embeddings down");
      }),
    } as never;
    const res = await markHandoffGaps({ supabase: db.client, llm }, USER, SESSION, {
      text: "- Something",
      renderedRecordIds: new Set(),
    });
    expect(res).toMatchObject({ status: "skipped", reason: "embeddings_unavailable" });
    expect(marks(db)).toEqual({ a: null });
  });

  it("embeds at most 40 segments", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "text-embedding-3-small");
    const text = Array.from({ length: 55 }, (_, i) => `- point ${i}`).join("\n");
    const db = dbOf([rec("a", { embedding: [1, 0, 0] })]);
    const llm = embedder({});
    const res = await markHandoffGaps({ supabase: db.client, llm }, USER, SESSION, {
      text,
      renderedRecordIds: new Set(),
    });
    expect(llm.embedMany.mock.calls[0][0].texts).toHaveLength(HANDOFF_GAP_MAX_SEGMENTS);
    expect(llm.embedMany).toHaveBeenCalledTimes(1);
    expect(res).toMatchObject({ segments: 40, segmentsTruncated: true });
  });

  it("splits the note structurally: bullets stripped, headings and blanks dropped", () => {
    expect(handoffSegments("Open items:\n- a thing\n\nDecisions:\n* another\nplain line")).toEqual([
      "a thing",
      "another",
      "plain line",
    ]);
  });
});

/** A client whose `session_memories` updates are recorded in order; `failOn` (1-based) throws on that update. */
function recordUpdates(db: ReturnType<typeof dbOf>, failOn?: number) {
  const writes: Array<boolean | null> = [];
  const client = {
    from: (t: string) => {
      const b = db.client.from(t) as unknown as Record<string, unknown>;
      return new Proxy(b, {
        get(target, prop) {
          if (prop === "update") {
            return (v: { covered_by_handoff: boolean | null }) => {
              writes.push(v.covered_by_handoff);
              if (failOn === writes.length) throw new Error("write failed");
              return (target.update as (x: unknown) => unknown)(v);
            };
          }
          const x = target[prop as string];
          return typeof x === "function" ? (x as (...a: unknown[]) => unknown).bind(target) : x;
        },
      });
    },
  } as unknown as typeof db.client;
  return { client, writes };
}

describe("handoff gap diff: ADV fixes", () => {
  const three = () => dbOf([rec("near", { embedding: [1, 0, 0] }), rec("far", { embedding: [0, 1, 0] }), rec("noVec")]);
  const note = { text: "- Cache the importer", renderedRecordIds: new Set<string>() };

  it("writes false before true before null, with no clear-first all-null window", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "text-embedding-3-small");
    const db = three();
    const { client, writes } = recordUpdates(db);
    await markHandoffGaps(
      { supabase: client, llm: embedder({ "Cache the importer": [1, 0, 0] }) },
      USER,
      SESSION,
      note,
    );
    expect(writes).toEqual([false, true, null]);
  });

  it("a failure between writes never marks a covered record false", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "text-embedding-3-small");
    const db = three();
    const { client } = recordUpdates(db, 2);
    const res = await markHandoffGaps(
      { supabase: client, llm: embedder({ "Cache the importer": [1, 0, 0] }) },
      USER,
      SESSION,
      note,
    );
    expect(res).toMatchObject({ reason: "failed" });
    expect(marks(db).near).not.toBe(false);
    expect(marks(db).far).toBe(false);
  });

  it("returns the embedding cost from the embed record", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "text-embedding-3-small");
    const res = await markHandoffGaps({ supabase: three().client, llm: embedder({}, 0.0021) }, USER, SESSION, note);
    expect(res.costUsd).toBeCloseTo(0.0021);
  });

  it("makes no embed call once the run is stopped or the budget is spent, with distinct reasons", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "text-embedding-3-small");
    const llm = embedder({});
    const stopped = await markHandoffGaps(
      { supabase: three().client, llm, shouldStop: () => true },
      USER,
      SESSION,
      note,
    );
    const broke = await markHandoffGaps({ supabase: three().client, llm, remainingBudgetUsd: 0 }, USER, SESSION, note);
    expect(stopped).toMatchObject({ status: "skipped", reason: "run_stopped" });
    expect(broke).toMatchObject({ status: "skipped", reason: "budget_exhausted" });
    expect(llm.embedMany).not.toHaveBeenCalled();
  });

  it("uses the client's embedding family for the cut, not only the env", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "text-embedding-3-small");
    const llm = { ...embedder({}), embedFamily: "some-uncalibrated-embed" } as never;
    const res = await markHandoffGaps({ supabase: three().client, llm }, USER, SESSION, note);
    expect(res).toMatchObject({ status: "skipped", reason: "uncalibrated_family" });
  });

  it("a record of another embedding family is unknown (null), never uncovered", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "text-embedding-3-small");
    const db = dbOf([rec("other", { embedding: [0, 1, 0], embedding_model: "nomic-embed-text" })]);
    const llm = embedder({});
    await markHandoffGaps({ supabase: db.client, llm }, USER, SESSION, note);
    expect(marks(db)).toEqual({ other: null });
    expect(llm.embedMany).not.toHaveBeenCalled();
  });

  it("beyond the 40-segment cap, a record matching only segment 45 is uncovered; one matching segment 39 is covered", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "text-embedding-3-small");
    const text = Array.from({ length: 55 }, (_, i) => `- point ${i}`).join("\n");
    const db = dbOf([rec("in", { embedding: [1, 0, 0] }), rec("out", { embedding: [0, 1, 0] })]);
    const llm = embedder({ "point 39": [1, 0, 0], "point 45": [0, 1, 0] });
    await markHandoffGaps({ supabase: db.client, llm }, USER, SESSION, { text, renderedRecordIds: new Set() });
    expect(marks(db)).toEqual({ in: true, out: false });
  });

  it("never touches another user's or session's row with the same id", async () => {
    vi.stubEnv("MEMBRAL_EMBEDDING_MODEL", "text-embedding-3-small");
    const db = dbOf([
      rec("a", { embedding: [0, 1, 0] }),
      rec("a", { user_id: "u2", covered_by_handoff: true }),
      rec("a", { code_session_id: "s2", covered_by_handoff: true }),
    ]);
    await markHandoffGaps({ supabase: db.client, llm: embedder({ x: [1, 0, 0] }) }, USER, SESSION, {
      text: "- x",
      renderedRecordIds: new Set(),
    });
    const byKey = db
      .getRows("session_memories")
      .map((r) => `${r.user_id}/${r.code_session_id}=${r.covered_by_handoff}`);
    expect(byKey).toEqual(["u1/s1=false", "u2/s1=true", "u1/s2=true"]);
  });
});
