// D3 decision B (2026-09-24): a record that fails grounding is written
// already retired (retire_reason "unverified:<reason>", migration 086), and
// --reverify un-retires ONLY rows retired as unverified.

import { makeMemoryFakeSupabase as makeFakeSupabase, type Row } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import {
  type InsertableRecord,
  insertMemoryRecords,
  isRetiredUnverified,
  planReverifyUpdate,
  type ReverifyRowState,
} from "@/lib/memory/write";

function grounded(over: Partial<InsertableRecord>): InsertableRecord {
  return {
    windowIndex: 0,
    kind: "decision",
    text: "Cache keyed on repo and branch",
    quote: "keyed the cache on repo + branch for every run",
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
    contentHash: "h-verified",
    paths: [],
    dangling: false,
    priority: false,
    embedding: null,
    ...over,
  };
}

describe("insertMemoryRecords retire-on-write", () => {
  it("inserts an unverified record already retired with its reason; the verified row carries no retired_at", async () => {
    const rows: Row[] = [];
    const upserts: Row[][] = [];
    const supabase = makeFakeSupabase({ session_memories: rows });
    const from = supabase.from.bind(supabase);
    // Record each upsert payload to prove the verified batch never mentions retired_at.
    supabase.from = (t: string) => {
      const q = from(t);
      const upsert = q.upsert.bind(q);
      q.upsert = (r: Row | Row[], o?: { onConflict?: string }) => {
        upserts.push(Array.isArray(r) ? r : [r]);
        return upsert(r, o);
      };
      return q;
    };

    const out = await insertMemoryRecords(supabase, "u1", "p1", "s1", "main", [
      grounded({}),
      grounded({
        text: "Short quote record",
        quote: "keyed it",
        verified: false,
        unverifiedReason: "quote_not_specific",
        contentHash: "h-unverified",
      }),
    ]);

    expect(rows).toHaveLength(2);
    const live = rows.find((r) => r.content_hash === "h-verified");
    const retired = rows.find((r) => r.content_hash === "h-unverified");
    expect(live?.retired_at).toBeUndefined();
    expect(live?.retire_reason).toBeUndefined();
    expect(retired?.verified).toBe(false);
    expect(retired?.retired_at).toEqual(expect.any(String));
    expect(retired?.retire_reason).toBe("unverified:quote_not_specific");
    expect(upserts).toHaveLength(2);
    expect(upserts[0].every((r) => !("retired_at" in r))).toBe(true);
    expect(out.map((r) => r.verified).sort()).toEqual([false, true]);
  });

  it("a verified re-upsert over a row another path retired does not resurrect it", async () => {
    const rows: Row[] = [
      {
        id: "x",
        user_id: "u1",
        code_session_id: "s1",
        content_hash: "h-verified",
        retired_at: "2026-09-01T00:00:00Z",
        retire_reason: "duplicate",
      },
    ];
    const supabase = makeFakeSupabase({ session_memories: rows });
    await insertMemoryRecords(supabase, "u1", "p1", "s1", "main", [grounded({})]);
    expect(rows[0].retired_at).toBe("2026-09-01T00:00:00Z");
    expect(rows[0].retire_reason).toBe("duplicate");
  });

  it("P8: a verified record with retireReason resolved_in_session is inserted retired with that reason (never deleted)", async () => {
    const rows: Row[] = [];
    const supabase = makeFakeSupabase({ session_memories: rows });
    const out = await insertMemoryRecords(supabase, "u1", "p1", "s1", "main", [
      grounded({
        kind: "blocker",
        durable: false,
        contentHash: "h-blk",
        retireReason: "resolved_in_session",
      }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].verified).toBe(true);
    expect(rows[0].retired_at).toEqual(expect.any(String));
    expect(rows[0].retire_reason).toBe("resolved_in_session");
    expect(out[0].live).toBe(false);
  });

  it("P8: an explicit retireReason wins over a grounding failure, so --reverify can never lift it", async () => {
    const rows: Row[] = [];
    const supabase = makeFakeSupabase({ session_memories: rows });
    await insertMemoryRecords(supabase, "u1", "p1", "s1", "main", [
      grounded({
        kind: "blocker",
        verified: false,
        unverifiedReason: "quote_not_found",
        contentHash: "h-blk",
        retireReason: "resolved_in_session",
      }),
    ]);
    expect(rows[0].retire_reason).toBe("resolved_in_session");
    expect(isRetiredUnverified(rows[0].retire_reason as string)).toBe(false);
  });

  it("P8: a resolved_in_session record over a live prior row retires that row; over a duplicate-retired row it writes nothing", async () => {
    const rows: Row[] = [
      {
        id: "live",
        user_id: "u1",
        code_session_id: "s1",
        content_hash: "h-live",
        retired_at: null,
        retire_reason: null,
      },
      {
        id: "dup",
        user_id: "u1",
        code_session_id: "s1",
        content_hash: "h-dup",
        retired_at: "2026-09-01T00:00:00Z",
        retire_reason: "duplicate",
      },
    ];
    const supabase = makeFakeSupabase({ session_memories: rows });
    await insertMemoryRecords(supabase, "u1", "p1", "s1", "main", [
      grounded({
        kind: "blocker",
        contentHash: "h-live",
        retireReason: "resolved_in_session",
      }),
      grounded({
        kind: "blocker",
        text: "other",
        contentHash: "h-dup",
        retireReason: "resolved_in_session",
      }),
    ]);
    const live = rows.find((r) => r.id === "live");
    const dup = rows.find((r) => r.id === "dup");
    expect(live?.retired_at).toEqual(expect.any(String));
    expect(live?.retire_reason).toBe("resolved_in_session");
    expect(dup?.retired_at).toBe("2026-09-01T00:00:00Z");
    expect(dup?.retire_reason).toBe("duplicate");
  });
});

describe("planReverifyUpdate (--reverify)", () => {
  const base: ReverifyRowState = {
    verified: false,
    turn_idx: 1,
    quote: "q",
    turn_role: "assistant",
    retired_at: "2026-09-01T00:00:00Z",
    retire_reason: "unverified:quote_not_found",
  };
  const pass = { verified: true, turn_idx: 1 };
  const NOW = "2026-09-24T00:00:00Z";

  it("un-retires a row retired as unverified that now grounds", () => {
    const plan = planReverifyUpdate(base, pass, NOW);
    expect(plan.unretire).toBe(true);
    expect(plan.update).toMatchObject({ verified: true, retired_at: null, retire_reason: null });
  });

  it.each([
    "rerun",
    "resolved_in_session",
    "duplicate",
    "preference_assistant_turn",
    null,
  ])("never un-retires a row retired for reason %s", (reason) => {
    const plan = planReverifyUpdate({ ...base, retire_reason: reason }, pass, NOW);
    expect(plan.unretire).toBe(false);
    expect(plan.update).toBeNull();
  });

  it("retires a live row that now fails, with its reason", () => {
    const plan = planReverifyUpdate(
      { ...base, verified: true, retired_at: null, retire_reason: null },
      { verified: false, turn_idx: 1, reason: "no_quote" },
      NOW,
    );
    expect(plan.retire).toBe(true);
    expect(plan.update).toMatchObject({ verified: false, retired_at: NOW, retire_reason: "unverified:no_quote" });
  });

  it("leaves a retired-unverified row that still fails alone", () => {
    expect(
      planReverifyUpdate(base, { verified: false, turn_idx: 1, reason: "quote_not_found" }, NOW).update,
    ).toBeNull();
  });

  it("recognises the unverified prefix exactly", () => {
    expect(isRetiredUnverified("unverified")).toBe(true);
    expect(isRetiredUnverified("unverified:no_quote")).toBe(true);
    expect(isRetiredUnverified("unverifiedish")).toBe(false);
    expect(isRetiredUnverified("resolved_in_session")).toBe(false);
    expect(isRetiredUnverified(null)).toBe(false);
  });
});
