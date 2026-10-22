// Semantic dedup (migration 101): the RPC finds pairs in Postgres; the app
// clusters them, keeps the newest row of each cluster, retires the rest, logs
// every merge to memory_merges, and links the survivor's `supersedes`.

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SEMANTIC_DEDUP_MIN_SIM,
  mergeSemanticDuplicates,
  planSemanticMerges,
  SEMANTIC_DEDUP_KINDS,
  SEMANTIC_DUPLICATE_RETIRE_REASON,
  type SemanticDuplicatePair,
  semanticDedupKinds,
  semanticDedupMinSim,
} from "@/lib/memory/write";

const USER = "u1";

function mem(over: Partial<Row>): Row {
  return {
    user_id: USER,
    kind: "blocker",
    scope: "project",
    code_project_id: "p1",
    code_session_id: "s-old",
    retired_at: null,
    retire_reason: null,
    supersedes: null,
    created_at: "2026-09-20T00:00:00Z",
    ...over,
  };
}

const older = (a: Row, b: Row) => a.created_at < b.created_at || (a.created_at === b.created_at && a.id < b.id);

/**
 * A fake `memory_semantic_duplicates` applying the SQL's rules over given
 * sims (keyed "x:y", either order): same kind/scope/project, kind in p_kinds,
 * existing older than new, at least one side in p_record_ids (within-batch
 * pairs included), sim >= p_min_sim.
 */
function fakeRpc(rows: Row[], sims: Record<string, number>, calls: Array<Record<string, unknown>> = []) {
  return (args: Record<string, unknown>) => {
    calls.push(args);
    const ids = args.p_record_ids as string[] | null;
    const min = args.p_min_sim as number;
    const kinds = args.p_kinds as string[];
    const pairs: SemanticDuplicatePair[] = [];
    const live = rows.filter((r) => r.retired_at === null);
    for (const n of live) {
      for (const e of live) {
        if (!older(e, n)) continue;
        if (ids && !ids.includes(n.id) && !ids.includes(e.id)) continue;
        const sameScope =
          e.kind === n.kind && e.scope === n.scope && (n.scope === "global" || e.code_project_id === n.code_project_id);
        const sim = sims[`${n.id}:${e.id}`] ?? sims[`${e.id}:${n.id}`] ?? 0;
        if (sameScope && kinds.includes(n.kind) && sim >= min) {
          pairs.push({
            new_id: n.id,
            existing_id: e.id,
            sim,
            kind: n.kind,
            new_created_at: n.created_at,
            existing_created_at: e.created_at,
          });
        }
      }
    }
    return { data: pairs, error: null };
  };
}

function setup(rows: Row[], sims: Record<string, number>) {
  const merges: Row[] = [];
  const calls: Array<Record<string, unknown>> = [];
  const supabase = makeFakeSupabase(
    { session_memories: rows },
    {
      rpc: { memory_semantic_duplicates: fakeRpc(rows, sims, calls) },
      onInsert: (table, row) => {
        if (table === "memory_merges") merges.push(row);
      },
    },
  );
  return { supabase, merges, calls };
}

const byId = (rows: Row[], id: string) => rows.find((r) => r.id === id);

