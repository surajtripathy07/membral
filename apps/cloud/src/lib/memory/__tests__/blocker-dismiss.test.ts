// chainMemberIds — which rows one Today blocker row stands for (the
// retire/undo round trip against the preamble lives in preamble.test.ts).

import { makeMemoryFakeSupabase as makeFakeSupabase } from "@membral/test-kit";
import { describe, expect, it } from "vitest";
import { type InsertableRecord, retireRowsByIds } from "@/lib/memory/write";
import {
  BLOCKER_DISMISS_RETIRE_REASON,
  carryUserDismissals,
  chainMemberIds,
  dismissBlocker,
  listDismissedBlockers,
  undoBlockerDismissal,
} from "../blocker-dismiss";

describe("chainMemberIds", () => {
  it("follows recurs_of transitively in both directions, through a retired root not in the live set", () => {
    const rows = [
      { id: "a", recurs_of: "root" },
      { id: "b", recurs_of: "a" },
      { id: "c", recurs_of: "root" },
      { id: "x", recurs_of: null },
    ];
    expect(chainMemberIds("b", rows).sort()).toEqual(["a", "b", "c"]);
    expect(chainMemberIds("x", rows)).toEqual(["x"]);
    expect(chainMemberIds("gone", [])).toEqual(["gone"]);
  });

  it("stores reasons distinct from every machine retire reason", () => {
    expect(BLOCKER_DISMISS_RETIRE_REASON).toEqual({ resolved: "user_resolved", ignored: "user_ignored" });
  });
});