describe("mergeSemanticDuplicates", () => {
  it("retires the older memory, links supersedes, and logs the merge", async () => {
    const rows = [mem({ id: "old" }), mem({ id: "new", code_session_id: "s-new", created_at: "2026-09-25T00:00:00Z" })];
    const { supabase, merges } = setup(rows, { "new:old": 0.85 });
    expect(await mergeSemanticDuplicates(supabase, USER, ["new"])).toBe(1);
    expect(byId(rows, "old")?.retire_reason).toBe(SEMANTIC_DUPLICATE_RETIRE_REASON);
    expect(byId(rows, "new")?.retired_at).toBeNull();
    expect(byId(rows, "new")?.supersedes).toBe("old");
    expect(merges).toEqual([
      { user_id: USER, kept_id: "new", retired_id: "old", sim: 0.85, kind: "blocker", source: "write" },
    ]);
  });

  it("uses 0.80 by default: 0.80 merges, 0.79 does not", async () => {
    const rows = [
      mem({ id: "a" }),
      mem({ id: "b", created_at: "2026-09-21T00:00:00Z" }),
      mem({ id: "c", kind: "decision" }),
      mem({ id: "d", kind: "decision", created_at: "2026-09-21T00:00:00Z" }),
    ];
    const { supabase, calls } = setup(rows, { "b:a": 0.8, "d:c": 0.79 });
    expect(await mergeSemanticDuplicates(supabase, USER, ["b", "d"])).toBe(1);
    expect(calls[0]?.p_min_sim).toBe(0.8);
    expect(byId(rows, "a")?.retired_at).not.toBeNull();
    expect(byId(rows, "c")?.retired_at).toBeNull();
  });

  it("never merges outcomes, even when the RPC returns an outcome pair", async () => {
    const rows = [
      mem({ id: "o1", kind: "outcome" }),
      mem({ id: "o2", kind: "outcome", created_at: "2026-09-21T00:00:00Z" }),
    ];
    const supabase = makeFakeSupabase(
      { session_memories: rows },
      {
        rpc: {
          memory_semantic_duplicates: (args) => {
            expect(args.p_kinds).not.toContain("outcome");
            return {
              data: [
                {
                  new_id: "o2",
                  existing_id: "o1",
                  sim: 0.99,
                  kind: "outcome",
                  new_created_at: "2026-09-21T00:00:00Z",
                  existing_created_at: "2026-09-20T00:00:00Z",
                },
              ],
              error: null,
            };
          },
        },
      },
    );
    expect(await mergeSemanticDuplicates(supabase, USER, ["o2"], 0.8, ["outcome", "blocker"])).toBe(0);
    expect(rows.every((r) => r.retired_at === null)).toBe(true);
  });

  it("merges a pair inside one write batch (same session), keeping the newer row", async () => {
    const rows = [
      mem({ id: "w1", code_session_id: "s", created_at: "2026-09-25T00:00:00Z" }),
      mem({ id: "w2", code_session_id: "s", created_at: "2026-09-25T00:00:00Z" }),
    ];
    const { supabase, merges } = setup(rows, { "w2:w1": 0.9 });
    expect(await mergeSemanticDuplicates(supabase, USER, ["w1", "w2"])).toBe(1);
    expect(byId(rows, "w1")?.retired_at).not.toBeNull();
    expect(byId(rows, "w2")?.retired_at).toBeNull();
    expect(merges.map((m) => [m.kept_id, m.retired_id])).toEqual([["w2", "w1"]]);
  });

  it("collapses a chain A~B~C (A and C not similar) to one survivor, the newest", async () => {
    const rows = [
      mem({ id: "A", created_at: "2026-09-20T00:00:00Z" }),
      mem({ id: "B", created_at: "2026-09-21T00:00:00Z" }),
      mem({ id: "C", created_at: "2026-09-22T00:00:00Z" }),
    ];
    const { supabase, merges } = setup(rows, { "B:A": 0.86, "C:B": 0.9 });
    expect(await mergeSemanticDuplicates(supabase, USER, ["A", "B", "C"])).toBe(2);
    expect(rows.filter((r) => r.retired_at === null).map((r) => r.id)).toEqual(["C"]);
    expect(merges.every((m) => m.kept_id === "C")).toBe(true);
    expect(merges.map((m) => m.retired_id).sort()).toEqual(["A", "B"]);
    expect(byId(rows, "C")?.supersedes).toBe("B");
  });

  it("does not merge a different kind or a different project", async () => {
    const rows = [
      mem({ id: "other-kind", kind: "decision" }),
      mem({ id: "other-project", code_project_id: "p2" }),
      mem({ id: "new", code_session_id: "s-new", created_at: "2026-09-25T00:00:00Z" }),
    ];
    const { supabase, merges } = setup(rows, { "new:other-kind": 0.99, "new:other-project": 0.99 });
    expect(await mergeSemanticDuplicates(supabase, USER, ["new"])).toBe(0);
    expect(rows.every((r) => r.retired_at === null && r.supersedes === null)).toBe(true);
    expect(merges).toEqual([]);
  });

  it("never overwrites an existing supersedes", async () => {
    const rows = [mem({ id: "a" }), mem({ id: "n", supersedes: "earlier", created_at: "2026-09-25T00:00:00Z" })];
    const { supabase } = setup(rows, { "n:a": 0.95 });
    expect(await mergeSemanticDuplicates(supabase, USER, ["n"])).toBe(1);
    expect(byId(rows, "n")?.supersedes).toBe("earlier");
  });

  it("never throws when the RPC fails, and writes nothing", async () => {
    const rows = [mem({ id: "old" }), mem({ id: "new" })];
    const supabase = makeFakeSupabase(
      { session_memories: rows },
      { rpc: { memory_semantic_duplicates: () => ({ data: null, error: { message: "function does not exist" } }) } },
    );
    await expect(mergeSemanticDuplicates(supabase, USER, ["new"])).resolves.toBe(0);
    expect(rows.every((r) => r.retired_at === null && r.supersedes === null)).toBe(true);
  });

  it("never throws when the client itself throws", async () => {
    const supabase = {
      rpc: () => {
        throw new Error("network down");
      },
    } as never;
    await expect(mergeSemanticDuplicates(supabase, USER, ["new"])).resolves.toBe(0);
  });

  it("issues no RPC for an empty id list", async () => {
    const { supabase, calls } = setup([], {});
    expect(await mergeSemanticDuplicates(supabase, USER, [])).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("planSemanticMerges", () => {
  const pair = (n: string, e: string, sim: number, nAt: string, eAt: string): SemanticDuplicatePair => ({
    new_id: n,
    existing_id: e,
    sim,
    kind: "learning",
    new_created_at: nAt,
    existing_created_at: eAt,
  });

  it("is order-independent and picks the newest by microseconds, then id", () => {
    const pairs = [
      pair("y", "x", 0.9, "2026-09-25T00:00:00.000002+00:00", "2026-09-25T00:00:00.000001+00:00"),
      pair("z", "x", 0.85, "2026-09-25T00:00:00.000002+00:00", "2026-09-25T00:00:00.000001+00:00"),
    ];
    const a = planSemanticMerges(pairs);
    const b = planSemanticMerges([...pairs].reverse());
    expect(a).toEqual(b);
    expect(new Set(a.merges.map((m) => m.kept_id))).toEqual(new Set(["z"]));
    // y is not directly paired with z: its sim is its best edge.
    expect(a.merges.find((m) => m.retired_id === "y")?.sim).toBe(0.9);
  });
});

describe("semanticDedupMinSim", () => {
  it("defaults to 0.80 and reads MEMBRAL_MEMORY_DEDUP_MIN_SIM, falling back on junk", () => {
    expect(DEFAULT_SEMANTIC_DEDUP_MIN_SIM).toBe(0.8);
    expect(semanticDedupMinSim({})).toBe(0.8);
    expect(semanticDedupMinSim({ MEMBRAL_MEMORY_DEDUP_MIN_SIM: "0.88" })).toBe(0.88);
    expect(semanticDedupMinSim({ MEMBRAL_MEMORY_DEDUP_MIN_SIM: "abc" })).toBe(0.8);
    expect(semanticDedupMinSim({ MEMBRAL_MEMORY_DEDUP_MIN_SIM: "1.5" })).toBe(0.8);
    expect(semanticDedupMinSim({ MEMBRAL_MEMORY_DEDUP_MIN_SIM: "0" })).toBe(0.8);
  });
});

describe("semanticDedupKinds", () => {
  it("defaults to learning/blocker/decision/preference and never admits outcome", () => {
    expect(semanticDedupKinds({})).toEqual(["learning", "blocker", "decision", "preference"]);
    expect(SEMANTIC_DEDUP_KINDS).not.toContain("outcome");
    expect(semanticDedupKinds({ MEMBRAL_MEMORY_DEDUP_KINDS: "decision, outcome ,bogus" })).toEqual(["decision"]);
    expect(semanticDedupKinds({ MEMBRAL_MEMORY_DEDUP_KINDS: "outcome" })).toEqual([...SEMANTIC_DEDUP_KINDS]);
  });
});