describe("dismissals survive later extraction (carryUserDismissals)", () => {
  const DISMISSED_AT = "2026-09-20T12:00:00Z";
  const at = (iso: string | null) => () => iso;
  const base = {
    user_id: "u1",
    code_project_id: "p1",
    kind: "blocker",
    embedding: null,
    recurs_of: null,
    source: "extractor",
  };
  const ignored = {
    ...base,
    id: "ign",
    code_session_id: "s-old",
    text: "Smoke job times out on CI",
    quote: "the smoke job timed out again after 10 minutes",
    retired_at: DISMISSED_AT,
    retire_reason: "user_ignored",
  };
  const resolved = {
    ...base,
    id: "res",
    code_session_id: "s-old",
    text: "Migration 105 fails locally",
    quote: "migration 105 fails with a missing column",
    retired_at: DISMISSED_AT,
    retire_reason: "user_resolved",
  };
  const fresh = (over: Partial<InsertableRecord>): InsertableRecord => ({
    windowIndex: 0,
    kind: "blocker",
    text: "x",
    quote: null,
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
    contentHash: "h",
    paths: [],
    dangling: false,
    priority: false,
    embedding: null,
    ...over,
  });

  it("Ignore sticks across a new sighting after the click: inserted retired ':carried', linked to the clicked row", async () => {
    const supabase = makeFakeSupabase({ session_memories: [{ ...ignored }] });
    const out = await carryUserDismissals(supabase as never, "u1", "p1", "s-new", at("2026-09-25T00:00:00Z"), [
      fresh({ text: "smoke job times out on CI.", contentHash: "a" }),
      fresh({ kind: "learning", text: "Smoke job times out on CI", contentHash: "b" }),
      fresh({ text: "Something unrelated blocks deploy", contentHash: "c" }),
    ]);
    expect(out.carried).toBe(1);
    expect(out.records[0]).toMatchObject({ retireReason: "user_ignored:carried", recursOf: "ign" });
    expect(out.records[1].retireReason).toBeUndefined();
    expect(out.records[2].retireReason).toBeUndefined();
  });

  it("#436: an agent's memory_resolve carries like Resolved, so a --force re-run does not revive it", async () => {
    const supabase = makeFakeSupabase({
      session_memories: [{ ...resolved, id: "agt", retire_reason: "agent_resolved" }],
    });
    const rec = fresh({ text: "Migration 105 fails locally", contentHash: "a" });
    const rerun = await carryUserDismissals(supabase as never, "u1", "p1", "s-old", at("2026-09-19T00:00:00Z"), [rec]);
    expect(rerun.records[0]).toMatchObject({ retireReason: "agent_resolved:carried", recursOf: "agt" });
    const later = await carryUserDismissals(supabase as never, "u1", "p1", "s-new", at("2026-09-25T00:00:00Z"), [rec]);
    expect(later.records[0].retireReason).toBeUndefined();
  });

  it("Resolved resurfaces only for a sighting after the click (timed per record)", async () => {
    const supabase = makeFakeSupabase({ session_memories: [{ ...resolved }] });
    const rec = fresh({ text: "Migration 105 fails locally", contentHash: "a" });
    const after = await carryUserDismissals(supabase as never, "u1", "p1", "s-new", at("2026-09-25T00:00:00Z"), [rec]);
    expect(after.records[0].retireReason).toBeUndefined();
    const before = await carryUserDismissals(supabase as never, "u1", "p1", "s-mid", at("2026-09-19T00:00:00Z"), [rec]);
    expect(before.records[0]).toMatchObject({ retireReason: "user_resolved:carried", recursOf: "res" });
    expect((await carryUserDismissals(supabase as never, "u1", "p1", "s-x", at(null), [rec])).carried).toBe(0);
    // One session spanning the click: the pre-click turn carries, the post-click turn resurfaces.
    const spanning = await carryUserDismissals(
      supabase as never,
      "u1",
      "p1",
      "s-span",
      (r) => (r.turn_idx === 1 ? "2026-09-20T11:00:00Z" : "2026-09-20T13:00:00Z"),
      [rec, { ...rec, turn_idx: 9, contentHash: "b" }],
    );
    expect(spanning.records.map((r) => r.retireReason)).toEqual(["user_resolved:carried", undefined]);
  });

  it("B1: a carried row is never a match target — the Resolved cut-off stays at the click", async () => {
    // Click at T0 (DISMISSED_AT); an old session re-derived at T2 was carried; a new session at T1 (T0 < T1 < T2).
    const carriedAtT2 = {
      ...resolved,
      id: "carried",
      code_session_id: "s-old-laptop",
      recurs_of: "res",
      retired_at: "2026-09-26T00:00:00Z",
      retire_reason: "user_resolved:carried",
    };
    const supabase = makeFakeSupabase({ session_memories: [{ ...resolved }, carriedAtT2] });
    const out = await carryUserDismissals(supabase as never, "u1", "p1", "s-t1", at("2026-09-22T00:00:00Z"), [
      fresh({ text: "Migration 105 fails locally", contentHash: "a" }),
    ]);
    expect(out.carried).toBe(0);
    expect(out.records[0].retireReason).toBeUndefined();
  });

  it("a record already linked to a live chain, headed retired, or in another project is left alone", async () => {
    const supabase = makeFakeSupabase({ session_memories: [{ ...ignored }] });
    const same = { text: "Smoke job times out on CI" };
    expect(
      (await carryUserDismissals(supabase as never, "u1", "p2", "s-new", at(DISMISSED_AT), [fresh(same)])).carried,
    ).toBe(0);
    const linked = await carryUserDismissals(supabase as never, "u1", "p1", "s-new", at(DISMISSED_AT), [
      fresh({ ...same, recursOf: "live-root" }),
      fresh({ ...same, retireReason: "resolved_in_session" }),
    ]);
    expect(linked.carried).toBe(0);
  });

  it("a failed dismissed-row read carries nothing and extraction proceeds with the records unchanged", async () => {
    const supabase = makeFakeSupabase({ session_memories: [{ ...ignored }] });
    const failing = {
      from: () => {
        const q = supabase.from("session_memories");
        return Object.assign(q, {
          // biome-ignore lint/suspicious/noThenProperty: a PromiseLike stand-in for a failed PostgREST read
          then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { message: "boom" } }),
        });
      },
    };
    const recs = [fresh({ text: "Smoke job times out on CI" })];
    const out = await carryUserDismissals(failing as never, "u1", "p1", "s-new", at(DISMISSED_AT), recs);
    expect(out).toEqual({ records: recs, carried: 0 });
  });

  it("--force re-run keeps both reasons: dismissed rows are never re-tagged rerun, re-derived records carry them", async () => {
    const rows = [
      { ...ignored },
      { ...resolved },
      { ...base, id: "live", code_session_id: "s-old", text: "t", quote: "q", retired_at: null, retire_reason: null },
    ];
    const supabase = makeFakeSupabase({ session_memories: rows });
    await retireRowsByIds(supabase as never, "u1", ["ign", "res", "live"]);
    expect(rows.map((r) => r.retire_reason)).toEqual(["user_ignored", "user_resolved", "rerun"]);
    // A new prompt version rewords the text; the quote (no embedding) still matches.
    const out = await carryUserDismissals(supabase as never, "u1", "p1", "s-old", at("2026-09-18T00:00:00Z"), [
      fresh({ text: "CI smoke run exceeds its timeout", quote: ignored.quote, contentHash: "n1" }),
      fresh({ text: "Local migration 105 breaks", quote: resolved.quote, contentHash: "n2" }),
    ]);
    expect(out.records.map((r) => [r.retireReason, r.recursOf])).toEqual([
      ["user_ignored:carried", "ign"],
      ["user_resolved:carried", "res"],
    ]);
  });

  it("Undo lifts the clicked rows and every row carried onto them, never a machine-retired row (by id or by chain)", async () => {
    const rows = [
      { ...ignored },
      {
        ...base,
        id: "later",
        code_session_id: "s-new",
        text: "t",
        quote: null,
        recurs_of: "ign",
        retired_at: DISMISSED_AT,
        retire_reason: "user_ignored:carried",
      },
      {
        ...base,
        id: "later2",
        code_session_id: "s-new2",
        text: "t",
        quote: null,
        recurs_of: "later",
        retired_at: DISMISSED_AT,
        retire_reason: "user_ignored:carried",
      },
      {
        ...base,
        id: "machine",
        code_session_id: "s-new",
        text: "t",
        quote: null,
        recurs_of: "ign",
        retired_at: DISMISSED_AT,
        retire_reason: "resolved_observed",
      },
    ];
    const supabase = makeFakeSupabase({ session_memories: rows });
    expect(await undoBlockerDismissal(supabase as never, "u1", ["machine"])).toEqual([]);
    expect((await undoBlockerDismissal(supabase as never, "u1", ["ign"])).sort()).toEqual(["ign", "later", "later2"]);
    expect(rows.find((r) => r.id === "machine")?.retire_reason).toBe("resolved_observed");
    expect(rows.find((r) => r.id === "machine")?.retired_at).toBe(DISMISSED_AT);
  });

  it("dismiss retires only the clicked chain, never another project's rows", async () => {
    const rows = [
      { ...base, id: "a1", code_session_id: "s1", text: "t", quote: null, retired_at: null, retire_reason: null },
      {
        ...base,
        id: "a2",
        code_session_id: "s2",
        text: "t",
        quote: null,
        recurs_of: "a1",
        retired_at: null,
        retire_reason: null,
      },
      {
        ...base,
        id: "b1",
        code_project_id: "p2",
        code_session_id: "s3",
        text: "t",
        quote: null,
        recurs_of: "a1",
        retired_at: null,
        retire_reason: null,
      },
    ];
    const supabase = makeFakeSupabase({ session_memories: rows });
    const out = await dismissBlocker(supabase as never, "u1", "a2", "resolved");
    expect(out.ok && [...out.ids].sort()).toEqual(["a1", "a2"]);
    expect(rows.find((r) => r.id === "b1")?.retired_at).toBeNull();
  });

  it("listDismissedBlockers: one entry per click (chain rows share a timestamp), carried rows left out", async () => {
    const rows = [
      { ...resolved, id: "r1", created_at: "2026-09-10T00:00:00Z" },
      { ...resolved, id: "r2", text: "Migration 105 still fails", created_at: "2026-09-12T00:00:00Z" },
      { ...ignored, created_at: "2026-09-11T00:00:00Z", retired_at: "2026-09-21T00:00:00Z" },
      { ...ignored, id: "c", retire_reason: "user_ignored:carried", created_at: "2026-09-22T00:00:00Z" },
    ];
    const list = await listDismissedBlockers(makeFakeSupabase({ session_memories: rows }) as never, "u1");
    expect(list.map((d) => [d.ids.sort(), d.reason, d.text])).toEqual([
      [["ign"], "ignored", "Smoke job times out on CI"],
      [["r1", "r2"], "resolved", "Migration 105 still fails"],
    ]);
  });
});
